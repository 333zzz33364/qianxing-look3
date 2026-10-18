const uid = prefix => `${prefix}_${crypto.randomUUID()}`
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

function imageResource(name, imageUrl) {
  const id = uid('resource')
  return { id, name, imageUrl, imageResourceId: null, fitData: null,
    fitOptions: { defaultsVersion: 1, count: 400, resolution: 512, workers: 16, shapes: ['ellipse', 'rectangle'], transparent: true }, previewMode: 'image' }
}

function node(name, parentId, x, y, width, height, resourceId = '', options = {}) {
  const local = options.local === true
  return { id: uid('node'), parentId, name, type: resourceId ? 'primitive' : 'container', active: true, visible: options.visible !== false,
    x: local ? 800 + x : x, y: local ? 450 + y : y, width, height,
    scaleX: Number(options.scaleX ?? 1), scaleY: Number(options.scaleY ?? 1), scaleZ: 1,
    rotationX: 0, rotationY: 0, rotation: Number(options.rotation || 0),
    anchorMinX: local || resourceId ? .5 : 0, anchorMinY: local || resourceId ? .5 : 0,
    anchorMaxX: local || resourceId ? .5 : 1, anchorMaxY: local || resourceId ? .5 : 1,
    pivotX: .5, pivotY: .5, anchorOffsetX: local ? x : resourceId ? x - 800 : 0,
    anchorOffsetY: local ? y : resourceId ? y - 450 : 0, sizeDeltaX: local || resourceId ? width : 0, sizeDeltaY: local || resourceId ? height : 0,
    canControllerFocus: false, locked: false,
    properties: resourceId ? { imageUrl: '', imageResourceId: resourceId, previewMode: 'image', imageSource: 'primitive',
      imageId: 100001, imageColor: { r: 255, g: 255, b: 255, a: 1 }, imageType: 'basic',
      enableMask: false, enableSoftEdge: false, fillType: 'unused' } : {
      isolateNavigation: false, disableKeyEventPassthrough: false, disableCursorEventPassthrough: false, showCursor: false,
    } }
}

function document(name, nodes, resources, animations = [], warnings = []) {
  const normalized = animations.length ? animations : [{ id: uid('animation'), name: '默认动画', duration: 5, keyframeTracks: [] }]
  return { version: 12, hierarchyLayoutVersion: 2, controlModelVersion: 2, timelineModelVersion: 10,
    name, deviceMode: 'pc', previewPresetId: 'pc-16-9', canvasWidth: 1600, canvasHeight: 900,
    duration: normalized[0].duration, frameRate: 30, nodes, controlTemplates: [], primitiveResources: resources,
    giaSource: null, tweenTracks: [], keyframeTracks: normalized[0].keyframeTracks,
    animationModelVersion: 1, animations: normalized, activeAnimationId: normalized[0].id,
    timelineSnapEnabled: true, showContainerBones: true, giaImportStatus: warnings.join('；') }
}

function dataUrl(imageData) {
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = imageData.width; canvas.height = imageData.height
  const ctx = canvas.getContext('2d')
  const pixels = new Uint8ClampedArray(imageData.data)
  const bitmap = typeof ImageData === 'function'
    ? new ImageData(pixels, imageData.width, imageData.height)
    : ctx.createImageData(imageData.width, imageData.height)
  if (bitmap.data !== pixels) bitmap.data.set(pixels)
  ctx.putImageData(bitmap, 0, 0)
  return canvas.toDataURL('image/png')
}

function layerImageData(layer) {
  if (layer.imageData?.data && layer.imageData.width && layer.imageData.height) return layer.imageData
  if (layer.canvas?.width && layer.canvas?.height) {
    const ctx = layer.canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) return ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height)
  }
  return null
}

export function applyLayerMasks(imageData, layer, masks, warnings) {
  if (!imageData || !masks.length) return imageData
  const data = new Uint8ClampedArray(imageData.data)
  const layerLeft = Number(layer.left || 0), layerTop = Number(layer.top || 0)
  for (const maskLayer of masks) {
    // Match the reference editor: select one channel, without fallback or double application.
    const mask = maskLayer.realMask ?? maskLayer.mask
    if (!mask || mask.disabled || mask.fromVectorData === true && maskLayer.vectorMask?.disable === true) continue
    const maskPixels = mask.imageData
    const hasPixels = !!(maskPixels?.data && maskPixels.width && maskPixels.height)
    if (!hasPixels) {
      if (mask.fromVectorData || mask.vectorMask || maskLayer.vectorMask) warnings.add(`图层“${maskLayer.name || layer.name || ''}”的矢量蒙版没有像素蒙版数据，已按蒙版默认颜色导入`)
      else warnings.add(`图层“${maskLayer.name || layer.name || ''}”的蒙版没有可读取的像素数据，已按蒙版默认颜色导入`)
    }
    const relative = mask.positionRelativeToLayer === true
    const maskLeft = Number(mask.left || 0) + (relative ? Number(maskLayer.left || 0) : 0)
    const maskTop = Number(mask.top || 0) + (relative ? Number(maskLayer.top || 0) : 0)
    let density = Number(mask.userMaskDensity ?? 255)
    if (density <= 1) density *= 255
    density = clamp(density, 0, 255) / 255
    const outside = clamp(Number(mask.defaultColor ?? 255), 0, 255) / 255
    const inverted = mask.invert === true
    if (Number(mask.userMaskFeather ?? 0) > 0) warnings.add(`图层“${maskLayer.name || layer.name || ''}”的蒙版带有羽化；读取器未再次应用羽化效果`)
    for (let y = 0; y < imageData.height; y += 1) {
      const maskY = layerTop + y - maskTop
      for (let x = 0; x < imageData.width; x += 1) {
        const maskX = layerLeft + x - maskLeft
        let value = outside
        if (hasPixels && maskX >= 0 && maskY >= 0 && maskX < maskPixels.width && maskY < maskPixels.height) {
          const index = (Math.floor(maskY) * maskPixels.width + Math.floor(maskX)) * (maskPixels.data.length >= maskPixels.width * maskPixels.height * 4 ? 4 : 1)
          value = Number(maskPixels.data[index] ?? 255) / 255
        }
        if (inverted) value = 1 - value
        value = 1 - density * (1 - value)
        const alphaIndex = (y * imageData.width + x) * 4 + 3
        data[alphaIndex] = Math.round(data[alphaIndex] * value)
      }
    }
  }
  return { width: imageData.width, height: imageData.height, data }
}

