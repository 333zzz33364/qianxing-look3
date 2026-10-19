import { CANONICAL_CANVAS_BY_PLATFORM, CANVAS_PRESETS, DEFAULT_CANVAS_ID, PLATFORMS } from '../constants.js'
import { createGiaRaw } from '../gia/raw-fields.js'
import { createNode } from '../ui/authoring.js'
import { layoutTree } from '../ui/inspector.js'

const SHAPE_IMAGE_IDS = Object.freeze({ rectangle: 100001, ellipse: 100002, triangle: 100003 })
const FIT_KEYS = ['version', 'width', 'height', 'elements']
const ELEMENT_KEYS = ['type', 'imageId', 'x', 'y', 'width', 'height', 'rotation', 'color']
const COLOR_KEYS = ['r', 'g', 'b', 'a']

function finite(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是有限数值`)
  return Object.is(number, -0) ? 0 : number
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不符合格式`)
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
}

function colorCss(color) {
  return `rgba(${color.r},${color.g},${color.b},${Number(color.a.toFixed(5))})`
}

function svgEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function fmt(number) {
  const rounded = Math.round(number * 10000) / 10000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function fitShape(element) {
  const width = fmt(element.width)
  const height = fmt(element.height)
  if (element.type === 'ellipse') return `<ellipse cx="0" cy="0" rx="${fmt(element.width / 2)}" ry="${fmt(element.height / 2)}"/>`
  if (element.type === 'rectangle') return `<rect x="${fmt(-element.width / 2)}" y="${fmt(-element.height / 2)}" width="${width}" height="${height}"/>`
  return `<polygon points="0,${fmt(element.height / 2)} ${fmt(element.width / 2)},${fmt(-element.height / 2)} ${fmt(-element.width / 2)},${fmt(-element.height / 2)}"/>`
}

/** Validate and return a fresh FitData v1 value. */
export function validateFitData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('FitData 必须是对象')
  exactKeys(input, FIT_KEYS, 'FitData')
  if (input.version !== 1) throw new Error('仅支持 FitData version 1')
  const numberField = (value, label) => {
    if (typeof value !== 'number') throw new Error(`${label} 必须是数值`)
    return finite(value, label)
  }
  const width = numberField(input.width, 'FitData.width')
  const height = numberField(input.height, 'FitData.height')
  if (width <= 0 || height <= 0 || width > 32768 || height > 32768) throw new Error('FitData 尺寸超出范围')
  if (!Array.isArray(input.elements) || input.elements.length > 1001) throw new Error('FitData.elements 数量必须为 0–1001')
  const elements = input.elements.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`elements[${index}] 必须是对象`)
    exactKeys(row, ELEMENT_KEYS, `elements[${index}]`)
    if (!Object.hasOwn(SHAPE_IMAGE_IDS, row.type)) throw new Error(`elements[${index}] 的形状不受支持`)
    const imageId = numberField(row.imageId, `elements[${index}].imageId`)
    if (!Number.isInteger(imageId)) throw new Error(`elements[${index}].imageId 必须是整数`)
    const element = {
      type: row.type,
      imageId,
      x: numberField(row.x, `elements[${index}].x`),
      y: numberField(row.y, `elements[${index}].y`),
      width: numberField(row.width, `elements[${index}].width`),
      height: numberField(row.height, `elements[${index}].height`),
      rotation: numberField(row.rotation, `elements[${index}].rotation`),
      color: row.color,
    }
    if (element.imageId !== SHAPE_IMAGE_IDS[element.type]) throw new Error(`elements[${index}] 的 imageId 与形状不匹配`)
    if (element.width <= 0 || element.height <= 0 || element.width > width * 4 || element.height > height * 4) throw new Error(`elements[${index}] 尺寸无效`)
    if (!row.color || typeof row.color !== 'object' || Array.isArray(row.color)) throw new Error(`elements[${index}].color 必须是对象`)
    exactKeys(row.color, COLOR_KEYS, `elements[${index}].color`)
    element.color = {
      r: numberField(row.color.r, `elements[${index}].color.r`),
      g: numberField(row.color.g, `elements[${index}].color.g`),
      b: numberField(row.color.b, `elements[${index}].color.b`),
      a: numberField(row.color.a, `elements[${index}].color.a`),
    }
    if (['r', 'g', 'b'].some((key) => !Number.isInteger(element.color[key]) || element.color[key] < 0 || element.color[key] > 255)
      || element.color.a < 0 || element.color.a > 1) throw new Error(`elements[${index}].color 超出范围`)
    return element
  })
  return { version: 1, width, height, elements }
}

/** Render the supported fill-only subset as a portable SVG document. */
export function renderPrimitiveSvg(input) {
  const fit = validateFitData(input)
  const rows = fit.elements.map((element) => `    <g transform="translate(${fmt(element.x)} ${fmt(element.y)}) rotate(${fmt(element.rotation)})" fill="${svgEscape(colorCss(element.color))}">${fitShape(element)}</g>`)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(fit.width)}" height="${fmt(fit.height)}" viewBox="0 0 ${fmt(fit.width)} ${fmt(fit.height)}">`,
    `  <g transform="translate(${fmt(fit.width / 2)} ${fmt(fit.height / 2)}) scale(1 -1)">`,
    ...rows,
    '  </g>',
    '</svg>',
  ].join('\n')
}

function xmlUnescape(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity])
}

