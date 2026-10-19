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

function makeView(studio, api = async () => { throw new Error('unexpected api call in workspace-panel test') }, initial = studio.get()) {
  const slots = []
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
    api,
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

  const select = view.find(node => node.props['aria-label'] === '工作区存档列表')[0]
  assert.ok(select, 'the archives are collapsed into a select')
  assert.equal(select.props.value, '', 'the select starts empty')
  const options = (select.children || []).filter(child => child?.type === 'option')
  assert.equal(options.length, 1, 'no archive entries render when the workspace is empty')
  assert.match(flattenText(options[0]), /暂无/)
  assert.equal((select.children || []).filter(child => child?.type === 'optgroup').length, 0)

  const archiveRow = view.find(node => node.props.className === 'look2-workspace-row look2-archive-row')[0]
  const actions = (archiveRow.children || []).filter(child => child?.type === 'button')
  assert.deepEqual(actions.map(flattenText), ['打开', '存档改名', '打开文件夹', '删除'])
  assert.ok(actions.every(button => button.props.disabled === true), 'archive actions stay disabled until one is selected')
  assert.equal(actions[3].props.className, 'look2-danger')

  const filter = view.find(node => node.props.className === 'look2-archive-filter')[0]
  assert.ok(filter, 'a show-test-files toggle is present')
  assert.match(flattenText(filter), /显示测试文件/)
  const checkbox = (filter.children || []).find(child => child?.type === 'input')
  assert.equal(checkbox?.props.type, 'checkbox')
  assert.equal(checkbox?.props.checked, false, 'only workspace saves are shown by default')
})

