import { imageMaskBaseCoverage, imageMaskSpec } from '../studio/play/image-mask.js'

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

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

function stageMaskSpec(box) {
  return imageMaskSpec({
    ...box,
    kind: 'image',
    sourceWidth: finite(box.width, 0),
    sourceHeight: finite(box.height, 0),
  }, IDENTITY)
}

// Mutate the visual once, and return independent descendant coverage. The
// texture's alpha must not be multiplied into its own visual a second time.
export function applyStageImageMask(image, box = {}, tint = {}) {
  const { width, height, data } = image
  const mask = box.enableMask ? new Uint8ClampedArray(data.length) : null
  const spec = mask ? stageMaskSpec(box) : null
  const red = clamp(finite(tint.r, 255), 0, 255) / 255
  const green = clamp(finite(tint.g, 255), 0, 255) / 255
  const blue = clamp(finite(tint.b, 255), 0, 255) / 255
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (mask) {
      const localX = ((x + 0.5) / width - 0.5) * spec.width
      const localYUp = (0.5 - (y + 0.5) / height) * spec.height
      const effect = imageMaskBaseCoverage(localX, localYUp, spec)
      const sourceAlpha = data[i + 3]
      let coverage = Math.round(sourceAlpha * effect)
      if (spec.reverse) coverage = coverage > 0 ? 0 : 255
      mask[i] = mask[i + 1] = mask[i + 2] = 255
      mask[i + 3] = coverage
      data[i + 3] = Math.round(sourceAlpha * (spec.reverse ? 1 - effect : effect))
    }
    data[i] = Math.round(data[i] * red)
    data[i + 1] = Math.round(data[i + 1] * green)
    data[i + 2] = Math.round(data[i + 2] * blue)
  }
  return mask
}
