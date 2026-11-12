import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('signal parameter rows can be added, typed and removed in the debug panel', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-signal-params-'))
  const app = await createWebServer({ workspace: directory, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close().catch(() => {})
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory, ['--disable-gpu', '--disable-features=Vulkan,UseSkiaRenderer,WebGPU'])
  await browser.navigate(`${app.url}/editor`)
  await browser.wait(`!!document.querySelector('[role="tab"]')`)
  await browser.evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(row => row.textContent.trim() === '调试')
    if (!tab) throw new Error('缺少调试页签')
    tab.click()
  })()`)
  await browser.wait(`!!document.querySelector('button[aria-label="添加信号参数"]')`)

  const addRow = () => browser.evaluate(`document.querySelector('button[aria-label="添加信号参数"]').click()`)
  await addRow()
  await addRow()
  await browser.wait(`document.querySelectorAll('select[aria-label^="参数 "]').length === 2`)
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="参数 1 类型"]').value`), 'Int',
    '新参数默认是整数')
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="参数 1 类型"]').selectedOptions[0].textContent`), '整数（Int）',
    '参数类型应显示中文并保留枚举值')
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="参数 1 值"]').type`), 'text')
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="信号目标"]').selectedOptions[0].textContent`), '当前玩家（PlayerSelf）')
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="变量实体"]').selectedOptions[0].textContent`), '当前玩家（PlayerSelf）')

  const setSelect = (label, value) => browser.evaluate(`(() => {
    const select = document.querySelector('[aria-label=${JSON.stringify(label)}]')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await setSelect('参数 1 类型', 'String')
  await browser.wait(`document.querySelector('[aria-label="参数 1 值"]').placeholder === '文本'`)
  await setSelect('参数 2 类型', 'Bool')
  await browser.wait(`document.querySelector('[aria-label="参数 2 值"]').type === 'checkbox'`)
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="参数 2 值"]').checked`), true,
    '布尔参数默认勾选')

  await browser.evaluate(`document.querySelector('button[aria-label="移除参数 1"]').click()`)
  await browser.wait(`document.querySelectorAll('select[aria-label^="参数 "]').length === 1`)
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="参数 1 类型"]').value`), 'Bool',
    '移除后剩下的应是原来的第二个参数')
})
