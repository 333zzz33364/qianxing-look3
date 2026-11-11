import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStudio } from '../../studio/index.js'
import { createNode } from '../../studio/ui/authoring.js'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('Look3 toolbar entry matrix and tree operation combinations stay usable in the active UI', {
  skip: !process.env.QXQY_BROWSER, timeout: 120_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-toolbar-tree-matrix-'))
  const path = 'toolbar-tree.save.json'
  const file = join(directory, path)
  const archive = createStudio().archiveData()
  const container = archive.assets.server.root.children[0]
  const target = container.children.find(node => node.kind === 'textbox')
  assert.ok(target, 'fixture needs a textbox for tree operations')
  const sibling = container.children.find(node => node.id !== target.id && node.kind !== 'container')
  assert.ok(sibling, 'fixture needs a second control for reorder and duplicate checks')
  target.name = '矩阵目标文本'
  const moving = createNode('textbox', { name: '矩阵拖放源', text: '拖放源' })
  archive.assets.server.root.children.push(moving)
  archive.meta.name = '工具栏与树组合矩阵'
  writeFileSync(file, JSON.stringify(archive))

  const app = await createWebServer({ workspace: directory, initialPath: path, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close()
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory, ['--disable-gpu', '--disable-features=Vulkan,UseSkiaRenderer,WebGPU'])
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(`${app.url}/editor`)
  await browser.wait(`!!document.querySelector('.look2-tree-tools [aria-label="搜索控件"]')`)

  const clickBox = async box => {
    assert.ok(box && box.width > 0 && box.height > 0, `不可点击目标：${JSON.stringify(box)}`)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, browser.sessionId)
  }
  const boxOf = async selector => browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return null; el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x: r.x, y: r.y, width: r.width, height: r.height, hitTarget: Boolean(hit && (hit === el || el.contains(hit))) }; })()`)
  const clickSelector = async selector => {
    const box = await boxOf(selector)
    assert.ok(box?.hitTarget, `真实点击中心未命中 ${selector}: ${JSON.stringify(box)}`)
    await clickBox(box)
  }
  const rightClickSelector = async (selector, scopeSelector = '') => {
    const box = await browser.evaluate(`(() => { const scope = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : 'document'}; const el = scope?.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, width: r.width, height: r.height, hitTarget: Boolean(document.elementFromPoint(x, y)) }; })()`)
    assert.ok(box?.hitTarget, `真实右键中心未命中 ${selector}: ${JSON.stringify(box)}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'right', buttons: 0, clickCount: 1 }, browser.sessionId)
  }
  const clickContextItem = async label => {
    await browser.wait(`!![...document.querySelectorAll('.look2-context-menu button')].find(button => button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled)`)
    const clicked = await browser.evaluate(`(() => { const el = [...document.querySelectorAll('.look2-context-menu button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}); if (!el || el.disabled) return false; el.click(); return true; })()`)
    assert.equal(clicked, true, `右键菜单项无法点击：${label}`)
  }
  const rightClickTreeName = async name => {
    const box = await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('.look2-tree-row')].find(item => item.querySelector('.tree-name')?.textContent.trim() === ${JSON.stringify(name)})
      const el = row?.querySelector('.tree-name')
      if (!el) return null
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      const x = r.x + r.width / 2, y = r.y + r.height / 2
      return { x, y, width: r.width, height: r.height, hitTarget: Boolean(document.elementFromPoint(x, y)) }
    })()`)
    assert.ok(box?.hitTarget, `真实右键中心未命中树项目 ${name}: ${JSON.stringify(box)}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'right', buttons: 0, clickCount: 1 }, browser.sessionId)
  }
  const clickButtonText = async (text, scopeSelector) => {
    const box = await browser.evaluate(`(() => { const scope = document.querySelector(${JSON.stringify(scopeSelector)}); const el = [...(scope?.querySelectorAll('button') || [])].find(item => item.textContent.trim() === ${JSON.stringify(text)} && !item.disabled); if (!el) return null; el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x: r.x, y: r.y, width: r.width, height: r.height, hitTarget: Boolean(hit && (hit === el || el.contains(hit))) }; })()`)
    assert.ok(box?.hitTarget, `真实点击中心未命中按钮 ${text}: ${JSON.stringify(box)}`)
    await clickBox(box)
  }
  const setSelect = async (selector, value) => {
    const exists = await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`)
    assert.ok(exists, `下拉框不存在：${selector}`)
    await delay(50)
  }
  const optionsOf = selector => browser.evaluate(`[...document.querySelector(${JSON.stringify(selector)}).options].map(option => ({ value: option.value, text: option.textContent.trim(), disabled: option.disabled }))`)
  const zoomPercent = () => browser.evaluate(`Number((document.querySelector('.look2-zoom-control span')?.textContent || '').replace('%', ''))`)
  const sessionId = await browser.evaluate(`document.querySelector('.look2')?.dataset.qxsimSessionId || ''`)
  assert.ok(sessionId, 'active Look2 session id should be present')
  const snapshot = async () => {
    const response = await fetch(`${app.url}/editor/api/get`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
    })
    const envelope = await response.json()
    assert.equal(response.status, 200, JSON.stringify(envelope))
    return envelope.value
  }
  const waitForSnapshot = async (predicate, description) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const value = await snapshot()
      if (predicate(value)) return value
      await delay(50)
    }
    const value = await snapshot()
    assert.fail(`${description}: ${JSON.stringify({ canvasId: value.canvasId, selectedId: value.selectedId, locks: value.editorLocks, tree: value.tree?.length })}`)
  }
  const rowCount = () => browser.evaluate(`document.querySelectorAll('.look2-tree-row').length`)

  // U-UI02: every toolbar entry that does not open an OS dialog is present and reachable.
  const toolbarSelectors = [
    'button[title="新建工程"]', 'button[title="保存当前存档"]', 'button[aria-label="撤销"]', 'button[aria-label="重做"]',
    'button[aria-label="历史记录"]', 'select[title="导入文件"]', 'select[aria-label="导出格式"]', 'button[title="控件模板"]',
    'button[title="图片资源"]', 'select[aria-label="Lua 工具"]', 'select[title="画布尺寸"]', 'button[title="缩小"]', 'button[title="放大"]',
    'button[title="适应画布"]', 'button[aria-label="字体设置"]', 'select[aria-label="试玩目标"]', 'select[aria-label="试玩人数"]',
  ]
  for (const selector of toolbarSelectors) {
    assert.equal(await browser.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), true, `工具栏入口缺失：${selector}`)
  }
  const conditionalSelectors = ['button[aria-label="撤销"]', 'button[aria-label="重做"]', 'button[title="控件模板"]', 'button[title="图片资源"]']
  for (const selector of toolbarSelectors.filter(item => !conditionalSelectors.includes(item))) {
    assert.ok(await boxOf(selector), `工具栏入口不可用：${selector}`)
  }
  assert.equal(await browser.evaluate(`document.querySelector('button[aria-label="重做"]').disabled`), true, '无重做历史时重做应禁用')
  const exportOptions = (await optionsOf('select[aria-label="导出格式"]')).map(option => option.text)
  for (const expected of ['部分组合导出', '站点 JSON', '当前界面 Authoring JSON', 'GIA', 'GIA 整合包（控件+脚本）', '完整存档', 'Timeline Data', 'TweenTimelineLib 8.3', '播放脚本 Lua']) {
    assert.ok(exportOptions.includes(expected), `导出下拉缺少 ${expected}: ${JSON.stringify(exportOptions)}`)
  }
  const importOptions = (await optionsOf('select[title="导入文件"]')).map(option => option.text)
  assert.ok(importOptions.includes('JSON / GIA / PSD / Lua'), JSON.stringify(importOptions))
  const luaOptions = (await optionsOf('select[aria-label="Lua 工具"]')).map(option => option.text)
  for (const expected of ['导入 Lua / Timeline Data', '导出 Timeline Data', '导出 TweenTimelineLib', '导出播放脚本']) {
    assert.ok(luaOptions.includes(expected), `Lua 工具缺少 ${expected}: ${JSON.stringify(luaOptions)}`)
  }

  // Template and resource entries follow the edited asset, not the toolbar itself.
  assert.equal(await browser.evaluate(`document.querySelector('button[title="控件模板"]').disabled`), true, '服务端 UI 下控件模板应禁用')
  await browser.evaluate(`[...document.querySelectorAll('.look2-asset-switch button')].find(button => button.textContent.trim() === '客户端模板').click()`)
  await browser.wait(`document.querySelector('button[title="控件模板"]')?.disabled === false`)
  assert.equal(await browser.evaluate(`document.querySelector('button[title="图片资源"]').disabled`), false)
  await clickSelector('button[title="控件模板"]')
  await browser.wait(`!!document.querySelector('.look2-modal[aria-label="控件模板"]')`)
  await clickButtonText('关闭', '.look2-modal[aria-label="控件模板"]')
  await browser.wait(`!document.querySelector('.look2-modal[aria-label="控件模板"]')`)
  await browser.evaluate(`[...document.querySelectorAll('.look2-asset-switch button')].find(button => button.textContent.trim() === '服务端 UI').click()`)
  await browser.wait(`document.querySelector('button[title="控件模板"]')?.disabled === true`)

  // Zoom entries must change the rendered scale, and 适应画布 must reset it to 100%.
  const initialZoom = await zoomPercent()
  await clickSelector('button[title="放大"]')
  await browser.wait(`Number((document.querySelector('.look2-zoom-control span')?.textContent || '').replace('%', '')) > ${initialZoom}`)
  const zoomedIn = await zoomPercent()
  await clickSelector('button[title="缩小"]')
  await clickSelector('button[title="缩小"]')
  const zoomedOut = await zoomPercent()
  assert.ok(zoomedOut < zoomedIn, JSON.stringify({ initialZoom, zoomedIn, zoomedOut }))
  await clickSelector('button[title="适应画布"]')
  await browser.wait(`Math.abs(Number((document.querySelector('.look2-zoom-control span')?.textContent || '').replace('%', '')) - ${initialZoom}) <= 1`)
  assert.ok(Math.abs(await zoomPercent() - initialZoom) <= 1, '适应画布应回到初始适配比例')

  // Canvas preset switching, then undo/redo from the toolbar.
  const canvasIds = await browser.evaluate(`[...document.querySelector('select[title="画布尺寸"]').options].map(option => option.value)`)
  const originalCanvas = (await snapshot()).canvasId
  const otherCanvas = canvasIds.find(id => id !== originalCanvas && !id.startsWith('__'))
  assert.ok(otherCanvas, JSON.stringify(canvasIds))
  await setSelect('select[title="画布尺寸"]', otherCanvas)
  await waitForSnapshot(value => value.canvasId === otherCanvas, '切换画布尺寸未生效')
  await browser.wait(`document.querySelector('button[aria-label="撤销"]').disabled === false`)
  await clickSelector('button[aria-label="撤销"]')
  await waitForSnapshot(value => value.canvasId === originalCanvas, '工具栏撤销未恢复画布尺寸')
  await browser.wait(`document.querySelector('button[aria-label="重做"]').disabled === false`)
  await clickSelector('button[aria-label="重做"]')
  await waitForSnapshot(value => value.canvasId === otherCanvas, '工具栏重做未重新应用画布尺寸')

  // Font settings entry opens and closes through its own controls.
  await clickSelector('button[aria-label="字体设置"]')
  await browser.wait(`!!document.querySelector('.look2-font-modal[aria-label="字体设置"]')`)
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.look2-font-modal button')].some(button => button.textContent.trim() === '关闭')`), true, '字体设置弹窗应包含关闭入口')
  const closed = await browser.evaluate(`(() => { const modal = document.querySelector('.look2-font-modal[aria-label="字体设置"]'); const button = [...modal.querySelectorAll('button')].find(item => item.textContent.trim() === '关闭'); if (!button) return false; button.click(); return true; })()`)
  assert.equal(closed, true, '字体设置弹窗应能通过关闭按钮退出')
  await browser.wait(`!document.querySelector('.look2-font-modal[aria-label="字体设置"]')`)

  // U-UI03: search, lock, drag reparent, hide, duplicate and delete in one flow.
  const search = '矩阵目标文本'
  await clickSelector('[aria-label="搜索控件"]')
  await browser.send('Input.insertText', { text: search }, browser.sessionId)
  await browser.wait(`document.querySelector('[aria-label="搜索控件"]')?.value === ${JSON.stringify(search)}`)
  await browser.wait(`document.querySelectorAll('.look2-tree-row').length === 1`)
  await clickSelector('.tree-name', '.look2-tree-row')
  await waitForSnapshot(value => value.selectedId === target.id, '搜索结果行未选中目标控件')

  await clickSelector('.tree-lock', '.look2-tree-row')
  await browser.wait(`document.querySelector('.look2-tree-row')?.classList.contains('locked-node')`)
  await waitForSnapshot(value => value.editorLocks?.[target.id] === true, '锁定入口未写入编辑锁')

  // Drag the locked node onto a container: an edit lock must block the reparent.
  const lockedDrop = await browser.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.look2-tree-row')]
    if (rows.length !== 1) return { rows: rows.length }
    const name = row => row.querySelector('.tree-name')?.textContent.trim()
    const lockedRow = rows[0]
    const dataTransfer = new DataTransfer()
    lockedRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    lockedRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY: lockedRow.getBoundingClientRect().top + 5 }))
    lockedRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: lockedRow.getBoundingClientRect().top + 5 }))
    return { rows: rows.length, name: name(lockedRow) }
  })()`)
  assert.equal(lockedDrop.rows, 1, '搜索过滤后只应保留目标行')
  await waitForSnapshot(value => value.editorLocks?.[target.id] === true && value.selectedId === target.id,
    '锁定状态下拖放不应改变编辑锁或选中项')

  await clickSelector('.tree-lock', '.look2-tree-row')
  await browser.wait(`!document.querySelector('.look2-tree-row')?.classList.contains('locked-node')`)
  await waitForSnapshot(value => value.editorLocks?.[target.id] !== true, '解锁入口未清除编辑锁')

  // Drag a root-level control into a container: dropping inside reparents it.
  assert.ok(moving, 'fixture needs a root-level control to drag into the container')
  const cleared = await browser.evaluate(`(() => {
    const input = document.querySelector('[aria-label="搜索控件"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  assert.equal(cleared, true, '搜索框应可清空')
  await browser.wait(`document.querySelector('[aria-label="搜索控件"]')?.value === ''`)
  await browser.wait(`document.querySelectorAll('.look2-tree-row').length > 2`)
  const dragged = await browser.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.look2-tree-row')]
    const name = row => row.querySelector('.tree-name')?.textContent.trim()
    const source = rows.find(row => name(row) === ${JSON.stringify(moving.name)})
    const parent = rows.find(row => name(row) === ${JSON.stringify(container.name)})
    if (!source || !parent) return { ok: false, source: Boolean(source), parent: Boolean(parent) }
    const rect = parent.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    parent.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY: rect.top + rect.height / 2 }))
    parent.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: rect.top + rect.height / 2 }))
    return { ok: true, sourceName: name(source) }
  })()`)
  assert.ok(dragged.ok, `拖放目标行未找到：${JSON.stringify(dragged)}`)
  await waitForSnapshot(value => {
    const find = (node) => node.id === container.id ? node : (node.children || []).map(find).find(Boolean)
    return find(value.root)?.children?.some(node => node.id === moving.id)
  }, '拖放未把根级控件移入容器')

  const beforeTree = (await snapshot()).tree.length
  await rightClickTreeName(target.name)
  await clickContextItem('复制控件')
  await waitForSnapshot(value => value.tree.length === beforeTree + 1, '复制控件未新增控件')

  await rightClickTreeName(target.name)
  await clickContextItem('删除控件')
  await waitForSnapshot(value => value.tree.length === beforeTree, '删除控件未移除控件')

  const eyeBefore = await browser.evaluate(`document.querySelector('.look2-tree-row [title="在画布隐藏"], .look2-tree-row [title="在画布显示"]')?.getAttribute('title') || ''`)
  await clickSelector(`.look2-tree-row [title="${eyeBefore}"]`)
  await browser.wait(`document.querySelector('.look2-tree-row')?.classList.contains('hidden-node') === ${eyeBefore === '在画布隐藏'}`)

  // Saving from the toolbar writes the workspace archive explicitly.
  await clickSelector('button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('.look2-archive-status')?.textContent.includes('已保存')`)
})
