// Exercise a real Git dependency from a source-only snapshot, without changing
// the user's repository history, remote, or Harness profile.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { root, cleanGenerated } from './paths.mjs'

const supportedDshToolsVersions = new Set(['0.1.0-rc.6', '0.2.0-rc.2'])

function satisfiesLegacyDshToolsPeer(version) {
  const match = /^0\.1\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return false
  const patch = Number(match[1])
  if (patch > 0) return true
  if (!match[2]) return true
  const releaseCandidate = /^rc\.(\d+)$/.exec(match[2])
  return Boolean(releaseCandidate && Number(releaseCandidate[1]) >= 6)
}

function selectedDshToolsVersion(manifest) {
  const version = process.env.LOOK2_DSH_TOOLS_VERSION || manifest.devDependencies?.['@deepseek-ai/dsh-tools']
  assert.ok(supportedDshToolsVersions.has(version),
    `LOOK2_DSH_TOOLS_VERSION must be 0.1.0-rc.6 or 0.2.0-rc.2; got ${JSON.stringify(version)}`)
  return version
}

async function assertCliDshToolsVersion(cliPath, expectedVersion) {
  const cliRequire = createRequire(resolve(cliPath))
  const toolsManifestPath = cliRequire.resolve('@deepseek-ai/dsh-tools/package.json')
  const toolsManifest = JSON.parse(await readFile(toolsManifestPath, 'utf8'))
  console.log(`Supplied DSH CLI resolves @deepseek-ai/dsh-tools ${toolsManifest.version}`)
  const compatible = expectedVersion === '0.1.0-rc.6'
    ? satisfiesLegacyDshToolsPeer(toolsManifest.version)
    : toolsManifest.version === expectedVersion
  assert.ok(compatible,
    `LOOK2_DSH_TOOLS_VERSION=${expectedVersion} does not match the supplied DSH CLI's dsh-tools ${toolsManifest.version}`)
}

function usesAllowBuilds(pnpmVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(pnpmVersion)
  assert.ok(match, `Expected an exact pnpm version, got ${JSON.stringify(pnpmVersion)}`)
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 10 || major === 10 && minor >= 26
}

function renderWorkspaceConfig({ pnpmVersion, packageName, repositoryUrl, commit }) {
  if (usesAllowBuilds(pnpmVersion)) {
    const exactGitPackage = `${packageName}@${repositoryUrl}#${commit}`
    return [
      'allowBuilds:',
      `  ${JSON.stringify(exactGitPackage)}: true`,
      '  esbuild: true',
      '',
    ].join('\n')
  }
  return `onlyBuiltDependencies:\n  - ${packageName}\n  - esbuild\n`
}

if (process.argv[2] === '--print-workspace-config') {
  process.stdout.write(JSON.stringify(renderWorkspaceConfig(JSON.parse(process.argv[3]))))
  process.exit(0)
}

