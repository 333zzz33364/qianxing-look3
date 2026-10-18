import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCEPTANCE_IDS,
  PHASE13_PASSED,
  PHASE13_PENDING,
  expectedGateForId,
  analyzeAcceptanceLedger,
  validEvidencePath,
} from '../../scripts/acceptance-ledger-core.mjs'
import { auditEvidencePaths, buildAcceptanceReport } from '../../scripts/check-acceptance-ledger.mjs'

function fixture() {
  const passed = new Set(PHASE13_PASSED)
  const pending = new Set(PHASE13_PENDING)
  return {
    revision: '13',
    counts: { total: 37, nativeBrowserPassed: 6, nativeBrowserPending: 8, historicalReview: 1, packagingAndHostRemaining: 2 },
    items: ACCEPTANCE_IDS.map(id => {
      if (passed.has(id)) return {
        id, nextGate: 'native-browser', currentResult: 'passed-current-native-scope',
        evidence: ['look2-workspace/synthetic/' + id + '.json'], historicalReferencePaths: [],
      }
      if (pending.has(id)) return { id, nextGate: 'native-browser', currentResult: 'pending-current-acceptance', evidence: [], historicalReferencePaths: [] }
      if (id === 'UI07') return { id, nextGate: 'historical-evidence-review', currentResult: 'prior-local-evidence-retained', evidence: [], historicalReferencePaths: ['look2-workspace/old/UI07.md'] }
      if (id === 'HT01' || id === 'HT02') return { id, nextGate: id === 'HT01' ? 'package-and-external' : 'browser-package-and-external', currentResult: 'pending-current-acceptance', evidence: [], historicalReferencePaths: [] }
      return { id, nextGate: 'historical-evidence-retained', currentResult: 'prior-local-evidence-retained', evidence: [], historicalReferencePaths: [] }
    }),
  }
}

test('HT02 ledger contains all 37 unique IDs and phase-13 six/eight native scopes', () => {
  assert.equal(ACCEPTANCE_IDS.length, 37)
  assert.equal(new Set(ACCEPTANCE_IDS).size, 37)
  const report = analyzeAcceptanceLedger(fixture())
  assert.deepEqual(report.issues, [])
  assert.equal(report.valid, true)
  assert.equal(report.summary.nativeBrowserPassed, 6)
  assert.equal(report.summary.nativeBrowserPending, 8)
  assert.equal(report.summary.nativeBrowserComplete, false)
})

test('HT02 missing or duplicate domain IDs are rejected', () => {
  const missed = fixture()
  missed.items.pop()
  missed.counts.total--
  assert.match(analyzeAcceptanceLedger(missed).issues.join(' '), /missing item ID: HT02/)
  const duplicated = fixture()
  duplicated.items.push({ ...duplicated.items[0] })
  assert.match(analyzeAcceptanceLedger(duplicated).issues.join(' '), /duplicate item ID: UI01/)
})

test('HT02 a native passed status without current evidence is invalid', () => {
  const ledger = fixture()
  ledger.items.find(x => x.id === 'RS02').evidence = []
  assert.match(analyzeAcceptanceLedger(ledger).issues.join(' '), /RS02: marked passed without current evidence/)
})

test('HT02 historical references never replace current native-page evidence', () => {
  const ledger = fixture()
  const row = ledger.items.find(x => x.id === 'RS02')
  row.evidence = []
  row.historicalReferencePaths = ['look2-workspace/history/rs02.md']
  assert.equal(analyzeAcceptanceLedger(ledger).valid, false)
})

test('HT02 evidence paths reject traversal, absolute paths, backslashes and NUL', () => {
  for (const candidate of [
    '../outside.json',
    '/tmp/outside.json',
    'C:/secret/save.json',
    'look2-workspace/../../outside.txt',
    'look2-workspace/evidence/../outside.json',
    'look2-workspace/evidence\\outside.json',
    'look2-workspace/evidence/\0evil',
  ]) assert.equal(validEvidencePath(candidate), false, candidate)
  assert.equal(validEvidencePath('look2-workspace/evidence/run-1.json'), true)
})

