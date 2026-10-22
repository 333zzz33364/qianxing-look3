import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStudio } from '../../studio/index.js'
import { createDefaultClientTemplateProject, createNode } from '../../studio/ui/authoring.js'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('active template UI imports four-platform GIA, renames, reindexes, instantiates and explicitly saves/reopens', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-template-browser-'))
  const path = 'templates.save.json'
  const file = join(directory, path)
  const source = createDefaultClientTemplateProject()
  const platforms = ['KEYBOARD', 'TOUCHSCREEN', 'CONTROLLER_CONSOLE', 'CONTROLLER_MOBILE']
  const title = source.root.children[0].children.find(node => node.kind === 'textbox')
  assert.ok(title)
  for (const [index, platform] of platforms.entries()) title.transformByPlatform[platform].offset.x = 37 + index * 23
  const gia = createStudio(source).exportData('gia', 'client-control-template')
  const giaPath = join(directory, '四平台模板.gia')
  writeFileSync(giaPath, Buffer.from(gia.data, 'base64'))
  const initial = createStudio(createDefaultClientTemplateProject()).archiveData()
  initial.assets.client.root.children[0].children.push(createNode('reference', {
    id: 'missing-template-reference', name: '缺失模板引用', referencedPrefabId: '9876543',
  }))
  writeFileSync(file, JSON.stringify(initial))
  const app = await createWebServer({ workspace: directory, initialPath: path, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close()
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  browser = await startTestBrowser(directory)
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2-top')`)
  const click = async selector => {
    const box = await browser.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null; return e.getBoundingClientRect().toJSON() })()`)
    assert.ok(box?.width > 0 && box?.height > 0, selector)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }, browser.sessionId)
    }
  }
  const button = async (text, scope = '.look2') => {
    const selector = await browser.evaluate(`(() => { const e = [...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!e) return null; e.setAttribute('data-template-test-target', 'true'); return '[data-template-test-target="true"]' })()`)
    assert.ok(selector, `Missing button ${text}`)
    await click(selector)
    await browser.evaluate(`document.querySelector('[data-template-test-target]')?.removeAttribute('data-template-test-target')`)
  }
  const replace = async (selector, text) => {
    await click(selector)
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`)
    await browser.send('Input.insertText', { text }, browser.sessionId)
    await browser.key('Tab', 'Tab')
  }
  await button('客户端模板')
  const sessionId = await browser.evaluate(`document.querySelector('.look2').dataset.qxsimSessionId`)
  const snapshot = async () => {
    const response = await fetch(app.url + '/editor/api/get', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const waitFor = async (predicate, description) => {
    for (let attempt = 0; attempt < 140; attempt++) {
      const value = await snapshot()
      if (predicate(value)) return value
      await delay(50)
    }
    assert.fail(description + ': ' + JSON.stringify(await snapshot()))
  }
  await waitFor(s => s.asset.type === 'client-control-template', 'client asset switch')
  await click('button[title="控件模板"]')
  await browser.wait(`!!document.querySelector('[role="dialog"][aria-label="控件模板"]')`)
  await browser.wait(`document.querySelector('[role="dialog"][aria-label="控件模板"] [role="alert"]')?.textContent.includes('9876543')`)
  await browser.send('Page.setInterceptFileChooserDialog', { enabled: true }, browser.sessionId)
  await button('导入 GIA', '[role="dialog"][aria-label="控件模板"]')
  const { root } = await browser.send('DOM.getDocument', {}, browser.sessionId)
  const { nodeId } = await browser.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"][accept=".gia"]' }, browser.sessionId)
  assert.ok(nodeId)
  await browser.send('DOM.setFileInputFiles', { nodeId, files: [giaPath] }, browser.sessionId)
  let state = await waitFor(s => s.look2.controlTemplates.length === 1, 'GIA import')
  const imported = state.look2.controlTemplates[0]
  const importedTitle = imported.project.root.children[0].children.find(n => n.kind === 'textbox')
  assert.deepEqual(platforms.map(p => importedTitle.transformByPlatform[p].offset.x), [37, 60, 83, 106])
  await replace('.look2-template-row input[type="text"]', '已重命名四平台')
  await waitFor(s => s.look2.controlTemplates[0].name === '已重命名四平台', 'template rename')
  await replace('.look2-template-row input[type="number"]', '2088')
  await waitFor(s => s.look2.controlTemplates[0].index === 2088, 'template index')
  const count = (await snapshot()).tree.length
  const parentId = (await snapshot()).selectedId
  await click('.look2-template-row button[title="实例化到所选容器"]')
  state = await waitFor(s => s.tree.length > count, 'instantiate from modal')
  const instance = state.tree.find(n => n.name === '已重命名四平台')
  assert.ok(instance)
  assert.equal(instance.parentId, parentId, 'template must instantiate into the selected container')
  await browser.wait(`!document.querySelector('[role="dialog"][aria-label="控件模板"]')`)
  await click('button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已保存 ${path}')`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.look2.controlTemplates[0].name, '已重命名四平台')
  assert.equal(saved.look2.controlTemplates[0].index, 2088)
  await click('button[title="控件模板"]')
  await replace('.look2-template-row input[type="text"]', '未保存的模板名')
  await waitFor(s => s.look2.controlTemplates[0].name === '未保存的模板名', 'unsaved edit')
  await button('关闭', '[role="dialog"][aria-label="控件模板"]')
  await click('button[title="工作区存档"]')
  await browser.wait(`!!document.querySelector('[aria-label="工作区存档列表"] option[value="${path}"]')`)
  await click('[aria-label="工作区存档列表"]')
  await browser.key('Home', 'Home')
  await browser.key('ArrowDown', 'ArrowDown')
  await browser.key('Enter', 'Enter')
  await browser.wait(`document.querySelector('[aria-label="工作区存档列表"]')?.value === '${path}'`)
  await button('打开', '.look2-workspace')
  state = await waitFor(s => s.look2.controlTemplates[0]?.name === '已重命名四平台', 'explicit reopen must discard template draft')
  const restored = state.look2.controlTemplates[0]
  assert.equal(restored.index, 2088)
  const restoredTitle = restored.project.root.children[0].children.find(n => n.kind === 'textbox')
  assert.deepEqual(platforms.map(p => restoredTitle.transformByPlatform[p].offset.x), [37, 60, 83, 106])
  assert.equal(state.tree.find(n => n.id === instance.id)?.parentId, parentId, 'saved instance parent must survive reopen')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved, 'reopen must not rewrite saved file')
})
