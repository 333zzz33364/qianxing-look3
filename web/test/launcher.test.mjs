import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
function json(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    })
    request.on('error', reject)
    request.setTimeout(1500, () => request.destroy(new Error('HTTP timeout')))
  })
}

async function freePort() {
  for (;;) {
    // Reserve a whole range away from the next ephemeral client sockets. A
    // port-0 allocation can otherwise put HTTP probe sockets in our next slots.
    const port = 20000 + Math.floor(Math.random() * 24000), servers = []
    let available = true
    for (let offset = 0; offset < 20; offset++) {
      const server = createServer()
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port + offset, '127.0.0.1', resolve) })
        servers.push(server)
      } catch { available = false; break }
    }
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    if (available) return port
  }
}

async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'look2-launch-'))
  const root = join(parent, '中文 路径')
  mkdirSync(join(root, 'web/dist'), { recursive: true })
  const workspace = join(root, '工作区')
  mkdirSync(workspace)
  const script = join(root, 'look2-launch.ps1')
  const entry = join(root, 'web/dist/server.js')
  copyFileSync(new URL('../../look2-launch.ps1', import.meta.url), script)
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  // This fixture exercises PowerShell process/port/workspace decisions. The real
  // Web health fingerprint is independently checked below and in access.test.
  writeFileSync(entry, `import {createServer} from 'node:http';
import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const arg=n=>process.argv[process.argv.indexOf(n)+1];
const buildId=process.argv.includes('--legacy')?undefined:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const server=createServer((req,res)=>{
 res.setHeader('content-type','application/json; charset=utf-8');
 const password=process.env.QXQY_WEB_PASSWORD;
 if(req.url!=='/health' && password && req.headers.authorization!=='Basic '+Buffer.from('simulator:'+password).toString('base64')){res.statusCode=401;res.end('{}');return;}
 if(req.url==='/fixture-stop'){res.end('{}',()=>process.exit(0));return;}
 res.end(JSON.stringify(req.url==='/health'?{status:'ok',buildId,fixtureRoot:process.argv[1]}:{ok:true,value:{workspace:arg('--workspace'),pid:process.pid}}));
});server.listen(Number(arg('--port')),'127.0.0.1');`)
  const urls = new Set(), children = []
  let probeHeaders = {}
  t.after(async () => {
    for (let candidate = port; candidate < port + 20; candidate++) urls.add(`http://127.0.0.1:${candidate}`)
    await Promise.allSettled([...urls].map(async url => {
      const health = await json(url + '/health')
      if (health.fixtureRoot === entry) await json(url + '/fixture-stop', probeHeaders)
    }))
    for (const child of children) if (child.exitCode === null) child.kill()
    // Wait for our fixture processes to release their files before removal.
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.ok(parent.startsWith(join(tmpdir(), 'look2-launch-')))
    rmSync(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const port = await freePort()
  async function wait(url) {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { return await json(url + '/health') } catch {}
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Fixture did not start')
  }
  async function start(otherWorkspace = workspace, legacy = false) {
    const child = spawn(process.execPath, [entry, '--workspace', otherWorkspace, '--port', String(port), ...(legacy ? ['--legacy'] : [])], { windowsHide: true, stdio: 'ignore' })
    children.push(child)
    const url = `http://127.0.0.1:${port}`
    urls.add(url); await wait(url)
    return url
  }
  async function launch(password = '') {
    probeHeaders = password ? { authorization: 'Basic ' + Buffer.from('simulator:' + password).toString('base64') } : {}
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(port), '-WorkspacePath', workspace, '-NoOpen'], { windowsHide: true, timeout: 45000, env: { ...process.env, QXQY_WEB_PASSWORD: password } })
    const match = stdout.match(/LOOK2_URL=(http:\/\/127\.0\.0\.1:\d+)\/editor/)
    assert.ok(match, stdout)
    const url = match[1]
    urls.add(url)
    return { url, state: (await json(url + '/api/state', probeHeaders)).value, health: await json(url + '/health') }
  }
  return { root, workspace, entry, port, start, launch }
}

test('Windows launcher starts the current build and reuses it on the next launch', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const f = await fixture(t)
  const first = await f.launch(), second = await f.launch()
  assert.equal(first.health.buildId, sha(f.entry))
  assert.equal(second.url, first.url)
  assert.equal(second.state.pid, first.state.pid)
  assert.equal(second.state.workspace, f.workspace)
})

test('Windows launcher preserves legacy and previous-build processes while selecting the latest backend', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const f = await fixture(t), legacy = await f.start(f.workspace, true)
  const oldPid = (await json(legacy + '/api/state')).value.pid
  const first = await f.launch()
  assert.notEqual(first.url, legacy)
  assert.equal((await json(legacy + '/api/state')).value.pid, oldPid)
  const firstBuild = first.health.buildId
  appendFileSync(f.entry, '\n// Rebuilt backend\n')
  assert.notEqual(sha(f.entry), firstBuild)
  const next = await f.launch(), repeated = await f.launch()
  assert.notEqual(next.url, first.url)
  assert.equal(next.health.buildId, sha(f.entry))
  assert.equal((await json(first.url + '/health')).buildId, firstBuild)
  assert.equal((await json(legacy + '/api/state')).value.pid, oldPid)
  assert.equal(repeated.url, next.url)
  assert.equal(repeated.state.pid, next.state.pid)
})

test('Windows launcher does not reuse a matching build serving another workspace', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const f = await fixture(t), other = join(f.root, '其他工作区')
  mkdirSync(other)
  const original = await f.start(other), launched = await f.launch()
  assert.notEqual(launched.url, original)
  assert.equal(launched.state.workspace, f.workspace)
  assert.equal((await json(original + '/api/state')).value.workspace, other)
})

test('Windows launcher authenticates workspace probes when a Web password is configured', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const f = await fixture(t)
  const first = await f.launch('launcher-test-password'), second = await f.launch('launcher-test-password')
  assert.equal(first.health.buildId, sha(f.entry))
  assert.equal(second.state.pid, first.state.pid)
  assert.equal(second.url, first.url)
})

test('Windows launcher does not reuse an unprotected instance after a password is configured', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const f = await fixture(t), unprotected = await f.launch()
  const protectedInstance = await f.launch('launcher-test-password')
  assert.notEqual(protectedInstance.url, unprotected.url)
  assert.equal((await json(unprotected.url + '/api/state')).value.pid, unprotected.state.pid)
  const again = await f.launch('launcher-test-password')
  assert.equal(again.url, protectedInstance.url)
  assert.equal(again.state.pid, protectedInstance.state.pid)
})

test('real Web health keeps the loaded backend hash after its entry is replaced on disk', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'look2-build-health-'))
  const entry = join(directory, 'server.mjs')
  let source = readFileSync(new URL('../server.js', import.meta.url), 'utf8')
  for (const specifier of ['./lib/session.js', './lib/editor-sessions.js', '../studio/host/image-source.js']) {
    source = source.replace(`'${specifier}'`, JSON.stringify(new URL(specifier, new URL('../server.js', import.meta.url)).href))
  }
  writeFileSync(entry, source)
  const loadedHash = sha(entry)
  const { createWebServer } = await import(pathToFileURL(entry).href)
  const app = await createWebServer({ workspace: directory, port: 0 })
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.equal((await json(app.url + '/health')).buildId, loadedHash)
  appendFileSync(entry, '\n// Replaced while process remains live\n')
  assert.notEqual(sha(entry), loadedHash)
  assert.equal((await json(app.url + '/health')).buildId, loadedHash)
})
