import { CANVAS_PRESETS } from '../constants.js'
import { layoutTree } from '../ui/inspector.js'
import { applyMatrix, invertMatrix } from '../ui/layout.js'
import { projectCanvas } from '../ui/canvas.js'
import { EASE_TYPES, RELATIVE_FIELDS, TWEENABLE_FIELDS } from './sampling.js'

const epsilon = 1e-6
const clone = value => structuredClone(value)
const fieldParts = { anchoredPositionX: ['offset', 'x'], anchoredPositionY: ['offset', 'y'],
  sizeDeltaX: ['size', 'x'], sizeDeltaY: ['size', 'y'], localScaleX: ['scale', 'x'], localScaleY: ['scale', 'y'], localScaleZ: ['scale', 'z'],
  localRotationX: ['rotation', 'x'], localRotationY: ['rotation', 'y'], localRotationZ: ['rotation', 'z'],
  anchorMinX: ['anchorMin', 'x'], anchorMinY: ['anchorMin', 'y'], anchorMaxX: ['anchorMax', 'x'], anchorMaxY: ['anchorMax', 'y'],
  pivotX: ['pivot', 'x'], pivotY: ['pivot', 'y'] }

/** Upgrade old v12 Clip lanes at read time, retaining exact touching jumps. */
export function migrateSiteTweenClips(input, project) {
  if (!Array.isArray(input.tweenTracks)) return []
  const nodes = new Map(), parents = new Map()
  const visit = node => { nodes.set(node.id, node); for (const child of node.children || []) { parents.set(child.id, node); visit(child) } }
  visit(project.root)
  const canvas = projectCanvas(project), { boxes } = layoutTree(project.root, canvas)
  const groups = new Map(), ids = new Set()
  const unique = seed => { let id = seed, suffix = 1; while (ids.has(id)) id = `${seed}_${suffix++}`; ids.add(id); return id }
  const migrateValue = (node, field, value, relative) => {
    if (relative || typeof value !== 'number') return value
    const version = Number(input.timelineModelVersion)
    if (version !== 4 && version !== 6) return value
    const box = boxes[node.id], parent = parents.get(node.id)
    const parentBox = !parent || parent.kind === 'server-container' ? { left: 0, bottom: 0, ...canvas } : boxes[parent.id]
    const rt = node.transformByPlatform[CANVAS_PRESETS[project.canvasId]?.platform || 'KEYBOARD']
    const reference = { x: parentBox.left + parentBox.width * (rt.anchorMin.x + (rt.anchorMax.x - rt.anchorMin.x) * rt.pivot.x),
      y: parentBox.bottom + parentBox.height * (rt.anchorMin.y + (rt.anchorMax.y - rt.anchorMin.y) * rt.pivot.y) }
    if (version === 6) {
      if (field === 'anchoredPositionX') return value + (parent?.kind !== 'server-container' ? parentBox.left + parentBox.width / 2 : 0) - reference.x
      if (field === 'anchoredPositionY') return value + (parent?.kind !== 'server-container' ? parentBox.bottom + parentBox.height / 2 : 0) - reference.y
      return value
    }
    if (field === 'sizeDeltaX') return value - parentBox.width * (rt.anchorMax.x - rt.anchorMin.x)
    if (field === 'sizeDeltaY') return value - parentBox.height * (rt.anchorMax.y - rt.anchorMin.y)
    if (field !== 'anchoredPositionX' && field !== 'anchoredPositionY') return value
    const pivot = applyMatrix(box.renderMatrix, box.left + box.width * rt.pivot.x, box.bottom + box.height * rt.pivot.y)
    if (field === 'anchoredPositionX') pivot.x = value
    else pivot.y = value
    const inverse = parentBox.renderMatrix && invertMatrix(parentBox.renderMatrix)
    const local = inverse ? applyMatrix(inverse, pivot.x, pivot.y) : pivot
    return field === 'anchoredPositionX' ? local.x - reference.x : local.y - reference.y
  }
  for (const [index, clip] of input.tweenTracks.entries()) {
    const node = nodes.get(clip?.nodeId)
    const definition = node && TWEENABLE_FIELDS.find(field => field.fieldKey === clip.fieldKey && field.kinds.includes(node.kind))
    if (!definition) continue
    const relative = clip.relative === true && RELATIVE_FIELDS.has(clip.fieldKey)
    const rt = node.transformByPlatform[CANVAS_PRESETS[project.canvasId]?.platform || 'KEYBOARD']
    const part = fieldParts[clip.fieldKey]
    let base = clip.fieldKey === 'groupAlpha' ? 255 : part ? rt[part[0]][part[1]] : node[clip.fieldKey] ?? null
    if (definition.type === 'color' && typeof base === 'number') base = { r: base >>> 16 & 255, g: base >>> 8 & 255, b: base & 255, a: (base >>> 24 & 255) / 255 }
    const fallback = relative ? 0 : base
    const loadValue = slot => {
      if (!Object.hasOwn(clip, slot)) return clone(fallback)
      const value = clip[slot]
      if (value === null) return null
      const valid = definition.type === 'boolean' ? typeof value === 'boolean' : definition.type === 'color'
        ? value && ['r', 'g', 'b', 'a'].every(key => Number.isFinite(value[key])) : typeof value === 'number' && Number.isFinite(value)
      if (!valid) return clone(fallback)
      const normalized = definition.type === 'color' ? { r: Math.max(0, Math.min(255, Math.round(value.r))),
        g: Math.max(0, Math.min(255, Math.round(value.g))), b: Math.max(0, Math.min(255, Math.round(value.b))), a: Math.max(0, Math.min(1, value.a)) } : value
      return migrateValue(node, clip.fieldKey, clone(normalized), relative)
    }
    const duration = Math.max(.5, Number(input.duration) || 5)
    const clipDuration = Number(Math.min(duration, Math.max(.01, Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : Math.min(1, duration))).toFixed(6))
    const startTime = Number(Math.min(duration - clipDuration, Number.isFinite(clip.startTime) ? Math.max(0, clip.startTime) : 0).toFixed(6))
    const value = { ...clip, id: clip.id || `clip_${index}`, relative,
      startTime, duration: clipDuration, initialValue: loadValue('initialValue'), endValue: loadValue('endValue') }
    if (!EASE_TYPES.includes(value.easeType)) value.easeType = 'Linear'
    const lane = `${clip.nodeId}\0${clip.fieldKey}`, list = groups.get(lane) || []
    list.push(value); groups.set(lane, list)
  }
  return [...groups.values()].map(clips => {
    clips.sort((a, b) => a.startTime - b.startTime)
    const first = clips[0], track = { id: unique(`keytrack_${first.id}`), nodeId: first.nodeId, fieldKey: first.fieldKey, keyframes: [] }
    for (const clip of clips) {
      if (!Number.isFinite(clip.startTime) || clip.startTime < 0 || !Number.isFinite(clip.duration)
        || clip.duration <= epsilon || !Number.isFinite(clip.startTime + clip.duration)) throw new Error('旧动画 Clip 时间无效')
      const last = track.keyframes.at(-1)
      if (last && clip.startTime < last.time - epsilon) throw new Error('旧动画 Clip 重叠，无法无损迁移')
      const start = { id: unique(`key_${clip.id}_start`), time: clip.startTime, value: clone(clip.initialValue),
        ...(clip.relative ? { relative: true } : {}), easeType: clip.easeType, interpolation: 'tween' }
      if (last && Math.abs(last.time - start.time) <= epsilon) {
        const incoming = clone(last.value), incomingRelative = last.relative === true
        if (clip.relative) {
          last.value = last.value == null || clip.initialValue == null ? clone(clip.initialValue) : last.value + clip.initialValue
          last.relative = true
        } else { last.value = clone(clip.initialValue); delete last.relative }
        last.leftValue = incoming
        if (incomingRelative) last.leftRelative = true
        else delete last.leftRelative
        last.easeType = clip.easeType; last.interpolation = 'tween'
      } else track.keyframes.push(start)
      const endValue = clip.relative && clip.initialValue != null && clip.endValue != null
        ? clip.endValue - clip.initialValue : clone(clip.endValue)
      if (typeof endValue === 'number' && !Number.isFinite(endValue)) throw new Error('旧动画 Clip 数值溢出')
      track.keyframes.push({ id: unique(`key_${clip.id}_end`), time: clip.startTime + clip.duration,
        value: endValue, ...(clip.relative ? { relative: true } : {}), easeType: 'Linear', interpolation: 'step' })
    }
    return track
  })
}
