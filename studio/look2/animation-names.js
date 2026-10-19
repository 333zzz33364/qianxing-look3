export function validateAnimationName(animations, targetId, value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error('动画名称不能为空')
  if (name.length > 80) throw new Error('动画名称不能超过 80 个字符')
  if (/[\x00-\x1f]/.test(name)) throw new Error('动画名称不能包含控制字符')
  if ((animations || []).some(animation => animation.id !== targetId && animation.name === name)) {
    throw new Error(`动画名称重复：${name}`)
  }
  return name
}

export function uniqueAnimationName(animations, base) {
  const names = new Set((animations || []).map(animation => animation.name))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base} ${index}`)) index++
  return `${base} ${index}`
}

export function newAnimationName(animations) {
  return uniqueAnimationName(animations, '新动画')
}

export function copiedAnimationName(animations, sourceName) {
  return uniqueAnimationName(animations, `${String(sourceName || '').slice(0, 70)} 副本`)
}
