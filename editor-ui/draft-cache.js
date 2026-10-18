// Serialize browser writes so a late export cannot resurrect a cleared draft.
export function createDraftCache({ sessionId, request, onError = () => {}, delay = 700 }) {
  let generation = 0
  let pending = null
  let writes = Promise.resolve()
  let disposed = false

  function invalidate() {
    generation++
    if (pending) {
      clearTimeout(pending.timer)
      pending.resolve(false)
      pending = null
    }
  }
  function enqueue(operation) {
    const result = writes.then(operation)
    writes = result.catch(() => {})
    return result
  }
  function schedule(exportArchive, waitForQueue = () => Promise.resolve()) {
    if (disposed) return Promise.resolve(false)
    invalidate()
    const revision = generation
    return new Promise(resolve => {
      const task = { resolve, timer: null }
      pending = task
      task.timer = setTimeout(async () => {
        if (pending === task) pending = null
        const current = () => !disposed && revision === generation
        try {
          await waitForQueue()
          if (!current()) { resolve(false); return }
          const exported = await exportArchive()
          if (!current()) { resolve(false); return }
          await enqueue(() => current() ? request('put', sessionId, {
            format: 'archive', data: exported.data, at: Date.now(),
          }) : undefined)
          resolve(current())
        } catch (reason) {
          if (current()) {
            try { onError(reason) } catch {}
          }
          resolve(false)
        }
      }, delay)
    })
  }
  function clear() {
    invalidate()
    return enqueue(() => request('delete', sessionId))
  }
  function dispose() {
    disposed = true
    invalidate()
  }
  return { schedule, clear, dispose }
}