function opacityFactor(value) {
  const number = Number(value ?? 1)
  if (!Number.isFinite(number)) return 1
  return clamp(number > 1 ? number / 255 : number, 0, 1)
}

function transparentPixelData() {
  return { width: 1, height: 1, data: new Uint8ClampedArray(4) }
}

function layerBounds(layer, childrenBounds) {
  if (layer.children?.length) {
    const rows = childrenBounds.filter(Boolean)
    if (rows.length) {
      const left = Math.min(...rows.map(row => row.left)), top = Math.min(...rows.map(row => row.top))
      const right = Math.max(...rows.map(row => row.left + row.width)), bottom = Math.max(...rows.map(row => row.top + row.height))
      return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
    }
    return { left: Number(layer.left || 0), top: Number(layer.top || 0), width: 1, height: 1 }
  }
  const pixels = layerImageData(layer)
  if (!pixels) return { left: Number(layer.left || 0), top: Number(layer.top || 0), width: 1, height: 1 }
  return { left: Number(layer.left || 0), top: Number(layer.top || 0), width: pixels.width, height: pixels.height }
}

export async function convertPsdDocument(psd, fileName, encodeImage = dataUrl) {
  const colorMode = psd?.colorMode
  const bitsPerChannel = psd?.bitsPerChannel
  if (colorMode != null && ![0, 1, 3].includes(Number(colorMode))) {
    const modeName = ({ 2: '索引色', 4: 'CMYK', 7: '多通道', 8: '双色调', 9: 'Lab' })[Number(colorMode)] || `编号 ${colorMode}`
    throw new Error(`PSD 颜色模式 ${modeName} 暂不支持；请先转换为 RGB 或灰度模式`)
  }
  const bitmapMode = Number(colorMode) === 0
  if (bitsPerChannel != null && Number(bitsPerChannel) !== 8 && !(bitmapMode && Number(bitsPerChannel) === 1)) {
    throw new Error(`PSD 当前只支持 8 位每通道；位图模式支持 1 位，收到 ${bitsPerChannel} 位`)
  }
  const width = Math.max(1, Number(psd.width || 1600)), height = Math.max(1, Number(psd.height || 900))
  const sourceLayers = Array.isArray(psd.children) ? psd.children : []
  if (!sourceLayers.length) throw new Error('PSD 中没有图层')
  const warnings = new Set(), bounds = new Map(), pixelsByLayer = new Map()
  let layerCount = 0
  const inspect = (layer, depth) => {
    layerCount += 1
    if (layerCount > 1024) throw new Error('PSD 图层数不能超过 1024')
    if (depth > 64) throw new Error('PSD 图层嵌套不能超过 64 层')
    if (layer.children?.length) {
      const childBounds = layer.children.map(child => inspect(child, depth + 1))
      const box = layerBounds(layer, childBounds)
      bounds.set(layer, box)
      return box
    }
    const pixels = layerImageData(layer)
    if (pixels && pixels.width * pixels.height > 32 * 1024 * 1024) throw new Error(`PSD 图层“${layer.name || ''}”超过 32 百万像素`)
    pixelsByLayer.set(layer, pixels || transparentPixelData())
    const box = layerBounds(layer)
    bounds.set(layer, box)
    return box
  }
  for (const layer of sourceLayers) inspect(layer, 1)

  const rootName = String(fileName || 'PSD').replace(/\.psd$/i, '')
  const root = node(rootName, null, 0, 0, width, height, '', { local: true })
  const nodes = [root], resources = []
  const sourceCenter = { x: width / 2, y: height / 2 }
  const visit = async (layers, parentId, parentCenter, inheritedMasks = [], inheritedOpacity = 1) => {
    for (const layer of [...(layers || [])].reverse()) {
      const box = bounds.get(layer)
      const centerX = box.left + box.width / 2, centerY = box.top + box.height / 2
      const x = centerX - parentCenter.x, y = parentCenter.y - centerY
      const opacity = inheritedOpacity * opacityFactor(layer.opacity) * opacityFactor(layer.fillOpacity)
      const masks = [...inheritedMasks, layer]
      const label = layer.name || '未命名图层'
      const mode = String(layer.blendMode || 'normal').replace(/[\s_-]/g, '').toLowerCase()
      if (layer.clipping) warnings.add(`图层“${label}”使用剪贴关系；该关系无法烘焙到单独的像素层`)
      if (mode !== 'normal' && mode !== 'passthrough') warnings.add(`图层“${label}”使用 ${layer.blendMode} 混合模式；导入保留原像素并按普通混合显示`)
      if (layer.adjustment || layer.adjustments) warnings.add(`图层“${label}”是调整图层；调整效果未烘焙`)
      if (layer.vectorMask && !layer.vectorMask.disable) {
        const mask = layer.realMask ?? layer.mask, pixels = mask?.imageData
        if (mask?.fromVectorData === true && !mask.disabled && pixels?.data && pixels.width && pixels.height) {
          warnings.add(`图层“${label}”的矢量蒙版已按 PSD 保存的栅格通道烘焙；矢量路径不可编辑`)
        } else if (mask?.fromVectorData === true && mask.disabled) {
          warnings.add(`图层“${label}”的矢量蒙版未烘焙；PSD 保存的栅格通道已禁用`)
        } else warnings.add(`图层“${label}”使用矢量蒙版；当前读取器没有可烘焙的矢量蒙版像素`)
      }
      if (layer.realMask && layer.mask) {
        if (layer.realMask.disabled) warnings.add(`图层“${label}”的优先蒙版通道已禁用；备用通道未应用`)
        else warnings.add(`图层“${label}”的多通道像素蒙版按参考站优先通道导入，未重复叠加`)
      }
      if (layer.effects && Object.keys(layer.effects).length) warnings.add(`图层“${label}”含图层样式；效果未烘焙进分层像素`)
      if (layer.children?.length) {
        if (opacityFactor(layer.opacity) * opacityFactor(layer.fillOpacity) !== 1) warnings.add(`文件夹“${label}”的不透明度已分摊到子图层，重叠区域可能不同`)
        const group = node(label, parentId, x, y, box.width, box.height, '', { local: true, visible: layer.hidden !== true })
        nodes.push(group)
        await visit(layer.children, group.id, { x: centerX, y: centerY }, masks, opacity)
        continue
      }
      let pixels = pixelsByLayer.get(layer) || transparentPixelData()
      const baked = applyLayerMasks(pixels, layer, masks, warnings)
      if (opacity !== 1) {
        const data = new Uint8ClampedArray(baked.data)
        for (let index = 3; index < data.length; index += 4) data[index] = Math.round(data[index] * opacity)
        pixels = { width: baked.width, height: baked.height, data }
      } else pixels = baked
      const resource = imageResource(label, await encodeImage(pixels)); resources.push(resource)
      const image = node(label, parentId, x, y, box.width, box.height, resource.id, { local: true, visible: layer.hidden !== true })
      nodes.push(image)
    }
  }
  await visit(sourceLayers, root.id, sourceCenter)
  return document(root.name, nodes, resources, [], [...warnings])
}

