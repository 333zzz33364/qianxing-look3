import { CANONICAL_CANVAS_BY_PLATFORM, CANVAS_PRESETS, PLATFORMS } from '../constants.js'
import { findNode } from '../ui/authoring.js'
import { layoutTree } from '../ui/inspector.js'

export const BONE_THICKNESS = 25
export const DEFAULT_BONE_ARROW_LENGTH = 160
export const MAX_BONE_ARROW_LENGTH = 2000

const EPSILON = 1e-8
const TRACK_PATHS = Object.freeze({
  anchoredPositionX: ['offset', 'x'], anchoredPositionY: ['offset', 'y'],
  sizeDeltaX: ['size', 'x'], sizeDeltaY: ['size', 'y'],
  localScaleX: ['scale', 'x'], localScaleY: ['scale', 'y'], localScaleZ: ['scale', 'z'],
  localRotationX: ['rotation', 'x'], localRotationY: ['rotation', 'y'], localRotationZ: ['rotation', 'z'],
  anchorMinX: ['anchorMin', 'x'], anchorMinY: ['anchorMin', 'y'],
  anchorMaxX: ['anchorMax', 'x'], anchorMaxY: ['anchorMax', 'y'],
  pivotX: ['pivot', 'x'], pivotY: ['pivot', 'y'],
})

const finite = value => Number.isFinite(Number(value))
const clone = value => structuredClone(value)

function inverseMatrix(matrix) {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < EPSILON) return null
  const a = matrix.d / determinant
  const b = -matrix.b / determinant
  const c = -matrix.c / determinant
  const d = matrix.a / determinant
  return { a, b, c, d, tx: -(a * matrix.tx + c * matrix.ty), ty: -(b * matrix.tx + d * matrix.ty) }
}

function multiplyMatrix(outer, inner) {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  }
}

function applyMatrix(matrix, point) {
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.tx, y: matrix.b * point.x + matrix.d * point.y + matrix.ty }
}

function presetFor(platform, currentPlatform, currentCanvas) {
  if (platform === currentPlatform && finite(currentCanvas?.width) && finite(currentCanvas?.height)) {
    return { ...currentCanvas, platform }
  }
  return { ...CANVAS_PRESETS[CANONICAL_CANVAS_BY_PLATFORM[platform]], platform }
}

function parentPivot(box, transform) {
  return { x: box.left + box.width * transform.pivot.x, y: box.bottom + box.height * transform.pivot.y }
}

function boneGeometry(parentBox, parentTransform, start, end) {
  const inverse = inverseMatrix(parentBox.renderMatrix)
  if (!inverse) throw new Error('所选父级的变换不可逆，不能创建骨骼')
  const localStart = applyMatrix(inverse, start)
  const localEnd = applyMatrix(inverse, end)
  const pivot = parentPivot(parentBox, parentTransform)
  const dx = localEnd.x - localStart.x, dy = localEnd.y - localStart.y
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || length < 1) throw new Error('骨骼长度至少为 1 像素')
  const offset = { x: localStart.x - pivot.x, y: localStart.y - pivot.y }
  return { offset, length: Math.min(MAX_BONE_ARROW_LENGTH, length), rotation: Math.atan2(dy, dx) * 180 / Math.PI }
}

export function buildBoneTransformMap(root, { parentId, start, end, currentCanvas, currentPlatform }) {
  const parent = findNode(root, parentId)
  if (!parent || parent.kind !== 'container') throw new Error('骨骼父级必须是容器节点')
  if (!start || !end || ![start.x, start.y, end.x, end.y].every(finite)) throw new Error('骨骼坐标无效')
  if (!finite(currentCanvas?.width) || !finite(currentCanvas?.height) || currentCanvas.width <= 0 || currentCanvas.height <= 0) {
    throw new Error('当前画布尺寸无效')
  }
  if (!PLATFORMS.includes(currentPlatform)) throw new Error('当前设备平台无效')

  const transforms = {}
  let arrowLength = DEFAULT_BONE_ARROW_LENGTH
  for (const platform of PLATFORMS) {
    const canvas = presetFor(platform, currentPlatform, currentCanvas)
    const { boxes } = layoutTree(root, canvas, platform)
    const parentBox = boxes[parentId]
    const parentTransform = parent.transformByPlatform?.[platform]
    if (!parentBox || !parentTransform) throw new Error(`父级缺少 ${platform} 平台布局`)
    const startForPlatform = { x: start.x * canvas.width / currentCanvas.width, y: start.y * canvas.height / currentCanvas.height }
    const endForPlatform = { x: end.x * canvas.width / currentCanvas.width, y: end.y * canvas.height / currentCanvas.height }
    const geometry = boneGeometry(parentBox, parentTransform, startForPlatform, endForPlatform)
    const pivot = { ...parentTransform.pivot }
    transforms[platform] = {
      anchorMin: { ...pivot }, anchorMax: { ...pivot },
      offset: geometry.offset,
      size: { x: geometry.length, y: BONE_THICKNESS },
      pivot: { x: 0, y: 0.5 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: geometry.rotation },
    }
    if (platform === currentPlatform) arrowLength = geometry.length
  }
  return { transformByPlatform: transforms, directionArrowLength: arrowLength }
}

