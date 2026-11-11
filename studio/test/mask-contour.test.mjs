import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { DOMAdapter } from 'pixi.js'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { applyStageImageMask } from '../../editor-ui/stage-image-mask.js'
import { imageAssetKey } from '../assets/catalog.js'
import { renderScenePng } from '../host-png.js'
import { imageMaskSpec, paintMaskCanvas } from '../play/image-mask.js'
import { PixiPlayRenderer } from '../play/pixi-renderer.js'
import { playSnapshot } from '../play/session.js'
import { maskContourEnabled, normalizeRenderSettings, readRenderSettings, renderSettingsPath, writeRenderSettings } from '../host/render-settings.js'

const image = (width, height, alpha = () => 255) => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    data[i] = data[i + 1] = data[i + 2] = 255
    data[i + 3] = alpha(x, y)
  }
  return { width, height, data }
}

test('render settings default to the geometry rule and reject unknown modes', () => {
  assert.deepEqual(normalizeRenderSettings(undefined), { maskContour: 'geometry' })
  assert.deepEqual(normalizeRenderSettings({}), { maskContour: 'geometry' })
  assert.deepEqual(normalizeRenderSettings({ maskContour: 'contour' }), { maskContour: 'contour' })
  assert.throws(() => normalizeRenderSettings({ maskContour: 'alpha' }), /遮罩覆盖规则/)
  assert.equal(maskContourEnabled({ maskContour: 'contour' }), true)
  assert.equal(maskContourEnabled(undefined), false)
})

test('render settings read defaults without a file and round-trip through the config path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-render-settings-'))
  try {
    const file = join(directory, 'render.json')
    assert.deepEqual(readRenderSettings(file), { maskContour: 'geometry' })
    writeRenderSettings({ maskContour: 'contour' }, file)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { maskContour: 'contour' })
    assert.deepEqual(readRenderSettings(file), { maskContour: 'contour' })
    writeFileSync(file, '{ broken')
    assert.throws(() => readRenderSettings(file), /渲染设置无法读取/)
    assert.equal(renderSettingsPath({ QXQY_RENDER_CONFIG_PATH: join(directory, 'custom.json') }), join(directory, 'custom.json'))
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('mask spec only reports contour when the caller asks for it', () => {
  const item = { kind: 'image', enableMask: true, width: 40, height: 20 }
  const matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
  assert.equal(imageMaskSpec(item, matrix).contour, false)
  assert.equal(imageMaskSpec(item, matrix, { contour: true }).contour, true)
})

test('geometry rule clips descendants by the rectangle and ignores texture alpha', () => {
  const data = image(4, 4, (x) => (x === 0 ? 0 : 255))
  const mask = applyStageImageMask(data, { width: 40, height: 40, enableMask: true }, {})
  assert.equal(mask[3], 255, 'geometry coverage must not drop with texture alpha')
  assert.equal(data.data[3], 0, 'the image itself still keeps its own transparency')
  assert.equal(mask[(2 * 4 + 3) * 4 + 3], 255)
})

test('contour rule follows the texture alpha for the same control', () => {
  const data = image(4, 4, (x) => (x === 0 ? 0 : 255))
  const mask = applyStageImageMask(data, { width: 40, height: 40, enableMask: true }, {}, { contour: true })
  assert.equal(mask[3], 0, 'contour coverage must follow the source alpha')
  assert.equal(mask[(2 * 4 + 3) * 4 + 3], 255)
})

test('both rules keep the rectangle empty outside the mask and honour reverse', () => {
  const box = { width: 20, height: 20, enableMask: true, reverseMaskArea: true }
  for (const options of [{}, { contour: true }]) {
    const data = image(4, 4)
    const mask = applyStageImageMask(data, box, {}, options)
    assert.equal(mask[3], 0, 'reverse masks zero the covered area')
  }
  const outside = image(4, 4)
  const emptyBox = { width: 0, height: 0, enableMask: true }
  const mask = applyStageImageMask(outside, emptyBox, {}, {})
  assert.equal(mask[3], 0, 'a zero-size box yields no coverage')
})

