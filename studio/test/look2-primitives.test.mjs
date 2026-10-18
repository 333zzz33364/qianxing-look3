import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { createDefaultClientTemplateProject, createNode } from '../ui/authoring.js'
import { PLATFORMS } from '../constants.js'
import { createRectTransform } from '../ui/layout.js'
import {
  bakePrimitives,
  buildPrimitiveData,
  exportPrimitiveCss,
  exportPrimitiveLibrary,
  importPrimitiveCss,
  importPrimitiveSvg,
  renderPrimitiveSvg,
  validateFitData,
} from '../look2/primitives.js'
import { createPrimitiveFitJob, normalizeFitOptions } from '../../editor-ui/look2-fitting.js'

const fitFixture = () => ({
  version: 1, width: 200, height: 100,
  elements: [
    { type: 'ellipse', imageId: 100002, x: -31, y: 14, width: 45, height: 28, rotation: 17, color: { r: 230, g: 30, b: 90, a: .8 } },
    { type: 'rectangle', imageId: 100001, x: 35, y: -10, width: 40, height: 20, rotation: -32, color: { r: 12, g: 140, b: 210, a: 1 } },
    { type: 'triangle', imageId: 100003, x: 8, y: 24, width: 22, height: 30, rotation: 0, color: { r: 250, g: 190, b: 10, a: .45 } },
  ],
})