function parseXml(source) {
  const text = String(source).replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '')
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(text)) throw new Error('SVG 声明、实体和 DTD 不受支持')
  const tokens = text.match(/<[^>]*>|[^<]+/g) || []
  const stack = []
  let root = null
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (token.trim()) throw new Error('SVG 不支持文本内容')
      continue
    }
    if (/^<\//.test(token)) {
      const name = token.slice(2, -1).trim()
      if (stack.at(-1)?.name !== name) throw new Error('SVG 标签没有正确闭合')
      stack.pop()
      continue
    }
    const match = token.match(/^<([A-Za-z][\w:-]*)([\s\S]*?)\s*(\/?)>$/)
    if (!match) throw new Error('SVG 标签格式无效')
    const [, name, rawAttributes, selfClosing] = match
    const attributes = {}
    let remaining = rawAttributes
    const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
    let attributeMatch
    while ((attributeMatch = attributePattern.exec(rawAttributes))) {
      if (Object.hasOwn(attributes, attributeMatch[1])) throw new Error(`SVG 属性重复：${attributeMatch[1]}`)
      attributes[attributeMatch[1]] = xmlUnescape(attributeMatch[3] ?? attributeMatch[4] ?? '')
    }
    remaining = remaining.replace(attributePattern, '').trim()
    if (remaining) throw new Error('SVG 属性格式无效')
    const node = { name, attributes, children: [] }
    if (stack.length) stack.at(-1).children.push(node)
    else if (root) throw new Error('SVG 只能有一个根元素')
    else root = node
    if (!selfClosing) stack.push(node)
  }
  if (stack.length || !root) throw new Error('SVG 文档不完整')
  return root
}

function parseColor(value) {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const names = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', magenta: '#ff00ff', fuchsia: '#ff00ff', cyan: '#00ffff', aqua: '#00ffff', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', lime: '#00ff00', navy: '#000080', teal: '#008080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000' }
  const normalized = names[text] || text
  if (/^#[0-9a-f]{3}$/i.test(normalized)) return { r: parseInt(normalized[1] + normalized[1], 16), g: parseInt(normalized[2] + normalized[2], 16), b: parseInt(normalized[3] + normalized[3], 16), a: 1 }
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return { r: parseInt(normalized.slice(1, 3), 16), g: parseInt(normalized.slice(3, 5), 16), b: parseInt(normalized.slice(5, 7), 16), a: 1 }
  if (/^#[0-9a-f]{8}$/i.test(normalized)) return { r: parseInt(normalized.slice(1, 3), 16), g: parseInt(normalized.slice(3, 5), 16), b: parseInt(normalized.slice(5, 7), 16), a: parseInt(normalized.slice(7, 9), 16) / 255 }
  const rgb = normalized.match(/^rgba?\(\s*([^)]*)\)$/)
  if (rgb) {
    const parts = rgb[1].split(/\s*,\s*/)
    if (parts.length < 3 || parts.length > 4) throw new Error(`颜色格式无效：${value}`)
    const channel = (entry) => Math.max(0, Math.min(255, Math.round(entry.endsWith('%') ? finite(entry.slice(0, -1), '颜色') * 2.55 : finite(entry, '颜色'))))
    const alpha = parts[3] == null ? 1 : Math.max(0, Math.min(1, parts[3].endsWith('%') ? finite(parts[3].slice(0, -1), '透明度') / 100 : finite(parts[3], '透明度')))
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha }
  }
  throw new Error(`颜色格式不受支持：${value}`)
}

function parseStyle(style, allow) {
  const out = {}
  for (const declaration of String(style || '').split(';')) {
    if (!declaration.trim()) continue
    const colon = declaration.indexOf(':')
    if (colon < 1) throw new Error('样式声明格式无效')
    const key = declaration.slice(0, colon).trim().toLowerCase()
    if (!allow.has(key)) throw new Error(`样式属性不受支持：${key}`)
    out[key] = declaration.slice(colon + 1).trim()
  }
  return out
}

function svgAttributes(node, allowed) {
  const attributes = { ...node.attributes }
  const style = parseStyle(attributes.style, new Set(['fill', 'fill-opacity', 'opacity', 'transform', 'stroke']))
  delete attributes.style
  for (const [key, value] of Object.entries(style)) attributes[key] ??= value
  for (const key of Object.keys(attributes)) if (!allowed.has(key)) throw new Error(`SVG 属性不受支持：${key}`)
  if (attributes.stroke && attributes.stroke !== 'none') throw new Error('SVG 描边不受支持')
  return attributes
}

function multiplyMatrix(outer, inner) {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}

function parseTransform(value) {
  const source = String(value || '').trim()
  if (!source) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  let result = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const pattern = /(translate|rotate|scale)\s*\(([^)]*)\)/gy
  let cursor = 0
  let match
  while (cursor < source.length) {
    while (/[\s,]/.test(source[cursor] || '')) cursor += 1
    pattern.lastIndex = cursor
    match = pattern.exec(source)
    if (!match) throw new Error('SVG transform 只支持 translate、rotate 和 scale')
    const values = match[2].trim().split(/[\s,]+/).filter(Boolean).map((item) => finite(item, 'transform'))
    let matrix
    if (match[1] === 'translate' && values.length >= 1 && values.length <= 2) matrix = { a: 1, b: 0, c: 0, d: 1, e: values[0], f: values[1] || 0 }
    else if (match[1] === 'scale' && values.length >= 1 && values.length <= 2) matrix = { a: values[0], b: 0, c: 0, d: values[1] ?? values[0], e: 0, f: 0 }
    else if (match[1] === 'rotate' && (values.length === 1 || values.length === 3)) {
      const angle = values[0] * Math.PI / 180
      const rotation = { a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: 0, f: 0 }
      if (values.length === 3) matrix = multiplyMatrix(multiplyMatrix({ a: 1, b: 0, c: 0, d: 1, e: values[1], f: values[2] }, rotation), { a: 1, b: 0, c: 0, d: 1, e: -values[1], f: -values[2] })
      else matrix = rotation
    } else throw new Error('SVG transform 参数无效')
    result = multiplyMatrix(result, matrix)
    cursor = pattern.lastIndex
  }
  return result
}

function applyMatrix(matrix, x, y) {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }
}

