import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStudio } from '../index.js'

const b64 = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
const decode = result => JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'))

test('custom canvas sizes drive layout, inspector edits, save migration, and runtime without changing preset tables', () => {
  const input = fixture()
  Object.assign(input, { previewPresetId: 'custom-portrait', canvasWidth: 900, canvasHeight: 1600 })
  input.primitiveResources = []
  input.nodes[1].properties = { imageId: 100001 }
  const studio = createStudio()
  studio.importData('json', b64(input), 'custom.json')
  assert.deepEqual([studio.get().canvas.width, studio.get().canvas.height], [900, 1600])
  assert.deepEqual([studio.get().boxes.find(row => row.id === 'root').width, studio.get().boxes.find(row => row.id === 'root').height], [900, 1600])
  studio.patch({ op: 'select', id: 'image' })
  studio.patch({ op: 'set', id: 'image', key: 'posX', value: 500 })
  assert.equal(studio.get().inspector.fields.find(field => field.key === 'posX').value, 500)
  assert.equal(studio.get().root.children[0].children[0].transformByPlatform.KEYBOARD.offset.x, 50)
  const archive = studio.archiveData()
  // Old version-4 saves carry raw site settings without the new canonical metadata.
  delete archive.assets.client.meta.customCanvas
  const reopened = createStudio(archive)
  assert.deepEqual([reopened.get().canvas.width, reopened.get().canvas.height], [900, 1600])
  const play = reopened.playStart({ asset: 'client', templateRootId: 'root' })
  assert.deepEqual([play.canvasWidth, play.canvasHeight], [900, 1600])
  reopened.playStop()
  reopened.patch({ op: 'setCanvas', canvasId: 'pc-16-9' })
  assert.equal(reopened.get().canvas.width, 1600)
  reopened.history({ action: 'undo', expectedRevision: reopened.get().version })
  assert.equal(reopened.get().canvas.width, 900)
  reopened.history({ action: 'redo', expectedRevision: reopened.get().version })
  assert.equal(reopened.get().canvas.width, 1600)
  // The reference editor also permits custom dimensions with a known preset ID.
  input.previewPresetId = 'pc-16-9'
  studio.importData('json', b64(input), 'known-preset-custom-size.json')
  assert.deepEqual([studio.get().canvas.width, studio.get().canvas.height], [900, 1600])
  const restoredKnownPreset = createStudio(studio.archiveData())
  assert.deepEqual([restoredKnownPreset.get().canvas.width, restoredKnownPreset.get().canvas.height], [900, 1600])
})

function fixture() {
  const root = { id: 'root', parentId: null, name: 'Default_UI', type: 'container', active: true, visible: true,
    anchorMinX: 0, anchorMinY: 0, anchorMaxX: 1, anchorMaxY: 1, pivotX: .5, pivotY: .5,
    anchorOffsetX: 0, anchorOffsetY: 0, sizeDeltaX: 0, sizeDeltaY: 0,
    properties: { showCursor: false }, editor: { directionArrowLength: 160 } }
  const image = { id: 'image', parentId: 'root', name: '图片_1', type: 'image', active: true, visible: true,
    anchorMinX: .5, anchorMinY: .5, anchorMaxX: .5, anchorMaxY: .5, pivotX: .5, pivotY: .5,
    anchorOffsetX: -40, anchorOffsetY: 30, sizeDeltaX: 150, sizeDeltaY: 150,
    properties: { imageSource: 'primitive', primitiveResourceId: 'resource-1', imageId: 100001,
      imageColor: { r: 255, g: 128, b: 0, a: .5 }, fillType: 'unused', fillAmount: null } }
  const track = { id: 'track', nodeId: 'image', fieldKey: 'anchoredPositionX', keyframes: [
    { id: 'key-0', time: 0, value: -40, easeType: 'Linear', interpolation: 'tween' },
    { id: 'key-1', time: 1, value: 30, easeType: 'EaseIn', interpolation: 'tween' },
  ] }
  const animation = { id: 'animation-default', name: '进入', duration: 2, keyframeTracks: [track] }
  return { version: 12, name: '测试动画', previewPresetId: 'pc-16-9', frameRate: 30,
    nodes: [root, image], primitiveResources: [{ id: 'resource-1', name: '测试图', imageUrl: 'data:image/png;base64,AA==' }],
    animations: [animation], activeAnimationId: animation.id, keyframeTracks: [track],
    giaSource: { marker: 1 }, tweenTracks: [{ marker: 2 }], showContainerBones: false }
}

