import test from 'node:test'
import assert from 'node:assert/strict'
import { decodePng, encodePng, diffImages, heatmap, boxesFromMetrics } from '../ui-screenshot-diff.mjs'

function image(width, height, painter) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = painter(x, y)
      const i = (y * width + x) * 4
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a
    }
  }
  return { width, height, data }
}

test('encode and decode round-trip preserves RGBA pixels', () => {
  const source = image(7, 5, (x, y) => [x * 30, y * 40, (x + y) * 10, 255 - x])
  const decoded = decodePng(encodePng(source))
  assert.equal(decoded.width, 7)
  assert.equal(decoded.height, 5)
  assert.deepEqual([...decoded.data], [...source.data])
})

test('identical images report zero difference', () => {
  const a = image(4, 3, () => [10, 20, 30, 255])
  const report = diffImages(a, decodePng(encodePng(a)))
  assert.equal(report.regions.total.meanAbsDiff, 0)
  assert.equal(report.regions.total.maxChannelDelta, 0)
  assert.equal(report.regions.total.changed[0].pixels, 0)
})

test('single changed pixel is counted once and respects thresholds', () => {
  const a = image(4, 3, () => [10, 20, 30, 255])
  const b = image(4, 3, () => [10, 20, 30, 255])
  b.data[0] = 150
  const report = diffImages(a, b)
  assert.equal(report.regions.total.pixels, 12)
  assert.equal(report.regions.total.changed[0].pixels, 1)
  assert.equal(report.regions.total.changed[8].pixels, 1)
  assert.equal(report.regions.total.changed[32].pixels, 1)
  assert.equal(report.regions.total.maxChannelDelta, 140)
  assert.equal(report.regions.total.changed[0].ratio, Number((1 / 12).toFixed(6)))
})

test('alpha-only change is reported separately from colour change', () => {
  const a = image(2, 2, () => [0, 0, 0, 255])
  const b = image(2, 2, () => [0, 0, 0, 255])
  b.data[3] = 0
  const report = diffImages(a, b)
  assert.equal(report.regions.total.meanAbsDiff, 0)
  assert.equal(report.regions.total.alphaDifferingPixels, 1)
  assert.equal(report.regions.total.changed[0].pixels, 1)
})

test('region boxes are clipped to the image and averaged over their own pixels', () => {
  const a = image(10, 10, () => [0, 0, 0, 255])
  const b = image(10, 10, () => [0, 0, 0, 255])
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) b.data[(y * 10 + x) * 4] = 100
  const report = diffImages(a, b, { regions: { quadrant: { x: 0, y: 0, width: 5, height: 5 }, outside: { x: 20, y: 20, width: 5, height: 5 } } })
  assert.equal(report.regions.quadrant.pixels, 25)
  assert.equal(report.regions.quadrant.meanAbsDiff, Number((100 / 3).toFixed(4)))
  assert.equal(report.regions.outside.pixels, 0)
  assert.equal(report.regions.outside.meanAbsDiff, 0)
})

test('size mismatch is rejected instead of silently cropping', () => {
  assert.throws(() => diffImages(image(2, 2, () => [0, 0, 0, 255]), image(3, 2, () => [0, 0, 0, 255])), /Size mismatch/)
})

test('heatmap amplifies the channel delta and stays opaque', () => {
  const a = image(1, 1, () => [0, 0, 0, 255])
  const b = image(1, 1, () => [20, 0, 0, 255])
  const map = heatmap(a, b, 4)
  assert.equal(map.data[0], 80)
  assert.equal(map.data[3], 255)
  assert.equal(decodePng(encodePng(map)).data[0], 80)
})

test('boxesFromMetrics picks the matching variant and size', () => {
  const metrics = {
    look3: [{
      pngSize: { width: 1280, height: 720 },
      metrics: {
        regions: { tree: { x: 6, y: 119, width: 252, height: 392 } },
        style: { stage: { x: 273, y: 175.03, width: 487, height: 273.94 } },
      },
    }],
  }
  const picked = boxesFromMetrics(metrics, 'look3', '1280x720')
  assert.deepEqual(Object.keys(picked.boxes).sort(), ['regions.tree', 'style.stage'])
  assert.throws(() => boxesFromMetrics(metrics, 'look3', '1920x1080'), /No metrics/)
})
