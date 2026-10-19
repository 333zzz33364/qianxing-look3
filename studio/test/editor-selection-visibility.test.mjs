import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultProject, createDefaultClientTemplateProject } from '../ui/authoring.js'

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

test('hiding the server wrapper removes its entire canvas subtree and restores it without editing the asset', () => {
  const studio = createStudio(createDefaultProject()), view = makeView(studio)
  const before = studio.archiveData(), count = view.boxes().length
  const wrapper = studio.get().root.id
  assert.ok(count > 1)
  view.eye(wrapper).props.onClick(); view.render()
  assert.equal(view.boxes().length, 0)
  assert.equal(view.find(node => node.props.className === 'look2-gizmo').length, 0)
  view.eye(wrapper).props.onClick(); view.render()
  assert.equal(view.boxes().length, count)
  assert.deepEqual(studio.archiveData(), before)
})

test('restoring a parent preserves a child hidden independently, including its selection handles', () => {
  const project = createDefaultProject(), root = project.root.children[0], child = root.children[0]
  const studio = createStudio(project), view = makeView(studio)
  const count = view.boxes().length
  view.eye(child.id).props.onClick(); view.render()
  const withoutChild = view.boxes().length
  assert.ok(withoutChild < count)
  view.eye(root.id).props.onClick(); view.render()
  assert.equal(view.boxes().length, 0)
  view.eye(root.id).props.onClick(); view.render()
  assert.equal(view.boxes().length, withoutChild)
  assert.ok(!view.boxes().some(node => node.props.key === child.id))
})

test('hidden subtrees do not leave bone guides on the canvas', () => {
  const studio = createStudio(createDefaultProject()), view = makeView(studio)
  view.find(node => node.type === 'button' && node.children.includes('骨骼视图'))[0].props.onClick(); view.render()
  assert.ok(view.find(node => node.props.className === 'look2-bone').length > 0)
  view.eye(studio.get().root.id).props.onClick(); view.render()
  assert.equal(view.find(node => node.props.className === 'look2-bone').length, 0)
})

test('replacing a document clears canvas hiding even when the new document reuses node IDs', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  try {
    const studio = createStudio(createDefaultProject()), view = makeView(studio)
    view.eye(studio.get().root.id).props.onClick(); view.render()
    assert.equal(view.boxes().length, 0)
    view.find(node => node.props.title === '新建工程')[0].props.onClick()
    await settle(); view.render()
    assert.ok(view.boxes().length > 0)
    assert.equal(view.eye(studio.get().root.id).props.title, '在画布隐藏')
  } finally { globalThis.document = previousDocument }
})

test('blank canvas and outer workspace clicks clear selection and leave geometry intact', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  try {
    for (const inside of [false, true]) {
      const studio = createStudio(createDefaultProject()), view = makeView(studio)
      const root = structuredClone(studio.get().root)
      const wrap = view.find(node => node.props.className === 'look2-stage-wrap')[0]
      const background = { classList: { contains: name => inside && name === 'look2-stage' } }
      wrap.props.onPointerDown({ button: 0, target: background, currentTarget: inside ? {} : background })
      await settle(); view.render()
      assert.equal(studio.get().selectedId, '')
      assert.equal(studio.get().inspector, null)
      assert.deepEqual(studio.get().root, root)
      assert.equal(view.find(node => node.props.className === 'look2-gizmo').length, 0)
      assert.equal(view.find(node => node.props.className?.startsWith('look2-tree-row') && node.props.className.includes(' sel')).length, 0)
      const reloaded = createStudio(studio.archiveData())
      assert.equal(reloaded.get().selectedId, '')
      const name = view.find(node => node.props.className === 'tree-name')[0]
      name.props.onClick(); await settle(); view.render()
      assert.ok(studio.get().selectedId)
    }
  } finally { globalThis.document = previousDocument }
})

test('middle and right clicks and bubbled control events do not clear selection', async () => {
  const studio = createStudio(createDefaultProject()), view = makeView(studio), id = studio.get().selectedId
  const wrap = view.find(node => node.props.className === 'look2-stage-wrap')[0]
  const background = { setPointerCapture() {} }
  for (const button of [1, 2]) {
    wrap.props.onPointerDown({ button, target: background, currentTarget: background, preventDefault() {} })
    await settle()
    assert.equal(studio.get().selectedId, id)
  }
  wrap.props.onPointerDown({ button: 0, target: { classList: { contains: () => false } }, currentTarget: background })
  await settle()
  assert.equal(studio.get().selectedId, id)
})

test('clearing selection in a second client template keeps its canvas and animation context after reload', () => {
  const project = createDefaultClientTemplateProject()
  const second = structuredClone(project.root.children[0])
  function rename(node) { node.id = `second-${node.id}`; delete node.guid; delete node.giaInfoIndex; delete node.giaInfoIndexSource; node.children?.forEach(rename) }
  rename(second); project.root.children.push(second); project.selectedId = second.id
  const studio = createStudio(project), before = studio.get()
  const cleared = studio.transaction({ ops: [{ op: 'select', id: '' }], expectedRevision: before.version })
  assert.equal(cleared.selectedId, '')
  assert.equal(cleared.asset.currentTemplateId, second.id)
  assert.deepEqual(cleared.animationPreviewRoot, before.animationPreviewRoot)
  assert.deepEqual(cleared.boxes, before.boxes)
  const reopened = createStudio(studio.archiveData()).get()
  assert.equal(reopened.selectedId, '')
  assert.equal(reopened.asset.currentTemplateId, second.id)
})

test('invalid selection IDs do not clear a valid selection and null explicitly clears it', () => {
  const studio = createStudio(createDefaultProject()), id = studio.get().selectedId
  studio.patch({ op: 'select', id: 'missing' })
  assert.equal(studio.get().selectedId, id)
  studio.patch({ op: 'select' })
  assert.equal(studio.get().selectedId, id)
  studio.patch({ op: 'select', id: null })
  assert.equal(studio.get().selectedId, '')
})
