import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { unpackRgba } from '../../client/lua-runtime/src/color.js'
import { importSiteJson, normalizeLook2 } from '../look2/site-json.js'
import { exportTimelineData, exportTimelineLibrary, importTimelineData, parseTimelineLuaLiteral } from '../look2/timeline-lua.js'
import { buildAnimationScripts } from '../look2/player.js'
import { sampleTrack } from '../look2/sampling.js'

const baseSite = animations => ({
  version: 12, name: 'Interop', previewPresetId: 'pc-16-9',
  nodes: [
    { id: 'root', name: 'Root', type: 'container', parentId: null, sizeDeltaX: 400, sizeDeltaY: 300 },
    { id: 'image', name: '图像', type: 'image', parentId: 'root', anchorOffsetX: 20, sizeDeltaX: 80, sizeDeltaY: 60,
      properties: { imageId: 100001, imageColor: { r: 20, g: 40, b: 60, a: 1 } } },
  ],
  animations, activeAnimationId: animations[0].id,
})

const track = (fieldKey, keyframes, nodeId = 'image') => ({ id: `${nodeId}-${fieldKey}`, nodeId, fieldKey, keyframes })

test('relative keys resolve from the preceding right value and incoming left values use that same base', () => {
  const relative = track('anchoredPositionX', [
    { time: 0, value: 5, relative: true },
    { time: 1, value: 10, relative: true, leftValue: 3, leftRelative: true },
  ])
  assert.equal(sampleTrack(relative, 0, 20), 25)
  assert.equal(sampleTrack(relative, .5, 20), 26.5)
  assert.equal(sampleTrack(relative, 1, 20), 35)
  assert.deepEqual(sampleTrack(track('imageColor', [
    { time: 0, value: { r: 255, g: 0, b: 0, a: 1 } },
    { time: 1, value: { r: 0, g: 0, b: 255, a: 0 } },
  ]), .5, { r: 0, g: 0, b: 0, a: 1 }), { r: 127.5, g: 0, b: 127.5, a: .5 })
})

test('position, size and scale relative/leftRelative tracks match the Runtime sequence', () => {
  const fields = [
    ['anchoredPositionX', 20, 5, 10, 3, 26.5],
    ['anchoredPositionY', -4, 2, 6, -1, -2.5],
    ['sizeDeltaX', 100, 10, 20, 5, 112.5],
    ['sizeDeltaY', 50, -5, -10, -2, 44],
    ['localScaleX', 2, .25, .75, .5, 2.5],
    ['localScaleY', 1, -.1, -.2, -.05, .875],
  ]
  const tracks = fields.map(([field, , first, last, incoming]) => [field, [
    { time: 0, value: first, relative: true },
    { time: 1, value: last, relative: true, leftValue: incoming, leftRelative: true },
  ]])
  const data = `local timeline = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 8, duration = 1, tracks = {
    ${fields.map(([field], index) => `{ "", "${field}", { { 0, ${tracks[index][1][0].value}, true, "Linear", "tween" }, { 1, ${tracks[index][1][1].value}, true, "Linear", "tween", ${tracks[index][1][1].leftValue}, true } } },`).join('\n    ')}
  } }
  local sequence = TweenTimelineLib.Create(script.object, timeline)
  sequence:Play()
  script:EnableUpdate(true)
  function OnStart() sequence:Restart() end`
  const runtime = createRuntime()
  const initial = Object.fromEntries(fields.map(([field, value]) => [field, value]))
  const root = runtime.addRoot({ name: 'Root', kind: 'container', active: true, ...initial })
  const library = exportTimelineLibrary().replace(/\nreturn TweenTimelineLib\s*$/, '')
  runtime.mountScript({ path: 'relative-fields.lua', control: root, source: `${library}\n${data}` })
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
  for (const [field, baseline, first] of fields) assert.equal(root[field], baseline + first)
  runtime.step(.5)
  for (const [field, , , , , expected] of fields) {
    assert.equal(root[field], expected, `${field} at half time`)
    assert.equal(sampleTrack(track(field, tracks.find(row => row[0] === field)[1]), .5, initial[field]), expected, `${field} JS sample`)
  }
})

