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

test('renamed aliases cannot recreate old files while rename-back and explicit reload can save', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'look3-web-rename-alias-'))
  const app = await createWebServer({ workspace, port: 0 })
  t.after(async () => { await app.close(); rmSync(workspace, { recursive: true, force: true }) })
  const call = async (action, body = {}) => (await fetch(`${app.url}/editor/api/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'a', ...body }),
  })).json()
  const revision = async () => (await call('get')).value.version
  const rename = async (path, name) => {
    const result = await call('archive-manage', { operation: 'rename-archive', path, name, expectedRevision: await revision() })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  await call('save', { path: 'original.json', expectedRevision: await revision() })
  await call('load-archive', { path: './original.json' })
  await rename('original.json', 'renamed.json')
  assert.equal((await call('get')).value.storage.path, 'renamed.json')
  const aliases = ['./original.json', 'unused/../original.json', 'original.json/']
  if (process.platform === 'win32') aliases.push('ORIGINAL.JSON')
  for (const path of aliases) {
    const result = await call('save', { path, expectedRevision: await revision() })
    assert.equal(result.ok, false, path)
    assert.match(result.error, /已改名/)
  }
  assert.equal(existsSync(join(workspace, 'original.json')), false)
  await rename('renamed.json', 'original.json')
  assert.equal((await call('save', { path: './original.json', expectedRevision: await revision() })).ok, true)
  await rename('original.json', 'renamed.json')
  writeFileSync(join(workspace, 'original.json'), readFileSync(join(workspace, 'renamed.json')))
  assert.equal((await call('load-archive', { path: 'original.json' })).ok, true)
  await call('patch', { op: { op: 'renameSave', name: '重新载入', expectedRevision: await revision() } })
  assert.equal((await call('save', { path: 'original.json', expectedRevision: await revision() })).ok, true)
  assert.equal(JSON.parse(readFileSync(join(workspace, 'original.json'), 'utf8')).meta.name, '重新载入')
})

test('independent Web instances reject saving a moved binding while retaining the dirty draft for Save As', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'look3-web-independent-'))
  const first = await createWebServer({ workspace, port: 0 })
  const second = await createWebServer({ workspace, port: 0 })
  t.after(async () => { await first.close(); await second.close(); rmSync(workspace, { recursive: true, force: true }) })
  const call = async (app, action, body = {}) => (await fetch(`${app.url}/editor/api/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'a', ...body }),
  })).json()
  const revision = async app => (await call(app, 'get')).value.version
  await call(first, 'save', { path: 'original.json', expectedRevision: await revision(first) })
  await call(second, 'load-archive', { path: 'original.json' })
  await call(second, 'patch', { op: { op: 'renameSave', name: '独立服务草稿', expectedRevision: await revision(second) } })
  const renamed = await call(first, 'archive-manage', { operation: 'rename-archive', path: 'original.json', name: 'moved.json', expectedRevision: await revision(first) })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  const movedBytes = readFileSync(join(workspace, 'moved.json'))
  const stale = await call(second, 'save', { path: './original.json', expectedRevision: await revision(second) })
  assert.equal(stale.ok, false)
  assert.match(stale.error, /已移动或删除/)
  assert.equal(existsSync(join(workspace, 'original.json')), false)
  assert.deepEqual(readFileSync(join(workspace, 'moved.json')), movedBytes)
  assert.equal((await call(second, 'get')).value.save.name, '独立服务草稿')
  assert.equal((await call(second, 'save', { path: 'explicit-copy.json', expectedRevision: await revision(second) })).ok, true)
  assert.equal(JSON.parse(readFileSync(join(workspace, 'explicit-copy.json'), 'utf8')).meta.name, '独立服务草稿')
})