function decomposeLinear(matrix) {
  const scaleX = Math.hypot(matrix.a, matrix.b)
  const scaleYLength = Math.hypot(matrix.c, matrix.d)
  if (scaleX < EPSILON || scaleYLength < EPSILON) return null
  if (Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > 1e-6 * Math.max(1, scaleX * scaleYLength)) return null
  const rotation = Math.atan2(matrix.b, matrix.a)
  const scaleY = (matrix.a * matrix.d - matrix.b * matrix.c) / scaleX
  if (!Number.isFinite(scaleY) || Math.abs(scaleY) < EPSILON) return null
  return { rotation: rotation * 180 / Math.PI, scaleX, scaleY }
}

function transformForWorldPose(nodeTransform, nodeBox, nodeWorld, parentTransform, parentBox, parentWorld) {
  const inverseParent = inverseMatrix(parentWorld)
  if (!inverseParent) return null
  const localWorld = multiplyMatrix(inverseParent, nodeWorld)
  const decomposition = decomposeLinear(localWorld)
  if (!decomposition) return null
  const childPivot = {
    x: nodeBox.left + nodeBox.width * nodeTransform.pivot.x,
    y: nodeBox.bottom + nodeBox.height * nodeTransform.pivot.y,
  }
  const localPivot = applyMatrix(inverseParent, applyMatrix(nodeWorld, childPivot))
  const parentAnchor = parentPivot(parentBox, parentTransform)
  const next = clone(nodeTransform)
  next.anchorMin = { ...parentTransform.pivot }
  next.anchorMax = { ...parentTransform.pivot }
  next.offset = { x: localPivot.x - parentAnchor.x, y: localPivot.y - parentAnchor.y }
  next.size = { x: nodeBox.width, y: nodeBox.height }
  next.rotation = { x: 0, y: 0, z: decomposition.rotation }
  next.scale = { x: decomposition.scaleX, y: decomposition.scaleY, z: nodeTransform.scale.z }
  return next
}

function isDescendant(root, parentId, possibleDescendantId) {
  const parent = findNode(root, parentId)
  if (!parent) return false
  const stack = [...(parent.children || [])]
  while (stack.length) {
    const node = stack.pop()
    if (node.id === possibleDescendantId) return true
    stack.push(...(node.children || []))
  }
  return false
}

export function buildBoneAttachmentPlan(root, childId, parentId, {
  currentCanvas, currentPlatform, previewBoxes = [], lockedIds = [],
} = {}) {
  const child = findNode(root, childId)
  const parent = findNode(root, parentId)
  const locked = lockedIds instanceof Set ? lockedIds : new Set(lockedIds)
  if (!child || child.kind === 'server-container' || child.id === root?.id) throw new Error('待附着控件不存在或不可附着')
  if (!parent || parent.kind !== 'container' || parent.id === child.id || isDescendant(root, child.id, parent.id)) throw new Error('骨骼父级无效或会形成循环')
  if (locked.has(childId) || locked.has(parentId)) throw new Error('控件或父级已锁定，不能附着')

  const transforms = {}
  let previewTransform = null
  for (const platform of PLATFORMS) {
    const canvas = presetFor(platform, currentPlatform, currentCanvas)
    const { boxes } = layoutTree(root, canvas, platform)
    const childBox = boxes[childId], parentBox = boxes[parentId]
    const childTransform = child.transformByPlatform?.[platform]
    const parentTransform = parent.transformByPlatform?.[platform]
    if (!childBox || !parentBox || !childTransform || !parentTransform) throw new Error(`控件缺少 ${platform} 平台布局`)
    const next = transformForWorldPose(childTransform, childBox, childBox.renderMatrix, parentTransform, parentBox, parentBox.renderMatrix)
    if (!next) throw new Error(`控件在 ${platform} 平台下的变换含不可表示的剪切或退化缩放`)
    transforms[platform] = next
  }

  const previewById = new Map((previewBoxes || []).map(box => [box.id, box]))
  const previewChild = previewById.get(childId), previewParent = previewById.get(parentId)
  if (previewChild && previewParent && currentPlatform) {
    const canvas = presetFor(currentPlatform, currentPlatform, currentCanvas)
    const { boxes } = layoutTree(root, canvas, currentPlatform)
    const childBox = previewChild, parentBox = previewParent
    const baseChild = child.transformByPlatform[currentPlatform]
    const baseParent = parent.transformByPlatform[currentPlatform]
    const childTransform = {
      ...clone(baseChild),
      anchorMin: { x: previewChild.anchorMinX ?? baseChild.anchorMin.x, y: previewChild.anchorMinY ?? baseChild.anchorMin.y },
      anchorMax: { x: previewChild.anchorMaxX ?? baseChild.anchorMax.x, y: previewChild.anchorMaxY ?? baseChild.anchorMax.y },
      pivot: { x: previewChild.pivotX ?? baseChild.pivot.x, y: previewChild.pivotY ?? baseChild.pivot.y },
      scale: { x: previewChild.scaleX ?? baseChild.scale.x, y: previewChild.scaleY ?? baseChild.scale.y, z: previewChild.scaleZ ?? baseChild.scale.z },
    }
    const parentTransform = {
      ...clone(baseParent),
      pivot: { x: previewParent.pivotX ?? baseParent.pivot.x, y: previewParent.pivotY ?? baseParent.pivot.y },
    }
    const previewChildBox = { ...boxes[childId], ...childBox, renderMatrix: childBox.matrix }
    const previewParentBox = { ...boxes[parentId], ...parentBox, renderMatrix: parentBox.matrix }
    previewTransform = transformForWorldPose(childTransform, previewChildBox, previewChildBox.renderMatrix,
      parentTransform, previewParentBox, previewParentBox.renderMatrix)
    if (!previewTransform) throw new Error('当前动画姿态含不可表示的剪切或退化缩放，附着已取消')
  }
  return { transforms, previewTransform }
}

