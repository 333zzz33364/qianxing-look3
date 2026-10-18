const IMAGE_IDS = { rectangle: 100001, ellipse: 100002, triangle: 100003 }
const GEOMETRY_VARIANTS = [
  [1, 1, 0, 0], [.9, .9, 0, 0], [1.1, 1.1, 0, 0],
  [1, 1, .1, 0], [1, 1, 0, -.1],
]
const ROTATION_CACHE = new WeakMap()

let state = null

function postError(error) {
  self.postMessage({ type: 'error', message: String(error?.message || error) })
}

async function decode(source, resolution) {
  let blob
  if (source instanceof Blob) blob = source
  else if (typeof source === 'string' && source.startsWith('data:')) {
    // Decode embedded images locally. Fetching a data URL is a network
    // operation under CSP and is blocked by the host's connect-src policy.
    const match = source.match(/^data:(image\/[^;,]+)((?:;[^,]*)?),([\s\S]*)$/i)
    if (!match) throw new Error('拟合图片的内嵌数据格式无效')
    const bytes = /;base64(?:;|$)/i.test(match[2])
      ? Uint8Array.from(atob(match[3].replace(/\s/g, '')), character => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[3]))
    blob = new Blob([bytes], { type: match[1] })
  } else {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`)
    blob = await response.blob()
  }
  const bitmap = await createImageBitmap(blob)
  const width = bitmap.width
  const height = bitmap.height
  if (!width || !height || width > 100000 || height > 100000) { bitmap.close?.(); throw new Error('图片尺寸无效或过大') }
  const ratio = Math.min(1, resolution / Math.max(width, height))
  const gridWidth = Math.max(1, Math.round(width * ratio))
  const gridHeight = Math.max(1, Math.round(height * ratio))
  if (typeof OffscreenCanvas !== 'function') { bitmap.close?.(); throw new Error('当前浏览器 Worker 不支持 OffscreenCanvas') }
  const canvas = new OffscreenCanvas(gridWidth, gridHeight)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) { bitmap.close?.(); throw new Error('无法读取拟合画布像素') }
  context.clearRect(0, 0, gridWidth, gridHeight)
  context.drawImage(bitmap, 0, 0, gridWidth, gridHeight)
  bitmap.close?.()
  const pixels = context.getImageData(0, 0, gridWidth, gridHeight).data
  const transferable = new Uint8ClampedArray(pixels)
  self.postMessage({ type: 'decoded', width, height, gridWidth, gridHeight, pixels: transferable.buffer }, [transferable.buffer])
}

function configure(message) {
  const pixels = new Uint8ClampedArray(message.pixels)
  const total = message.gridWidth * message.gridHeight
  const target = new Float32Array(total * 4)
  const rendered = new Float32Array(total * 4)
  const transparent = message.transparent !== false
  let errorTotal = 0
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    const alpha = pixels[offset + 3] / 255
    let red = pixels[offset] / 255 * alpha
    let green = pixels[offset + 1] / 255 * alpha
    let blue = pixels[offset + 2] / 255 * alpha
    if (!transparent) {
      red += 1 - alpha; green += 1 - alpha; blue += 1 - alpha
      rendered[offset] = 1; rendered[offset + 1] = 1; rendered[offset + 2] = 1; rendered[offset + 3] = 1
    }
    target[offset] = red; target[offset + 1] = green; target[offset + 2] = blue
    target[offset + 3] = transparent ? alpha : 1
    const d0 = target[offset] - rendered[offset]
    const d1 = target[offset + 1] - rendered[offset + 1]
    const d2 = target[offset + 2] - rendered[offset + 2]
    const d3 = target[offset + 3] - rendered[offset + 3]
    errorTotal += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3
  }
  const shapes = Array.isArray(message.shapes) && message.shapes.length
    ? message.shapes.filter((shape) => Object.hasOwn(IMAGE_IDS, shape))
    : ['ellipse', 'rectangle']
  const workerCount = Math.max(1, Math.trunc(Number(message.workerCount) || 1))
  const workerIndex = Math.max(0, Math.trunc(Number(message.workerIndex) || 0))
  const shapeIndex = workerCount >= shapes.length ? workerIndex % shapes.length : -1
  const tileIndex = workerCount >= shapes.length ? Math.floor(workerIndex / shapes.length) : workerIndex
  const tileCount = workerCount >= shapes.length ? Math.ceil(workerCount / shapes.length) : workerCount
  const columns = Math.ceil(Math.sqrt(tileCount))
  const rows = Math.ceil(tileCount / columns)
  const tileColumn = tileIndex % columns
  const tileRow = Math.floor(tileIndex / columns)
  const xStart = Math.floor(message.gridWidth * tileColumn / columns)
  const xEnd = Math.max(xStart + 1, Math.floor(message.gridWidth * (tileColumn + 1) / columns))
  const yStart = Math.floor(message.gridHeight * tileRow / rows)
  const yEnd = Math.max(yStart + 1, Math.floor(message.gridHeight * (tileRow + 1) / rows))
  state = {
    workerIndex, workerCount, width: message.width, height: message.height,
    gridWidth: message.gridWidth, gridHeight: message.gridHeight,
    stepX: message.width / message.gridWidth, stepY: message.height / message.gridHeight,
    target, rendered, shapes, shapeIndex, xStart, xEnd, yStart, yEnd,
    transparent, errorTotal, pixelCount: total,
  }
  self.postMessage({ type: 'ready' })
}

function insideShape(type, x, y, geometry) {
  const dx = x - geometry.x; const dy = y - geometry.y
  let rotation = ROTATION_CACHE.get(geometry)
  if (!rotation) {
    const angle = geometry.rotation * Math.PI / 180
    rotation = { cos: Math.cos(angle), sin: Math.sin(angle) }
    ROTATION_CACHE.set(geometry, rotation)
  }
  const { cos, sin } = rotation
  const localX = cos * dx + sin * dy
  const localY = -sin * dx + cos * dy
  const halfW = geometry.width / 2
  const halfH = geometry.height / 2
  if (type === 'rectangle') return Math.abs(localX) <= halfW && Math.abs(localY) <= halfH
  if (type === 'ellipse') return (localX * localX) / (halfW * halfW) + (localY * localY) / (halfH * halfH) <= 1
  if (localY < -halfH || localY > halfH) return false
  const halfAtY = ((halfH - localY) / geometry.height) * geometry.width / 2
  return Math.abs(localX) <= halfAtY
}

function cellBounds(geometry) {
  const s = state
  const angle = geometry.rotation * Math.PI / 180
  const cos = Math.abs(Math.cos(angle)); const sin = Math.abs(Math.sin(angle))
  const radiusX = cos * geometry.width / 2 + sin * geometry.height / 2
  const radiusY = sin * geometry.width / 2 + cos * geometry.height / 2
  return {
    left: Math.max(0, Math.floor((geometry.x - radiusX + s.width / 2) / s.stepX) - 1),
    right: Math.min(s.gridWidth - 1, Math.ceil((geometry.x + radiusX + s.width / 2) / s.stepX) + 1),
    top: Math.max(0, Math.floor((s.height / 2 - (geometry.y + radiusY)) / s.stepY) - 1),
    bottom: Math.min(s.gridHeight - 1, Math.ceil((s.height / 2 - (geometry.y - radiusY)) / s.stepY) + 1),
  }
}

function pixelError(index) {
  const offset = index * 4
  const s = state
  const d0 = s.target[offset] - s.rendered[offset]
  const d1 = s.target[offset + 1] - s.rendered[offset + 1]
  const d2 = s.target[offset + 2] - s.rendered[offset + 2]
  const d3 = s.target[offset + 3] - s.rendered[offset + 3]
  return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3
}

function findSeed() {
  const s = state
  let best = -1
  let bestError = 1e-9
  for (let row = s.yStart; row < s.yEnd; row += 1) {
    const start = row * s.gridWidth
    for (let col = s.xStart; col < s.xEnd; col += 1) {
      const index = start + col
      // Source-over cannot erase alpha already painted into a transparent
      // target pixel. Do not let that irreducible residual starve all opaque
      // texture details of their next local candidate.
      if (s.transparent && s.target[index * 4 + 3] <= 1e-8) continue
      const error = pixelError(index)
      if (error > bestError) { best = index; bestError = error }
    }
  }
  return best < 0 ? null : { index: best, error: bestError }
}

function sameTargetColor(index, seed) {
  const s = state
  const a = index * 4; const b = seed * 4
  const d0 = s.target[a] - s.target[b]
  const d1 = s.target[a + 1] - s.target[b + 1]
  const d2 = s.target[a + 2] - s.target[b + 2]
  const d3 = s.target[a + 3] - s.target[b + 3]
  return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3 <= .12 * .12
}

function gatherBounds(seed) {
  const s = state
  const seedCol = seed % s.gridWidth
  const seedRow = Math.floor(seed / s.gridWidth)
  let count = 0
  let sumX = 0; let sumY = 0; let sumXX = 0; let sumYY = 0; let sumXY = 0
  for (let row = s.yStart; row < s.yEnd; row += 1) {
    const start = row * s.gridWidth
    for (let col = s.xStart; col < s.xEnd; col += 1) {
      const index = start + col
      if (!sameTargetColor(index, seed)) continue
      const x = (col + .5) * s.stepX - s.width / 2
      const y = s.height / 2 - (row + .5) * s.stepY
      count += 1; sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y
    }
  }
  if (!count) return { cx: (seedCol + .5) * s.stepX - s.width / 2, cy: s.height / 2 - (seedRow + .5) * s.stepY, angle: 0, major: s.stepX, minor: s.stepY }
  const cx = sumX / count; const cy = sumY / count
  const xx = sumXX / count - cx * cx; const yy = sumYY / count - cy * cy; const xy = sumXY / count - cx * cy
  const angle = .5 * Math.atan2(2 * xy, xx - yy)
  const step = Math.min(s.stepX, s.stepY)
  const discriminant = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)
  const majorVariance = Math.max(0, (xx + yy + discriminant) / 2)
  const minorVariance = Math.max(0, (xx + yy - discriminant) / 2)
  const major = Math.sqrt(12 * majorVariance + step * step)
  const minor = Math.sqrt(12 * minorVariance + step * step)
  return { cx, cy, angle, major: Math.max(step, major), minor: Math.max(step, minor) }
}

function summarizeGeometry(element) {
  const s = state
  const bounds = cellBounds(element)
  let count = 0; let oldError = 0
  const sumD = [0, 0, 0]; const sumBase = [0, 0, 0]
  const sumD2 = [0, 0, 0]; const sumDBase = [0, 0, 0]; const sumBase2 = [0, 0, 0]
  let sumAlphaD = 0; let sumAlphaD2 = 0; let sumAlphaDu = 0; let sumU2 = 0
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    const y = s.height / 2 - (row + .5) * s.stepY
    const start = row * s.gridWidth
    for (let col = bounds.left; col <= bounds.right; col += 1) {
      const x = (col + .5) * s.stepX - s.width / 2
      if (!insideShape(element.type, x, y, element)) continue
      count += 1
      const pixel = (start + col) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const d = s.target[pixel + channel] - s.rendered[pixel + channel]
        const base = s.rendered[pixel + channel]
        sumD[channel] += d; sumBase[channel] += base
        sumD2[channel] += d * d; sumDBase[channel] += d * base; sumBase2[channel] += base * base
        oldError += d * d
      }
      const alphaD = s.target[pixel + 3] - s.rendered[pixel + 3]
      const u = 1 - s.rendered[pixel + 3]
      sumAlphaD += alphaD; sumAlphaD2 += alphaD * alphaD
      sumAlphaDu += alphaD * u; sumU2 += u * u
      oldError += alphaD * alphaD
    }
  }
  if (!count) return null
  const alphaFit = Math.max(0, Math.min(1, sumU2 > 1e-9 ? sumAlphaDu / sumU2 : 1))
  const alphas = [...new Set([.2, .4, .6, .8, 1, alphaFit].map((value) => Math.max(0, Math.min(1, Math.round(value * 1000) / 1000))))]
  let best = null
  for (const alpha of alphas) {
    if (alpha <= 1e-5) continue
    const color = []
    let newError = 0
    for (let channel = 0; channel < 3; channel += 1) {
      const sumQ = sumD[channel] + alpha * sumBase[channel]
      const sumQ2 = sumD2[channel] + 2 * alpha * sumDBase[channel] + alpha * alpha * sumBase2[channel]
      const source = Math.round(Math.max(0, Math.min(1, sumQ / (count * alpha))) * 255) / 255
      const sourceTerm = alpha * source
      newError += sumQ2 - 2 * sourceTerm * sumQ + count * sourceTerm * sourceTerm
      color.push(Math.round(source * 255))
    }
    const roundedAlpha = Math.round(alpha * 10000) / 10000
    newError += sumAlphaD2 - 2 * roundedAlpha * sumAlphaDu + roundedAlpha * roundedAlpha * sumU2
    const improvement = oldError - newError
    if (!best || improvement > best.improvement) {
      best = { improvement, color: { r: color[0], g: color[1], b: color[2], a: roundedAlpha } }
    }
  }
  return best
}

function candidateGeometry(type, bounds, variant) {
  let angle; let width; let height
  if (type === 'triangle') {
    angle = bounds.angle - Math.PI / 2
    width = bounds.minor; height = bounds.major
  } else {
    angle = bounds.angle
    width = bounds.major; height = bounds.minor
  }
  const step = Math.min(state.stepX, state.stepY)
  width = Math.max(step, width * variant[0])
  height = Math.max(step, height * variant[1])
  return {
    type, imageId: IMAGE_IDS[type],
    x: bounds.cx + variant[2] * width,
    y: bounds.cy + variant[3] * height,
    width, height, rotation: angle * 180 / Math.PI,
    color: { r: 0, g: 0, b: 0, a: 1 },
  }
}

function makeCandidate(iteration) {
  const s = state
  const seed = findSeed()
  if (!seed) return null
  const bounds = gatherBounds(seed.index)
  const types = s.shapeIndex < 0 ? s.shapes : [s.shapes[s.shapeIndex]]
  let best = null
  for (const type of types) {
    for (const variant of GEOMETRY_VARIANTS) {
      const geometry = candidateGeometry(type, bounds, variant)
      const summary = summarizeGeometry(geometry)
      if (!summary || summary.improvement <= 1e-8) continue
      const candidate = { improvement: summary.improvement, element: { ...geometry, color: summary.color }, iteration }
      if (!best || candidate.improvement > best.improvement) best = candidate
    }
  }
  if (!best) {
    // Disconnected colors (texture, noise, small details) can span an entire
    // tile. Their shared PCA bounds may have no useful overlay even though
    // local residuals remain. Search around the residual seed before ending.
    const col = seed.index % s.gridWidth
    const row = Math.floor(seed.index / s.gridWidth)
    const x = (col + .5) * s.stepX - s.width / 2
    const y = s.height / 2 - (row + .5) * s.stepY
    for (const type of types) for (const diameter of [1, 2, 4, 8, 16, 32]) {
      const geometry = { type, imageId: IMAGE_IDS[type], x, y,
        width: diameter * s.stepX, height: diameter * s.stepY, rotation: 0 }
      const summary = summarizeGeometry(geometry)
      if (!summary || summary.improvement <= 1e-8) continue
      const candidate = { improvement: summary.improvement, element: { ...geometry, color: summary.color }, iteration }
      if (!best || candidate.improvement > best.improvement) best = candidate
    }
  }
  return best
}

function commit(candidate) {
  const s = state
  const element = candidate.element
  const bounds = cellBounds(element)
  let delta = 0
  const alpha = element.color.a
  const color = [element.color.r / 255, element.color.g / 255, element.color.b / 255]
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    const y = s.height / 2 - (row + .5) * s.stepY
    const start = row * s.gridWidth
    for (let col = bounds.left; col <= bounds.right; col += 1) {
      const x = (col + .5) * s.stepX - s.width / 2
      if (!insideShape(element.type, x, y, element)) continue
      const pixel = (start + col) * 4
      const old0 = s.target[pixel] - s.rendered[pixel]
      const old1 = s.target[pixel + 1] - s.rendered[pixel + 1]
      const old2 = s.target[pixel + 2] - s.rendered[pixel + 2]
      const old3 = s.target[pixel + 3] - s.rendered[pixel + 3]
      const inv = 1 - alpha
      const new0 = color[0] * alpha + s.rendered[pixel] * inv
      const new1 = color[1] * alpha + s.rendered[pixel + 1] * inv
      const new2 = color[2] * alpha + s.rendered[pixel + 2] * inv
      const new3 = alpha + s.rendered[pixel + 3] * inv
      const d0 = s.target[pixel] - new0; const d1 = s.target[pixel + 1] - new1
      const d2 = s.target[pixel + 2] - new2; const d3 = s.target[pixel + 3] - new3
      delta += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3 - (old0 * old0 + old1 * old1 + old2 * old2 + old3 * old3)
      s.rendered[pixel] = new0; s.rendered[pixel + 1] = new1
      s.rendered[pixel + 2] = new2; s.rendered[pixel + 3] = new3
    }
  }
  s.errorTotal = Math.max(0, s.errorTotal + delta)
  const error = s.errorTotal / (s.pixelCount * 4)
  return { remaining: error, error }
}

self.addEventListener('message', (event) => {
  const message = event.data || {}
  if (message.type === 'decode') {
    decode(message.source, message.resolution).catch(postError)
    return
  }
  if (message.type === 'init') {
    try { configure(message) } catch (error) { postError(error) }
    return
  }
  if (!state) { postError(new Error('Worker 尚未初始化')); return }
  if (message.type === 'search') {
    try {
      self.postMessage({
        type: 'candidate', iteration: message.iteration,
        candidate: makeCandidate(message.iteration),
        error: state.errorTotal / (state.pixelCount * 4),
      })
    }
    catch (error) { postError(error) }
  } else if (message.type === 'commit') {
    try { self.postMessage({ type: 'committed', iteration: message.iteration, ...commit(message.candidate) }) }
    catch (error) { postError(error) }
  } else if (message.type === 'cancel') state = null
})
