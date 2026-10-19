import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { compileProject } from '../play/compile.js'
import { previewAnimation, projectPreviewTreeForPlatform } from '../look2/preview.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject, findNode } from '../ui/authoring.js'
import { CANVAS_PRESETS, PLATFORMS } from '../constants.js'

function editor(studio) {
  const initial = studio.get()
  const slots = []
  let cursor = 0
  let tree
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState(value) {
      const index = cursor++
      if (!(index in slots)) slots[index] = index === 0 ? initial : typeof value === 'function' ? value() : value
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(value) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: index === 1 ? initial : value }
      return slots[index]
    },
    useEffect() {},
    useCallback: callback => callback,
  }
  const previousDocument = globalThis.document
  globalThis.document = { getElementById: () => null, createElement: () => ({}), head: { append() {} }, activeElement: null }
  const { AnimationView } = createAnimationView(React, {
    api: async (_session, action, body) => {
      if (action === 'transaction') return studio.transaction(body)
      if (action === 'get') return studio.get()
      throw new Error(`unexpected action ${action}`)
    },
  })
  function render() { cursor = 0; tree = AnimationView({ sessionId: 'platform-preview-test' }); return tree }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  render()
  return {
    render,
    find,
    async flush() { await new Promise(resolve => setImmediate(resolve)); render() },
    restoreDocument() {
      if (previousDocument === undefined) delete globalThis.document
      else globalThis.document = previousDocument
    },
  }
}

test('author preview projects each platform slot over an unchanged five-preset viewport', async () => {
  const project = createDefaultClientTemplateProject()
  const root = findNode(project.root, 'n1')
  const title = findNode(project.root, 'n2')
  const offsets = { KEYBOARD: -360, TOUCHSCREEN: -120, CONTROLLER_CONSOLE: 120, CONTROLLER_MOBILE: 360 }
  for (const platform of PLATFORMS) {
    root.transformByPlatform[platform].offset.x = offsets[platform]
    title.transformByPlatform[platform].offset.x = offsets[platform] / 2
  }
  const studio = createStudio(project)
  const before = studio.archiveData()
  const snapshot = studio.get()
  const compiled = compileProject(project).root
  const basePosition = compiled.anchoredPositionX

  for (const platform of PLATFORMS) {
    const projected = projectPreviewTreeForPlatform(compiled, snapshot.root, platform)
    assert.equal(projected.anchoredPositionX, offsets[platform])
    assert.equal(projected.children.find(node => node.authoringId === 'n2').anchoredPositionX, offsets[platform] / 2)
    const boxes = previewAnimation(projected, snapshot.look2.animations[0], 0, snapshot.canvas)
    assert.equal(boxes.find(box => box.id === 'n1').centerX, snapshot.canvas.width / 2 + offsets[platform])
  }
  assert.equal(compiled.anchoredPositionX, basePosition, 'projection must not mutate the runtime compiled tree')
  assert.deepEqual(studio.archiveData(), before, 'preview reads must not edit any platform transform')
  assert.deepEqual(Object.keys(CANVAS_PRESETS), ['pc-16-9', 'pc-21-9', 'mobile-16-9', 'mobile-19.5-9', 'mobile-4-3'])

  const view = editor(studio)
  try {
    const runtimeRootBefore = structuredClone(studio.get().animationPreviewRoot)
    const initialStageWidth = view.find(node => node.props.className === 'look2-stage')[0].props.style.width
    const touchButton = view.find(node => node.type === 'button' && node.props['aria-label'] === '触屏')[0]
    touchButton.props.onClick()
    view.render()
    assert.ok(view.find(node => node.props.className === 'look2-gizmo')[0], 'touch layout edits use the selected platform even on a PC-sized viewport')
    assert.equal(studio.get().canvasId, 'pc-16-9', 'platform selection does not change the viewport preset')

    const consoleButton = view.find(node => node.type === 'button' && node.props['aria-label'] === '主机手柄')[0]
    assert.ok(consoleButton)
    consoleButton.props.onClick()
    view.render()

    const stage = view.find(node => node.props.className === 'look2-stage')[0]
    const rootBox = view.find(node => node.props.key === 'n1' && /look2-box/.test(node.props.className || ''))[0]
    const status = view.find(node => node.props.className === 'look2-stage-status')[0]
    assert.equal(stage.props.style.width, initialStageWidth, 'platform selection keeps the selected geometry viewport unchanged')
    assert.equal(rootBox.props.style.left, `${100 * (snapshot.canvas.width / 2 + offsets.CONTROLLER_CONSOLE - 260) / snapshot.canvas.width}%`)
    assert.equal(status.props['data-preview-platform'], 'CONTROLLER_CONSOLE')
    assert.match(status.children.join(''), /控制器槽位预览，不代表手柄运行时/)
    assert.equal(studio.get().canvasId, 'pc-16-9')
    assert.equal(studio.get().canvas.platform, 'KEYBOARD')
    assert.deepEqual(studio.get().animationPreviewRoot, runtimeRootBefore)

    const titleBox = view.find(node => node.props.key === 'n2' && /look2-box/.test(node.props.className || ''))[0]
    titleBox.props.onPointerDown({ button: 0, stopPropagation() {} })
    await view.flush()
    assert.equal(studio.get().selectedId, 'n2', 'a hit on the controller-slot preview selects that slot’s visible control')
    assert.deepEqual(studio.archiveData().assets.client.root, before.assets.client.root, 'controller preview selection does not write transforms')
  } finally {
    view.restoreDocument()
  }
})
