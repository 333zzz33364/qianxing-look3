import { initializeCanvas, readPsd } from 'ag-psd'
import { convertPsdDocument, PSD_IMPORT_MAX_BYTES } from './look2-assets.js'

const scope = globalThis

function bytesToDataUrl(blob) {
  if (typeof scope.FileReaderSync === 'function') {
    return new scope.FileReaderSync().readAsDataURL(blob)
  }
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer)
    const chunks = []
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
    }
    return `data:${blob.type || 'image/png'};base64,${scope.btoa(chunks.join(''))}`
  })
}

async function encodeLayer(imageData) {
  if (typeof scope.OffscreenCanvas !== 'function') throw new Error('当前 Worker 不支持 OffscreenCanvas')
  const canvas = new scope.OffscreenCanvas(imageData.width, imageData.height)
  const context = canvas.getContext('2d')
  if (!context || typeof canvas.convertToBlob !== 'function') throw new Error('当前 Worker 无法编码 PNG 图层')
  const pixels = context.createImageData(imageData.width, imageData.height)
  pixels.data.set(new Uint8ClampedArray(imageData.data))
  context.putImageData(pixels, 0, 0)
  return bytesToDataUrl(await canvas.convertToBlob({ type: 'image/png' }))
}

function initializePsdCanvas() {
  const scratch = new scope.OffscreenCanvas(1, 1)
  const context = scratch.getContext('2d')
  if (!context || typeof context.createImageData !== 'function') {
    throw new Error('当前 Worker 无法为 PSD 图层创建 ImageData')
  }
  initializeCanvas(
    (width, height) => new scope.OffscreenCanvas(width ?? 1, height ?? 1),
    (width, height) => context.createImageData(width, height),
  )
}

function sendError(requestId, error) {
  if (typeof requestId !== 'string') return
  scope.postMessage({ type: 'error', requestId, error: String(error?.message || error || 'PSD 处理失败') })
}

scope.onmessage = async event => {
  const message = event?.data
  if (!message || message.type !== 'look2:parse-psd' || typeof message.requestId !== 'string') return
  try {
    if (!(message.buffer instanceof ArrayBuffer)) throw new Error('PSD Worker 没有收到文件数据')
    if (message.buffer.byteLength > PSD_IMPORT_MAX_BYTES) throw new Error('PSD 文件不能超过 128 MB')
    if (typeof scope.OffscreenCanvas !== 'function') throw new Error('当前浏览器不支持 OffscreenCanvas，无法在后台处理 PSD')
    initializePsdCanvas()
    const psd = readPsd(message.buffer, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true })
    const document = await convertPsdDocument(psd, message.fileName, encodeLayer)
    scope.postMessage({ type: 'success', requestId: message.requestId, document })
  } catch (error) {
    sendError(message.requestId, error)
  }
}
