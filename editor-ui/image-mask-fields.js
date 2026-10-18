const normalized = value => String(value ?? '').toLowerCase()

/** Return only the image mask properties that are relevant to the current values. */
export function imageMaskFields(fields = []) {
  const byKey = new Map((Array.isArray(fields) ? fields : []).map(field => [field?.key, field]))
  const value = key => byKey.get(key)?.value
  const result = []
  const add = key => {
    const field = byKey.get(key)
    if (field) result.push(field)
  }

  add('enableMask')
  if (value('enableMask') !== true) return result

  add('enableSoftEdge')
  if (value('enableSoftEdge') === true) {
    add('softEdgeMode')
    if (normalized(value('softEdgeMode')) === 'percentage') {
      add('horizontalSoftRange')
      add('verticalSoftRange')
    } else {
      add('softEdgeWidthX')
      add('softEdgeWidthY')
    }
  }

  add('enableFill')
  const fillType = normalized(value('fillType'))
  const fillEnabled = value('enableFill') ?? Boolean(fillType && fillType !== 'unused')
  if (fillEnabled) {
    const shape = byKey.get('fillType')
    if (shape) result.push({
      ...shape,
      options: Array.isArray(shape.options)
        ? shape.options.filter(option => normalized(option?.value) !== 'unused')
        : shape.options,
    })
    if (fillType === 'horizontal') add('fillHorizontalType')
    else if (fillType === 'vertical') add('fillVerticalType')
    else if (fillType === 'radial90') add('fillRadial90Type')
    else if (fillType === 'radial180' || fillType === 'radial360') add('fillRadialType')
    if (fillType.startsWith('radial')) add('fillClockwise')
    add('fillAmount')
  }

  add('reverseMaskArea')
  return result
}
