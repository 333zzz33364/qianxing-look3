import { imageFillCoverage, imageFillPolygon, imageFillSpec } from './image-geometry.js'

export { imageFillCoverage, imageFillPolygon, imageFillSpec }

/** Keep the original rectangle API for renderer callers and compatibility tests. */
export function imageFillRect(item, width, height) {
  const spec = imageFillSpec(item, width, height)
  return spec?.kind === 'rect' ? { x: spec.x, y: spec.y, width: spec.width, height: spec.height } : null
}

/** Apply a shared rectangle or radial clip to a Canvas 2D context. */
export function clipImageFill(ctx, spec, scaleX = 1, scaleY = 1) {
  if (!spec) return false
  const points = imageFillPolygon(spec)
  ctx.beginPath()
  if (points.length) {
    points.forEach((point, index) => {
      const x = point.x * scaleX, y = point.y * scaleY
      if (index) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.closePath()
  } else {
    // A zero-area path makes the image invisible at zero progress.
    ctx.rect(0, 0, 0, 0)
  }
  ctx.clip()
  return true
}
