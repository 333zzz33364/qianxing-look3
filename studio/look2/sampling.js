// Shared animation field and keyframe rules for the editor, preview and Lua
// export. `relative` follows TweenTimeline@8: it is added to the preceding
// key's resolved right-hand value. `isDelta` remains readable for old states.

const TRANSFORM_FIELDS = [
  ['anchoredPositionX', '水平位置 X', true], ['anchoredPositionY', '水平位置 Y', true],
  ['sizeDeltaX', '宽度', true], ['sizeDeltaY', '高度', true],
  ['localScaleX', '缩放 X', true], ['localScaleY', '缩放 Y', true], ['localScaleZ', '缩放 Z', true],
  ['localRotationX', '旋转 X', false], ['localRotationY', '旋转 Y', false], ['localRotationZ', '旋转 Z', false],
  ['anchorMinX', '最小锚点 X', false], ['anchorMinY', '最小锚点 Y', false],
  ['anchorMaxX', '最大锚点 X', false], ['anchorMaxY', '最大锚点 Y', false],
  ['pivotX', '轴心 X', false], ['pivotY', '轴心 Y', false],
]

const COMMON_KINDS = ['container', 'image', 'textbox', 'textwindow', 'button', 'cursor', 'grid', 'keyhint', 'animation', 'fullscreen', 'reference']
const TEXT_KINDS = ['textbox', 'textwindow']
const COLOR_KINDS = TEXT_KINDS

export const TWEENABLE_FIELDS = Object.freeze([
  ...TRANSFORM_FIELDS.map(([fieldKey, label, relative]) => Object.freeze({ fieldKey, label, type: 'number', kinds: COMMON_KINDS, relative })),
  Object.freeze({ fieldKey: 'visible', label: '控件显隐', type: 'boolean', kinds: COMMON_KINDS, relative: false }),
  Object.freeze({ fieldKey: 'groupAlpha', label: '组合透明度', type: 'groupAlpha', kinds: COMMON_KINDS, relative: false }),
  Object.freeze({ fieldKey: 'fontSize', label: '文字大小', type: 'number', kinds: TEXT_KINDS, relative: false }),
  Object.freeze({ fieldKey: 'fontColor', label: '文字颜色', type: 'color', kinds: TEXT_KINDS, relative: false }),
  Object.freeze({ fieldKey: 'bgColor', label: '文字背景色', type: 'color', kinds: TEXT_KINDS, relative: false }),
  Object.freeze({ fieldKey: 'outlineColor', label: '描边颜色', type: 'color', kinds: TEXT_KINDS, relative: false }),
  Object.freeze({ fieldKey: 'fillAmount', label: '图片填充量', type: 'number', kinds: ['image'], relative: false }),
  Object.freeze({ fieldKey: 'imageColor', label: '图片颜色', type: 'color', kinds: ['image'], relative: false }),
])

export const TWEENABLE_FIELDS_BY_KIND = Object.freeze(Object.fromEntries(COMMON_KINDS.map(kind => [
  kind, TWEENABLE_FIELDS.filter(field => field.kinds.includes(kind)),
])))

export const RELATIVE_FIELDS = new Set(TRANSFORM_FIELDS.filter(([, , relative]) => relative).map(([fieldKey]) => fieldKey))
export const COLOR_FIELDS = new Set(['imageColor', 'fontColor', 'bgColor', 'outlineColor'])

// This list mirrors Runtime Enum.EaseType. The three Ease* names remain aliases
// for states created before the reference editor used the full enum.
export const EASE_TYPES = Object.freeze([
  'Linear', 'InSine', 'OutSine', 'InOutSine',
  'InQuad', 'OutQuad', 'InOutQuad',
  'InCubic', 'OutCubic', 'InOutCubic',
  'InQuart', 'OutQuart', 'InOutQuart',
  'InQuint', 'OutQuint', 'InOutQuint',
  'InExpo', 'OutExpo', 'InOutExpo',
  'InCirc', 'OutCirc', 'InOutCirc',
  'InBack', 'OutBack', 'InOutBack',
  'InElastic', 'OutElastic', 'InOutElastic',
  'InBounce', 'OutBounce', 'InOutBounce',
  'EaseIn', 'EaseOut', 'EaseInOut',
])

function bounceOut(t) {
  const n1 = 7.5625, d1 = 2.75
  if (t < 1 / d1) return n1 * t * t
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + .75 }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + .9375 }
  t -= 2.625 / d1
  return n1 * t * t + .984375
}

