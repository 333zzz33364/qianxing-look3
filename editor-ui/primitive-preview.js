import { renderPrimitiveSvg } from '../studio/look2/primitives.js'

// Fit data is replaced by resource edits; a WeakMap retains no removed resource
// or old session. Hovering, dragging and selection reuse the same encoded SVG.
export function createPrimitivePreviewSource(render = renderPrimitiveSvg) {
  const sources = new WeakMap()
  return fitData => {
    let source = sources.get(fitData)
    if (!source) {
      source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(render(fitData))}`
      sources.set(fitData, source)
    }
    return source
  }
}
