// Editor preview policy follows ugc-tool 46052fc / e48a966. This is not
// additional device evidence for the separate play renderer's rectangle masks.
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))

// Position and tint do not affect mask coverage. Keep redraws independent of
// pointer movement, selection, and imageColor alpha (which only hides the image).
export function stageMaskKey(box = {}) {
  return JSON.stringify([
    box.enableMask, box.width, box.height, box.enableSoftEdge, box.softEdgeMode,
    box.softEdgeWidthX, box.softEdgeWidthY, box.horizontalSoftRange, box.verticalSoftRange,
    box.enableFill, box.fillType, box.fillHorizontalType, box.fillVerticalType,
    box.fillRadial90Type, box.fillRadialType, box.fillClockwise, box.fillAmount, box.reverseMaskArea,
  ])
}

function feather(distance, size, pixels, range, mode) {
  const edge = normalizedFillValue(mode) === 'pixel' ? Math.max(0, finite(pixels, 8)) / Math.max(1, size)
    : (100 - clamp(finite(range, 100), 0, 100)) / 200
  return edge > 0 ? clamp(Math.min(distance, 1 - distance) / edge) : 1
}

function fillCoverage(x, y, box) {
  if (box.enableFill === false) return 1
  const fillType = normalizedFillValue(box.fillType)
  if (!fillType || fillType === 'unused') return 1
  const amount = clamp(finite(box.fillAmount, 1))
  if (amount === 0) return 0
  if (amount === 1) return 1
  if (fillType === 'horizontal') return (normalizedFillValue(box.fillHorizontalType) === 'right' ? 1 - x : x) < amount ? 1 : 0
  if (fillType === 'vertical') return (normalizedFillValue(box.fillVerticalType) === 'top' ? y : 1 - y) < amount ? 1 : 0
  const sweep = { radial90: 90, radial180: 180, radial360: 360 }[fillType]
  if (!sweep) return 1
  let originX = .5, originY = .5
  let start = { bottom: 180, left: 270, top: 0, right: 90 }[normalizedFillValue(box.fillRadialType)] ?? 180
  if (fillType === 'radial90') {
    ;[originX, originY, start] = {
      bottomleft: [0, 1, 0], topleft: [0, 0, 90],
      topright: [1, 0, 180], bottomright: [1, 1, 270],
    }[normalizedFillValue(box.fillRadial90Type)] || [0, 1, 0]
  } else if (fillType === 'radial180') {
    ;[originX, originY, start] = {
      bottom: [.5, 1, 270], left: [0, .5, 0],
      top: [.5, 0, 90], right: [1, .5, 180],
    }[normalizedFillValue(box.fillRadialType)] || [.5, 1, 270]
  }
  // Conic gradients use physical lengths, so a non-square control needs its
  // aspect ratio included when measuring angles from the upward ray.
  const angle = Math.atan2((x - originX) * Math.max(1, box.width), -(y - originY) * Math.max(1, box.height)) * 180 / Math.PI
  const clockwise = box.fillClockwise !== false
  const fillStart = clockwise ? start : start + sweep
  const delta = clockwise ? angle - start : fillStart - angle
  return ((delta % 360 + 360) % 360) < sweep * amount ? 1 : 0
}

function normalizedFillValue(value) { return String(value ?? '').toLowerCase() }

// Mutate the visual once, and return independent descendant coverage. The
// texture's alpha must not be multiplied into its own visual a second time.
export function applyStageImageMask(image, box = {}, tint = {}) {
  const { width, height, data } = image
  const mask = box.enableMask ? new Uint8ClampedArray(data.length) : null
  const red = clamp(finite(tint.r, 255), 0, 255) / 255
  const green = clamp(finite(tint.g, 255), 0, 255) / 255
  const blue = clamp(finite(tint.b, 255), 0, 255) / 255
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    let effect = 1
    if (mask) {
      const nx = (x + .5) / width, ny = (y + .5) / height
      if (box.enableSoftEdge) effect *= feather(nx, box.width, box.softEdgeWidthX, box.horizontalSoftRange, box.softEdgeMode)
        * feather(ny, box.height, box.softEdgeWidthY, box.verticalSoftRange, box.softEdgeMode)
      effect *= fillCoverage(nx, ny, box)
      const sourceAlpha = data[i + 3]
      let coverage = Math.round(sourceAlpha * effect)
      if (box.reverseMaskArea) {
        // Upstream promotes every nonzero 8-bit sample before subtracting the
        // filled/feathered texture from the control rectangle.
        coverage = coverage > 0 ? 0 : 255
        effect = coverage / 255
      }
      mask[i] = mask[i + 1] = mask[i + 2] = 255
      mask[i + 3] = coverage
      data[i + 3] = Math.round(sourceAlpha * effect)
    }
    data[i] = Math.round(data[i] * red)
    data[i + 1] = Math.round(data[i + 1] * green)
    data[i + 2] = Math.round(data[i + 2] * blue)
  }
  return mask
}
