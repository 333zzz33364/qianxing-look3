// 界面动效预览：官方 UIVfx 视频把 C（emission）与 T（transmission）两路并排打包。
// 播放时按 result = C + background * T 合成：T 用 multiply、C 用 plus-lighter 叠加。
// 两路都画进调用方给的 canvas，帧同步用 requestVideoFrameCallback，没有时退回 rAF。
export function attachUIVfxRenderer(video, transmission, emission, options = {}) {
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {}
  const onError = typeof options.onError === 'function' ? options.onError : () => {}
  const t = transmission.getContext('2d', { alpha: false })
  const c = emission.getContext('2d', { alpha: false })
  if (!t || !c) throw new Error('当前环境不支持 Canvas 2D，无法预览界面动效')

  let frame = 0
  let videoFrame = 0
  let destroyed = false
  let lastTime = -1
  const listeners = []

  function cancel() {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (videoFrame && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrame)
    videoFrame = 0
  }

  function draw() {
    if (destroyed || video.readyState < 2) return
    if (!video.videoWidth || video.videoWidth % 2 || !video.videoHeight) throw new Error('动效视频不是可拆分的 C/T 双通道尺寸')
    if (lastTime === video.currentTime) return
    const width = video.videoWidth / 2
    const height = video.videoHeight
    for (const canvas of [transmission, emission]) {
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
    }
    t.drawImage(video, width, 0, width, height, 0, 0, width, height)
    c.drawImage(video, 0, 0, width, height, 0, 0, width, height)
    lastTime = video.currentTime
    onFrame()
  }

  function tick() {
    cancel()
    if (destroyed) return
    try {
      draw()
    } catch {
      onError()
      return
    }
    if (video.paused || video.ended) return
    if (video.requestVideoFrameCallback) videoFrame = video.requestVideoFrameCallback(tick)
    else frame = requestAnimationFrame(tick)
  }

  for (const name of ['loadeddata', 'play', 'seeked', 'pause', 'ended']) {
    video.addEventListener(name, tick)
    listeners.push(() => video.removeEventListener(name, tick))
  }

  function reset() {
    cancel()
    lastTime = -1
  }
  video.addEventListener('emptied', reset)
  listeners.push(() => video.removeEventListener('emptied', reset))

  return {
    draw: tick,
    destroy() {
      destroyed = true
      cancel()
      for (const remove of listeners) remove()
      listeners.length = 0
    },
  }
}
