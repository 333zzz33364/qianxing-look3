import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultProject, createDefaultClientTemplateProject, createNode } from '../ui/authoring.js'
import { describeEditorError } from '../../editor-ui/error-log.js'

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
  return { render, find, boxes, eye, row }
}

const edit = (studio, op) => studio.transaction({ ops: [op], expectedRevision: studio.get().version })
const history = (studio, action) => studio.history({ action, expectedRevision: studio.get().version })
function fixture(client = false) {
  const project = client ? createDefaultClientTemplateProject() : createDefaultProject()
  const inner = project.root.children[0]
  inner.children = [createNode('image', { id: 'image', guid: 1073742951, name: '图片' }),
    createNode('container', { id: 'nested', guid: 1073742952, name: '嵌套容器', children: [
      createNode('textwindow', { id: 'text', guid: 1073742953, name: '文本视窗' }),
      createNode('keyhint', { id: 'hint', guid: 1073742954, name: '按键提示' }),
    ] })]
  project.selectedId = 'image'
  return createStudio(project)
}
const select = async (view, id) => {
  await view.find(node => node.props.className === 'tree-name', view.row(id))[0].props.onClick()
  await settle(); view.render()
}
const drop = async (view, id, target, y = 50) => {
  await view.row(target).props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => id },
    currentTarget: { getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }) }, clientY: y })
  await settle(); view.render()
}

for (const client of [false, true]) {
  test(`${client ? 'client template' : 'server UI'}: reparent preserves current geometry, raw data, identity and undo/redo`, () => {
    const studio = fixture(client)
    edit(studio, { op: 'set', id: 'nested', key: 'posX', value: 350 })
    edit(studio, { op: 'set', id: 'nested', key: 'width', value: 500 })
    const initial = studio.get(), beforeRoot = initial.root, box = initial.boxes.find(row => row.id === 'image')
    const moved = edit(studio, { op: 'reparent', id: 'image', parentId: 'nested' })
    assert.equal(moved.tree.find(row => row.id === 'image').parentId, 'nested')
    assert.equal(moved.selectedId, 'image')
    assert.equal(moved.history.entries.length, initial.history.entries.length + 1)
    const newBox = moved.boxes.find(row => row.id === 'image')
    for (const key of ['centerX', 'centerY', 'width', 'height']) assert.ok(Math.abs(newBox[key] - box[key]) < 0.00001, key)
    assert.equal(moved.root.children[0].children.find(node => node.id === 'nested').children.at(-1).guid, 1073742951)
    const target = createStudio()
    const gia = studio.exportData('gia')
    const imported = target.importData('gia', gia.data, gia.filename).snapshot
    assert.equal(imported.tree.find(row => row.name === '图片').parentId, imported.tree.find(row => row.name === '嵌套容器').id)
    history(studio, 'undo'); assert.deepEqual(studio.get().root, beforeRoot)
    history(studio, 'redo'); assert.deepEqual(studio.get().root, moved.root)
    assert.deepEqual(createStudio(studio.archiveData()).get().root, moved.root)
  })
}

test('server UI accepts moving a nested client control to its ancestor container', async () => {
  const studio = fixture(), view = makeView(studio)
  await drop(view, 'text', 'n1')
  assert.equal(studio.get().tree.find(row => row.id === 'text').parentId, 'n1')
  await select(view, 'hint'); assert.equal(studio.get().selectedId, 'hint')
})

test('wrapper and cycle constraints reject atomically while ordinary containers can be promoted', () => {
  const studio = fixture(), before = studio.archiveData(), wrapper = studio.get().root.id
  for (const [id, parentId, pattern] of [['image', wrapper, /只能直接包含容器节点/], ['n1', 'nested', /自身或其后代/], [wrapper, 'nested', /node not found/]]) {
    assert.throws(() => edit(studio, { op: 'reparent', id, parentId }), pattern)
    assert.deepEqual(studio.archiveData(), before)
  }
  edit(studio, { op: 'reparent', id: 'nested', parentId: wrapper })
  assert.equal(studio.get().tree.find(row => row.id === 'nested').parentId, wrapper)
  history(studio, 'undo'); assert.deepEqual(studio.get().root, before.assets.server.root)
})