function transformGeometry(type, geometry, matrix, color) {
  const center = applyMatrix(matrix, geometry.cx, geometry.cy)
  const sx = Math.hypot(matrix.a, matrix.b)
  const sy = Math.hypot(matrix.c, matrix.d)
  if (sx < 1e-8 || sy < 1e-8) throw new Error('SVG 不支持零缩放图元')
  const dot = matrix.a * matrix.c + matrix.b * matrix.d
  if (Math.abs(dot) > Math.max(sx * sy, 1) * 1e-5) throw new Error('SVG 的斜切变换不受支持')
  let rotation = Math.atan2(matrix.b, matrix.a) * 180 / Math.PI
  if (type === 'triangle' && (matrix.a * matrix.d - matrix.b * matrix.c) * (geometry.tipSign || 1) < 0) rotation += 180
  return {
    type, imageId: SHAPE_IMAGE_IDS[type], x: center.x, y: center.y,
    width: geometry.width * sx, height: geometry.height * sy,
    rotation, color,
  }
}

function svgShapeGeometry(node, attributes) {
  const number = (key, fallback = 0) => finite(attributes[key] ?? fallback, `SVG ${key}`)
  if (node.name === 'ellipse') {
    const rx = number('rx')
    const ry = number('ry')
    if (rx <= 0 || ry <= 0) throw new Error('SVG 椭圆半径必须大于零')
    return { type: 'ellipse', geometry: { cx: number('cx'), cy: number('cy'), width: rx * 2, height: ry * 2 } }
  }
  if (node.name === 'rect') {
    if (number('rx') || number('ry')) throw new Error('SVG 圆角矩形不受支持')
    const width = number('width')
    const height = number('height')
    if (width <= 0 || height <= 0) throw new Error('SVG 矩形尺寸必须大于零')
    return { type: 'rectangle', geometry: { cx: number('x') + width / 2, cy: number('y') + height / 2, width, height } }
  }
  const tokens = (attributes.points || '').trim().split(/[\s,]+/).filter(Boolean).map((item) => finite(item, 'SVG points'))
  if (tokens.length !== 6) throw new Error('SVG 仅支持三顶点三角形')
  const points = [[tokens[0], tokens[1]], [tokens[2], tokens[3]], [tokens[4], tokens[5]]]
  const cx = (Math.min(...points.map((point) => point[0])) + Math.max(...points.map((point) => point[0]))) / 2
  const cy = (Math.min(...points.map((point) => point[1])) + Math.max(...points.map((point) => point[1]))) / 2
  const minY = Math.min(...points.map((point) => point[1]))
  const maxY = Math.max(...points.map((point) => point[1]))
  const levelTolerance = Math.max(maxY - minY, 1) * .02
  const baseIsTop = points.filter((point) => Math.abs(point[1] - minY) <= levelTolerance).length === 2
  const baseY = baseIsTop ? minY : maxY
  const tip = points.find((point) => Math.abs(point[1] - (baseIsTop ? maxY : minY)) <= levelTolerance)
  const base = points.filter((point) => point !== tip).sort((a, b) => a[0] - b[0])
  const width = base.length === 2 ? Math.hypot(base[1][0] - base[0][0], base[1][1] - base[0][1]) : 0
  const height = maxY - minY
  if (!width || !height || Math.abs(tip[0] - cx) > width * .02 || Math.abs(base[0][1] - base[1][1]) > height * .02
    || Math.abs(base[0][0] - (cx - width / 2)) > width * .02 || Math.abs(base[1][0] - (cx + width / 2)) > width * .02) {
    throw new Error('SVG 三角形必须是中心对称的等腰三角形')
  }
  return { type: 'triangle', geometry: { cx, cy, width, height, tipSign: Math.sign(tip[1] - baseY) } }
}

