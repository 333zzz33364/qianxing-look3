import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectGia } from '../studio/gia/inspect.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const json = args.includes('--json')
const target = args.find(argument => !argument.startsWith('--'))

if (!target) {
  console.log('Usage: node scripts/inspect-gia.mjs <file.gia> [--json]')
  console.log('Read-only: reports envelope, asset type, GUID range, filePath, scripts and unknown units.')
  process.exitCode = 2
} else {
  try {
    const report = inspectGia(readFileSync(resolve(projectRoot, target)))
    if (json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`File: ${target} (${report.file.bytes} bytes, payload ${report.file.payloadBytes})`)
      console.log(`Asset type: ${report.assetType}`)
      console.log(`Root.filePath: ${report.root.filePath || '<missing>'}`)
      console.log(`Root.gameVersion: ${report.root.gameVersion || '<missing>'}`)
      console.log(`Units: graph ${report.counts.graph}, accessories ${report.counts.accessories}, templates ${report.counts.templates}, scripts ${report.counts.scripts}, unknown ${report.counts.unknown}`)
      for (const unit of report.units) {
        console.log(`  [${unit.bag}] which=${unit.which} ${unit.kind}「${unit.name || '<unnamed>'}」guid=${unit.guidText || '<missing>'}${unit.guidValid ? '' : ' (out of range)'}${unit.script ? ` script=${unit.script.filePath}(${unit.script.sourceLength}B)` : ''}`)
      }
      for (const error of report.errors) console.log(`ERROR: ${error}`)
      for (const warning of report.warnings) console.log(`WARN: ${warning}`)
      console.log(`Result: ${report.ok ? 'PASS' : 'FAIL'}`)
    }
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    console.error(`Cannot inspect ${target}: ${error?.message || String(error)}`)
    process.exitCode = 2
  }
}
