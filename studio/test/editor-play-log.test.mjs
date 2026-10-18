import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject } from '../ui/authoring.js'
import { buildPlayLog, canStopInlinePlay, playLogFilename, PLAY_STOP_GRACE_MS, playTargetGuide } from '../../editor-ui/play-log.js'

test('canStopInlinePlay ignores a stop inside the grace window after play starts', () => {
  assert.equal(canStopInlinePlay(0), true, 'no recorded start still allows stopping')
  assert.equal(canStopInlinePlay(1000, 1000 + PLAY_STOP_GRACE_MS - 1), false)
  assert.equal(canStopInlinePlay(1000, 1000 + PLAY_STOP_GRACE_MS), true)
  assert.equal(canStopInlinePlay(1000, 1000 + PLAY_STOP_GRACE_MS + 500), true)
})

test('buildPlayLog packages the debug panel data and names the JSON file', () => {
  const log = buildPlayLog({
    now: 0, sessionId: 's1', saveName: '工程', filePath: 'a.b', assetType: 'client-control-template',
    canvas: { id: 'pc' }, playTarget: 'template', running: true,
    status: { frame: 3 }, server: { hp: 1 }, tree: [{ name: '甲' }], logs: ['a', 'b'],
  })
  assert.equal(log.exportedAt, new Date(0).toISOString())
  assert.equal(log.sessionId, 's1')
  assert.deepEqual(log.project, { name: '工程', path: 'a.b', assetType: 'client-control-template', canvas: { id: 'pc' } })
  assert.deepEqual(log.play, { target: 'template', running: true })
  assert.deepEqual(log.status, { frame: 3 })
  assert.deepEqual(log.server, { hp: 1 })
  assert.deepEqual(log.controls, [{ name: '甲' }])
  assert.deepEqual(log.logs, ['a', 'b'])

  const empty = buildPlayLog({ now: 0 })
  assert.deepEqual(empty.play, { target: 'full', running: false })
  assert.deepEqual(empty.controls, [])
  assert.deepEqual(empty.logs, [])
  assert.equal(empty.project.name, '')
  assert.equal(playLogFilename(0), 'look2-play-log-1970-01-01T00-00-00-000Z.json')
})

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
    api: async () => { throw new Error('unexpected api call in play-log test') },
  })
  function render() { cursor = 0; tree = AnimationView({ sessionId: 'play-log' }); return tree }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  render()
  return { render, find }
}

test('play target selector opens a dropdown that explains both targets and their difference', () => {
  const view = makeView(createStudio(createDefaultClientTemplateProject()))
  const guide = playTargetGuide()
  const trigger = view.find(node => node.props.className === 'look2-play-help-trigger')[0]
  assert.ok(trigger, 'help trigger is rendered next to the target select')
  assert.equal(flattenText(trigger), '▾')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.match(trigger.props.title, /完整界面/)
  assert.match(trigger.props.title, /当前模板/)
  assert.match(trigger.props.title, /区别/)
  assert.equal(view.find(node => node.props.className === 'look2-play-help-panel').length, 0, 'the explanation stays collapsed until opened')

  trigger.props.onClick()
  view.render()
  const panel = view.find(node => node.props.className === 'look2-play-help-panel')[0]
  assert.ok(panel, 'clicking the arrow opens the explanation panel')
  assert.equal(panel.props.role, 'tooltip')
  assert.equal(view.find(node => node.props.className === 'look2-play-help-trigger')[0].props['aria-expanded'], true)
  const panelText = flattenText(panel)
  assert.match(panelText, new RegExp(guide.full.label))
  assert.match(panelText, new RegExp(guide.template.label))
  assert.match(panelText, /区别/)

  view.find(node => node.props.className === 'look2-play-help-trigger')[0].props.onClick()
  view.render()
  assert.equal(view.find(node => node.props.className === 'look2-play-help-panel').length, 0, 'clicking again collapses the explanation')

  view.find(node => node.props.className === 'look2-play-help-trigger')[0].props.onClick()
  view.render()
  const backdrop = view.find(node => node.props.className === 'look2-play-help-backdrop')[0]
  assert.ok(backdrop, 'an outside-click backdrop is present while open')
  backdrop.props.onClick()
  view.render()
  assert.equal(view.find(node => node.props.className === 'look2-play-help-panel').length, 0, 'clicking blank space closes the explanation')
})

test('export play log button downloads the debug panel JSON', () => {
  const downloads = []
  const previous = {
    document: globalThis.document,
    createObjectURL: globalThis.URL.createObjectURL,
    revokeObjectURL: globalThis.URL.revokeObjectURL,
  }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ href: '', download: '', click() { downloads.push(this.download) }, remove() {} }),
    head: { append() {} },
    body: { append() {} },
  }
  globalThis.URL.createObjectURL = () => 'blob:test'
  globalThis.URL.revokeObjectURL = () => {}
  try {
    const view = makeView(createStudio(createDefaultClientTemplateProject()))
    const debugTab = view.find(node => node.props.role === 'tab' && flattenText(node).includes('调试'))[0]
    assert.ok(debugTab, 'debug dock tab exists')
    debugTab.props.onClick()
    view.render()
    const button = view.find(node => node.props.className === 'look2-export-play-log')[0]
    assert.ok(button, 'export button is rendered in the debug panel')
    button.props.onClick()
    assert.equal(downloads.length, 1)
    assert.match(downloads[0], /^look2-play-log-.*\.json$/)
  } finally {
    if (previous.document === undefined) delete globalThis.document
    else globalThis.document = previous.document
    globalThis.URL.createObjectURL = previous.createObjectURL
    globalThis.URL.revokeObjectURL = previous.revokeObjectURL
  }
})