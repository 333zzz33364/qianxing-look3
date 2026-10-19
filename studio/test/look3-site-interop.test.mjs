import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStudio } from '../index.js'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { importSiteJson, exportSiteJson } from '../look2/site-json.js'
import { buildAnimationScripts } from '../look2/player.js'
import { exportTimelineData, exportTimelineLibrary } from '../look2/timeline-lua.js'
import { sampleTrack } from '../look2/sampling.js'

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64')
const decoded = result => JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'))
const node = (id, type, properties = {}) => ({ id, name: id, type, parentId: id === 'root' ? null : 'root',
  sizeDeltaX: 200, sizeDeltaY: 100, properties })
const document = nodes => ({ version: 12, name: 'fixed-upstream', timelineModelVersion: 10, nodes: [node('root', 'container'), ...nodes] })
const keys = (from, to) => [{ id: 'a', time: 0, value: from, easeType: 'Linear', interpolation: 'tween' },
  { id: 'b', time: 1, value: to, easeType: 'Linear', interpolation: 'tween' }]

test('all reference control type names and editable enum values survive save, reopen and site export', () => {
  const input = document([
    node('label', 'text', { text: 'one', horizontalAlignment: 'right', verticalAlignment: 'middle', adaptiveFontSize: true }),
    node('window', 'textWindow', { text: 'two', interactable: false, showScrollBar: false }),
    node('button', 'presetButton', { clickAudioId: 100, raycastTarget: false }),
    node('cursor', 'cursorEventArea', { raycastTarget: false }),
    node('grid', 'gridScroller', { scrollDirection: 'horizontal', layoutConstraint: 'fixed', itemPrefabIndex: 12, itemCount: 3, scrollProgress: .25 }),
    node('hint', 'keyHint', { keyboardKeyCode: 'CraftspersonKey3', controllerKeyCode: 'JumpKey' }),
    node('effect', 'uiAnimation', { animationId: 15, layer: 'belowAllControls', playSoundEffect: true }),
    node('full', 'fullscreenAnimation', { animationId: 16 }),
    node('reference', 'reference', { referencedPrefabIndex: 12 }),
    node('mask', 'image', { imageId: 100001, enableMask: true, enableSoftEdge: true, softEdgeMode: 'pixel',
      softEdgeWidthX: 12, softEdgeWidthY: 7, horizontalSoftRange: 80, verticalSoftRange: 60, reverseMaskArea: true,
      enableFill: true, fillType: 'radial90', fillClockwise: false, fillAmount: .25 }),
  ])
  input.nodes[1].properties.vendor = { retained: true }
  const studio = createStudio()
  studio.importData('json', b64(input), 'upstream.json')
  const saved = decoded(studio.exportData('save'))
  const reopened = createStudio(saved)
  const output = decoded(reopened.exportData('site-json'))
  assert.deepEqual(output.nodes.map(row => row.type), input.nodes.map(row => row.type))
  for (let index = 0; index < input.nodes.length; index++) {
    for (const [key, value] of Object.entries(input.nodes[index].properties)) {
      assert.deepEqual(output.nodes[index].properties[key], value, `${input.nodes[index].type}.${key}`)
    }
  }
  const grid = reopened.archiveData().assets.client.root.children[0].children.find(row => row.kind === 'grid')
  assert.equal(grid.scrollDirection, 'Horizontal')
  assert.equal(grid.itemPrefabId, 12)
  assert.equal(grid.previewCount, 3)
})

