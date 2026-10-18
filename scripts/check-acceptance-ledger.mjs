// Read-only acceptance ledger auditor. Never edits evidence, saves or release files.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeAcceptanceLedger, validEvidencePath } from './acceptance-ledger-core.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ledgerPath = resolve(projectRoot, 'look2-workspace/acceptance-20261009/acceptance-ledger.11.json')

// stat a project-relative evidence path and reject symlinks that escape the root.
// Evidence may come from earlier native runs; source SHA belongs to its own run.
function checkFile(relativeName) {
  if (!validEvidencePath(relativeName)) return { ok: false, reason: 'invalid path' }
  const root = realpathSync(projectRoot)
  const full = resolve(root, ...relativeName.split('/'))
  try {
    const physical = realpathSync(full)
    if (!physical.startsWith(root + sep)) return { ok: false, reason: 'evidence escapes project root' }
    const info = statSync(full)
    if (!info.isFile() || info.size <= 0) return { ok: false, reason: 'empty or non-file evidence' }
    return { ok: true, bytes: info.size }
  } catch (error) {
    return { ok: false, reason: error?.code || String(error?.message || error) }
  }
}

export function auditEvidencePaths(ledger, check = checkFile) {
  const missing = []
  const seen = new Set()
  let currentEvidenceFiles = 0
  let historicalReferences = 0
  for (const item of Array.isArray(ledger?.items) ? ledger.items : []) {
    for (const [kind, paths] of [['current', item?.evidence], ['historical', item?.historicalReferencePaths]]) {
      if (!Array.isArray(paths)) continue
      for (const p of paths) {
        if (!validEvidencePath(p)) continue // pure validator already rejects it
        if (kind === 'current') currentEvidenceFiles++
        else historicalReferences++
        if (seen.has(p)) continue
        seen.add(p)
        const result = check(p)
        if (!result?.ok) missing.push({ id: item.id, kind, path: p, reason: result?.reason || 'not a readable file' })
      }
    }
  }
  return { checkedDistinctPaths: seen.size, currentEvidenceFiles, historicalReferences, missing }
}

export function buildAcceptanceReport(ledger, check = checkFile) {
  const structure = analyzeAcceptanceLedger(ledger)
  const files = auditEvidencePaths(ledger, check)
  const pendingIds = (Array.isArray(ledger?.items) ? ledger.items : [])
    .filter(x => x?.nextGate === 'native-browser' && x.currentResult !== 'passed-current-native-scope')
    .map(x => x.id)
  const blockers = []
  if (pendingIds.length) blockers.push('native-browser: ' + pendingIds.join(', '))
  if (structure.summary.historicalReview) blockers.push('UI07 historical-gap and remaining native coverage')
  if (structure.summary.packagingAndHostRemaining) blockers.push('HT01/HT02 package, install, external hosts and real samples')
  return {
    ledgerRevision: ledger?.revision ?? 'unknown',
    structure,
    files,
    consistent: structure.valid && files.missing.length === 0,
    pendingIds,
    blockers,
    // This is a machine-checkable evidence inventory, not a declaration
    // that external requirements or native browser interactions passed.
    projectComplete: false,
  }
}

function printHelp() {
  console.log('Usage: node scripts/check-acceptance-ledger.mjs [--json] [--strict-complete]')
  console.log('Read-only. Exit 0: ledger/evidence consistent, 2: invalid/missing, 3: remaining gates with --strict-complete.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
  } else if (args.some(a => !['--json', '--strict-complete'].includes(a))) {
    printHelp()
    process.exitCode = 2
  } else {
    try {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      const report = buildAcceptanceReport(ledger)
      if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
      else {
        console.log('Ledger records:', report.structure.summary.total)
        console.log('Native passed/pending:', report.structure.summary.nativeBrowserPassed, '/', report.structure.summary.nativeBrowserPending)
        console.log('Current evidence and historical references:', report.files.currentEvidenceFiles, '/', report.files.historicalReferences)
        console.log('Evidence files checked:', report.files.checkedDistinctPaths)
        for (const error of report.structure.issues) console.error('INVALID:', error)
        for (const file of report.files.missing) console.error('MISSING:', file.path, file.reason)
        for (const blocker of report.blockers) console.log('REMAINS:', blocker)
        console.log('Ledger consistency:', report.consistent ? 'PASS' : 'FAIL')
        console.log('Project completion: NOT CLAIMED BY THIS AUDIT')
      }
      if (!report.consistent) process.exitCode = 2
      else if (args.includes('--strict-complete') && report.blockers.length) process.exitCode = 3
    } catch (error) {
      console.error('Ledger audit failed:', error?.message || String(error))
      process.exitCode = 2
    }
  }
}
