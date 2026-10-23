import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'
import { createStudio } from '../../studio/index.js'
import { createDefaultClientTemplateProject } from '../../studio/ui/authoring.js'
import { startTestBrowser } from './browser-helper.mjs'

for (const [width, height] of [[1600, 1000], [390, 844]]) {
test(`Look3 bone creation, length handles, attachment and undo work through real pointer events at ${width}x${height}`, {
  skip: !process.env.QXQY_BROWSER, timeout: 60_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-bones-browser-'))
  const input = JSON.stringify(createStudio(createDefaultClientTemplateProject()).archiveData())
  const file = join(directory, 'bones.save.json')
  writeFileSync(file, input)
  const app = await createWebServer({ workspace: directory, initialPath: 'bones.save.json', port: 0 })
  let browser
  t.after(async () => {
    try { await browser?.close() }
    finally {
      try { await app.close() }
      finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    }
  })
  browser = await startTestBrowser(directory)
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2-top')`)
  const clickElement = async expression => {
    const point = await browser.evaluate(`(async () => {
      const el = ${expression}; if (!el || el.disabled) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: !!hit && (hit === el || el.contains(hit)), width: r.width, height: r.height };
    })()`)
    assert.ok(point?.hit && point.width > 0 && point.height > 0, `真实点击不可达：${expression} ${JSON.stringify(point)}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, browser.sessionId)
  }
  const click = text => clickElement(`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`)
  await click('客户端模板')
  await browser.wait(`!![...document.querySelectorAll('button')].find(el => el.textContent === '创建/附着骨骼')`)
  const sessionId = await browser.evaluate(`document.querySelector('.look2').dataset.qxsimSessionId`)
  const snapshot = async () => {
    const response = await fetch(app.url + '/editor/api/get', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) })
    const envelope = await response.json()
    assert.equal(envelope.ok, true, JSON.stringify(envelope))
    return envelope.value
  }
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await snapshot()
      if (predicate(value)) return value
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    const value = await snapshot()
    assert.fail(JSON.stringify({ version: value.version, tree: value.tree, history: value.history, siteNodes: value.look2.siteNodes }))
  }
  const mouse = params => browser.send('Input.dispatchMouseEvent', params, browser.sessionId)
  const drag = async (start, end, modifiers = 0) => {
    await mouse({ type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1, modifiers })
    await mouse({ type: 'mouseMoved', ...end, button: 'left', buttons: 1, modifiers })
    await mouse({ type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1, modifiers })
  }
  const undo = async () => {
    const version = (await snapshot()).version
    await clickElement(`document.querySelector('button[aria-label="撤销"]')`)
    return waitFor(value => value.version > version)
  }
  await click('创建/附着骨骼')
  if (width < 520) {
    const beforeLayout = await snapshot()
    await clickElement(`document.querySelector('button[title="折叠动画面板"]')`)
    await browser.wait(`document.querySelector('.look2-animations')?.classList.contains('collapsed')`)
    await clickElement(`document.querySelector('button[title="收起属性面板"]')`)
    await browser.wait(`document.querySelector('.look2-inspector-pane')?.classList.contains('collapsed')`)
    const resize = await browser.evaluate(`document.querySelector('.look2-dock > .look2-timeline-resize').getBoundingClientRect().toJSON()`)
    const previousHeight = await browser.evaluate(`document.querySelector('.look2-dock').getBoundingClientRect().height`)
    const origin = { x: resize.x + resize.width / 2, y: resize.y + resize.height / 2 }
    await drag(origin, { x: origin.x, y: origin.y - 50 })
    await browser.wait(`document.querySelector('.look2-dock').getBoundingClientRect().height > ${previousHeight + 30}`)
    await clickElement(`document.querySelector('button[title="展开动画面板"]')`)
    await clickElement(`document.querySelector('button[title="展开属性面板"]')`)
    await browser.wait(`!document.querySelector('.look2-animations')?.classList.contains('collapsed') && !document.querySelector('.look2-inspector-pane')?.classList.contains('collapsed') && document.querySelector('.look2-stage-heading button[aria-pressed="true"]')?.textContent === '退出骨骼编辑'`)
    const afterLayout = await snapshot()
    assert.equal(afterLayout.version, beforeLayout.version, '折叠和拖高面板不应修改工程版本或历史')
    assert.deepEqual(afterLayout.look2, beforeLayout.look2, '布局变化不应修改动画或骨骼数据')
  }
  // ResizeObserver and the layout grid must finish before mapping world points.
  await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const stage = await browser.evaluate(`document.querySelector('.look2-stage').getBoundingClientRect().toJSON()`)
  const point = (x, y) => ({ x: stage.x + x * stage.width / 1600, y: stage.y + (900 - y) * stage.height / 900 })
  await drag(point(650, 500), point(720, 470))
  const created = await waitFor(value => value.tree.some(row => row.name === '骨骼_1'))
  const bone = created.tree.find(row => row.name === '骨骼_1')
  assert.equal(bone.parentId, 'n1')
  assert.equal(readFileSync(file, 'utf8'), input, '创建骨骼后，显式保存前不能改写磁盘存档')
  const initialLength = created.look2.siteNodes[bone.id].editor.directionArrowLength
  await browser.wait(`!!document.querySelector('[data-bone-length-handle="${bone.id}"]')`)
  const handle = await browser.evaluate(`document.querySelector('[data-bone-length-handle="${bone.id}"]').getBoundingClientRect().toJSON()`)
  await drag({ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + 25, y: handle.y + handle.height / 2 })
  await waitFor(value => value.look2.siteNodes[bone.id].editor.directionArrowLength !== initialLength)
  assert.equal(readFileSync(file, 'utf8'), input, '骨骼长度修改尚未撤销时，不能提前写盘')
  const restoredLength = await undo()
  assert.equal(restoredLength.look2.siteNodes[bone.id].editor.directionArrowLength, initialLength)
  await browser.wait(`(() => { const r = document.querySelector('[data-bone-length-handle="${bone.id}"]')?.getBoundingClientRect(); return !!r && Math.abs(r.x - ${handle.x}) < .1 && Math.abs(r.y - ${handle.y}) < .1 })()`)
  const titleSelector = `[...document.querySelectorAll('.look2-box.textbox')].find(el => el.textContent.replace(/\\s/g, '').includes('客户端模板已实例化'))`
  const title = await browser.evaluate(`${titleSelector}.getBoundingClientRect().toJSON()`)
  const center = { x: title.x + title.width / 2, y: title.y + title.height / 2 }
  const hit = await browser.evaluate(`(() => { const el = ${titleSelector}; const hit = document.elementFromPoint(${center.x}, ${center.y}); return { target: !!hit && (hit === el || el.contains(hit)), tag: hit?.tagName, className: hit?.getAttribute('class') }; })()`)
  assert.equal(hit.target, true, `附着点击应实际命中文本控件：${JSON.stringify({ center, hit })}`)
  await drag(center, center, 2)
  const attached = await waitFor(value => value.tree.find(row => row.id === 'n2')?.parentId === bone.id)
  assert.equal(attached.tree.find(row => row.id === 'n2').parentId, bone.id)
  assert.equal(readFileSync(file, 'utf8'), input, '控件附着尚未撤销时，不能提前写盘')
  const after = await browser.evaluate(`${titleSelector}.getBoundingClientRect().toJSON()`)
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(after[key] - title[key]) < 0.1, `${key}: ${JSON.stringify({ title, after })}`)
  const detached = await undo()
  assert.equal(detached.tree.find(row => row.id === 'n2').parentId, 'n1')
  const removed = await undo()
  assert.equal(removed.tree.some(row => row.id === bone.id), false)
  assert.equal(readFileSync(file, 'utf8'), input, 'all editing stays in memory until explicit save')
})
}
