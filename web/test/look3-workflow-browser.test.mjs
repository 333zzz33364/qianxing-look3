import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStudio } from '../../studio/index.js'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('Look3 workspace and archive rename preserve an explicitly saved draft through UI reopen', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-workflow-browser-'))
  const app = await createWebServer({ workspace: directory, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close()
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory)
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1200, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2 button[title="工作区存档"]')`)

  const clickBox = async box => {
    assert.ok(box && box.width > 0 && box.height > 0, `不可点击目标：${JSON.stringify(box)}`)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, browser.sessionId)
  }
  const clickSelector = async selector => {
    const box = await browser.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`)
    await clickBox(box)
  }
  const clickButton = async (label, scope = 'document') => {
    const box = await browser.evaluate(`(() => { const root = ${scope}; const el = [...root.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`)
    await clickBox(box)
  }
  const replaceInput = async (selector, value) => {
    await clickSelector(selector)
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.select()`)
    await browser.send('Input.insertText', { text: value }, browser.sessionId)
    try { await browser.wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`) }
    catch (error) {
      const state = await browser.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); return { value: input?.value, active: document.activeElement?.getAttribute('aria-label'), tag: document.activeElement?.tagName }; })()`)
      throw new Error(`${error.message}\ninput state: ${JSON.stringify(state)}`)
    }
  }
  const fillDialog = async (label, value) => {
    const selector = `[role="dialog"] input[aria-label=${JSON.stringify(label)}]`
    await replaceInput(selector, value)
    await clickButton('确认', 'document.querySelector("[role=dialog]")')
    await browser.wait(`!document.querySelector('[role="dialog"][aria-label="管理工作区文件"]')`)
  }
  const readWorkspacePath = () => browser.evaluate(`document.querySelector('[aria-label="当前工作区"]')?.value ?? ''`)
  const readSavePath = () => browser.evaluate(`document.querySelector('[aria-label="项目存档路径"]')?.value ?? ''`)

  await clickSelector('button[title="工作区存档"]')
  await browser.wait(`!!document.querySelector('button') && [...document.querySelectorAll('button')].some(el => el.textContent.trim() === '新建工作区')`)
  await clickButton('新建工作区')
  await browser.wait(`!!document.querySelector('[role="dialog"] input[aria-label="名称"]')`)
  await fillDialog('名称', 'Look3流程甲')
  await browser.wait(`document.querySelector('[aria-label="当前工作区"]')?.value === '工作区/Look3流程甲'`)

  await clickButton('新建文件')
  await browser.wait(`document.querySelector('[aria-label="项目存档路径"]')?.value.startsWith('工作区/Look3流程甲/')`)
  await replaceInput('[aria-label="工程名称"]', '首次保存')
  await clickSelector('button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已保存 工作区/Look3流程甲/')`)
  const originalPath = await readSavePath()
  assert.ok(originalPath.endsWith('.save.json'), originalPath)
  const originalFile = join(directory, ...originalPath.split('/'))
  assert.ok(existsSync(originalFile), `UI保存没有写出存档：${originalPath}`)
  assert.equal(JSON.parse(readFileSync(originalFile, 'utf8')).meta.name, '首次保存')

  await clickButton('工作区改名')
  await browser.wait(`!!document.querySelector('[role="dialog"] input[aria-label="名称"]')`)
  await fillDialog('名称', 'Look3流程乙')
  await browser.wait(`document.querySelector('[aria-label="当前工作区"]')?.value === '工作区/Look3流程乙'`)
  const movedPath = await readSavePath()
  assert.equal(movedPath, originalPath.replace('工作区/Look3流程甲/', '工作区/Look3流程乙/'))
  const movedFile = join(directory, ...movedPath.split('/'))
  assert.equal(existsSync(originalFile), false, '工作区改名后旧目录中的存档应消失')
  assert.ok(existsSync(movedFile), '工作区改名应移动存档')

  const archiveSelect = '[aria-label="工作区存档列表"]'
  const archiveOptions = await browser.evaluate(`([...document.querySelector(${JSON.stringify(archiveSelect)}).options]).map(option => ({ value: option.value, text: option.textContent }))`)
  const archive = archiveOptions.find(option => option.value === movedPath)
  assert.ok(archive, JSON.stringify(archiveOptions))
  await clickSelector(archiveSelect)
  await browser.key('ArrowDown', 'ArrowDown')
  await browser.key('Enter', 'Enter')
  await browser.wait(`document.querySelector(${JSON.stringify(archiveSelect)})?.value === ${JSON.stringify(movedPath)}`)
  await clickButton('存档改名')
  await browser.wait(`!!document.querySelector('[role="dialog"] input[aria-label="存档文件名"]')`)
  await fillDialog('存档文件名', '显式保存验证.save.json')
  await browser.wait(`document.querySelector('[aria-label="工作区存档列表"]')?.value === '工作区/Look3流程乙/显式保存验证.save.json'`)

  const finalPath = '工作区/Look3流程乙/显式保存验证.save.json'
  const finalFile = join(directory, ...finalPath.split('/'))
  assert.equal(existsSync(movedFile), false, '存档改名后旧文件应消失')
  assert.ok(existsSync(finalFile), 'UI存档改名应写入新路径')
  await replaceInput('[aria-label="工程名称"]', '明确提交的版本')
  await clickSelector('button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已保存 ${finalPath}')`)
  assert.equal(JSON.parse(readFileSync(finalFile, 'utf8')).meta.name, '明确提交的版本')

  await replaceInput('[aria-label="工程名称"]', '只存在于未保存草稿')
  await clickButton('打开')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已加载 ${finalPath}')`)
  await clickSelector('button[title="工作区存档"]')
  await browser.wait(`document.querySelector('[aria-label="工程名称"]')?.value === '明确提交的版本'`)
  assert.equal(await readSavePath(), finalPath)
  assert.equal(JSON.parse(readFileSync(finalFile, 'utf8')).meta.name, '明确提交的版本')
  assert.equal(await readWorkspacePath(), '工作区/Look3流程乙')
})