test('pre-v2 hierarchy world coordinates migrate through rotated parents and export current local coordinates', () => {
  const row = (id, parentId, fields) => ({ id, parentId, name: id, type: 'container', properties: {}, ...fields })
  const input = {
    version: 12, name: 'legacy-world-layout', hierarchyLayoutVersion: 1,
    controlModelVersion: 1, timelineModelVersion: 4,
    canvasWidth: 1600, canvasHeight: 900, nodes: [
      row('root', null, { x: 0, y: 0, width: 1600, height: 900,
        anchorMinX: 0, anchorMinY: 0, anchorMaxX: 1, anchorMaxY: 1, pivotX: .5, pivotY: .5 }),
      row('parent', 'root', { x: 0, y: 0, width: 400, height: 300,
        scaleX: 2, scaleY: 1, rotation: 90, pivotX: .5, pivotY: .5 }),
      row('child', 'parent', { type: 'image', x: 100, y: -50, width: 100, height: 80,
        anchorMinX: .25, anchorMaxX: .75, anchorMinY: .5, anchorMaxY: .5,
        pivotX: .75, pivotY: .5 }),
    ],
  }
  const { project, look2 } = importSiteJson(input)
  const child = project.root.children[0].children[0].children[0]
  assert.deepEqual(child.transformByPlatform.KEYBOARD.offset, { x: -25, y: -100 })
  assert.deepEqual(child.transformByPlatform.KEYBOARD.size, { x: -100, y: 80 })

  const output = exportSiteJson(project, look2)
  assert.equal(output.hierarchyLayoutVersion, 2)
  assert.equal(output.controlModelVersion, 2)
  assert.equal(output.timelineModelVersion, 10)
  const savedChild = output.nodes.find(item => item.id === 'child')
  assert.deepEqual([savedChild.x, savedChild.y, savedChild.width, savedChild.height], [225, 50, 100, 80])
  const reopened = importSiteJson(output).project.root.children[0].children[0].children[0]
  assert.deepEqual(reopened.transformByPlatform.KEYBOARD.offset, { x: -25, y: -100 })
  assert.deepEqual(reopened.transformByPlatform.KEYBOARD.size, { x: -100, y: 80 })
})

test('mixed pre-v2 rows use UGC defaults, custom canvas coordinates, parent pivot and Y direction', () => {
  const input = {
    version: 12, name: 'mixed-legacy-layout', hierarchyLayoutVersion: 1,
    canvasWidth: 1280, canvasHeight: 800, previewPresetId: 'custom-1280-800',
    nodes: [
      { id: 'root', name: 'root', type: 'container', parentId: null, properties: {},
        width: 1280, height: 800, anchorMinX: 0, anchorMinY: 0, anchorMaxX: 1, anchorMaxY: 1,
        pivotX: .5, pivotY: .5, anchorOffsetX: 0, anchorOffsetY: 0, sizeDeltaX: 1280, sizeDeltaY: 800 },
      { id: 'parent', name: 'parent', type: 'container', parentId: 'root', properties: {},
        width: 400, height: 300, rotation: 90, scaleX: 2, scaleY: 1, pivotX: .25, pivotY: .75,
        anchorOffsetX: 0, anchorOffsetY: 0, sizeDeltaX: 400, sizeDeltaY: 300 },
      { id: 'child', name: 'child', type: 'image', parentId: 'parent', properties: {},
        x: 100, y: 40, width: 100, height: 80 },
      { id: 'legacy-default', name: 'legacy-default', type: 'image', parentId: 'parent', properties: {},
        width: 120, height: 50, anchorOffsetX: 0, anchorOffsetY: 0, sizeDeltaX: 120, sizeDeltaY: 50 },
    ],
  }

  const { project } = importSiteJson(input)
  const root = project.root.children[0]
  const parent = root.children[0]
  const child = parent.children.find(row => row.id === 'child')
  const legacyDefault = parent.children.find(row => row.id === 'legacy-default')

  // Complete layout rows without x/y keep upstream makeNode's fixed 800x450 defaults.
  assert.deepEqual(root.transformByPlatform.KEYBOARD.offset, { x: 160, y: 50 })
  assert.deepEqual(parent.transformByPlatform.KEYBOARD.offset, { x: 0, y: 0 })
  // Missing layout state uses custom-canvas center +x and center -y, then inverse parent rotation/scale.
  assert.deepEqual(child.transformByPlatform.KEYBOARD.offset, { x: -145, y: 135 })
  assert.deepEqual(child.transformByPlatform.KEYBOARD.size, { x: 100, y: 80 })
  // A second complete row with no x/y shares the fixed upstream world default under the non-centered pivot.
  assert.deepEqual(legacyDefault.transformByPlatform.KEYBOARD.offset, { x: -100, y: 75 })
  for (const platform of ['KEYBOARD', 'TOUCHSCREEN', 'CONTROLLER_CONSOLE', 'CONTROLLER_MOBILE']) {
    assert.deepEqual(child.transformByPlatform[platform].offset, { x: -145, y: 135 }, platform)
  }
  assert.deepEqual(input.nodes[0].anchorOffsetX, 0)
  assert.equal(input.nodes[2].x, 100)
})

