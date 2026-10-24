import { EN } from './locales/en.js'

const STORAGE_KEY = 'qxqy-language'
const listeners = new Set()
let locale = 'zh-CN'
let initialized = false

function normalize(value) {
  return String(value || '').toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
}

function readStored() {
  try { return localStorage.getItem(STORAGE_KEY) || '' } catch { return '' }
}

export function getLanguagePreference() {
  const value = readStored()
  return value ? normalize(value) : null
}

export function getLocale() {
  if (!initialized) {
    initialized = true
    locale = getLanguagePreference() || normalize(globalThis.navigator?.language)
  }
  return locale
}

export function t(value, fallback = value) {
  const source = fallback == null ? value : fallback
  return getLocale().startsWith('en') ? (EN[value] || source) : source
}

function translateAttributes(root) {
  for (const element of root.querySelectorAll?.('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]') || []) {
    if (element.dataset.i18n) element.textContent = t(element.dataset.i18n)
    if (element.dataset.i18nTitle) element.title = t(element.dataset.i18nTitle)
    if (element.dataset.i18nPlaceholder) element.placeholder = t(element.dataset.i18nPlaceholder)
    if (element.dataset.i18nAriaLabel) element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel))
  }
}

export function localizePage(root = globalThis.document?.body) {
  if (!root || !getLocale().startsWith('en')) {
    if (root) translateAttributes(root)
    return
  }
  const walker = root.ownerDocument.createTreeWalker(root, 4)
  const nodes = []
  let node
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (parent && !['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'OPTION'].includes(parent.tagName)) nodes.push(node)
  }
  for (const text of nodes) {
    const value = text.nodeValue
    if (value && EN[value.trim()]) text.nodeValue = value.replace(value.trim(), EN[value.trim()])
  }
  translateAttributes(root)
}

export function setLanguagePreference(value) {
  locale = normalize(value)
  initialized = true
  try { localStorage.setItem(STORAGE_KEY, locale) } catch { /* optional */ }
  for (const listener of listeners) listener(locale)
  localizePage()
  return locale
}

export function subscribeLocale(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function loadSystemLanguage({ url = '', fetcher = globalThis.fetch } = {}) {
  if (!url || getLanguagePreference()) return { language: '', source: 'preference' }
  try {
    const response = await fetcher(url, { cache: 'no-store' })
    if (!response.ok) return { language: '', source: 'browser' }
    const value = await response.json()
    const language = normalize(value.language || globalThis.navigator?.language)
    locale = language
    initialized = true
    for (const listener of listeners) listener(locale)
    localizePage()
    return { ...value, language: locale }
  } catch {
    return { language: getLocale(), source: 'browser' }
  }
}

getLocale()
