import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { createPrimitiveFitJob } from '../../editor-ui/look2-fitting.js'

const workerSource = readFileSync(new URL('../../editor-ui/look2-fit-worker.js', import.meta.url), 'utf8')

function fixture(width, height, paint) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = paint(x, y)
      const offset = (y * width + x) * 4
      pixels[offset] = color?.[0] || 0
      pixels[offset + 1] = color?.[1] || 0
      pixels[offset + 2] = color?.[2] || 0
      pixels[offset + 3] = color?.[3] || 0
    }
  }
  return { width, height, pixels }
}

function createWorkerClass(image) {
  return class TestWorker {
    constructor() {
      this.terminated = false
      const self = {
        addEventListener: (type, handler) => { if (type === 'message') this.handle = handler },
        postMessage: (data) => queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data }) }),
      }
      class TestCanvas {
        constructor(width, height) { this.width = width; this.height = height; this.image = null }
        getContext() {
          return {
            clearRect() {},
            drawImage: (bitmap) => { this.image = bitmap },
            getImageData: () => {
              const output = new Uint8ClampedArray(this.width * this.height * 4)
              for (let y = 0; y < this.height; y += 1) {
                for (let x = 0; x < this.width; x += 1) {
                  const sx = Math.min(image.width - 1, Math.floor(x * image.width / this.width))
                  const sy = Math.min(image.height - 1, Math.floor(y * image.height / this.height))
                  const source = (sy * image.width + sx) * 4
                  const target = (y * this.width + x) * 4
                  output.set(image.pixels.subarray(source, source + 4), target)
                }
              }
              return { data: output }
            },
          }
        }
      }
      const sandbox = {
        self,
        Blob,
        TextEncoder,
        atob,
        Uint8Array,
        Uint8ClampedArray,
        Float32Array,
        OffscreenCanvas: TestCanvas,
        createImageBitmap: async () => ({ width: image.width, height: image.height, close() {} }),
      }
      vm.runInNewContext(workerSource, sandbox, { filename: 'look2-fit-worker.js' })
    }

    postMessage(data) {
      queueMicrotask(() => {
        if (!this.terminated) this.handle?.({ data })
      })
    }

    terminate() { this.terminated = true }
  }
}

async function fit(image, { count, transparent = true, shapes = ['ellipse', 'rectangle'], workers = 4, resolution = 64 }) {
  const job = createPrimitiveFitJob({
    source: 'data:image/png;base64,AA==', workerURL: '/test-fit-worker.js',
    WorkerClass: createWorkerClass(image), hardwareConcurrency: workers,
    options: { count, resolution, workers, transparent, shapes },
  })
  return job.promise
}

function inside(type, x, y, element) {
  const radians = element.rotation * Math.PI / 180
  const localX = Math.cos(radians) * (x - element.x) + Math.sin(radians) * (y - element.y)
  const localY = -Math.sin(radians) * (x - element.x) + Math.cos(radians) * (y - element.y)
  const halfW = element.width / 2
  const halfH = element.height / 2
  if (type === 'rectangle') return Math.abs(localX) <= halfW && Math.abs(localY) <= halfH
  if (type === 'ellipse') return localX * localX / (halfW * halfW) + localY * localY / (halfH * halfH) <= 1
  if (localY < -halfH || localY > halfH) return false
  return Math.abs(localX) <= ((halfH - localY) / element.height) * element.width / 2
}

function errorFor(image, fitData, transparent = true) {
  let total = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const input = (y * image.width + x) * 4
      const sourceAlpha = image.pixels[input + 3] / 255
      const target = [
        image.pixels[input] / 255 * sourceAlpha,
        image.pixels[input + 1] / 255 * sourceAlpha,
        image.pixels[input + 2] / 255 * sourceAlpha,
        sourceAlpha,
      ]
      if (!transparent) {
        target[0] += 1 - sourceAlpha; target[1] += 1 - sourceAlpha; target[2] += 1 - sourceAlpha; target[3] = 1
      }
      const rendered = transparent ? [0, 0, 0, 0] : [1, 1, 1, 1]
      const pointX = x + .5 - image.width / 2
      const pointY = image.height / 2 - y - .5
      for (const element of fitData.elements) {
        if (!inside(element.type, pointX, pointY, element)) continue
        const alpha = element.color.a
        const inverse = 1 - alpha
        rendered[0] = element.color.r / 255 * alpha + rendered[0] * inverse
        rendered[1] = element.color.g / 255 * alpha + rendered[1] * inverse
        rendered[2] = element.color.b / 255 * alpha + rendered[2] * inverse
        rendered[3] = alpha + rendered[3] * inverse
      }
      for (let channel = 0; channel < 4; channel += 1) total += (target[channel] - rendered[channel]) ** 2
    }
  }
  return total / (image.width * image.height * 4)
}

