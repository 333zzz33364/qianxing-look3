import { fileURLToPath } from 'node:url'
import { createImageSource } from '../studio/host/image-source.js'
import { spawnSync } from 'node:child_process'

const proxyIndex = process.argv.indexOf('--proxy')
if (proxyIndex >= 0) {
  const proxy = process.argv[proxyIndex + 1]
  if (!proxy || !/^https?:\/\//.test(proxy)) throw new Error('proxy must be an HTTP URL')
  const result = spawnSync(process.execPath, ['--use-env-proxy', fileURLToPath(import.meta.url)], {
    env: { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost' },
    stdio: 'inherit', windowsHide: true,
  })
  process.exit(result.status || 0)
}
const source = createImageSource(fileURLToPath(new URL('../look2-workspace/.look2-image-cache/', import.meta.url)))
const catalogue = await source.asset('catalog.json')
const data = JSON.parse(catalogue.data.toString('utf8'))
if (!data.imageData || !data.category) throw new Error('unexpected reference catalogue schema')
const idArgument = process.argv.indexOf('--image-id')
const imageId = idArgument >= 0 ? process.argv[idArgument + 1] : '100001'
if (!/^\d+$/.test(imageId) || !data.imageData[imageId]) throw new Error('unknown image ID')
const image = await source.asset(`sprite/${imageId}.png`)
if (!image.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('invalid material image PNG')
const border = await source.asset(`border/${imageId}.json`)
JSON.parse(border.data.toString('utf8'))
const background = await source.asset('canvas-background.png')
console.log(JSON.stringify({ imageCount: Object.keys(data.imageData).length, categories: Object.keys(data.category).length,
  imageBytes: image.data.length, backgroundBytes: background.data.length,
  cache: { catalogue: catalogue.cache, image: image.cache, border: border.cache, background: background.cache } }))