export const PSD_IMPORT_MAX_BYTES = 128 * 1024 * 1024
export const PSD_IMPORT_TIMEOUT_MS = 120_000

function psdAbortError() {
  const error = new Error('PSD 导入已取消')
  error.name = 'AbortError'
  return error
}

function defaultPsdWorkerUrl() {
  const pathname = String(globalThis.location?.pathname || '')
  return pathname === '/look2-simulator' || pathname.startsWith('/look2-simulator/')
    ? '/look2-simulator/look2-psd-worker.js'
    : '/look2-psd-worker.js'
}

function validPsdDocument(value) {
  return !!value && typeof value === 'object' && value.version === 12
    && Array.isArray(value.nodes) && Array.isArray(value.primitiveResources) && Array.isArray(value.animations)
}

export async function importPsd(file, canvas, options = {}) {
  const settings = options || {}
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('PSD 文件不可读取')
  if (Number(file.size) > PSD_IMPORT_MAX_BYTES) throw new Error('PSD 文件不能超过 128 MB')
  const signal = settings.signal
  if (signal?.aborted) throw psdAbortError()
  const WorkerCtor = settings.Worker || globalThis.Worker
  if (!settings.createWorker && typeof WorkerCtor !== 'function') throw new Error('当前浏览器不支持 Web Worker，无法后台处理 PSD')
  const createWorker = settings.createWorker || (url => new WorkerCtor(url))
  const hasOffscreenCanvas = settings.offscreenCanvasSupported ?? typeof globalThis.OffscreenCanvas === 'function'
  if (!hasOffscreenCanvas) throw new Error('当前浏览器不支持 OffscreenCanvas，无法在后台处理 PSD')
  if (typeof createWorker !== 'function') throw new Error('当前浏览器不支持 Web Worker，无法在后台处理 PSD')

  const buffer = await file.arrayBuffer()
  if (signal?.aborted) throw psdAbortError()
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > PSD_IMPORT_MAX_BYTES) throw new Error('PSD 文件不能超过 128 MB 或无法读取')
  const workerUrl = String(settings.workerUrl || defaultPsdWorkerUrl())
  const timeoutMs = Math.min(PSD_IMPORT_TIMEOUT_MS, Math.max(1, Number(settings.timeoutMs) || PSD_IMPORT_TIMEOUT_MS))
  const requestId = uid('psd')

  return new Promise((resolve, reject) => {
    let worker
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate?.()
      }
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(psdAbortError())
    const timer = setTimeout(() => finish(new Error(`PSD 导入超过 ${Math.ceil(timeoutMs / 1000)} 秒，已取消`)), timeoutMs)
    try {
      worker = createWorker(workerUrl)
    } catch (error) {
      finish(new Error(`无法启动 PSD Worker：${error?.message || error}`))
      return
    }
    worker.onmessage = event => {
      const message = event?.data
      if (!message || typeof message !== 'object') return finish(new Error('PSD Worker 返回的消息格式无效'))
      if (message.requestId !== requestId) return finish(new Error('PSD Worker 响应编号不匹配'))
      if (message.type === 'error') return finish(new Error(String(message.error || 'PSD Worker 处理失败')))
      if (message.type !== 'success' || !validPsdDocument(message.document)) return finish(new Error('PSD Worker 返回的文档格式无效'))
      finish(null, message.document)
    }
    worker.onerror = event => finish(new Error(`PSD Worker 出错：${event?.message || '未知错误'}`))
    worker.onmessageerror = () => finish(new Error('无法读取 PSD Worker 返回的数据'))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      worker.postMessage({ type: 'look2:parse-psd', requestId, fileName: String(file.name || 'PSD.psd'), buffer }, [buffer])
    } catch (error) {
      finish(new Error(`无法发送 PSD 到 Worker：${error?.message || error}`))
    }
  })
}

