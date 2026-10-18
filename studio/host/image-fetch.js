import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Readable } from 'node:stream'

// The local tool also runs under Node versions without --use-env-proxy.
// A configured proxy is preferred; direct access can fall back to the verified
// local proxy without changing global Node networking or browser settings.
async function throughProxy(value, proxyValue, redirects = 0) {
  const url = new URL(value), proxy = new URL(proxyValue)
  if (!['http:', 'https:'].includes(url.protocol) || !['http:', 'https:'].includes(proxy.protocol)) throw new Error('无效的图片代理配置')
  const transport = proxy.protocol === 'https:' ? https : http
  const proxyAuth = proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : ''
  const headers = proxyAuth ? { 'proxy-authorization': proxyAuth } : {}
  const send = (options, module) => new Promise((resolve, reject) => {
    const request = module.request(options, resolve)
    request.setTimeout(30_000, () => request.destroy(new Error('图片代理请求超时')))
    request.once('error', reject)
    request.end()
  })
  let response
  if (url.protocol === 'http:') {
    response = await send({ hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), path: url.href, method: 'GET', headers: { ...headers, host: url.host } }, transport)
  } else {
    const socket = await new Promise((resolve, reject) => {
      const request = transport.request({ hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${url.hostname}:${url.port || 443}`, headers })
      request.setTimeout(10_000, () => request.destroy(new Error('图片代理连接超时')))
      request.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`代理连接失败：HTTP ${response.statusCode}`)); return }
        if (head.length) socket.unshift(head)
        socket.setTimeout(30_000, () => socket.destroy(new Error('图片代理连接超时')))
        resolve(socket)
      })
      request.once('error', reject)
      request.end()
    })
    const agent = new https.Agent({ keepAlive: false })
    agent.createConnection = () => tls.connect({ socket, servername: url.hostname })
    try {
      response = await send({ hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`, method: 'GET', agent }, https)
    } catch (error) { agent.destroy(); socket.destroy(); throw error }
    response.once('close', () => agent.destroy())
  }
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume()
    if (redirects >= 5) throw new Error('图片网址重定向过多')
    return throughProxy(new URL(response.headers.location, url).href, proxyValue, redirects + 1)
  }
  return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
    headers: { get: key => response.headers[key.toLowerCase()] || null }, body: Readable.toWeb(response) }
}

export async function fetchImage(url, options = {}) {
  const configured = process.env.LOOK2_IMAGE_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  if (configured) return throughProxy(url, configured)
  try { return await fetch(url, { ...options, signal: AbortSignal.timeout(5_000) }) }
  catch (directError) {
    try { return await throughProxy(url, 'http://127.0.0.1:65532') }
    catch { throw directError }
  }
}
