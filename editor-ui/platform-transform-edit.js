import { TWEENABLE_FIELDS } from '../studio/look2/sampling.js'
import { findNode } from '../studio/ui/authoring.js'
import { setAbsoluteKeyframeValue, setTransformTrackValue, transformTrackValue, TRANSFORM_TRACK_PATHS } from './field-groups.js'

const clone = value => JSON.parse(JSON.stringify(value))

export function preparePlatformTransformEdit(snapshot, { id, platform, section, axis, value, playhead = 0, makeId }) {
  const node = findNode(snapshot?.root, id)
  const sourceTransform = node?.transformByPlatform?.[platform]
  if (!sourceTransform || !sourceTransform[section] || !Object.hasOwn(sourceTransform[section], axis)) {
    throw new Error('当前平台变换字段不可用')
  }
  const nextValue = Number(value)
  if (!Number.isFinite(nextValue)) throw new Error('变换值必须是有限数字')

  const nextTransform = clone(sourceTransform)
  nextTransform[section][axis] = nextValue
  const ops = []
  let nextState = null
  const animation = snapshot.asset?.type === 'client-control-template' && snapshot.canvas?.platform === platform
    ? snapshot.look2?.animations?.find(item => item.id === snapshot.look2.activeAnimationId) || snapshot.look2?.animations?.[0]
    : null
  const changedChannels = {}
  for (const fieldKey of Object.keys(TRANSFORM_TRACK_PATHS)) {
    const before = transformTrackValue(sourceTransform, fieldKey)
    const after = transformTrackValue(nextTransform, fieldKey)
    if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) > 1e-9) changedChannels[fieldKey] = after
  }

  let recordTime = 0
  if (animation) {
    const frameRate = Math.max(1, Number(snapshot.look2.frameRate) || 30)
    const rawTime = Math.max(0, Math.min(Number(animation.duration) || 5, Number(playhead) || 0))
    recordTime = Number((snapshot.look2.timelineSnapEnabled ? Math.round(rawTime * frameRate) / frameRate : rawTime).toFixed(4))
  }
  const baseTransform = clone(nextTransform)
  for (const [fieldKey, channelValue] of Object.entries(changedChannels)) {
    const definition = TWEENABLE_FIELDS.find(field => field.fieldKey === fieldKey && field.kinds.includes(snapshot.inspector?.kind))
    const track = definition && animation?.keyframeTracks?.find(item => item.nodeId === id && item.fieldKey === fieldKey)
    if (!track) continue

    nextState ||= clone(snapshot.look2)
    const targetAnimation = nextState.animations.find(item => item.id === animation.id)
    const targetTrack = targetAnimation?.keyframeTracks?.find(item => item.id === track.id)
    if (!targetTrack) continue
    targetTrack.keyframes ||= []
    let keyframe = targetTrack.keyframes.find(item => Math.abs(Number(item.time) - recordTime) < .0001)
    if (!keyframe) {
      if (typeof makeId !== 'function') throw new Error('缺少关键帧 ID 生成器')
      keyframe = { id: makeId(), time: recordTime, value: clone(channelValue), easeType: 'Linear', interpolation: 'tween' }
      targetTrack.keyframes.push(keyframe)
      targetTrack.keyframes.sort((left, right) => left.time - right.time)
    }
    setAbsoluteKeyframeValue(keyframe, channelValue)
    setTransformTrackValue(baseTransform, fieldKey, transformTrackValue(sourceTransform, fieldKey))
  }

  if (JSON.stringify(baseTransform) !== JSON.stringify(sourceTransform)) {
    ops.push({ op: 'setPlatformTransform', id, platform, transform: baseTransform })
  }
  return { ops, state: nextState || undefined, skip: !ops.length && !nextState }
}
