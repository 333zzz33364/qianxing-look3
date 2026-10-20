import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas, Image, loadImage } from '@napi-rs/canvas'
import { applyStageImageMask, stageMaskKey } from '../../editor-ui/stage-image-mask.js'
import { imageMaskFields } from '../../editor-ui/image-mask-fields.js'
import { createPrimitivePreviewSource } from '../../editor-ui/primitive-preview.js'
import { createAnimationView } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject } from '../ui/authoring.js'
import { normalizeImageMeta, rasterizeSlices } from '../assets/image-stretch.js'

const box = extra => ({ width: 4, height: 1, enableMask: true, ...extra })
function image(alphas, width = alphas.length) {
  return { width, height: alphas.length / width,
    data: Uint8ClampedArray.from(alphas.flatMap(alpha => [200, 100, 50, alpha])) }
}
const alphas = data => Array.from(data).filter((_, index) => index % 4 === 3)

test('texture alpha masks descendants once and ignores image tint alpha', () => {
  const source = image([0, 1, 128, 255])
  const mask = applyStageImageMask(source, box(), { r: 128, g: 255, b: 0, a: 0 })
  assert.deepEqual(alphas(mask), [0, 1, 128, 255])
  assert.deepEqual(alphas(source.data), [0, 1, 128, 255])
  assert.deepEqual(Array.from(source.data.slice(8, 12)), [100, 100, 0, 128])
  assert.equal(applyStageImageMask(image([128]), { enableMask: false }), null)
})

test('reverse mask promotes nonzero 8-bit coverage after fill and feathering', () => {
  const source = image([0, 1, 128, 255])
  const mask = applyStageImageMask(source, box({ reverseMaskArea: true }))
  assert.deepEqual(alphas(mask), [255, 0, 0, 0])
  assert.deepEqual(alphas(source.data), [0, 0, 0, 0])
  const filled = image([0, 255, 128, 255])
  assert.deepEqual(alphas(applyStageImageMask(filled, box({ enableFill: true, fillType: 'Horizontal', fillAmount: .5, reverseMaskArea: true }))), [255, 0, 255, 255])
  assert.deepEqual(alphas(filled.data), [0, 0, 128, 255])
  const feathered = image([1, 255, 255, 255])
  assert.deepEqual(alphas(applyStageImageMask(feathered, box({ enableSoftEdge: true, softEdgeMode: 'Pixel', softEdgeWidthX: 4, softEdgeWidthY: 0, reverseMaskArea: true }))), [255, 0, 0, 0])
})

test('pixel and percentage feather widths retain overlapping fades', () => {
  const soft = { enableSoftEdge: true, softEdgeMode: 'Pixel', softEdgeWidthX: 4, softEdgeWidthY: 0 }
  assert.deepEqual(alphas(applyStageImageMask(image([255, 255, 255, 255]), box(soft))), [32, 96, 96, 32])
  assert.deepEqual(alphas(applyStageImageMask(image([255, 255, 255, 255]), box({ ...soft, softEdgeWidthX: 0 }))), [255, 255, 255, 255])
  const percent = { ...soft, softEdgeMode: 'Percentage', horizontalSoftRange: 0, verticalSoftRange: 100 }
  assert.deepEqual(alphas(applyStageImageMask(image([255, 255, 255, 255]), box(percent))), [64, 191, 191, 64])
})

test('dual-axis corners preserve legacy Pixel minimum and use Percentage range intersection', () => {
  const source = image([255, 255, 255, 255], 2)
  const pixel = applyStageImageMask({ ...source, data: new Uint8ClampedArray(source.data) }, box({
    width: 4, height: 4, enableSoftEdge: true, softEdgeMode: 'Pixel',
    softEdgeWidthX: 4, softEdgeWidthY: 8,
  }))
  assert.deepEqual(alphas(pixel), [32, 32, 32, 32], 'Pixel retains the previous minimum of the four edge fades')
  const percentage = applyStageImageMask({ ...source, data: new Uint8ClampedArray(source.data) }, box({
    width: 4, height: 4, enableSoftEdge: true, softEdgeMode: 'Percentage',
    horizontalSoftRange: 0, verticalSoftRange: 0,
  }))
  assert.deepEqual(alphas(percentage), [64, 64, 64, 64], 'Percentage intersects horizontal and vertical coverage by multiplication')
})

