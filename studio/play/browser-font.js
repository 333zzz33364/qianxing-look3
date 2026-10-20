import { DEFAULT_FONT, FONT_ROUTE, MAX_FONT_BYTES, fontFamily, fontStack } from '../fonts.js'

let pending
let loadedStack = DEFAULT_FONT
export const browserFontStack = () => loadedStack
export function loadBrowserFont() {
  pending ||= load().catch(error => { pending = null; throw error })
  return pending
}

async function load() {
  const options = { cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', signal: AbortSignal.timeout(10_000) }
  const manifest = await fetch(`${FONT_ROUTE}/manifest`, options)
  if (!manifest.ok) throw new Error('无法读取本地字体配置，请检查宿主配置及本机连接')
  const { id, scope = 'all' } = await manifest.json()
  const styleId = 'qxqy-local-font-style'
  if (id === null) {
    loadedStack = DEFAULT_FONT
    document.getElementById(styleId)?.remove()
    return null
  }
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('本地字体标识无效')
  const response = await fetch(`${FONT_ROUTE}/file/${id}`, options)
  if (!response.ok) throw new Error('本地字体加载失败，请重启宿主并刷新页面')
  const bytes = await response.arrayBuffer()
  if (!bytes.byteLength || bytes.byteLength > MAX_FONT_BYTES) throw new Error('本地字体大小无效')
  const face = new FontFace(fontFamily(id), bytes)
  await face.load()
  document.fonts.add(face)
  loadedStack = fontStack(id)
  let style = document.getElementById(styleId)
  if (scope === 'game') {
    style?.remove()
  } else {
    if (!style) {
      style = document.createElement('style')
      style.id = styleId
      document.head.append(style)
    }
    style.textContent = `[data-qxqy-font-ui], [data-qxqy-font-ui] * { font-family: ${loadedStack} !important; }`
  }
  return loadedStack
}