test('look2 site JSON and Timeline Data roundtrip preserves animation and resources', () => {
  const studio = createStudio()
  assert.equal(studio.importData('json', b64(fixture()), 'site.json').metadata.format, 'site-json')
  const exported = decode(studio.exportData('site-json'))
  assert.equal(exported.nodes.length, 2)
  assert.equal(exported.nodes[1].properties.primitiveResourceId, 'resource-1')
  assert.equal(exported.nodes[1].properties.imageColor.g, 128)
  assert.equal(exported.giaSource.marker, 1)
  assert.equal(exported.tweenTracks[0].marker, 2)
  assert.equal(exported.showContainerBones, false)
  assert.equal(exported.keyframeTracks[0].keyframes[1].value, 30)
  const lua = studio.exportData('timeline-data', 'root')
  assert.match(Buffer.from(lua.data, 'base64').toString('utf8'), /ClientUIAnimationEditor\.TweenTimeline@8/)
  assert.equal(studio.importData('lua', lua.data, lua.filename).metadata.format, 'timeline-data')
  assert.equal(studio.get().look2.animations.length, 2)
  const archive = studio.exportData('save')
  const reopened = createStudio()
  reopened.importData('json', archive.data, archive.filename)
  assert.equal(reopened.get().look2.animations.length, 2)
  assert.equal(reopened.get().look2.primitiveResources.length, 1)
})

test('site JSON preserves imported canvas settings and unknown extensions until an explicit preset selection', () => {
  const input = fixture()
  input.previewPresetId = 'custom-portrait'
  input.canvasWidth = 900
  input.canvasHeight = 1600
  input.deviceMode = 'foldable'
  input.vendorExtension = { revision: 3, flags: ['kept', 'nested'] }
  input.nodes[0].vendorNodeExtension = { editorTag: 'root' }

  const studio = createStudio()
  studio.importData('json', b64(input), 'custom-canvas.json')
  const roundtrip = decode(studio.exportData('site-json'))
  assert.equal(roundtrip.previewPresetId, 'custom-portrait')
  assert.equal(roundtrip.canvasWidth, 900)
  assert.equal(roundtrip.canvasHeight, 1600)
  assert.equal(roundtrip.deviceMode, 'foldable')
  assert.deepEqual(roundtrip.vendorExtension, input.vendorExtension)
  assert.deepEqual(roundtrip.nodes[0].vendorNodeExtension, input.nodes[0].vendorNodeExtension)
  assert.equal(Object.hasOwn(roundtrip, 'siteCanvasSettings'), false)

  const archive = studio.exportData('save')
  const reopened = createStudio()
  reopened.importData('json', archive.data, archive.filename)
  const reopenedSite = decode(reopened.exportData('site-json'))
  assert.equal(reopenedSite.previewPresetId, 'custom-portrait')
  assert.equal(reopenedSite.canvasWidth, 900)
  assert.equal(reopenedSite.canvasHeight, 1600)
  assert.equal(reopenedSite.deviceMode, 'foldable')
  assert.deepEqual(reopenedSite.vendorExtension, input.vendorExtension)

  reopened.patch({ op: 'setCanvas', canvasId: 'mobile-4-3' })
  const selectedPreset = decode(reopened.exportData('site-json'))
  assert.equal(selectedPreset.previewPresetId, 'mobile-4-3')
  assert.equal(selectedPreset.canvasWidth, 1280)
  assert.equal(selectedPreset.canvasHeight, 960)
  assert.equal(selectedPreset.deviceMode, 'mobile')
  assert.equal(Object.hasOwn(selectedPreset, 'siteCanvasSettings'), false)
  assert.equal(Object.hasOwn(reopened.get().look2, 'siteCanvasSettings'), false)
  assert.deepEqual(selectedPreset.vendorExtension, input.vendorExtension)

  let revision = reopened.get().version
  reopened.history({ action: 'undo', expectedRevision: revision })
  const undonePreset = decode(reopened.exportData('site-json'))
  assert.equal(undonePreset.previewPresetId, 'custom-portrait')
  assert.equal(undonePreset.canvasWidth, 900)
  assert.equal(undonePreset.canvasHeight, 1600)
  assert.equal(undonePreset.deviceMode, 'foldable')

  revision = reopened.get().version
  reopened.history({ action: 'redo', expectedRevision: revision })
  const redonePreset = decode(reopened.exportData('site-json'))
  assert.equal(redonePreset.previewPresetId, 'mobile-4-3')
  assert.equal(redonePreset.canvasWidth, 1280)
  assert.equal(redonePreset.canvasHeight, 960)
  assert.equal(redonePreset.deviceMode, 'mobile')
})

