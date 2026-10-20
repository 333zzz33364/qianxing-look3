const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const normalized = value => String(value?.Name ?? value?.name ?? value ?? '').toLowerCase()
const modulo = (value, length) => ((value % length) + length) % length
const toDegrees = radians => radians * 180 / Math.PI
const toRadians = degrees => degrees * Math.PI / 180

const RADIAL_90 = {
  bottomleft: [-1, 1, 0],
  topleft: [-1, -1, 90],
  topright: [1, -1, 180],
  bottomright: [1, 1, 270],
}
const RADIAL_180 = {
  bottom: [0, 1, 270],
  left: [-1, 0, 0],
  top: [0, -1, 90],
  right: [1, 0, 180],
}
const RADIAL_360 = { bottom: 180, left: 270, top: 0, right: 90 }

function fillAmount(item) {
  const raw = Number(item?.fillAmount ?? 1)
  return Number.isFinite(raw) ? clamp(raw, 0, 1) : 1
}

/** Build centered, Y-down fill geometry shared by authoring, play and PNG. */
export function imageFillSpec(item, width, height) {
  if (!item || item.enableFill === false) return null
  const w = Math.max(0, finite(width, 0))
  const h = Math.max(0, finite(height, 0))
  const type = normalized(item.fillType)
  const amount = fillAmount(item)
  if (!type || type === 'unused') return null
  if (type === 'horizontal') {
    const filledWidth = w * amount
    return {
      kind: 'rect', type, amount,
      horizontalType: normalized(item.fillHorizontalType) || 'left',
      verticalType: normalized(item.fillVerticalType) || 'bottom',
      radial90Type: normalized(item.fillRadial90Type) || 'bottomleft',
      radialType: normalized(item.fillRadialType) || 'bottom',
      clockwise: item.fillClockwise !== false,
      x: normalized(item.fillHorizontalType) === 'right' ? w / 2 - filledWidth : -w / 2,
      y: -h / 2, width: filledWidth, height: h,
    }
  }
  if (type === 'vertical') {
    const filledHeight = h * amount
    return {
      kind: 'rect', type, amount,
      horizontalType: normalized(item.fillHorizontalType) || 'left',
      verticalType: normalized(item.fillVerticalType) || 'bottom',
      radial90Type: normalized(item.fillRadial90Type) || 'bottomleft',
      radialType: normalized(item.fillRadialType) || 'bottom',
      clockwise: item.fillClockwise !== false,
      x: -w / 2,
      y: normalized(item.fillVerticalType) === 'top' ? -h / 2 : h / 2 - filledHeight,
      width: w, height: filledHeight,
    }
  }

  const sweep = { radial90: 90, radial180: 180, radial360: 360 }[type]
  if (!sweep) return null
  let originX = 0, originY = 0, start
  if (type === 'radial90') {
    const [x, y, angle] = RADIAL_90[normalized(item.fillRadial90Type)] || RADIAL_90.bottomleft
    originX = x * w / 2
    originY = y * h / 2
    start = angle
  } else if (type === 'radial180') {
    const [x, y, angle] = RADIAL_180[normalized(item.fillRadialType)] || RADIAL_180.bottom
    originX = x * w / 2
    originY = y * h / 2
    start = angle
  } else {
    start = RADIAL_360[normalized(item.fillRadialType)] ?? RADIAL_360.bottom
  }
  const clockwise = item.fillClockwise !== false
  const radialStart = clockwise ? start : start + sweep
  return {
    kind: 'radial', type, amount, width: w, height: h,
    horizontalType: normalized(item.fillHorizontalType) || 'left',
    verticalType: normalized(item.fillVerticalType) || 'bottom',
    radial90Type: normalized(item.fillRadial90Type) || 'bottomleft',
    radialType: normalized(item.fillRadialType) || 'bottom',
    originX, originY, radialStart, radialSweep: sweep, clockwise,
  }
}

function insideRect(x, y, width, height) {
  return width > 0 && height > 0 && x >= -width / 2 && x <= width / 2 && y >= -height / 2 && y <= height / 2
}

/** Return analytic pixel coverage for a centered, Y-down fill spec. */
export function imageFillCoverage(localX, localY, spec) {
  if (!spec) return 1
  const x = finite(localX, 0), y = finite(localY, 0)
  if (spec.kind === 'rect') {
    if (!(spec.width > 0 && spec.height > 0)) return 0
    return x >= spec.x && x <= spec.x + spec.width && y >= spec.y && y <= spec.y + spec.height ? 1 : 0
  }
  if (spec.kind !== 'radial' || !insideRect(x, y, spec.width, spec.height)) return 0
  if (spec.amount <= 0) return 0
  if (spec.amount >= 1) return 1
  if (Math.hypot(x - spec.originX, y - spec.originY) < 1e-12) return 1
  const angle = modulo(toDegrees(Math.atan2(x - spec.originX, -(y - spec.originY))), 360)
  const delta = spec.clockwise
    ? modulo(angle - spec.radialStart, 360)
    : modulo(spec.radialStart - angle, 360)
  return delta < spec.radialSweep * spec.amount ? 1 : 0
}

