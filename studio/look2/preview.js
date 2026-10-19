import { COLOR_FIELDS, sampleTrack } from './sampling.js'
import { canvasBox, computeRect, identityMatrix, composeRectMatrix, applyMatrix } from '../ui/layout.js'
import { PLATFORMS } from '../constants.js'
import { getPlatformTransform } from '../ui/transforms.js'

const transformFields = Object.freeze({
  anchoredPositionX: ['offset', 'x'], anchoredPositionY: ['offset', 'y'],
  sizeDeltaX: ['size', 'x'], sizeDeltaY: ['size', 'y'],
  anchorMinX: ['anchorMin', 'x'], anchorMinY: ['anchorMin', 'y'],
  anchorMaxX: ['anchorMax', 'x'], anchorMaxY: ['anchorMax', 'y'],
  pivotX: ['pivot', 'x'], pivotY: ['pivot', 'y'],
  localScaleX: ['scale', 'x'], localScaleY: ['scale', 'y'], localScaleZ: ['scale', 'z'],
  localRotationX: ['rotation', 'x'], localRotationY: ['rotation', 'y'], localRotationZ: ['rotation', 'z'],
})

/**
 * Project a compiled preview tree onto an authoring platform while leaving its
 * viewport and the project/runtime device selection untouched.
 */
export function projectPreviewTreeForPlatform(compiledRoot, authoredRoot, platform) {
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform ${platform}`)
  if (!compiledRoot) return null
  const authoringById = new Map()
  const collect = node => {
    if (!node || typeof node !== 'object') return
    if (node.id) authoringById.set(node.id, node)
    for (const child of node.children || []) collect(child)
  }
  collect(authoredRoot)

  function project(node) {
    const authored = authoringById.get(node.authoringId)
    const result = { ...node }
    if (authored?.transformByPlatform) {
      const transform = getPlatformTransform(authored.transformByPlatform, platform)
      for (const [field, [part, axis]] of Object.entries(transformFields)) result[field] = transform[part][axis]
    }
    if (node.children) result.children = node.children.map(project)
    return result
  }
  return project(compiledRoot)
}

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
