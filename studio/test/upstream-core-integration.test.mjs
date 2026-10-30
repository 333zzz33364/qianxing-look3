import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudio, importGia } from '../index.js'
import { findNode, walk } from '../ui/authoring.js'

const config = { version: 1, workspaceDir: '脚本', clientImportRoot: 'C:/isolated-client', clientSubdir: 'ui' }
const at = (studio, id) => findNode(studio.archiveData().assets.server.root, id)

test('GUID and sync domains share atomic transactions, history and explicit persistence with Look2 state', () => {
  const studio = createStudio()
  const before = studio.archiveData()
  assert.throws(() => studio.transaction({ expectedRevision: studio.get().version, ops: [
    { op: 'setControlGuid', id: 'n2', guid: 1073741941 },
    { op: 'setScriptSync', config },
    { op: 'set', id: 'n2', key: 'unknown-property', value: true },
  ] }), /unknown key/)
  assert.deepEqual(studio.archiveData(), before)
  const state = structuredClone(studio.get().look2)
  state.siteExtras = { futureFeature: { enabled: true } }
  studio.transaction({ expectedRevision: studio.get().version, state, ops: [
    { op: 'setControlGuid', id: 'n2', guid: 1073741941 }, { op: 'setScriptSync', config },
  ] })
  const changed = studio.archiveData()
  assert.equal(changed.controlGuidChanges.length, 1)
  assert.deepEqual(changed.scriptSync, config)
  assert.deepEqual(changed.look2ByAsset.server.siteExtras, state.siteExtras)
  studio.history({ action: 'undo', expectedRevision: studio.get().version })
  assert.equal(at(studio, 'n2').guid, findNode(before.assets.server.root, 'n2').guid)
  assert.deepEqual(studio.get().controlGuidChanges, [])
  assert.equal(studio.get().scriptSync, null)
  studio.history({ action: 'redo', expectedRevision: studio.get().version })
  assert.equal(at(studio, 'n2').guid, 1073741941)
  assert.deepEqual(studio.get().controlGuidChanges, changed.controlGuidChanges)
  assert.deepEqual(studio.get().scriptSync, config)
  const reopened = createStudio(JSON.parse(Buffer.from(studio.exportData('save').data, 'base64')))
  assert.deepEqual(reopened.archiveData(), studio.archiveData())
})

test('save and project unknown metadata survive load edit save and history', () => {
  const seed = createStudio().archiveData()
  seed.meta.futureSave = { flags: [1, 'two'] }
  seed.assets.server.meta.futureProject = { retained: true }
  findNode(seed.assets.server.root, 'n2').meta = { futureNode: { color: 'keep' } }
  const original = structuredClone(seed)
  const studio = createStudio(seed)
  studio.patch({ op: 'set', id: 'n2', key: 'text', value: 'edited' })
  const saved = studio.archiveData()
  assert.deepEqual(saved.meta.futureSave, original.meta.futureSave)
  assert.deepEqual(saved.assets.server.meta.futureProject, original.assets.server.meta.futureProject)
  assert.deepEqual(findNode(saved.assets.server.root, 'n2').meta, findNode(original.assets.server.root, 'n2').meta)
  assert.deepEqual(seed, original, 'read migration must not edit source objects')
})

test('image flags directions and fractional feather ranges round trip through actual GIA wire data', () => {
  for (const clockwise of [false, true]) {
    const studio = createStudio()
    const changes = { enableMask: true, enableFill: true, fillType: 'Radial90', fillClockwise: clockwise,
      fillHorizontalType: 'Right', fillVerticalType: 'Bottom', fillRadial90Type: 'TopRight', fillRadialType: 'Left',
      horizontalSoftRange: 37.25, verticalSoftRange: 83.75, reverseMaskArea: true, fillAmount: 0.42 }
    studio.transaction({ expectedRevision: studio.get().version, ops: Object.entries(changes).map(([key, value]) => ({ op: 'set', id: 'n9', key, value })) })
    const exported = studio.exportData('gia')
    const imported = importGia(Buffer.from(exported.data, 'base64')).project
    let image
    walk(imported.root, node => { if (node.guid === at(studio, 'n9').guid) image = node })
    assert.ok(image)
    for (const [key, value] of Object.entries(changes)) assert.equal(image[key], value, `${key}/${clockwise}`)
    const reopened = createStudio({ ...studio.archiveData(), assets: { ...studio.archiveData().assets, server: imported } })
    assert.equal(findNode(reopened.archiveData().assets.server.root, image.id).fillClockwise, clockwise)
  }
})


test('native image direction edits stay synchronized and future numeric enums remain lossless', () => {
  const studio = createStudio()
  for (const [raw, semantic, value] of [
    ['imageField503', 'fillHorizontalType', 'Right'], ['imageField504', 'fillVerticalType', 'Top'],
    ['imageField505', 'fillClockwise', true], ['imageField506', 'fillRadial90Type', 'TopLeft'],
    ['imageField507', 'fillRadialType', 'Left'],
  ]) {
    studio.patch({ op: 'set', id: 'n9', key: `giaRaw.${raw}`, value: 1 })
    assert.equal(at(studio, 'n9')[semantic], value)
  }
  studio.patch({ op: 'set', id: 'n9', key: 'giaRaw.imageField503', value: 73 })
  const imageGuid = at(studio, 'n9').guid
  let image
  walk(importGia(Buffer.from(studio.exportData('gia').data, 'base64')).project.root, node => { if (node.guid === imageGuid) image = node })
  assert.equal(image.giaRaw.imageField503, 73)
  studio.patch({ op: 'set', id: 'n9', key: 'fillHorizontalType', value: 'Left' })
  assert.equal(at(studio, 'n9').giaRaw.imageField503, 0)
})