test('Look3 toolbar imports JSON, edits platform geometry, submits Lua, exports and reopens a saved archive', {
  skip: !process.env.QXQY_BROWSER, timeout: 120_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-toolbar-workflow-browser-'))
  const sourcePath = join(directory, 'toolbar-source.json')
  const savedPath = join(directory, 'look2.0.1.save.json')
  const archive = createStudio().archiveData()
  const parent = archive.assets.server.root.children[0]
  const target = parent.children.find(node => node.kind === 'textbox')
  assert.ok(target, '合成 JSON 必须带有可编辑的服务端文本控件')
  parent.children = [target]
  target.name = '工具栏指针编辑目标'
  target.text = '工具栏指针编辑目标'
  target.syncAllDevices = false
  for (const transform of Object.values(target.transformByPlatform)) {
    transform.offset = { x: 0, y: 0 }
    transform.size = { x: 300, y: 100 }
  }
  archive.activeAssetType = 'server-control-template'
  archive.meta.name = '工具栏跨入口验收'
  archive.assets.scripts = [{
    id: 'script-toolbar', guid: 8101, path: 'lua/toolbar.lua', source: 'return "toolbar-initial"', controlId: '', controlAsset: '',
  }]
  writeFileSync(sourcePath, `${JSON.stringify(archive, null, 2)}\n`)

  const app = await createWebServer({ workspace: directory, port: 0 })
  let browser
  t.after(async () => {
    try { await browser?.close() }
    finally {
      try { await app.close() }
      finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    }
  })

  browser = await startTestBrowser(directory)
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory })
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1200, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2-top button[title="新建工程"]') && !!document.querySelector('.look2-top select[title="导入文件"]')`)

  const clickExpression = async expression => {
    const box = await browser.evaluate(`(async () => {
      const el = ${expression}
      if (!el || el.disabled) return null
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const rect = el.getBoundingClientRect()
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
      const hit = document.elementFromPoint(x, y)
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        centerX: x, centerY: y, viewportWidth: innerWidth, viewportHeight: innerHeight,
        centerHit: !!hit && (hit === el || el.contains(hit)), hitTag: hit?.tagName, hitClass: hit?.className }
    })()`)
    assert.ok(box && box.width > 0 && box.height > 0, `不可点击目标：${JSON.stringify(box)}`)
    assert.ok(box.centerX >= 0 && box.centerY >= 0 && box.centerX < box.viewportWidth && box.centerY < box.viewportHeight,
      `目标中心点在视口外：${JSON.stringify(box)}`)
    assert.equal(box.centerHit, true, `点击中心被其他元素遮挡：${JSON.stringify(box)}`)
    const point = { x: box.centerX, y: box.centerY }
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }, browser.sessionId)
  }
  const clickSelector = selector => clickExpression(`document.querySelector(${JSON.stringify(selector)})`)
  const clickText = (selector, text) => clickExpression(`([...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)} && !el.disabled))`)
  const replaceInput = async (selector, value) => {
    await clickSelector(selector)
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.select()`)
    await browser.send('Input.insertText', { text: value }, browser.sessionId)
    await browser.wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
  }
  const sessionId = () => browser.evaluate(`document.querySelector('.look2').dataset.qxsimSessionId`)
  const snapshot = async () => {
    const id = await sessionId()
    const response = await fetch(app.url + '/editor/api/get', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id }),
      signal: AbortSignal.timeout(5_000),
    })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const findTarget = state => state.root.children[0].children.find(node => node.id === target.id)
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await snapshot()
      if (predicate(state)) return state
      await delay(50)
    }
    assert.fail(`${label}: ${JSON.stringify(await snapshot())}`)
  }

  await clickSelector('.look2-top button[title="新建工程"]')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已新建工程')`)
  await browser.wait(`document.querySelector('.look2-project-copy small')?.title.endsWith('look2.0.1.save.json')`)
  assert.match(await browser.evaluate(`document.querySelector('.look2-project-copy small')?.title || ''`), /look2\.0\.1\.save\.json$/)
  assert.equal(existsSync(savedPath), false, '新建工程只分配存档路径，不应提前创建磁盘存档')

  await browser.send('Page.setInterceptFileChooserDialog', { enabled: true }, browser.sessionId)
  let unsubscribeChooser
  let chooserTimeout
  const chooserOpened = new Promise((resolve, reject) => {
    unsubscribeChooser = browser.onEvent(message => {
      if (message.method === 'Page.fileChooserOpened') resolve(message)
    })
    chooserTimeout = setTimeout(() => reject(new Error('工具栏导入未在 10 秒内打开文件选择器')), 10_000)
  })
  try {
    await clickSelector('.look2-top select[title="导入文件"]')
    await browser.key('ArrowDown', 'ArrowDown')
    await browser.key('Enter', 'Enter')
    const chooser = await chooserOpened
    assert.equal(chooser.sessionId, browser.sessionId, '文件选择器事件必须来自当前编辑页会话')
    assert.equal(chooser.params?.mode, 'selectSingle', `导入 JSON 应打开单文件选择器：${JSON.stringify(chooser)}`)
    assert.ok(Number.isInteger(chooser.params?.backendNodeId) && chooser.params.backendNodeId > 0,
      `文件选择器事件必须提供 backendNodeId：${JSON.stringify(chooser)}`)
    await browser.send('DOM.setFileInputFiles', { backendNodeId: chooser.params.backendNodeId, files: [sourcePath] }, browser.sessionId)
    await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已导入 toolbar-source.json')`)
  } finally {
    clearTimeout(chooserTimeout)
    unsubscribeChooser?.()
  }
  let state = await waitFor(value => !!findTarget(value), '导入的合成 JSON 控件应进入当前工程')
  assert.equal(findTarget(state).name, '工具栏指针编辑目标')
  assert.equal(state.asset.type, 'server-control-template')
  assert.equal(readFileSync(sourcePath, 'utf8'), `${JSON.stringify(archive, null, 2)}\n`, '导入不能改写合成源文件')

  await clickSelector('.look2-box.textbox')
  await waitFor(value => value.selectedId === target.id, '指针应选中待编辑文本控件')
  const initialTransform = structuredClone(findTarget(await snapshot()).transformByPlatform)
  const controlBox = await browser.evaluate(`document.querySelector('.look2-box.textbox')?.getBoundingClientRect().toJSON()`)
  assert.ok(controlBox?.width > 0 && controlBox.height > 0, `画布控件不可见：${JSON.stringify(controlBox)}`)
  const scale = controlBox.width / initialTransform.KEYBOARD.size.x
  assert.ok(Number.isFinite(scale) && scale > 0, `控件缩放不可用：${scale}`)
  const start = { x: controlBox.x + controlBox.width / 2, y: controlBox.y + controlBox.height / 2 }
  assert.equal(await browser.evaluate(`(() => { const el = document.querySelector('.look2-box.textbox'); return el?.contains(document.elementFromPoint(${start.x}, ${start.y})) })()`),
    true, '画布拖动必须从真实文本控件命中点开始')
  const end = { x: start.x + 40 * scale, y: start.y - 24 * scale }
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 }, browser.sessionId)
  const edited = await waitFor(value => findTarget(value).transformByPlatform.KEYBOARD.offset.x > initialTransform.KEYBOARD.offset.x + 30,
    '真实画布拖动应提交 KEYBOARD 平台位置变换')
  const editedTransforms = findTarget(edited).transformByPlatform
  assert.ok(Math.abs(editedTransforms.KEYBOARD.offset.y - initialTransform.KEYBOARD.offset.y - 24) < 1,
    `屏幕向上拖动应增加世界坐标 Y：${JSON.stringify(editedTransforms.KEYBOARD.offset)}`)
  for (const platform of ['TOUCHSCREEN', 'CONTROLLER_CONSOLE', 'CONTROLLER_MOBILE']) {
    assert.deepEqual(editedTransforms[platform], initialTransform[platform], `关闭同步时不能改动 ${platform} 平台`)
  }
  await browser.wait(`document.querySelector('button[aria-label="撤销"]') && !document.querySelector('button[aria-label="撤销"]').disabled`)
  await clickSelector('button[aria-label="撤销"]')
  const undone = await waitFor(value => Math.abs(findTarget(value).transformByPlatform.KEYBOARD.offset.x - initialTransform.KEYBOARD.offset.x) < .01,
    '撤销应恢复拖动前的平台变换')
  assert.deepEqual(findTarget(undone).transformByPlatform, initialTransform, '撤销必须精确还原四平台变换')
  await browser.wait(`document.querySelector('button[aria-label="重做"]') && !document.querySelector('button[aria-label="重做"]').disabled`)
  await clickSelector('button[aria-label="重做"]')
  const redone = await waitFor(value => Math.abs(findTarget(value).transformByPlatform.KEYBOARD.offset.x - editedTransforms.KEYBOARD.offset.x) < .01,
    '重做应恢复画布拖动后的平台变换')
  assert.deepEqual(findTarget(redone).transformByPlatform, editedTransforms, '重做必须恢复四平台变换')

  const sourceInput = '.qxsim-script-page textarea'
  await clickText('.look2-dock-tabs [role="tab"]', 'Lua')
  await browser.wait(`!!document.querySelector(${JSON.stringify(sourceInput)})`)
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(sourceInput)})?.value`), 'return "toolbar-initial"')
  await replaceInput(sourceInput, 'return "toolbar-submitted"')
  await clickText('.qxsim-script-footer button', '保存脚本')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('Lua 脚本已提交到当前工程')`)

  assert.equal(existsSync(savedPath), false, '画布编辑和 Lua 提交在显式保存前都不应创建磁盘存档')
  await clickSelector('.look2-top button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已保存 look2.0.1.save.json')`)
  assert.ok(existsSync(savedPath), '显式保存必须写入当前工程存档')
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
  assert.equal(saved.assets.scripts.find(script => script.path === 'lua/toolbar.lua')?.source, 'return "toolbar-submitted"')
  assert.deepEqual(saved.assets.server.root.children[0].children.find(node => node.id === target.id).transformByPlatform, editedTransforms)

  const exportOptions = await browser.evaluate(`([...document.querySelector('.look2-top select[title="导出文件"]').options]).map(option => ({ value: option.value, text: option.textContent.trim(), disabled: option.disabled }))`)
  const fullArchiveOption = exportOptions.find(option => option.value === 'save' && option.text === '完整存档')
  assert.ok(fullArchiveOption, `完整存档导出入口不存在：${JSON.stringify(exportOptions)}`)
  await clickSelector('.look2-top select[title="导出文件"]')
  for (let index = 0; index < exportOptions.findIndex(option => option.value === 'save'); index++) await browser.key('ArrowDown', 'ArrowDown')
  await browser.key('Enter', 'Enter')
  const exportedName = '工具栏跨入口验收 · 资产包.json'
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes(${JSON.stringify(`已导出 ${exportedName}`)})`)
  let exportedPath
  for (let attempt = 0; attempt < 100 && !exportedPath; attempt++) {
    if (readdirSync(directory).includes(exportedName)) exportedPath = join(directory, exportedName)
    else await delay(100)
  }
  assert.ok(exportedPath, `完整存档没有下载；目录内容：${JSON.stringify(readdirSync(directory))}`)
  const exported = JSON.parse(readFileSync(exportedPath, 'utf8'))
  assert.equal(exported.assets.scripts.find(script => script.path === 'lua/toolbar.lua')?.source, 'return "toolbar-submitted"')
  assert.deepEqual(exported.assets.server.root.children[0].children.find(node => node.id === target.id).transformByPlatform, editedTransforms)

  await replaceInput(sourceInput, 'return "uncommitted-before-reopen"')
  await clickSelector('.look2-top button[title="工作区存档"]')
  await browser.wait(`!!document.querySelector('.look2-workspace [aria-label="工作区存档列表"]')`)
  const archiveSelector = '.look2-workspace [aria-label="工作区存档列表"]'
  const options = await browser.evaluate(`([...document.querySelector(${JSON.stringify(archiveSelector)}).options]).map(option => ({ value: option.value, text: option.textContent.trim() }))`)
  const archiveOptionIndex = options.findIndex(option => option.value === 'look2.0.1.save.json')
  assert.ok(archiveOptionIndex > 0, `保存后的存档必须显示在工作区列表：${JSON.stringify(options)}`)
  await clickSelector(archiveSelector)
  for (let index = 0; index < archiveOptionIndex; index++) await browser.key('ArrowDown', 'ArrowDown')
  await browser.key('Enter', 'Enter')
  await browser.wait(`document.querySelector(${JSON.stringify(archiveSelector)})?.value === 'look2.0.1.save.json'`)
  await clickText('.look2-workspace button', '打开')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已加载 look2.0.1.save.json')`)
  await clickText('.look2-dock-tabs [role="tab"]', 'Lua')
  await browser.wait(`document.querySelector(${JSON.stringify(sourceInput)})?.value === 'return "toolbar-submitted"'`)
  const reopened = JSON.parse(readFileSync(savedPath, 'utf8'))
  assert.equal(reopened.assets.scripts.find(script => script.path === 'lua/toolbar.lua')?.source, 'return "toolbar-submitted"')
  assert.deepEqual(reopened.assets.server.root.children[0].children.find(node => node.id === target.id).transformByPlatform, editedTransforms)
  assert.deepEqual(reopened, saved, '导出和重开不得改写已显式保存的存档')
})