test('reference incoming key values drive interpolation and export with upstream names after edits', () => {
  const input = document([node('label', 'text', { fontSize: 20 })])
  input.animations = [{ id: 'anim', name: 'incoming', duration: 1, vendor: 1,
    events: [{ id: 'event', time: .5, name: 'play', nodeId: 'label', params: '{"value":1}', vendor: 'event' }],
    keyframeTracks: [{ id: 'lane', nodeId: 'label', fieldKey: 'fontSize', keyframes: [
      ...keys(20, 80).slice(0, 1), { ...keys(20, 80)[1], incomingValue: 40, incomingRelative: false, vendor: 'key' },
    ] }] }]
  const { project, look2 } = importSiteJson(input)
  const track = look2.animations[0].keyframeTracks[0]
  assert.equal(sampleTrack(track, .5, 20), 30)
  assert.equal(sampleTrack(track, 1, 20), 80)
  track.keyframes[1].leftValue = 60
  const output = exportSiteJson(project, look2)
  assert.deepEqual(output.animations[0].events, input.animations[0].events)
  assert.equal(output.animations[0].vendor, 1)
  const key = output.animations[0].keyframeTracks[0].keyframes[1]
  assert.equal(key.incomingValue, 60)
  assert.equal(key.incomingRelative, false)
  assert.equal(key.vendor, 'key')
  assert.equal(Object.hasOwn(key, 'leftValue'), false)
  assert.equal(input.animations[0].keyframeTracks[0].keyframes[1].incomingValue, 40)
})

function templateFixture() {
  const layout = { active: true, scaleX: 1, scaleY: 1, scaleZ: 1, rotationX: 0, rotationY: 0, rotationZ: 0,
    anchorMinX: .5, anchorMinY: .5, anchorMaxX: .5, anchorMaxY: .5, anchoredPositionX: 0, anchoredPositionY: 0,
    sizeDeltaX: 150, sizeDeltaY: 80, pivotX: .5, pivotY: .5 }
  return { id: 'library', index: 12, name: 'four-device-template', sourceName: 'original.gia', vendor: { kept: true },
    devices: Array.from({ length: 4 }, (_, platform) => [
      { sourceNodeIndex: 100, parentSourceNodeIndex: null, childSourceNodeIndices: [102, 101], name: 'panel', type: 'container', properties: {}, layout },
      { sourceNodeIndex: 101, parentSourceNodeIndex: 100, childSourceNodeIndices: [], name: 'top', type: 'text', properties: { text: 'first' }, layout: { ...layout, anchoredPositionX: platform * 10 } },
      { sourceNodeIndex: 102, parentSourceNodeIndex: 100, childSourceNodeIndices: [], name: 'bottom', type: 'image', properties: { imageId: 100001 }, layout },
    ]) }
}

