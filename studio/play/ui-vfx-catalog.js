// UI 动效素材目录：官方 OSS 的 Public/UIVfx。
// 目录（data.json）与中文名（i18n/<locale>.json）分开加载；校验规则沿用上游：
// id 唯一、scope 只能是 ui/screen、宽高为正、isLoop 为布尔、nameI18nKey 为字符串。
// 资源路径只接受相对路径或 http(s)，拒绝 `..`、协议相对和带冒号的写法，避免越界。
export const UI_VFX_BASE = 'https://oss.xiaomol444.xyz/ugc-tool-data/Public/UIVfx'
export const UI_VFX_SCOPES = ['ui', 'screen']

function assetUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null
  if (/^https?:\/\//i.test(value)) return value
  if (value.includes(':') || value.includes('..') || value.startsWith('//')) return null
  return `${base}${value.startsWith('/') ? '' : '/'}${value}`
}

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

export function normalizeUIVfxCatalog(input, base = UI_VFX_BASE) {
  const catalog = input
  if (!catalog || !Array.isArray(catalog.data)) throw new Error('UI 动效目录缺少 data 数组')
  const ids = new Set()
  const assets = catalog.data.map((raw) => {
    const id = Number(raw?.id)
    const url = assetUrl(raw?.path, base)
    const width = positive(raw?.width)
    const height = positive(raw?.height)
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id) || !url
      || !UI_VFX_SCOPES.includes(raw?.scope) || !width || !height
      || typeof raw.isLoop !== 'boolean' || typeof raw.nameI18nKey !== 'string') {
      throw new Error(`UI 动效素材无效：${raw?.id ?? '<missing>'}`)
    }
    ids.add(id)
    return {
      id,
      nameI18nKey: raw.nameI18nKey,
      category: Number(raw.category),
      scope: raw.scope,
      tagList: Array.isArray(raw.tagList) ? raw.tagList.filter(Number.isSafeInteger) : [],
      url,
      icon: assetUrl(raw.icon, base),
      isLoop: raw.isLoop,
      width,
      height,
      audioUrls: raw.hasAudio && Array.isArray(raw.audioPath)
        ? raw.audioPath.map((item) => assetUrl(item, base)).filter(Boolean)
        : [],
    }
  })
  const tags = Array.isArray(catalog.tags)
    ? catalog.tags
      .filter((tag) => Number.isSafeInteger(tag?.id) && typeof tag?.nameI18nKey === 'string')
      .map((tag) => ({ id: tag.id, nameI18nKey: tag.nameI18nKey }))
    : []
  const categories = Array.isArray(catalog.category)
    ? catalog.category
      .filter((item) => Number.isSafeInteger(item?.id) && typeof item?.nameI18nKey === 'string')
      .map((item) => ({ id: item.id, nameI18nKey: item.nameI18nKey, scope: UI_VFX_SCOPES.includes(item.scope) ? item.scope : 'ui' }))
    : []
  return { assets, tags, categories }
}

export function createUIVfxCatalog({ base = UI_VFX_BASE, locale = 'zh-cn', fetchImpl = null } = {}) {
  let assets = []
  let tags = []
  let categories = []
  let labels = {}
  let pending = null
  let loaded = false
  let failed = false

  const request = async (url) => {
    const impl = fetchImpl || globalThis.fetch
    if (typeof impl !== 'function') throw new Error('当前环境没有可用的 fetch')
    const response = await impl(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`UI 动效资源请求失败：${response.status} ${url}`)
    return response.json()
  }

  function load(refresh = false) {
    if (pending) return pending
    if (loaded && !refresh) return Promise.resolve()
    pending = (async () => {
      failed = false
      try {
        const [catalog, translation] = await Promise.all([
          request(`${base}/data.json`),
          request(`${base}/i18n/${locale}.json`).catch(() => null),
        ])
        const normalized = normalizeUIVfxCatalog(catalog, base)
        assets = normalized.assets
        tags = normalized.tags
        categories = normalized.categories
        labels = translation && typeof translation === 'object' ? translation : {}
        loaded = true
      } catch (error) {
        failed = true
        throw error
      } finally {
        pending = null
      }
    })()
    return pending
  }

  const text = (key) => (typeof labels[key] === 'string' ? labels[key] : '')

  return {
    load,
    get assets() { return assets },
    get tags() { return tags },
    get categories() { return categories },
    get failed() { return failed },
    byId(id) {
      const value = Number(id)
      return Number.isSafeInteger(value) ? assets.find((asset) => asset.id === value) || null : null
    },
    label(asset) {
      if (!asset) return ''
      return text(asset.nameI18nKey) || `#${asset.id}`
    },
    tagLabel(tag) {
      if (!tag) return ''
      return text(tag.nameI18nKey) || `#${tag.id}`
    },
    categoryLabel(id) {
      const category = categories.find((item) => item.id === Number(id))
      return category ? text(category.nameI18nKey) || `#${category.id}` : ''
    },
  }
}

export const uiVfxCatalog = createUIVfxCatalog()
