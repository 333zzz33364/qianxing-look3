import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateChecker, releaseForPackage } from '../host/updates.js'

const release = (version, packageName = 'look3-web') => ({
  draft: false, prerelease: false, html_url: `https://github.com/1475505/miliastra-beyond-simulator/releases/tag/v${version}`,
  assets: [{ name: `${packageName}-${version}.tgz`, browser_download_url: `https://github.com/1475505/miliastra-beyond-simulator/releases/download/v${version}/${packageName}-${version}.tgz` }],
})

test('release metadata filters unsafe and prerelease assets and picks highest stable version', () => {
  const result = releaseForPackage([release('3.1.0'), release('3.2.0'), { ...release('9.0.0'), prerelease: true }, { ...release('4.0.0'), html_url: 'https://evil.example/releases/tag/v4.0.0' }], 'look3-web')
  assert.equal(result.version, '3.2.0')
})

test('update checker caches metadata and reports current or available status', async () => {
  let calls = 0; let clock = 0
  const check = createUpdateChecker({ packageName: 'look3-web', currentVersion: '3.3.0', now: () => clock, fetch: async () => { calls++; return { ok: true, json: async () => [release('3.4.0')] } } })
  assert.equal((await check()).status, 'available')
  assert.equal((await check()).status, 'available')
  assert.equal(calls, 1)
  clock = 5 * 60_000 + 1
  assert.equal((await check()).status, 'available')
  assert.equal(calls, 2)
})
