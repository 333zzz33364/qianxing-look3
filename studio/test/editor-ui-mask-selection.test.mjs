import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCanvas } from '@napi-rs/canvas'
import { createMaskedControls } from '../../editor-ui/mask-preview.js'

function createHarness() {
  return {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) }),
    useMemo(factory) { return factory() },
  }
}
function collect(tree, predicate, found = []) {
  if (!tree || typeof tree !== 'object') return found
  if (predicate(tree)) found.push(tree)
  for (const child of tree.children || []) collect(child, predicate, found)
  return found
}
const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
const maskOf = (id, extra = {}) => ({
  id, matrix: identity, width: 100, height: 50, featherX: 0, featherY: 0,
  composition: 'single', reverse: false, fill: null, ...extra,
})
const boxOf = (id, masks = []) => ({ id, kind: 'image', masks })
const groupsOf = tree => collect({ children: tree.flat(Infinity) }, node => node.type?.name === 'MaskGroup')
const renderGroup = node => node.type({ ...node.props, children: node.children })

function withDocument(create = () => createCanvas(1, 1)) {
  const previous = globalThis.document
  globalThis.document = { createElement: create }
  return () => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous }
}

test('unmasked controls render directly and masked siblings share one group', () => {
  const React = createHarness()
  const MaskedControls = createMaskedControls(React)
  const rendered = []
  const renderControl = item => { rendered.push(item.id); return { type: 'control', props: {}, children: [item.id] } }
  const mask = maskOf('m1')
  const boxes = [boxOf('a'), boxOf('b', [mask]), boxOf('c', [mask]), boxOf('d')]
  const tree = MaskedControls({ boxes, canvasWidth: 800, canvasHeight: 600, renderControl })

  assert.deepEqual(rendered, ['a', 'b', 'c', 'd'])
  const groups = groupsOf(tree)
  assert.equal(groups.length, 1, 'adjacent boxes with the same mask share one composite group')
  assert.equal(groups[0].props.mask.id, 'm1')
  assert.deepEqual(groups[0].children.flat().map(node => node.type === 'control' ? node.children[0] : node.type?.name), ['b', 'c'])
})

test('a mask without feather uses a plain white rect instead of rasterising', () => {
  const React = createHarness()
  const MaskedControls = createMaskedControls(React)
  const tree = MaskedControls({
    boxes: [boxOf('a', [maskOf('m1')])], canvasWidth: 200, canvasHeight: 100,
    renderControl: item => ({ type: 'control', props: {}, children: [item.id] }),
  })
  const group = renderGroup(groupsOf(tree)[0])
  assert.equal(group.props.className, 'qxsim-mask-group')
  assert.equal(group.props['data-mask-id'], 'm1')
  const svg = decodeURIComponent(group.props.style.maskImage.replace(/^url\("data:image\/svg\+xml,/, '').replace(/"\)$/, ''))
  assert.match(svg, /<rect width="100" height="50" fill="white" transform="matrix\(1 0 0 1 -50 75\)"\/>/)
  assert.match(svg, /width="200" height="100" viewBox="0 0 200 100"/)
  assert.equal(group.props.style.maskMode, 'alpha')
  assert.equal(group.props.style.pointerEvents, 'none')
  assert.deepEqual(group.children.map(node => node.children[0]), ['a'])
})

test('feather rasterises through the shared mask canvas', () => {
  const restore = withDocument()
  try {
    const React = createHarness()
    const MaskedControls = createMaskedControls(React)
    const tree = MaskedControls({
      boxes: [boxOf('a', [maskOf('m1', { featherX: 8, featherY: 8 })])], canvasWidth: 200, canvasHeight: 100,
      renderControl: item => ({ type: 'control', props: {}, children: [item.id] }),
    })
    const group = renderGroup(groupsOf(tree)[0])
    const svg = decodeURIComponent(group.props.style.maskImage.replace(/^url\("data:image\/svg\+xml,/, '').replace(/"\)$/, ''))
    assert.match(svg, /<image width="100" height="50" preserveAspectRatio="none" href="data:image\/png;base64,/)
  } finally { restore() }
})

test('nested masks nest groups and a non-invertible matrix drops the group', () => {
  const React = createHarness()
  const MaskedControls = createMaskedControls(React)
  const tree = MaskedControls({
    boxes: [boxOf('a', [maskOf('outer'), maskOf('inner')])], canvasWidth: 200, canvasHeight: 100,
    renderControl: item => ({ type: 'control', props: {}, children: [item.id] }),
  })
  const groups = groupsOf(tree)
  assert.deepEqual(groups.map(group => group.props.mask.id), ['outer', 'inner'])
  // 外层组的子节点里包含内层组，形成嵌套。
  assert.equal(groups[0].children.flat().some(node => node.type?.name === 'MaskGroup'), true)

  const singular = maskOf('bad', { matrix: { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 } })
  const dropped = MaskedControls({
    boxes: [boxOf('a', [singular])], canvasWidth: 200, canvasHeight: 100,
    renderControl: item => ({ type: 'control', props: {}, children: [item.id] }),
  })
  assert.equal(renderGroup(groupsOf(dropped)[0]), null, 'a non-invertible mask renders nothing')
})

test('zero-sized masks are not composited', () => {
  const React = createHarness()
  const MaskedControls = createMaskedControls(React)
  const tree = MaskedControls({
    boxes: [boxOf('a', [maskOf('m1', { width: 0 })])], canvasWidth: 200, canvasHeight: 100,
    renderControl: item => ({ type: 'control', props: {}, children: [item.id] }),
  })
  assert.equal(renderGroup(groupsOf(tree)[0]), null)
})

test('editor keeps the selection layer separate from masked control bodies', () => {
  const source = readFileSync(new URL('../../editor-ui/index.js', import.meta.url), 'utf8')
  // 选中框只由 selectionOnly 分支产出，控件本体不内联 selected 样式。
  assert.match(source, /if \(selectionOnly\) return e\('div', \{/)
  assert.match(source, /'data-selection-id': item\.id/)
  assert.match(source, /\['tl', 'tr', 'bl', 'br'\]\.map\(\(pos\) => e\('i', \{ key: pos, className: `qxsim-handle \$\{pos\}` \}\)\)/)
  assert.doesNotMatch(source, /className: `qxsim-box \$\{kind\}[^`]*selected/)
  // 画布先渲染遮罩分组，再单独叠加选中层。
  assert.match(source, /e\(MaskedControls, \{ boxes: renderBoxes, canvasWidth, canvasHeight, renderControl:/)
  assert.match(source, /selectionBox \? renderControl\(selectionBox, snap, canvasWidth, canvasHeight, effectiveZoom, dragOffset, fontFamily, true\) : null/)
  // 层级隐藏的控件不进入画布渲染。
  assert.match(source, /box\.visibleInHierarchy !== false/)
})