function resolveImage(files, path) {
  const normalized = withoutImageExtension(String(path || '').replace(/\\/g, '/')).toLowerCase()
  const rows = files.map(file => ({
    file,
    name: withoutImageExtension(String(file.name || '').replace(/\\/g, '/')).toLowerCase(),
    path: withoutImageExtension(String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/').replace(/^\.\//, '')).toLowerCase(),
  }))
  const matches = normalized.includes('/')
    ? rows.filter(row => row.path === normalized || row.path.endsWith(`/${normalized}`) || row.name === normalized)
    : rows.filter(row => row.name.split('/').at(-1) === normalized)
  const unique = [...new Set(matches.map(row => row.file))]
  if (unique.length > 1) throw new Error(`Spine 图片路径不唯一：${path}`)
  return unique[0]
}

function fileDataUrl(file) {
  if (typeof FileReader === 'undefined') return file.arrayBuffer().then(buffer => `data:${file.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`)
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
}

function spineColor(hex) {
  const text = String(hex || 'ffffffff').replace(/^#/, '')
  if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) throw new Error(`Spine 颜色格式错误：${hex}`)
  const value = text.length === 6 ? `${text}ff` : text
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16), a: parseInt(value.slice(6, 8), 16) / 255 }
}

function multiplyColor(left, right) {
  return { r: Math.round(left.r * right.r / 255), g: Math.round(left.g * right.g / 255),
    b: Math.round(left.b * right.b / 255), a: left.a * right.a }
}

function bezierYAtX(curve, x) {
  if (!Array.isArray(curve) || curve.length !== 4 || !curve.every(Number.isFinite) || curve[0] < 0 || curve[0] > 1 || curve[2] < 0 || curve[2] > 1) {
    throw new Error('Spine Bezier 曲线需要四个数值，且 X 控制点须在 0–1 范围内')
  }
  const [x1, y1, x2, y2] = curve
  const cubic = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
  let low = 0, high = 1, parameter = x
  for (let i = 0; i < 32; i += 1) {
    parameter = (low + high) / 2
    if (cubic(parameter, x1, x2) < x) low = parameter
    else high = parameter
  }
  return cubic(parameter, y1, y2)
}

function spineKeys(frames, mapValue, durationRef) {
  const source = [...(frames || [])].map(frame => ({ ...frame, time: Number(frame.time ?? 0) }))
    .sort((a, b) => a.time - b.time)
  if (source.some(frame => !Number.isFinite(frame.time) || frame.time < 0)) throw new Error('Spine 动画帧包含非法时间')
  const output = []
  const put = (time, value, interpolation = 'tween') => {
    const last = output[output.length - 1]
    if (last && Math.abs(last.time - time) <= 1e-9) { last.value = value; last.interpolation = interpolation; return }
    output.push({ id: uid('key'), time, value, easeType: 'Linear', interpolation })
  }
  for (let index = 0; index < source.length; index += 1) {
    const frame = source[index], value = mapValue(frame)
    durationRef.value = Math.max(durationRef.value, frame.time)
    if (index === 0) put(frame.time, value, frame.curve === 'stepped' ? 'step' : 'tween')
    const next = source[index + 1]
    if (!next) continue
    const span = next.time - frame.time
    if (span < 0) throw new Error('Spine 动画帧时间必须递增')
    const curve = frame.curve
    if (curve === 'stepped' || span === 0) continue
    if (Array.isArray(curve)) {
      const nextValue = mapValue(next)
      for (let sample = 1; frame.time + sample / 30 < next.time - 1e-9; sample += 1) {
        const time = frame.time + sample / 30
        const u = (time - frame.time) / span
        const ease = bezierYAtX(curve, u)
        const sampled = typeof value === 'number' ? value + (nextValue - value) * ease
          : Object.fromEntries(Object.keys(value).map(key => [key, key === 'a' ? value[key] + (nextValue[key] - value[key]) * ease : value[key] + (nextValue[key] - value[key]) * ease]))
        put(time, sampled)
        durationRef.value = Math.max(durationRef.value, time)
      }
    }
    put(next.time, mapValue(next), next.curve === 'stepped' ? 'step' : 'tween')
  }
  return output
}