test('the worker preserves distinct opaque colors and larger budgets reduce rendered RGBA error', async () => {
  const image = fixture(24, 16, (x) => x < 12 ? [255, 0, 0, 255] : [0, 0, 255, 255])
  const one = await fit(image, { count: 1, shapes: ['rectangle'] })
  const more = await fit(image, { count: 8, shapes: ['rectangle'] })
  const colors = more.elements.map(({ color }) => color)
  assert.ok(colors.some((color) => color.r > 220 && color.b < 40), 'fit contains a red region')
  assert.ok(colors.some((color) => color.b > 220 && color.r < 40), 'fit contains a blue region')
  assert.ok(errorFor(image, more) < errorFor(image, one), 'additional shapes improve the rendered image')
})

test('disconnected texture details continue fitting after large color regions stop improving', async () => {
  const palette = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255], [255, 255, 0, 255],
    [0, 255, 255, 255], [255, 0, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255]]
  let seed = 37
  const image = fixture(64, 64, (x, y) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (x * 64 + y) % 31 === 0 ? [0, 0, 0, 0] : palette[seed >>> 29] })
  const coarse = await fit(image, { count: 2, shapes: ['rectangle'], workers: 1 })
  const detailed = await fit(image, { count: 32, shapes: ['rectangle'], workers: 1 })
  assert.equal(detailed.elements.length, 32, 'local details exhaust the requested budget rather than stopping at an average color')
  assert.ok(errorFor(image, detailed) < errorFor(image, coarse))
})

test('greedy color residual fitting continues to improve a smooth gradient', async () => {
  const image = fixture(24, 12, (x) => {
    const red = Math.round(255 * x / 23)
    return [red, 30, 255 - red, 255]
  })
  const one = await fit(image, { count: 1, shapes: ['rectangle'] })
  const more = await fit(image, { count: 12, shapes: ['rectangle'] })
  assert.ok(errorFor(image, more) < errorFor(image, one))
  assert.ok(new Set(more.elements.map(({ color }) => `${color.r},${color.g},${color.b}`)).size > 2)
})

test('sparse transparent marks receive a non-empty fit without adding an opaque canvas', async () => {
  const image = fixture(21, 21, (x, y) => {
    const dx = x - 10; const dy = y - 10
    return (Math.abs(dx) === Math.abs(dy) || dx === 0 || dy === 0) && Math.max(Math.abs(dx), Math.abs(dy)) <= 4
      ? [255, 180, 20, 255]
      : null
  })
  const result = await fit(image, { count: 1, workers: 1 })
  assert.ok(result.elements.length > 0)
  assert.equal(result.elements.some((element) => element.width >= image.width && element.height >= image.height && element.color.a === 1), false)
  assert.equal(errorFor(image, result) < errorFor(image, { version: 1, width: image.width, height: image.height, elements: [] }), true)
  const backgroundCorner = (0 + .5 - image.width / 2)
  const fitCoversCorner = result.elements.some((element) => inside(element.type, backgroundCorner, image.height / 2 - .5, element) && element.color.a > .99)
  assert.equal(fitCoversCorner, false, 'transparent corners stay transparent')
})

test('opaque mode emits a white base rectangle and fits against the white-composited target', async () => {
  const image = fixture(18, 12, (x, y) => x >= 4 && x < 14 && y >= 3 && y < 9 ? [0, 120, 220, 190] : null)
  const result = await fit(image, { count: 4, transparent: false, shapes: ['rectangle'] })
  assert.equal(result.elements[0].type, 'rectangle')
  assert.equal(result.elements[0].width, image.width)
  assert.deepEqual(result.elements[0].color, { r: 255, g: 255, b: 255, a: 1 })
  assert.ok(result.elements.length <= 5)
  assert.ok(errorFor(image, result, false) < errorFor(image, { version: 1, width: image.width, height: image.height, elements: [result.elements[0]] }, false))
})
