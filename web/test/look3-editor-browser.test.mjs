import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'
import { createStudio } from '../../studio/index.js'
import { createNode } from '../../studio/ui/authoring.js'
import { startTestBrowser } from './browser-helper.mjs'

test('Look3 active editor fits multiline text and keeps workspace entries reachable at desktop and narrow sizes', {
  skip: !process.env.QXQY_BROWSER, timeout: 60_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-editor-browser-'))
  const archive = createStudio().archiveData()
  const text = createNode('textbox', { name: 'FitLabel', text: 'A\nB', fontSize: 40, adaptiveFontSize: true, minimumFontSize: 10 })
  for (const [index, transform] of Object.values(text.transformByPlatform).entries()) {
    transform.size = { x: 160, y: 40 }
    transform.offset = { x: index * 100, y: 0 }
  }
  archive.assets.server.root.children[0].children = [text]
  const file = join(directory, 'editor.save.json'), original = JSON.stringify(archive)
  writeFileSync(file, original)
  const app = await createWebServer({ workspace: directory, initialPath: 'editor.save.json', port: 0 })
  let browser
  t.after(async () => {
    await browser?.close()
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  browser = await startTestBrowser(directory)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2-box.textbox .look2-stage-text span')`)
  for (const [width, height] of [[1920, 1080], [1280, 720], [390, 844]]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
    await browser.wait(`document.querySelector('.look2').clientWidth === ${width}`)
    const metrics = await browser.evaluate(`(() => {
      const text = document.querySelector('.look2-box.textbox .look2-stage-text'), stage = document.querySelector('.look2-stage');
      const scale = parseFloat(stage.style.width) / 1600;
      return { text: text.textContent, size: parseFloat(text.style.fontSize) / scale,
        stageWidth: stage.getBoundingClientRect().width,
        tabs: [...document.querySelectorAll('[role=tab]')].map(el => ({ name: el.textContent, box: el.getBoundingClientRect().toJSON() })),
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`)
    assert.equal(metrics.text, 'A\nB')
    assert.ok(Math.abs(metrics.size - 13) < 1e-4, JSON.stringify(metrics))
    assert.ok(metrics.stageWidth > 0)
    assert.equal(metrics.overflow, false, JSON.stringify(metrics))
    for (const tab of ['动画', 'Lua', '逻辑', '同步', '调试']) {
      const entry = metrics.tabs.find(row => row.name === tab)
      assert.ok(entry && entry.box.width > 0 && entry.box.x >= 0 && entry.box.right <= width, JSON.stringify({ width, tab, metrics }))
    }
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  let initialCenter
  for (const [index, platform] of ['键鼠', '触屏', '主机手柄', '手机手柄'].entries()) {
    await browser.evaluate(`document.querySelector('button[aria-label="${platform}"]').click()`)
    await browser.wait(`document.querySelector('button[aria-label="${platform}"]').classList.contains('selected')`)
    const location = await browser.evaluate(`(() => {
      const box = document.querySelector('.look2-box.textbox').getBoundingClientRect(), stage = document.querySelector('.look2-stage').getBoundingClientRect();
      return { center: box.x + box.width / 2, scale: (stage.width - 2) / 1600, stageWidth: stage.width };
    })()`)
    initialCenter ??= location.center
    assert.ok(Math.abs(location.center - initialCenter - index * 100 * location.scale) < 0.1, JSON.stringify({ platform, location, initialCenter }))
  }
  await browser.evaluate(`document.querySelector('[role=tab][aria-selected=false]').click()`)
  assert.equal(readFileSync(file, 'utf8'), original, 'view changes do not implicitly save the user archive')
})