test('legacy semantics migrate once using preserved or project transform baselines', () => {
  const project = importSiteJson(baseSite([{ id: 'a', name: 'A', duration: 1, keyframeTracks: [] }])).project
  const old = { version: 1, activeAnimationId: 'a', animations: [{ id: 'a', duration: 1, keyframeTracks: [
    track('anchoredPositionX', [{ time: 0, value: 5, isDelta: true }]),
    track('groupAlpha', [{ time: 0, value: .5 }]),
  ] }] }
  const migrated = normalizeLook2(old, project)
  assert.equal(migrated.semanticVersion, 2)
  assert.equal(migrated.animations[0].keyframeTracks[0].keyframes[0].value, 25)
  assert.equal(migrated.animations[0].keyframeTracks[0].keyframes[0].isDelta, undefined)
  assert.equal(migrated.animations[0].keyframeTracks[1].keyframes[0].value, 127.5)

  const reference = importSiteJson(baseSite([{ id: 'a', name: 'A', duration: 1, keyframeTracks: [
    track('anchoredPositionX', [{ time: 0, value: 5, relative: true }]),
  ] }])).look2
  assert.equal(reference.animations[0].keyframeTracks[0].keyframes[0].relative, true)
})

test('Timeline Data uses UTF-8 Lua byte escapes, preserves events, and imports constants only', () => {
  const animation = { id: 'a', name: 'A', duration: 1,
    keyframeTracks: [track('anchoredPositionX', [{ time: 0, value: 5, relative: true }, { time: 1, value: 10, relative: true }])],
    events: [{ id: 'e', time: .5, name: '触发', target: '图像', params: '{"safe":true}', extension: 7 }] }
  const sourceProject = importSiteJson(baseSite([animation]))
  const lua = exportTimelineData(sourceProject.project, sourceProject.look2, 'root')
  const parsed = parseTimelineLuaLiteral(lua)
  assert.equal(parsed.tracks[0][0], '图像')
  assert.equal(parsed.events[0].name, '触发')
  assert.equal(parsed.events[0].extension, 7)

  const imported = importTimelineData(lua, sourceProject.project, sourceProject.look2, { mode: 'replace', rootId: 'root' })
  assert.equal(imported.animations[0].keyframeTracks[0].keyframes[1].relative, true)
  assert.equal(imported.animations[0].events[0].name, '触发')
  assert.equal(imported.animations[0].events[0].nodeId, 'image')
  assert.throws(() => parseTimelineLuaLiteral('return { tracks = { os.execute("bad") } }'), /非字面量|不支持的表达式/)
})

test('Timeline Data rejects invalid explicit roots and only rejects referenced slash-name paths', () => {
  const site = baseSite([{ id: 'a', name: 'A', duration: 1, keyframeTracks: [] }])
  site.nodes.push({ id: 'slash', name: 'Branch/Child', type: 'container', parentId: 'root' })
  const imported = importSiteJson(site)
  const validLook2 = { activeAnimationId: 'a', animations: [{ id: 'a', name: 'A', duration: 1,
    keyframeTracks: [track('anchoredPositionX', [{ time: 0, value: 5 }])],
    events: [{ id: 'root-event', time: 0, name: 'root-event', target: '', nodeId: 'root' }] }] }
  const lua = `local TweenTimelineData = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 8,
    duration = 1, tracks = { { "", "anchoredPositionX", { { 0, 5, false, "Linear", "tween" } } } } }
    return TweenTimelineData`

  assert.throws(() => exportTimelineData(imported.project, validLook2, 'missing-root'), /root not found: missing-root/)
  assert.throws(() => importTimelineData(lua, imported.project, imported.look2, { rootId: 'missing-root' }), /root not found: missing-root/)
  assert.doesNotThrow(() => exportTimelineData(imported.project, validLook2, 'root'), 'an unreferenced slash-name control must not block export')

  const slashTrackLook2 = { ...validLook2, animations: [{ ...validLook2.animations[0],
    keyframeTracks: [track('anchoredPositionX', [{ time: 0, value: 5 }], 'slash')], events: [] }] }
  assert.throws(() => exportTimelineData(imported.project, slashTrackLook2, 'root'), /path is not representable/)

  const slashEventLook2 = { ...validLook2, animations: [{ ...validLook2.animations[0], keyframeTracks: [],
    events: [{ id: 'slash-event', time: 0, name: 'slash-event', target: 'Branch/Child', nodeId: 'slash' }] }] }
  assert.throws(() => exportTimelineData(imported.project, slashEventLook2, 'root'), /path is not representable/)

  const slashEventWithoutIdLook2 = { ...slashEventLook2, animations: [{ ...slashEventLook2.animations[0],
    events: [{ id: 'slash-event', time: 0, name: 'slash-event', target: 'Branch/Child' }] }] }
  assert.throws(() => exportTimelineData(imported.project, slashEventWithoutIdLook2, 'root'), /path is not representable/)
})