test('workspace management filters archives and remaps draft paths without saving', async () => {
  const studio = createStudio(createDefaultClientTemplateProject())
  let snapshot = structuredClone(studio.get())
  snapshot.storage = { ...(snapshot.storage || {}), path: 'root.save.json' }
  const actions = [], archiveManageCalls = []
  let workspaces = [{ name: '默认工作区', path: '' }, { name: '旧组', path: '工作区/旧组' }]
  let archives = [
    { name: '根存档', path: 'root.save.json' },
    { name: '旧组文件', path: '工作区/旧组/旧组.save.json' },
  ]
  const response = (extra = {}) => ({ ...extra, snapshot: structuredClone(snapshot), archives: structuredClone(archives), workspaces: structuredClone(workspaces) })
  const api = async (_sessionId, action, payload = {}) => {
    actions.push({ action, payload })
    if (action === 'transaction') {
      snapshot = { ...snapshot, version: snapshot.version + 1 }
      return structuredClone(snapshot)
    }
    if (action !== 'archive-manage') throw new Error(`unexpected ${action}`)
    archiveManageCalls.push(structuredClone(payload))
    if (payload.operation === 'create-workspace') {
      if (payload.name === '冲突组') throw new Error('工作区名称已存在')
      const path = `工作区/${payload.name}`
      if (workspaces.some(item => item.path === path)) throw new Error('工作区名称已存在')
      workspaces = [...workspaces, { name: payload.name, path }]
      return response({ path })
    }
    if (payload.operation === 'rename-workspace') {
      const path = `工作区/${payload.name}`
      const previousPath = payload.path
      workspaces = workspaces.map(item => item.path === previousPath ? { name: payload.name, path } : item)
      archives = archives.map(item => item.path === previousPath || item.path.startsWith(`${previousPath}/`)
        ? { ...item, path: `${path}${item.path.slice(previousPath.length)}` } : item)
      if (snapshot.storage.path === previousPath || snapshot.storage.path.startsWith(`${previousPath}/`)) {
        snapshot = { ...snapshot, storage: { ...snapshot.storage, path: `${path}${snapshot.storage.path.slice(previousPath.length)}` } }
      }
      return response({ path, previousPath })
    }
    if (payload.operation === 'rename-archive') {
      const previousPath = payload.path
      const path = `${previousPath.slice(0, previousPath.lastIndexOf('/') + 1)}${payload.name}`
      archives = archives.map(item => item.path === previousPath ? { ...item, path, name: payload.name } : item)
      if (snapshot.storage.path === previousPath) snapshot = { ...snapshot, storage: { ...snapshot.storage, path } }
      return response({ path, previousPath })
    }
    throw new Error(`unexpected operation ${payload.operation}`)
  }
  const view = makeView(studio, api, snapshot)
  const byText = label => view.find(node => node.type === 'button' && flattenText(node) === label)[0]
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); view.render() }

  view.find(node => node.props.className === 'look2-menu-button')[0].props.onClick()
  view.render()
  byText('新建工作区').props.onClick()
  view.render()
  let nameInput = view.find(node => node.props['aria-label'] === '名称')[0]
  nameInput.props.onChange({ target: { value: '冲突组' } })
  view.render()
  byText('确认').props.onClick()
  await settle()
  assert.equal(flattenText(view.find(node => node.props.role === 'alert')[0]), '工作区名称已存在', 'duplicate names remain visible in the dialog')
  assert.equal(actions.some(item => item.action === 'save'), false, 'workspace creation never saves a document')

  nameInput = view.find(node => node.props['aria-label'] === '名称')[0]
  nameInput.props.onChange({ target: { value: '项目组' } })
  view.render()
  byText('确认').props.onClick()
  await settle()
  assert.deepEqual(archiveManageCalls.at(-1), { operation: 'create-workspace', name: '项目组', expectedRevision: snapshot.version })
  assert.equal(archives.some(item => item.path === '工作区/项目组/look2.0.1.save.json'), false, 'creating a workspace does not create a document')

  const workspaceSelect = view.find(node => node.props['aria-label'] === '当前工作区')[0]
  workspaceSelect.props.onChange({ target: { value: '工作区/旧组' } })
  view.render()
  let archiveSelect = view.find(node => node.props['aria-label'] === '工作区存档列表')[0]
  assert.match(flattenText(archiveSelect), /旧组文件/)
  assert.doesNotMatch(flattenText(archiveSelect), /根存档/)
  workspaceSelect.props.onChange({ target: { value: '工作区/项目组' } })
  view.render()
  view.find(node => node.props['aria-label'] === '当前工作区')[0].props.onChange({ target: { value: '工作区/项目组' } })
  view.render()
  byText('新建文件').props.onClick()
  await settle()
  let filePathInput = view.find(node => node.props['aria-label'] === '项目存档路径')[0]
  assert.equal(filePathInput.props.value, '工作区/项目组/look2.0.1.save.json', 'new documents target the selected folder')

  byText('工作区改名').props.onClick()
  view.render()
  nameInput = view.find(node => node.props['aria-label'] === '名称')[0]
  nameInput.props.onChange({ target: { value: '正式组' } })
  view.render()
  byText('确认').props.onClick()
  await settle()
  filePathInput = view.find(node => node.props['aria-label'] === '项目存档路径')[0]
  assert.equal(filePathInput.props.value, '工作区/正式组/look2.0.1.save.json', 'renaming a folder remaps an unsaved document path')
  assert.equal(actions.some(item => item.action === 'save'), false, 'rename operations do not save the current draft')

  view.find(node => node.props['aria-label'] === '当前工作区')[0].props.onChange({ target: { value: '' } })
  view.render()
  archiveSelect = view.find(node => node.props['aria-label'] === '工作区存档列表')[0]
  archiveSelect.props.onChange({ target: { value: 'root.save.json' } })
  filePathInput = view.find(node => node.props['aria-label'] === '项目存档路径')[0]
  filePathInput.props.onChange({ target: { value: 'root.save.json' } })
  view.render()
  byText('存档改名').props.onClick()
  view.render()
  nameInput = view.find(node => node.props['aria-label'] === '存档文件名')[0]
  nameInput.props.onChange({ target: { value: 'renamed.save.json' } })
  view.render()
  byText('确认').props.onClick()
  await settle()
  assert.equal(view.find(node => node.props['aria-label'] === '工作区存档列表')[0].props.value, 'renamed.save.json')
  assert.equal(view.find(node => node.props['aria-label'] === '项目存档路径')[0].props.value, 'renamed.save.json', 'a bound session path follows the archive rename')
  assert.equal(archiveManageCalls.at(-1).path, 'root.save.json')
  assert.equal(archiveManageCalls.at(-1).name, 'renamed.save.json')
  assert.equal(actions.some(item => item.action === 'save'), false, 'archive rename never implicitly saves')
})
