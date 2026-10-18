import { applyInspectorToTransform, cloneRectTransform, setAnchorPreset } from '../studio/ui/layout.js'

export const TRANSFORM_TRACK_PATHS = Object.freeze({
  anchoredPositionX: ['offset', 'x'], anchoredPositionY: ['offset', 'y'],
  sizeDeltaX: ['size', 'x'], sizeDeltaY: ['size', 'y'],
  localScaleX: ['scale', 'x'], localScaleY: ['scale', 'y'], localScaleZ: ['scale', 'z'],
  localRotationX: ['rotation', 'x'], localRotationY: ['rotation', 'y'], localRotationZ: ['rotation', 'z'],
  anchorMinX: ['anchorMin', 'x'], anchorMinY: ['anchorMin', 'y'],
  anchorMaxX: ['anchorMax', 'x'], anchorMaxY: ['anchorMax', 'y'],
  pivotX: ['pivot', 'x'], pivotY: ['pivot', 'y'],
})

const INSPECTOR_TRACK_FIELDS = Object.freeze({
  posX: 'anchoredPositionX', posY: 'anchoredPositionY',
  width: 'sizeDeltaX', height: 'sizeDeltaY',
  rotationZ: 'localRotationZ',
  anchorMinX: 'anchorMinX', anchorMinY: 'anchorMinY',
  anchorMaxX: 'anchorMaxX', anchorMaxY: 'anchorMaxY',
  pivotX: 'pivotX', pivotY: 'pivotY',
})

function numberValue(value, key) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${key} must be a finite number`)
  return number
}

function component(transform, path) {
  return Number(transform?.[path[0]]?.[path[1]])
}

export function setTransformTrackValue(transform, fieldKey, value) {
  const path = TRANSFORM_TRACK_PATHS[fieldKey]
  if (!path) return false
  if (!transform[path[0]] || !Object.hasOwn(transform[path[0]], path[1])) return false
  transform[path[0]][path[1]] = numberValue(value, fieldKey)
  return true
}

export function transformTrackValue(transform, fieldKey) {
  const path = TRANSFORM_TRACK_PATHS[fieldKey]
  return path ? component(transform, path) : undefined
}

export function setAbsoluteKeyframeValue(keyframe, value) {
  keyframe.value = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
  keyframe.relative = false
  delete keyframe.isDelta
  delete keyframe._legacyBaseDelta
  return keyframe
}

/** Convert the visible RectTransform inspector fields to the runtime channels they edit. */
export function inspectorTransformChannels(source, parentBox, box, values) {
  const original = cloneRectTransform(source)
  let transform = cloneRectTransform(source)
  const inspector = {
    posX: Number(box.centerX), posY: Number(box.centerY),
    width: Number(box.width), height: Number(box.height),
  }
  let solveRect = false

  for (const [key, value] of Object.entries(values || {})) {
    if (Object.hasOwn(inspector, key)) {
      inspector[key] = numberValue(value, key)
      solveRect = true
    } else if (key === 'rotationZ') {
      transform.rotation.z = numberValue(value, key)
    } else if (key === 'anchorType') {
      transform = setAnchorPreset(transform, value)
      solveRect = true
    } else if (key === 'anchorMinX' || key === 'anchorMinY') {
      transform.anchorMin[key.endsWith('X') ? 'x' : 'y'] = numberValue(value, key)
      solveRect = true
    } else if (key === 'anchorMaxX' || key === 'anchorMaxY') {
      transform.anchorMax[key.endsWith('X') ? 'x' : 'y'] = numberValue(value, key)
      solveRect = true
    } else if (key === 'pivotX' || key === 'pivotY') {
      transform.pivot[key.endsWith('X') ? 'x' : 'y'] = numberValue(value, key)
      solveRect = true
    }
  }

  if (solveRect) transform = applyInspectorToTransform(parentBox, transform, inspector)
  const channels = {}
  for (const fieldKey of Object.values(INSPECTOR_TRACK_FIELDS)) {
    const path = TRANSFORM_TRACK_PATHS[fieldKey]
    const before = component(original, path), after = component(transform, path)
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) > 1e-9) channels[fieldKey] = after
  }
  return { transform, channels }
}
