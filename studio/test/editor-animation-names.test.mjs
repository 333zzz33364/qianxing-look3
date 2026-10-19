import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { copiedAnimationName, newAnimationName, uniqueAnimationName, validateAnimationName } from '../look2/animation-names.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject } from '../ui/authoring.js'

function animation(id, name) { return { id, name, duration: 5, keyframeTracks: [], events: [] } }

function makeView(studio) {
  const initial = studio.get(), slots = []
  let cursor = 0, tree
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
  const { AnimationView } = createAnimationView(React, {
    WorkspaceInspector() {},
    api: async (_sessionId, action, payload) => {
      assert.equal(action, 'transaction')
      return studio.transaction(payload)
    },
  })
  function render() { cursor = 0; tree = AnimationView({ sessionId: 'animation-name-test' }); return tree }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  render()
  return { render, find, flush: async () => { await new Promise(resolve => setImmediate(resolve)); render() } }
}

test('animation name rules match upstream validation and automatic de-duplication', () => {
  const rows = [animation('a', '新动画'), animation('b', '新动画 2'), animation('c', '走')]
  assert.equal(validateAnimationName(rows, 'c', '  新名字  '), '新名字')
  assert.equal(validateAnimationName(rows, 'c', '走'), '走', 'renaming to the same name is allowed')
  assert.throws(() => validateAnimationName(rows, 'c', '新动画'), /重复/)
  assert.throws(() => validateAnimationName(rows, 'c', '  '), /不能为空/)
  assert.throws(() => validateAnimationName(rows, 'c', 'a'.repeat(81)), /80/)
  assert.throws(() => validateAnimationName(rows, 'c', 'bad\u0001name'), /控制字符/)
  assert.equal(newAnimationName(rows), '新动画 3')
  assert.equal(copiedAnimationName([...rows, animation('d', '走 副本')], '走'), '走 副本 2')
  assert.equal(uniqueAnimationName([animation('x', '动画'), animation('y', '动画 2')], '动画'), '动画 3')
})

test('animation create, copy, and rename handlers use the shared naming rules', async () => {
  const studio = createStudio(createDefaultClientTemplateProject())
  const state = structuredClone(studio.get().look2)
  state.animations = [
    animation('anim-new', '新动画'), animation('anim-new-2', '新动画 2'),
    animation('anim-run', 'Run'), animation('anim-copy', 'Run 副本'), animation('anim-conflict', 'Conflict'),
  ]
  state.activeAnimationId = 'anim-run'
  studio.setLook2(state, studio.get().version)
  const view = makeView(studio)

  view.find(node => node.props.title === '新增动画')[0].props.onClick()
  await view.flush()
  assert.equal(studio.get().look2.animations.at(-1).name, '新动画 3')

  view.find(node => node.type === 'button' && node.props.title === 'Run · 5s')[0].props.onClick()
  await view.flush()
  view.find(node => node.props.title === '复制动画')[0].props.onClick()
  await view.flush()
  const copied = studio.get().look2.animations.at(-1)
  assert.equal(copied.name, 'Run 副本 2')
  const nameEditor = () => view.find(node => node.props.ariaLabel === '动画名称')[0]
  const beforeInvalidRename = studio.archiveData()
  const historyBeforeInvalidRename = studio.get().history.entries.length
  await assert.rejects(nameEditor().props.onCommit('Conflict'), /重复/)
  await view.flush()
  assert.deepEqual(studio.archiveData(), beforeInvalidRename)
  assert.equal(studio.get().history.entries.length, historyBeforeInvalidRename)

  await nameEditor().props.onCommit('  Renamed Copy  ')
  await view.flush()
  assert.equal(studio.get().look2.animations.at(-1).name, 'Renamed Copy')
})
