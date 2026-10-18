import test from 'node:test'
import assert from 'node:assert/strict'
import { ACCEPTANCE_IDS, expectedGateForId } from '../../scripts/acceptance-ledger-core.mjs'
import { PHASE19_CHECK_IDS, evaluatePhase19Evidence } from '../../scripts/phase19-evidence-audit.mjs'

function fixture() {
  const archivePath = 'look2-workspace/acceptance-20261010/pause-19-20261010-183103-251a1650/workspace/look2.0.7.save.json'
  const source = 'a'.repeat(64)
  const served = 'b'.repeat(64)
  const selfChecks = PHASE19_CHECK_IDS.map(id => ({
    id, passedSelfCheck: true, independentReview: 'not-completed-user-paused',
  }))
  const nativePassed = new Set(['UI01', 'UI02', 'UI06', 'RS01', 'RS02', 'RS08', 'IM01', 'ST02'])
  const items = ACCEPTANCE_IDS.map(id => {
    const nextGate = expectedGateForId(id)
    const currentResult = nextGate === 'native-browser'
      ? nativePassed.has(id) ? 'passed-current-native-scope' : 'pending-current-acceptance'
      : 'prior-local-evidence-retained'
    return {
      id, nextGate,
      currentResult: nextGate === 'package-and-external' || nextGate === 'browser-package-and-external'
        ? 'pending-current-acceptance' : currentResult,
      evidence: nativePassed.has(id) ? ['look2-workspace/synthetic/' + id + '.json'] : [],
      historicalReferencePaths: [],
    }
  })
  return {
    checkpoint: {
      status: 'paused',
      candidateVersion: '2.0.19',
      latestSavedArchive: { path: archivePath, bytes: 10, sha256: 'c'.repeat(64) },
      phase19Observed: { sourceEditorSha256: source, servedEditorSha256: served, checks: selfChecks },
    },
    ledger: {
      revision: '19', currentStatus: 'paused',
      counts: { total: 37, nativeBrowserPassed: 8, nativeBrowserPending: 6, historicalReview: 1, packagingAndHostRemaining: 2 },
      items,
      phase19Observed: { sourceEditorSha256: source, servedEditorSha256: served, checks: structuredClone(selfChecks) },
    },
    nativeReport: {
      version: '2.0.19', sourceEditorSha256: source, servedEditorSha256: served,
      checks: PHASE19_CHECK_IDS.map(id => ({ id, passed: true })),
      savedPaths: ['look2.0.7.save.json'],
    },
    formalReadback: {
      rootMatches: true, look2Matches: true,
      reopened: { look2: { animations: [{ id: 'first' }] } },
    },
    saveArchive: {
      format: 'qxqy-simulator-save',
      version: 4, meta: { name: 'look2.0 本地闭环验收 2.0.19' },
      look2: { animations: [{ id: 'first' }] },
    },
    archiveBytes: 10, archiveSha256: 'c'.repeat(64), sourceSha256: source,
  }
}

test('phase19 12 documentary checks match without claiming final acceptance', () => {
  const result = evaluatePhase19Evidence(fixture())
  assert.equal(result.documentaryConsistent, true)
  assert.deepEqual(result.issues, [])
  assert.equal(result.evidenceChecks, 12)
  assert.equal(result.independentNativeReviewCompleted, false)
  assert.equal(result.externalHostVerified, false)
  assert.equal(result.projectComplete, false)
  assert.equal(result.gateCounts.nativeBrowserPending, 6)
})

test('phase19 archive hash and source hash changes invalidate the saved identity', () => {
  const f = fixture()
  f.archiveSha256 = 'e'.repeat(64)
  f.sourceSha256 = 'f'.repeat(64)
  const result = evaluatePhase19Evidence(f)
  assert.equal(result.documentaryConsistent, false)
  assert.ok(result.issues.some(x => x.includes('archive bytes or SHA-256')))
  assert.ok(result.issues.some(x => x.includes('source editor SHA-256')))
})

test('phase19 tampered native report and served-build identity are detected', () => {
  const f = fixture()
  f.nativeReport.checks.find(x => x.id === 'AN03').passed = false
  f.nativeReport.servedEditorSha256 = 'e'.repeat(64)
  const result = evaluatePhase19Evidence(f)
  assert.equal(result.documentaryConsistent, false)
  assert.ok(result.issues.some(x => x.includes('AN03:')))
  assert.ok(result.issues.some(x => x.includes('served editor SHA-256')))
})

test('phase19 evidence ID omissions and duplicates cannot be silently accepted', () => {
  const f = fixture()
  f.nativeReport.checks.pop()
  f.ledger.phase19Observed.checks[1].id = 'AN01'
  const result = evaluatePhase19Evidence(f)
  assert.equal(result.documentaryConsistent, false)
  assert.ok(result.issues.some(x => x.includes('nativeReport: expected exactly 12 checks')))
  assert.ok(result.issues.some(x => x.includes('ledger.phase19Observed: duplicate IDs')))
})

test('phase19 saved and reopened look2 data are compared independently of self-report flags', () => {
  const f = fixture()
  f.formalReadback.reopened.look2.animations[0].id = 'changed'
  const result = evaluatePhase19Evidence(f)
  assert.equal(result.reopenedLook2Matches, false)
  assert.ok(result.issues.some(x => x.includes('archive and reopened look2 payload differ')))
})

test('phase19 state cannot be optimistically promoted by existing self-checks', () => {
  const f = fixture()
  f.ledger.items.find(x => x.id === 'AN01').currentResult = 'passed-current-native-scope'
  f.ledger.items.find(x => x.id === 'AN01').evidence = ['look2-workspace/synthetic/AN01.json']
  f.ledger.counts.nativeBrowserPassed = 9
  f.ledger.counts.nativeBrowserPending = 5
  const result = evaluatePhase19Evidence(f)
  assert.equal(result.documentaryConsistent, false)
  assert.ok(result.issues.some(x => x.includes('gate counts')))
})

test('phase19 saved review flags must remain recorded as pending', () => {
  const f = fixture()
  f.checkpoint.phase19Observed.checks[0].independentReview = 'done'
  const result = evaluatePhase19Evidence(f)
  assert.equal(result.documentaryConsistent, false)
  assert.ok(result.issues.some(x => x.includes('independent-review status')))
})
