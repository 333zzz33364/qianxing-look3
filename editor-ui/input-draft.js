export function createInputDraft(initialValue, { onDiscardError } = {}) {
  let sourceValue = initialValue
  let value = initialValue
  let generation = 0
  let dirty = false
  let discardedBefore = 0
  const failedErrors = new Set()

  return {
    get value() { return value },
    get dirty() { return dirty },
    edit(nextValue) {
      generation++
      dirty = true
      value = nextValue
      return value
    },
    sync(nextSourceValue) {
      sourceValue = nextSourceValue
      if (dirty) return { changed: false, value }
      value = sourceValue
      return { changed: true, value }
    },
    capture(submittedValue = value) {
      return { generation, value: submittedValue }
    },
    isCurrent(attempt) {
      return attempt?.generation === generation
    },
    fail(attempt, error) {
      if (attempt.generation < discardedBefore) onDiscardError?.(error)
      else failedErrors.add(error)
    },
    complete(attempt, committedValue = attempt?.value) {
      if (!this.isCurrent(attempt)) return { changed: false, value }
      sourceValue = committedValue
      value = committedValue
      dirty = false
      failedErrors.clear()
      return { changed: true, value }
    },
    reset(nextSourceValue = sourceValue) {
      generation++
      discardedBefore = generation
      for (const error of failedErrors) onDiscardError?.(error)
      failedErrors.clear()
      sourceValue = nextSourceValue
      value = nextSourceValue
      dirty = false
      return value
    },
  }
}

export async function commitInputDraft(draft, save, submittedValue = draft.value) {
  const attempt = draft.capture(submittedValue)
  try {
    const committedValue = await save(attempt.value)
    const completion = draft.complete(attempt, committedValue === undefined ? attempt.value : committedValue)
    return { ok: true, ...completion }
  } catch (error) {
    draft.fail(attempt, error)
    return { ok: false, current: draft.isCurrent(attempt) && draft.dirty, error, value: draft.value }
  }
}