test('explicit canvas selection in a transaction survives stale look2 state, undo, redo, and save restore', () => {
  const input = fixture()
  input.previewPresetId = 'custom-wide'
  input.canvasWidth = 2400
  input.canvasHeight = 1000
  input.deviceMode = 'desktop-wide'
  const studio = createStudio()
  studio.importData('json', b64(input), 'custom-wide.json')

  const before = studio.get()
  studio.transaction({
    ops: [{ op: 'setCanvas', canvasId: 'pc-21-9' }],
    state: before.look2,
    expectedRevision: before.version,
    label: '选择超宽画布',
  })
  const selected = decode(studio.exportData('site-json'))
  assert.equal(selected.previewPresetId, 'pc-21-9')
  assert.equal(selected.canvasWidth, 2100)
  assert.equal(selected.canvasHeight, 900)
  assert.equal(selected.deviceMode, 'pc')
  assert.equal(Object.hasOwn(selected, 'siteCanvasSettings'), false)

  let revision = studio.get().version
  studio.history({ action: 'undo', expectedRevision: revision })
  const undone = decode(studio.exportData('site-json'))
  assert.equal(undone.previewPresetId, 'custom-wide')
  assert.equal(undone.canvasWidth, 2400)
  assert.equal(undone.canvasHeight, 1000)
  assert.equal(undone.deviceMode, 'desktop-wide')

  revision = studio.get().version
  studio.history({ action: 'redo', expectedRevision: revision })
  const redone = decode(studio.exportData('site-json'))
  assert.equal(redone.previewPresetId, 'pc-21-9')
  assert.equal(redone.canvasWidth, 2100)
  assert.equal(redone.canvasHeight, 900)
  assert.equal(redone.deviceMode, 'pc')

  const saved = studio.exportData('save')
  const reopened = createStudio()
  reopened.importData('json', saved.data, saved.filename)
  assert.deepEqual(decode(reopened.exportData('site-json')), redone)
})

test('look2 rejects cyclic site hierarchy before changing the project', () => {
  const studio = createStudio()
  const input = fixture()
  input.nodes[0].parentId = 'image'
  assert.throws(() => studio.importData('json', b64(input), 'cycle.json'), /循环|根控件/)
  assert.equal(studio.get().look2.primitiveResources.length, 0)
})

test('unused reference fill preserves the full image even when a stale amount remains', () => {
  const studio = createStudio(), input = fixture()
  input.nodes[1].properties.fillAmount = .25
  studio.importData('json', b64(input), 'unused-fill.json')
  const image = studio.archiveData().assets.client.root.children[0].children[0]
  assert.equal(image.enableFill, false)
  const properties = decode(studio.exportData('site-json')).nodes.find(row => row.id === 'image').properties
  assert.equal(properties.fillType, 'unused')
  assert.equal(properties.fillAmount, null)
})
