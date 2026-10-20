import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
