import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Container, DOMAdapter, Matrix, Sprite } from 'pixi.js'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { paintList, playSnapshot } from '../play/session.js'
import { renderPaintPng, renderScenePng } from '../host-png.js'
import { PixiPlayRenderer } from '../play/pixi-renderer.js'

function control(name, kind, x, y, width, height, extra = {}) {
  return { name, kind, active: true, visible: true,
    anchoredPositionX: x, anchoredPositionY: y, sizeDeltaX: width, sizeDeltaY: height,
    anchorMinX: 0.5, anchorMaxX: 0.5, anchorMinY: 0.5, anchorMaxY: 0.5,
    pivotX: 0.5, pivotY: 0.5, ...extra }
}

function fixture(t) {
  const runtime = createRuntime({ canvasWidth: 240, canvasHeight: 160 })
  t.after(() => runtime.destroy())
  const root = runtime.addRoot(control('Root', 'container', 0, 0, 240, 160, { children: [
    control('Sibling', 'image', 90, 0, 24, 24, { imageId: 100001, imageColor: 0xff0000ff }),
    control('Mask', 'image', 0, 0, 100, 60, { imageId: 100001, imageColor: 0x00ffffff, enableMask: true,
      children: [control('Red', 'image', 0, 12, 180, 24, { imageId: 100001, imageColor: 0xffff0000 })] }),
  ] }))
  const session = { runtime, compiled: { canvasId: 'pc-16-9', platform: 'PC' }, history: [] }
  return { mask: root.GetChild('Mask'), session,
    scene: () => playSnapshot(session, { view: true }).scene }
}

async function alphaPixel(png, x, y) {
  const image = await loadImage(png.data)
  const ctx = createCanvas(image.width, image.height).getContext('2d')
  ctx.drawImage(image, 0, 0)
  return ctx.getImageData(x, y, 1, 1).data[3]
}

test('image mask clips descendants while an outside sibling remains visible', async t => {
  const f = fixture(t)
  const png = renderScenePng(f.scene(), 240, 160, { background: 'transparent' })
  assert.deepEqual(png.data, renderPaintPng(paintList(f.session), 240, 160, { background: 'transparent' }).data)
  assert.equal(await alphaPixel(png, 120, 68), 255)
  assert.equal(await alphaPixel(png, 40, 68), 0)
  assert.equal(await alphaPixel(png, 210, 80), 255)
})

test('pixel soft edge fades inward, while zero width remains hard', async t => {
  const f = fixture(t)
  f.mask.enableSoftEdge = true
  f.mask.softEdgeMode = 'Pixel'
  f.mask.softEdgeWidthX = 20
  f.mask.softEdgeWidthY = 0
  const png = renderScenePng(f.scene(), 240, 160, { background: 'transparent' })
  assert.equal(await alphaPixel(png, 79, 68), 121)
  assert.equal(await alphaPixel(png, 120, 68), 255)
  f.mask.softEdgeWidthX = 0
  const hard = renderScenePng(f.scene(), 240, 160, { background: 'transparent' })
  assert.equal(await alphaPixel(hard, 71, 68), 255)
  assert.equal(await alphaPixel(hard, 68, 68), 0)
})

test('Pixi mask contains descendants, reuses soft texture and releases it', async t => {
  const adapter = DOMAdapter.get()
  DOMAdapter.set({ ...adapter, createCanvas })
  const renderer = Object.create(PixiPlayRenderer.prototype)
  Object.assign(renderer, { nodes: new Map(), scratch: new Matrix(), canvasHeight: 160,
    app: { stage: new Container() } })
  t.after(() => { renderer.clearNodes(); DOMAdapter.set(adapter) })
  const mask = { id: 'mask', parent: null, z: 0, kind: 'image', primitive: 'rect',
    sourceWidth: 100, sourceHeight: 60, imageColor: 0x00ffffff,
    enableMask: true, enableSoftEdge: true, softEdgeMode: 'Pixel',
    softEdgeWidthX: 20, softEdgeWidthY: 0,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 120, ty: 80 } }
  const child = { id: 'child', parent: 'mask', z: 0, kind: 'image', primitive: 'rect',
    sourceWidth: 180, sourceHeight: 24, imageColor: 0xffff0000,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 12 } }
  renderer.upsertSceneNode(mask)
  renderer.upsertSceneNode(child)
  const root = renderer.nodes.get('mask')
  assert.equal(renderer.nodes.get('child').parent, root.__imageContent)
  assert.ok(root.__imageMask instanceof Sprite)
  const texture = root.__imageMask.texture
  renderer.upsertSceneNode({ ...mask, softEdgeWidthX: 30 })
  assert.equal(root.__imageMask.texture, texture)
  renderer.upsertSceneNode({ ...mask, enableMask: false })
  assert.equal(root.__imageContent.mask, undefined)
  assert.equal(texture.destroyed, true)
  renderer.removeNode('mask')
  assert.equal(renderer.nodes.get('child').destroyed, false)
})

for (const masked of [false, true]) {
  test(`opaque Pixi parent paints behind its children (mask=${masked}) after rebuild and reorder`, t => {
    const renderer = Object.create(PixiPlayRenderer.prototype)
    Object.assign(renderer, { nodes: new Map(), scratch: new Matrix(), canvasHeight: 160,
      app: { stage: new Container() } })
    t.after(() => renderer.clearNodes())
    const parent = { id: 'viewport', parent: null, z: 0, kind: 'image', primitive: 'rect',
      sourceWidth: 100, sourceHeight: 60, imageColor: 0xffffffff, enableMask: masked,
      matrix: { a: 1, b: 0, c: 0, d: 1, tx: 120, ty: 80 } }
    const child = { id: 'map', parent: 'viewport', z: 2, kind: 'image', primitive: 'rect',
      sourceWidth: 100, sourceHeight: 60, imageColor: 0xff008899,
      matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } }
    const overlay = { ...child, id: 'labels', z: 1, imageColor: 0xffff0000 }
    renderer.upsertSceneNode(parent)
    renderer.upsertSceneNode(child)
    renderer.upsertSceneNode(overlay)
    const root = renderer.nodes.get('viewport')
    const order = () => {
      const content = root.__imageContent || root
      content.sortChildren()
      return content.children.filter(node => node === root.__visual || node.__runtimeId != null)
        .map(node => node === root.__visual ? 'background' : node.__runtimeId)
    }
    // Sort the real Pixi containers: addChildAt(visual, 0) alone is insufficient
    // when runtime siblings use negative zIndex values.
    assert.deepEqual(order(), ['background', 'map', 'labels'])
    renderer.upsertSceneNode({ ...parent, sourceWidth: 110, imageColor: 0xffcccccc })
    assert.deepEqual(order(), ['background', 'map', 'labels'])
    renderer.upsertSceneNode({ ...child, z: 0 })
    assert.deepEqual(order(), ['background', 'labels', 'map'])
    renderer.upsertSceneNode({ ...parent, enableMask: !masked })
    assert.deepEqual(order(), ['background', 'labels', 'map'])
    renderer.removeNode('map')
    assert.deepEqual(order(), ['background', 'labels'])
  })
}
