import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from 'qxqy-lua-runtime'
import { createDefaultProject } from '../ui/authoring.js'
import { compileProject } from '../play/compile.js'
import { buildAnimationScripts } from '../look2/player.js'
import { exportTimelineData, importTimelineData } from '../look2/timeline-lua.js'
import { freshLook2 } from '../look2/site-json.js'

const SERVER_ASSET = 'server-control-template'
const keyframes = (from, to) => [
  { id: 'key-start', time: 0, value: from, easeType: 'Linear', interpolation: 'tween' },
  { id: 'key-end', time: 1, value: to, easeType: 'Linear', interpolation: 'tween' },
]

function serverFixture() {
  const project = createDefaultProject()
  const root = project.root.children[0]
  const textbox = root.children.find(node => node.kind === 'textbox')
  return { project, root, textbox }
}

function animationState(nodeId) {
  return {
    ...freshLook2(),
    activeAnimationId: 'server-motion',
    animations: [{ id: 'server-motion', name: '服务器控件动画', duration: 1,
      keyframeTracks: [{ id: 'server-track', nodeId, fieldKey: 'anchoredPositionX', keyframes: keyframes(0, 100) }],
      events: [] }],
  }
}

test('server client-control subtree compiles an asset-mounted player that animates at runtime', () => {
  const { project, root, textbox } = serverFixture()
  const state = animationState(textbox.id)
  const bundle = buildAnimationScripts(project, state)
  assert.equal(bundle.scripts.length, 1)
  assert.equal(bundle.scripts[0].controlId, root.id)
  assert.equal(bundle.scripts[0].controlAsset, SERVER_ASSET)

  const compiled = compileProject(project, bundle.scripts)
  const runtime = createRuntime({ canvasWidth: 1600, canvasHeight: 900, device: 'PC' })
  const runtimeRoot = runtime.addRoot(compiled.root)
  const runtimeTextbox = runtimeRoot.children.find(node => node.name === textbox.name)
  assert.equal(runtime.mountErrors.length, 0, JSON.stringify(runtime.mountErrors))
  assert.equal(runtimeTextbox.anchoredPositionX, 0)
  runtime.step(.5)
  assert.equal(runtimeTextbox.anchoredPositionX, 50)
  runtime.destroy()
})

test('server animation event handlers resolve only against server-mounted scripts', () => {
  const { project, textbox } = serverFixture()
  const state = animationState(textbox.id)
  state.animations[0].events.push({ id: 'server-event', time: .5, name: 'Pulse', nodeId: textbox.id,
    target: textbox.name, params: '', handler: { targetNodeId: textbox.id, scriptPath: 'server-handler.lua', functionName: 'OnPulse' } })
  const serverScript = { id: 'server-handler', guid: 1073742900, path: 'server-handler.lua', source: 'function OnPulse() end',
    controlId: textbox.id, controlAsset: SERVER_ASSET }
  const clientScript = { ...serverScript, id: 'client-handler', guid: 1073742901, controlAsset: 'client-control-template' }
  const resolved = buildAnimationScripts(project, state, [clientScript, serverScript])
  assert.equal(resolved.warnings.some(row => /处理器无效/.test(row)), false)

  const mismatched = buildAnimationScripts(project, state, [clientScript])
  assert.ok(mismatched.warnings.some(row => /不存在路径为 server-handler\.lua 的控件脚本/.test(row)))
})

test('server-container wrapper is not an animation target', () => {
  const { project } = serverFixture()
  const bundle = buildAnimationScripts(project, animationState(project.root.id))
  assert.deepEqual(bundle.scripts, [])
  assert.ok(bundle.warnings.some(row => /控件已不存在/.test(row)))
})

test('Timeline Data exports and imports paths within a server asset subtree', () => {
  const { project, root, textbox } = serverFixture()
  const state = animationState(textbox.id)
  const source = exportTimelineData(project, state, root.id)
  const imported = importTimelineData(source, project, freshLook2(), { rootId: root.id })
  const track = imported.animations.at(-1).keyframeTracks[0]
  assert.equal(track.nodeId, textbox.id)
  assert.equal(track.fieldKey, 'anchoredPositionX')
})
