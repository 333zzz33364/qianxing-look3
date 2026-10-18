import { COLOR_FIELDS, sampleTrack } from './sampling.js'
import { canvasBox, computeRect, identityMatrix, composeRectMatrix, applyMatrix } from '../ui/layout.js'

function colorValue(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'number') return value
  const packed = value >>> 0
  return { r: packed >>> 16 & 255, g: packed >>> 8 & 255, b: packed & 255, a: (packed >>> 24 & 255) / 255 }
}

export function previewAnimation(root, animation, time, canvas) {
  const rows = [], tracks = new Map()
  for (const track of animation.keyframeTracks || []) {
    const list = tracks.get(track.nodeId) || []
    list.push(track); tracks.set(track.nodeId, list)
  }
  function visit(base, parentBox, parentMatrix, parentVisible, inheritedGroupAlpha) {
    const control = { ...base }, id = base.authoringId
    const nodeTracks = tracks.get(id) || []
    for (const track of nodeTracks) {
      const initial = COLOR_FIELDS.has(track.fieldKey) ? colorValue(base[track.fieldKey])
        : track.fieldKey === 'groupAlpha' ? 255 : base[track.fieldKey] ?? (track.fieldKey === 'visible' ? base.visible : 0)
      const value = sampleTrack(track, time, initial)
      if (value !== null) control[track.fieldKey] = value
    }
    const box = computeRect(parentBox, control)
    const matrix = composeRectMatrix(parentMatrix, box, control)
    const topLeft = applyMatrix(matrix, box.left, box.top)
    const visible = parentVisible && control.active !== false && control.visible !== false
    // A groupAlpha track applies its absolute 0–255 factor to the entire
    // descendant tree. A nested group track replaces the inherited factor;
    // the exporter separately reports overlapping group target conflicts.
    const groupTrack = nodeTracks.find(track => track.fieldKey === 'groupAlpha')
    const inheritedAlpha = inheritedGroupAlpha ?? 1
    const alpha = groupTrack ? Math.max(0, Math.min(1, Number(control.groupAlpha ?? 255) / 255)) : inheritedAlpha
    rows.push({ ...control, ...box, id, matrix, topLeft, visible, alpha, base })
    for (const child of [...(base.children || [])].reverse()) visit(child, box, matrix, visible, alpha)
  }
  if (root) visit(root, canvasBox(canvas), identityMatrix(), true, 1)
  return rows
}
