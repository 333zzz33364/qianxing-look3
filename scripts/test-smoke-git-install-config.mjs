import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./smoke-git-install.mjs', import.meta.url))
const packageName = 'look3-dsh-plugin'
const repositoryUrl = 'git+file:///C:/Temp/qxqy-git-install/source'
const commit = '706d453b55b8bb1e991bef43b49acc71c839043d'

function render(pnpmVersion) {
  const output = execFileSync(process.execPath, [script, '--print-workspace-config', JSON.stringify({
    pnpmVersion,
    packageName,
    repositoryUrl,
    commit,
  })], { encoding: 'utf8' })
  return JSON.parse(output)
}

const pnpm10 = render('10.15.0')
assert.equal(pnpm10, `onlyBuiltDependencies:\n  - ${packageName}\n  - esbuild\n`)
assert.ok(!pnpm10.includes('allowBuilds'))

const pnpm10Modern = render('10.26.0')
const exactGitPackage = `${packageName}@${repositoryUrl}#${commit}`
assert.equal(pnpm10Modern, `allowBuilds:\n  ${JSON.stringify(exactGitPackage)}: true\n  esbuild: true\n`)

const pnpm12 = render('12.9.1')
assert.equal(pnpm12, pnpm10Modern)
assert.ok(!pnpm12.includes('*'))
assert.ok(!pnpm12.includes('dangerouslyAllowAllBuilds'))

console.log('PASS Git install workspace policy: pnpm 10 legacy/allowBuilds boundary and exact pnpm 12 Git commit allowlist')
