import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('an aborted browser test closes its isolated browser and exits', {
  skip: !process.env.QXQY_BROWSER, timeout: 40_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qxqy-browser-lifecycle-'))
  const fixture = join(directory, 'timeout.test.mjs')
  const marker = join(directory, 'closed.txt')
  writeFileSync(fixture, `
import test from 'node:test';
import {writeFileSync} from 'node:fs';
import {startTestBrowser} from ${JSON.stringify(new URL('./browser-helper.mjs', import.meta.url).href)};
test('intentional browser timeout', {timeout: 12000}, async t => {
  const browser = await startTestBrowser(${JSON.stringify(directory)});
  t.after(async () => {
    await browser.close();
    await browser.close();
    writeFileSync(${JSON.stringify(marker)}, 'closed');
  });
  await browser.evaluate('document.title = "owned test browser"');
  await new Promise(() => {});
});
`)
  try {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--test', fixture], {
        env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => { stdout += data })
      child.stderr.on('data', data => { stderr += data })
      const timer = setTimeout(() => {
        const failure = new Error(`Timed-out fixture did not exit within 25000ms\n${stdout}\n${stderr}`)
        // Keep the fixture alive until tree termination so its owned browser
        // remains a descendant even if the helper's cleanup has regressed.
        if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 5_000 }, () => { child.kill(); reject(failure) })
        } else { child.kill(); reject(failure) }
      }, 25_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /testTimeoutFailure|timed out/)
    assert.ok(existsSync(marker), result.stdout + result.stderr)
    assert.equal(readFileSync(marker, 'utf8'), 'closed', 'timeout cleanup completed, including idempotent close')
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