/** Import fill-only SVG ellipses, rectangles and isosceles triangles. */
export function importPrimitiveSvg(source) {
  const root = parseXml(source)
  if (root.name !== 'svg') throw new Error('根元素必须是 svg')
  const rootAttrs = svgAttributes(root, new Set(['xmlns', 'version', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'role', 'aria-label', 'transform', 'fill', 'fill-opacity', 'opacity', 'stroke']))
  const readDimension = (value, fallback, label) => {
    if (value == null) return fallback
    const match = String(value).match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:px)?$/)
    if (!match) throw new Error(`SVG ${label} 只支持 px 数值`)
    return finite(match[1], label)
  }
  const box = (rootAttrs.viewBox || '').trim().split(/[\s,]+/).filter(Boolean).map((item) => finite(item, 'viewBox'))
  if (box.length !== 4) throw new Error('SVG 必须提供四项 viewBox')
  const [minX, minY, viewWidth, viewHeight] = box
  const width = readDimension(rootAttrs.width, viewWidth, 'width')
  const height = readDimension(rootAttrs.height, viewHeight, 'height')
  if (width <= 0 || height <= 0 || viewWidth <= 0 || viewHeight <= 0) throw new Error('SVG 尺寸必须大于零')
  if (rootAttrs.preserveAspectRatio && rootAttrs.preserveAspectRatio !== 'none' && rootAttrs.preserveAspectRatio !== 'xMidYMid meet') throw new Error('SVG preserveAspectRatio 选项不受支持')
  const scale = rootAttrs.preserveAspectRatio === 'none' ? null : Math.min(width / viewWidth, height / viewHeight)
  const scaleX = scale ?? width / viewWidth
  const scaleY = scale ?? height / viewHeight
  const offsetX = scale == null ? 0 : (width - viewWidth * scale) / 2
  const offsetY = scale == null ? 0 : (height - viewHeight * scale) / 2
  const baseMatrix = {
    a: scaleX, b: 0, c: 0, d: -scaleY,
    e: offsetX - minX * scaleX - width / 2,
    f: height / 2 - offsetY + minY * scaleY,
  }
  const elements = []
  const walk = (node, parentMatrix, inheritedFill, inheritedOpacity, isRoot = false) => {
    const common = svgAttributes(node, isRoot
      ? new Set(['xmlns', 'version', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'role', 'aria-label', 'transform', 'fill', 'fill-opacity', 'opacity', 'stroke'])
      : node.name === 'g'
        ? new Set(['transform', 'fill', 'fill-opacity', 'opacity', 'stroke', 'id', 'class'])
        : node.name === 'ellipse'
          ? new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'fill-opacity', 'opacity', 'transform', 'stroke', 'id', 'class'])
          : node.name === 'rect'
            ? new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'fill-opacity', 'opacity', 'transform', 'stroke', 'id', 'class'])
            : node.name === 'polygon'
              ? new Set(['points', 'fill', 'fill-opacity', 'opacity', 'transform', 'stroke', 'id', 'class'])
              : new Set())
    if (!isRoot && !['g', 'ellipse', 'rect', 'polygon'].includes(node.name)) throw new Error(`SVG 元素不受支持：${node.name}`)
    const matrix = multiplyMatrix(parentMatrix, parseTransform(common.transform))
    const fill = common.fill ?? inheritedFill ?? '#000000'
    const opacity = inheritedOpacity * Math.max(0, Math.min(1, finite(common.opacity ?? 1, 'opacity'))) * Math.max(0, Math.min(1, finite(common['fill-opacity'] ?? 1, 'fill-opacity')))
    if (node.name === 'ellipse' || node.name === 'rect' || node.name === 'polygon') {
      if (fill !== 'none' && opacity > 0) {
        const typeAndGeometry = svgShapeGeometry(node, common)
        const color = parseColor(fill)
        elements.push(transformGeometry(typeAndGeometry.type, typeAndGeometry.geometry, matrix, { ...color, a: color.a * opacity }))
      }
      if (node.children.length) throw new Error('SVG 形状不能包含子元素')
      return
    }
    for (const child of node.children) walk(child, matrix, fill, opacity)
  }
  walk(root, baseMatrix, null, 1, true)
  return validateFitData({ version: 1, width, height, elements })
}

function cssRules(source) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, '')
  if (/@|<|>/u.test(text)) throw new Error('shaper CSS 不支持 at-rule 或 HTML')
  const rules = []
  const consumed = text.replace(/([^{}]+)\{([^{}]*)\}/g, (_all, selector, body) => {
    for (const item of selector.split(',')) rules.push({ selector: item.trim().replace(/^\./, '.'), declarations: body.trim() })
    return ''
  })
  if (consumed.trim()) throw new Error('CSS 规则格式无效')
  return rules
}

function cssLength(value, label) {
  const match = String(value || '').trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))(?:px)?$/)
  if (!match) throw new Error(`${label} 只支持 px 数值`)
  return finite(match[1], label)
}

function cssCenter(value, size, label, axis) {
  const text = String(value || '').trim()
  const calc = text.match(/^calc\(\s*50%\s*([+-])\s*((?:\d+\.?\d*|\.\d+))px\s*\)$/)
  if (calc) return (calc[1] === '-' ? -1 : 1) * Number(calc[2])
  if (/^50%$/.test(text)) return 0
  const absolute = cssLength(text, label)
  return axis === 'x' ? absolute + size / 2 : size / 2 - absolute
}

function parseCssTransform(value) {
  let angle = 0
  let sx = 1
  let sy = 1
  const source = String(value || '').trim()
  if (!source) return { angle, sx, sy, centered: false }
  const pattern = /(translate|rotate|scale|scaleX|scaleY)\s*\(([^)]*)\)/gy
  let cursor = 0
  let centered = false
  let match
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] || '')) cursor += 1
    pattern.lastIndex = cursor
    match = pattern.exec(source)
    if (!match) throw new Error('shaper CSS transform 只支持 translate、rotate 和 scale')
    const values = match[2].trim().split(/[\s,]+/).filter(Boolean)
    if (match[1] === 'translate') {
      if (values.length === 2 && values[0] === '-50%' && values[1] === '-50%') centered = true
      else throw new Error('shaper CSS 只支持 translate(-50%, -50%)')
    } else if (match[1] === 'rotate') {
      const degrees = values[0]?.match(/^([+-]?(?:\d+\.?\d*|\.\d+))deg$/)
      if (values.length !== 1 || !degrees) throw new Error('shaper CSS rotate 必须使用 deg')
      angle += finite(degrees[1], 'rotate')
    } else {
      const parsed = values.map((item) => finite(item, 'scale'))
      if (!parsed.length || parsed.length > 2) throw new Error('shaper CSS scale 参数无效')
      if (match[1] === 'scale') { sx *= parsed[0]; sy *= parsed[1] ?? parsed[0] }
      else if (match[1] === 'scaleX') sx *= parsed[0]
      else sy *= parsed[0]
    }
    cursor = pattern.lastIndex
  }
  return { angle, sx, sy, centered }
}