test('fill directions and radial origins follow the upstream editor preview', () => {
  const fill = { enableFill: true, fillAmount: .5 }
  assert.deepEqual(alphas(applyStageImageMask(image([255, 255, 255, 255]), box({ ...fill, fillType: 'Horizontal', fillHorizontalType: 'Right' }))), [0, 0, 255, 255])
  assert.deepEqual(alphas(applyStageImageMask(image([255, 255, 255, 255], 1), box({ ...fill, width: 1, height: 4, fillType: 'Vertical' }))), [0, 0, 255, 255])
  const radial = (fillType, extra) => alphas(applyStageImageMask(image([255, 255, 255, 255], 2), box({ ...fill, width: 2, height: 2, fillType, ...extra })))
  assert.deepEqual(radial('Radial360', { fillRadialType: 'Top' }), [0, 255, 0, 255])
  assert.deepEqual(radial('Radial90', { fillRadial90Type: 'BottomLeft' }), [255, 0, 0, 0])
  assert.deepEqual(radial('Radial180', { fillRadialType: 'Bottom' }), [255, 0, 255, 0])
})

test('radial fill direction reverses coverage and invalidates the coverage cache', () => {
  const radial = clockwise => alphas(applyStageImageMask(image([255, 255, 255, 255], 2), box({
    width: 2, height: 2, enableFill: true, fillType: 'Radial360', fillRadialType: 'Top',
    fillAmount: .25, fillClockwise: clockwise,
  })))
  assert.deepEqual(radial(true), [0, 255, 0, 0])
  assert.deepEqual(radial(false), [255, 0, 0, 0])
  const source = box({ fillType: 'Radial360', fillRadialType: 'Top', fillAmount: .25, fillClockwise: true })
  assert.notEqual(stageMaskKey(source), stageMaskKey({ ...source, fillClockwise: false }))
})

test('image mask properties follow enable, feather mode, and fill shape', () => {
  const fields = [
    ['enableMask', true], ['enableSoftEdge', true], ['softEdgeMode', 'percentage'],
    ['softEdgeWidthX', 8], ['softEdgeWidthY', 8], ['horizontalSoftRange', 75], ['verticalSoftRange', 80],
    ['enableFill', true], ['fillType', 'Radial360'], ['fillHorizontalType', 'Left'],
    ['fillVerticalType', 'Top'], ['fillRadial90Type', 'BottomLeft'], ['fillRadialType', 'Bottom'],
    ['fillClockwise', false], ['fillAmount', .5], ['reverseMaskArea', false],
  ].map(([key, value]) => ({ key, value, type: key === 'fillType' ? 'enum' : 'bool', options: key === 'fillType'
    ? [{ value: 'Unused' }, { value: 'Horizontal' }, { value: 'Radial360' }] : undefined }))
  const keys = (input = fields) => imageMaskFields(input).map(field => field.key)
  assert.deepEqual(keys(fields.map(field => field.key === 'enableMask' ? { ...field, value: false } : field)), ['enableMask'])
  assert.deepEqual(keys(), [
    'enableMask', 'enableSoftEdge', 'softEdgeMode', 'horizontalSoftRange', 'verticalSoftRange',
    'enableFill', 'fillType', 'fillRadialType', 'fillClockwise', 'fillAmount', 'reverseMaskArea',
  ])
  const shape = imageMaskFields(fields).find(field => field.key === 'fillType')
  assert.deepEqual(shape.options.map(option => option.value), ['Horizontal', 'Radial360'])
  assert.deepEqual(keys(fields.map(field => field.key === 'fillType' ? { ...field, value: 'Horizontal' } : field))
    .filter(key => key.startsWith('fill')), ['fillType', 'fillHorizontalType', 'fillAmount'])
})

test('pixel feather accepts both GIA and site-json enum casing', () => {
  const feathered = extra => alphas(applyStageImageMask(image([255, 255, 255, 255]), box({
    enableSoftEdge: true, softEdgeWidthX: 4, softEdgeWidthY: 0, ...extra,
  })))
  assert.deepEqual(feathered({ softEdgeMode: 'Pixel' }), [32, 96, 96, 32])
  assert.deepEqual(feathered({ softEdgeMode: 'pixel' }), [32, 96, 96, 32])
})

test('mask uses the stretched texture and nested descendant masks multiply', () => {
  const source = createCanvas(3, 3), ctx = source.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 3, 3); ctx.clearRect(1, 1, 1, 1)
  const meta = normalizeImageMeta({ m_Rect: { width: 3, height: 3 }, m_Border: { X: 1, Y: 1, Z: 1, W: 1 } })
  const stretched = rasterizeSlices(source, meta, 9, 5, createCanvas)
  const pixels = stretched.getContext('2d').getImageData(0, 0, 9, 5)
  const before = new Uint8ClampedArray(pixels.data)
  const mask = applyStageImageMask(pixels, box({ width: 9, height: 5 }))
  assert.deepEqual(alphas(mask), alphas(before))
  assert.equal(mask[(2 * 9 + 4) * 4 + 3], 0)
  assert.equal(mask[3], 255)
  const child = image([128]), parent = image([128])
  const parentMask = applyStageImageMask(parent, box())
  const childMask = applyStageImageMask(child, box())
  assert.equal(Math.round(parentMask[3] * childMask[3] / 255), 64)
})