test('Timeline Data import rejects unique paths that resolve to a slash-name control', () => {
  const site = baseSite([{ id: 'a', name: 'A', duration: 1, keyframeTracks: [] }])
  site.nodes.push({ id: 'slash', name: 'Branch/Child', type: 'container', parentId: 'root' })
  const imported = importSiteJson(site)
  const project = imported.project
  const source = body => `local TweenTimelineData = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 8,
    duration = 1, ${body} } return TweenTimelineData`
  const trackSource = source('tracks = { { "Branch/Child", "anchoredPositionX", { { 0, 5, false, "Linear", "tween" } } } }')
  const eventSource = source('tracks = {}, events = { { time = 0, name = "event", target = "Branch/Child" } }')

  assert.throws(() => importTimelineData(trackSource, project, imported.look2, { rootId: 'root' }), /path is not representable/)
  assert.throws(() => importTimelineData(eventSource, project, imported.look2, { rootId: 'root' }), /path is not representable/)
})

test('reference Timeline Data versions 3 through 7 safely append and preserve RGBA colors', () => {
  const fixtures = [3, 4, 5, 6, 7].map(version => ({
    version,
    source: `local TweenTimelineData = {
  schema = "ClientUIAnimationEditor.TweenTimeline@${version}",
  version = ${version},
  duration = 1,
  tracks = {
    { "图像", "imageColor", {
      { 0, { r = 230, g = 40, b = 15, a = 1 }, false, "Linear", "tween" },
      { 1, { r = 5, g = 80, b = 210, a = 0.25 }, false, "Linear", "tween" },
    } },
  },
}
return TweenTimelineData`,
  }))
  const sourceProject = importSiteJson(baseSite([{ id: 'existing', name: 'Existing', duration: 2, keyframeTracks: [] }]))
  for (const fixture of fixtures) {
    const parsed = parseTimelineLuaLiteral(fixture.source)
    assert.equal(parsed.version, fixture.version)
    const appended = importTimelineData(fixture.source, sourceProject.project, sourceProject.look2, { rootId: 'root' })
    assert.equal(appended.animations.length, 2, `@${fixture.version} appends without replacing`)
    assert.equal(appended.animations[0].id, 'existing')
    const imported = appended.animations[1]
    assert.equal(imported.keyframeTracks[0].fieldKey, 'imageColor')
    assert.deepEqual(imported.keyframeTracks[0].keyframes.map(key => key.value), [
      { r: 230, g: 40, b: 15, a: 1 }, { r: 5, g: 80, b: 210, a: .25 },
    ])
    const reexported = parseTimelineLuaLiteral(exportTimelineData(sourceProject.project, appended, 'root'))
    assert.deepEqual(reexported.tracks[0][2].map(key => key[1]), [
      { r: 230, g: 40, b: 15, a: 1 }, { r: 5, g: 80, b: 210, a: .25 },
    ])
    assert.throws(() => parseTimelineLuaLiteral(`${fixture.source}\nos.execute("no")`), /可执行代码/)
  }
})

