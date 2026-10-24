import test from 'node:test'
import assert from 'node:assert/strict'
import { createSystemLanguageReader, localLanguageRequest, normalizeSystemLanguage } from '../host/system-language.js'

test('system language normalization accepts locale variants and rejects sentinels', () => {
  assert.equal(normalizeSystemLanguage(' zh_CN.UTF-8\n'), 'zh-CN')
  assert.equal(normalizeSystemLanguage('en_US'), 'en-US')
  assert.equal(normalizeSystemLanguage('C'), '')
  assert.equal(normalizeSystemLanguage('not a locale'), '')
})

test('system language reader uses host locale on non-Windows', async () => {
  const read = createSystemLanguageReader({ platform: 'linux', env: { LANG: 'en_US.UTF-8' } })
  assert.deepEqual(await read(), { language: 'en-US', source: 'host-locale' })
})

test('language endpoint only exposes host language to direct loopback requests', () => {
  const base = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4260' } }
  assert.equal(localLanguageRequest(base), true)
  assert.equal(localLanguageRequest({ ...base, socket: { remoteAddress: '10.0.0.2' } }), false)
  assert.equal(localLanguageRequest({ ...base, headers: { ...base.headers, forwarded: 'for=10.0.0.2' } }), false)
})
