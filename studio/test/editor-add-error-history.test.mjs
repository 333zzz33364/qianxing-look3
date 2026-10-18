import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultProject, createDefaultClientTemplateProject } from '../ui/authoring.js'
import { describeEditorError, emptyErrorLog, ERROR_LOG_LIMIT, loadErrorLog, saveErrorLog, updateErrorLog } from '../../editor-ui/error-log.js'

const settle = () => new Promise(resolve => setImmediate(resolve))

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
    api: async (_session, action, body) => {
      assert.equal(action, 'transaction')
      return studio.transaction(body)
    },
  })
  function render() { cursor = 0; tree = AnimationView({ sessionId: 'selection-visibility' }); return tree }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  render()
  const boxes = () => find(node => node.props.className?.startsWith('look2-box '))
  const row = id => find(node => node.props.className?.startsWith('look2-tree-row') && node.props.key === id)[0]
  const eye = id => find(node => ['在画布显示', '在画布隐藏'].includes(node.props.title), row(id))[0]
  return { render, find, boxes, eye }
}

const edit = (studio, ops) => studio.transaction({ ops, expectedRevision: studio.get().version })

for (const kind of ['button', 'textbox', 'image', 'cursor', 'grid', 'textwindow', 'reference', 'keyhint', 'animation', 'fullscreen']) {
  test(`adding ${kind} while the outer server wrapper is selected routes to its client container`, () => {
    const studio = createStudio(createDefaultProject()), before = studio.get()
    const added = edit(studio, [{ op: 'add', kind, parentId: before.root.id, resolveParent: true }])
    const row = added.tree.find(row => row.id === added.selectedId)
    assert.equal(row.parentId, before.root.children[0].id)
    assert.equal(row.kind, kind)
    assert.equal(added.root.children.length, 1)
  })
}

for (const factory of [createDefaultProject, createDefaultClientTemplateProject]) {
  test(`${factory.name}: adding a button to an empty asset creates one parent atomically and supports undo/redo`, () => {
    const studio = createStudio(factory())
    edit(studio, [{ op: 'remove', id: studio.get().root.id }])
    const empty = studio.archiveData(), start = studio.get().history.entries.length
    const result = edit(studio, [{ op: 'add', kind: 'button', parentId: studio.get().root.id, resolveParent: true }])
    assert.equal(result.history.entries.length, start + 1)
    assert.equal(result.root.children.length, 1)
    assert.equal(result.root.children[0].kind, 'container')
    assert.equal(result.root.children[0].children[0].kind, 'button')
    assert.equal(result.selectedId, result.root.children[0].children[0].id)
    studio.history({ action: 'undo', expectedRevision: result.version })
    assert.deepEqual(studio.get().root, empty.assets[studio.get().asset.type === 'client-control-template' ? 'client' : 'server'].root)
    studio.history({ action: 'redo', expectedRevision: studio.get().version })
    assert.equal(studio.get().root.children[0].children[0].kind, 'button')
  })
}

test('automatic parent creation rolls back if the requested control is invalid', () => {
  const studio = createStudio(createDefaultProject())
  edit(studio, [{ op: 'remove', id: studio.get().root.id }])
  const before = studio.archiveData()
  assert.throws(() => edit(studio, [{ op: 'add', kind: 'invalid-kind', parentId: studio.get().root.id, resolveParent: true }]))
  assert.deepEqual(studio.archiveData(), before)
})

test('raw authoring add retains its wrapper constraint unless routing is explicitly requested', () => {
  const studio = createStudio(createDefaultProject())
  assert.throws(() => edit(studio, [{ op: 'add', kind: 'button', parentId: studio.get().root.id }]), /server container only accepts/)
})

test('the UI add menu can add a button under an outer selection without exposing a wrapper error', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  try {
    const project = createDefaultProject(); project.selectedId = project.root.id
    const studio = createStudio(project), view = makeView(studio)
    const button = view.find(node => node.type === 'button' && node.children.includes('按钮'))[0]
    assert.ok(button)
    await button.props.onClick({ currentTarget: { closest: () => ({ removeAttribute() {} }) } }); await settle(); view.render()
    const result = studio.get(), row = result.tree.find(row => row.id === result.selectedId)
    assert.equal(row.kind, 'button')
    assert.equal(row.parentId, project.root.children[0].id)
    const trigger = view.find(node => node.props['aria-label'] === '查看错误历史')[0]
    assert.ok(trigger)
    assert.ok(!trigger.props.className.includes(' error'))
  } finally { globalThis.document = previousDocument }
})