test('Timeline Data import rejects unknown or contradictory version declarations and retains untagged legacy versions', () => {
  const sourceProject = importSiteJson(baseSite([{ id: 'existing', name: 'Existing', duration: 2, keyframeTracks: [] }]))
  const tracks = '{ { "图像", "anchoredPositionX", { { 0, 1, false, "Linear", "tween" } } } }'
  const acceptedLegacy = `local TweenTimelineData = { version = 3, duration = 1, tracks = ${tracks} } return TweenTimelineData`
  const appended = importTimelineData(acceptedLegacy, sourceProject.project, sourceProject.look2, { rootId: 'root' })
  assert.equal(appended.animations.length, 2)
  assert.equal(appended.animations[1].keyframeTracks[0].fieldKey, 'anchoredPositionX')

  const invalidSources = [
    [`local TweenTimelineData = { schema = "Other.Timeline@8", version = 8, duration = 1, tracks = ${tracks} } return TweenTimelineData`, /字面表 schema 不受支持/],
    [`local TweenTimelineData = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 7, duration = 1, tracks = ${tracks} } return TweenTimelineData`, /schema 与 version 不一致/],
    [`-- source ClientUIAnimationEditor.TweenTimeline@7\nlocal TweenTimelineData = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 8, duration = 1, tracks = ${tracks} } return TweenTimelineData`, /源码含有互相矛盾/],
    [`-- source ClientUIAnimationEditor.TweenTimeline@8\nlocal TweenTimelineData = { version = 7, duration = 1, tracks = ${tracks} } return TweenTimelineData`, /schema 与 version 不一致/],
    [`-- source ClientUIAnimationEditor.TweenTimeline@9\nlocal TweenTimelineData = { version = 8, duration = 1, tracks = ${tracks} } return TweenTimelineData`, /源码 schema 版本不受支持/],
    [`local TweenTimelineData = { duration = 1, tracks = ${tracks} } return TweenTimelineData`, /缺少可识别的 schema、version 或 libVersion/],
    [`local TweenTimelineData = { version = "8", duration = 1, tracks = ${tracks} } return TweenTimelineData`, /version 不受支持/],
  ]
  for (const [source, message] of invalidSources) {
    assert.throws(() => importTimelineData(source, sourceProject.project, sourceProject.look2, { rootId: 'root' }), message)
  }
})

test('event-only Timeline Data imports and rebuilds missing, empty, non-string and duplicate event IDs', () => {
  const sourceProject = importSiteJson(baseSite([{ id: 'existing', name: 'Existing', duration: 2, keyframeTracks: [] }]))
  const source = `local TweenTimelineData = {
  version = 8,
  duration = 1,
  events = {
    { id = nil, time = 0, name = "missing-id", target = "图像" },
    { id = "", time = 0.2, name = "empty-id", target = "图像" },
    { id = 17, time = 0.4, name = "numeric-id", target = "图像" },
    { id = "duplicate", time = 0.6, name = "first-duplicate", target = "图像" },
    { id = "duplicate", time = 0.8, name = "second-duplicate", target = "图像" },
  },
}
return TweenTimelineData`
  const imported = importTimelineData(source, sourceProject.project, sourceProject.look2, { rootId: 'root' })
  assert.equal(imported.animations.length, 2)
  const animation = imported.animations[1]
  assert.equal(animation.keyframeTracks.length, 0)
  assert.deepEqual(animation.events.map(event => event.name), [
    'missing-id', 'empty-id', 'numeric-id', 'first-duplicate', 'second-duplicate',
  ])
  assert.ok(animation.events.every(event => typeof event.id === 'string' && event.id.trim()))
  assert.equal(animation.events[3].id, 'duplicate')
  assert.notEqual(animation.events[4].id, 'duplicate')
  assert.equal(new Set(animation.events.map(event => event.id)).size, animation.events.length)
  assert.ok(animation.events.every(event => event.nodeId === 'image'))
})

