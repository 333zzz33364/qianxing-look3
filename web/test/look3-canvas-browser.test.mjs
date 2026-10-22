import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStudio } from '../../studio/index.js'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('Look3 canvas zoom anchors the pointer, middle pan preserves data, and scaled dragging respects locks', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-canvas-browser-'))
  const path = 'canvas.save.json'
  const file = join(directory, path)
  const archive = createStudio().archiveData()
  const parent = archive.assets.server.root.children[0]
  const target = parent.children.find(node => node.kind === 'textbox')
  assert.ok(target)
  parent.children = [target]
  target.name = '画布指针目标'
  target.text = '画布指针目标'
  target.syncAllDevices = false
  for (const transform of Object.values(target.transformByPlatform)) {
    transform.offset = { x: 0, y: 0 }
    transform.size = { x: 300, y: 100 }
  }
  const original = JSON.stringify(archive)
  writeFileSync(file, original)
  const app = await createWebServer({ workspace: directory, initialPath: path, port: 0 })
  let browser
  t.after(async () => {
    try { await browser?.close() } finally {
      try { await app.close() } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    }
  })
  browser = await startTestBrowser(directory)
  t.diagnostic('isolated browser started')
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.canvasTestErrors = [];
    addEventListener('error', event => window.canvasTestErrors.push(event.message));
    addEventListener('unhandledrejection', event => window.canvasTestErrors.push(String(event.reason)));
  ` }, browser.sessionId)
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('.look2-box.textbox') && !!document.querySelector('.look2-stage')`)
  t.diagnostic('active editor mounted')
  await browser.evaluate('document.fonts.ready.then(() => true)')
  // Font loading can resize the surrounding panels and therefore canvas fit.
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  const sessionId = await browser.evaluate(`document.querySelector('.look2').dataset.qxsimSessionId`)
  const snapshot = async () => {
    const response = await fetch(app.url + '/editor/api/get', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(5_000),
    })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const targetNode = value => value.root.children[0].children.find(node => node.id === target.id)
  const waitFor = async (predicate, description) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const value = await snapshot()
      if (predicate(value)) return value
      await delay(50)
    }
    assert.fail(`${description}: ${JSON.stringify(await snapshot())}`)
  }
  const rect = selector => browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing element ' + ${JSON.stringify(selector)});
    return el.getBoundingClientRect().toJSON();
  })()`)
  const mouse = params => browser.send('Input.dispatchMouseEvent', params, browser.sessionId)
  const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const click = async selector => {
    const point = center(await rect(selector))
    assert.equal(await browser.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el.contains(document.elementFromPoint(${point.x}, ${point.y}));
    })()`), true, `click must hit ${selector}`)
    await mouse({ type: 'mouseMoved', ...point })
    await mouse({ type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await mouse({ type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  }
  const drag = async (start, end, button = 'left') => {
    assert.equal(await browser.evaluate(`(() => {
      const control = document.querySelector('.look2-box.textbox');
      return control.contains(document.elementFromPoint(${start.x}, ${start.y}));
    })()`), true, 'control drag must start on the intended textbox')
    const buttons = button === 'middle' ? 4 : 1
    await mouse({ type: 'mouseMoved', ...start })
    await mouse({ type: 'mousePressed', ...start, button, buttons, clickCount: 1 })
    await mouse({ type: 'mouseMoved', ...end, button, buttons })
    await mouse({ type: 'mouseReleased', ...end, button, buttons: 0, clickCount: 1 })
  }
  const near = (actual, expected, message, tolerance = .8) => assert.ok(
    Math.abs(actual - expected) < tolerance, `${message}: ${actual} vs ${expected}`)

  const before = await snapshot()
  const initial = await rect('.look2-stage')
  const point = { x: initial.x + initial.width * .65, y: initial.y + initial.height * .37 }
  const normalized = { x: (point.x - initial.x) / initial.width, y: (point.y - initial.y) / initial.height }
  await mouse({ type: 'mouseMoved', ...point })
  await mouse({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: -120 })
  await browser.wait(`document.querySelector('.look2-stage').getBoundingClientRect().width > ${initial.width * 1.05}`)
  const zoomed = await rect('.look2-stage')
  t.diagnostic('wheel zoom completed')
  near(zoomed.width / initial.width, 1.1, 'wheel zoom ratio', .002)
  near(zoomed.x + normalized.x * zoomed.width, point.x, 'pointer world position x stays fixed')
  near(zoomed.y + normalized.y * zoomed.height, point.y, 'pointer world position y stays fixed')

  const start = center(await rect('.look2-box.textbox'))
  await drag(start, { x: start.x + 51, y: start.y + 29 }, 'middle')
  await browser.wait(`Math.abs(document.querySelector('.look2-stage').getBoundingClientRect().x - ${zoomed.x + 51}) < 1`)
  const panned = await rect('.look2-stage')
  t.diagnostic('middle pan completed')
  near(panned.x - zoomed.x, 51, 'middle drag pans horizontally over a control')
  near(panned.y - zoomed.y, 29, 'middle drag pans vertically over a control')
  const afterView = await snapshot()
  assert.equal(afterView.version, before.version, 'view gestures do not create edit transactions')
  assert.deepEqual(afterView.root, before.root, 'view gestures do not alter controls')
  assert.deepEqual(afterView.history, before.history, 'view gestures do not enter undo history')

  await click('button[title="适应画布"]')
  await browser.wait(`Math.abs(document.querySelector('.look2-stage').getBoundingClientRect().width - ${initial.width}) < 1`)
  const reset = await rect('.look2-stage')
  near(reset.x, initial.x, 'fit restores horizontal view')
  near(reset.y, initial.y, 'fit restores vertical view')
  await click('.look2-box.textbox')
  await waitFor(value => value.selectedId === target.id, 'select canvas control')
  const base = targetNode(await snapshot()).transformByPlatform
  const control = await rect('.look2-box.textbox')
  const scale = control.width / base.KEYBOARD.size.x
  const movement = { x: 40 * scale, y: -24 * scale }
  const controlCenter = center(control)
  await drag(controlCenter, { x: controlCenter.x + movement.x, y: controlCenter.y + movement.y })
  const moved = await waitFor(value => targetNode(value).transformByPlatform.KEYBOARD.offset.x > base.KEYBOARD.offset.x + 30,
    'scaled pointer drag must commit world coordinates')
  const transforms = targetNode(moved).transformByPlatform
  t.diagnostic('control drag committed')
  near(transforms.KEYBOARD.offset.x - base.KEYBOARD.offset.x, 40, 'scaled drag world x', 1)
  near(transforms.KEYBOARD.offset.y - base.KEYBOARD.offset.y, 24, 'screen y maps to upward world y', 1)
  for (const platform of ['TOUCHSCREEN', 'CONTROLLER_CONSOLE', 'CONTROLLER_MOBILE']) {
    assert.deepEqual(transforms[platform], base[platform], `drag must preserve ${platform} when sync is off`)
  }
  await click('.look2-tree-row.sel .tree-lock')
  await waitFor(value => value.editorLocks?.[target.id] === true, 'lock target')
  await browser.wait(`!!document.querySelector('.look2-tree-row.sel.locked-node')`)
  const locked = await snapshot()
  const lockedCenter = center(await rect('.look2-box.textbox'))
  await drag(lockedCenter, { x: lockedCenter.x + 40, y: lockedCenter.y - 20 })
  // Check repeated post-input observations after the lock has rendered; a
  // single immediate read could miss a late edit transaction.
  for (let observation = 0; observation < 3; observation++) {
    await delay(100)
    const current = await snapshot()
    assert.deepEqual(targetNode(current).transformByPlatform, transforms, 'locked canvas drag must preserve geometry')
    assert.equal(current.history.entries.length, locked.history.entries.length, 'locked drag adds no undo entry')
    assert.equal(current.version, locked.version, 'locked drag must not submit an edit transaction')
  }
  await click('.look2-tree-row.sel .tree-lock')
  await waitFor(value => value.editorLocks?.[target.id] !== true, 'unlock target')
  await browser.wait(`!!document.querySelector('.look2-tree-row.sel:not(.locked-node)')`)
  await click('button[aria-label="撤销"]')
  const undoUnlock = await waitFor(value => value.editorLocks?.[target.id] === true, 'undo unlock')
  assert.deepEqual(targetNode(undoUnlock).transformByPlatform, transforms, 'undo unlock preserves moved geometry')
  await click('button[aria-label="撤销"]')
  await waitFor(value => value.editorLocks?.[target.id] !== true, 'undo lock')
  await click('button[aria-label="撤销"]')
  await waitFor(value => Math.abs(targetNode(value).transformByPlatform.KEYBOARD.offset.x - base.KEYBOARD.offset.x) < .01,
    'undo move restores geometry after undoing both lock transactions')
  assert.equal(readFileSync(file, 'utf8'), original, 'unsaved pointer edits must not touch the input file')
  assert.deepEqual(await browser.evaluate('window.canvasTestErrors'), [], 'canvas interactions must not cause browser exceptions')
})
