import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Container, Matrix, Mesh, Sprite, Texture } from 'pixi.js'
import { normalizeImageMeta, sliceRegions } from '../assets/image-stretch.js'
import { imageAssetKey } from '../assets/catalog.js'
import { PixiPlayRenderer } from '../play/pixi-renderer.js'

test('nine-slice preserves borders on each axis and Pixi selects its mesh', () => {
  const meta = normalizeImageMeta({ m_Rect: { width: 20, height: 20 },
    m_Border: { X: 4, Y: 4, Z: 4, W: 4 } })
  const regions = sliceRegions(meta, 100, 60)
  assert.equal(regions.length, 9)
  assert.deepEqual(regions[0], { source: [0, 0, 4, 4], target: [0, 0, 4, 4] })
  assert.deepEqual(regions[4], { source: [4, 4, 12, 12], target: [4, 4, 92, 52] })

  const renderer = Object.create(PixiPlayRenderer.prototype)
  renderer.scratch = new Matrix()
  renderer.canvasHeight = 160
  renderer.imageTextures = new Map([[imageAssetKey(42, 'StaticReference'), { texture: Texture.WHITE, meta }]])
  const root = new Container()
  const item = { id: 'image', kind: 'image', primitive: 'sprite', imageId: 42,
    imageType: 'Stretch', imageColor: 0xffffffff, sourceWidth: 100, sourceHeight: 60 }
  renderer.updateNode(root, item)
  const mesh = root.__visual.children.find(child => child instanceof Mesh)
  assert.ok(mesh)
  // Nine regions become nine indexed Pixi quads (four vertices / six indices
  // apiece), so both source borders and target geometry reach the draw mesh.
  assert.equal(mesh.geometry.getBuffer('aPosition').data.length, regions.length * 8)
  assert.equal(mesh.geometry.getIndex().data.length, regions.length * 6)
  assert.deepEqual(Array.from(mesh.geometry.getBuffer('aPosition').data.slice(0, 8)), [-50, -30, -46, -30, -46, -26, -50, -26])
  renderer.updateNode(root, { ...item, imageType: 'Basic' })
  assert.ok(root.__visual.children.find(child => child instanceof Sprite))
  renderer.clearVisual(root)
  root.destroy({ children: true })
})