function close(a, b, tolerance = 1e-3) {
  assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`)
}

function makeProject() {
  const project = createDefaultClientTemplateProject()
  const root = project.root.children[0]
  root.id = 'root'
  root.name = '根容器'
  const transforms = Object.fromEntries(PLATFORMS.map((platform) => [platform, createRectTransform({ size: [160, 90], offset: [18, -7] })]))
  const image = createNode('image', { id: 'source', name: '源图片', guid: 42, imageId: 100001, transformByPlatform: transforms })
  const existing = createNode('textbox', { id: 'existing', name: '已有子项', guid: 99 })
  existing.children.push(createNode('image', { id: 'nested', name: 'Nested', imageId: 100001, transformByPlatform: transforms }))
  const collision = createNode('textbox', { id: 'source__primitive_001', name: 'ID 冲突', guid: 77 })
  image.children.push(existing)
  root.children.push(image, collision)
  return project
}

function findNode(root, id) {
  if (root?.id === id) return root
  for (const child of root?.children || []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return null
}

const look2Fixture = (fitData) => ({
  siteNodes: {
    source: { id: 'source', type: 'primitive', properties: { imageResourceId: 'res' } },
    nested: { id: 'nested', type: 'image', properties: { primitiveResourceId: 'res' } },
  },
  primitiveResources: [{ id: 'res', name: '图片', fitData }],
})

test('FitData validates exact fields and SVG round trips geometry, transforms and inherited fill', () => {
  const fit = fitFixture()
  assert.deepEqual(validateFitData(fit), fit)
  const svg = renderPrimitiveSvg(fit)
  const imported = importPrimitiveSvg(svg)
  assert.equal(imported.elements.length, fit.elements.length)
  for (let index = 0; index < fit.elements.length; index += 1) {
    const expected = fit.elements[index]
    const actual = imported.elements[index]
    assert.equal(actual.type, expected.type)
    assert.equal(actual.imageId, expected.imageId)
    for (const key of ['x', 'y', 'width', 'height', 'rotation']) close(actual[key], expected[key])
    for (const key of ['r', 'g', 'b', 'a']) close(actual.color[key], expected.color[key])
  }
  const inherited = importPrimitiveSvg('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><g fill="rgba(10, 20, 30, .5)" transform="translate(10 5) rotate(30)"><ellipse rx="4" ry="2"/></g></svg>')
  assert.equal(inherited.elements[0].type, 'ellipse')
  assert.deepEqual(inherited.elements[0].color, { r: 10, g: 20, b: 30, a: .5 })
  close(inherited.elements[0].x, 0)
  close(inherited.elements[0].y, 0)
  close(inherited.elements[0].rotation, -30)
  assert.throws(() => validateFitData({ ...fit, unexpected: true }), /字段/)
  const fractionalId = structuredClone(fit)
  fractionalId.elements[0].imageId += .5
  assert.throws(() => validateFitData(fractionalId), /整数/)
  const stringCoordinate = structuredClone(fit)
  stringCoordinate.elements[0].x = '12'
  assert.throws(() => validateFitData(stringCoordinate), /数值/)
})

test('Shaper CSS round trips supported shapes and imports container background as the bottom rectangle', () => {
  const fit = fitFixture()
  const css = exportPrimitiveCss(fit)
  const imported = importPrimitiveCss(css)
  assert.deepEqual(imported, fit)
  const withBackground = importPrimitiveCss('.shaper-container{width:40px;height:30px;background:rgba(1,2,3,.5)}.shaper-element{position:absolute;transform:translate(-50%,-50%)}.shaper-e0{left:calc(50% + 2px);top:calc(50% - 3px);width:10px;height:8px;background:#abcdef;border-radius:50%;transform:translate(-50%,-50%) rotate(20deg)}')
  assert.equal(withBackground.elements[0].type, 'rectangle')
  assert.deepEqual(withBackground.elements[0].color, { r: 1, g: 2, b: 3, a: .5 })
  assert.equal(withBackground.elements[1].type, 'ellipse')
  close(withBackground.elements[1].x, 2)
  close(withBackground.elements[1].y, 3)
  close(withBackground.elements[1].rotation, -20)
  assert.throws(() => importPrimitiveCss('.shaper-container{width:20px;height:20px;background:linear-gradient(red,blue)}'), /渐变/)
})

test('unsupported SVG shapes and strokes fail before an existing fit result can be replaced', () => {
  const old = fitFixture()
  const resource = { fitData: old }
  assert.throws(() => importPrimitiveSvg('<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>'), /不受支持/)
  assert.throws(() => importPrimitiveSvg('<svg width="10" height="10" viewBox="0 0 10 10"><rect width="8" height="8" stroke="red"/></svg>'), /描边/)
  assert.equal(resource.fitData, old)
})

test('baking clones the authoring tree, keeps GUID/layer order and contains fitted pieces on every platform', () => {
  const project = makeProject()
  const before = structuredClone(project)
  const fitData = fitFixture()
  const { project: baked, warnings } = bakePrimitives(project, look2Fixture(fitData))
  assert.deepEqual(warnings, [])
  assert.deepEqual(project, before)
  const root = findNode(baked.root, 'root')
  const container = findNode(baked.root, 'source')
  assert.equal(container.id, 'source')
  assert.equal(container.kind, 'container')
  assert.equal(container.guid, 42)
  assert.deepEqual(root.children.slice(-2).map((node) => node.id), ['source', 'source__primitive_001'])
  assert.equal(container.children[0].name, '已有子项')
  assert.equal(container.children[3].name, '图元_001')
  assert.equal(container.children[3].id, 'source__primitive_001_2')
  assert.deepEqual(container.children.slice(1).map((node) => node.imageId), [100003, 100001, 100002])
  assert.equal(container.children[3].guid, 0)
  for (const platform of PLATFORMS) {
    const transform = container.children[3].transformByPlatform[platform]
    assert.equal(transform.anchorMin.x, .5)
    assert.equal(transform.anchorMax.y, .5)
    assert.ok(transform.size.x <= 160)
    assert.ok(transform.size.y <= 90)
  }
  const primitiveData = buildPrimitiveData(project, look2Fixture(fitData), 'root')
  assert.equal(primitiveData.v, 3)
  assert.equal(primitiveData.groups.length, 2)
  assert.equal(primitiveData.groups[0].path, '源图片')
  assert.equal(primitiveData.groups[1].path, '源图片/已有子项/Nested')
  assert.equal(primitiveData.groups[0].visible, false)
  assert.deepEqual(primitiveData.groups[0].elements[0], [1, 0, -24.8, 11.2, 36, 22.4, 17, 230, 30, 90, 204])
  assert.deepEqual(primitiveData.groups[0].elements[1], [0, 0, 28, -8, 32, 16, -32, 12, 140, 210, 255])
  const failed = bakePrimitives(project, {
    siteNodes: { source: { id: 'source', type: 'primitive', properties: { imageResourceId: 'res' } } },
    primitiveResources: [{ id: 'res', name: '图片', fitData: { version: 1, width: -1, height: 3, elements: [] } }],
  })
  assert.equal(findNode(failed.project.root, 'source').kind, 'image')
  assert.equal(failed.warnings.length, 1)
})

test('PrimitiveImage Lua library uses documented game calls and only replaces its own children', () => {
  const runtime = createRuntime()
  const root = runtime.addRoot({ name: 'PrimitiveRoot', kind: 'container', active: true, sizeDeltaX: 200, sizeDeltaY: 100 })
  runtime.registerTemplate(17, { name: '图元图片模板', kind: 'image', active: true, sizeDeltaX: 1, sizeDeltaY: 1 })
  runtime.registerTemplate(18, { name: '嵌套图片', kind: 'image', active: true, sizeDeltaX: 100, sizeDeltaY: 50 })
  const nestedTarget = runtime.instantiate(18, root)
  const library = exportPrimitiveLibrary()
  const source = `local PrimitiveImageLib = (function()\n${library}\nend)()
local data = {
  v = 3,
  groups = {
    {
      path = "",
      visible = false,
      focus = true,
      elements = {
        { 1, 0, 12, -7, 30, 20, 25, 10, 20, 30, 128 },
      },
    },
    {
      path = "嵌套图片",
      visible = false,
      elements = {
        { 0, 1, 0, 0, 12, 8, 0, 1, 2, 3, 255 },
      },
    },
  },
}
function OnStart()
  local nested = script.object:GetChild("嵌套图片")
  local originalNestedColor = nested.imageColor
  local originalRootVisible = script.object.visible
  local originalRootFocus = script.object.canControllerFocus
  local first, warnings = PrimitiveImageLib.create(script.object, data, 17)
  if #first ~= 2 or #script.object:GetChildren() ~= 2 or #nested:GetChildren() ~= 1 then error("first create failed") end
  if #warnings ~= 2 or not string.find(warnings[1], "imageType", 1, true) then error("unsupported imageType mode did not return an explicit warning") end
  if script.object.visible ~= false or script.object.canControllerFocus ~= true or nested.visible ~= false then error("group visible/focus flags were not applied") end
  local old = first[1]
  local oldNested = first[2]
  local broken = { v = 3, groups = {
    { path = "", elements = { data.groups[1].elements[1] } },
    { path = "Missing", elements = { data.groups[2].elements[1] } },
  } }
  local failed = PrimitiveImageLib.create(script.object, broken, 17)
  if failed ~= nil or not old.alive or #script.object:GetChildren() ~= 2 then error("failed create replaced the previous collection") end
  if PrimitiveImageLib.create(script.object, { v = 4, groups = data.groups }, 17) ~= nil or not old.alive then error("unsupported data version replaced the previous collection") end
  if PrimitiveImageLib.create(script.object, { v = 3, groups = { { path = "/嵌套图片", elements = data.groups[2].elements } } }, 17) ~= nil or not old.alive then error("invalid group path replaced the previous collection") end
  local invalidRows = { v = 3, groups = { { path = "", elements = { { 8, 0, 0, 0, 2, 2, 0, 1, 2, 3, 255 } } } } }
  if PrimitiveImageLib.create(script.object, invalidRows, 17) ~= nil or not old.alive then error("invalid v3 row replaced the previous collection") end
  local legacyV1 = { schema = "UGCTools.PrimitiveProject@1", columns = { "imageId", "imageType", "x", "y", "width", "height", "rotation", "r", "g", "b", "a" }, groups = { { path = "", elements = { { 100003, "Stretch", 0, 0, 10, 10, 0, 1, 2, 3, 255 } } } } }
  local legacyControls, legacyWarnings = PrimitiveImageLib.create(script.object, legacyV1, 17)
  if #legacyControls ~= 1 or #legacyWarnings ~= 1 or old.alive then error("v1 PrimitiveData compatibility failed") end
  local legacyV2 = { v = 2, groups = { { path = "", elements = { { 2, 1, 0, 0, 9, 9, 0, 4, 5, 6, 255 } } } } }
  local v2Controls, v2Warnings = PrimitiveImageLib.create(script.object, legacyV2, 17)
  if #v2Controls ~= 1 or #v2Warnings ~= 1 or legacyControls[1].alive then error("v2 PrimitiveData compatibility failed") end
  local second = PrimitiveImageLib.create(script.object, data, 17)
  if #second ~= 2 or #script.object:GetChildren() ~= 2 or #nested:GetChildren() ~= 1 then error("repeat create duplicated children " .. tostring(#script.object:GetChildren())) end
  if old.alive then error("repeat create did not destroy its old image") end
  if oldNested.alive then error("repeat create did not destroy its old nested image") end
  local image = script.object:GetChild("图元_001")
  if image.imageId ~= 100002 then error("SetImage did not apply the primitive image ID") end
  if image.name ~= "图元_001" then error("primitive name missing") end
  if image.anchoredPositionX ~= 12 or image.anchoredPositionY ~= -7 then error("primitive position mismatch") end
  PrimitiveImageLib.destroy(script.object)
  if #script.object:GetChildren() ~= 1 or #nested:GetChildren() ~= 0 then error("destroy left generated children") end
  if nested.imageColor ~= originalNestedColor then error("destroy changed the original image color") end
  if script.object.visible ~= originalRootVisible or script.object.canControllerFocus ~= originalRootFocus or nested.visible ~= true then error("destroy did not restore target flags") end
end`
  runtime.mountScript({ path: 'PrimitiveLibraryTest', control: root, source })
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
  assert.equal(runtime.logs.filter((item) => item.level === 'error').length, 0)
  assert.equal(root.children.length, 1)
})

test('worker fit options honor quantity/resolution limits and hardware worker caps', () => {
  const options = normalizeFitOptions({ count: 5000, resolution: 300, workers: 16, shapes: ['ellipse', 'triangle'], transparent: false }, 6)
  assert.deepEqual(options, { count: 1000, resolution: 512, workers: 16, actualWorkers: 6, shapes: ['ellipse', 'triangle'], transparent: false })
  assert.deepEqual(normalizeFitOptions({}, 4), { count: 400, resolution: 512, workers: 16, actualWorkers: 4, shapes: ['ellipse', 'rectangle'], transparent: true })
})

test('fit job reports each committed element and cancellation terminates its worker pool', async () => {
  const jobs = []
  class FakeWorker {
    constructor(url) { this.url = url; this.terminated = false; jobs.push(this) }
    postMessage(message) {
      if (message.type === 'decode') queueMicrotask(() => this.onmessage?.({ data: { type: 'decoded', width: 2, height: 2, gridWidth: 2, gridHeight: 2, pixels: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]).buffer } }))
      else if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }))
      else if (message.type === 'search') queueMicrotask(() => this.onmessage?.({ data: { type: 'candidate', candidate: message.iteration === 0 ? { improvement: 4, type: 'rectangle', element: { type: 'rectangle', imageId: 100001, x: 0, y: 0, width: 2, height: 2, rotation: 0, color: { r: 255, g: 0, b: 0, a: 1 } } } : null } }))
      else if (message.type === 'commit') queueMicrotask(() => this.onmessage?.({ data: { type: 'committed', remaining: 0, error: 0 } }))
    }
    terminate() { this.terminated = true }
  }
  const progress = []
  const job = createPrimitiveFitJob({ source: 'data:image/png;base64,AA==', workerURL: '/fit.js', WorkerClass: FakeWorker, hardwareConcurrency: 1, options: { count: 10, workers: 16 }, onProgress: (item) => progress.push(item) })
  const fit = await job.promise
  assert.equal(fit.elements.length, 1)
  assert.equal(fit.width, 2)
  assert.equal(progress[0].completed, 1)
  assert.ok(jobs[0].terminated)

  const cancelled = createPrimitiveFitJob({ source: 'data:image/png;base64,AA==', workerURL: '/fit.js', WorkerClass: FakeWorker, options: {} })
  cancelled.cancel()
  await assert.rejects(cancelled.promise, { name: 'AbortError' })
  assert.ok(jobs.at(-1).terminated)
})
