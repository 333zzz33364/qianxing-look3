// Phase 19 saved-evidence consistency audit, strictly read-only.
// This checks existing artifacts, not browser interactions or external hosts.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeAcceptanceLedger } from './acceptance-ledger-core.mjs'

export const PHASE19_CHECK_IDS = Object.freeze([
  'AN01', 'AN02', 'AN03', 'AN04', 'AN07', 'ST01',
  'UI07', 'UI01', 'UI06', 'UI02', 'RS01', 'RS02',
])

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = 'look2-workspace/acceptance-20261010/pause-19-20261010-183103-251a1650'
const PHASE19_FILES = Object.freeze({
  checkpoint: BUNDLE + '/pause-checkpoint.19.json',
  ledger: BUNDLE + '/acceptance-ledger.after.19.json',
  nativeReport: BUNDLE + '/evidence/native-report.19.json',
  formalReadback: BUNDLE + '/evidence/formal-readback.19.json',
  archive: BUNDLE + '/workspace/look2.0.7.save.json',
  sourceEditor: 'editor-ui/look2.js',
})

function exactIds(ids, name, issues) {
  const expected = new Set(PHASE19_CHECK_IDS)
  if (!Array.isArray(ids) || ids.length !== expected.size) {
    issues.push(name + ': expected exactly 12 checks')
    return
  }
  if (new Set(ids).size !== ids.length) issues.push(name + ': duplicate IDs')
  for (const id of ids) if (!expected.has(id)) issues.push(name + ': unknown ID ' + String(id))
  for (const id of expected) if (!ids.includes(id)) issues.push(name + ': missing ' + id)
}

/**
 * Pure documentary review. Never upgrades a native-browser or external gate.
 * archiveBytes is measured on the raw original file (not reserialized JSON).
 */
export function evaluatePhase19Evidence({
  checkpoint, ledger, nativeReport, formalReadback, saveArchive,
  archiveBytes, archiveSha256, sourceSha256,
}) {
  const issues = []
  const phase = checkpoint?.phase19Observed
  const record = ledger?.phase19Observed
  const checks = phase?.checks
  const nativeChecks = nativeReport?.checks
  const ledgerChecks = record?.checks

  if (checkpoint?.candidateVersion !== '2.0.19') issues.push('checkpoint: version mismatch')
  if (checkpoint?.status !== 'paused') issues.push('checkpoint: expected saved paused state')
  if (ledger?.revision !== '19') issues.push('ledger: expected phase 19 revision')
  if (ledger?.currentStatus !== 'paused') issues.push('ledger: saved status changed')
  if (nativeReport?.version !== '2.0.19') issues.push('nativeReport: version mismatch')
  exactIds(checks?.map(x => x?.id), 'checkpoint', issues)
  exactIds(nativeChecks?.map(x => x?.id), 'nativeReport', issues)
  exactIds(ledgerChecks?.map(x => x?.id), 'ledger.phase19Observed', issues)

  for (const id of PHASE19_CHECK_IDS) {
    const cp = checks?.find(x => x?.id === id)
    const nr = nativeChecks?.find(x => x?.id === id)
    const lr = ledgerChecks?.find(x => x?.id === id)
    if (cp?.passedSelfCheck !== true || nr?.passed !== true || lr?.passedSelfCheck !== true) {
      issues.push(id + ': report/checkpoint/ledger self-check mismatch')
    }
    if (cp?.independentReview !== 'not-completed-user-paused' ||
        lr?.independentReview !== 'not-completed-user-paused') {
      issues.push(id + ': frozen independent-review status differs')
    }
  }

  const expectedSource = phase?.sourceEditorSha256
  const expectedServed = phase?.servedEditorSha256
  if (!expectedSource || sourceSha256 !== expectedSource) issues.push('source editor SHA-256 differs from checkpoint')
  if (!expectedServed || nativeReport?.servedEditorSha256 !== expectedServed ||
      record?.servedEditorSha256 !== expectedServed) {
    issues.push('served editor SHA-256 identity inconsistent')
  }
  if (nativeReport?.sourceEditorSha256 !== expectedSource ||
      record?.sourceEditorSha256 !== expectedSource) {
    issues.push('report/ledger source editor identity inconsistent')
  }

  const saved = checkpoint?.latestSavedArchive
  if (saved?.path !== PHASE19_FILES.archive) issues.push('checkpoint: unexpected isolated archive path')
  if (saved?.bytes !== archiveBytes || saved?.sha256 !== archiveSha256) {
    issues.push('archive bytes or SHA-256 differ from saved checkpoint')
  }
  if (saveArchive?.format !== 'qxqy-simulator-save' || saveArchive?.version !== 4) {
    issues.push('archive: unsupported format/version')
  }
  if (saveArchive?.meta?.name !== 'look2.0 本地闭环验收 2.0.19') {
    issues.push('archive: unexpected project name')
  }
  if (formalReadback?.rootMatches !== true || formalReadback?.look2Matches !== true) {
    issues.push('formal readback flags do not both pass')
  }
  // Compare the raw saved look2 payload with the reopened snapshot, not just
  // an unverified boolean in the report.
  if (!saveArchive?.look2 || !formalReadback?.reopened?.look2 ||
      JSON.stringify(saveArchive.look2) !== JSON.stringify(formalReadback.reopened.look2)) {
    issues.push('archive and reopened look2 payload differ')
  }
  if (!Array.isArray(nativeReport?.savedPaths) ||
      !nativeReport.savedPaths.includes('look2.0.7.save.json')) {
    issues.push('nativeReport: missing final isolated save reference')
  }

  const ledgerStructure = analyzeAcceptanceLedger(ledger)
  if (!ledgerStructure.valid) issues.push('ledger: ' + ledgerStructure.issues.join('; '))
  // Saved snapshot must not be silently promoted because the native report
  // declares its own checks passing.
  if (ledgerStructure.summary.nativeBrowserPassed !== 8 ||
      ledgerStructure.summary.nativeBrowserPending !== 6 ||
      ledgerStructure.summary.historicalReview !== 1 ||
      ledgerStructure.summary.packagingAndHostRemaining !== 2) {
    issues.push('ledger: recorded gate counts no longer match phase19 checkpoint')
  }
  return {
    version: '2.0.19',
    evidenceChecks: PHASE19_CHECK_IDS.length,
    documentaryConsistent: issues.length === 0,
    issues,
    gateCounts: ledgerStructure.summary,
    archiveIdentityMatches: saved?.bytes === archiveBytes && saved?.sha256 === archiveSha256,
    sourceIdentityMatches: sourceSha256 === expectedSource,
    reopenedLook2Matches: !!saveArchive?.look2 && !!formalReadback?.reopened?.look2 &&
      JSON.stringify(saveArchive.look2) === JSON.stringify(formalReadback.reopened.look2),
    independentNativeReviewCompleted: false,
    externalHostVerified: false,
    projectComplete: false,
    limitations: [
      'Only cross-checks saved phase19 documents, source bytes and the isolated archive.',
      'Does not rerun the UI, replay the recorded network trace or validate screenshots.',
      'Does not replace independent native-browser, external host or real-sample acceptance.',
    ],
  }
}