test('reference four-device templates become usable after save/reopen and retain wire sibling order', () => {
  const input = document([])
  input.controlTemplates = [templateFixture()]
  input.controlTemplates[0].devices[1][1].properties.text = 'mobile-only'
  input.controlTemplates[0].devices[1][1].layout.vendor = { raw: true }
  const studio = createStudio()
  studio.importData('json', b64(input), 'templates.json')
  const reopened = createStudio(decoded(studio.exportData('save')))
  let snap = reopened.get()
  const entry = snap.look2.controlTemplates[0]
  assert.deepEqual(entry.project.root.children[0].children.map(row => row.name), ['top', 'bottom'])
  const top = entry.project.root.children[0].children[0]
  const platforms = ['KEYBOARD', 'TOUCHSCREEN', 'CONTROLLER_CONSOLE', 'CONTROLLER_MOBILE']
  assert.deepEqual(platforms.map(platform => top.transformByPlatform[platform].offset.x), [0, 10, 20, 30])
  snap = reopened.template({ action: 'instantiate', id: entry.id, parentId: 'root', expectedRevision: snap.version })
  const copied = reopened.archiveData().assets.client.root.children[0].children[0]
  assert.equal(copied.name, entry.name)
  assert.deepEqual(copied.children.map(row => row.name), ['top', 'bottom'])
  const output = decoded(reopened.exportData('site-json'))
  assert.equal(output.controlTemplates[0].devices.length, 4)
  assert.deepEqual(output.controlTemplates[0].vendor, { kept: true })
  assert.deepEqual(output.controlTemplates[0].devices[0][0].childSourceNodeIndices, [102, 101])
  assert.equal(output.controlTemplates[0].devices[1][1].properties.text, 'mobile-only')
  assert.deepEqual(output.controlTemplates[0].devices[1][1].layout.vendor, { raw: true })
  reopened.patch({ op: 'setCanvas', canvasId: 'mobile-16-9' })
  reopened.template({ action: 'instantiate', id: entry.id, parentId: 'root', expectedRevision: reopened.get().version })
  const mobile = reopened.archiveData().assets.client.root.children[0].children.at(-1)
  assert.equal(mobile.children[0].text, 'mobile-only')
  const before = reopened.archiveData()
  const duplicated = structuredClone(input)
  duplicated.controlTemplates.push({ ...duplicated.controlTemplates[0], id: 'duplicate-index' })
  assert.throws(() => reopened.importData('json', b64(duplicated), 'duplicate.json'), /重复/)
  assert.deepEqual(reopened.archiveData(), before)
  assert.equal(input.controlTemplates[0].project, undefined)
  const invalid = structuredClone(input)
  invalid.controlTemplates[0].devices[1][0].parentSourceNodeIndex = 101
  assert.throws(() => reopened.importData('json', b64(invalid), 'invalid.json'), /循环/)
  assert.deepEqual(reopened.archiveData(), before)
  invalid.controlTemplates = [templateFixture()]
  invalid.controlTemplates[0].devices[0][0].layout.active = 'false'
  assert.throws(() => reopened.importData('json', b64(invalid), 'invalid-active.json'), /数据无效/)
  assert.deepEqual(reopened.archiveData(), before)
})