const temporary = await mkdtemp(join(tmpdir(), 'qxqy-git-install-'))
const source = join(temporary, 'source')
const dshCli = process.argv[2]
const dshHome = join(temporary, 'dsh-home')
const consumer = dshCli ? join(dshHome, 'profiles/web') : join(temporary, 'consumer')
const commandEnv = { ...process.env }
const commandBin = join(temporary, 'bin')
const pathKey = Object.keys(commandEnv).find(key => key.toLowerCase() === 'path') || 'PATH'
commandEnv[pathKey] = commandBin + delimiter + (commandEnv[pathKey] || '')
const run = (command, args, cwd, extra = {}) => execFileSync(command, args, {
  cwd, env: commandEnv, encoding: 'utf8', windowsHide: true, timeout: 300000, ...extra,
})
const runPnpm = (args, cwd, extra) => process.platform === 'win32'
  ? run(process.execPath, [join(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'), ...args], cwd, extra)
  : run('pnpm', args, cwd, extra)
async function sourceFiles() {
  let checkout = ''
  try { checkout = run('git', ['rev-parse', '--show-toplevel'], root, { stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch {}
  if (checkout && resolve(checkout).toLowerCase() === resolve(root).toLowerCase()) {
    return run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0').filter(Boolean)
  }
  // Local derivatives may have no Git metadata. Exclude dependencies, build
  // output, caches, and the named workspace directories; other folders remain eligible.
  const excluded = new Set(['node_modules', 'dist', 'release', 'look2-workspace', 'look3-workspace', '上游', 'archive', 'look-workspace', 'look2-image-cache', 'coverage', 'frontend'])
  const generated = new Set(['dsh-plugin/skill.md', 'dsh-plugin/presets', ...['editor.js', 'play-renderer.js', 'play.html', 'play.js', 'play.css', 'look2-fit-worker.js', 'look2-psd-worker.js'].map(name => `web/public/${name}`)])
  const files = []
  async function visit(path = '') {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const relative = path ? `${path}/${entry.name}` : entry.name
      if (excluded.has(entry.name) || generated.has(relative) || entry.name.startsWith('.') && entry.isDirectory()) continue
      if (entry.isDirectory()) await visit(relative)
      else if (entry.isFile() && !/\.(?:tgz|log)$/.test(entry.name) && !/^\.env(?:\.|$)/.test(entry.name)) files.push(relative)
    }
  }
  await visit()
  return files
}
try {
  await mkdir(commandBin)
  if (process.platform === 'win32') {
    const cli = join(dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js')
    await writeFile(join(commandBin, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`)
  }
  await mkdir(source)
  await mkdir(consumer, { recursive: true })
  const files = await sourceFiles()
  for (const file of files) {
    const from = join(root, file)
    const info = await stat(from).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (!info?.isFile()) continue // Deleted tracked files are absent in this snapshot.
    const to = join(source, file)
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
  assert.equal(await stat(join(source, 'dsh-plugin/dist')).catch(() => null), null, 'Git test must start without built assets')
  run('git', ['init', '-b', 'master'], source)
  run('git', ['-c', 'core.autocrlf=false', 'add', '.'], source)
  const hooks = join(temporary, 'empty-hooks')
  await mkdir(hooks)
  run('git', ['-c', 'user.name=Package smoke test', '-c', 'user.email=package-smoke@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, 'commit', '-qm', 'Source-only install fixture'], source)
  const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const dshToolsVersion = selectedDshToolsVersion(sourceManifest)
  console.log(`Selected DSH tools compatibility line ${dshToolsVersion}`)
  const commit = run('git', ['rev-parse', 'HEAD'], source).trim()
  const repositoryUrl = `git+${pathToFileURL(source).href}`

  const dshEnv = { ...commandEnv, DSH_HOME: dshHome }
  if (dshCli) {
    await assertCliDshToolsVersion(dshCli, dshToolsVersion)
    run(process.execPath, [dshCli, 'plugin', '--profile', 'web', 'list'], temporary, { env: dshEnv, stdio: 'inherit' })
  } else {
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager: 'pnpm@10.15.0' }))
  }
  const pnpmVersion = /^\d+\.\d+\.\d+/.exec(runPnpm(['--version'], consumer).trim())?.[0]
  assert.ok(pnpmVersion, `Could not determine pnpm version for ${join(consumer, 'package.json')}`)
  console.log(`Using pnpm ${pnpmVersion} for the isolated consumer`)
  await writeFile(join(consumer, 'pnpm-workspace.yaml'), renderWorkspaceConfig({
    pnpmVersion,
    packageName: sourceManifest.name,
    repositoryUrl,
    commit,
  }))
  const spec = `${repositoryUrl}#master`
  console.log(`Installing Git source in an isolated consumer: ${spec}`)
  if (dshCli) {
    run(process.execPath, [dshCli, 'plugin', '--profile', 'web', 'add', spec], temporary, { env: dshEnv, stdio: 'inherit' })
    const profile = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'))
    assert.ok(profile.dsh.profile.bundles.includes('look3-dsh-plugin'))
    const config = run(process.execPath, [dshCli, '--profile', 'web', '--dump-config'], temporary, { env: dshEnv })
    for (const entry of ['look3-simulator', 'look3-simulator-skill', 'look3-simulator-preset']) assert.ok(config.includes(entry), entry)
    console.log('PASS Harness plugin add and --dump-config in isolated DSH_HOME')
  } else {
    console.log(`Installing @deepseek-ai/dsh-tools ${dshToolsVersion} and @deepseek-ai/cordis 4.0.4`)
    runPnpm(['add', spec, `@deepseek-ai/dsh-tools@${dshToolsVersion}`, '@deepseek-ai/cordis@4.0.4'], consumer, { stdio: 'inherit' })
  }
  await copyFile(join(root, 'scripts/smoke-git-installed.mjs'), join(consumer, 'smoke.mjs'))
  run(process.execPath, ['smoke.mjs'], consumer, { stdio: 'inherit' })
  const lockfile = await readFile(join(consumer, 'pnpm-lock.yaml'), 'utf8')
  assert.ok(lockfile.includes('git+file:'), 'Expected a Git install, not a linked source directory')
  console.log('PASS source-only Git install: prepare build, bundle, client, Skill, presets, Worker and PNG')
} finally {
  await cleanGenerated(temporary, tmpdir())
}