function normalizedSpineSkins(raw) {
  return Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([name, attachments]) => ({ name, attachments }))
}

function atlasRegions(source) {
  const regions = new Map()
  let page = '', current = null
  for (const raw of String(source || '').split(/\r?\n/)) {
    if (!raw.trim()) { current = null; continue }
    const text = raw.trim()
    if (!raw.startsWith(' ') && !raw.startsWith('\t') && !text.includes(':')) {
      if (/\.(png|jpe?g|webp)$/i.test(text)) page = text
      else if (page) { current = { name: text, page, rotate: false }; regions.set(withoutImageExtension(text).toLowerCase(), current) }
      continue
    }
    if (!current || !text.includes(':')) continue
    const [key, ...rest] = text.split(':')
    const value = rest.join(':').trim()
    const numbers = value.split(',').map(Number)
    if (key.trim() === 'xy') [current.x, current.y] = numbers
    else if (key.trim() === 'size') [current.width, current.height] = numbers
    else if (key.trim() === 'orig') [current.originalWidth, current.originalHeight] = numbers
    else if (key.trim() === 'offset') [current.offsetX, current.offsetY] = numbers
    else if (key.trim() === 'rotate') current.rotate = value === 'true' ? 90 : Number(value) || 0
  }
  return regions
}

async function croppedAtlasDataUrl(file, region, attachment) {
  const image = await createImageBitmap(file)
  const sourceWidth = Number(region.width || 0), sourceHeight = Number(region.height || 0)
  if (!sourceWidth || !sourceHeight) throw new Error(`Spine atlas 区域缺少尺寸：${region.name}`)
  const rotated = region.rotate === true ? 90 : Number(region.rotate || 0)
  // Legacy atlas size is the unrotated region size; quarter turns swap the page rectangle.
  const quarterTurn = rotated === 90 || rotated === 270
  const cropWidth = quarterTurn ? sourceHeight : sourceWidth
  const cropHeight = quarterTurn ? sourceWidth : sourceHeight
  const trimmed = globalThis.document.createElement('canvas')
  trimmed.width = sourceWidth; trimmed.height = sourceHeight
  const ctx = trimmed.getContext('2d')
  if (rotated) {
    ctx.translate(sourceWidth / 2, sourceHeight / 2)
    // Atlas packing is counterclockwise; positive Canvas angles undo it clockwise.
    ctx.rotate(rotated * Math.PI / 180)
    ctx.drawImage(image, Number(region.x || 0), Number(region.y || 0), cropWidth, cropHeight, -cropWidth / 2, -cropHeight / 2, cropWidth, cropHeight)
  } else ctx.drawImage(image, Number(region.x || 0), Number(region.y || 0), cropWidth, cropHeight, 0, 0, sourceWidth, sourceHeight)
  const originalWidth = Math.max(1, Number(region.originalWidth || attachment.width || sourceWidth))
  const originalHeight = Math.max(1, Number(region.originalHeight || attachment.height || sourceHeight))
  if (originalWidth === sourceWidth && originalHeight === sourceHeight && !region.offsetX && !region.offsetY) return trimmed.toDataURL('image/png')
  const output = globalThis.document.createElement('canvas')
  output.width = originalWidth; output.height = originalHeight
  const out = output.getContext('2d')
  const offsetX = Number(region.offsetX || 0)
  const offsetY = originalHeight - Number(region.offsetY || 0) - sourceHeight
  out.drawImage(trimmed, offsetX, offsetY)
  return output.toDataURL('image/png')
}

function fileSize(file) { return Number(file.size || 0) }

function withoutImageExtension(path) {
  return String(path || '').replace(/\.(?:png|jpe?g|webp)$/i, '')
}

function selectSkeletonJson(files) {
  const jsonFiles = files.filter(file => /\.json$/i.test(file.name))
  const preferred = jsonFiles.filter(file => /(^|\/)skeleton\.json$/i.test(String(file.webkitRelativePath || file.name).replace(/\\/g, '/')))
  if (preferred.length === 1) return preferred[0]
  if (preferred.length > 1 || jsonFiles.length !== 1) throw new Error('请选择一个包含唯一 skeleton.json 的 Spine 文件夹')
  return jsonFiles[0]
}

