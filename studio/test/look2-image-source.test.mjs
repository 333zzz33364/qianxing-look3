import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageSource } from '../host/image-source.js'

test('online catalogue and images share requests and persist for offline fallback', async () => {
  const path = await mkdtemp(join(tmpdir(), 'look2-images-'))
  let count = 0
  const fetcher = async url => { count++; return new Response(url.endsWith('.json') ? JSON.stringify({ imageData: { 100001: { id: 100001 } }, category: {} }) : Uint8Array.from([137, 80, 78, 71]), { headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'image/png' } }) }
  try {
    const source = createImageSource(path, { fetcher })
    const [a, b] = await Promise.all([source.asset('catalog.json'), source.asset('catalog.json')])
    assert.deepEqual(a.data, b.data); assert.equal(count, 1)
    await source.asset('sprite/100001.png'); assert.equal(count, 2)
    const offline = createImageSource(path, { fetcher: async () => { throw new Error('offline') }, ttl: -1 })
    assert.equal((await offline.asset('catalog.json')).cache, 'offline')
    assert.equal((await offline.asset('sprite/100001.png')).cache, 'hit')
    assert.equal(JSON.parse((await offline.asset('catalog.json')).data.toString()).imageData[100001].id, 100001)
  } finally { await rm(path, { recursive: true, force: true }) }
})
test('URL imports embed bytes and fail invalid formats without poisoning asset cache', async () => {
  const path = await mkdtemp(join(tmpdir(), 'look2-images-'))
  try {
    const source = createImageSource(path, { fetcher: async url => new Response('sample', { headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'text/html' } }) })
    const imported = await source.importUrl('https://example.invalid/a.png')
    assert.equal(Buffer.from(imported.data, 'base64').toString(), 'sample')
    await assert.rejects(source.importUrl('file:///tmp/x.png'), /HTTP\/HTTPS/)
    await assert.rejects(source.importUrl('https://example.invalid/login'), /没有返回支持的图片/)
    await assert.rejects(source.asset('../secret'), /无效的素材路径/)
  } finally { await rm(path, { recursive: true, force: true }) }
})
