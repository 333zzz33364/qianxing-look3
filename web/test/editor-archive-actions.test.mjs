import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('workspace management remaps two bound tabs, preserves dirty drafts and refuses stale saves and collisions', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'look3-web-managed-'))
  const app = await createWebServer({ workspace, port: 0 })
  t.after(async () => { await app.close(); rmSync(workspace, { recursive: true, force: true }) })
  const call = async (sessionId, action, body = {}) => {
    const response = await fetch(`${app.url}/editor/api/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }),
    })
    return { status: response.status, ...await response.json() }
  }
  const get = async id => (await call(id, 'get')).value
  const manage = async (id, body) => call(id, 'archive-manage', { ...body, expectedRevision: (await get(id)).version })
  assert.equal((await manage('a', { operation: 'create-workspace', name: '甲' })).status, 200)
  assert.equal((await call('a', 'archives')).value.archives.length, 0)
  const sourcePath = '工作区/甲/存档.save.json'
  await call('a', 'save', { path: sourcePath, expectedRevision: (await get('a')).version })
  await call('b', 'load-archive', { path: sourcePath })
  await call('b', 'patch', { op: { op: 'renameSave', name: '乙页未保存', expectedRevision: (await get('b')).version } })
  const bytes = readFileSync(join(workspace, sourcePath))
  assert.equal((await manage('a', { operation: 'rename-workspace', path: '工作区/甲', name: '乙' })).status, 200)
  const moved = '工作区/乙/存档.save.json'
  assert.equal((await get('a')).storage.path, moved)
  assert.equal((await get('b')).storage.path, moved)
  assert.equal((await get('b')).save.name, '乙页未保存')
  const stale = await call('b', 'save', { path: sourcePath, expectedRevision: (await get('b')).version })
  assert.equal(stale.status, 400)
  assert.match(stale.error, /已改名/)
  assert.equal(existsSync(join(workspace, sourcePath)), false)
  assert.deepEqual(readFileSync(join(workspace, moved)), bytes)
  assert.equal((await manage('a', { operation: 'rename-archive', path: moved, name: '新存档' })).status, 200)
  const renamed = '工作区/乙/新存档.save.json'
  assert.equal((await get('b')).storage.path, renamed)
  assert.equal((await call('b', 'save', { path: renamed, expectedRevision: (await get('b')).version })).status, 200)
  assert.equal(JSON.parse(readFileSync(join(workspace, renamed), 'utf8')).meta.name, '乙页未保存')
  writeFileSync(join(workspace, '工作区/乙/冲突.json'), 'protected')
  assert.equal((await manage('a', { operation: 'rename-archive', path: renamed, name: '冲突.json' })).status, 400)
  assert.equal(readFileSync(join(workspace, '工作区/乙/冲突.json'), 'utf8'), 'protected')
})

test('concurrent rename and save cannot recreate a renamed archive', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'look3-web-rename-race-'))
  const app = await createWebServer({ workspace, port: 0 })
  t.after(async () => { await app.close(); rmSync(workspace, { recursive: true, force: true }) })
  const call = async (sessionId, action, body = {}) => (await fetch(`${app.url}/editor/api/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }),
  })).json()
  const revision = (await call('a', 'get')).value.version
  await call('a', 'save', { path: 'a.json', expectedRevision: revision })
  await call('b', 'load-archive', { path: 'a.json' })
  const bRevision = (await call('b', 'get')).value.version
  const [renamed, saved] = await Promise.all([
    call('a', 'archive-manage', { operation: 'rename-archive', path: 'a.json', name: 'b.json', expectedRevision: revision }),
    call('b', 'save', { path: 'a.json', expectedRevision: bRevision }),
  ])
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  assert.equal(typeof saved.ok, 'boolean')
  assert.equal(existsSync(join(workspace, 'a.json')), false)
  assert.equal(existsSync(join(workspace, 'b.json')), true)
  assert.equal((await call('b', 'get')).value.storage.path, 'b.json')
})
