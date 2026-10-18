// Keep the complete projected affine transform, including reflection and shear.
// Decomposing to positive width/height + rotation loses X/Y back faces.
export function controlTransformStyle(box, canvasWidth, canvasHeight, offset = null) {
  const m = box.renderMatrix
  if (!m) return {}
  const x = m.a * box.centerX + m.c * box.centerY + m.tx + (Number(offset?.dx) || 0)
  const y = m.b * box.centerX + m.d * box.centerY + m.ty + (Number(offset?.dy) || 0)
  return {
    left: `${(x - box.width / 2) / canvasWidth * 100}%`,
    bottom: `${(y - box.height / 2) / canvasHeight * 100}%`,
    width: `${box.width / canvasWidth * 100}%`,
    height: `${box.height / canvasHeight * 100}%`,
    transform: `matrix(${m.a},${-m.b},${-m.c},${m.d},0,0)`,
  }
}
