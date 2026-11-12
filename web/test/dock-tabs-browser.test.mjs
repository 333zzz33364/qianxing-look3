import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('timeline hint never sits under the dock tabs', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-dock-tabs-'))
  const app = await createWebServer({ workspace: directory, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close().catch(() => {})
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory, ['--disable-gpu', '--disable-features=Vulkan,UseSkiaRenderer,WebGPU'])
  await browser.navigate(`${app.url}/editor`)
  await browser.wait(`!!document.querySelector('.look2-timeline-hint')`)

  const measure = () => browser.evaluate(`(() => {
    const hintEl = document.querySelector('.look2-timeline-hint')
    const hint = hintEl.getBoundingClientRect()
    const tabs = document.querySelector('.look2-dock-tabs').getBoundingClientRect()
    return {
      hintRight: hint.right, hintWidth: hint.width, hintDisplay: getComputedStyle(hintEl).display,
      tabsLeft: tabs.left, tabsRight: tabs.right, viewport: innerWidth,
    }
  })()`)

  for (const width of [1280, 960, 720]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
    await new Promise(resolve => setTimeout(resolve, 250))
    const box = await measure()
    if (width === 1280) {
      assert.equal(box.hintDisplay, 'block', '宽屏时应显示提示文字')
      assert.ok(box.hintWidth > 10, `1280px：提示文字应可见（实际 ${box.hintWidth}）`)
    }
    if (box.hintDisplay !== 'none') {
      assert.ok(box.hintRight <= box.tabsLeft + 1, `${width}px：提示右缘 ${box.hintRight} 不应压到页签左缘 ${box.tabsLeft}`)
    }
    assert.ok(box.tabsRight <= box.viewport + 1, `${width}px：页签不应超出视口`)
  }
})
