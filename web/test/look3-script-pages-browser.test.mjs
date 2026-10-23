import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWebServer } from '../server.js'
import { createStudio } from '../../studio/index.js'
import { startTestBrowser } from './browser-helper.mjs'

function pageActions(browser) {
  const clickElement = async expression => {
    const box = await browser.evaluate(`(async () => {
      const el = ${expression}
      if (!el || el.disabled) return null
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const rect = el.getBoundingClientRect()
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
      const hit = document.elementFromPoint(x, y)
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        centerX: x, centerY: y, viewportWidth: innerWidth, viewportHeight: innerHeight,
        centerHit: !!hit && (hit === el || el.contains(hit)), hitTag: hit?.tagName, hitClass: hit?.className,
      }
    })()`)
    assert.ok(box && box.width > 0 && box.height > 0, `不可点击目标：${JSON.stringify(box)}`)
    assert.ok(box.centerX >= 0 && box.centerY >= 0 && box.centerX < box.viewportWidth && box.centerY < box.viewportHeight,
      `目标中心点在视口外：${JSON.stringify(box)}`)
    assert.equal(box.centerHit, true, `点击中心被其他元素遮挡：${JSON.stringify(box)}`)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, browser.sessionId)
  }
  const clickSelector = selector => clickElement(`document.querySelector(${JSON.stringify(selector)})`)
  const clickText = async (selector, text) => {
    await clickElement(`([...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.textContent.trim() === ${JSON.stringify(text)} && !item.disabled))`)
  }
  const replaceInput = async (selector, value) => {
    await clickSelector(selector)
    const focus = await browser.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        active: document.activeElement === el, disabled: el.disabled,
        fieldsetDisabled: el.closest('fieldset')?.disabled || false,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        target: target?.tagName, targetClass: target?.className,
      }
    })()`)
    assert.equal(focus?.active, true, `输入框未获得焦点：${selector} ${JSON.stringify(focus)}`)
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.select()`)
    await browser.send('Input.insertText', { text: value }, browser.sessionId)
    await browser.wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
  }
  const switchTab = async (label, activeSelector) => {
    await clickText('.look2-dock-tabs [role="tab"]', label)
    await browser.wait(`document.querySelector('.look2-dock-tabs [role="tab"][aria-selected="true"]')?.textContent.trim() === ${JSON.stringify(label)} && !!document.querySelector(${JSON.stringify(activeSelector)})`)
  }

  return { clickSelector, clickText, replaceInput, switchTab }
}

