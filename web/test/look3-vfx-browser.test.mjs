import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWebServer } from '../server.js'
import { createStudio } from '../../studio/index.js'
import { createNode } from '../../studio/ui/authoring.js'
import { startTestBrowser } from './browser-helper.mjs'

const BASE = 'https://oss.xiaomol444.xyz/ugc-tool-data/Public/UIVfx'
const catalog = {
  data: [
    { id: 101, path: 'icon/101.png', width: 120, height: 60, scope: 'ui', category: 1, tagList: [11], isLoop: true, nameI18nKey: 'vfx.101' },
    { id: 102, path: 'icon/102.png', width: 60, height: 120, scope: 'ui', category: 2, tagList: [12], isLoop: false, nameI18nKey: 'vfx.102' },
    { id: 201, path: 'icon/201.png', width: 200, height: 200, scope: 'screen', category: 3, tagList: [11], isLoop: false, nameI18nKey: 'vfx.201' },
  ],
  tags: [{ id: 11, nameI18nKey: 'tag.11' }, { id: 12, nameI18nKey: 'tag.12' }],
  category: [
    { id: 1, nameI18nKey: 'cat.1', scope: 'ui' },
    { id: 2, nameI18nKey: 'cat.2', scope: 'ui' },
    { id: 3, nameI18nKey: 'cat.3', scope: 'screen' },
  ],
}
const labels = {
  'vfx.101': '素材甲', 'vfx.102': '素材乙', 'vfx.201': '全屏丙',
  'tag.11': '火焰', 'tag.12': '水', 'cat.1': '战斗', 'cat.2': '环境', 'cat.3': '全屏',
}

// 浏览器测试不访问外网：目录请求在页面脚本执行前换成固定数据。
const stubSource = `(() => {
  const base = ${JSON.stringify(BASE)};
  const catalog = ${JSON.stringify(catalog)};
  const labels = ${JSON.stringify(labels)};
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url === base + '/data.json') return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith(base + '/i18n/')) return new Response(JSON.stringify(labels), { status: 200, headers: { 'content-type': 'application/json' } });
    return original(input, init);
  };
})();`

test('Look3 界面动效素材库在真实浏览器里筛选、选择并写回控件', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-vfx-browser-'))
  const screenshotDirectory = process.env.QXQY_TEST_EVIDENCE_DIR
    ? resolve(process.env.QXQY_TEST_EVIDENCE_DIR) : join(directory, 'screenshots')
  const archive = createStudio().archiveData()
  archive.assets.server.root.children[0].children = [createNode('animation', { name: '动效控件', animationId: '' })]
  const savePath = join(directory, 'vfx.save.json'), original = JSON.stringify(archive)
  writeFileSync(savePath, original)

  const app = await createWebServer({ workspace: directory, initialPath: 'vfx.save.json', port: 0 })
  let browser
  t.after(async () => {
    try { await browser?.close() }
    finally {
      try { await app.close() }
      finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    }
  })

  browser = await startTestBrowser(directory)
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: stubSource }, browser.sessionId)
  await browser.navigate(`${app.url}/editor`)
  await browser.wait(`!!document.querySelector('button.tree-name[title*="动效控件"]')`)
  await browser.evaluate(`document.querySelector('button.tree-name[title*="动效控件"]').click()`)
  await browser.wait(`!!document.querySelector('.qxsim-vfx-field')`)

  const initial = await browser.evaluate(`({
    text: document.querySelector('.qxsim-vfx-field').innerText,
    dialog: !!document.querySelector('[role="dialog"][aria-label="界面动效素材库"]'),
  })`)
  assert.equal(initial.dialog, false)
  assert.match(initial.text, /未选择动效/)
  assert.match(initial.text, /作用域：界面/)

  await browser.evaluate(`document.querySelector('.qxsim-vfx-field button[type="button"]').click()`)
  await browser.wait(`!!document.querySelector('[role="dialog"][aria-label="界面动效素材库"]')`)
  await browser.wait(`document.querySelectorAll('[role="dialog"] button[title*="（#"]').length === 2`)

  mkdirSync(screenshotDirectory, { recursive: true })
  const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, browser.sessionId)
  writeFileSync(join(screenshotDirectory, 'look3-ui-vfx-library.png'), Buffer.from(shot.data, 'base64'))

  const cardTitles = await browser.evaluate(`[...document.querySelectorAll('[role="dialog"] button[title*="（#"]')].map(button => button.getAttribute('title'))`)
  assert.equal(cardTitles.length, 2)
  assert.deepEqual(cardTitles.map(title => title.split('（')[0]).sort(), ['素材乙', '素材甲'])

  await browser.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '战斗').click()`)
  await browser.wait(`document.querySelectorAll('[role="dialog"] button[title*="（#"]').length === 1`)
  await browser.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '战斗').click()`)
  await browser.wait(`document.querySelectorAll('[role="dialog"] button[title*="（#"]').length === 2`)

  await browser.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input[aria-label="搜索界面动效"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '素材乙');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await browser.wait(`document.querySelectorAll('[role="dialog"] button[title*="（#"]').length === 1`)

  await browser.evaluate(`document.querySelector('[role="dialog"] button[title*="素材乙"]').click()`)
  await browser.wait(`!document.querySelector('[role="dialog"]')`)
  const chosen = await browser.evaluate(`document.querySelector('.qxsim-vfx-field').innerText`)
  assert.match(chosen, /素材乙/)
  assert.match(chosen, /#102/)
  assert.match(chosen, /单次 · 60×120/)
  assert.match(chosen, /显示预览|隐藏预览/)

  // 选择只改会话状态，不隐式写盘。
  assert.equal(readFileSync(savePath, 'utf8'), original)
  const state = await browser.evaluate(`(async () => {
    const sessionId = document.querySelector('.qxsim')?.dataset?.qxsimSessionId || document.querySelector('[data-qxsim-session-id]')?.dataset?.qxsimSessionId;
    const response = await fetch('/editor/api/get', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    return response.json();
  })()`)
  assert.equal(state.ok, true)
  assert.ok(JSON.stringify(state.value).includes('102'), '选择结果写入当前会话')
})
