import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../dsh-plugin/lib/play.html', import.meta.url), 'utf8')
const start = source.indexOf("      $('close').addEventListener('click', async () => {")
const end = source.indexOf("      $('theme').addEventListener", start)
assert(start >= 0 && end > start)
const handlerSource = source.slice(start, end)

function page({ api = '/editor/api/play', opener = null, closeWorks = false, stop = async () => {}, storageThrows = false, referrer = '' } = {}) {
  let handler, stopped = 0, closed = 0
  const targets = [], storage = new Map(), timers = new Map()
  const button = { disabled: false, addEventListener(type, fn) { assert.equal(type, 'click'); handler = fn } }
  const window = { opener, closed: false, close() { closed++; window.closed = closeWorks } }
  runInNewContext(handlerSource, {
    $: () => button, API: api, sessionId: 'unsaved-preview-session', window,
    play: { running: true, async stop() { stopped++; await stop() } },
    sessionStorage: { setItem(key, value) { if (storageThrows) throw Error('disabled'); storage.set(key, value) } },
    location: { origin: 'http://local.test', pathname: '/look2-simulator/play', replace: target => targets.push(target) },
    document: { referrer }, URL,
    setTimeout(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  return { click: () => handler(), targets, storage, button, timers, window,
    counts: () => ({ stopped, closed }),
    flush(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() } },
  }
}

test('directly opened Web play returns to the same unsaved editor session', async () => {
  const p = page()
  await p.click(); p.flush(100)
  assert.deepEqual(p.targets, ['/editor'])
  assert.equal(p.storage.get('look2-editor-session'), 'unsaved-preview-session')
  assert.deepEqual(p.counts(), { stopped: 1, closed: 0 })
})

test('a popup focuses its editor and closes without navigating either page', async () => {
  let focused = 0
  const p = page({ opener: { closed: false, focus() { focused++ } }, closeWorks: true })
  await p.click(); p.flush(100)
  assert.equal(focused, 1)
  assert.deepEqual(p.counts(), { stopped: 1, closed: 1 })
  assert.deepEqual(p.targets, [])
})

test('a browser-blocked popup close falls back to its matching editor', async () => {
  const p = page({ opener: { closed: false, focus() {} } })
  await p.click(); p.flush(100)
  assert.deepEqual(p.targets, ['/editor'])
  assert.equal(p.storage.get('look2-editor-session'), 'unsaved-preview-session')
})

test('stop rejection and disabled storage still permit returning', async () => {
  const p = page({ stop: async () => { throw Error('worker stopped') }, storageThrows: true })
  await p.click(); p.flush(100)
  assert.deepEqual(p.targets, ['/editor#session=unsaved-preview-session'])
})

test('a hanging stop is bounded and repeated clicks do not repeat stop', async () => {
  const p = page({ stop: () => new Promise(() => {}) })
  const pending = p.click()
  await p.click()
  p.flush(1500)
  await pending; p.flush(100)
  assert.deepEqual(p.counts(), { stopped: 1, closed: 0 })
  assert.deepEqual(p.targets, ['/editor'])
  assert.equal(p.timers.size, 0)
})

test('DSH fallback returns only to a same-origin host page', async () => {
  for (const [referrer, expected] of [['http://local.test/chat/one', 'http://local.test/chat/one'], ['https://foreign.test/chat', '/'], ['', '/']]) {
    const p = page({ api: '/look2-simulator/api/play', referrer })
    await p.click(); p.flush(100)
    assert.deepEqual(p.targets, [expected])
    assert.equal(p.storage.size, 0)
  }
})

const entry = readFileSync(new URL('../lib/editor-client.js', import.meta.url), 'utf8')
const sessionSource = entry.slice(entry.indexOf("const key = 'look2-editor-session'"), entry.indexOf('const editor ='))
function editorSession({ hash = '', stored = 'previous-editor', blocked = false } = {}) {
  let written
  const result = runInNewContext(sessionSource + '\nsessionId', {
    location: { hash }, URLSearchParams, Uint8Array,
    crypto: { getRandomValues: value => value.fill(1) },
    sessionStorage: {
      getItem() { if (blocked) throw Error('disabled'); return stored },
      setItem(key, value) { if (blocked) throw Error('disabled'); written = value },
    },
  })
  return { result, written }
}

test('editor restores the preview session from its fragment when storage is blocked', () => {
  assert.equal(editorSession({ hash: '#session=unsaved-preview-session', blocked: true }).result, 'unsaved-preview-session')
  const restored = editorSession({ hash: '#session=unsaved-preview-session' })
  assert.equal(restored.result, 'unsaved-preview-session')
  assert.equal(restored.written, 'unsaved-preview-session')
})

test('editor preserves its normal session and ignores invalid return identifiers', () => {
  assert.equal(editorSession().result, 'previous-editor')
  assert.equal(editorSession({ hash: '#session=invalid%2Fidentifier' }).result, 'previous-editor')
})

test('editor can initialize when both storage reads and writes are blocked', () => {
  assert.equal(editorSession({ blocked: true }).result, '01'.repeat(16))
})
