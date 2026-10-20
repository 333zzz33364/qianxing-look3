import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStudio } from '../../studio/index.js'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('Look3 tree search, lock toggle, timeline copy/paste, undo/redo and save/reopen use the active UI', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-tree-timeline-browser-'))
  const path = 'tree-timeline.save.json'
  const file = join(directory, path)
  const archive = createStudio().archiveData()
  const target = archive.assets.server.root.children[0].children.find(node => node.kind === 'textbox')
  assert.ok(target, 'fixture needs a textbox in the active server UI tree')
  target.name = '树搜索目标文本'
  archive.meta.name = '树与时间轴浏览器关键路径'
  writeFileSync(file, JSON.stringify(archive))

  const app = await createWebServer({ workspace: directory, initialPath: path, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close()
    await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory, [
    '--disable-gpu',
    '--disable-features=Vulkan,UseSkiaRenderer,WebGPU',
  ])
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false,
  }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2-tree-list [aria-label="搜索控件"]')`)
  await browser.wait(`!!document.querySelector('[aria-label="关键帧时间轴"] input.timeline-seek')`)

  const clickBox = async box => {
    assert.ok(box && box.width > 0 && box.height > 0, `不可点击目标：${JSON.stringify(box)}`)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, browser.sessionId)
  }
  const clickSelector = async (selector, scopeSelector = '') => {
    const scope = scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : 'document'
    const box = await browser.evaluate(`(() => { const scope = ${scope}; const el = scope?.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`)
    await clickBox(box)
  }
  const clickButtonText = async (text, scopeSelector) => {
    const box = await browser.evaluate(`(() => { const scope = document.querySelector(${JSON.stringify(scopeSelector)}); const el = [...(scope?.querySelectorAll('button') || [])].find(item => item.textContent.trim() === ${JSON.stringify(text)} && !item.disabled); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`)
    await clickBox(box)
  }
  const sessionId = await browser.evaluate(`document.querySelector('.look2')?.dataset.qxsimSessionId || ''`)
  assert.ok(sessionId, 'active Look2 session id should be present in the real editor DOM')
  const snapshot = async () => {
    const response = await fetch(`${app.url}/editor/api/get`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
    })
    const envelope = await response.json()
    assert.equal(response.status, 200, JSON.stringify(envelope))
    assert.equal(envelope.ok, true, JSON.stringify(envelope))
    return envelope.value
  }
  const waitForSnapshot = async (predicate, description) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const value = await snapshot()
      if (predicate(value)) return value
      await delay(50)
    }
    const value = await snapshot()
    assert.fail(`${description}: ${JSON.stringify({ selectedId: value.selectedId, locks: value.editorLocks, animations: value.look2?.animations })}`)
  }
  const activeTrack = value => value.look2.animations
    .find(animation => animation.id === value.look2.activeAnimationId)?.keyframeTracks?.find(track => track.nodeId === target.id)
  const seekAt = async fraction => {
    const box = await browser.evaluate(`(() => { const el = document.querySelector('input.timeline-seek'); const r = el?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height }; })()`)
    assert.ok(box && box.width > 30, `时间轴滑块不可用：${JSON.stringify(box)}`)
    await clickBox({ ...box, x: box.x + box.width * fraction, width: 1 })
    await delay(80)
    return browser.evaluate(`Number(document.querySelector('.look2-time-readout')?.textContent.match(/^([0-9.]+)/)?.[1] || 0)`)
  }

  const search = '树搜索目标文本'
  await clickSelector('[aria-label="搜索控件"]')
  await browser.send('Input.insertText', { text: search }, browser.sessionId)
  await browser.wait(`document.querySelector('[aria-label="搜索控件"]')?.value === ${JSON.stringify(search)}`)
  await browser.wait(`document.querySelectorAll('.look2-tree-row').length === 1`)
  const rowText = await browser.evaluate(`document.querySelector('.look2-tree-row .tree-name')?.textContent.trim()`)
  assert.equal(rowText, search, 'search should filter the active tree to the named target')
  await clickSelector('.tree-name', '.look2-tree-row')
  await browser.wait(`document.querySelector('.look2-tree-row')?.classList.contains('sel')`)
  await waitForSnapshot(value => value.selectedId === target.id, 'tree row selection did not reach the active editor')

  await clickSelector('.tree-lock', '.look2-tree-row')
  await browser.wait(`document.querySelector('.look2-tree-row')?.classList.contains('locked-node')`)
  await waitForSnapshot(value => value.editorLocks?.[target.id] === true, 'tree lock click did not lock the selected node')
  await clickSelector('.tree-lock', '.look2-tree-row')
  await browser.wait(`!document.querySelector('.look2-tree-row')?.classList.contains('locked-node')`)
  await waitForSnapshot(value => value.editorLocks?.[target.id] !== true, 'tree unlock click did not unlock the selected node')

  await clickSelector('button[title="添加当前控件的轨道"]')
  let value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 1, 'UI did not add the selected textbox property track')
  assert.equal(activeTrack(value).fieldKey, 'anchoredPositionX')
  assert.ok(await browser.evaluate(`document.querySelector('.look2-track .look2-key') !== null`), 'new track should render its initial key in the timeline')

  const secondTime = await seekAt(.28)
  assert.ok(secondTime > .1, `pointer input should move the playback head: ${secondTime}`)
  await clickSelector('button[title="在播放头添加关键帧"]', '.look2-track')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 2, 'UI did not add a keyframe at the moved playhead')
  const track = activeTrack(value)
  const times = track.keyframes.map(key => Number(key.time)).sort((a, b) => a - b)
  assert.ok(times[0] < times[1], JSON.stringify(times))

  await clickSelector('.look2-key:last-child', '.look2-track')
  await browser.wait(`document.querySelector('.look2-key.sel') !== null`)
  await clickButtonText('复制', '.look2-key-inspector')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已复制 1 个关键帧')`)
  const pasteTime = await seekAt(.72)
  assert.ok(pasteTime > secondTime + .1, JSON.stringify({ secondTime, pasteTime }))
  await clickButtonText('粘贴', '.look2-key-inspector')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 3, 'UI paste did not create the copied keyframe at the playhead')
  const pastedTrack = activeTrack(value)
  const savedKeyTimes = pastedTrack.keyframes.map(key => Number(key.time)).sort((a, b) => a - b)
  assert.ok(savedKeyTimes[2] > savedKeyTimes[1], JSON.stringify(savedKeyTimes))

  await clickSelector('button[aria-label="撤销"]')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 2, 'undo should remove the pasted keyframe')
  assert.equal(activeTrack(value).keyframes.length, 2)
  await clickSelector('button[aria-label="重做"]')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 3, 'redo should restore the pasted keyframe')
  assert.deepEqual(activeTrack(value).keyframes.map(key => Number(key.time)).sort((a, b) => a - b), savedKeyTimes)

  await clickSelector('button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('.look2-archive-status')?.textContent.includes('已保存')`)
  const savedArchive = JSON.parse(readFileSync(file, 'utf8'))
  const storedTrack = savedArchive.look2.animations
    .find(animation => animation.id === savedArchive.look2.activeAnimationId)?.keyframeTracks?.find(track => track.nodeId === target.id)
  assert.ok(storedTrack, 'explicit UI save should persist the timeline track to the workspace archive')
  assert.deepEqual(storedTrack.keyframes.map(key => Number(key.time)).sort((a, b) => a - b), savedKeyTimes)

  await clickSelector('.look2-menu-button')
  await browser.wait(`!!document.querySelector('.look2-workspace select[aria-label="工作区存档列表"]')`)
  const archiveSelect = '.look2-workspace select[aria-label="工作区存档列表"]'
  const options = await browser.evaluate(`([...document.querySelector(${JSON.stringify(archiveSelect)}).options]).map(option => option.value)`)
  assert.ok(options.includes(path), JSON.stringify(options))
  const selectedPath = await browser.evaluate(`document.querySelector(${JSON.stringify(archiveSelect)}).value`)
  if (selectedPath !== path) {
    await clickSelector(archiveSelect)
    await browser.key('Home', 'Home')
    await browser.key('ArrowDown', 'ArrowDown')
    await browser.key('Enter', 'Enter')
  }
  await browser.wait(`document.querySelector(${JSON.stringify(archiveSelect)})?.value === ${JSON.stringify(path)}`)
  await clickButtonText('打开', '.look2-workspace')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes(${JSON.stringify(`已加载 ${path}`)})`)
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 3, 'reopening the saved archive should restore the full UI-edited timeline')
  assert.deepEqual(activeTrack(value).keyframes.map(key => Number(key.time)).sort((a, b) => a - b), savedKeyTimes)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).meta.name, '树与时间轴浏览器关键路径')
})
