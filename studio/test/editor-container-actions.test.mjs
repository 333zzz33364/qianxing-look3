import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultProject, createDefaultClientTemplateProject, createNode } from '../ui/authoring.js'
import { previewAnimation } from '../look2/preview.js'
import { hitTest } from '../ui/inspector.js'

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

const edit = (studio, op, label = '测试编辑') => studio.transaction({ ops: [op], label, expectedRevision: studio.get().version })
const history = (studio, action) => studio.history({ action, expectedRevision: studio.get().version })
const content = studio => {
  const data = studio.archiveData()
  delete data.assets.server.version
  delete data.assets.client.version
  return data
}

for (const factory of [createDefaultProject, createDefaultClientTemplateProject]) {
  test(`${factory.name}: deleting the final actual container leaves an empty save that can be reopened and rebuilt`, () => {
    const studio = createStudio(factory()), before = content(studio)
    const rootId = studio.get().root.children[0].id
    const cleared = edit(studio, { op: 'remove', id: rootId }, '删除最后一个容器')
    assert.equal(cleared.tree.length, 0)
    assert.equal(cleared.boxes.length, 0)
    assert.equal(cleared.selectedId, '')
    assert.equal(cleared.inspector, null)
    assert.equal(cleared.asset.templateCount, 0)
    assert.throws(() => studio.exportData('site-json'), /空界面可使用完整存档保存/)
    assert.equal(previewAnimation(cleared.animationPreviewRoot, cleared.look2.animations[0], 0, cleared.canvas).filter(row => row.visible).length, 0)
    const reopened = createStudio(studio.archiveData())
    assert.equal(reopened.get().tree.length, 0)
    const rebuilt = edit(reopened, { op: 'add', kind: 'container', name: '重新添加' })
    assert.ok(rebuilt.tree.some(row => row.name === '重新添加'))
    assert.ok(rebuilt.boxes.some(row => row.name === '重新添加'))
    assert.ok(rebuilt.animationPreviewRoot.visible)
    history(studio, 'undo'); assert.deepEqual(content(studio), before)
    history(studio, 'redo'); assert.equal(studio.get().tree.length, 0)
  })
}

test('deleting the outer server container restores raw data, tracks, events, locks and script mounts in one undo', () => {
  const project = createDefaultProject()
  project.root.children[0].giaRaw = { unknownPayload: 'preserve-on-undo' }
  const studio = createStudio(project), serverAsset = studio.get().asset.type
  studio.patch({ op: 'addScript', controlId: 'n1', controlAsset: serverAsset, path: 'keep.lua', source: 'print("keep")' })
  studio.patch({ op: 'setEditorLock', id: 'n1', locked: true })
  const state = studio.get().look2
  state.siteNodes.n2 = { id: 'n2', type: 'textbox', properties: {} }
  state.animations[0].keyframeTracks = [{ id: 'track', nodeId: 'n2', fieldKey: 'visible', keyframes: [] }]
  state.animations[0].events = [{ id: 'event', nodeId: 'n2', target: '文本框', time: 0, name: 'event', params: '' }]
  studio.setLook2(state, studio.get().version)
  const before = content(studio)
  const cleared = edit(studio, { op: 'remove', id: studio.get().root.id }, '删除最外层容器')
  assert.equal(cleared.tree.length, 0)
  assert.deepEqual(cleared.editorLocks, {})
  assert.equal(cleared.look2.animations[0].keyframeTracks.length, 0)
  assert.equal(cleared.look2.animations[0].events.length, 0)
  assert.equal(cleared.look2.siteNodes.n2, undefined)
  assert.equal(cleared.scripts[0].mounted, false)
  assert.equal(cleared.scripts[0].source, 'print("keep")')
  assert.deepEqual(studio.archiveData().assets.client, { ...before.assets.client, version: studio.archiveData().assets.client.version })
  assert.throws(() => studio.exportData('gia'), /当前界面为空/)
  history(studio, 'undo'); assert.deepEqual(content(studio), before)
  assert.equal(studio.get().scripts[0].mounted, true)
  history(studio, 'redo'); assert.equal(studio.get().tree.length, 0)
})

test('new server root siblings and nested containers can all be deleted and undone', () => {
  const studio = createStudio(createDefaultProject()), wrapperId = studio.get().root.id
  const added = edit(studio, { op: 'add', parentId: wrapperId, kind: 'container', name: '新增一级容器' })
  const id = added.selectedId
  edit(studio, { op: 'add', parentId: id, kind: 'container', name: '嵌套容器' })
  const before = content(studio)
  edit(studio, { op: 'remove', id })
  assert.ok(!studio.get().tree.some(row => [id, '嵌套容器'].includes(row.id) || row.name === '嵌套容器'))
  assert.ok(studio.get().tree.some(row => row.id === 'n1'))
  history(studio, 'undo'); assert.deepEqual(content(studio), before)
})