test('generated player interpolates colors, applies absolute group alpha and dispatches crossing events only', () => {
  const animation = { id: 'a', name: 'A', duration: 1,
    keyframeTracks: [track('groupAlpha', [{ time: 0, value: 127.5 }], 'root')],
    events: [
      { id: 'e0', time: 0, name: 'start', target: '', params: 'zero' },
      { id: 'e1', time: .5, name: 'half', target: '图像', params: 'half' },
    ] }
  const source = importSiteJson(baseSite([animation]))
  const bundle = buildAnimationScripts(source.project, source.look2)
  assert.equal(bundle.scripts.length, 1)
  const rt = createRuntime()
  const root = rt.addRoot({ name: 'Root', active: true, imageColor: 0xff14283c,
    children: [{ name: '图像', kind: 'image', active: true, imageColor: 0xc814283c }] })
  const script = `${bundle.scripts[0].source}\nfunction Look2OnEvent(event, control) print("event:"..event.name..":"..event.target..":"..event.params) end`
  rt.mountScript({ path: bundle.scripts[0].path, control: root, source: script })
  assert.equal(rt.mountErrors.length, 0)
  assert.deepEqual(unpackRgba(root.children[0].imageColor), [20, 40, 60, 100])
  assert.ok(rt.logs.some(row => row.text?.includes('event:start::zero')), JSON.stringify(rt.logs))
  rt.step(.5)
  assert.ok(rt.logs.some(row => row.text?.includes('event:half:图像:half')))

  const seekRuntime = createRuntime()
  const seekRoot = seekRuntime.addRoot({ name: 'Root', active: true, children: [{ name: '图像', kind: 'image', active: true }] })
  seekRuntime.mountScript({ path: bundle.scripts[0].path, control: seekRoot,
    source: `${script}\nfunction OnStart() Look2Seek(0.75) end` })
  assert.ok(!seekRuntime.logs.some(row => row.text?.includes('event:half:')))
})