test('HT02 ledger rejects unsafe current and historical paths', () => {
  const ledger = fixture()
  ledger.items.find(x => x.id === 'UI01').evidence = ['look2-workspace/../../secret.txt']
  ledger.items.find(x => x.id === 'UI07').historicalReferencePaths = ['../wrong.md']
  const result = analyzeAcceptanceLedger(ledger)
  assert.ok(result.issues.some(x => x.includes('unsafe evidence path')))
  assert.ok(result.issues.some(x => x.includes('unsafe historical reference path')))
})

test('HT02 actual row counts override optimistic summary fields', () => {
  const ledger = fixture()
  ledger.counts.nativeBrowserPassed = 14
  ledger.counts.nativeBrowserPending = 0
  const result = analyzeAcceptanceLedger(ledger)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(x => x.includes('counts.nativeBrowserPassed')))
  assert.equal(result.summary.nativeBrowserPending, 8)
})

test('HT02 wrong native gate and pass status combinations are rejected', () => {
  const ledger = fixture()
  ledger.items.find(x => x.id === 'AN01').currentResult = 'passed-current-native-scope'
  const result = analyzeAcceptanceLedger(ledger)
  assert.ok(result.issues.some(x => x.includes('AN01: marked passed without current evidence')))
  assert.ok(result.issues.some(x => x.includes('counts.nativeBrowserPending')))
})

test('HT02 missing evidence files are separately reported and do not change rows', () => {
  const ledger = fixture()
  const originalStatus = ledger.items.find(x => x.id === 'UI01').currentResult
  const result = buildAcceptanceReport(ledger, p => p.endsWith('UI01.json') ? { ok: false, reason: 'ENOENT' } : { ok: true })
  assert.equal(result.structure.valid, true)
  assert.equal(result.consistent, false)
  assert.equal(result.files.missing.length, 1)
  assert.equal(result.files.missing[0].id, 'UI01')
  assert.equal(ledger.items.find(x => x.id === 'UI01').currentResult, originalStatus)
})

test('HT02 read-only evidence inventory keeps current and historical counts distinct', () => {
  const result = auditEvidencePaths(fixture(), () => ({ ok: true }))
  assert.equal(result.currentEvidenceFiles, 6)
  assert.equal(result.historicalReferences, 1)
  assert.equal(result.checkedDistinctPaths, 7)
  assert.deepEqual(result.missing, [])
})

test('HT02 even when 14 browser scopes pass, UI07 and external release gates remain', () => {
  const ledger = fixture()
  for (const item of ledger.items.filter(x => x.nextGate === 'native-browser')) {
    item.currentResult = 'passed-current-native-scope'
    if (!item.evidence.length) item.evidence = ['look2-workspace/synthetic/' + item.id + '.json']
  }
  ledger.counts.nativeBrowserPassed = 14
  ledger.counts.nativeBrowserPending = 0
  const result = buildAcceptanceReport(ledger, () => ({ ok: true }))
  assert.equal(result.consistent, true)
  assert.equal(result.structure.summary.nativeBrowserComplete, true)
  assert.equal(result.projectComplete, false)
  assert.ok(result.blockers.some(x => x.includes('UI07')))
  assert.ok(result.blockers.some(x => x.includes('HT01/HT02')))
})

test('HT02 completed UI07 and external gates still require distinct current evidence', () => {
  const ledger = fixture()
  for (const id of ['UI07','HT01','HT02']) {
    const item = ledger.items.find(x => x.id === id)
    item.currentResult = id === 'UI07' ? 'passed-current-reviewed' : 'passed-verified-external'
  }
  ledger.counts.historicalReview = 0
  ledger.counts.packagingAndHostRemaining = 0
  const result = analyzeAcceptanceLedger(ledger)
  assert.equal(result.valid, false)
  assert.equal(result.issues.filter(x => x.includes('marked passed without current evidence')).length, 3)
})

