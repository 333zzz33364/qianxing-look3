import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView, groupWorkspaceArchives } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject } from '../ui/authoring.js'

function flattenText(node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children || []).map(flattenText).join('')
}

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
    api: async () => { throw new Error('unexpected api call in workspace-panel test') },
  })
  function render() { cursor = 0; tree = AnimationView({ sessionId: 'workspace-panel' }); return tree }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  render()
  return { render, find }
}

test('groupWorkspaceArchives separates root saves from nested workspace files', () => {
  const rows = [
    { path: 'a.save.json', name: '甲' },
    { path: 'acceptance-20261005/large-draft.save.json', name: '乙' },
    { path: 'c.save.json', name: '丙' },
  ]
  const { root, other } = groupWorkspaceArchives(rows)
  assert.deepEqual(root.map(entry => entry.path), ['a.save.json', 'c.save.json'])
  assert.deepEqual(other.map(entry => entry.path), ['acceptance-20261005/large-draft.save.json'])
  assert.deepEqual(groupWorkspaceArchives(), { root: [], other: [] })
})

test('the workspace panel shows a collapsible usage guide and a grouped archive dropdown', () => {
  const view = makeView(createStudio(createDefaultClientTemplateProject()))
  assert.equal(view.find(node => node.props.className === 'look2-workspace').length, 0, 'the panel starts closed')

  const menu = view.find(node => node.props.className === 'look2-menu-button')[0]
  assert.ok(menu, 'the top-left menu button exists')
  menu.props.onClick()
  view.render()

  assert.ok(view.find(node => node.props.className === 'look2-workspace')[0], 'clicking the menu opens the workspace panel')
  const summary = view.find(node => node.type === 'summary')[0]
  assert.ok(summary, 'the usage guide is a native collapsible')
  assert.match(flattenText(summary), /使用说明/)
  const steps = view.find(node => node.props.className === 'look2-usage-list')[0]
  assert.ok(steps)
  assert.ok((steps.children || []).length >= 5, 'the guide lists several usage steps')

  const select = view.find(node => node.props.className === 'look2-archive-select')[0]
  assert.ok(select, 'the archives are collapsed into a select')
  assert.equal(select.props.value, '', 'the select starts empty')
  const options = (select.children || []).filter(child => child?.type === 'option')
  assert.equal(options.length, 1, 'no archive entries render when the workspace is empty')
  assert.match(flattenText(options[0]), /暂无/)
  assert.equal((select.children || []).filter(child => child?.type === 'optgroup').length, 0)

  const archiveRow = view.find(node => node.props.className === 'look2-workspace-row')[1]
  const actions = (archiveRow.children || []).filter(child => child?.type === 'button')
  assert.deepEqual(actions.map(flattenText), ['打开', '打开文件夹', '删除'])
  assert.ok(actions.every(button => button.props.disabled === true), 'archive actions stay disabled until one is selected')
  assert.equal(actions[2].props.className, 'look2-danger')

  const filter = view.find(node => node.props.className === 'look2-archive-filter')[0]
  assert.ok(filter, 'a show-test-files toggle is present')
  assert.match(flattenText(filter), /显示测试文件/)
  const checkbox = (filter.children || []).find(child => child?.type === 'input')
  assert.equal(checkbox?.props.type, 'checkbox')
  assert.equal(checkbox?.props.checked, false, 'only workspace saves are shown by default')
})