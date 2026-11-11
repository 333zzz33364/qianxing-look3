import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('the mask coverage switch round-trips through the host and survives a reload', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-render-settings-browser-'))
  const configPath = join(directory, 'render.json')
  const previous = process.env.QXQY_RENDER_CONFIG_PATH
  process.env.QXQY_RENDER_CONFIG_PATH = configPath
  const app = await createWebServer({ workspace: directory, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close().catch(() => {})
    await app.close()
    if (previous === undefined) delete process.env.QXQY_RENDER_CONFIG_PATH
    else process.env.QXQY_RENDER_CONFIG_PATH = previous
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory, ['--disable-gpu', '--disable-features=Vulkan,UseSkiaRenderer,WebGPU'])
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(`${app.url}/editor`)
  await browser.wait(`!!document.querySelector('button[title="工作区存档"]')`)

  await browser.evaluate(`document.querySelector('button[title="工作区存档"]').click()`)
  await browser.wait(`!!document.querySelector('select[aria-label="遮罩覆盖规则"]')`)
  assert.equal(await browser.evaluate(`document.querySelector('select[aria-label="遮罩覆盖规则"]').value`), 'geometry',
    '本机没有配置时编辑器应显示几何矩形')

  await browser.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="遮罩覆盖规则"]')
    select.value = 'contour'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  let saved = null
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = JSON.parse(readFileSync(configPath, 'utf8'))
      if (value.maskContour === 'contour') { saved = value; break }
    } catch { /* the host writes atomically; retry until it lands */ }
    await delay(50)
  }
  assert.deepEqual(saved, { maskContour: 'contour' }, '下拉变更应写入宿主 render.json')

  await browser.navigate(`${app.url}/editor`)
  await browser.wait(`!!document.querySelector('button[title="工作区存档"]')`)
  await browser.evaluate(`document.querySelector('button[title="工作区存档"]').click()`)
  await browser.wait(`!!document.querySelector('select[aria-label="遮罩覆盖规则"]')`)
  assert.equal(await browser.evaluate(`document.querySelector('select[aria-label="遮罩覆盖规则"]').value`), 'contour',
    '刷新后应读到保存的透明轮廓规则')
})
