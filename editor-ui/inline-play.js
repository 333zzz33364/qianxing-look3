import { PixiPlayRenderer } from '../studio/play/pixi-renderer.js'
import { createPlaySession } from '../studio/play/browser-session.js'

// The editor owns authoring state; this surface owns only a disposable runtime.
export function createInlinePlay(React, { api }) {
  const h = React.createElement
  const transitions = new Map()
  return function InlinePlay({ sessionId, startOptions, onSnapshot, onError, onStopped, onReady }) {
    const rootRef = React.useRef(null)
    const canvasRef = React.useRef(null)
    const surfaceRef = React.useRef(null)
    const viewportRef = React.useRef(null)
    const playRef = React.useRef(null)
    const callbacks = React.useRef({})
    callbacks.current = { onSnapshot, onError, onStopped, onReady }
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(true)
    const [error, setError] = React.useState('')
    const [fullscreen, setFullscreen] = React.useState(false)
    const [size, setSize] = React.useState({ width: '100%', height: '100%' })
    const optionsRef = React.useRef(startOptions)
    React.useEffect(() => {
      const root = rootRef.current
      const document = root.ownerDocument
      const updateFullscreen = () => {
        setFullscreen(document.fullscreenElement === root)
        if (!document.fullscreenElement || document.fullscreenElement === root) surfaceRef.current?.focus({ preventScroll: true })
      }
      document.addEventListener('fullscreenchange', updateFullscreen)
      return () => {
        document.removeEventListener('fullscreenchange', updateFullscreen)
        if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {})
      }
    }, [])
    React.useEffect(() => {
      let alive = true
      let stopping = false
      let disposed = false
      const renderer = new PixiPlayRenderer(canvasRef.current)
      const call = (action, args = {}) => api(sessionId, 'play', { action, args })
      const report = cause => {
        if (!alive) return
        setError(cause.message || String(cause))
        callbacks.current.onError?.(cause)
      }
      const update = next => {
        if (!alive) return
        setStatus(next)
        callbacks.current.onSnapshot?.(next)
      }
      const play = createPlaySession({ renderer, api: call, onSnapshot: update,
        onStatus: next => { if (alive) setStatus(current => ({ ...current, ...next })) },
        onError: report, isActive: () => alive && !stopping })
      // Serialize transitions, including cleanup after a start still in flight.
      const transition = task => {
        const operation = (transitions.get(sessionId) || Promise.resolve()).catch(() => {}).then(task)
        transitions.set(sessionId, operation)
        void operation.finally(() => { if (transitions.get(sessionId) === operation) transitions.delete(sessionId) }).catch(() => {})
        return operation
      }
      const controller = {
        get snapshot() { return play.snapshot },
        act: (action, args) => play.act(action, args),
        inspect: () => call('get', { inspect: true, compact: true }),
        restart: () => transition(async () => {
          if (!alive) return
          setBusy(true)
          try { await play.stop(); if (alive) await play.start(optionsRef.current) }
          catch (cause) { report(cause) }
          finally { if (alive) setBusy(false) }
        }),
        view: playerIndex => transition(() => alive ? play.view({ playerIndex }) : null),
        stop: () => {
          stopping = true
          play.reset()
          setBusy(true)
          return transition(async () => {
            if (!alive) return
            try { await play.stop(); callbacks.current.onStopped?.() }
            catch (cause) { stopping = false; report(cause); if (alive) setBusy(false) }
          })
        },
      }
      playRef.current = controller
      callbacks.current.onReady?.(controller)
      void transition(async () => {
        try {
          await renderer.ready
          if (!alive || stopping) return
          await play.start(optionsRef.current)
          if (alive && !stopping) { play.bindInput(surfaceRef.current); surfaceRef.current.focus() }
        } catch (cause) {
          report(cause)
          await call('stop').catch(() => {})
          if (alive) callbacks.current.onStopped?.()
        } finally { if (alive) setBusy(false) }
      })
      return () => {
        alive = false
        playRef.current = null
        play.reset()
        // A renderer cannot be destroyed while its initialization/apply is pending.
        void transition(async () => {
          await call('stop').catch(() => {})
          await renderer.ready.catch(() => {})
          if (!disposed) { disposed = true; play.destroy() }
        })
      }
    }, [sessionId])
    React.useEffect(() => {
      const fit = () => {
        const viewport = viewportRef.current
        if (!viewport) return
        const width = status?.canvasWidth || 1600, height = status?.canvasHeight || 900
        const ratio = Math.min(viewport.clientWidth / width, viewport.clientHeight / height)
        setSize({ width: Math.max(1, width * ratio), height: Math.max(1, height * ratio) })
      }
      fit()
      const observer = new ResizeObserver(fit)
      if (viewportRef.current) observer.observe(viewportRef.current)
      return () => observer.disconnect()
    }, [status?.canvasWidth, status?.canvasHeight])
    const run = async task => {
      setBusy(true)
      try { await task() } catch (cause) { setError(cause.message); callbacks.current.onError?.(cause) }
      finally { setBusy(false) }
    }
    const toggleFullscreen = async () => {
      const root = rootRef.current
      try {
        if (root.ownerDocument.fullscreenElement === root) await root.ownerDocument.exitFullscreen()
        else if (root.requestFullscreen) await root.requestFullscreen()
        else throw new Error('当前浏览器不支持全屏，请在桌面浏览器中打开试玩')
      } catch (cause) {
        setError(`无法切换全屏：${cause.message || String(cause)}`)
      }
    }
    return h('div', { ref: rootRef, className: 'look2-inline-play',
      onKeyDownCapture: event => {
        if (event.key === 'Escape' && rootRef.current?.ownerDocument.fullscreenElement === rootRef.current) {
          event.preventDefault()
          event.stopPropagation()
          void toggleFullscreen()
        }
      },
      style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: '#1d2128', color: '#e1e7ef' } },
      h('div', { className: 'look2-play-controls', style: { display: 'flex', flexWrap: 'wrap', gap: 4, flex: '0 0 auto', padding: 4 } },
        h('button', { disabled: busy, onClick: () => void run(() => playRef.current.act(status?.paused ? 'resume' : 'pause')) }, status?.paused ? '继续' : '暂停'),
        h('button', { disabled: busy || !status?.paused, onClick: () => void run(() => playRef.current.act('step', { dt: 1 / 30 })) }, '单步'),
        h('button', { disabled: busy, onClick: () => void playRef.current.restart() }, '重启'),
        h('button', { onClick: () => void playRef.current?.stop() }, '停止'),
        h('button', { type: 'button', 'aria-pressed': fullscreen, title: fullscreen ? '退出全屏（Esc）' : '全屏试玩（Esc 返回编辑器）', onClick: () => void toggleFullscreen() }, fullscreen ? '退出全屏' : '全屏'),
        h('select', { 'aria-label': '试玩玩家', disabled: busy, value: status?.viewPlayerIndex || 1,
          onChange: event => { const index = Number(event.target.value); void run(() => playRef.current.view(index)) } },
        (status?.players || [{ index: 1, label: '玩家1' }]).map(player => h('option', { key: player.index, value: player.index }, player.label))),
        h('span', { role: 'status' }, busy ? '启动／切换中…' : `${Number(status?.time || 0).toFixed(2)}s · ${status?.frame || 0}f`)),
      error ? h('div', { role: 'alert' }, error) : null,
      h('div', { ref: viewportRef, style: { display: 'grid', placeItems: 'center', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' } },
        h('div', { ref: surfaceRef, tabIndex: 0, 'aria-label': 'Look 试玩画布', style: { ...size, position: 'relative', outline: 'none', touchAction: 'none' } },
          h('canvas', { ref: canvasRef, style: { display: 'block', width: '100%', height: '100%' } }))))
  }
}
