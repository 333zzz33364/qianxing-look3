import test from 'node:test'
import assert from 'node:assert/strict'
import { commitInputDraft, createInputDraft } from '../../editor-ui/input-draft.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

for (const [kind, initial, first, second, committed] of [
  ['scalar', '610', '101', '102', '102'],
  ['color', '#FF112233', '#FF445566', '#FF778899', '#FF778899'],
]) {
  test(`${kind} draft keeps a newer edit across an older async commit and accepts the retry`, async () => {
    const draft = createInputDraft(initial)
    const firstSave = deferred()

    draft.edit(first)
    const firstCommit = commitInputDraft(draft, () => firstSave.promise)
    draft.edit(second)

    const propSync = draft.sync(first)
    assert.deepEqual(propSync, { changed: false, value: second })
    assert.equal(draft.value, second)
    assert.equal(draft.dirty, true)

    firstSave.resolve(first)
    const firstResult = await firstCommit
    assert.equal(firstResult.ok, true)
    assert.equal(firstResult.changed, false)
    assert.equal(draft.value, second)
    assert.equal(draft.dirty, true)

    const retryResult = await commitInputDraft(draft, async value => {
      assert.equal(value, second)
      return committed
    })
    assert.equal(retryResult.ok, true)
    assert.equal(retryResult.changed, true)
    assert.equal(draft.value, committed)
    assert.equal(draft.dirty, false)
  })
}

test('failed draft remains dirty for retry and Escape reset invalidates the pending attempt', async () => {
  const draft = createInputDraft('old')
  const pending = deferred()
  draft.edit('typed')
  const failedCommit = commitInputDraft(draft, () => Promise.reject(new Error('offline')))
  const pendingCommit = commitInputDraft(draft, () => pending.promise)

  const failed = await failedCommit
  assert.equal(failed.ok, false)
  assert.equal(failed.current, true)
  assert.equal(draft.value, 'typed')
  assert.equal(draft.dirty, true)

  draft.sync('latest prop')
  draft.reset('latest prop')
  pending.resolve('stale response')
  const stale = await pendingCommit
  assert.equal(stale.ok, true)
  assert.equal(stale.changed, false)
  assert.equal(draft.value, 'latest prop')
  assert.equal(draft.dirty, false)
})

test('reset releases only this draft\'s errors, including a failure arriving after cancellation', async () => {
  const discarded = []
  const draft = createInputDraft('old', { onDiscardError: error => discarded.push(error) })
  const firstError = new Error('failed before Escape')
  draft.edit('first')
  await commitInputDraft(draft, async () => { throw firstError })
  assert.deepEqual(discarded, [])
  draft.reset()
  assert.deepEqual(discarded, [firstError])

  const pending = deferred()
  const lateError = new Error('failed after Escape')
  draft.edit('second')
  const save = commitInputDraft(draft, () => pending.promise)
  draft.reset()
  pending.reject(lateError)
  const result = await save
  assert.equal(result.current, false)
  assert.equal(draft.dirty, false)
  assert.deepEqual(discarded, [firstError, lateError])

  const retainedError = new Error('newer input is still dirty')
  draft.edit('third')
  const newerPending = deferred()
  const olderSave = commitInputDraft(draft, () => newerPending.promise)
  draft.edit('fourth')
  newerPending.reject(retainedError)
  await olderSave
  assert.deepEqual(discarded, [firstError, lateError])
  assert.equal(draft.dirty, true)
  draft.reset()
  assert.deepEqual(discarded, [firstError, lateError, retainedError])
})