function orderedFixture(client = false) {
  const project = client ? createDefaultClientTemplateProject() : createDefaultProject()
  const root = project.root.children[0]
  root.children = ['front', 'middle', 'back'].map((id, index) => createNode('image', { id, guid: 1073742900 + index, name: id, imageId: 100001 }))
  project.selectedId = 'middle'
  return createStudio(project)
}

for (const direction of ['top', 'bottom']) {
  test(`${direction}: reorders siblings consistently for tree, preview, hit testing and GIA round-trip`, () => {
    const studio = orderedFixture(), before = content(studio), historyCount = studio.get().history.entries.length
    const moved = edit(studio, { op: 'moveSibling', id: 'middle', direction }, direction)
    const order = direction === 'top' ? ['middle', 'front', 'back'] : ['front', 'back', 'middle']
    assert.deepEqual(moved.root.children[0].children.map(node => node.id), order)
    assert.equal(moved.history.entries.length, historyCount + (historyCount ? 1 : 2))
    const preview = previewAnimation(moved.animationPreviewRoot, moved.look2.animations[0], 0, moved.canvas)
    assert.deepEqual(preview.filter(node => order.includes(node.id)).map(node => node.id), [...order].reverse())
    assert.equal(hitTest(moved.boxes, moved.canvas.width / 2, moved.canvas.height / 2), order[0])
    const exported = studio.exportData('gia')
    const target = createStudio()
    const imported = target.importData('gia', exported.data, exported.filename).snapshot
    assert.deepEqual(imported.root.children[0].children.map(node => node.name), order)
    history(studio, 'undo'); assert.deepEqual(content(studio), before)
    history(studio, 'redo'); assert.deepEqual(studio.get().root.children[0].children.map(node => node.id), order)
  })
}

test('client template roots support top and bottom among their actual siblings', () => {
  const project = createDefaultClientTemplateProject()
  project.root.children.push(createNode('container', { id: 'second', name: '第二模板' }), createNode('container', { id: 'third', name: '第三模板' }))
  const studio = createStudio(project)
  edit(studio, { op: 'moveSibling', id: 'second', direction: 'top' })
  assert.deepEqual(studio.get().root.children.map(node => node.id), ['second', 'n1', 'third'])
  edit(studio, { op: 'moveSibling', id: 'second', direction: 'bottom' })
  assert.deepEqual(studio.get().root.children.map(node => node.id), ['n1', 'third', 'second'])
})

test('UI delete button clears the outer container and empty UI can add a new container', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  try {
    const project = createDefaultProject(); project.selectedId = project.root.id
    const studio = createStudio(project), view = makeView(studio)
    await view.find(node => node.props.title === '删除选中控件')[0].props.onClick(); view.render()
    assert.equal(studio.get().tree.length, 0)
    assert.equal(view.boxes().length, 0)
    view.find(node => node.props.title === '新建容器')[0].props.onClick()
    await settle(); view.render()
    assert.ok(view.boxes().length > 0)
    assert.ok(studio.get().selectedId)
  } finally { globalThis.document = previousDocument }
})

test('client root context menu exposes top and bottom with correct boundary disabling', async () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window
  globalThis.document = { activeElement: null }; globalThis.window = { innerWidth: 1200, innerHeight: 800 }
  try {
    const project = createDefaultClientTemplateProject()
    project.root.children.push(createNode('container', { id: 'second', name: '第二模板' }))
    const studio = createStudio(project), view = makeView(studio)
    const row = () => view.find(node => node.props.className?.startsWith('look2-tree-row') && node.props.key === 'second')[0]
    const open = () => { row().props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 50, clientY: 100 }); view.render() }
    open()
    const top = view.find(node => node.type === 'button' && node.children.includes('置顶'))[0]
    const bottom = view.find(node => node.type === 'button' && node.children.includes('置底'))[0]
    assert.equal(top.props.disabled, false); assert.equal(bottom.props.disabled, true)
    top.props.onClick(); await settle(); view.render(); open()
    assert.equal(view.find(node => node.type === 'button' && node.children.includes('置顶'))[0].props.disabled, true)
    assert.equal(view.find(node => node.type === 'button' && node.children.includes('置底'))[0].props.disabled, false)
  } finally { globalThis.document = previousDocument; globalThis.window = previousWindow }
})

