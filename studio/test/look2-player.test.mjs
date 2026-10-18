import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStudio, importGia, importScriptGia, validateGiaCompatibility } from '../index.js'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { unpackRgba } from '../../client/lua-runtime/src/color.js'
import { exportSiteJson, importSiteJson } from '../look2/site-json.js'
import { buildAnimationScripts } from '../look2/player.js'
import { sampleTrack, EASE_TYPES } from '../look2/sampling.js'
import { previewAnimation } from '../look2/preview.js'
import { compileProject } from '../play/compile.js'

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64')
function fixture(tracks = []) {
  return { version: 12, name: '播放测试', nodes: [
    { id: 'root', name: '根', type: 'container', parentId: null, sizeDeltaX: 400, sizeDeltaY: 300 },
    { id: 'child', name: '中文/图片', type: 'image', parentId: 'root', sizeDeltaX: 80, sizeDeltaY: 50,
      anchorOffsetX: 20, properties: { imageId: 100001 } },
  ], animations: [{ id: 'a', name: '动画', duration: 2, keyframeTracks: tracks }], activeAnimationId: 'a' }
}
const track = (fieldKey, keyframes, nodeId = 'child') => ({ id: `${nodeId}-${fieldKey}`, nodeId, fieldKey, keyframes })
const keys = (from, to, extra = {}) => [{ time: 0, value: from, ...extra }, { time: 1, value: to }]
function studioFor(input) {
  const studio = createStudio()
  studio.importData('json', b64(input), 'fixture.json')
  return studio
}
function find(rows, name) {
  for (const row of rows) {
    if (row.name === name) return row
    const child = find(row.children || [], name)
    if (child) return child
  }
}

test('current client animation runs once, holds its end, and leaves the archive untouched', () => {
  const studio = studioFor(fixture([track('anchoredPositionX', keys(20, 100))]))
  const before = studio.archiveData()
  const start = studio.playStart({ inspect: true })
  assert.equal(find(start.tree, '中文/图片').anchoredPositionX, 20)
  assert.equal(find(studio.playStep(.5, { inspect: true }).tree, '中文/图片').anchoredPositionX, 60)
  assert.equal(find(studio.playStep(2, { inspect: true }).tree, '中文/图片').anchoredPositionX, 100)
  assert.equal(find(studio.playStep(1, { inspect: true }).tree, '中文/图片').anchoredPositionX, 100)
  assert.deepEqual(studio.archiveData(), before)
  assert.equal(studio.get().scripts.length, 0)
  studio.playStop()
})

test('AN04 sampling holds the exact last key after the final boundary', () => {
  const position = track('anchoredPositionX', [
    { id: 'start', time: 0, value: 20, interpolation: 'tween', easeType: 'Linear' },
    { id: 'end', time: 1, value: 100, interpolation: 'tween', easeType: 'Linear' },
  ])
  const visibility = track('visible', [
    { id: 'hidden', time: 0, value: false, interpolation: 'step' },
    { id: 'shown', time: 1, value: true, interpolation: 'step' },
  ])
  for (const time of [1, 1.00001, 1.5, 2, 8]) {
    assert.equal(sampleTrack(position, time, 5), 100, `position @ ${time}`)
    assert.equal(sampleTrack(visibility, time, false), true, `visible @ ${time}`)
  }
  assert.equal(sampleTrack(position, 0.5, 5), 60)
  assert.equal(sampleTrack(visibility, 0.5, false), false)
  const studio = studioFor(fixture([position, visibility]))
  studio.playStart({ inspect: true })
  for (const dt of [1, 1, 3]) {
    const current = studio.playStep(dt, { inspect: true })
    assert.equal(find(current.tree, '中文/图片').anchoredPositionX, 100)
    assert.equal(find(current.tree, '中文/图片').visible, true)
  }
  studio.playStop()
})

