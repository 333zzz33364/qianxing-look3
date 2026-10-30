import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUIVfxCatalog, createUIVfxCatalog, UI_VFX_BASE } from '../play/ui-vfx-catalog.js'

const asset = (over = {}) => ({
  id: '10001001',
  nameI18nKey: 'uiEffect.title.10001001',
  category: 1,
  scope: 'ui',
  tagList: [3, 15],
  path: '/video/10001001.webm',
  isLoop: true,
  width: 182,
  height: 182,
  hasAudio: false,
  audioPath: [],
  icon: '/icon/10001001.png',
  ...over,
})

const catalogOf = (data, extra = {}) => ({
  data,
  category: [{ id: 1, nameI18nKey: 'uiEffect.category.1', scope: 'ui' }],
  tags: [{ id: 3, nameI18nKey: 'uiEffect.tags.3' }],
  ...extra,
})

test('catalog normalizes assets, icon, audio, tags and categories against the OSS base', () => {
  const { assets, tags, categories } = normalizeUIVfxCatalog(catalogOf([
    asset(),
    asset({ id: '10001017', path: '/video/10001017.webm', hasAudio: true, audioPath: ['/audio/10001017.mp3'], isLoop: false }),
  ]))
  assert.equal(assets.length, 2)
  assert.equal(assets[0].id, 10001001)
  assert.equal(assets[0].url, `${UI_VFX_BASE}/video/10001001.webm`)
  assert.equal(assets[0].icon, `${UI_VFX_BASE}/icon/10001001.png`)
  assert.deepEqual(assets[0].tagList, [3, 15])
  assert.deepEqual(assets[1].audioUrls, [`${UI_VFX_BASE}/audio/10001017.mp3`])
  assert.equal(assets[1].isLoop, false)
  assert.deepEqual(tags, [{ id: 3, nameI18nKey: 'uiEffect.tags.3' }])
  assert.deepEqual(categories, [{ id: 1, nameI18nKey: 'uiEffect.category.1', scope: 'ui' }])
})

test('catalog rejects malformed entries instead of importing half of them', () => {
  const invalid = [
    ['missing data array', { tags: [] }, /缺少 data 数组/],
    ['duplicate id', catalogOf([asset(), asset()]), /素材无效/],
    ['unknown scope', catalogOf([asset({ scope: 'world' })]), /素材无效/],
    ['zero width', catalogOf([asset({ width: 0 })]), /素材无效/],
    ['non-boolean loop', catalogOf([asset({ isLoop: 'yes' })]), /素材无效/],
    ['missing name key', catalogOf([asset({ nameI18nKey: null })]), /素材无效/],
  ]
  for (const [label, input, pattern] of invalid) {
    assert.throws(() => normalizeUIVfxCatalog(input), pattern, label)
  }
})

test('catalog refuses path escapes and protocol-relative resources', () => {
  for (const path of ['../secret.webm', '//evil.example/x.webm', 'javascript:alert(1)']) {
    const input = catalogOf([asset({ path })])
    assert.throws(() => normalizeUIVfxCatalog(input), /素材无效/, path)
  }
  for (const path of ['https://cdn.example/a.webm', 'http://cdn.example/b.webm']) {
    const absolute = normalizeUIVfxCatalog(catalogOf([asset({ path })]))
    assert.equal(absolute.assets[0].url, path)
  }
})

test('catalog loader resolves Chinese names and falls back to the numeric id', async () => {
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(url)
    const body = url.endsWith('/data.json')
      ? catalogOf([asset()])
      : { 'uiEffect.title.10001001': '雷能量满值1', 'uiEffect.category.1': '循环特效' }
    return { ok: true, status: 200, json: async () => body }
  }
  const catalog = createUIVfxCatalog({ fetchImpl, base: 'https://example.test/UIVfx' })
  await catalog.load()
  assert.deepEqual(requests.sort(), ['https://example.test/UIVfx/data.json', 'https://example.test/UIVfx/i18n/zh-cn.json'])
  assert.equal(catalog.label(catalog.byId(10001001)), '雷能量满值1')
  assert.equal(catalog.categoryLabel(1), '循环特效')
  const unknown = createUIVfxCatalog({ fetchImpl: async (url) => ({
    ok: true, status: 200, json: async () => (url.endsWith('/data.json') ? catalogOf([asset()]) : {}),
  }) })
  await unknown.load()
  assert.equal(unknown.label(unknown.byId(10001001)), '#10001001')
})

test('catalog loader survives a missing translation file but reports catalog failure', async () => {
  const partial = createUIVfxCatalog({
    fetchImpl: async (url) => (url.endsWith('/data.json')
      ? { ok: true, status: 200, json: async () => catalogOf([asset()]) }
      : { ok: false, status: 404, json: async () => ({}) }),
  })
  await partial.load()
  assert.equal(partial.failed, false)
  assert.equal(partial.label(partial.byId(10001001)), '#10001001')

  const broken = createUIVfxCatalog({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
  await assert.rejects(() => broken.load(), /503/)
  assert.equal(broken.failed, true)
})

test('catalog exposes empty state before loading and rejects ids outside the catalog', async () => {
  const catalog = createUIVfxCatalog({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => catalogOf([asset()]) }) })
  assert.deepEqual(catalog.assets, [])
  assert.equal(catalog.byId(10001001), null)
  await catalog.load()
  assert.equal(catalog.byId(10001001).id, 10001001)
  assert.equal(catalog.byId(99999999), null)
  assert.equal(catalog.byId('abc'), null)
})