function rayRectPoint(spec, angle) {
  const radians = toRadians(angle)
  const dx = Math.sin(radians), dy = -Math.cos(radians)
  const candidates = []
  if (dx > 1e-12) candidates.push((spec.width / 2 - spec.originX) / dx)
  else if (dx < -1e-12) candidates.push((-spec.width / 2 - spec.originX) / dx)
  if (dy > 1e-12) candidates.push((spec.height / 2 - spec.originY) / dy)
  else if (dy < -1e-12) candidates.push((-spec.height / 2 - spec.originY) / dy)
  const distance = Math.min(...candidates.filter(value => value >= 0))
  if (!Number.isFinite(distance)) return { x: spec.originX, y: spec.originY }
  return { x: spec.originX + dx * distance, y: spec.originY + dy * distance }
}

function angularProgress(angle, spec) {
  return spec.clockwise
    ? modulo(angle - spec.radialStart, 360)
    : modulo(spec.radialStart - angle, 360)
}

/** Polygon for renderer APIs that accept vector clipping paths. */
export function imageFillPolygon(spec) {
  if (!spec) return []
  if (spec.kind === 'rect') {
    if (!(spec.width > 0 && spec.height > 0)) return []
    return [
      { x: spec.x, y: spec.y },
      { x: spec.x + spec.width, y: spec.y },
      { x: spec.x + spec.width, y: spec.y + spec.height },
      { x: spec.x, y: spec.y + spec.height },
    ]
  }
  if (spec.kind !== 'radial' || spec.amount <= 0 || !(spec.width > 0 && spec.height > 0)) return []
  const corners = [
    { x: -spec.width / 2, y: -spec.height / 2 },
    { x: spec.width / 2, y: -spec.height / 2 },
    { x: spec.width / 2, y: spec.height / 2 },
    { x: -spec.width / 2, y: spec.height / 2 },
  ]
  if (spec.amount >= 1) return corners

  const sweep = spec.radialSweep * spec.amount
  const points = [{ progress: 0, point: rayRectPoint(spec, spec.radialStart) }]
  for (const point of corners) {
    const dx = point.x - spec.originX, dy = point.y - spec.originY
    if (Math.hypot(dx, dy) < 1e-12) continue
    const angle = modulo(toDegrees(Math.atan2(dx, -dy)), 360)
    const progress = angularProgress(angle, spec)
    if (progress > 1e-9 && progress < sweep - 1e-9) points.push({ progress, point })
  }
  points.push({ progress: sweep, point: rayRectPoint(spec, spec.radialStart + (spec.clockwise ? sweep : -sweep)) })
  points.sort((a, b) => a.progress - b.progress)
  const unique = []
  for (const entry of points) {
    const previous = unique.at(-1)
    if (!previous || Math.hypot(previous.x - entry.point.x, previous.y - entry.point.y) > 1e-8) unique.push(entry.point)
  }
  const origin = { x: spec.originX, y: spec.originY }
  if (unique.length && Math.hypot(unique[0].x - origin.x, unique[0].y - origin.y) < 1e-8) unique.shift()
  return [origin, ...unique]
}

function axisFeather(distance, size, feather) {
  if (distance < 0 || distance > size) return 0
  if (!(feather > 0)) return 1
  return clamp(Math.min(distance, size - distance) / feather, 0, 1)
}

/** Rectangular soft edge coverage; input localY follows runtime's Y-up matrices. */
export function imageMaskBaseCoverage(localX, localY, mask) {
  const width = Math.max(0, finite(mask?.width, 0))
  const height = Math.max(0, finite(mask?.height, 0))
  if (!(width > 0 && height > 0)) return 0
  const x = finite(localX, 0) + width / 2
  const y = -finite(localY, 0) + height / 2
  const featherX = Math.max(0, finite(mask?.featherX, 0))
  const featherY = Math.max(0, finite(mask?.featherY, 0))
  const left = axisFeather(x, width, featherX)
  const right = axisFeather(width - x, width, featherX)
  const top = axisFeather(y, height, featherY)
  const bottom = axisFeather(height - y, height, featherY)
  let coverage = mask?.composition === 'multiply'
    ? Math.min(left, right) * Math.min(top, bottom)
    : Math.min(left, right, top, bottom)
  if (coverage > 0 && mask?.fill) coverage *= imageFillCoverage(finite(localX, 0), -finite(localY, 0), mask.fill)
  return coverage
}

/** Inverted mask means the complement of every nonzero covered sample. */
export function imageMaskCoverage(localX, localY, mask) {
  const coverage = imageMaskBaseCoverage(localX, localY, mask)
  return mask?.reverse ? (coverage > 0 ? 0 : 1) : coverage
}
