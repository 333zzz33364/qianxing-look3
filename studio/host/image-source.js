import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fetchImage } from './image-fetch.js'

const REFERENCE_ROOT = 'https://oss.xiaomol444.xyz/ugc-tool-data/Public/CustomUIImage/'
const ALLOWED_ASSET = /^(?:catalog\.json|canvas-background\.png|(?:sprite|border)\/\d+\.(?:png|json))$/
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const pending = new Map()

async function fetchBytes(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_IMAGE_BYTES) throw new Error('图片超过32MB')
  const chunks = []; let count = 0
  for await (const chunk of response.body) {
    count += chunk.length
    if (count > MAX_IMAGE_BYTES) { await response.body.cancel?.().catch(() => {}); throw new Error('图片超过32MB') }
    chunks.push(Buffer.from(chunk))
  }
  return { data: Buffer.concat(chunks), mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' }
}

export function createImageSource(cacheDirectory, { fetcher = fetchImage, ttl = 24 * 60 * 60 * 1000 } = {}) {
  async function readCache(key) {
    try {
      const metadata = JSON.parse(await readFile(join(cacheDirectory, `${key}.json`), 'utf8'))
      const data = await readFile(join(cacheDirectory, `${key}.bin`))
      if (createHash('sha256').update(data).digest('hex') !== metadata.digest) return null
      return { ...metadata, data }
    } catch { return null }
  }
  async function cache(key, result) {
    await mkdir(cacheDirectory, { recursive: true })
    const suffix = `${process.pid}-${crypto.randomUUID()}`
    const bytesPath = join(cacheDirectory, `${key}.${suffix}.bin`)
    const metaPath = join(cacheDirectory, `${key}.${suffix}.json`)
    await writeFile(bytesPath, result.data)
    await writeFile(metaPath, JSON.stringify({ mimeType: result.mimeType, at: Date.now(), digest: createHash('sha256').update(result.data).digest('hex') }))
    await rename(bytesPath, join(cacheDirectory, `${key}.bin`))
    await rename(metaPath, join(cacheDirectory, `${key}.json`))
  }
  async function get(url, type) {
    const key = createHash('sha256').update(url).digest('hex')
    const cached = await readCache(key)
    // Catalogue refreshes once a day; immutable numbered images stay cached.
    if (cached && (type !== 'catalog' || Date.now() - cached.at < ttl)) return { ...cached, cache: 'hit' }
    const requestKey = `${cacheDirectory}\0${key}`
    if (!pending.has(requestKey)) pending.set(requestKey, (async () => {
      try {
        const result = await fetchBytes(url, fetcher)
        if (type === 'catalog' || type === 'border') JSON.parse(result.data.toString('utf8'))
        if (type === 'image' && !/^image\/(?:png|jpe?g|webp|gif|bmp)$/i.test(result.mimeType)) throw new Error('网址没有返回支持的图片格式')
        await cache(key, result)
        return { ...result, cache: 'download' }
      } catch (error) {
        if (cached) return { ...cached, cache: 'offline', warning: String(error.message || error) }
        throw error
      } finally { pending.delete(requestKey) }
    })())
    return pending.get(requestKey)
  }
  return {
    async asset(path) {
      if (!ALLOWED_ASSET.test(path)) throw new Error('无效的素材路径')
      const remote = path === 'catalog.json' ? 'data.json' : path
      if (path === 'canvas-background.png') return get('https://tool.xiaomol444.xyz/img/UIPage.524a5600.png', 'image')
      return get(new URL(remote, REFERENCE_ROOT).href, path === 'catalog.json' ? 'catalog' : path.startsWith('border/') ? 'border' : 'image')
    },
    async importUrl(value) {
      const url = new URL(String(value))
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用不含账号密码的 HTTP/HTTPS 图片网址')
      const result = await get(url.href, 'image')
      return { data: result.data.toString('base64'), mimeType: result.mimeType, cache: result.cache }
    },
  }
}