function readCssColor(row) {
  const value = row.background || row['background-color'] || 'transparent'
  if (/[()]/.test(value) && /^url\(/i.test(value.trim())) throw new Error('CSS 图片背景不受支持')
  return parseColor(value)
}

/** Export the supported shaper-container/shaper-element CSS subset. */
export function exportPrimitiveCss(input) {
  const fit = validateFitData(input)
  const rules = [
    `.shaper-container { position: relative; width: ${fmt(fit.width)}px; height: ${fmt(fit.height)}px; overflow: hidden; background: transparent; }`,
    '.shaper-element { position: absolute; transform: translate(-50%, -50%); transform-origin: center center; }',
  ]
  fit.elements.forEach((element, index) => {
    const position = (value) => `calc(50% ${value < 0 ? '-' : '+'} ${fmt(Math.abs(value))}px)`
    const x = position(element.x)
    const y = position(-element.y)
    const style = [
      `left: ${x}`, `top: ${y}`,
      `width: ${fmt(element.width)}px`, `height: ${fmt(element.height)}px`,
      `transform: translate(-50%, -50%) rotate(${fmt(-element.rotation)}deg)`,
      `background: ${colorCss(element.color)}`,
    ]
    if (element.type === 'ellipse') style.push('border-radius: 50%')
    if (element.type === 'triangle') style.push('clip-path: polygon(50% 0%, 100% 100%, 0% 100%)')
    rules.push(`.shaper-e${index} { ${style.join('; ')}; }`)
  })
  return rules.join('\n')
}

/** Import the supported shaper CSS subset; container background becomes a bottom rectangle. */
export function importPrimitiveCss(source) {
  const parsed = new Map()
  for (const rule of cssRules(source)) {
    const selector = rule.selector
    if (!['.shaper-container', '.shaper-element'].includes(selector) && !/^\.shaper-e\d+$/.test(selector)) throw new Error(`CSS 选择器不受支持：${selector}`)
    const allowed = new Set(['position', 'width', 'height', 'overflow', 'left', 'top', 'transform', 'transform-origin', 'background', 'background-color', 'border-radius', 'clip-path'])
    const declarations = parseStyle(rule.declarations, allowed)
    parsed.set(selector, { ...(parsed.get(selector) || {}), ...declarations })
  }
  const container = parsed.get('.shaper-container')
  if (!container) throw new Error('CSS 缺少 .shaper-container')
  const width = cssLength(container.width, '容器宽度')
  const height = cssLength(container.height, '容器高度')
  if (width <= 0 || height <= 0) throw new Error('CSS 容器尺寸必须大于零')
  if (container.background && /url\(|gradient\(/i.test(container.background)) throw new Error('CSS 渐变和图片背景不受支持')
  const elements = []
  const background = readCssColor(container)
  if (background.a > 0) elements.push({ type: 'rectangle', imageId: SHAPE_IMAGE_IDS.rectangle, x: 0, y: 0, width, height, rotation: 0, color: background })
  const base = parsed.get('.shaper-element') || {}
  const names = [...parsed.keys()].filter((selector) => /^\.shaper-e\d+$/.test(selector)).sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))
  for (const selector of names) {
    const row = { ...base, ...parsed.get(selector) }
    const elementWidth = cssLength(row.width, `${selector} 宽度`)
    const elementHeight = cssLength(row.height, `${selector} 高度`)
    if (elementWidth <= 0 || elementHeight <= 0) throw new Error(`${selector} 尺寸必须大于零`)
    if (row.position && row.position !== 'absolute') throw new Error(`${selector} position 必须是 absolute`)
    if (row['transform-origin'] && row['transform-origin'] !== 'center' && row['transform-origin'] !== 'center center') throw new Error(`${selector} transform-origin 只支持 center`)
    const transform = parseCssTransform(row.transform)
    if (!transform.centered && /translate\(/.test(row.transform || '')) throw new Error(`${selector} 平移锚点不支持`)
    let type = 'rectangle'
    if (row['clip-path']) {
      if (!/^polygon\(\s*50%\s+0%\s*,\s*100%\s+100%\s*,\s*0%\s+100%\s*\)$/i.test(row['clip-path'])) throw new Error(`${selector} 只支持等腰三角形 clip-path`)
      type = 'triangle'
    } else if (row['border-radius']) {
      if (!/^50%(?:\s*\/\s*50%)?$/.test(row['border-radius'].trim())) throw new Error(`${selector} 只支持椭圆 border-radius: 50%`)
      type = 'ellipse'
    }
    const color = readCssColor(row)
    if (color.a === 0) continue
    elements.push({
      type, imageId: SHAPE_IMAGE_IDS[type],
      x: cssCenter(row.left, width, `${selector} left`, 'x'),
      y: -cssCenter(row.top, height, `${selector} top`, 'y'),
      width: elementWidth * Math.abs(transform.sx), height: elementHeight * Math.abs(transform.sy),
      rotation: -transform.angle, color,
    })
  }
  return validateFitData({ version: 1, width, height, elements })
}

function rgbaInt(color) {
  return (((Math.round(color.a * 255) & 255) << 24) | ((color.r & 255) << 16) | ((color.g & 255) << 8) | (color.b & 255)) >>> 0
}

function transformForElement(element, imageBox, fit) {
  const contain = Math.min(Math.abs(imageBox.width) / fit.width, Math.abs(imageBox.height) / fit.height)
  const scale = Number.isFinite(contain) && contain > 0 ? contain : 1
  return {
    scale: { x: 1, y: 1, z: 1 },
    rotation: { x: 0, y: 0, z: element.rotation },
    anchorMin: { x: 0.5, y: 0.5 }, anchorMax: { x: 0.5, y: 0.5 },
    offset: { x: element.x * scale, y: element.y * scale },
    size: { x: element.width * scale, y: element.height * scale },
    pivot: { x: 0.5, y: 0.5 },
  }
}

function uniquePrimitiveId(base, ids) {
  let id = base
  let suffix = 1
  while (ids.has(id)) { suffix += 1; id = `${base}_${suffix}` }
  ids.add(id)
  return id
}

function resourceIdFor(look2, node) {
  const siteNode = look2?.siteNodes?.[node.id]
  if (siteNode?.type && !['image', 'primitive'].includes(siteNode.type)) return null
  return siteNode?.properties?.imageResourceId || siteNode?.properties?.primitiveResourceId || null
}

function collectNodes(root, out = []) {
  if (!root) return out
  out.push(root)
  for (const child of root.children || []) collectNodes(child, out)
  return out
}

function boxForPlatform(project, nodeId, platform) {
  const canvasId = CANONICAL_CANVAS_BY_PLATFORM[platform]
  return layoutTree(project.root, canvasId, platform).boxes[nodeId]
}

function makeBakedChildren(project, node, fit, ids) {
  const children = []
  for (let index = 0; index < fit.elements.length; index += 1) {
    const element = fit.elements[index]
    const id = uniquePrimitiveId(`${node.id}__primitive_${String(index + 1).padStart(3, '0')}`, ids)
    const transformByPlatform = Object.fromEntries(PLATFORMS.map((platform) => {
      const box = boxForPlatform(project, node.id, platform) || { width: fit.width, height: fit.height }
      return [platform, transformForElement(element, box, fit)]
    }))
    children.push(createNode('image', {
      id, name: `图元_${String(index + 1).padStart(3, '0')}`,
      imageId: element.imageId, imageSource: 'StaticReference', imageColor: rgbaInt(element.color),
      transformByPlatform,
    }))
  }
  // FitData is a paint list (last shape on top); authoring lists put the
  // foremost sibling first. Keep shape names tied to their FitData indices.
  return children.reverse()
}

function bakeNodeTree(project, look2, ids, warnings) {
  const visit = (node) => {
    node.children = (node.children || []).map(visit)
    if (!['image', 'primitive'].includes(node.kind)) return node
    const id = resourceIdFor(look2, node)
    const resource = look2?.primitiveResources?.find((item) => item.id === id)
    if (!resource?.fitData) {
      if (id) warnings.push(`${node.name || node.id}：图片资源尚未生成图元，千星导出暂保留 imageId；请先完成拟合。`)
      return node
    }
    let fit
    try { fit = validateFitData(resource.fitData) }
    catch (error) { warnings.push(`${node.name || node.id}：拟合数据无效，保留原图片（${error.message}）`); return node }
    const baked = makeBakedChildren(project, node, fit, ids)
    node.kind = 'container'
    node.giaRaw = createGiaRaw('container', node.giaRaw)
    delete node.imageSource
    delete node.imageId
    delete node.imageColor
    delete node.enableMask
    delete node.enableSoftEdge
    delete node.softEdgeMode
    delete node.softEdgeWidthX
    delete node.softEdgeWidthY
    delete node.horizontalSoftRange
    delete node.verticalSoftRange
    delete node.enableFill
    delete node.fillType
    delete node.fillHorizontalType
    delete node.fillVerticalType
    delete node.fillRadial90Type
    delete node.fillRadialType
    delete node.fillAmount
    delete node.reverseMaskArea
    node.isolateNavigation = false
    node.disableKeyEventPassthrough = false
    node.disableCursorEventPassthrough = false
    node.showCursor = false
    // Existing descendants previously painted above the source image.
    node.children = [...(node.children || []), ...baked]
    return node
  }
  project.root = visit(project.root)
}

/** Bake every valid primitive-bound image into a cloned project; the input remains untouched. */
export function bakePrimitives(project, look2) {
  if (!project?.root) throw new Error('project.root 缺失')
  const cloned = clone(project)
  const ids = new Set(collectNodes(cloned.root).map((node) => String(node.id)))
  const warnings = []
  bakeNodeTree(cloned, look2, ids, warnings)
  return { project: cloned, warnings }
}

/** Build compact PrimitiveImage v3 data for every bound descendant below rootId. */
export function buildPrimitiveData(project, look2, rootId) {
  if (!project?.root) throw new Error('project.root 缺失')
  const root = collectNodes(project.root).find((item) => String(item.id) === String(rootId))
  if (!root) throw new Error(`找不到图元根控件：${rootId}`)
  const canvasId = CANVAS_PRESETS[project.canvasId] ? project.canvasId : DEFAULT_CANVAS_ID
  const canvas = CANVAS_PRESETS[canvasId]
  const boxes = layoutTree(project.root, canvasId, canvas.platform).boxes
  const groups = []
  const paths = new Set()
  const shapeCodes = { rectangle: 0, ellipse: 1, triangle: 2 }
  const round4 = (value) => Math.round(value * 10000) / 10000
  const visit = (node, pathSegments) => {
    if (['image', 'primitive'].includes(node.kind)) {
      const resourceId = resourceIdFor(look2, node)
      const resource = look2?.primitiveResources?.find((item) => item.id === resourceId)
      if (resource?.fitData) {
        if (pathSegments.some((segment) => segment.includes('/'))) throw new Error(`控件名称含有路径分隔符，无法生成 PrimitiveData 路径：${pathSegments.join('/')}`)
        const path = pathSegments.join('/')
        if (paths.has(path)) throw new Error(`图元相对路径重复，无法在运行时唯一定位：${path || '(root)'}`)
        paths.add(path)
        const fit = validateFitData(resource.fitData)
        const box = boxes[node.id]
        if (!box || !Number.isFinite(box.width) || !Number.isFinite(box.height)) throw new Error(`${node.name || node.id}：无法计算当前控件尺寸`)
        const scale = Math.max(0, Math.min(box.width / fit.width, box.height / fit.height))
        const group = {
          path,
          visible: false,
          elements: fit.elements.map((element) => [
            shapeCodes[element.type], 0,
            round4(element.x * scale), round4(element.y * scale),
            round4(element.width * scale), round4(element.height * scale),
            element.rotation, element.color.r, element.color.g, element.color.b,
            Math.round(255 * element.color.a),
          ]),
        }
        if (node.canControllerFocus === true) group.focus = true
        groups.push(group)
      }
    }
    for (const child of node.children || []) {
      visit(child, [...pathSegments, String(child.name || child.id)])
    }
  }
  visit(root, [])
  if (!groups.length) throw new Error(`控件 ${root.name || root.id} 下没有可导出的拟合图元`)
  return { v: 3, groups }
}

/** Emit a Lua 5.1-compatible primitive image library using documented dot-call game APIs. */
export function exportPrimitiveLibrary() {
  return `local PrimitiveImageLib = {}
local owned = setmetatable({}, { __mode = "k" })
local ownedById = {}
local shapeImageIds = { [0] = 100001, [1] = 100002, [2] = 100003 }
local shapeCodesByImageId = { [100001] = 0, [100002] = 1, [100003] = 2 }
local columnsV1 = { "imageId", "imageType", "x", "y", "width", "height", "rotation", "r", "g", "b", "a" }

local function finite(value, fallback)
  if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then return fallback end
  return value
end

local function isInteger(value, minimum, maximum)
  return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
    and value == math.floor(value) and value >= minimum and value <= maximum
end

local function arrayLength(value)
  if type(value) ~= "table" then return nil end
  local count = 0
  local maximum = 0
  for key in pairs(value) do
    if not isInteger(key, 1, 100000) then return nil end
    count = count + 1
    if key > maximum then maximum = key end
  end
  if count ~= maximum then return nil end
  return maximum
end

local function readRow(row, compact)
  if arrayLength(row) ~= 11 then error("primitive element rows must contain exactly 11 values") end
  local imageId
  local modeName
  if compact then
    if not isInteger(row[1], 0, 2) then error("invalid compact primitive shape code") end
    if not isInteger(row[2], 0, 1) then error("invalid compact primitive image mode") end
    imageId = shapeImageIds[row[1]]
    modeName = row[2] == 0 and "Basic" or "Stretch"
  else
    if not isInteger(row[1], 100001, 100003) or not shapeCodesByImageId[row[1]] then error("invalid v1 primitive image ID") end
    if row[2] ~= "Basic" and row[2] ~= "Stretch" then error("invalid v1 primitive image type") end
    imageId = row[1]
    modeName = row[2]
  end
  local values = {}
  for index = 3, 11 do
    local value = finite(row[index], nil)
    if value == nil then error("primitive row contains a non-finite value") end
    values[index] = value
  end
  if values[5] < 0 or values[6] < 0 then error("primitive row width and height must be non-negative") end
  for index = 8, 11 do
    if not isInteger(values[index], 0, 255) then error("primitive row colors must be byte values") end
  end
  return {
    imageId = imageId, modeName = modeName,
    x = values[3], y = values[4], width = values[5], height = values[6], rotation = values[7],
    r = values[8], g = values[9], b = values[10], a = values[11],
  }
end

local function normalizeData(root, data)
  local compact
  if data.v == 2 or data.v == 3 then
    compact = true
  elseif data.v == nil and data.schema == "UGCTools.PrimitiveProject@1" then
    compact = false
    if arrayLength(data.columns) ~= #columnsV1 then error("v1 PrimitiveData columns are invalid") end
    for index, name in ipairs(columnsV1) do
      if data.columns[index] ~= name then error("v1 PrimitiveData columns are invalid") end
    end
  else
    error("unsupported PrimitiveData version or schema")
  end
  local groupCount = arrayLength(data.groups)
  if not groupCount or groupCount == 0 then error("primitive groups are missing or malformed") end
  local groups = {}
  local seenPaths = {}
  for groupIndex = 1, groupCount do
    local source = data.groups[groupIndex]
    if type(source) ~= "table" then error("primitive group is malformed") end
    local path = source.path
    if path == nil then path = "" end
    if type(path) ~= "string" or path:sub(1, 1) == "/" or path:sub(-1) == "/" or path:find("//", 1, true) then
      error("primitive group path is invalid")
    end
    if seenPaths[path] then error("duplicate primitive group path: " .. path) end
    seenPaths[path] = true
    if source.visible ~= nil and type(source.visible) ~= "boolean" then error("primitive group visible must be boolean") end
    if source.focus ~= nil and type(source.focus) ~= "boolean" then error("primitive group focus must be boolean") end
    local target = path == "" and root or root:FindChild(path)
    if not target then error("primitive group target path was not found: " .. path) end
    local rowCount = arrayLength(source.elements)
    if not rowCount then error("primitive group elements are malformed") end
    local elements = {}
    for rowIndex = 1, rowCount do elements[rowIndex] = readRow(source.elements[rowIndex], compact) end
    groups[groupIndex] = { path = path, target = target, visible = source.visible, focus = source.focus, elements = elements }
  end
  return groups
end

local function destroyList(list, keepTargets)
  if not list then return end
  local errors = {}
  for i = #list.pendingControls, 1, -1 do
    local control = list.pendingControls[i]
    local ok, failure = pcall(function()
      if control and control.alive then
        control:SetVisible(false)
        game.DestroyClientUIControl(control)
      end
    end)
    if ok then
      table.remove(list.pendingControls, i)
    else
      errors[#errors + 1] = tostring(failure)
    end
  end
  for i = #list.targets, 1, -1 do
    local target = list.targets[i]
    if not target then
      table.remove(list.targets, i)
    elseif not (keepTargets and keepTargets[target.id]) then
      local ok, failure = pcall(function()
        if target.control and target.control.alive then
          target.control:SetVisible(target.visible)
          target.control.canControllerFocus = target.focus
        end
      end)
      if ok then
        table.remove(list.targets, i)
      else
        errors[#errors + 1] = tostring(failure)
      end
    end
  end
  if #errors > 0 then error("[PrimitiveImageLib] 图片清理失败：" .. table.concat(errors, "; "), 0) end
end

local function clearOwnership(list)
  if list.root and owned[list.root] == list then owned[list.root] = nil end
  if list.rootId and ownedById[list.rootId] == list then ownedById[list.rootId] = nil end
end

local function attachDestroyHandle(list)
  list.controls.destroy = function(self)
    if self ~= list.controls or owned[list.root] ~= list or ownedById[list.rootId] ~= list then return false end
    destroyList(list)
    clearOwnership(list)
    return true
  end
end

local function rollbackList(list)
  for _, target in ipairs(list.targets) do
    target.visible = target.currentVisible
    target.focus = target.currentFocus
  end
  destroyList(list)
end

local function retainRetryCleanup(owner, pending)
  for _, control in ipairs(pending.pendingControls) do
    owner.pendingControls[#owner.pendingControls + 1] = control
    owner.controls[#owner.controls + 1] = control
  end
  for _, target in ipairs(pending.targets) do owner.targets[#owner.targets + 1] = target end
end

function PrimitiveImageLib.destroy(root)
  local rootId = root and root.Id
  local list = (root and owned[root]) or (rootId and ownedById[rootId])
  if not list then return end
  destroyList(list)
  clearOwnership(list)
end

function PrimitiveImageLib.create(root, data, imagePrefabIndex)
  if not root then return nil, "root is required" end
  local rootId = root.Id
  if type(rootId) ~= "number" then return nil, "root.Id must be a number" end
  if type(data) ~= "table" then return nil, "primitive data is required" end
  if not isInteger(imagePrefabIndex, 1, 2147483647) then return nil, "imagePrefabIndex must be an integer template index" end
  local valid, groups = pcall(normalizeData, root, data)
  if not valid then return nil, tostring(groups) end
  local previous = (owned[root]) or ownedById[rootId]
  local previousTargets = {}
  if previous then
    for _, target in ipairs(previous.targets) do previousTargets[target.id] = target end
  end
  local list = { controls = {}, pendingControls = {}, targets = {}, targetIds = {}, warnings = {} }
  local ok, failure = pcall(function()
    for _, group in ipairs(groups) do
      local target = group.target
      local width, height = target:GetSizeDelta()
      width = math.abs(finite(width, 0))
      height = math.abs(finite(height, 0))
      for i, element in ipairs(group.elements) do
        local image = game.InstantiateClientUIControl(imagePrefabIndex, target)
        if not image then error("could not instantiate primitive image " .. tostring(i)) end
        list.controls[#list.controls + 1] = image
        list.pendingControls[#list.pendingControls + 1] = image
        image.name = "图元_" .. string.format("%03d", i)
        image:SetAnchorMin(0.5, 0.5)
        image:SetAnchorMax(0.5, 0.5)
        image:SetPivot(0.5, 0.5)
        image:SetAnchoredPosition(element.x, element.y)
        image:SetSizeDelta(element.width, element.height)
        image:SetLocalRotation(0, 0, element.rotation)
        image:SetImage(Enum.ImageSource.StaticReference, element.imageId)
        local modeOk, modeError = pcall(function() image.imageType = Enum.ImageType[element.modeName] end)
        if not modeOk then
          list.warnings[#list.warnings + 1] = "PrimitiveImageLib: element " .. tostring(i) .. " imageType " .. element.modeName .. " could not be assigned: " .. tostring(modeError)
        end
        image.imageColor = Color.FromRGBA(element.r, element.g, element.b, element.a)
        image:SetActive(true)
        image:SetAsLastSibling()
      end
      local targetId = target.Id
      if targetId and not list.targetIds[targetId] then
        list.targetIds[targetId] = true
        local oldTarget = previousTargets[targetId]
        list.targets[#list.targets + 1] = {
          id = targetId, control = target,
          currentVisible = target.visible, currentFocus = target.canControllerFocus,
          visible = oldTarget and oldTarget.visible or target.visible,
          focus = oldTarget and oldTarget.focus or target.canControllerFocus,
          desiredVisible = group.visible, desiredFocus = group.focus,
        }
        if oldTarget then
          local current = list.targets[#list.targets]
          if oldTarget.visible == false then current.visible = false end
          if oldTarget.focus == true then current.focus = true end
          if oldTarget.visibleSet then current.visible = oldTarget.visible end
          if oldTarget.focusSet then current.focus = oldTarget.focus end
        end
      end
    end
    for _, target in ipairs(list.targets) do
      local desiredVisible = target.desiredVisible
      local desiredFocus = target.desiredFocus
      target.visibleSet = desiredVisible ~= nil or (previousTargets[target.id] and previousTargets[target.id].visibleSet) or false
      target.focusSet = desiredFocus ~= nil or (previousTargets[target.id] and previousTargets[target.id].focusSet) or false
      if desiredVisible == nil and previousTargets[target.id] and previousTargets[target.id].visibleSet then desiredVisible = target.visible end
      if desiredFocus == nil and previousTargets[target.id] and previousTargets[target.id].focusSet then desiredFocus = target.focus end
      if desiredVisible ~= nil then target.control:SetVisible(desiredVisible) end
      if desiredFocus ~= nil then target.control.canControllerFocus = desiredFocus end
    end
  end)
  if not ok then
    local cleaned, cleanupFailure = pcall(function() rollbackList(list) end)
    if not cleaned then
      if previous then
        retainRetryCleanup(previous, list)
      else
        list.root = root
        list.rootId = rootId
        owned[root] = list
        ownedById[rootId] = list
        attachDestroyHandle(list)
      end
    end
    return nil, tostring(failure) .. (cleaned and "" or "; " .. tostring(cleanupFailure))
  end
  local keepTargets = list.targetIds
  if previous then
    local cleaned, cleanupFailure = pcall(function() destroyList(previous, keepTargets) end)
    if not cleaned then
      local rollbackOk, rollbackFailure = pcall(function() rollbackList(list) end)
      if not rollbackOk then retainRetryCleanup(previous, list) end
      error(tostring(cleanupFailure) .. (rollbackOk and "" or "; " .. tostring(rollbackFailure)), 0)
    end
    clearOwnership(previous)
  end
  list.root = root
  list.rootId = rootId
  owned[root] = list
  ownedById[rootId] = list
  attachDestroyHandle(list)
  return list.controls, list.warnings
end

return PrimitiveImageLib
`
}
