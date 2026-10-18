import { mkdtemp, readFile, copyFile, writeFile, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { root, cleanGenerated } from './paths.mjs'
import { npm } from './npm.mjs'

const { artifacts } = JSON.parse(await readFile(join(root, 'release/manifest.json'), 'utf8'))
const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const supportedDshToolsVersions = new Set(['0.1.0-rc.6', '0.2.0-rc.2'])
const dshToolsVersion = process.env.LOOK2_DSH_TOOLS_VERSION || sourceManifest.devDependencies?.['@deepseek-ai/dsh-tools']
if (!supportedDshToolsVersions.has(dshToolsVersion)) {
  throw new Error(`LOOK2_DSH_TOOLS_VERSION must be 0.1.0-rc.6 or 0.2.0-rc.2; got ${JSON.stringify(dshToolsVersion)}`)
}
const destination = await mkdtemp(join(tmpdir(), 'qxqy-package-smoke-'))
try {
  const checkout = await realpath(root)
  const consumer = await realpath(destination)
  const checkoutRelative = relative(checkout, consumer)
  const outsideCheckout = checkoutRelative === '..' || checkoutRelative.startsWith(`..${sep}`) || isAbsolute(checkoutRelative)
  if (!outsideCheckout) {
    throw new Error(`Package consumer must be outside checkout: ${consumer}`)
  }
  await writeFile(join(destination, 'package.json'), JSON.stringify({ name: 'look2-package-consumer', private: true, type: 'module' }, null, 2) + '\n')
  const npmPrefix = await realpath(resolve(npm(['prefix'], { cwd: destination }).trim()))
  const normalized = path => process.platform === 'win32' ? path.toLowerCase() : path
  if (normalized(npmPrefix) !== normalized(consumer)) throw new Error(`Unexpected npm prefix: ${npmPrefix}; expected ${consumer}`)
  console.log(`Installing release packages in verified consumer: ${consumer}`)
  console.log(`Verified npm prefix: ${npmPrefix}`)
  console.log(`Using @deepseek-ai/dsh-tools ${dshToolsVersion} for the isolated compatibility check`)
  npm(['install', '--prefix', destination, '--cache', join(destination, '.npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
    ...artifacts.map(a => join(root, 'release', a.filename)),
    `@deepseek-ai/dsh-tools@${dshToolsVersion}`, '@deepseek-ai/cordis@4.0.4'], { cwd: destination, stdio: 'inherit', timeout: 180000 })
  await copyFile(join(root, 'scripts/smoke-installed.mjs'), join(destination, 'smoke.mjs'))
  const license = await readFile(join(root, 'LICENSE'), 'utf8')
  for (const artifact of artifacts) {
    const installed = join(destination, 'node_modules', artifact.name)
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    if (manifest.license !== 'GPL-3.0-only' || await readFile(join(installed, 'LICENSE'), 'utf8') !== license) {
      throw new Error(`Missing or inconsistent GPL license: ${artifact.name}`)
    }
  }
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: destination, stdio: 'inherit', windowsHide: true, timeout: 90000 })
} finally {
  await cleanGenerated(destination, tmpdir())
}
