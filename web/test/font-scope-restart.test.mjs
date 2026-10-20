import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { geometryFont } from '../../studio/test/fixtures/geometry-font.mjs'
import { fontFamily } from '../../studio/fonts.js'
import { startTestBrowser } from './browser-helper.mjs'

const ipcPrefix = '__QXQY_FONT_TEST__'

function startFreshHost({ workspace, configPath }) {
  const serverModule = new URL('../server.js', import.meta.url).href
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
  const childEnv = { ...process.env, QXQY_FONT_CONFIG_PATH: configPath }
  delete childEnv.QXQY_FONT_PATH
  delete childEnv.QXQY_WEB_PASSWORD
  const source = `
    import { createInterface } from 'node:readline'
    try {
      const { createWebServer } = await import(${JSON.stringify(serverModule)})
      const app = await createWebServer({ workspace: ${JSON.stringify(workspace)}, host: '127.0.0.1', port: 0 })
      const send = value => process.stdout.write(${JSON.stringify(ipcPrefix)} + JSON.stringify(value) + '\\n')
      send({ type: 'ready', url: app.url })
      const input = createInterface({ input: process.stdin })
      input.on('line', line => {
        if (line !== 'close') return
        input.close()
        app.close().then(() => {
          process.stdout.write(${JSON.stringify(ipcPrefix)} + JSON.stringify({ type: 'closed' }) + '\\n', () => process.exit(0))
        }, error => { console.error(error); process.exit(1) })
      })
    } catch (error) { console.error(error); process.exit(1) }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const messages = []
  const waiters = []
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.setEncoding('utf8')
  let output = ''
  child.stdout.on('data', chunk => {
    output += chunk
    for (;;) {
      const newline = output.indexOf('\n')
      if (newline < 0) break
      const line = output.slice(0, newline).trimEnd()
      output = output.slice(newline + 1)
      if (!line.startsWith(ipcPrefix)) continue
      let message
      try { message = JSON.parse(line.slice(ipcPrefix.length)) } catch { continue }
      const index = waiters.findIndex(waiter => waiter.type === message.type)
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
      else messages.push(message)
    }
  })
  let exitResult
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    exitResult = { code, signal }
    resolve(exitResult)
  }))
  child.once('close', (code, signal) => {
    const error = new Error(`font host exited before IPC completed (code=${code}, signal=${signal})${stderr ? `\n${stderr}` : ''}`)
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  })

  function waitFor(type, timeoutMs = 20_000) {
    const index = messages.findIndex(message => message.type === type)
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
    if (exitResult) return Promise.reject(new Error(`font host already exited (code=${exitResult.code}, signal=${exitResult.signal})${stderr ? `\n${stderr}` : ''}`))
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: null, reject: null }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`font host IPC timeout waiting for ${type}${stderr ? `\n${stderr}` : ''}`))
      }, timeoutMs)
      waiter.resolve = value => { clearTimeout(timer); resolve(value) }
      waiter.reject = error => { clearTimeout(timer); reject(error) }
      waiters.push(waiter)
    })
  }

  let closePromise
  return {
    child,
    waitFor,
    async ready() { return waitFor('ready') },
    close() {
      closePromise ||= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            const closed = waitFor('closed', 10_000)
            child.stdin.write('close\n')
            await closed
          } catch {
            child.kill()
          }
        }
        const result = await Promise.race([exited, delay(10_000).then(() => null)])
        if (!result) {
          child.kill()
          const finalResult = await Promise.race([exited, delay(3_000).then(() => null)])
          if (!finalResult) throw new Error('font host child did not exit after close/kill')
          if (finalResult.code !== 0) throw new Error(`font host child exited with ${finalResult.code}: ${stderr}`)
          return
        }
        if (result.code !== 0) throw new Error(`font host child exited with ${result.code}: ${stderr}`)
      })()
      return closePromise
    },
  }
}

test('persisted custom font scope applies after each fresh Web host starts', {
  skip: !process.env.QXQY_BROWSER,
  timeout: 120_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qxqy-font-scope-restart-'))
  const browsers = []
  const hosts = []
  // Register cleanup before writing fixtures or launching either child process.
  t.after(async () => {
    for (const browser of browsers.splice(0).reverse()) await browser.close().catch(() => {})
    for (const host of hosts.splice(0).reverse()) await host.close().catch(() => {})
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  const bytes = geometryFont()
  const expectedId = createHash('sha256').update(bytes).digest('hex')
  const expectedFamily = fontFamily(expectedId)
  const scopes = ['game', 'all']

  for (const scope of scopes) {
    const scopeDirectory = join(directory, scope)
    const workspace = join(scopeDirectory, 'workspace')
    const fontPath = join(scopeDirectory, 'geometry-font.ttf')
    const configPath = join(scopeDirectory, 'font.json')
    await mkdir(workspace, { recursive: true })
    await writeFile(fontPath, bytes)
    await writeFile(configPath, JSON.stringify({ mode: 'custom', path: fontPath, scope }, null, 2) + '\n')

    const host = startFreshHost({ workspace, configPath })
    hosts.push(host)
    let browser
    try {
      const { url } = await host.ready()
      const manifestResponse = await fetch(`${url}/qxqy-font/manifest`)
      assert.equal(manifestResponse.status, 200)
      assert.deepEqual(await manifestResponse.json(), { id: expectedId, scope },
        `fresh host must load the persisted custom font and ${scope} scope`)

      browser = await startTestBrowser(join(scopeDirectory, 'edge-profile'))
      browsers.push(browser)
      await browser.navigate(`${url}/editor`)
      await browser.wait(`!!document.querySelector('button[aria-label="字体设置"]')`)
      await browser.wait(`document.fonts.check('16px "${expectedFamily}"')`)
      await browser.wait(`document.querySelector('.look2-stage-text span') && getComputedStyle(document.querySelector('.look2-stage-text span')).fontFamily.includes('${expectedFamily}')`)
      await browser.wait(scope === 'all'
        ? `!!document.querySelector('#qxqy-local-font-style')`
        : `!document.querySelector('#qxqy-local-font-style')`)

      const ui = await browser.evaluate(`(() => {
        const root = document.querySelector('[data-qxqy-font-ui]')
        const button = document.querySelector('button[aria-label="字体设置"]')
        return {
          stylePresent: !!document.querySelector('#qxqy-local-font-style'),
          rootPresent: !!root,
          buttonFont: getComputedStyle(button).fontFamily,
          stageFont: getComputedStyle(document.querySelector('.look2-stage-text span')).fontFamily,
          fontLoaded: document.fonts.check('16px "${expectedFamily}"'),
        }
      })()`)
      assert.equal(ui.rootPresent, true, 'Look2 root is the scoped UI font boundary')
      assert.equal(ui.stylePresent, scope === 'all')
      assert.equal(ui.fontLoaded, true)
      assert.ok(ui.stageFont.includes(expectedFamily), JSON.stringify(ui))
      assert.equal(ui.buttonFont.includes(expectedFamily), scope === 'all',
        `persisted ${scope} scope must ${scope === 'all' ? '' : 'not '}override the Look2 button font: ${JSON.stringify(ui)}`)

      const pixiFamily = await browser.evaluate(`(async()=>{
        const { PixiPlayRenderer, loadBrowserFont } = await import('/play-renderer.js')
        const canvas = document.createElement('canvas'); document.body.append(canvas)
        const renderer = window.scopeFontRenderer = new PixiPlayRenderer(canvas, { fontReady: loadBrowserFont() })
        await renderer.ready
        await renderer.applyScene({ format: 'tree-v1', reset: true, nodes: [{
          id: 1, parent: null, z: 0, kind: 'textbox', text: 'A', fontSize: 24,
          fontColor: 0xffffffff, bgColor: 0, enableOutline: false,
          sourceWidth: 120, sourceHeight: 48,
          horizontalAlignment: 'Left', verticalAlignment: 'Top',
          matrix: { a: 1, b: 0, c: 0, d: 1, tx: 24, ty: 24 }
        }] }, 160, 96)
        return renderer.nodes.get(1).__visual.__text.style.fontFamily
      })()`)
      assert.ok(pixiFamily.includes(expectedFamily),
        `Pixi canvas text must use the persisted custom font for ${scope}: ${pixiFamily}`)
      await browser.evaluate(`scopeFontRenderer.destroy()`)
    } finally {
      if (browser) {
        await browser.close()
        const index = browsers.indexOf(browser)
        if (index >= 0) browsers.splice(index, 1)
      }
      await host.close()
      const index = hosts.indexOf(host)
      if (index >= 0) hosts.splice(index, 1)
    }
  }
})