function control(name, kind, x, y, width, height, extra = {}) {
  return {
    name, kind, active: true, visible: true,
    anchoredPositionX: x, anchoredPositionY: y, sizeDeltaX: width, sizeDeltaY: height,
    anchorMinX: 0.5, anchorMaxX: 0.5, anchorMinY: 0.5, anchorMaxY: 0.5,
    pivotX: 0.5, pivotY: 0.5, ...extra,
  }
}

function halfTransparentTexture() {
  const canvas = createCanvas(4, 4)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(2, 0, 2, 4)
  return canvas
}

async function alphaAt(png, x, yFromTop) {
  const decoded = await loadImage(png.data)
  const canvas = createCanvas(decoded.width, decoded.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(decoded, 0, 0)
  return ctx.getImageData(x, yFromTop, 1, 1).data[3]
}

test('pixi contour masks multiply the source texture alpha into the mask canvas', t => {
  const previous = DOMAdapter.get()
  DOMAdapter.set({ ...previous, createCanvas })
  t.after(() => DOMAdapter.set(previous))
  const key = imageAssetKey(100001)
  const renderer = Object.create(PixiPlayRenderer.prototype)
  renderer.imageTextures = new Map([[key, { texture: { source: { resource: halfTransparentTexture() } } }]])
  const spec = imageMaskSpec(
    { kind: 'image', enableMask: true, width: 8, height: 8 },
    { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    { contour: true, imageKey: key },
  )
  const geometryCanvas = createCanvas(8, 8)
  const contourCanvas = createCanvas(8, 8)
  paintMaskCanvas(geometryCanvas, { ...spec, contour: false, imageKey: '' })
  renderer.paintContourMask(contourCanvas, spec)
  const geometry = geometryCanvas.getContext('2d').getImageData(0, 0, 8, 8).data
  const contour = contourCanvas.getContext('2d').getImageData(0, 0, 8, 8).data
  assert.equal(geometry[3], 255, 'geometry coverage stays opaque over the transparent half')
  assert.equal(contour[3], 0, 'contour coverage follows the transparent texture half')
  assert.equal(contour[(4 * 8 + 6) * 4 + 3], 255, 'contour keeps the opaque texture half')
})

test('scene PNG honours the contour mode by sampling the mask image alpha', async t => {
  const runtime = createRuntime({ canvasWidth: 240, canvasHeight: 160 })
  t.after(() => runtime.destroy())
  runtime.addRoot(control('Root', 'container', 0, 0, 240, 160, {
    children: [
      control('Mask', 'image', 0, 0, 100, 60, {
        imageId: 100001, imageColor: 0x00ffffff, enableMask: true,
        children: [control('Red', 'image', 0, 0, 180, 24, { imageId: 100002, imageColor: 0xffff0000 })],
      }),
    ],
  }))
  const session = { runtime, compiled: { canvasId: 'pc-16-9', platform: 'PC' }, history: [] }
  const scene = playSnapshot(session, { view: true }).scene
  const opaque = createCanvas(4, 4)
  opaque.getContext('2d').fillRect(0, 0, 4, 4)
  const images = new Map([
    [imageAssetKey(100001), halfTransparentTexture()],
    [imageAssetKey(100002), opaque],
  ])

  const geometry = renderScenePng(scene, 240, 160, { background: 'transparent', images })
  const contour = renderScenePng(scene, 240, 160, { background: 'transparent', images, contour: true })
  assert.equal(await alphaAt(geometry, 80, 80), 255, 'geometry keeps the child under a transparent texture half')
  assert.equal(await alphaAt(geometry, 160, 80), 255)
  assert.equal(await alphaAt(contour, 80, 80), 0, 'contour drops the child where the mask image is transparent')
  assert.equal(await alphaAt(contour, 160, 80), 255, 'contour keeps the child under the opaque half')
})
