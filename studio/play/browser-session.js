export const PLAY_POLL_INTERVAL_MS = 33
export const PLAY_MOVE_THROTTLE_MS = 60

const MOVEMENT_KEY_EVENTS = Object.freeze({
  KeyW: 'KeyboardMoveForwardKey',
  KeyS: 'KeyboardMoveBackwardKey',
  KeyA: 'KeyboardMoveLeftKey',
  KeyD: 'KeyboardMoveRightKey',
})

export function keyEventName(event, phase) {
  const digit = event.code && String(event.code).startsWith('Digit') ? String(event.code).slice(5) : ''
  if (digit && Number(digit) >= 1 && Number(digit) <= 9) return `KeyboardCraftspersonKey${digit}${phase}`
  const movement = MOVEMENT_KEY_EVENTS[event.code]
  if (movement) return `${movement}${phase}`
  return ''
}

export function stagePoint(event, rect, width, height) {
  return {
    x: (event.clientX - rect.left) * width / rect.width,
    y: (rect.bottom - event.clientY) * height / rect.height,
  }
}

/**
 * Shared browser play loop used by the DSH standalone page and local Web preview.
 * Worker semantics stay in studio/host/worker.js; this only observes compact
 * scene snapshots and sends light-weight input.
 */
export function createPlaySession({ renderer, api, onSnapshot, onStatus, onError, isActive } = {}) {
  let snapshot = null
  let running = false
  let polling = false
  let timer = null
  let pollSoonTimer = null
  let sceneRev = 0
  let moveTimer = null
  let lastMove = null
  let generation = 0
  let destroyed = false
  const inputDisposers = new Set()
  const inputResetters = new Set()

  function clearPendingMove() {
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = null
    lastMove = null
  }

  function emitError(error) {
    if (onError) onError(error)
  }

  async function applyScene(next, token = generation) {
    if (destroyed || token !== generation) return
    snapshot = next
    running = next?.running !== false
    if (next?.scene && next.scene.format === 'tree-v1') {
      if (next.scene.reset) sceneRev = 0
      await renderer.applyScene(next.scene, next.canvasWidth, next.canvasHeight)
      sceneRev = next.scene.revision || sceneRev
    } else if (Array.isArray(next?.paint)) {
      await renderer.render(next.paint, next.canvasWidth, next.canvasHeight)
    }
    if (destroyed || token !== generation) return
    if (!destroyed && token === generation && onSnapshot) await onSnapshot(next)
  }

  async function poll() {
    if (!running || polling) return
    if (isActive && !isActive()) return
    polling = true
    const token = generation
    try {
      await applyScene(await api('get', { view: true, sceneRev, compact: true }), token)
    } catch (error) {
      if (destroyed || token !== generation) return
      running = false
      stopPolling()
      emitError(error)
    } finally {
      polling = false
    }
  }

  function startPolling() {
    if (destroyed || timer) return
    timer = setInterval(() => { void poll() }, PLAY_POLL_INTERVAL_MS)
  }

  function stopPolling() {
    if (timer) clearInterval(timer)
    timer = null
    if (pollSoonTimer) clearTimeout(pollSoonTimer)
    pollSoonTimer = null
  }

  function pollSoon(delay = 30) {
    if (pollSoonTimer) return
    pollSoonTimer = setTimeout(() => {
      pollSoonTimer = null
      void poll()
    }, delay)
  }

  function reset() {
    generation += 1
    running = false
    snapshot = null
    sceneRev = 0
    clearPendingMove()
    for (const resetInput of inputResetters) resetInput()
    stopPolling()
  }

  async function act(action, args) {
    if (destroyed || (isActive && !isActive())) return null
    const token = generation
    try {
      const value = await api(action, { light: true, ...(args || {}) })
      if (destroyed || token !== generation) return null
      if (value && typeof value === 'object' && value.frame !== undefined && onStatus) onStatus(value)
      pollSoon(30)
      return value
    } catch (error) {
      if (!destroyed && token === generation) emitError(error)
      return null
    }
  }

  async function start(args = {}) {
    if (destroyed) throw new Error('play surface has been destroyed')
    reset()
    const token = generation
    sceneRev = 0
    const next = await api('start', { view: true, compact: true, ...args })
    if (destroyed || token !== generation) return next
    await applyScene({ ...next, running: true }, token)
    if (destroyed || token !== generation) return next
    running = true
    stopPolling()
    startPolling()
    return next
  }

  async function attach() {
    if (destroyed) throw new Error('play surface has been destroyed')
    // Reconnect a reloaded browser to the existing worker without restarting
    // the game, changing its player, or resuming a paused session.
    reset()
    const token = generation
    const next = await api('get', { view: true, compact: true, sceneRev: 0 })
    await applyScene(next, token)
    if (running) startPolling()
    return next
  }

  async function device(args = {}) {
    if (destroyed) throw new Error('play surface has been destroyed')
    reset()
    const token = generation
    const next = await api('device', { view: true, compact: true, ...args })
    await applyScene({ ...next, running: true }, token)
    if (destroyed || token !== generation) return next
    running = true
    startPolling()
    return next
  }

  async function view(args = {}) {
    const token = generation
    sceneRev = 0
    const next = await api('view', { view: true, compact: true, ...args })
    await applyScene({ ...next, running: true }, token)
    return next
  }

  async function stop() {
    reset()
    return api('stop')
  }

  function point(event, el) {
    return stagePoint(event, el.getBoundingClientRect(), snapshot.canvasWidth, snapshot.canvasHeight)
  }

  function bindInput(surface, { keysOn } = {}) {
    const keyTarget = keysOn || surface
    const heldKeys = new Set()
    const onPointerDown = (event) => {
      if (!snapshot || !running || (isActive && !isActive())) return
      surface.focus?.({ preventScroll: true })
      surface.setPointerCapture?.(event.pointerId)
      void act('pointer', { type: 'down', ...point(event, surface) })
    }
    const onPointerUp = (event) => {
      if (!snapshot || !running || (isActive && !isActive())) return
      void act('pointer', { type: 'up', ...point(event, surface) })
    }
    const onPointerMove = (event) => {
      if (!snapshot || !running || (isActive && !isActive())) return
      lastMove = point(event, surface)
      if (moveTimer) return
      moveTimer = setTimeout(() => {
        moveTimer = null
        if (lastMove) void act('pointer', { type: 'move', ...lastMove })
      }, PLAY_MOVE_THROTTLE_MS)
    }
    const onPointerLeave = () => {
      // A queued in-bounds move must not arrive after the pointer has left.
      clearPendingMove()
      if (snapshot && running && (!isActive || isActive())) void act('pointer', { type: 'move', x: -1, y: -1 })
    }
    const onKeyDown = (event) => {
      if (!snapshot || !running || (isActive && !isActive())) return
      const name = keyEventName(event, 'Down')
      if (name) {
        if (heldKeys.has(event.code)) return
        heldKeys.add(event.code)
        event.preventDefault()
        void act('key', { key: name })
      }
    }
    const onKeyUp = (event) => {
      if (!snapshot || !running || (isActive && !isActive())) return
      const name = keyEventName(event, 'Up')
      if (name) {
        heldKeys.delete(event.code)
        event.preventDefault()
        void act('key', { key: name })
      }
    }
    const releaseKeys = () => {
      for (const code of heldKeys) void act('key', { key: keyEventName({ code }, 'Up') })
      heldKeys.clear()
    }
    const onPointerCancel = event => {
      clearPendingMove()
      if (snapshot && running) void act('pointer', { type: 'up', ...point(event, surface) })
    }
    surface.addEventListener('pointerdown', onPointerDown)
    surface.addEventListener('pointerup', onPointerUp)
    surface.addEventListener('pointermove', onPointerMove)
    surface.addEventListener('pointerleave', onPointerLeave)
    surface.addEventListener('pointercancel', onPointerCancel)
    keyTarget.addEventListener('blur', releaseKeys)
    keyTarget.addEventListener('keydown', onKeyDown)
    keyTarget.addEventListener('keyup', onKeyUp)
    const resetInput = () => heldKeys.clear()
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      surface.removeEventListener('pointerdown', onPointerDown)
      surface.removeEventListener('pointerup', onPointerUp)
      surface.removeEventListener('pointermove', onPointerMove)
      surface.removeEventListener('pointerleave', onPointerLeave)
      surface.removeEventListener('pointercancel', onPointerCancel)
      keyTarget.removeEventListener('blur', releaseKeys)
      keyTarget.removeEventListener('keydown', onKeyDown)
      keyTarget.removeEventListener('keyup', onKeyUp)
      clearPendingMove()
      resetInput()
      inputResetters.delete(resetInput)
      inputDisposers.delete(dispose)
    }
    inputResetters.add(resetInput)
    inputDisposers.add(dispose)
    return dispose
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    reset()
    for (const dispose of [...inputDisposers]) dispose()
    renderer?.destroy?.()
  }

  return {
    get snapshot() { return snapshot },
    get running() { return running },
    get sceneRev() { return sceneRev },
    applyScene,
    poll,
    pollSoon,
    startPolling,
    stopPolling,
    reset,
    act,
    start,
    attach,
    device,
    view,
    stop,
    bindInput,
    destroy,
  }
}
