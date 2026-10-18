import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudio, importGia } from '../index.js'
import { parseTimelineLuaLiteral } from '../look2/timeline-lua.js'

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64')
function open() {
  const studio = createStudio()
  studio.importData('json', encode({ version: 12, nodes: [
    { id: 'root', name: '根', type: 'container', parentId: null, sizeDeltaX: 400, sizeDeltaY: 300 },
    { id: 'picture', name: '图元', type: 'primitive', parentId: 'root', sizeDeltaX: 100, sizeDeltaY: 80,
      properties: { imageResourceId: 'resource' } },
  ], primitiveResources: [{ id: 'resource', name: '内嵌图', imageUrl: 'data:image/png;base64,AAAA', fitData: {
    version: 1, width: 100, height: 80, elements: [
      { type: 'rectangle', imageId: 100001, x: 0, y: 0, width: 100, height: 80, rotation: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
    ],
  } }], animations: [{ id: 'a', name: '淡出', duration: 1, keyframeTracks: [
    { id: 'opacity', nodeId: 'picture', fieldKey: 'groupAlpha', keyframes: [{ time: 0, value: 255 }, { time: 1, value: 0 }] },
  ] }], activeAnimationId: 'a' }))
  return studio
}
const decode = result => Buffer.from(result.data, 'base64').toString('utf8')
const find = (node, id) => node.id === id ? node : (node.children || []).map(row => find(row, id)).find(Boolean)

test('Basic and Stretch image types round trip the observed GIA slot 504 without exposing a Lua setter', () => {
  const studio = createStudio()
  studio.patch({ op: 'selectAsset', assetType: 'client-control-template' })
  studio.patch({ op: 'add', kind: 'image' })
  const id = studio.get().selectedId
  for (const mode of ['Basic', 'Stretch']) {
    studio.patch({ op: 'set', id, key: 'imageType', value: mode })
    const node = find(studio.archiveData().assets.client.root, id)
    assert.equal(node.giaRaw.imageSlotType, mode === 'Basic' ? 0 : 1)
    const restored = importGia(Buffer.from(studio.exportData('gia', 'client-control-template').data, 'base64'))
    const images = restored.project.root.children[0].children.filter(row => row.kind === 'image')
    assert.equal(images.at(-1).imageType, mode)
  }
})

test('all new primitive and timeline export formats are usable and preserve editable resources', () => {
  const studio = open(), before = studio.archiveData()
  const data = parseTimelineLuaLiteral(decode(studio.exportData('primitive-data', 'root')))
  assert.equal(data.v, 3)
  assert.equal(data.groups[0].path, '图元')
  assert.match(decode(studio.exportData('primitive-svg', 'picture')), /<svg/)
  assert.match(decode(studio.exportData('primitive-css', 'resource')), /background/)
  assert.match(decode(studio.exportData('primitive-lib')), /InstantiateClientUIControl/)
  assert.match(decode(studio.exportData('timeline-lib')), /TweenSequence/)
  assert.deepEqual(studio.archiveData(), before)
})

test('GIA bakes fitted children and mounts opacity playback without mutating authoring', () => {
  const studio = open(), before = studio.archiveData()
  const result = studio.exportData('gia', 'client-control-template')
  const imported = importGia(Buffer.from(result.data, 'base64'))
  const root = imported.project.root.children[0]
  assert.equal(root.children[0].kind, 'container')
  assert.equal(root.children[0].children[0].imageId, 100001)
  assert.ok(imported.scripts.some(row => row.source.includes('groupAlpha')))
  assert.deepEqual(studio.archiveData(), before)
  assert.equal(find(before.assets.client.root, 'picture').kind, 'image')
})

test('baked Runtime opacity animation changes fitted children while the source archive stays editable', () => {
  const studio = open(), before = studio.archiveData()
  studio.playStart()
  const snap = studio.playStep(.5, { inspect: true })
  const row = snap.tree[0].children[0].children[0]
  assert.equal(row.kind, 'image')
  assert.equal(row.imageColor >>> 24, 128)
  assert.deepEqual(studio.archiveData(), before)
  studio.playStop()
})