test('a failed hierarchy action keeps its bilingual history and allows selecting several controls and the canvas', async () => {
  const studio = fixture(), view = makeView(studio), before = studio.get().root
  await drop(view, 'image', studio.get().root.id)
  assert.deepEqual(studio.get().root, before)
  for (const id of ['text', 'hint', 'image']) {
    await select(view, id)
    assert.equal(studio.get().selectedId, id)
    assert.equal(view.find(node => node.props.className?.startsWith('look2-tree-row') && node.props.className.includes(' sel')).length, 1)
  }
  view.find(node => node.props.className?.startsWith('look2-box ') && node.props.key === 'text')[0].props.onDoubleClick()
  await settle(); view.render()
  assert.equal(studio.get().selectedId, 'text')
  view.find(node => node.props['aria-label'] === '查看错误历史')[0].props.onClick(); view.render()
  const dialog = view.find(node => node.props.role === 'dialog' && node.props['aria-label'] === '错误历史')[0]
  assert.ok(view.find(node => node.type === 'p' && node.children.some(value => typeof value === 'string' && value.includes('只能直接包含容器节点')), dialog).length)
  assert.ok(view.find(node => node.type === 'p' && node.children.some(value => typeof value === 'string' && value.includes('only accepts container nodes')), dialog).length)
})

test('failed hierarchy can be followed by a valid drag and sibling top/bottom with undo', async () => {
  const studio = fixture(), view = makeView(studio)
  await drop(view, 'n1', 'nested') // cycle
  await drop(view, 'image', 'nested')
  assert.equal(studio.get().tree.find(row => row.id === 'image').parentId, 'nested')
  await drop(view, 'image', 'text', 1)
  assert.deepEqual(studio.get().root.children[0].children[0].children.map(node => node.id), ['image', 'text', 'hint'])
  edit(studio, { op: 'moveSibling', id: 'image', direction: 'bottom' })
  assert.deepEqual(studio.get().root.children[0].children[0].children.map(node => node.id), ['text', 'hint', 'image'])
  history(studio, 'undo')
  assert.deepEqual(studio.get().root.children[0].children[0].children.map(node => node.id), ['image', 'text', 'hint'])
})

test('a real failed property commit still prevents selection until its own error is discarded', async () => {
  const studio = fixture(), view = makeView(studio)
  const inspector = view.find(node => typeof node.type === 'function' && node.type.name === 'WorkspaceInspector')[0]
  let reason
  try { await inspector.props.patch({ op: 'set', id: 'image', key: 'imageId', value: 'invalid-number' }) }
  catch (error) { reason = error }
  assert.ok(reason)
  await select(view, 'text')
  assert.equal(studio.get().selectedId, 'image')
  inspector.props.onDiscardInputError(reason)
  await select(view, 'text')
  assert.equal(studio.get().selectedId, 'text')
})

test('dragging between containers inserts beside the target and undoes in a single step', async () => {
  const studio = fixture(), view = makeView(studio), before = studio.get()
  await drop(view, 'image', 'hint', 1)
  assert.deepEqual(studio.get().root.children[0].children[0].children.map(node => node.id), ['text', 'image', 'hint'])
  assert.equal(studio.get().history.entries.length, before.history.entries.length + (before.history.entries.length ? 1 : 2))
  history(studio, 'undo'); assert.deepEqual(studio.get().root, before.root)
})

test('a queued field failure cannot be bypassed by selecting before its response arrives', async () => {
  const studio = fixture(), view = makeView(studio)
  const inspector = view.find(node => typeof node.type === 'function' && node.type.name === 'WorkspaceInspector')[0]
  const failed = inspector.props.patch({ op: 'set', id: 'image', key: 'imageId', value: 'invalid-number' }).catch(reason => reason)
  await select(view, 'text')
  const reason = await failed
  assert.ok(reason instanceof Error)
  assert.equal(studio.get().selectedId, 'image')
  inspector.props.onDiscardInputError(reason)
  await select(view, 'hint'); assert.equal(studio.get().selectedId, 'hint')
})

test('a queued asset switch cancels a stale drop without changing the new asset or trapping selection', async () => {
  const studio = fixture(), view = makeView(studio)
  const inspector = view.find(node => typeof node.type === 'function' && node.type.name === 'WorkspaceInspector')[0]
  const clientBefore = studio.archiveData().assets.client.root
  const switching = inspector.props.patch({ op: 'selectAsset', assetType: 'client-control-template' })
  await drop(view, 'image', 'hint', 1)
  await switching
  assert.equal(studio.get().asset.type, 'client-control-template')
  assert.deepEqual(studio.get().root, clientBefore)
  await select(view, 'n2'); assert.equal(studio.get().selectedId, 'n2')
})

test('hierarchy errors provide dedicated bilingual explanations', () => {
  for (const raw of ['最外层客户端控件容器只能直接包含容器节点；请移入内部容器', '控件不能移动到自身或其后代下面', 'reparent: parent not found']) {
    const detail = describeEditorError(raw)
    assert.equal(detail.translated, true)
    assert.match(detail.zh, /[\u3400-\u9fff]/)
    assert.match(detail.en, /[A-Za-z]/)
  }
})