test('Look3 Lua and server-logic pages edit, explicitly save, export, and reopen an archive', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-script-pages-browser-'))
  const fileName = 'script-logic.save.json'
  const file = join(directory, fileName)
  const archive = createStudio().archiveData()
  archive.meta.name = 'Look3脚本逻辑验收'
  archive.assets.scripts = [{
    id: 'script-main', guid: 101, path: 'lua/main.lua', source: 'return "initial"', controlId: '', controlAsset: '',
  }]
  archive.serverLogic = {
    version: 1,
    rules: [{
      id: 'rule-score', signalName: 'InitialSignal',
      actions: [{ kind: 'setCustomVariable', entityType: 'Level', name: 'Score', value: 1 }],
    }],
  }
  writeFileSync(file, `${JSON.stringify(archive, null, 2)}\n`)
  const app = await createWebServer({ workspace: directory, initialPath: fileName, port: 0 })
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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1600, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2-dock-tabs [role="tab"]') && !!document.querySelector('.look2-top button[title="保存当前存档"]')`)

  const { clickSelector, clickText, replaceInput, switchTab } = pageActions(browser)

  await switchTab('Lua', '.qxsim-script-page textarea')
  await clickSelector('.look2-dock-tabs button[aria-label="面板全屏"]')
  await browser.wait(`document.fullscreenElement?.classList.contains('look2-dock') && (() => {
    const rect = document.querySelector('.qxsim-script-page textarea')?.getBoundingClientRect()
    return !!rect && rect.top >= 0 && rect.bottom <= innerHeight
  })()`)
  const sourceInput = '.qxsim-script-page textarea'
  const initialSource = await browser.evaluate(`document.querySelector(${JSON.stringify(sourceInput)})?.value`)
  assert.equal(initialSource, 'return "initial"', 'Lua 页应加载合成存档中的脚本')
  await replaceInput(sourceInput, 'return "saved-v1"')
  await browser.wait(`document.querySelector('.qxsim-script-footer')?.textContent.includes('有未保存的修改')`)

  await switchTab('逻辑', '.qxsim-server-logic')
  const signalInput = '[aria-label="规则 1 监听信号名"]'
  await replaceInput(signalInput, 'Awarded')
  await browser.wait(`!document.querySelector('.qxsim-server-logic button')?.disabled`)
  await switchTab('Lua', '.qxsim-script-page textarea')
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(sourceInput)})?.value`), 'return "saved-v1"', '切换工作区页后 Lua 草稿应保留')
  await clickText('.qxsim-script-footer button', '保存脚本')
  await browser.wait(`[...document.querySelectorAll('.qxsim-script-footer button')].find(button => button.textContent.trim() === '保存脚本')?.disabled && document.querySelector('[role="status"]')?.textContent.includes('Lua 脚本已提交到当前工程')`)

  await switchTab('逻辑', '.qxsim-server-logic')
  await clickText('.qxsim-logic-title button', '保存服务端逻辑')
  await browser.wait(`document.querySelector('.qxsim-logic-title button')?.disabled && document.querySelector('[role="status"]')?.textContent.includes('服务端逻辑已提交到当前工程')`)

  await switchTab('Lua', '.qxsim-script-page textarea')
  await clickText('.qxsim-script-footer button', '⇩ 脚本包 JSON')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已导出')`)
  let bundlePath
  for (let attempt = 0; attempt < 100 && !bundlePath; attempt++) {
    const downloaded = readdirSync(directory).find(name => name.endsWith(' · 脚本.json'))
    if (downloaded && !downloaded.endsWith('.crdownload')) bundlePath = join(directory, downloaded)
    else await delay(100)
  }
  assert.ok(bundlePath, `脚本包 JSON 未下载；目录内容：${JSON.stringify(readdirSync(directory))}`)
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
  assert.equal(bundle.scripts.find(script => script.path === 'lua/main.lua')?.source, 'return "saved-v1"', '脚本包应包含编辑后的 Lua 源码')

  await clickSelector('.look2-dock-tabs button[aria-label="退出面板全屏"]')
  await browser.wait(`!document.fullscreenElement`)
  await clickSelector('.look2-top button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已保存 ${fileName}')`)
  const savedArchive = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(savedArchive.assets.scripts.find(script => script.path === 'lua/main.lua')?.source, 'return "saved-v1"')
  assert.equal(savedArchive.serverLogic.rules[0].signalName, 'Awarded')

  await clickSelector('.look2-dock-tabs button[aria-label="面板全屏"]')
  await browser.wait(`document.fullscreenElement?.classList.contains('look2-dock')`)
  await replaceInput(sourceInput, 'return "unsaved-v2"')
  await switchTab('逻辑', '.qxsim-server-logic')
  await replaceInput(signalInput, 'UnsavedSignal')
  await clickSelector('.look2-dock-tabs button[aria-label="退出面板全屏"]')
  await browser.wait(`!document.fullscreenElement`)
  await clickSelector('.look2-top button[title="工作区存档"]')
  await browser.wait(`!!document.querySelector('.look2-workspace [aria-label="工作区存档列表"]')`)
  const archiveSelect = '.look2-workspace [aria-label="工作区存档列表"]'
  await browser.wait(`([...document.querySelector(${JSON.stringify(archiveSelect)}).options]).some(option => option.value === ${JSON.stringify(fileName)})`)
  await clickSelector(archiveSelect)
  await browser.key('ArrowDown', 'ArrowDown')
  await browser.key('Enter', 'Enter')
  await browser.wait(`document.querySelector(${JSON.stringify(archiveSelect)})?.value === ${JSON.stringify(fileName)}`)
  await clickText('.look2-workspace button', '打开')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已加载 ${fileName}')`)
  await browser.wait(`document.querySelector(${JSON.stringify(signalInput)})?.value === 'Awarded'`)
  await switchTab('Lua', '.qxsim-script-page textarea')
  await browser.wait(`document.querySelector(${JSON.stringify(sourceInput)})?.value === 'return "saved-v1"'`)
  const reopenedArchive = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(reopenedArchive.assets.scripts.find(script => script.path === 'lua/main.lua')?.source, 'return "saved-v1"')
  assert.equal(reopenedArchive.serverLogic.rules[0].signalName, 'Awarded')
})

