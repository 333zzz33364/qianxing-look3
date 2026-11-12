// 缓动枚举（Runtime Enum.EaseType）的中文名。下拉框显示中文，存档与运行时仍写枚举原值。
export const EASE_TYPE_LABELS = Object.freeze({
  Linear: '线性',
  InSine: '正弦渐入', OutSine: '正弦渐出', InOutSine: '正弦缓入缓出',
  InQuad: '二次渐入', OutQuad: '二次渐出', InOutQuad: '二次缓入缓出',
  InCubic: '三次渐入', OutCubic: '三次渐出', InOutCubic: '三次缓入缓出',
  InQuart: '四次渐入', OutQuart: '四次渐出', InOutQuart: '四次缓入缓出',
  InQuint: '五次渐入', OutQuint: '五次渐出', InOutQuint: '五次缓入缓出',
  InExpo: '指数渐入', OutExpo: '指数渐出', InOutExpo: '指数缓入缓出',
  InCirc: '圆形渐入', OutCirc: '圆形渐出', InOutCirc: '圆形缓入缓出',
  InBack: '回弹渐入', OutBack: '回弹渐出', InOutBack: '回弹缓入缓出',
  InElastic: '弹性渐入', OutElastic: '弹性渐出', InOutElastic: '弹性缓入缓出',
  InBounce: '弹跳渐入', OutBounce: '弹跳渐出', InOutBounce: '弹跳缓入缓出',
  EaseIn: '缓入（旧名）', EaseOut: '缓出（旧名）', EaseInOut: '缓入缓出（旧名）',
})

export function easeTypeLabel(ease) {
  return EASE_TYPE_LABELS[ease] || String(ease || '')
}