test('HT02 all recorded gates may close only with evidence, never by test counts alone', () => {
  const ledger = fixture()
  for (const item of ledger.items.filter(x => x.nextGate === 'native-browser')) {
    item.currentResult = 'passed-current-native-scope'
    if (!item.evidence.length) item.evidence = ['look2-workspace/synthetic/' + item.id + '.json']
  }
  ledger.counts.nativeBrowserPending = 0
  ledger.counts.nativeBrowserPassed = 14
  for (const id of ['UI07','HT01','HT02']) {
    const item = ledger.items.find(x => x.id === id)
    item.currentResult = id === 'UI07' ? 'passed-current-reviewed' : 'passed-verified-external'
    item.evidence = ['look2-workspace/synthetic/' + id + '.json']
  }
  ledger.counts.historicalReview = 0
  ledger.counts.packagingAndHostRemaining = 0
  const report = buildAcceptanceReport(ledger, () => ({ ok: true }))
  assert.equal(report.consistent, true)
  assert.deepEqual(report.blockers, [])
  assert.equal(report.projectComplete, false)
})

test('HT02 native gate IDs cannot be swapped with historical IDs even with equal counts', () => {
  const ledger = fixture()
  const native = ledger.items.find(x => x.id === 'AN03')
  const historic = ledger.items.find(x => x.id === 'UI03')
  native.nextGate = 'historical-evidence-retained'
  native.currentResult = 'prior-local-evidence-retained'
  historic.nextGate = 'native-browser'
  historic.currentResult = 'pending-current-acceptance'
  // Aggregate six/eight and the other gate totals stay unchanged.
  assert.equal(ledger.counts.nativeBrowserPending, 8)
  const result = analyzeAcceptanceLedger(ledger)
  assert.equal(result.summary.nativeBrowserPending, 8)
  assert.ok(result.issues.some(x => x.includes('AN03: expected gate native-browser')))
  assert.ok(result.issues.some(x => x.includes('UI03: expected gate historical-evidence-retained')))
})

test('HT02 UI07 and HT01/HT02 gates are bound to exact domain IDs', () => {
  const ledger = fixture()
  const ui07 = ledger.items.find(x => x.id === 'UI07')
  const ui08 = ledger.items.find(x => x.id === 'UI08')
  ui07.nextGate = 'historical-evidence-retained'
  ui08.nextGate = 'historical-evidence-review'
  const ht01 = ledger.items.find(x => x.id === 'HT01')
  const ht02 = ledger.items.find(x => x.id === 'HT02')
  ;[ht01.nextGate, ht02.nextGate] = [ht02.nextGate, ht01.nextGate]
  const result = analyzeAcceptanceLedger(ledger)
  for (const id of ['UI07','UI08','HT01','HT02']) {
    assert.ok(result.issues.some(x => x.includes(id + ': expected gate')), id)
  }
  assert.equal(result.summary.packagingAndHostRemaining, 2)
})

test('HT02 count fields are mandatory, not optional optimistic placeholders', () => {
  const ledger = fixture()
  delete ledger.counts.nativeBrowserPending
  delete ledger.counts.total
  const result = analyzeAcceptanceLedger(ledger)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(x => x.includes('counts.nativeBrowserPending')))
  assert.ok(result.issues.some(x => x.includes('counts.total')))
})

test('HT02 fixed native and external gate definitions include precisely the expected codes', () => {
  assert.equal(expectedGateForId('AN03'), 'native-browser')
  assert.equal(expectedGateForId('UI07'), 'historical-evidence-review')
  assert.equal(expectedGateForId('HT01'), 'package-and-external')
  assert.equal(expectedGateForId('HT02'), 'browser-package-and-external')
  assert.equal(expectedGateForId('UI03'), 'historical-evidence-retained')
  assert.equal(expectedGateForId('UNKNOWN'), null)
})

test('HT02 malformed status values report validation errors without crashing', () => {
  const ledger = fixture()
  delete ledger.items[0].currentResult
  const result = analyzeAcceptanceLedger(ledger)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(x => x.includes('invalid currentResult')))
})
