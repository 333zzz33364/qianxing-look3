import test from 'node:test'
import assert from 'node:assert/strict'
import { getLocale, getLanguagePreference, setLanguagePreference, t } from '../i18n.js'

test('i18n keeps Chinese default and supports explicit English preference', () => {
  assert.equal(getLanguagePreference(), null)
  assert.equal(getLocale(), 'zh-CN')
  assert.equal(t('检查更新'), '检查更新')
  const values = new Map()
  globalThis.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }
  setLanguagePreference('en-US')
  assert.equal(getLanguagePreference(), 'en-US')
  assert.equal(t('检查更新'), 'Check for updates')
  setLanguagePreference('zh-CN')
  assert.equal(t('检查更新'), '检查更新')
})
