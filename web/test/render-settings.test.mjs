import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'

test('render settings endpoint reads the geometry default and persists the contour choice', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look3-render-endpoint-'))
  const configPath = join(directory, 'render.json')
  const previous = process.env.QXQY_RENDER_CONFIG_PATH
  process.env.QXQY_RENDER_CONFIG_PATH = configPath
  const app = await createWebServer({ workspace: directory, port: 0 })
  t.after(async () => {
    await app.close()
    if (previous === undefined) delete process.env.QXQY_RENDER_CONFIG_PATH
    else process.env.QXQY_RENDER_CONFIG_PATH = previous
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  const initial = await fetch(`${app.url}/api/render-settings`)
  const first = await initial.json()
  assert.equal(initial.status, 200)
  assert.equal(first.ok, true)
  assert.equal(first.value.maskContour, 'geometry', 'a missing config file falls back to the device rule')

  const saved = await fetch(`${app.url}/api/render-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maskContour: 'contour' }),
  })
  const second = await saved.json()
  assert.equal(saved.status, 200, JSON.stringify(second))
  assert.equal(second.value.maskContour, 'contour')
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { maskContour: 'contour' })

  const reread = await (await fetch(`${app.url}/api/render-settings`)).json()
  assert.equal(reread.value.maskContour, 'contour', 'the setting survives a fresh read')

  const rejected = await fetch(`${app.url}/api/render-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maskContour: 'alpha' }),
  })
  assert.ok(rejected.status >= 400, String(rejected.status))
  assert.match((await rejected.json()).error, /遮罩覆盖规则/)
})