test('legacy Tween clips migrate touching boundaries and relative values exactly once', () => {
  const input = document([node('image', 'image')])
  input.duration = 2; input.timelineModelVersion = 7; input.frameRate = 240
  input.tweenTracks = [
    { id: 'c1', nodeId: 'image', fieldKey: 'anchoredPositionX', startTime: 0, duration: 1, initialValue: 10, endValue: 30, easeType: 'Linear' },
    { id: 'c2', nodeId: 'image', fieldKey: 'anchoredPositionX', startTime: 1, duration: 1, initialValue: 50, endValue: 80, easeType: 'Linear' },
  ]
  const result = importSiteJson(input)
  const track = result.look2.animations[0].keyframeTracks[0]
  assert.equal(result.look2.frameRate, 240)
  assert.equal(sampleTrack(track, .5, 0), 20)
  assert.equal(sampleTrack(track, 1, 0), 50)
  assert.equal(sampleTrack(track, 1.5, 0), 65)
  const reopened = importSiteJson(exportSiteJson(result.project, result.look2))
  assert.equal(sampleTrack(reopened.look2.animations[0].keyframeTracks[0], .5, 0), 20)
  assert.equal(sampleTrack(reopened.look2.animations[0].keyframeTracks[0], 1, 0), 50)
  input.tweenTracks.forEach(row => { row.relative = true })
  const relative = importSiteJson(input).look2.animations[0].keyframeTracks[0]
  assert.equal(sampleTrack(relative, .5, 5), 25)
  assert.equal(sampleTrack(relative, 1, 5), 85)
  assert.equal(sampleTrack(relative, 2, 5), 115)
  const missing = document([node('label', 'text', { fontSize: 20 })])
  missing.tweenTracks = [{ id: 'missing', nodeId: 'label', fieldKey: 'fontSize', duration: 1, endValue: 40 }]
  assert.equal(sampleTrack(importSiteJson(missing).look2.animations[0].keyframeTracks[0], .5, 0), 30)
  const invalid = structuredClone(input)
  invalid.tweenTracks[1].startTime = .5
  assert.throws(() => importSiteJson(invalid), /重叠/)
})

test('Clip v4 absolute, v5 anchored and v6 parent-centered positions convert according to their source version', () => {
  const expected = new Map([
    [4, { position: [45, 65], size: [150, 170] }],
    [5, { position: [10, 30], size: [250, 270] }],
    [6, { position: [-15, 5], size: [250, 270] }],
  ])
  for (const version of [4, 5, 6]) {
    const input = document([node('image', 'image')])
    input.hierarchyLayoutVersion = 2
    input.timelineModelVersion = version
    const image = input.nodes.find(row => row.id === 'image')
    Object.assign(image, { anchorMinX: .25, anchorMaxX: .75, anchorMinY: .5, anchorMaxY: .5,
      pivotX: .75, pivotY: .5, anchorOffsetX: 0, anchorOffsetY: 0, sizeDeltaX: 0, sizeDeltaY: 100 })
    input.tweenTracks = [
      { id: `position-v${version}`, nodeId: 'image', fieldKey: 'anchoredPositionX', startTime: 0,
        duration: 1, initialValue: version === 4 ? 870 : 10, endValue: version === 4 ? 890 : 30, easeType: 'Linear' },
      { id: `size-v${version}`, nodeId: 'image', fieldKey: 'sizeDeltaX', startTime: 0,
        duration: 1, initialValue: 250, endValue: 270, easeType: 'Linear' },
    ]
    const migrated = importSiteJson(input).look2.animations[0].keyframeTracks
    const position = migrated.find(track => track.fieldKey === 'anchoredPositionX').keyframes
    const size = migrated.find(track => track.fieldKey === 'sizeDeltaX').keyframes
    assert.deepEqual(position.map(key => key.value), expected.get(version).position, `position v${version}`)
    assert.deepEqual(size.map(key => key.value), expected.get(version).size, `size v${version}`)
  }

  const rotated = document([node('image', 'image')])
  rotated.hierarchyLayoutVersion = 2
  rotated.timelineModelVersion = 4
  Object.assign(rotated.nodes[0], { rotation: 90, scaleX: 2, scaleY: 1,
    anchorOffsetX: 0, anchorOffsetY: 0 })
  Object.assign(rotated.nodes[1], { anchorMinX: .25, anchorMaxX: .75, anchorMinY: .5, anchorMaxY: .5,
    pivotX: .75, pivotY: .5, anchorOffsetX: 0, anchorOffsetY: 0, sizeDeltaX: 0, sizeDeltaY: 100 })
  rotated.tweenTracks = [{ id: 'rotated-absolute-x', nodeId: 'image', fieldKey: 'anchoredPositionX',
    startTime: 0, duration: 1, initialValue: 850, endValue: 890, easeType: 'Linear' }]
  const rotatedPosition = importSiteJson(rotated).look2.animations[0].keyframeTracks[0].keyframes
  assert.deepEqual(rotatedPosition.map(key => key.value), [0, 0], 'v4 absolute X is converted through the scaled, rotated parent basis')
})