const easeFns = {
  Linear: t => t,
  InSine: t => 1 - Math.cos(t * Math.PI / 2), OutSine: t => Math.sin(t * Math.PI / 2), InOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  InQuad: t => t * t, OutQuad: t => 1 - (1 - t) ** 2, InOutQuad: t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,
  InCubic: t => t ** 3, OutCubic: t => 1 - (1 - t) ** 3, InOutCubic: t => t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
  InQuart: t => t ** 4, OutQuart: t => 1 - (1 - t) ** 4, InOutQuart: t => t < .5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2,
  InQuint: t => t ** 5, OutQuint: t => 1 - (1 - t) ** 5, InOutQuint: t => t < .5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2,
  InExpo: t => t === 0 ? 0 : 2 ** (10 * t - 10), OutExpo: t => t === 1 ? 1 : 1 - 2 ** (-10 * t),
  InOutExpo: t => t === 0 || t === 1 ? t : t < .5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  InCirc: t => 1 - Math.sqrt(1 - t ** 2), OutCirc: t => Math.sqrt(1 - (t - 1) ** 2),
  InOutCirc: t => t < .5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2,
  InBack: t => { const c = 1.70158; return (c + 1) * t ** 3 - c * t ** 2 },
  OutBack: t => { const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2 },
  InOutBack: t => { const c = 1.70158 * 1.525; return t < .5 ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2 : ((2 * t - 2) ** 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2 },
  InElastic: t => t === 0 || t === 1 ? t : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * 2 * Math.PI / 3),
  OutElastic: t => t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - .75) * 2 * Math.PI / 3) + 1,
  InOutElastic: t => { if (t === 0 || t === 1) return t; const c = 2 * Math.PI / 4.5; return t < .5 ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * c)) / 2 : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * c)) / 2 + 1 },
  InBounce: t => 1 - bounceOut(1 - t), OutBounce: bounceOut, InOutBounce: t => t < .5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2,
}
easeFns.EaseIn = easeFns.InQuad
easeFns.EaseOut = easeFns.OutQuad
easeFns.EaseInOut = easeFns.InOutQuad

export function easeProgress(name, progress) {
  const t = Math.max(0, Math.min(1, Number(progress) || 0))
  if (t === 0 || t === 1) return t
  return (easeFns[name] || easeFns.Linear)(t)
}

function sortedKeys(track) {
  return (track.keyframes || []).map((key, index) => ({ key, index }))
    .sort((a, b) => Number(a.key.time) - Number(b.key.time) || a.index - b.index)
    .map(row => row.key)
}

function componentwise(left, right, operation) {
  if (typeof right === 'number' && typeof left === 'number') return operation(left, right)
  if (Array.isArray(right) && Array.isArray(left)) return right.map((value, index) => operation(Number(left[index] ?? 0), Number(value)))
  if (right && left && typeof right === 'object' && typeof left === 'object') {
    const output = { ...left }
    for (const [key, value] of Object.entries(right)) if (Number.isFinite(Number(value)) && Number.isFinite(Number(left[key]))) output[key] = operation(Number(left[key]), Number(value))
    return output
  }
  return right
}

function addRelative(previous, value) {
  return componentwise(previous, value, (left, right) => left + right)
}

function legacyBaseValue(base, value) {
  return typeof value === 'number' && typeof base === 'number' ? base + value : value
}

function resolvedRight(key, previous, base, first) {
  if (key.relative === true) return addRelative(previous, key.value)
  // Old look2 states used isDelta against the playback-start base. normalizeLook2
  // migrates this marker when a site node baseline is available.
  if (key.isDelta === true) return legacyBaseValue(base, key.value)
  if (key._legacyBaseDelta === true) return legacyBaseValue(base, key.value)
  return key.value
}

function resolvedIncoming(key, previous, base) {
  if (key.leftValue === undefined) return resolvedRight(key, previous, base, false)
  if (key.leftRelative === true || key.leftDelta === true && key._leftUsesPrevious === true) return addRelative(previous, key.leftValue)
  if (key.leftDelta === true || key._legacyBaseLeftDelta === true) return legacyBaseValue(base, key.leftValue)
  return key.leftValue
}

function interpolate(from, to, amount) {
  if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * amount
  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) return from.map((value, index) => interpolate(Number(value), Number(to[index]), amount))
  if (from && to && typeof from === 'object' && typeof to === 'object' && !Array.isArray(from) && !Array.isArray(to)) {
    const result = { ...from }
    for (const [key, value] of Object.entries(to)) if (Number.isFinite(Number(value)) && Number.isFinite(Number(from[key]))) result[key] = interpolate(Number(from[key]), Number(value), amount)
    return result
  }
  return from
}

export function sampleTrack(track, time, base = 0) {
  const keys = sortedKeys(track)
  if (!keys.length) return null
  const first = keys[0]
  let previous = base
  const rightValues = [], incomingValues = []
  for (const key of keys) {
    const right = resolvedRight(key, previous, base, rightValues.length === 0)
    rightValues.push(right)
    incomingValues.push(resolvedIncoming(key, previous, base))
    previous = right
  }
  const currentTime = Number(time) || 0
  if (currentTime < Number(first.time)) return track.fieldKey === 'visible' ? base : rightValues[0]
  let index = 0
  while (index + 1 < keys.length && Number(keys[index + 1].time) <= currentTime) index += 1
  const from = rightValues[index], next = keys[index + 1]
  if (!next || keys[index].interpolation === 'step') return from
  const to = incomingValues[index + 1]
  if (typeof from !== 'number' && !Array.isArray(from) && !(from && typeof from === 'object')) return from
  if (typeof to !== 'number' && !Array.isArray(to) && !(to && typeof to === 'object')) return from
  const span = Number(next.time) - Number(keys[index].time)
  if (span <= 0) return from
  const u = easeProgress(keys[index].easeType || 'Linear', (currentTime - Number(keys[index].time)) / span)
  return interpolate(from, to, u)
}
