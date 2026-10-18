import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraftCache } from '../../editor-ui/draft-cache.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('clearing a draft invalidates an export already in flight', async () => {
  const started = deferred(), exported = deferred(), calls = []
  const cache = createDraftCache({ sessionId: 'a', delay: 0, request: async (...args) => calls.push(args) })
  const scheduled = cache.schedule(() => { started.resolve(); return exported.promise })
  await started.promise
  await cache.clear()
  exported.resolve({ data: 'obsolete' })
  assert.equal(await scheduled, false)
  assert.deepEqual(calls, [['delete', 'a']])
})

test('clear waits for an active put, then deletes before a newly scheduled draft is written', async () => {
  const started = deferred(), put = deferred(), operations = []
  let stored
  const cache = createDraftCache({ sessionId: 'a', delay: 0, request: async (method, key, value) => {
    operations.push(`${method}:${value?.data || key}`)
    if (value?.data === 'old') { started.resolve(); await put.promise }
    if (method === 'put') stored = value.data
    else stored = undefined
  } })
  const old = cache.schedule(async () => ({ data: 'old' }))
  await started.promise
  const cleared = cache.clear()
  const fresh = cache.schedule(async () => ({ data: 'new' }))
  put.resolve()
  await cleared
  assert.equal(await old, false)
  assert.equal(await fresh, true)
  assert.deepEqual(operations, ['put:old', 'delete:a', 'put:new'])
  assert.equal(stored, 'new')
})

test('superseding an export or disposing suppresses stale writes and errors', async () => {
  const started = deferred(), oldExport = deferred(), calls = [], errors = []
  const cache = createDraftCache({ sessionId: 'a', delay: 0,
    request: async (...args) => calls.push(args), onError: error => errors.push(error.message) })
  const old = cache.schedule(() => { started.resolve(); return oldExport.promise })
  await started.promise
  const fresh = cache.schedule(async () => ({ data: 'new' }))
  assert.equal(await fresh, true)
  oldExport.reject(new Error('stale export'))
  assert.equal(await old, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].data, 'new')
  assert.deepEqual(errors, [])
  const disposed = cache.schedule(async () => { throw new Error('disposed export') })
  cache.dispose()
  assert.equal(await disposed, false)
  assert.equal(await cache.schedule(async () => ({ data: 'never' })), false)
  assert.equal(calls.length, 1)
  assert.deepEqual(errors, [])
})

test('a current storage error is reported and deletion failures can be retried', async () => {
  const errors = []
  let failing = true
  const cache = createDraftCache({ sessionId: 'a', delay: 0, onError: error => errors.push(error.message),
    request: async () => { if (failing) throw new Error('storage unavailable') } })
  assert.equal(await cache.schedule(async () => ({ data: 'draft' })), false)
  assert.deepEqual(errors, ['storage unavailable'])
  await assert.rejects(cache.clear(), /storage unavailable/)
  failing = false
  await cache.clear()
  assert.equal(await cache.schedule(async () => ({ data: 'retry' })), true)
})
