// Pure validation of the 37-domain acceptance ledger. No filesystem writes.
export const ACCEPTANCE_IDS = Object.freeze([
  'UI01','UI02','UI03','UI04','UI05','UI06','UI07','UI08',
  'RS01','RS02','RS03','RS04','RS05','RS06','RS07','RS08','RS09',
  'AN01','AN02','AN03','AN04','AN05','AN06','AN07',
  'TP01','IM01','IM02','IM03','IM04','LU01','LU02','LU03',
  'ST01','ST02','ST03','HT01','HT02',
])
export const PHASE13_PASSED = Object.freeze(['UI01','UI02','UI06','RS01','RS02','ST02'])
export const PHASE13_PENDING = Object.freeze(['RS08','AN01','AN02','AN03','AN04','AN07','IM01','ST01'])

// Each domain ID has a fixed acceptance gate. Checking only the number of
// native/UI07/HT rows would miss a swapped gate with unchanged totals.
export const NATIVE_BROWSER_IDS = Object.freeze([...PHASE13_PASSED, ...PHASE13_PENDING])
const NATIVE_BROWSER_SET = new Set(NATIVE_BROWSER_IDS)
export function expectedGateForId(id) {
  if (!ACCEPTANCE_IDS.includes(id)) return null
  if (NATIVE_BROWSER_SET.has(id)) return 'native-browser'
  if (id === 'UI07') return 'historical-evidence-review'
  if (id === 'HT01') return 'package-and-external'
  if (id === 'HT02') return 'browser-package-and-external'
  return 'historical-evidence-retained'
}

const RESULT_TYPES = new Set([
  'passed-current-native-scope',
  'pending-current-acceptance',
  'prior-local-evidence-retained',
  'passed-current-reviewed',
  'passed-verified-external',
])
const GATES = new Set([
  'native-browser',
  'historical-evidence-review',
  'historical-evidence-retained',
  'package-and-external',
  'browser-package-and-external',
])

// Paths are project-root-relative. In particular, an existing historical
// reference does not count as current native acceptance evidence.
export function validEvidencePath(path) {
  if (typeof path !== 'string' || !path.startsWith('look2-workspace/')) return false
  if (path.includes('\\') || path.includes('\0') || /[\r\n]/.test(path)) return false
  const segments = path.split('/')
  return segments.length >= 3 && segments.every(s => s && s !== '.' && s !== '..' && !s.includes(':'))
}

export function analyzeAcceptanceLedger(ledger) {
  const issues = []
  const warning = []
  const items = Array.isArray(ledger?.items) ? ledger.items : []
  if (!Array.isArray(ledger?.items)) issues.push('items must be an array')
  const expected = new Set(ACCEPTANCE_IDS)
  const seen = new Set()
  const actual = { nativeBrowserPassed: 0, nativeBrowserPending: 0, historicalReview: 0, packagingAndHostRemaining: 0 }
  let historicalRows = 0
  let externalRows = 0
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push('item must be an object')
      continue
    }
    const { id, nextGate, currentResult } = item
    if (!expected.has(id)) issues.push('unexpected item ID: ' + String(id))
    if (seen.has(id)) issues.push('duplicate item ID: ' + String(id))
    seen.add(id)
    if (!GATES.has(nextGate)) issues.push(String(id) + ': invalid nextGate')
    const expectedGate = expectedGateForId(id)
    if (expectedGate && nextGate !== expectedGate) issues.push(String(id) + ': expected gate ' + expectedGate + ', got ' + String(nextGate))
    if (!RESULT_TYPES.has(currentResult)) issues.push(String(id) + ': invalid currentResult')
    if (!Array.isArray(item.evidence)) issues.push(String(id) + ': evidence must be an array')
    else {
      for (const p of item.evidence) if (!validEvidencePath(p)) issues.push(String(id) + ': unsafe evidence path')
      if (new Set(item.evidence).size !== item.evidence.length) issues.push(String(id) + ': duplicate evidence')
      if (typeof currentResult === 'string' && currentResult.startsWith('passed-') && item.evidence.length === 0) {
        issues.push(String(id) + ': marked passed without current evidence')
      }
    }
    const historical = item.historicalReferencePaths ?? []
    if (!Array.isArray(historical)) issues.push(String(id) + ': historicalReferencePaths must be an array')
    else for (const p of historical) if (!validEvidencePath(p)) issues.push(String(id) + ': unsafe historical reference path')
    if (nextGate === 'native-browser') {
      if (currentResult === 'passed-current-native-scope') actual.nativeBrowserPassed++
      else if (currentResult === 'pending-current-acceptance') actual.nativeBrowserPending++
      else issues.push(String(id) + ': native-browser gate has inconsistent result')
    } else if (nextGate === 'historical-evidence-review') {
      historicalRows++
      if (currentResult === 'prior-local-evidence-retained') actual.historicalReview++
      else if (currentResult !== 'passed-current-reviewed') issues.push(String(id) + ': invalid historical review status')
    } else if (nextGate === 'package-and-external' || nextGate === 'browser-package-and-external') {
      externalRows++
      if (currentResult === 'pending-current-acceptance') actual.packagingAndHostRemaining++
      else if (currentResult !== 'passed-verified-external') issues.push(String(id) + ': invalid external gate status')
    } else if (currentResult !== 'prior-local-evidence-retained') {
      issues.push(String(id) + ': invalid historical retained status')
    }
  }
  for (const id of ACCEPTANCE_IDS) if (!seen.has(id)) issues.push('missing item ID: ' + id)
  if (items.length !== ACCEPTANCE_IDS.length) issues.push('expected exactly 37 items')
  if (actual.nativeBrowserPassed + actual.nativeBrowserPending !== 14) issues.push('expected 14 native-browser items')
  if (historicalRows !== 1) issues.push('expected one UI07 historical-review row')
  if (externalRows !== 2) issues.push('expected two HT external rows')
  if (ledger?.counts && typeof ledger.counts === 'object') {
    const counts = { total: items.length, ...actual }
    for (const [key, number] of Object.entries(counts)) {
      if (ledger.counts[key] !== number) {
        issues.push('counts.' + key + ' missing or inconsistent with item rows: ' + number)
      }
    }
  } else issues.push('counts must be an object')
  // A valid ledger may be incomplete. Do not report project completion from
  // these structural checks or reuse earlier unit-test counts as page evidence.
  if (actual.nativeBrowserPending > 0) warning.push(actual.nativeBrowserPending + ' native-browser scopes still pending')
  if (actual.historicalReview > 0) warning.push('UI07 historical evidence remains to be completed')
  if (actual.packagingAndHostRemaining > 0) warning.push('release/install and external-host gates remain open')
  return {
    valid: issues.length === 0,
    issues,
    warnings: warning,
    summary: { total: items.length, ...actual, nativeBrowserComplete: actual.nativeBrowserPending === 0 },
  }
}