test('mask redraw key ignores movement and tint but tracks coverage edits', () => {
  const original = box({ id: 'mask', imageColor: 0, posX: 1 })
  assert.equal(stageMaskKey(original), stageMaskKey({ ...original, posX: 90, imageColor: 0xffffffff }))
  for (const changed of [{ width: 10 }, { enableMask: false }, { reverseMaskArea: true }, { fillAmount: .4 }, { softEdgeWidthX: 2 }]) {
    assert.notEqual(stageMaskKey(original), stageMaskKey({ ...original, ...changed }))
  }
})

test('primitive source is generated once per fit revision and invalidates on replacement/undo', () => {
  let calls = 0
  const source = createPrimitivePreviewSource(fit => { calls++; return `<svg>${fit.value}</svg>` })
  const first = { value: 1 }, edited = { value: 2 }
  const initial = source(first)
  for (let i = 0; i < 100; i++) assert.equal(source(first), initial)
  assert.equal(calls, 1)
  assert.notEqual(source(edited), initial)
  assert.equal(source(first), initial)
  assert.equal(calls, 2)
})

function find(node, predicate) {
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flat(Infinity).flatMap(child => find(child, predicate))]
}

test('StageImage draws texture coverage for children while its own tint alpha stays separate', async t => {
  const globals = ['Image', 'window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver']
  const previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  let cleanups = []
  t.after(() => {
    cleanups.forEach(cleanup => cleanup())
    for (const key of globals) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete globalThis[key] }
  })
  const frames = new Map(), observers = []
  let frameId = 0, slots = [], cursor = 0, effects = [], mountingImage = false
  globalThis.Image = Image
  globalThis.window = { devicePixelRatio: 1 }
  globalThis.document = { createElement: () => createCanvas(1, 1) }
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this) } observe() {} disconnect() {} }
  const studio = createStudio(createDefaultClientTemplateProject()), initial = studio.get()
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = !mountingImage && index === 0 ? initial : typeof value === 'function' ? value() : value; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }] },
    useRef(value) { const index = cursor++; if (!(index in slots)) slots[index] = { current: !mountingImage && index === 1 ? initial : value }; return slots[index] },
    useEffect(effect) { if (mountingImage) effects.push(effect) },
    useCallback: callback => callback,
  }
  const { AnimationView } = createAnimationView(React, { WorkspaceInspector() {}, api() {} })
  const tree = AnimationView({ sessionId: 'mask-test' })
  const StageImage = find(tree, node => node.type?.name === 'StageImage')[0].type
  mountingImage = true; slots = []; cursor = 0
  const source = createCanvas(4, 1), context = source.getContext('2d')
  const pixels = context.createImageData(4, 1)
  pixels.data.set(image([0, 128, 255, 255]).data); context.putImageData(pixels, 0, 0)
  const props = { src: source.toDataURL(), tint: { r: 255, g: 255, b: 255, a: 0 }, maskBox: box(), children: 'descendant' }
  let rendered = StageImage(props)
  const canvas = createCanvas(4, 1); canvas.clientWidth = 4; canvas.clientHeight = 1
  // A transformed bounding box must never determine mask raster dimensions.
  canvas.getBoundingClientRect = () => ({ width: 100, height: 100 })
  find(rendered, node => node.type === 'canvas')[0].props.ref.current = canvas
  cleanups = effects.map(effect => effect()).filter(Boolean)
  for (let i = 0; !frames.size && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(frames.size, 'image load schedules a draw')
  for (const callback of frames.values()) callback(); frames.clear()
  cursor = 0; rendered = StageImage(props)
  assert.equal(canvas.width, 4); assert.equal(canvas.height, 1)
  assert.deepEqual(alphas(canvas.getContext('2d').getImageData(0, 0, 4, 1).data), [0, 128, 255, 255])
  assert.equal(find(rendered, node => node.type === 'canvas')[0].props.style.opacity, 0)
  const subtree = find(rendered, node => node.props.className === 'look2-stage-subtree')[0]
  assert.deepEqual(subtree.children, ['descendant'])
  const encoded = subtree.props.style.maskImage.match(/^url\("(.*)"\)$/)[1]
  const decoded = await loadImage(encoded), decodedContext = createCanvas(4, 1).getContext('2d')
  decodedContext.drawImage(decoded, 0, 0)
  assert.deepEqual(alphas(decodedContext.getImageData(0, 0, 4, 1).data), [0, 128, 255, 255])
  cursor = 0; rendered = StageImage({ ...props, src: 'different.png' })
  assert.equal(find(rendered, node => node.props.className === 'look2-stage-subtree')[0].props.style.maskImage, 'linear-gradient(transparent,transparent)')
  // An outstanding resize draw is cancelled on unmount.
  observers[0].callback(); assert.ok(frames.size)
  cleanups.forEach(cleanup => cleanup()); assert.equal(frames.size, 0)
})
