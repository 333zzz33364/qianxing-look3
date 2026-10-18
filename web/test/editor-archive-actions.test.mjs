import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'

test('editor delete-archive removes a save and reveal-archive rejects a missing path', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'look3-web-archive-'))
  const app = await createWebServer({ workspace, port: 0 })
  t.after(async () => { await app.close(); rmSync(workspace, { recursive: true, force: true }) })
  const call = async (sessionId, action, body = {}) => {
    const response = await fetch(`${app.url}/editor/api/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }),
    })
    return { status: response.status, ...await response.json() }
  }

  const filePath = join(workspace, 'doomed.save.json')
  writeFileSync(filePath, JSON.stringify({ format: 'qxqy-simulator-save', name: '临时存档' }))
  assert.equal((await call('a', 'archives')).value.archives.length, 1)

  const deleted = await call('a', 'delete-archive', { path: 'doomed.save.json' })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.value.path, 'doomed.save.json')
  assert.equal(existsSync(filePath), false)
  assert.equal((await call('a', 'archives')).value.archives.length, 0)

  // Reveal is routed even though the file manager is never launched for a missing path.
  const missing = await call('a', 'reveal-archive', { path: 'doomed.save.json' })
  assert.equal(missing.status, 400)
  assert.match(missing.error, /file does not exist/)

  assert.match((await call('a', 'delete-archive', { path: '../escape.save.json' })).error, /workspace/)
})