test('exported TweenTimelineLib keeps the reference Create and TweenSequence contract', () => {
  const source = exportTimelineLibrary()
  assert.match(source, /function TweenTimelineLib\.Create\(root, data, options\)/)
  assert.match(source, /game\.TweenSequence\(\)/)
  assert.match(source, /TweenTimelineLib\.create = TweenTimelineLib\.Create/)
  assert.match(source, /ResetBaseAlphas/)
  assert.doesNotMatch(source, /\b(load|string\.dump|require)\s*\(/)

  const library = source.replace(/\nreturn TweenTimelineLib\s*$/, '')
  const rt = createRuntime()
  const root = rt.addRoot({ name: 'Root', kind: 'container', active: true, children: [
    { name: 'fadeGroup', kind: 'container', active: true, children: [
      { name: '图像', kind: 'image', active: true, visible: true, imageColor: 0xc814283c },
    ] },
    { name: 'ColorPic', kind: 'image', active: true, visible: true, imageColor: 0xffff0000 },
  ] })
  const timeline = `local timeline = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 8, duration = 1, tracks = {
    { "fadeGroup", "groupAlpha", { { 0, 255, false, "Linear", "tween" }, { 1, 0, false, "Linear", "tween" } } },
    { "fadeGroup/图像", "visible", { { 0, false, false, "Linear", "step" }, { 1, true, false, "Linear", "step" } } },
    { "ColorPic", "imageColor", {
      { 0, { r = 255, g = 0, b = 0, a = 1 }, false, "Linear", "tween" },
      { 1, { r = 0, g = 0, b = 255, a = 1 }, false, "Linear", "tween" },
    } },
  }, events = {
    { time = 0, name = "start", target = "fadeGroup/图像", params = "zero" },
    { time = 0.25, name = "half", target = "fadeGroup/图像", params = "safe" },
    { time = 0.75, name = "fail", target = "fadeGroup/图像", params = "still a string" },
  } }
  local function callback(event, control)
    print("timeline:" .. event.name .. ":" .. event.params)
    if event.name == "fail" then error("callback failure") end
  end
  function OnEnable()
    TimelineFirst = TweenTimelineLib.Create(script.object, timeline, { onEvent = callback })
    TimelineFirst:Play()
    script:EnableUpdate(true)
  end
  function OnStart() TimelineFirst:Restart() end
  function OnUpdate(dt)
    TimelineElapsed = (TimelineElapsed or 0) + dt
    if not TimelineSecond and TimelineElapsed >= 0.75 then
      TimelineSecond = TweenTimelineLib.Create(script.object, timeline, { onEvent = callback })
      TimelineSecond:Play()
      print("timeline:created-again")
    end
  end`
  rt.mountScript({ path: 'timeline-lib.lua', control: root, source: `${library}\n${timeline}` })
  assert.equal(rt.mountErrors.length, 0, JSON.stringify(rt.mountErrors))
  assert.equal(root.children[0].children[0].visible, false)
  assert.equal(unpackRgba(root.children[0].children[0].imageColor)[3], 200)
  assert.deepEqual(unpackRgba(root.children[1].imageColor), [255, 0, 0, 255])
  rt.step(.5)
  assert.equal(unpackRgba(root.children[0].children[0].imageColor)[3], 100)
  assert.deepEqual(unpackRgba(root.children[1].imageColor), [127, 0, 127, 255])
  assert.ok(rt.logs.some(row => row.text?.includes('timeline:half:safe')))
  rt.step(.25)
  assert.equal(unpackRgba(root.children[0].children[0].imageColor)[3], 200, 'second Create keeps the first base alpha')
  assert.deepEqual(unpackRgba(root.children[1].imageColor), [255, 0, 0, 255], 'second Create reads the current RGB target')
  assert.equal(root.children[0].children[0].visible, false)
  assert.ok(rt.logs.some(row => row.text?.includes('timeline:created-again')))
  rt.step(.25)
  rt.step(.75)
  assert.equal(root.children[0].children[0].visible, true)
  assert.ok(rt.logs.some(row => row.text?.includes('callback failure')), JSON.stringify(rt.logs))
})

test('TweenTimelineLib checks compatible schema and versions without mutating rejected data', () => {
  const library = exportTimelineLibrary().replace(/\nreturn TweenTimelineLib\s*$/, '')
  const runtime = createRuntime()
  const root = runtime.addRoot({ name: 'Root', kind: 'container', active: true })
  const source = `${library}
  local accepted = 0
  for version = 3, 8 do
    local sequence = TweenTimelineLib.Create(script.object, {
      schema = "ClientUIAnimationEditor.TweenTimeline@" .. version, version = version, duration = 1, tracks = {},
    })
    if sequence then accepted = accepted + 1 end
  end
  local invalid = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 999, duration = 1, tracks = {} }
  local ok, message = pcall(function() TweenTimelineLib.Create(script.object, invalid) end)
  print("version-check:" .. accepted .. ":" .. tostring(ok) .. ":" .. invalid.version .. ":" .. #invalid.tracks .. ":" .. tostring(message))
  local mismatch = { schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 7, duration = 1, tracks = {} }
  local mismatchOk, mismatchMessage = pcall(function() TweenTimelineLib.Create(script.object, mismatch) end)
  print("schema-check:" .. tostring(mismatchOk) .. ":" .. tostring(mismatchMessage))`
  runtime.mountScript({ path: 'version-check.lua', control: root, source })
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
  assert.ok(runtime.logs.some(row => row.text?.includes('version-check:6:false:999:0:') && row.text.includes('supported: 3-8')), JSON.stringify(runtime.logs))
  assert.ok(runtime.logs.some(row => row.text?.includes('schema-check:false:') && row.text.includes('schema/version mismatch')), JSON.stringify(runtime.logs))
})

test('multi-turn rotation preserves the unwrapped angle in JS and Lua Runtime', () => {
  const rotation = track('localRotationZ', [
    { time: 0, value: 350 }, { time: 1, value: 730 },
  ])
  assert.equal(sampleTrack(rotation, .5, 0), 540)

  const runtime = createRuntime()
  const root = runtime.addRoot({ name: 'Root', kind: 'container', active: true, localRotationZ: 0 })
  const library = exportTimelineLibrary().replace(/\nreturn TweenTimelineLib\s*$/, '')
  const source = `${library}
  local sequence = TweenTimelineLib.Create(script.object, {
    schema = "ClientUIAnimationEditor.TweenTimeline@8", version = 8, duration = 1,
    tracks = { { "", "localRotationZ", { { 0, 350, false, "Linear", "tween" }, { 1, 730, false, "Linear", "tween" } } } },
  })
  sequence:Play()
  script:EnableUpdate(true)
  function OnStart() sequence:Restart() end`
  runtime.mountScript({ path: 'multi-turn.lua', control: root, source })
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
  runtime.step(.5)
  assert.equal(root.localRotationZ, sampleTrack(rotation, .5, 0))
})