test('template zero index remains a library identity and reindexing updates references atomically', () => {
  const studio = createStudio()
  const source = createStudio().exportData('gia', 'client-control-template')
  const loaded = studio.template({ action: 'import', data: source.data, index: 0, expectedRevision: studio.get().version })
  const entry = studio.archiveData().look2.controlTemplates[0]
  studio.patch({ op: 'set', id: 'n4', key: 'referencedPrefabId', value: '0' })
  assert.deepEqual(studio.get().look2Warnings, [])
  studio.template({ action: 'update', id: entry.id, index: 17, expectedRevision: studio.get().version })
  assert.equal(at(studio, 'n4').referencedPrefabId, '17')
  assert.equal(at(studio, 'n4').giaRaw.templateRefSlot, '17')
  assert.equal(studio.archiveData().look2.controlTemplates[0].index, 17)
  studio.history({ action: 'undo', expectedRevision: studio.get().version })
  assert.equal(at(studio, 'n4').referencedPrefabId, '0')
  assert.equal(studio.archiveData().look2.controlTemplates[0].index, 0)
  assert.deepEqual(createStudio(studio.archiveData()).get().look2Warnings, [])
})

test('image source changes retain automatic type selection and grid progress persists across reopen', () => {
  const studio = createStudio()
  studio.patch({ op: 'set', id: 'n9', key: 'imageType', value: 'Stretch' })
  studio.patch({ op: 'set', id: 'n9', key: 'imageSource', value: 'Prefab' })
  assert.equal(at(studio, 'n9').imageType, null)
  assert.equal(studio.get().boxes.find(node => node.id === 'n9').primitive, 'missing')
  studio.patch({ op: 'set', id: 'n5', key: 'scrollProgress', value: .75 })
  assert.equal(at(studio, 'n5').scrollProgress, .75)
  assert.throws(() => studio.patch({ op: 'set', id: 'n5', key: 'scrollProgress', value: 2 }), /between/)
  const reopened = createStudio(studio.archiveData())
  assert.equal(at(reopened, 'n5').scrollProgress, .75)
  reopened.patch({ op: 'select', id: 'n5' })
  assert.equal(reopened.get().inspector.fields.find(field => field.key === 'scrollProgress').value, .75)
})


test('semantic keyboard enum names edit, save, reopen and run without inventing native GIA encodings', t => {
  const input = { version: 12, name: 'semantic-keys', nodes: [
    { id: 'root', name: 'root', type: 'container', parentId: null, properties: {} },
    { id: 'hint', name: 'hint', type: 'keyHint', parentId: 'root', properties: { keyboardKeyCode: 'MoveForwardKey', controllerKeyCode: 'JumpKey' } },
  ] }
  const original = structuredClone(input)
  const studio = createStudio()
  studio.importData('json', Buffer.from(JSON.stringify(input)).toString('base64'))
  studio.patch({ op: 'select', id: 'hint' })
  const keyboard = studio.get().inspector.fields.find(field => field.key === 'keyboardKeyCode')
  assert.equal(keyboard.type, 'enum')
  assert.equal(keyboard.value, 'MoveForwardKey')
  assert.ok(keyboard.options.some(option => option.value === 'MoveBackwardKey'))
  const reopened = createStudio(JSON.parse(Buffer.from(studio.exportData('save').data, 'base64')))
  reopened.patch({ op: 'set', id: 'hint', key: 'keyboardKeyCode', value: 'MoveBackwardKey' })
  const before = reopened.archiveData()
  assert.throws(() => reopened.exportData('gia'), /尚未核实键盘按键.*MoveBackwardKey.*GIA/)
  assert.deepEqual(reopened.archiveData(), before)
  assert.throws(() => reopened.patch({ op: 'set', id: 'hint', key: 'keyboardKeyCode', value: 'not-a-known-key' }), /已知枚举/)
  assert.deepEqual(reopened.archiveData(), before)
  const site = JSON.parse(Buffer.from(reopened.exportData('site-json').data, 'base64'))
  assert.equal(site.nodes.find(row => row.id === 'hint').properties.keyboardKeyCode, 'MoveBackwardKey')
  assert.equal(site.nodes.find(row => row.id === 'hint').properties.controllerKeyCode, 'JumpKey')
  reopened.patch({ op: 'addScript', path: 'key-check', controlId: 'hint', controlAsset: 'client-control-template',
    source: 'function OnStart() print("semantic-key", script.object.keyboardKeyCode.Name) end' })
  t.after(() => reopened.playStop())
  assert.match(reopened.playStart({ inspect: true, asset: 'client', templateRootId: 'root' }).logs.map(row => row.text).join('\n'), /semantic-key\tMoveBackwardKey/)
  reopened.playStop()
  reopened.patch({ op: 'set', id: 'hint', key: 'keyboardKeyCode', value: 'CraftspersonKey4' })
  assert.equal(reopened.archiveData().assets.client.root.children[0].children[0].keyboardKeyCode, 4)
  assert.doesNotThrow(() => reopened.exportData('gia'))
  assert.deepEqual(input, original)
})