export async function importSpine(files) {
  const list = Array.from(files || [])
  if (!list.length) throw new Error('请选择包含 skeleton.json 与图片的文件夹')
  if (list.length > 4096 || list.reduce((sum, file) => sum + fileSize(file), 0) > 256 * 1024 * 1024) throw new Error('Spine 文件夹最多 4096 个文件、总大小 256 MB')
  const skeletonFile = selectSkeletonJson(list)
  if (fileSize(skeletonFile) > 16 * 1024 * 1024) throw new Error('Spine JSON 文件不能超过 16 MB')
  const spine = JSON.parse(await skeletonFile.text())
  const spineVersion = spine.skeleton?.spine
  if (typeof spineVersion !== 'string' || !/^3\.8(?:\.\d+)?$/.test(spineVersion.trim())) throw new Error('目前只支持版本号为 3.8 或 3.8.x 的 Spine JSON 导出')
  const boneDefs = spine.bones || [], slotDefs = spine.slots || []
  if (boneDefs.length > 1024 || slotDefs.length > 2048) throw new Error('Spine 骨骼最多 1024 个，插槽最多 2048 个')
  const warnings = []
  const root = node(skeletonFile.name.replace(/\.json$/i, ''), null, 800, 450, 1600, 900)
  const nodes = [root], resources = [], boneNodes = new Map()
  const bones = new Map()
  for (const bone of boneDefs) {
    if (!bone?.name || bones.has(bone.name)) throw new Error('Spine 骨骼名称为空或重复')
    bones.set(bone.name, bone)
  }
  const constraintLabels = { ik: 'IK', transform: 'transform', path: 'path', physics: 'physics' }
  for (const type of Object.keys(constraintLabels)) {
    const constraints = spine[type]
    if (constraints == null) continue
    if (!Array.isArray(constraints) || constraints.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error(`Spine ${type} setup 约束列表格式无效`)
    }
    if (constraints.length) {
      const names = constraints.map(item => String(item.name || '')).filter(Boolean)
      const summary = names.length ? `（${names.slice(0, 5).join('、')}${names.length > 5 ? '…' : ''}）` : ''
      warnings.push(`Spine setup pose 含 ${constraintLabels[type]} 约束${summary}；当前不会求解静态约束，骨骼按 JSON setup 值导入`)
    }
  }
  const skeletonWidth = Math.max(1, Number(spine.skeleton?.width || 1600))
  const skeletonHeight = Math.max(1, Number(spine.skeleton?.height || 900))
  const scale = Math.min(1600 / skeletonWidth, 900 / skeletonHeight)
  const originX = -(Number(spine.skeleton?.x || 0) + skeletonWidth / 2) * scale
  const originY = -(Number(spine.skeleton?.y || 0) + skeletonHeight / 2) * scale
  const visiting = new Set(), visited = new Set()
  const buildBone = bone => {
    if (visited.has(bone.name)) return boneNodes.get(bone.name)
    if (visiting.has(bone.name)) throw new Error(`Spine 骨骼层级存在循环：${bone.name}`)
    visiting.add(bone.name)
    const parent = bone.parent ? bones.get(bone.parent) : null
    if (bone.parent && !parent) throw new Error(`Spine 骨骼 ${bone.name} 的父骨骼不存在：${bone.parent}`)
    const parentNode = parent ? buildBone(parent) : root
    if (bone.transform && bone.transform !== 'normal') warnings.push(`骨骼“${bone.name}”使用 ${bone.transform} 变换继承；导入按普通父子变换近似`)
    const shearX = Number(bone.shearX ?? 0), shearY = Number(bone.shearY ?? 0)
    if (!Number.isFinite(shearX) || !Number.isFinite(shearY)) throw new Error(`Spine 骨骼 ${bone.name} 的 setup shear 数值无效`)
    if (shearX !== 0 || shearY !== 0) warnings.push(`Spine 骨骼“${bone.name}”含 setup shear（${shearX}, ${shearY}）；Look 控件没有剪切属性，已按无剪切变换导入`)
    const x = (Number(bone.x || 0) + (parent ? 0 : originX / scale)) * scale
    const y = (Number(bone.y || 0) + (parent ? 0 : originY / scale)) * scale
    const entry = node(bone.name, parentNode.id, x, y, Number(bone.length || 0) * scale, 0, '', {
      local: true, rotation: Number(bone.rotation || 0), scaleX: Number(bone.scaleX ?? 1), scaleY: Number(bone.scaleY ?? 1),
    })
    entry.properties.spineBone = bone.name
    nodes.push(entry); boneNodes.set(bone.name, entry)
    visiting.delete(bone.name); visited.add(bone.name)
    return entry
  }
  for (const bone of boneDefs) buildBone(bone)

  const skins = normalizedSpineSkins(spine.skins)
  const skin = skins.find(row => row.name === 'default') || skins[0]
  if (!skin) throw new Error('Spine JSON 没有皮肤数据')
  if (skins.length > 1) warnings.push(`Spine 包含 ${skins.length} 个皮肤；仅导入 ${skin.name || '第一个'} 皮肤`)
  if (Array.isArray(skin.bones) && skin.bones.length || boneDefs.some(bone => bone.skin === true)) {
    warnings.push(`Spine 皮肤“${skin.name || '未命名'}”含皮肤限定骨骼；当前导入不按皮肤启用/停用骨骼`)
  }
  const slotNames = new Set()
  const slotBoneNames = new Set()
  for (const slot of slotDefs) {
    if (!slot?.name || slotNames.has(slot.name)) throw new Error('Spine 插槽名称为空或重复')
    slotNames.add(slot.name)
    if (typeof slot.bone === 'string' && slot.bone) slotBoneNames.add(slot.bone)
  }
  if (slotBoneNames.size > 1) {
    warnings.push(`Spine 静态插槽顺序独立于骨骼层级，插槽分属 ${slotBoneNames.size} 个骨骼；当前按骨骼嵌套插槽，跨骨骼全局显示顺序可能不同`)
  }
  const imageFiles = list.filter(file => /\.(png|jpe?g|webp)$/i.test(file.name))
  const atlasFile = list.find(file => /\.atlas$/i.test(file.name))
  const atlas = atlasFile ? atlasRegions(await atlasFile.text()) : new Map()
  const atlasPages = new Map()
  if (atlasFile) {
    for (const region of atlas.values()) {
      if (!atlasPages.has(region.page)) {
        const page = resolveImage(imageFiles, region.page)
        if (!page) throw new Error(`Spine atlas 图片页缺失：${region.page}`)
        atlasPages.set(region.page, page)
      }
    }
  }
  const slotNodes = new Map(), attachmentNodes = new Map(), slotColors = new Map()
  const makeResource = async (name, attachment) => {
    const path = String(attachment.path || attachment.name || name || '')
    const normalized = withoutImageExtension(path.replace(/\\/g, '/')).toLowerCase()
    const region = atlas.get(normalized) || [...atlas.values()].find(row => normalized.endsWith('/' + withoutImageExtension(row.name).toLowerCase()))
    let imageUrl
    if (region) imageUrl = await croppedAtlasDataUrl(atlasPages.get(region.page), region, attachment)
    else {
      const image = resolveImage(imageFiles, path)
      if (!image) throw new Error(`Spine 图片缺失：${path || name}`)
      imageUrl = await fileDataUrl(image)
    }
    const resource = imageResource(name, imageUrl); resources.push(resource); return resource
  }
  for (const slot of [...slotDefs].reverse()) {
    const bone = bones.get(slot.bone)
    if (!bone) throw new Error(`Spine 插槽 ${slot.name} 的骨骼不存在：${slot.bone}`)
    const boneNode = boneNodes.get(slot.bone)
    if (!boneNode) throw new Error(`Spine 插槽 ${slot.name} 的骨骼节点无法建立`)
    const slotNode = node(slot.name, boneNode.id, 0, 0, 0, 0, '', { local: true })
    slotNode.properties.spineSlot = slot.name
    nodes.push(slotNode)
    const color = spineColor(slot.color || 'ffffffff')
    if (slot.dark) warnings.push(`Spine 插槽 ${slot.name} 使用双色 tint；Look 图片只支持单色 tint`)
    const blend = String(slot.blend || 'normal').toLowerCase()
    if (blend !== 'normal') warnings.push(`Spine 插槽 ${slot.name} 使用 ${blend} 混合；导入按普通混合显示`)
    slotColors.set(slot.name, color)
    const rawAttachments = skin.attachments?.[slot.name] || {}
    const names = Object.keys(rawAttachments)
    const activeName = slot.attachment == null ? '' : String(slot.attachment)
    if (activeName && !rawAttachments[activeName]) throw new Error(`Spine 插槽 ${slot.name} 的初始附件不存在：${activeName}`)
    const attachmentsForSlot = new Map()
    for (const attachmentName of names) {
      const attachment = rawAttachments[attachmentName]
      const type = attachment.type || 'region'
      if (type !== 'region') throw new Error(`Spine 附件 ${slot.name}/${attachmentName} 使用 ${type} 类型；当前只接受 region 附件`)
      const path = attachment.path || attachmentName
      const resource = await makeResource(path, attachment)
      const attachmentColor = spineColor(attachment.color || 'ffffffff')
      const tint = multiplyColor(color, attachmentColor)
      const width = Math.max(1, Number(attachment.width || 100) * scale)
      const height = Math.max(1, Number(attachment.height || 100) * scale)
      const child = node(attachmentName, slotNode.id, Number(attachment.x || 0) * scale, Number(attachment.y || 0) * scale,
        width, height, resource.id, { local: true, rotation: Number(attachment.rotation || 0),
          scaleX: Number(attachment.scaleX ?? 1), scaleY: Number(attachment.scaleY ?? 1), visible: attachmentName === activeName })
      child.properties.imageColor = tint
      child.properties.spineSlot = slot.name
      child.properties.spineAttachment = attachmentName
      child.properties.spineBone = slot.bone
      nodes.push(child)
      attachmentsForSlot.set(attachmentName, child)
    }
    if (activeName && !attachmentsForSlot.has(activeName)) throw new Error(`Spine 插槽 ${slot.name} 的初始附件无法读取：${activeName}`)
    if (names.length && !activeName) for (const child of attachmentsForSlot.values()) child.visible = false
    attachmentNodes.set(slot.name, attachmentsForSlot)
    slotNodes.set(slot.name, slotNode)
  }

  const animations = []
  for (const [name, animation] of Object.entries(spine.animations || {})) {
    const tracks = [], durationRef = { value: 0 }
    const pushTrack = (nodeId, fieldKey, keyframes) => { if (keyframes.length) tracks.push({ id: uid('track'), nodeId, fieldKey, keyframes }) }
    for (const [boneName, channels] of Object.entries(animation.bones || {})) {
      const definition = bones.get(boneName), target = boneNodes.get(boneName)
      if (!definition || !target) throw new Error(`Spine 动画 ${name} 指向不存在的骨骼：${boneName}`)
      for (const [channel, frames] of Object.entries(channels || {})) {
        if (channel === 'translate') {
          for (const axis of ['x', 'y']) {
            const fieldKey = axis === 'x' ? 'anchoredPositionX' : 'anchoredPositionY'
            const base = Number(definition[axis] || 0) * scale + (!definition.parent ? axis === 'x' ? originX : originY : 0)
            const keyframes = spineKeys(frames, frame => base + Number(frame[axis] || 0) * scale, durationRef)
            pushTrack(target.id, fieldKey, keyframes)
          }
        } else if (channel === 'rotate') {
          const base = Number(definition.rotation || 0)
          const keyframes = spineKeys(frames, frame => base + Number(frame.angle || 0), durationRef)
          pushTrack(target.id, 'localRotationZ', keyframes)
        } else if (channel === 'scale') {
          for (const axis of ['x', 'y']) {
            const base = Number(definition[`scale${axis.toUpperCase()}`] ?? 1)
            const keyframes = spineKeys(frames, frame => base * Number(frame[axis] ?? 1), durationRef)
            pushTrack(target.id, `localScale${axis.toUpperCase()}`, keyframes)
          }
        } else if (channel === 'shear') warnings.push(`Spine 动画 ${name} 的骨骼 ${boneName} 含 shear 轨道；Look 控件变换没有剪切属性`)
        else warnings.push(`Spine 动画 ${name} 的骨骼 ${boneName} 含未映射轨道 ${channel}`)
      }
    }
    for (const [slotName, channels] of Object.entries(animation.slots || {})) {
      const targets = attachmentNodes.get(slotName)
      if (!targets) throw new Error(`Spine 动画 ${name} 指向不存在的插槽：${slotName}`)
      for (const [channel, frames] of Object.entries(channels || {})) {
        if (channel === 'attachment') {
          for (const frame of frames || []) {
            if (frame.name != null && !targets.has(String(frame.name))) {
              throw new Error(`Spine 动画 ${name} 的插槽 ${slotName} 指向不存在的附件：${frame.name}`)
            }
          }
          for (const [attachmentName, target] of targets) {
            const keyframes = spineKeys(frames, frame => frame.name === attachmentName, durationRef)
            for (const key of keyframes) key.interpolation = 'step'
            pushTrack(target.id, 'visible', keyframes)
          }
        } else if (channel === 'color') {
          for (const [attachmentName, target] of targets) {
            const attachment = skin.attachments?.[slotName]?.[attachmentName]
            const attachmentColor = spineColor(attachment?.color || 'ffffffff')
            const keyframes = spineKeys(frames, frame => multiplyColor(spineColor(frame.color), attachmentColor), durationRef)
            pushTrack(target.id, 'imageColor', keyframes)
          }
        } else if (channel === 'twoColor') warnings.push(`Spine 动画 ${name} 的插槽 ${slotName} 含双色 tint；Look 图片只支持单色 tint`)
        else if (channel !== 'deform') warnings.push(`Spine 动画 ${name} 的插槽 ${slotName} 含未映射轨道 ${channel}`)
        else warnings.push(`Spine 动画 ${name} 的插槽 ${slotName} 含 deform 网格顶点轨道；Look 图片不支持网格变形`)
      }
    }
    for (const type of ['ik', 'transform', 'path', 'physics']) {
      if (animation[type] && Object.keys(animation[type]).length) warnings.push(`Spine 动画 ${name} 含 ${type} 约束轨道；当前导入仅重建骨骼与插槽轨道`)
    }
    const drawOrder = animation.draworder ?? animation.drawOrder
    if (Array.isArray(drawOrder) && drawOrder.length) warnings.push(`Spine 动画 ${name} 含插槽 draw order 变化；动画插槽顺序未导入`)
    const events = []
    const sourceEvents = animation.events || []
    if (!Array.isArray(sourceEvents)) throw new Error(`Spine 动画 ${name} 的事件列表格式无效`)
    for (const [index, event] of sourceEvents.entries()) {
      const eventTime = Number(event?.time)
      const eventName = event?.name
      if (typeof event?.time !== 'number' || !Number.isFinite(eventTime) || eventTime < 0) throw new Error(`Spine 动画 ${name} 含非法事件时间`)
      if (typeof eventName !== 'string' || !eventName.trim() || eventName.length > 320) throw new Error(`Spine 动画 ${name} 含非法事件名称`)
      const params = JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !['time', 'name'].includes(key))))
      if (params.length > 16_384) throw new Error(`Spine 动画 ${name} 的事件参数超过 16384 个字符`)
      events.push({ id: uid('event'), time: eventTime, name: eventName, target: '', params, _sourceIndex: index })
      durationRef.value = Math.max(durationRef.value, eventTime)
    }
    events.sort((left, right) => left.time - right.time || left._sourceIndex - right._sourceIndex)
    for (const event of events) delete event._sourceIndex
    animations.push({ id: uid('animation'), name, duration: Math.max(.1, durationRef.value), keyframeTracks: tracks, events })
  }
  if (slotDefs.length && !resources.length) throw new Error('Spine 图片与插槽未匹配；请选择包含贴图或图集的整个文件夹')
  return document(root.name, nodes, resources, animations, [...new Set(warnings)])
}
