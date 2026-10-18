import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Container, Matrix, Mesh, Sprite, Texture } from 'pixi.js'
import { normalizeImageMeta, sliceRegions } from '../assets/image-stretch.js'
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
  renderer.materialTextures = new Map([[42, { meta }]])
  renderer.materialTexture = () => Texture.WHITE
  const root = new Container()
  const item = { id: 'image', kind: 'image', primitive: 'missing', imageId: 42,
    imageType: 'Stretch', imageColor: 0xffffffff, sourceWidth: 100, sourceHeight: 60 }
  renderer.updateNode(root, item)
  assert.ok(root.__visual.__materialSprite instanceof Mesh)
  renderer.updateNode(root, { ...item, imageType: 'Basic' })
  assert.ok(root.__visual.__materialSprite instanceof Sprite)
  renderer.clearVisual(root)
  root.destroy({ children: true })
})
