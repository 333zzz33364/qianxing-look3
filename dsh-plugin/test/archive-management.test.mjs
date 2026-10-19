import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

test('DSH routes workspace management, remaps bound sessions and exposes archive delete/reveal failures', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'look3-dsh-managed-'))
  const routes = [], tools = [], cleanups = []
  apply({
    tools: { register(tool) { tools.push(tool) } }, webServer: { register(route) { routes.push(route) } },
    effect(factory) { const cleanup = factory(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    get(name) { if (name === 'sessions') return { get: () => ({ header: { cwd: workspace } }) } },
  })
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); rmSync(workspace, { recursive: true, force: true }) })
  const api = routes.find(route => route.path === '/look3-simulator/api')
  const call = (sessionId, action, data = {}) => new Promise(resolve => {
    const request = { method: 'POST', url: `/look3-simulator/api/${action}`,
      once() { return request }, destroy() {},
      on(event, listener) {
        if (event === 'data') queueMicrotask(() => listener(Buffer.from(JSON.stringify({ sessionId, ...data }))))
        if (event === 'end') queueMicrotask(listener)
        return request
      } }
    void api.handler(request, { setHeader() {}, end(text) { resolve(JSON.parse(text)) } })
  })
  const get = async id => (await call(id, 'get')).value
  const manage = async (id, body) => call(id, 'archive-manage', { ...body, expectedRevision: (await get(id)).version })
  const created = await manage('a', { operation: 'create-workspace', name: '项目' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.ok(created.value.workspaces.some(row => row.path === '工作区/项目'))
  await call('a', 'save', { path: '工作区/项目/a.json', expectedRevision: (await get('a')).version })
  await call('b', 'load-archive', { path: '工作区/项目/a.json' })
  const bytes = readFileSync(join(workspace, '工作区/项目/a.json'))
  const renamed = await manage('a', { operation: 'rename-archive', path: '工作区/项目/a.json', name: 'b.json' })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))
  assert.equal((await get('b')).storage.path, '工作区/项目/b.json')
  assert.deepEqual(readFileSync(join(workspace, '工作区/项目/b.json')), bytes)
  assert.equal((await call('b', 'save', { path: '工作区/项目/a.json', expectedRevision: (await get('b')).version })).ok, false)
  assert.equal(existsSync(join(workspace, '工作区/项目/a.json')), false)
  const loadTool = tools.find(tool => tool.name === 'look3_studio_load')
  const toolResult = await loadTool.execute({ operation: 'rename-workspace', path: '工作区/项目', name: '新项目', expectedRevision: (await get('a')).version }, { agent: { id: 'a', session: { header: { cwd: workspace } } } })
  assert.equal(toolResult.path, '工作区/新项目')
  assert.equal((await get('b')).storage.path, '工作区/新项目/b.json')
  assert.deepEqual(readFileSync(join(workspace, '工作区/新项目/b.json')), bytes)
  assert.match((await call('a', 'reveal-archive', { path: 'missing.json' })).error, /file does not exist/)
  const deleted = await call('a', 'delete-archive', { path: '工作区/新项目/b.json' })
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  assert.equal(existsSync(join(workspace, '工作区/新项目/b.json')), false)
})
