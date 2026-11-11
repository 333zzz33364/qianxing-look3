// Pure-Node PNG decode/encode plus per-region pixel diff. No extra dependencies:
// screenshots produced by the local capture pipeline are 8-bit RGB/RGBA, non-interlaced.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file')
  let offset = 8
  let header = null
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (!header) throw new Error('PNG missing IHDR')
  if (header.bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${header.bitDepth}`)
  if (header.interlace !== 0) throw new Error('Interlaced PNG is not supported')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType]
  if (!channels) throw new Error(`Unsupported PNG color type ${header.colorType}`)

  const { width, height } = header
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = new Uint8Array(height * stride)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) value += paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`)
      out[x] = value & 0xff
    }
    previous = out
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    if (channels >= 3) {
      rgba[i * 4] = pixels[j]
      rgba[i * 4 + 1] = pixels[j + 1]
      rgba[i * 4 + 2] = pixels[j + 2]
      rgba[i * 4 + 3] = channels === 4 ? pixels[j + 3] : 255
    } else {
      const grey = pixels[j]
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = grey
      rgba[i * 4 + 3] = channels === 2 ? pixels[j + 1] : 255
    }
  }
  return { width, height, data: rgba }
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
  return Buffer.concat([head, data, crc])
}

export function encodePng({ width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function emptyStats() {
  return { pixels: 0, meanAbsDiff: 0, maxChannelDelta: 0, alphaDifferingPixels: 0, changed: {} }
}

function accumulate(stats, deltaMax, deltaSum, alphaDifferent, thresholds) {
  stats.pixels++
  stats.meanAbsDiffSum = (stats.meanAbsDiffSum || 0) + deltaSum
  if (deltaMax > stats.maxChannelDelta) stats.maxChannelDelta = deltaMax
  if (alphaDifferent) stats.alphaDifferingPixels++
  for (const threshold of thresholds) {
    if (deltaMax > threshold) stats.changed[threshold] = (stats.changed[threshold] || 0) + 1
  }
}

function finish(stats, thresholds) {
  if (!stats.pixels) return { ...emptyStats(), changed: Object.fromEntries(thresholds.map(t => [t, 0])) }
  const result = {
    pixels: stats.pixels,
    meanAbsDiff: Number((stats.meanAbsDiffSum / stats.pixels).toFixed(4)),
    maxChannelDelta: stats.maxChannelDelta,
    alphaDifferingPixels: stats.alphaDifferingPixels,
    changed: {},
  }
  for (const threshold of thresholds) {
    const count = stats.changed[threshold] || 0
    result.changed[threshold] = { pixels: count, ratio: Number((count / stats.pixels).toFixed(6)) }
  }
  return result
}

export function diffImages(a, b, { regions = [], thresholds = [0, 8, 32] } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const buckets = new Map([['total', { x: 0, y: 0, width: a.width, height: a.height }]])
  for (const [name, box] of Object.entries(regions)) {
    if (box) buckets.set(name, {
      x: Math.max(0, Math.round(box.x)), y: Math.max(0, Math.round(box.y)),
      width: Math.max(0, Math.round(box.width)), height: Math.max(0, Math.round(box.height)),
    })
  }
  const stats = new Map([...buckets.keys()].map(name => [name, { pixels: 0, meanAbsDiffSum: 0, maxChannelDelta: 0, alphaDifferingPixels: 0, changed: {} }]))

  for (const [name, box] of buckets) {
    const bucket = stats.get(name)
    for (let y = box.y; y < Math.min(a.height, box.y + box.height); y++) {
      for (let x = box.x; x < Math.min(a.width, box.x + box.width); x++) {
        const i = (y * a.width + x) * 4
        const dr = Math.abs(a.data[i] - b.data[i])
        const dg = Math.abs(a.data[i + 1] - b.data[i + 1])
        const db = Math.abs(a.data[i + 2] - b.data[i + 2])
        const da = Math.abs(a.data[i + 3] - b.data[i + 3])
        accumulate(bucket, Math.max(dr, dg, db, da), (dr + dg + db) / 3, da > 0, thresholds)
      }
    }
  }

  const result = {}
  for (const [name, bucket] of stats) result[name] = finish(bucket, thresholds)
  return { width: a.width, height: a.height, thresholds, regions: result }
}

export function heatmap(a, b, gain = 4) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Size mismatch for heatmap')
  const data = new Uint8Array(a.width * a.height * 4)
  for (let i = 0; i < a.width * a.height; i++) {
    const delta = Math.max(
      Math.abs(a.data[i * 4] - b.data[i * 4]),
      Math.abs(a.data[i * 4 + 1] - b.data[i * 4 + 1]),
      Math.abs(a.data[i * 4 + 2] - b.data[i * 4 + 2]),
      Math.abs(a.data[i * 4 + 3] - b.data[i * 4 + 3]),
    )
    const level = Math.min(255, delta * gain)
    data[i * 4] = level
    data[i * 4 + 1] = level > 96 ? 48 : 0
    data[i * 4 + 2] = 0
    data[i * 4 + 3] = 255
  }
  return { width: a.width, height: a.height, data }
}

// The capture pipeline stores boxes under metrics.regions and metrics.style.
export function boxesFromMetrics(metrics, variant, size) {
  const [width, height] = size.split('x').map(Number)
  const entry = (metrics?.[variant] || []).find(item => item?.pngSize?.width === width && item?.pngSize?.height === height)
  if (!entry) throw new Error(`No metrics for ${variant} at ${size}`)
  const boxes = {}
  for (const group of ['regions', 'style']) {
    for (const [name, box] of Object.entries(entry.metrics?.[group] || {})) {
      if (box) boxes[`${group}.${name}`] = box
    }
  }
  return { boxes, filename: entry.filename }
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    options[name] = value
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (!options.a || !options.b || options.help) {
    console.log('Usage: node scripts/ui-screenshot-diff.mjs --a <png> --b <png> [--metrics <json>] [--size WxH] [--variant look3] [--heatmap <png>] [--out <json>]')
    process.exitCode = options.help ? 0 : 2
  } else {
    const a = decodePng(readFileSync(resolve(options.a)))
    const b = decodePng(readFileSync(resolve(options.b)))
    const regions = options.metrics
      ? boxesFromMetrics(JSON.parse(readFileSync(resolve(options.metrics), 'utf8')), options.variant || 'look3', options.size || `${a.width}x${a.height}`).boxes
      : {}
    const report = diffImages(a, b, { regions: Object.fromEntries(Object.entries(regions).map(([name, box]) => [name, box])) })
    if (options.heatmap) writeFileSync(resolve(options.heatmap), encodePng(heatmap(a, b)))
    const text = `${JSON.stringify(report, null, 2)}\n`
    if (options.out) writeFileSync(resolve(options.out), text, 'utf8')
    console.log(text)
  }
}