test('legacy reference GIA mask defaults migrate only on read, with intentional changes and opaque metadata retained', () => {
  const input = document([node('gia_node_100', 'image', { enableMask: false })])
  const component = (tag, body) => ({ [tag]: {}, '503': { [Number(tag) + 1]: body } })
  input.giaSource = { document: { json: { '1': { '5': 70, '1': { '4': 100 },
    '19': { '1': { '505': [component('11', {}), component('84', { '501': 1, '999': 42 })] } } } }, dtype_csv: 'opaque' },
    baseline: [node('gia_node_100', 'image', { enableMask: false })] }
  const original = structuredClone(input)
  const restored = importSiteJson(input)
  assert.equal(restored.project.root.children[0].children[0].enableMask, true)
  assert.equal(restored.look2.siteExtras.giaSource.imageMaskVersion, 1)
  const restoredOutput = exportSiteJson(restored.project, restored.look2)
  assert.equal(restoredOutput.nodes.find(row => row.id === 'gia_node_100').properties.enableMask, true)
  assert.equal(restoredOutput.giaSource.imageMaskVersion, 1)
  assert.deepEqual(input, original)
  input.giaSource.baseline[0].properties.enableMask = true
  const edited = importSiteJson(input)
  assert.equal(edited.project.root.children[0].children[0].enableMask, false)
  assert.deepEqual(edited.look2.siteExtras.giaSource.document, input.giaSource.document)
})

test('multiple text controls and mask feather tracks animate independently in generated Lua and Timeline library', t => {
  const input = document([node('first', 'text', { fontSize: 10 }), node('second', 'text', { fontSize: 30 }),
    node('mask', 'image', { enableMask: true, softEdgeWidthX: 8 })])
  input.animations = [{ id: 'a', name: 'parallel', duration: 1, keyframeTracks: [
    { id: 'first-lane', nodeId: 'first', fieldKey: 'fontSize', keyframes: keys(10, 20) },
    { id: 'second-lane', nodeId: 'second', fieldKey: 'fontSize', keyframes: keys(30, 50) },
    { id: 'feather-lane', nodeId: 'mask', fieldKey: 'softEdgeWidthX', keyframes: keys(8, 16) },
  ] }]
  const { project, look2 } = importSiteJson(input)
  const bundle = buildAnimationScripts(project, look2)
  assert.deepEqual(bundle.warnings, [])
  const source = bundle.scripts[0].source
  const timeline = exportTimelineData(project, look2, 'root')
  const library = exportTimelineLibrary().replace(/\nreturn TweenTimelineLib\s*$/, '')
  for (const mode of ['player', 'library']) {
    const runtime = createRuntime()
    t.after(() => runtime.destroy())
    const root = runtime.addRoot({ kind: 'container', name: 'root', active: true, children: [
      { kind: 'textbox', name: 'first', active: true, fontSize: 10 }, { kind: 'textbox', name: 'second', active: true, fontSize: 30 },
      { kind: 'image', name: 'mask', active: true, softEdgeWidthX: 8 },
    ] })
    runtime.mountScript({ control: root, path: `${mode}.lua`, source: mode === 'player'
      ? `${source}\nfunction OnStart() Look2Seek(0.5) end`
      : `${library}\n${timeline.replace(/\nreturn TweenTimelineData\s*$/, '')}\nlocal sequence = TweenTimelineLib.Create(script.object, TweenTimelineData)\nsequence:Play()\n` })
    if (mode === 'library') runtime.step(.5)
    assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
    assert.equal(root.GetChild('first').fontSize, 15, mode)
    assert.equal(root.GetChild('second').fontSize, 40, mode)
    assert.equal(root.GetChild('mask').softEdgeWidthX, 12, mode)
    assert.equal(runtime.logs.filter(row => row.level === 'error').length, 0)
  }
})