test('self-contained Lua matches editor sampling for easing, relative values and incoming jumps', () => {
  const scenarios = EASE_TYPES.map(easeType => keys(0, 100, { easeType }))
  scenarios.push([{ time: 0, value: 0, isDelta: true }, { time: 1, value: 80, isDelta: true }])
  scenarios.push([{ time: 0, value: 5, relative: true }, { time: 1, value: 5, relative: true }])
  scenarios.push([{ time: 0, value: 5, relative: true }, { time: 1, value: 10, leftValue: 3, leftRelative: true }])
  scenarios.push([{ time: 0, value: 0 }, { time: 1, value: 100, leftValue: 40 }])
  scenarios.push(keys(0, 100, { interpolation: 'step' }))
  for (const keyframes of scenarios) {
    const input = fixture([track('anchoredPositionX', keyframes)])
    const { project, look2 } = importSiteJson(input)
    const bundle = buildAnimationScripts(project, look2)
    assert.equal(bundle.warnings.length, 0)
    for (const time of [0, .25, .5, .999, 1, 1.5, 2]) {
      const rt = createRuntime()
      const root = rt.addRoot({ name: '根', active: true, children: [{ name: '中文/图片', kind: 'image', active: true, anchoredPositionX: 20 }] })
      rt.mountScript({ path: bundle.scripts[0].path, control: root,
        source: `${bundle.scripts[0].source}\nfunction OnStart() Look2Seek(${time}) end` })
      assert.equal(rt.mountErrors.length, 0)
      assert.equal(rt.logs.filter(row => row.level === 'error').length, 0)
      const expected = sampleTrack(input.animations[0].keyframeTracks[0], time, 20)
      assert.ok(Math.abs(root.children[0].anchoredPositionX - expected) < 1e-9,
        `scenario ${scenarios.indexOf(keyframes)} at ${time}: got ${root.children[0].anchoredPositionX}, expected ${expected}`)
    }
  }
})

test('visibility steps use SetVisible and retain the root update lifecycle', () => {
  const visibleKeys = (from, to) => [{ time: 0, value: from, interpolation: 'step' }, { time: 1, value: to, interpolation: 'step' }]
  const studio = studioFor(fixture([track('visible', visibleKeys(false, true)), track('visible', visibleKeys(true, false), 'root')]))
  const firstSnapshot = studio.playStart({ inspect: true })
  assert.equal(find(firstSnapshot.tree, '中文/图片').visible, false, JSON.stringify({ logs: firstSnapshot.logs, scripts: studio.get().scripts.map(row => row.source) }))
  const after = studio.playStep(1, { inspect: true })
  assert.equal(find(after.tree, '中文/图片').visible, true)
  assert.equal(find(after.tree, '根').visible, false)
  assert.equal(after.logs.filter(row => row.level === 'error').length, 0)
  studio.playStop()
})

test('client GIA includes generated source and mounts and plays after a fresh import', () => {
  const studio = studioFor(fixture([track('anchoredPositionX', keys(20, 100))]))
  const exported = studio.exportData('gia')
  const bytes = Buffer.from(exported.data, 'base64')
  assert.equal(validateGiaCompatibility(bytes).valid, true)
  const imported = importGia(bytes)
  assert.equal(imported.scripts.length, 1)
  assert.match(imported.scripts[0].source, /function Look2Play/)
  assert.deepEqual(imported.project.root.children[0].scriptMappingIds, [imported.scripts[0].guid])
  const fresh = createStudio()
  fresh.importData('gia', exported.data, exported.filename)
  assert.equal(fresh.get().scripts[0].mounted, true)
  assert.equal(fresh.get().scripts[0].controlAsset, 'client-control-template')
  fresh.playStart()
  assert.equal(find(fresh.playStep(.5, { inspect: true }).tree, '中文/图片').anchoredPositionX, 60)
  fresh.playStop()
})