export function updateBoneDirectionState(look2, id, directionArrowLength, parentId = undefined) {
  const next = clone(look2 || {})
  next.siteNodes ||= {}
  const original = next.siteNodes[id] || { id, type: 'container', properties: {} }
  const editor = { ...(original.editor || {}), directionArrowLength: Number(directionArrowLength) }
  next.siteNodes[id] = { ...original, id, type: original.type || 'container', editor,
    ...(parentId === undefined ? {} : { parentId }) }
  return next
}

export function preserveUntrackedAttachmentPose(baseTransform, look2, nodeId, animationId, transform) {
  const next = clone(baseTransform)
  if (!transform) return next
  const animation = look2?.animations?.find(item => item.id === animationId)
  const trackedFields = new Set((animation?.keyframeTracks || [])
    .filter(track => track.nodeId === nodeId && Object.hasOwn(TRACK_PATHS, track.fieldKey))
    .map(track => track.fieldKey))
  for (const [fieldKey, [group, axis]] of Object.entries(TRACK_PATHS)) {
    if (trackedFields.has(fieldKey)) continue
    const value = transform[group]?.[axis]
    if (Number.isFinite(Number(value))) next[group][axis] = Number(value)
  }
  return next
}

export function preserveAttachmentAnimationState(look2, nodeId, animationId, transform, time, makeId) {
  if (!transform) return null
  const source = look2?.animations?.find(animation => animation.id === animationId)
  if (!source) return null
  const existing = (source.keyframeTracks || []).filter(track => track.nodeId === nodeId && Object.hasOwn(TRACK_PATHS, track.fieldKey))
  const existingFields = new Set(existing.map(track => track.fieldKey))
  const fields = Object.keys(TRACK_PATHS).filter(fieldKey => existingFields.has(fieldKey))
  if (!fields.length) return null
  const frameRate = Math.max(1, Number(look2.frameRate) || 30)
  const rawTime = Math.max(0, Math.min(Number(source.duration) || 5, Number(time) || 0))
  const recordTime = Number((look2.timelineSnapEnabled ? Math.round(rawTime * frameRate) / frameRate : rawTime).toFixed(4))
  const next = clone(look2)
  const animation = next.animations.find(item => item.id === animationId)
  animation.keyframeTracks ||= []
  for (const fieldKey of fields) {
    const path = TRACK_PATHS[fieldKey]
    const value = transform[path[0]][path[1]]
    if (!Number.isFinite(Number(value))) continue
    let track = animation.keyframeTracks.find(item => item.nodeId === nodeId && item.fieldKey === fieldKey)
    if (!track) continue
    track.keyframes ||= []
    let keyframe = track.keyframes.find(item => Math.abs(Number(item.time) - recordTime) < 0.0001)
    if (!keyframe) {
      if (typeof makeId !== 'function') throw new Error('缺少关键帧 ID 生成器')
      keyframe = { id: makeId('key'), time: recordTime, value: Number(value), easeType: 'Linear', interpolation: 'tween' }
      track.keyframes.push(keyframe)
      track.keyframes.sort((left, right) => Number(left.time) - Number(right.time))
    }
    keyframe.value = Number(value)
    keyframe.relative = false
    delete keyframe.isDelta
    delete keyframe._legacyBaseDelta
  }
  return next
}