test('known English and Chinese errors have bilingual descriptions without losing their original details', () => {
  const english = 'server container only accepts container nodes'
  const result = describeEditorError(english)
  assert.match(result.zh, /只能直接包含容器节点/)
  assert.equal(result.en, english)
  assert.equal(result.raw, english)
  const chinese = '当前界面为空，请先添加容器后再导出站点 JSON；空界面可使用完整存档保存'
  const translated = describeEditorError(chinese)
  assert.equal(translated.zh, chinese)
  assert.match(translated.en, /full save/)
  assert.equal(translated.translated, true)
  assert.match(describeEditorError('new-unknown-error').zh, /英文原始错误/)
  assert.equal(describeEditorError('新出现的未知错误').translated, false)
})

test('adding immediately after a queued selection uses the newly selected parent rather than a stale render', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  try {
    const studio = createStudio(createDefaultProject()), originalParent = studio.get().root.children[0].id
    const added = edit(studio, [{ op: 'add', parentId: originalParent, kind: 'container', name: '新的目标容器' }])
    const nextParent = added.selectedId
    edit(studio, [{ op: 'select', id: originalParent }])
    const view = makeView(studio)
    const name = view.find(node => node.props.className === 'tree-name' && node.children.includes('新的目标容器'))[0]
    name.props.onClick()
    // Deliberately do not render or await the selection before clicking Add.
    view.find(node => node.type === 'button' && node.children.includes('按钮'))[0].props.onClick({ currentTarget: { closest: () => ({ removeAttribute() {} }) } })
    await settle(); await settle(); view.render()
    const snap = studio.get(), row = snap.tree.find(node => node.id === snap.selectedId)
    assert.equal(row.kind, 'button')
    assert.equal(row.parentId, nextParent)
    assert.equal(snap.root.children[0].children.find(node => node.id === nextParent).children.length, 1)
  } finally { globalThis.document = previousDocument }
})

test('error history survives current-error clearing and groups repeat notifications with timestamps', () => {
  let log = updateErrorLog(emptyErrorLog(), 'first failure', 100)
  log = updateErrorLog(log, 'first failure', 200)
  assert.equal(log.entries.length, 1)
  assert.equal(log.entries[0].count, 2)
  assert.equal(log.entries[0].firstAt, 100)
  assert.equal(log.entries[0].lastAt, 200)
  log = updateErrorLog(log, '', 300)
  assert.equal(log.current, '')
  assert.equal(log.entries.length, 1)
  log = updateErrorLog(log, 'second failure', 400)
  log = updateErrorLog(log, current => current === 'unrelated' ? '' : current, 500)
  assert.equal(log.current, 'second failure')
  assert.equal(log.entries[0].raw, 'first failure')
  assert.equal(log.entries.at(-1).raw, 'second failure')
  assert.equal(log.entries.at(-1).count, 1)
})

test('history is bounded, tab-session scoped, and safely ignores invalid or unavailable storage', () => {
  const items = new Map(), storage = { getItem: key => items.get(key), setItem: (key, value) => items.set(key, value) }
  let log = emptyErrorLog()
  for (let index = 0; index < ERROR_LOG_LIMIT + 20; index++) log = updateErrorLog(log, `failure ${index}`, index * 2000)
  assert.equal(log.entries.length, ERROR_LOG_LIMIT)
  assert.equal(log.entries[0].raw, 'failure 20')
  saveErrorLog('tab-a', log, storage)
  assert.deepEqual(loadErrorLog('tab-a', storage), log)
  assert.deepEqual(loadErrorLog('tab-b', storage), emptyErrorLog())
  storage.setItem('look2-error-log:broken', '{')
  assert.deepEqual(loadErrorLog('broken', storage), emptyErrorLog())
  assert.doesNotThrow(() => saveErrorLog('tab-a', log, { setItem() { throw new Error('quota') } }))
})