for (const [width, height] of [[1280, 720], [1920, 1080], [390, 844]]) {
  test(`Look3 compact Lua and logic dock saves through visible controls and survives host/browser restart at ${width}x${height}`, {
    skip: !process.env.QXQY_BROWSER, timeout: 90_000,
  }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'look3-compact-script-browser-'))
    const fileName = 'compact.save.json'
    const file = join(directory, fileName)
    const archive = createStudio().archiveData()
    archive.assets.scripts = [{ id: 'script-compact', guid: 103, path: 'lua/compact.lua', source: 'return "original"', controlId: '', controlAsset: '' }]
    archive.serverLogic = { version: 1, rules: [{ id: 'compact-rule', signalName: 'Before', actions: [{ kind: 'setCustomVariable', entityType: 'Level', name: 'Score', value: 1 }] }] }
    writeFileSync(file, JSON.stringify(archive))
    let app, browser
    t.after(async () => {
      try { await browser?.close() }
      finally {
        try { await app?.close() }
        finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
      }
    })
    const open = async () => {
      app = await createWebServer({ workspace: directory, initialPath: fileName, port: 0 })
      browser = await startTestBrowser(directory)
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
      await browser.navigate(`${app.url}/editor`)
      await browser.wait(`!!document.querySelector('.look2-dock-tabs [role="tab"]') && !!document.querySelector('.look2-top button[title="保存当前存档"]')`)
      return pageActions(browser)
    }
    const screenshot = async phase => {
      if (!process.env.QXQY_TEST_EVIDENCE_DIR) return
      mkdirSync(process.env.QXQY_TEST_EVIDENCE_DIR, { recursive: true })
      const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, browser.sessionId)
      writeFileSync(join(process.env.QXQY_TEST_EVIDENCE_DIR, `compact-${width}x${height}-${phase}.png`), Buffer.from(shot.data, 'base64'))
    }
    const sourceInput = '.qxsim-script-page textarea'
    const signalInput = '[aria-label="规则 1 监听信号名"]'
    const source = `return "compact-${width}"`
    const signal = `Saved${width}`
    let actions = await open()
    await actions.switchTab('Lua', sourceInput)
    assert.equal(await browser.evaluate('!!document.fullscreenElement'), false)
    await screenshot('lua-before')
    await actions.replaceInput(sourceInput, source)
    await actions.clickText('.qxsim-script-footer button', '保存脚本')
    await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('Lua 脚本已提交到当前工程')`)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).assets.scripts[0].source, 'return "original"', '提交脚本不应提前改写磁盘存档')
    await screenshot('lua-saved')
    await actions.switchTab('逻辑', '.qxsim-server-logic')
    await actions.replaceInput(signalInput, signal)
    await actions.clickText('.qxsim-logic-title button', '保存服务端逻辑')
    await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('服务端逻辑已提交到当前工程')`)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).serverLogic.rules[0].signalName, 'Before', '提交逻辑不应提前改写磁盘存档')
    await screenshot('logic-saved')
    await actions.clickSelector('.look2-top button[title="保存当前存档"]')
    await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已保存 ${fileName}')`)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.assets.scripts[0].source, source)
    assert.equal(saved.serverLogic.rules[0].signalName, signal)
    // Discard uncommitted drafts by terminating both real hosts, rather than
    // reopening an archive in the same React tree or retaining worker memory.
    await actions.switchTab('Lua', sourceInput)
    await actions.replaceInput(sourceInput, 'return "discard-after-restart"')
    await actions.switchTab('逻辑', '.qxsim-server-logic')
    await actions.replaceInput(signalInput, 'DiscardAfterRestart')
    const firstBrowser = browser, firstApp = app
    await firstBrowser.close()
    browser = undefined
    await firstApp.close()
    app = undefined
    actions = await open()
    assert.notEqual(browser, firstBrowser, '应启动新的浏览器进程')
    assert.notEqual(app, firstApp, '应启动新的Web服务及Worker')
    await actions.switchTab('Lua', sourceInput)
    await browser.wait(`document.querySelector(${JSON.stringify(sourceInput)})?.value === ${JSON.stringify(source)}`)
    await actions.switchTab('逻辑', '.qxsim-server-logic')
    await browser.wait(`document.querySelector(${JSON.stringify(signalInput)})?.value === ${JSON.stringify(signal)}`)
    assert.equal(await browser.evaluate('!!document.fullscreenElement'), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved, '重启和读取不应改写已保存的存档')
    console.log(`Compact dock verified: ${width}x${height}, real pointer edits, explicit disk save, fresh browser and service`)
  })
}