test('site JSON roundtrip keeps native image color tracks playable in Lua and GIA', () => {
  const input = fixture([track('imageColor', [
    { time: 0, value: { r: 255, g: 0, b: 0, a: 1 } },
    { time: 1, value: { r: 0, g: 0, b: 255, a: 1 } },
  ])])
  input.nodes[1].properties = { imageId: 100001, imageColor: { r: 20, g: 40, b: 60, a: 1 } }
  const sourceStudio = studioFor(input)
  const siteJson = JSON.parse(Buffer.from(sourceStudio.exportData('site-json').data, 'base64').toString('utf8'))
  assert.equal(siteJson.nodes.find(row => row.id === 'child').type, 'image')
  assert.equal(Object.hasOwn(siteJson.nodes.find(row => row.id === 'child').properties, 'imageResourceId'), false)

  const reopened = studioFor(siteJson)
  assert.equal(reopened.get().look2.siteNodes.child.type, 'image')
  const exported = reopened.exportData('animation-lua')
  const source = Buffer.from(exported.data, 'base64').toString('utf8')
  assert.match(source, /\"imageColor\"/)
  assert.equal(exported.warnings.length, 0)

  const runColorPlayer = (playerSource, path) => {
    const runtime = createRuntime()
    const root = runtime.addRoot({ name: input.nodes[0].name, kind: 'container', active: true, children: [
      { name: input.nodes[1].name, kind: 'image', active: true, imageColor: 0xff14283c },
    ] })
    runtime.mountScript({ path, control: root, source: `${playerSource}\nfunction OnStart() Look2Seek(0.5) end` })
    assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
    assert.deepEqual(unpackRgba(root.children[0].imageColor), [127, 0, 127, 255])
  }
  runColorPlayer(source, exported.filename)

  const gia = reopened.exportData('gia')
  const importedGia = importGia(Buffer.from(gia.data, 'base64'))
  assert.equal(importedGia.scripts.length, 1)
  assert.match(importedGia.scripts[0].source, /\"imageColor\"/)
  runColorPlayer(importedGia.scripts[0].source, importedGia.scripts[0].path)
})

test('resource primitive image tracks unsupported color fields with export warnings', () => {
  const input = fixture([
    track('anchoredPositionX', keys(20, 100)),
    track('imageColor', [
      { time: 0, value: { r: 255, g: 0, b: 0, a: 1 } },
      { time: 1, value: { r: 0, g: 0, b: 255, a: 1 } },
    ]),
  ])
  input.nodes[1].type = 'primitive'
  input.nodes[1].properties = { imageSource: 'primitive', imageResourceId: 'resource-1', imageId: 100001 }
  const sourceStudio = studioFor(input)
  const siteJson = JSON.parse(Buffer.from(sourceStudio.exportData('site-json').data, 'base64').toString('utf8'))
  const image = siteJson.nodes.find(row => row.id === 'child')
  assert.equal(image.type, 'primitive')
  assert.equal(image.properties.imageResourceId, 'resource-1')

  const reopened = studioFor(siteJson)
  const exported = reopened.exportData('animation-lua')
  assert.match(Buffer.from(exported.data, 'base64').toString('utf8'), /\"anchoredPositionX\"/)
  assert.ok(exported.warnings.some(message => message.includes('imageColor') && message.includes('不支持')),
    JSON.stringify(exported.warnings))
  assert.ok(reopened.exportData('gia').warnings.some(message => message.includes('imageColor') && message.includes('不支持')))
})

test('unsupported or ambiguous tracks warn rather than emitting invalid Lua', () => {
  const input = fixture([track('groupAlpha', keys(300, 0)), track('fontSize', keys(20, 40)),
    track('anchoredPositionX', keys(20, 100, { easeType: 'UnknownEase' })), track('fillAmount', keys(0, 1), 'missing')])
  const { project, look2 } = importSiteJson(input)
  const bundle = buildAnimationScripts(project, look2)
  assert.equal(bundle.scripts.length, 0)
  assert.equal(bundle.warnings.length, 4)
  const studio = studioFor(input)
  assert.throws(() => studio.exportData('animation-lua'), /没有可播放/)
  assert.equal(studio.exportData('gia').warnings.filter(row => row.includes('未导出')).length, 4)
  input.nodes.push({ ...input.nodes[1], id: 'duplicate' })
  input.animations[0].keyframeTracks = [track('anchoredPositionX', keys(20, 100))]
  const duplicate = importSiteJson(input)
  assert.match(buildAnimationScripts(duplicate.project, duplicate.look2).warnings[0], /同名/)
})

test('legacy duplicate sampling remains stable while reference Lua export rejects duplicate times', () => {
  const duplicate = [{ time: 0, value: 0 }, { time: 1, value: 10 }, { time: 1, value: 100 }]
  assert.equal(sampleTrack(track('anchoredPositionX', duplicate), 1, 20), 100)
  const { project, look2 } = importSiteJson(fixture([track('anchoredPositionX', duplicate)]))
  const bundle = buildAnimationScripts(project, look2)
  assert.equal(bundle.scripts.length, 0)
  assert.match(bundle.warnings[0], /重复时间/)
})

test('generated scripts coexist with user scripts without GUID collisions or remounting', () => {
  const studio = studioFor(fixture([track('anchoredPositionX', keys(20, 100))]))
  studio.patch({ op: 'addScript', source: 'function OnStart() print("user-script") end', path: 'user.lua', controlId: 'root', controlAsset: 'client-control-template' })
  const original = studio.archiveData()
  const exported = studio.exportData('gia')
  const imported = importGia(Buffer.from(exported.data, 'base64'))
  assert.equal(imported.scripts.length, 2)
  assert.equal(new Set(imported.scripts.map(row => row.guid)).size, 2)
  assert.equal(imported.project.root.children[0].scriptMappingIds.length, 2)
  assert.deepEqual(studio.archiveData(), original)
})

test('hierarchy preview applies parent transforms and captures current platform base values', () => {
  const input = fixture([track('anchoredPositionX', keys(0, 100), 'root'), track('localScaleX', keys(1, 2), 'root')])
  const { project, look2 } = importSiteJson(input)
  const compiled = compileProject(project)
  const start = previewAnimation(compiled.root, look2.animations[0], 0, { width: 1600, height: 900 })
  const end = previewAnimation(compiled.root, look2.animations[0], 1, { width: 1600, height: 900 })
  const a = start.find(row => row.id === 'child'), b = end.find(row => row.id === 'child')
  assert.equal(b.matrix.a, 2)
  assert.equal(b.topLeft.x - a.topLeft.x, 80)
  assert.equal(b.base.anchoredPositionX, 20)
  assert.equal(compiled.root.localScaleX, 1)
})

test('animation can target multiple roots and script export selects the requested root', () => {
  const input = fixture([track('anchoredPositionX', keys(0, 100), 'root'), track('anchoredPositionX', keys(0, 80), 'other')])
  input.nodes.push({ id: 'other', name: '另一个根', type: 'container', parentId: null })
  const studio = studioFor(input)
  const exported = studio.exportData('animation-lua', 'other')
  assert.match(Buffer.from(exported.data, 'base64').toString(), /80/)
  assert.equal(importGia(Buffer.from(studio.exportData('gia').data, 'base64')).scripts.length, 2)
})

test('font size and image fill tracks only write fields supported by each control type', () => {
  const input = fixture([track('fillAmount', keys(0, 1)), track('fontSize', keys(20, 40), 'text')])
  input.nodes.push({ id: 'text', name: '文本', type: 'textbox', parentId: 'root', properties: { text: '动画', fontSize: 20 } })
  const studio = studioFor(input)
  studio.playStart()
  const snapshot = studio.playStep(.5, { inspect: true })
  assert.equal(find(snapshot.tree, '中文/图片').fillAmount, .5)
  assert.equal(find(snapshot.tree, '文本').fontSize, 30)
  assert.equal(snapshot.logs.filter(row => row.level === 'error').length, 0)
  studio.playStop()
})

test('replacing a client GIA clears unrelated animation state instead of replaying stale tracks', () => {
  const studio = studioFor(fixture([track('anchoredPositionX', keys(20, 100))]))
  const exported = studio.exportData('gia')
  studio.importData('gia', exported.data, exported.filename)
  assert.equal(studio.get().look2.animations[0].keyframeTracks.length, 0)
  assert.equal(studio.get().scripts.length, 1)
  studio.playStart()
  assert.equal(find(studio.playStep(.5, { inspect: true }).tree, '中文/图片').anchoredPositionX, 60)
  studio.playStop()
})

test('one generated player compiles every animation, honors its startup id, and restores baselines on switches and stop', () => {
  const input = fixture([
    track('anchoredPositionX', keys(20, 100)),
    track('visible', [{ time: 0, value: false, interpolation: 'step' }, { time: 1, value: true, interpolation: 'step' }]),
    track('groupAlpha', keys(127.5, 127.5), 'root'),
  ])
  input.animations[0].name = 'Alpha'
  input.animations.push({ id: 'b', name: 'Beta', duration: 2,
    keyframeTracks: [track('anchoredPositionY', keys(10, 30))] })
  const { project, look2 } = importSiteJson(input)
  const bundle = buildAnimationScripts(project, look2)
  assert.equal(bundle.scripts.length, 1, 'all animation data shares one player for this template root')
  assert.match(bundle.scripts[0].source, /"Beta"/)

  const rootData = { name: '根', kind: 'container', active: true, children: [
    { name: '中文/图片', kind: 'image', active: true, visible: true,
      anchoredPositionX: 20, anchoredPositionY: 7, imageColor: 0xc814283c },
  ] }
  const runtime = createRuntime()
  const root = runtime.addRoot(rootData)
  const player = runtime.mountScript({ path: bundle.scripts[0].path, control: root, source: bundle.scripts[0].source })
  const image = root.children[0]
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
  assert.equal(image.anchoredPositionX, 20)
  assert.equal(image.visible, false)
  assert.equal(image.imageColor >>> 24, 100, 'group alpha applies to the captured alpha baseline')
  runtime.step(.25)
  assert.equal(image.anchoredPositionX, 40)
  player.invoke('Look2Pause', [])
  runtime.step(.25)
  assert.equal(image.anchoredPositionX, 40, 'pause stops the selected player')
  player.invoke('Look2Resume', [])
  runtime.step(.25)
  assert.equal(image.anchoredPositionX, 60, 'resume continues the same animation time')

  assert.equal(player.invoke('Look2PlayById', ['b']), true)
  assert.equal(image.anchoredPositionX, 20, 'switch restores properties only controlled by the prior animation')
  assert.equal(image.anchoredPositionY, 10)
  assert.equal(image.visible, true)
  assert.equal(image.imageColor, 0xc814283c, 'switch restores the original packed color and alpha')
  runtime.step(.5)
  assert.equal(image.anchoredPositionY, 20)
  assert.equal(image.anchoredPositionX, 20)
  assert.equal(player.invoke('Look2Stop', []), true)
  assert.equal(image.anchoredPositionY, 7)
  assert.equal(image.anchoredPositionX, 20)
  assert.equal(image.visible, true)
  assert.equal(image.imageColor, 0xc814283c)

  const selected = buildAnimationScripts(project, look2, [], [], { animationId: 'b' })
  assert.match(selected.scripts[0].source, /local defaultAnimationId = "b"/)
  const selectedRuntime = createRuntime()
  const selectedRoot = selectedRuntime.addRoot(rootData)
  selectedRuntime.mountScript({ path: selected.scripts[0].path, control: selectedRoot, source: selected.scripts[0].source })
  assert.equal(selectedRoot.children[0].anchoredPositionY, 10, 'the requested animation starts automatically')
  assert.equal(selectedRoot.children[0].visible, true)
})

test('generated players mount before user OnStart and retain that order in GIA exports', () => {
  const input = fixture([track('anchoredPositionX', keys(20, 100))])
  input.animations[0].name = 'Alpha'
  input.animations.push({ id: 'b', name: 'Beta', duration: 2,
    keyframeTracks: [track('anchoredPositionX', keys(10, 90))] })
  const studio = studioFor(input)
  const initialFilename = studio.exportData('animation-lua', 'root').filename
  const playerPath = initialFilename.replace(/\\/g, '/').replace(/\.lua$/i, '').split('/').pop()
  const added = studio.patch({ op: 'addScript', path: 'controller.lua', controlId: 'root', controlAsset: 'client-control-template', source: 'function OnStart() end' })
  studio.patch({ op: 'add', kind: 'button', parentId: 'root', name: '后来添加的控件' })
  const filename = studio.exportData('animation-lua', 'root').filename
  assert.equal(filename, initialFilename, 'adding a user script or control must not change the generated player path')
  const userScript = added.scripts.find(row => row.path === 'controller.lua')
  studio.patch({ op: 'updateScript', id: userScript.id, source: `
function OnStart()
  local player = script.object:GetScriptByPath(${JSON.stringify(playerPath)})
  assert(player ~= nil, "generated animation player must mount before OnStart")
  player:Invoke("Look2PlayById", "b")
end
` })

  const started = studio.playStart({ inspect: true })
  assert.equal(find(started.tree, '中文/图片').anchoredPositionX, 10, JSON.stringify(started.logs))
  assert.equal(started.logs.filter(row => row.level === 'error').length, 0, JSON.stringify(started.logs))
  assert.equal(find(studio.playStep(.5, { inspect: true }).tree, '中文/图片').anchoredPositionX, 50)
  studio.playStop()

  const exported = studio.exportData('gia')
  const imported = importGia(Buffer.from(exported.data, 'base64'))
  assert.match(imported.scripts[0].source, /^-- look2\.0 generated animation player/)
  const scriptBundle = JSON.parse(Buffer.from(studio.exportData('scripts').data, 'base64').toString('utf8'))
  assert.match(scriptBundle.scripts[0].source, /^-- look2\.0 generated animation player/)
  const scriptGia = importScriptGia(Buffer.from(studio.exportData('scripts-gia').data, 'base64'))
  assert.match(scriptGia.scripts[0].source, /^-- look2\.0 generated animation player/)
  const combined = importGia(Buffer.from(studio.exportData('gia-combined').data, 'base64'))
  assert.match(combined.scripts[0].source, /^-- look2\.0 generated animation player/)

  const fresh = createStudio()
  fresh.importData('gia', exported.data, exported.filename)
  const importedStart = fresh.playStart({ inspect: true })
  assert.equal(importedStart.logs.filter(row => row.level === 'error').length, 0, JSON.stringify(importedStart.logs))
  assert.equal(find(fresh.playStep(.5, { inspect: true }).tree, '中文/图片').anchoredPositionX, 50)
  fresh.playStop()
})

test('generated player paths safely derive from a stable root id when the root has no GUID', () => {
  const input = fixture([track('anchoredPositionX', keys(20, 100))])
  const { project, look2 } = importSiteJson(input)
  const root = project.root.children[0]
  delete root.guid
  const first = buildAnimationScripts(project, look2).scripts[0]
  root.children.push({ id: 'new-child', name: '新控件', kind: 'button', children: [] })
  const second = buildAnimationScripts(project, look2).scripts[0]
  assert.equal(first.path, 'look2-animation-id-72-6f-6f-74.1.lua')
  assert.equal(second.path, first.path)
})

test('animation name lookup rejects duplicates while id lookup and template instances remain independent', () => {
  const input = fixture([track('anchoredPositionX', keys(20, 100))])
  input.animations[0].name = 'Repeated'
  input.animations.push({ id: 'b', name: 'Repeated', duration: 1,
    keyframeTracks: [track('anchoredPositionY', keys(5, 25))] })
  const { project, look2 } = importSiteJson(input)
  const bundle = buildAnimationScripts(project, look2)
  assert.ok(bundle.warnings.some(message => message.includes('Look2PlayByName')))

  const makeRoot = () => createRuntimeRoot()
  function createRuntimeRoot() {
    return {
      name: '根', kind: 'container', active: true, children: [
        { name: '中文/图片', kind: 'image', active: true, anchoredPositionX: 20, anchoredPositionY: 3 },
      ],
    }
  }
  const runtime = createRuntime()
  const firstRoot = runtime.addRoot(makeRoot())
  const secondRoot = runtime.addRoot(makeRoot())
  const first = runtime.mountScript({ path: bundle.scripts[0].path, control: firstRoot, source: bundle.scripts[0].source })
  runtime.mountScript({ path: bundle.scripts[0].path, control: secondRoot, source: bundle.scripts[0].source })
  assert.equal(first.invoke('Look2PlayByName', ['Repeated']), false)
  assert.ok(runtime.logs.some(row => row.text?.includes('ambiguous name Repeated')))
  assert.equal(first.invoke('Look2PlayById', ['b']), true)
  runtime.step(.5)
  assert.equal(firstRoot.children[0].anchoredPositionX, 20)
  assert.equal(firstRoot.children[0].anchoredPositionY, 15)
  assert.equal(secondRoot.children[0].anchoredPositionX, 60)
  assert.equal(secondRoot.children[0].anchoredPositionY, 3)
})

test('explicit event bindings use Runtime GetScriptByPath and Invoke, preserve same-time order, and isolate handler errors', () => {
  const input = fixture([])
  input.animations[0].events = [
    { id: 'start', time: 0, name: 'start', target: '', params: 'zero' },
    { id: 'first', time: .5, name: 'first', target: '', params: 'one' },
    { id: 'second', time: .5, name: 'second', target: '', params: 'two' },
  ]
  const { project, look2 } = importSiteJson(input)
  const bundle = buildAnimationScripts(project, look2)
  assert.equal(bundle.scripts.length, 1, 'event-only templates receive a player')
  const playerSource = bundle.scripts[0].source
    + '\nfunction Look2OnEvent(event) print("callback:" .. event.name) end'
  const runtime = createRuntime()
  const root = runtime.addRoot({ name: '根', kind: 'container', active: true })
  runtime.mountScript({ path: 'handler.lua', control: root,
    source: 'function HandleLook2Event(event, target) print("handler:" .. event.name .. ":" .. event.params .. ":" .. target.name); if event.name == "second" then error("handler exploded") end end' })
  runtime.mountScript({ path: bundle.scripts[0].path, control: root, source: playerSource })
  const playerPath = bundle.scripts[0].path.replace(/\.lua$/i, '').split(/[\\/]/).pop()
  const binderSource = [
    'function OnStart()',
    '  local player = script.object:GetScriptByPath("' + playerPath + '")',
    '  player:Invoke("Look2PlayByName", "动画")',
    '  player:Invoke("Look2BindEvent", "start", "", "HandleLook2Event", "fusion/handler.lua")',
    '  player:Invoke("Look2BindEvent", "first", "", "HandleLook2Event", "fusion/handler.lua")',
    '  player:Invoke("Look2BindEvent", "second", "", "HandleLook2Event", "fusion/handler.lua")',
    'end',
  ].join('\n')
  runtime.mountScript({ path: 'binder.lua', control: root, source: binderSource })
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
  assert.ok(runtime.logs.some(row => row.text?.includes('callback:start')), 'legacy callback fires at playback start')
  runtime.step(.5)
  const handlerRows = runtime.logs.filter(row => row.text?.startsWith('handler:')).map(row => row.text)
  assert.deepEqual(handlerRows, ['handler:start:zero:根', 'handler:first:one:根', 'handler:second:two:根'])
  assert.ok(runtime.logs.some(row => row.text?.includes('look2 event second failed:') && row.text.includes('handler exploded')), JSON.stringify(runtime.logs))
  assert.ok(runtime.logs.some(row => row.text?.includes('callback:first')))
  assert.ok(runtime.logs.some(row => row.text?.includes('callback:second')), 'a failed handler does not suppress the legacy callback')
})

test('seek does not fire crossed events and an animation with no tracks does not block preview', () => {
  const input = fixture([])
  input.animations[0].events = [
    { id: 'half', time: .5, name: 'half', target: '', params: '' },
  ]
  const { project, look2 } = importSiteJson(input)
  const bundle = buildAnimationScripts(project, look2)
  const runtime = createRuntime()
  const root = runtime.addRoot({ name: '根', kind: 'container', active: true })
  runtime.mountScript({ path: bundle.scripts[0].path, control: root,
    source: bundle.scripts[0].source + '\nfunction Look2OnEvent(event) print("seek-event:" .. event.name) end\nfunction OnStart() Look2Seek(0.75) end' })
  runtime.step(.1)
  assert.ok(!runtime.logs.some(row => row.text?.includes('seek-event:half')))

  const noTrack = importSiteJson(fixture([]))
  assert.deepEqual(buildAnimationScripts(noTrack.project, noTrack.look2).scripts, [])
  const studio = studioFor(fixture([]))
  const started = studio.playStart({ inspect: true })
  assert.equal(started.logs.filter(row => row.level === 'error').length, 0)
  assert.equal(studio.get().scripts.length, 0)
  studio.playStop()
})

test('static event handlers survive site JSON round trips, resolve within their root, and take precedence over name bindings', () => {
  const input = fixture([])
  input.nodes.push({ id: 'other-root', name: '另一个根', type: 'container', parentId: null })
  input.animations[0].events = [
    { id: 'start', time: 0, name: 'start', target: '', nodeId: 'root', params: 'zero',
      handler: { targetNodeId: 'root', scriptPath: 'fusion/controller.lua', functionName: 'HandleStatic' } },
    { id: 'foreign', time: .25, name: 'foreign', target: '', nodeId: 'root', params: 'still logged',
      handler: { targetNodeId: 'other-root', scriptPath: 'controller.lua', functionName: 'HandleStatic' } },
    { id: 'empty', time: .5, name: 'empty', target: '', nodeId: 'root', params: 'also logged',
      handler: { targetNodeId: 'root', scriptPath: '', functionName: '' } },
  ]
  const { project, look2 } = importSiteJson(input)
  assert.deepEqual(look2.animations[0].events[0].handler, input.animations[0].events[0].handler)
  assert.deepEqual(exportSiteJson(project, look2).animations[0].events[0].handler, input.animations[0].events[0].handler)
  const bundle = buildAnimationScripts(project, look2, [
    { path: 'fusion/controller.lua', controlId: 'root', controlAsset: 'client-control-template' },
  ])
  assert.ok(bundle.warnings.some(message => message.includes('处理脚本目标必须位于事件的同一模板根')))
  assert.ok(bundle.warnings.some(message => message.includes('scriptPath 和 functionName 不能为空')))
  assert.equal(bundle.scripts.length, 1, 'invalid handlers do not remove their events')

  const runtime = createRuntime()
  const root = runtime.addRoot({ name: '根', kind: 'container', active: true })
  const playerScript = bundle.scripts[0]
  runtime.mountScript({ path: playerScript.path, control: root,
    source: playerScript.source + '\nfunction Look2OnEvent(event) print("callback:" .. event.name .. ":" .. event.params) end' })
  assert.ok(runtime.logs.some(row => row.text?.includes('callback:start:zero')))
  runtime.mountScript({ path: 'fusion/controller.lua', control: root,
    source: 'function HandleStatic(event) print("static:" .. event.name); if event.name == "start" then error("static handler failed") end end' })
  runtime.mountScript({ path: 'dynamic.lua', control: root,
    source: 'function HandleDynamic(event) print("dynamic:" .. event.name) end' })
  const playerPath = playerScript.path.replace(/\.lua$/i, '').split(/[\\/]/).pop()
  runtime.mountScript({ path: 'binder.lua', control: root, source: [
    'function OnStart()',
    '  local player = script.object:GetScriptByPath("' + playerPath + '")',
    '  player:Invoke("Look2BindEvent", "start", "", "HandleDynamic", "dynamic.lua")',
    'end',
  ].join('\n') })

  runtime.step(.6)
  assert.ok(runtime.logs.some(row => row.text?.includes('static:start')))
  assert.ok(runtime.logs.some(row => row.text?.includes('look2 event start failed:') && row.text.includes('static handler failed')))
  assert.ok(!runtime.logs.some(row => row.text?.includes('dynamic:start')), 'a static handler is not called again through the name binding')
  assert.ok(runtime.logs.some(row => row.text?.includes('callback:foreign:still logged')))
  assert.ok(runtime.logs.some(row => row.text?.includes('callback:empty:also logged')))
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
})

test('removed or renamed static handler scripts warn, omit the invalid binding, and keep the ordinary event', () => {
  const input = fixture([])
  input.animations[0].events = [{ id: 'ping', time: 0, name: 'ping', nodeId: 'root', target: '', params: 'still-fired',
    handler: { targetNodeId: 'root', scriptPath: 'fusion/controller.lua', functionName: 'HandlePing' } }]

  const makeStudio = () => {
    const studio = studioFor(input)
    const added = studio.patch({ op: 'addScript', path: 'fusion/controller.lua', controlId: 'root',
      controlAsset: 'client-control-template', source: 'function HandlePing(event) print("static:" .. event.name) end' })
    return { studio, script: added.scripts.find(row => row.path === 'fusion/controller.lua') }
  }
  const decode = studio => {
    const exported = studio.exportData('animation-lua', 'root')
    return { ...exported, source: Buffer.from(exported.data, 'base64').toString('utf8') }
  }
  const assertOrdinaryEventStillRuns = source => {
    const runtime = createRuntime()
    const root = runtime.addRoot({ name: '根', kind: 'container', active: true })
    runtime.mountScript({ path: 'player.lua', control: root,
      source: source + '\nfunction Look2OnEvent(event) print("callback:" .. event.name .. ":" .. event.params) end' })
    runtime.step(.1)
    assert.ok(runtime.logs.some(row => row.text?.includes('callback:ping:still-fired')), JSON.stringify(runtime.logs))
    assert.ok(!runtime.logs.some(row => row.text?.includes('static:ping')), JSON.stringify(runtime.logs))
  }

  for (const change of ['remove', 'rename']) {
    const { studio, script } = makeStudio()
    const valid = decode(studio)
    assert.ok(!valid.warnings.some(message => message.includes('不存在路径')), JSON.stringify(valid.warnings))
    assert.match(valid.source, /fusion\/controller\.lua/)
    if (change === 'remove') studio.patch({ op: 'removeScript', id: script.id })
    else studio.patch({ op: 'updateScript', id: script.id, path: 'fusion/renamed.lua' })

    const invalid = decode(studio)
    assert.ok(invalid.warnings.some(message => message.includes('不存在路径') && message.includes('fusion/controller.lua')), JSON.stringify(invalid.warnings))
    assert.doesNotMatch(invalid.source, /fusion\/controller\.lua/)
    assert.match(invalid.source, /ping/)
    assertOrdinaryEventStillRuns(invalid.source)
  }
})
