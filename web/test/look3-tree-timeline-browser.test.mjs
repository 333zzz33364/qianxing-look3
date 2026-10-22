import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStudio } from '../../studio/index.js'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('Look3 tree and timeline pointer editing, event playback and save reopen use the active UI', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-tree-timeline-browser-'))
  const path = 'tree-timeline.save.json'
  const file = join(directory, path)
  const archive = createStudio().archiveData()
  const targetParent = archive.assets.server.root.children[0]
  const target = targetParent.children.find(node => node.kind === 'textbox')
  assert.ok(target, 'fixture needs a textbox in the active server UI tree')
  const targetIndex = targetParent.children.indexOf(target)
  const nextSibling = targetParent.children[targetIndex + 1]
  assert.ok(nextSibling, 'fixture needs a following sibling for tree reorder')
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
  await browser.wait(`!!document.querySelector('.look2-tree-tools [aria-label="搜索控件"]')`)
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
    const box = await browser.evaluate(`(() => { const scope = ${scope}; const el = scope?.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return null; let r = el.getBoundingClientRect(); if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); r = el.getBoundingClientRect(); } const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x: r.x, y: r.y, width: r.width, height: r.height, hitTarget: Boolean(hit && (hit === el || el.contains(hit))), hitDescription: hit && { tag: hit.tagName, className: typeof hit.className === 'string' ? hit.className : '', title: hit.getAttribute('title') } }; })()`)
    assert.ok(box?.hitTarget, `真实点击中心未命中目标 ${selector}: ${JSON.stringify(box)}`)
    await clickBox(box)
  }
  const clickButtonText = async (text, scopeSelector) => {
    const box = await browser.evaluate(`(() => { const scope = document.querySelector(${JSON.stringify(scopeSelector)}); const el = [...(scope?.querySelectorAll('button') || [])].find(item => item.textContent.trim() === ${JSON.stringify(text)} && !item.disabled); if (!el) return null; let r = el.getBoundingClientRect(); if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); r = el.getBoundingClientRect(); } const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x: r.x, y: r.y, width: r.width, height: r.height, hitTarget: Boolean(hit && (hit === el || el.contains(hit))), hitDescription: hit && { tag: hit.tagName, className: typeof hit.className === 'string' ? hit.className : '', title: hit.getAttribute('title') } }; })()`)
    assert.ok(box?.hitTarget, `真实点击中心未命中按钮 ${text}: ${JSON.stringify(box)}`)
    await clickBox(box)
  }
  const rightClickSelector = async (selector, scopeSelector = '') => {
    const scope = scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : 'document'
    const box = await browser.evaluate(`(() => { const scope = ${scope}; const el = scope?.querySelector(${JSON.stringify(selector)}); if (!el) return null; let r = el.getBoundingClientRect(); if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); r = el.getBoundingClientRect(); } const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x: r.x, y: r.y, width: r.width, height: r.height, hitTarget: Boolean(hit && (hit === el || el.contains(hit))), hitDescription: hit && { tag: hit.tagName, className: typeof hit.className === 'string' ? hit.className : '', title: hit.getAttribute('title') } }; })()`)
    assert.ok(box && box.width > 0 && box.height > 0, `不可右键目标：${JSON.stringify(box)}`)
    assert.ok(box.hitTarget, `真实右键中心未命中目标 ${selector}: ${JSON.stringify(box)}`)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 }, browser.sessionId)
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
  let value
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

  await rightClickSelector('.look2-tree-row')
  await browser.wait(`!![...document.querySelectorAll('.look2-context-menu button')].find(button => button.textContent.trim() === '下移层级' && !button.disabled)`)
  await clickButtonText('下移层级', '.look2-context-menu')
  value = await waitForSnapshot(current => current.root?.children?.[0]?.children?.[targetIndex + 1]?.id === target.id, 'tree context action did not move the textbox below its sibling')
  assert.deepEqual(value.root.children[0].children.slice(targetIndex, targetIndex + 2).map(node => node.id), [nextSibling.id, target.id])

  await clickSelector('button[title="添加当前控件的轨道"]')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 1, 'UI did not add the selected textbox property track')
  assert.equal(activeTrack(value).fieldKey, 'anchoredPositionX')
  await browser.wait(`document.querySelectorAll('.look2-track .look2-key').length === 1`)
  assert.ok(await browser.evaluate(`document.querySelector('.look2-track .look2-key') !== null`), 'new track should render its initial key in the timeline')

  const secondTime = await seekAt(.28)
  assert.ok(secondTime > .1, `pointer input should move the playback head: ${secondTime}`)
  await clickSelector('button[title="在播放头添加关键帧"]', '.look2-track')
  try {
    value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 2, `UI did not add a keyframe at the moved playhead (${secondTime}s)`)
  } catch (reason) {
    const uiState = await browser.evaluate(`(() => { const button = document.querySelector('.look2-track button[title="在播放头添加关键帧"]'); const rect = button?.getBoundingClientRect(); const status = document.querySelector('[aria-label="查看错误历史"]'); return { readout: document.querySelector('.look2-time-readout')?.textContent, seekValue: document.querySelector('input.timeline-seek')?.value, addButton: button && { disabled: button.disabled, bounds: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, status: status?.textContent, statusTitle: status?.title, statusClass: status?.className } })()`)
    assert.fail(`${reason.message}\nUI state: ${JSON.stringify(uiState)}`)
  }
  await browser.wait(`document.querySelectorAll('.look2-track .look2-key').length === 2`)
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
  let savedKeyTimes = pastedTrack.keyframes.map(key => Number(key.time)).sort((a, b) => a - b)
  assert.ok(savedKeyTimes[2] > savedKeyTimes[1], JSON.stringify(savedKeyTimes))

  await clickSelector('button[aria-label="撤销"]')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 2, 'undo should remove the pasted keyframe')
  assert.equal(activeTrack(value).keyframes.length, 2)
  await browser.wait(`document.querySelector('button[aria-label="重做"]')?.disabled === false`)
  await clickSelector('button[aria-label="重做"]')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes?.length === 3, 'redo should restore the pasted keyframe')
  assert.deepEqual(activeTrack(value).keyframes.map(key => Number(key.time)).sort((a, b) => a - b), savedKeyTimes)

  // Drag the final key with real pointer capture, then verify its transaction
  // and persistence separately from the existing copy/paste path.
  const finalKey = activeTrack(value).keyframes.reduce((last, key) => key.time > last.time ? key : last)
  const finalSelector = '.look2-track .look2-key:last-child'
  await browser.wait(`document.querySelector(${JSON.stringify(finalSelector)})?.title.startsWith(${JSON.stringify(Number(finalKey.time).toFixed(3))})`)
  const keyBox = await browser.evaluate(`document.querySelector(${JSON.stringify(finalSelector)}).getBoundingClientRect().toJSON()`)
  const keyPoint = { x: keyBox.x + keyBox.width / 2, y: keyBox.y + keyBox.height / 2 }
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(finalSelector)}).contains(document.elementFromPoint(${keyPoint.x}, ${keyPoint.y}))`),
    true, 'key drag must begin on the intended key')
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...keyPoint }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...keyPoint, button: 'left', buttons: 1, clickCount: 1 }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: keyPoint.x - 36, y: keyPoint.y, button: 'left', buttons: 1 }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: keyPoint.x - 36, y: keyPoint.y, button: 'left', buttons: 0, clickCount: 1 }, browser.sessionId)
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes.find(key => key.id === finalKey.id)?.time < finalKey.time - .1,
    'pointer dragging the final key must move it earlier')
  assert.equal(activeTrack(value).keyframes.length, 3, 'dragging a key must preserve key count')
  const draggedTime = activeTrack(value).keyframes.find(key => key.id === finalKey.id).time
  assert.ok(Math.abs(draggedTime * value.look2.frameRate - Math.round(draggedTime * value.look2.frameRate)) < .01,
    'pointer drag must snap to the configured frame rate')
  await clickSelector('button[aria-label="撤销"]')
  await waitForSnapshot(current => activeTrack(current)?.keyframes.find(key => key.id === finalKey.id)?.time === finalKey.time,
    'undo key drag must restore its time')
  await browser.wait(`document.querySelector('button[aria-label="重做"]')?.disabled === false`)
  await clickSelector('button[aria-label="重做"]')
  value = await waitForSnapshot(current => activeTrack(current)?.keyframes.find(key => key.id === finalKey.id)?.time === draggedTime,
    'redo key drag must restore its moved time')
  savedKeyTimes = activeTrack(value).keyframes.map(key => Number(key.time)).sort((a, b) => a - b)

  const activeAnimation = current => current.look2.animations.find(animation => animation.id === current.look2.activeAnimationId)
  await seekAt(.12)
  // The key at the far end may have horizontally scrolled the timeline;
  // reveal the event row's label before checking and clicking its hit target.
  await browser.evaluate(`document.querySelector('button[title="在播放头添加事件"]').scrollIntoView({ block: 'nearest', inline: 'nearest' })`)
  await clickSelector('button[title="在播放头添加事件"]')
  value = await waitForSnapshot(current => activeAnimation(current)?.events.length === 1, 'UI must add the event')
  const eventId = activeAnimation(value).events[0].id
  await browser.wait(`document.querySelector('.look2-key-inspector h4')?.textContent === '事件'`)
  const replaceField = async (selector, text) => {
    await clickSelector(selector)
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`)
    await browser.send('Input.insertText', { text }, browser.sessionId)
    await browser.wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`)
    await browser.key('Tab', 'Tab')
  }
  await replaceField('.look2-key-inspector input[type="text"]', '浏览器事件回读')
  await waitForSnapshot(current => activeAnimation(current)?.events[0]?.name === '浏览器事件回读', 'event name blur must commit')
  await replaceField('.look2-key-inspector textarea', '{"source":"pointer","value":7}')
  value = await waitForSnapshot(current => activeAnimation(current)?.events[0]?.params === '{"source":"pointer","value":7}',
    'event parameters blur must commit')
  const savedEvents = structuredClone(activeAnimation(value).events)
  assert.equal(savedEvents[0].id, eventId)
  assert.ok(savedEvents[0].time > 0 && savedEvents[0].time < 1, 'event needs to occur shortly after playback begins')
  await clickSelector('button[title="播放事件日志"]')
  const pausedSeek = await seekAt(.8)
  assert.ok(pausedSeek > savedEvents[0].time + .5, 'paused seek must actually cross the event time')
  assert.equal(await browser.evaluate(`document.querySelectorAll('.look2-event-log > div').length`), 0,
    'seeking past an event while paused must not dispatch it')
  await clickSelector('button[title="回到起点"]')
  await browser.wait(`Number(document.querySelector('input.timeline-seek')?.value) === 0 && !!document.querySelector('button[aria-label="播放动画"]')`)
  await clickSelector('button[aria-label="播放动画"]')
  await browser.wait(`document.querySelector('.look2-event-log')?.textContent.includes('浏览器事件回读')`)
  await clickSelector('button[aria-label="暂停动画"]')
  await browser.wait(`!!document.querySelector('button[aria-label="播放动画"]')`)
  assert.equal(await browser.evaluate(`document.querySelectorAll('.look2-event-log > div').length`), 1,
    'crossing the event during playback must emit exactly once')
  assert.ok(await browser.evaluate(`document.querySelector('.look2-event-log').textContent.includes('"value":7')`))
  const seekAfterPlayback = await seekAt(.8)
  assert.ok(seekAfterPlayback > savedEvents[0].time + .5, 'second paused seek must actually cross the event time')
  assert.equal(await browser.evaluate(`document.querySelectorAll('.look2-event-log > div').length`), 1,
    'paused seeking must not duplicate an already emitted event')

  await clickSelector('button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('.look2-archive-status')?.textContent.includes('已保存')`)
  const savedArchive = JSON.parse(readFileSync(file, 'utf8'))
  const savedServerLook2 = savedArchive.look2ByAsset?.server
  assert.ok(savedServerLook2, 'explicit UI save should persist the active server timeline state')
  const storedTrack = savedServerLook2.animations
    .find(animation => animation.id === savedServerLook2.activeAnimationId)?.keyframeTracks?.find(track => track.nodeId === target.id)
  assert.ok(storedTrack, 'explicit UI save should persist the timeline track to the workspace archive')
  assert.deepEqual(storedTrack.keyframes.map(key => Number(key.time)).sort((a, b) => a - b), savedKeyTimes)
  assert.deepEqual(savedServerLook2.animations.find(animation => animation.id === savedServerLook2.activeAnimationId).events, savedEvents,
    'explicit save must persist edited event identity, time, name and parameters')
  assert.deepEqual(savedArchive.assets.server.root.children[0].children.slice(targetIndex, targetIndex + 2).map(node => node.id), [nextSibling.id, target.id], 'explicit UI save should persist the reordered tree')

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
  assert.deepEqual(activeAnimation(value).events, savedEvents, 'reopening the archive must restore the edited event')
  assert.deepEqual(value.root.children[0].children.slice(targetIndex, targetIndex + 2).map(node => node.id), [nextSibling.id, target.id], 'reopening the archive should restore the reordered tree')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).meta.name, '树与时间轴浏览器关键路径')
})