function getBytes(relative) {
  return readFileSync(resolve(ROOT, relative))
}
function getJson(relative) {
  return JSON.parse(getBytes(relative).toString('utf8'))
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
export function runPhase19EvidenceAudit() {
  const archiveRaw = getBytes(PHASE19_FILES.archive)
  return evaluatePhase19Evidence({
    checkpoint: getJson(PHASE19_FILES.checkpoint),
    ledger: getJson(PHASE19_FILES.ledger),
    nativeReport: getJson(PHASE19_FILES.nativeReport),
    formalReadback: getJson(PHASE19_FILES.formalReadback),
    saveArchive: JSON.parse(archiveRaw.toString('utf8')),
    archiveBytes: archiveRaw.length,
    archiveSha256: sha256(archiveRaw),
    sourceSha256: sha256(getBytes(PHASE19_FILES.sourceEditor)),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/phase19-evidence-audit.mjs [--json]')
    console.log('Read-only documentary consistency check; never declares native or external acceptance.')
  } else if (args.some(x => x !== '--json')) {
    console.error('Unsupported argument. Use --help.')
    process.exitCode = 2
  } else {
    try {
      const result = runPhase19EvidenceAudit()
      if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
      else {
        console.log('Phase 19 evidence checks:', result.evidenceChecks)
        console.log('Saved documentary consistency:', result.documentaryConsistent ? 'PASS' : 'FAIL')
        for (const issue of result.issues) console.error('ISSUE:', issue)
        console.log('Independent native review: NOT COMPLETED')
        console.log('External acceptance: NOT COMPLETED')
        console.log('Project complete: NO')
      }
      if (!result.documentaryConsistent) process.exitCode = 2
    } catch (error) {
      console.error('Phase19 audit failed:', error?.message || String(error))
      process.exitCode = 2
    }
  }
}
