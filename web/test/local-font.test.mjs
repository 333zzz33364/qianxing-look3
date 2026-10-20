import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createWebServer } from '../server.js'
import { localFont } from '../../studio/host/local-font.js'
import { geometryFont } from '../../studio/test/fixtures/geometry-font.mjs'
import { fontFamily } from '../../studio/fonts.js'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { playSnapshot } from '../../studio/play/session.js'
import { startTestBrowser } from './browser-helper.mjs'

test('Web local font authentication, privacy, export boundary and real browser rendering', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qxqy-font-web-'))
  const path = join(directory, 'user-font.ttf'), configPath = join(directory, 'font-config.json'), bytes = geometryFont()
  await writeFile(path, bytes)
  const previous = process.env.QXQY_FONT_PATH
  const previousConfig = process.env.QXQY_FONT_CONFIG_PATH
  process.env.QXQY_FONT_PATH = path
  process.env.QXQY_FONT_CONFIG_PATH = configPath
  let app, browser
  t.after(async () => {
    await browser?.close(); await app?.close()
    if (previous === undefined) delete process.env.QXQY_FONT_PATH; else process.env.QXQY_FONT_PATH = previous
    if (previousConfig === undefined) delete process.env.QXQY_FONT_CONFIG_PATH; else process.env.QXQY_FONT_CONFIG_PATH = previousConfig
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const recoveryConfigPath = join(directory, 'invalid-path-recovery.json')
  const originalConfig = { mode: 'system', path: '', scope: 'game' }
  await writeFile(recoveryConfigPath, JSON.stringify(originalConfig))
  const childEnv = { ...process.env, QXQY_FONT_CONFIG_PATH: recoveryConfigPath }
  delete childEnv.QXQY_FONT_PATH
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
  const localFontModule = new URL('../../studio/host/local-font.js', import.meta.url).href
  const recoveryChild = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs'
    const { saveLocalFontSettings } = await import(${JSON.stringify(localFontModule)})
    let rejected = false
    try { saveLocalFontSettings({ mode: 'custom', path: ${JSON.stringify(join(directory, 'missing.ttf'))}, scope: 'all' }) }
    catch { rejected = true }
    const saved = JSON.parse(readFileSync(process.env.QXQY_FONT_CONFIG_PATH, 'utf8'))
    if (!rejected || JSON.stringify(saved) !== ${JSON.stringify(JSON.stringify(originalConfig))}) process.exitCode = 1
    console.log(JSON.stringify({ rejected, saved }))
  `], { cwd: projectRoot, env: childEnv, encoding: 'utf8', timeout: 15_000 })
  assert.equal(recoveryChild.status, 0, recoveryChild.stderr || recoveryChild.stdout)
  assert.deepEqual(JSON.parse(recoveryChild.stdout.trim()).saved, originalConfig, 'invalid custom paths leave the previous isolated config intact')
  await assert.rejects(createWebServer({ workspace: directory, host: '0.0.0.0', port: 0, password: 'test' }), /loopback-only/)
  app = await createWebServer({ workspace: directory, port: 0, password: 'test' })
  const auth = { authorization: `Basic ${Buffer.from('simulator:test').toString('base64')}` }
  const manifestUrl = app.url + '/qxqy-font/manifest'
  assert.equal((await fetch(manifestUrl)).status, 401)
  const manifest = await fetch(manifestUrl, { headers: auth })
  const { id } = await manifest.json()
  assert.equal(id, localFont().id)
  const settingsUrl = app.url + '/qxqy-font/settings'
  const settingsResponse = await fetch(settingsUrl, { headers: auth })
  assert.equal(settingsResponse.status, 200)
  const initialSettings = await settingsResponse.json()
  assert.equal(initialSettings.environmentPath, path)
  assert.equal((await fetch(settingsUrl, { headers: { ...auth, 'x-forwarded-for': '127.0.0.1' } })).status, 403)
  assert.equal((await fetch(settingsUrl, { headers: { ...auth, 'sec-fetch-site': 'cross-site' } })).status, 403)
  const saveResponse = await fetch(settingsUrl, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'game' }) })
  assert.equal(saveResponse.status, 200, await saveResponse.clone().text())
  const savedSettings = await saveResponse.json()
  assert.equal(savedSettings.scope, 'game')
  assert.equal(savedSettings.active.scope, 'all', 'the running host keeps its startup scope until restart')
  assert.equal(savedSettings.restartRequired, true)
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { mode: 'auto', path: '', scope: 'game' }, 'settings use only the test-owned QXQY_FONT_CONFIG_PATH')
  const response = await fetch(`${app.url}/qxqy-font/file/${id}`, { headers: auth })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal((await fetch(manifestUrl, { headers: { ...auth, origin: 'https://example.invalid' } })).status, 403)
  assert.equal((await fetch(`${app.url}/qxqy-font/file/not-a-font`, { headers: auth })).status, 404)
  const state = await (await fetch(app.url + '/api/state', { headers: auth })).text()
  assert.ok(!state.includes('user-font.ttf') && !state.includes(id), 'project observations never expose font configuration')
  await app.close()
  app = await createWebServer({ workspace: directory, port: 0 })

  await t.test('browser uses the loaded font in editor text and incremental fitted Pixi scenes', {
    skip: !process.env.QXQY_BROWSER, timeout: 60_000,
  }, async () => {
    browser = await startTestBrowser(directory)
    const { evaluate, wait } = browser
    await browser.navigate(app.url + '/editor')
    await wait(`!!document.querySelector('.look2-top')`)
    await wait(`document.querySelector('.look2-stage-text')?.style.fontFamily.includes('QxqyLocal_')`)
    const stateBefore = (await (await fetch(app.url + '/api/state')).json()).value
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '字体设置')?.click()`)
    await wait(`!!document.querySelector('[role="dialog"][aria-label="字体设置"]')`)
    assert.equal(await evaluate(`document.querySelector('[role="dialog"][aria-label="字体设置"] select[aria-label="应用范围"]').value`), 'game')
    assert.equal(await evaluate(`document.querySelector('[role="dialog"][aria-label="字体设置"] input[aria-label="字体文件路径"]').disabled`), true,
      'QXQY_FONT_PATH locks the selected file while leaving scope configurable')
    await evaluate(`(()=>{const select=document.querySelector('[role="dialog"][aria-label="字体设置"] select[aria-label="应用范围"]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await evaluate(`document.querySelector('[role="dialog"][aria-label="字体设置"] button[type="submit"]').click()`)
    await wait(`document.querySelector('[role="dialog"][aria-label="字体设置"]')?.innerText.includes('已保存')`)
    assert.ok(await evaluate(`document.querySelector('[role="dialog"][aria-label="字体设置"]')?.innerText.includes('重启')`),
      'saving reports that the host must restart before the scope takes effect')
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { mode: 'auto', path: '', scope: 'all' }, 'browser UI persisted the overall-UI scope in the test config')
    await browser.send('Page.reload', {}, browser.sessionId)
    await wait(`!!document.querySelector('button[aria-label="字体设置"]')`)
    await evaluate(`[...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '字体设置')?.click()`)
    await wait(`document.querySelector('[role="dialog"][aria-label="字体设置"]')?.innerText.includes('已有设置需要应用')`)
    assert.equal(await evaluate(`document.querySelector('[role="dialog"][aria-label="字体设置"] select[aria-label="应用范围"]').value`), 'all',
      'reopening after refresh reads the persisted overall-UI scope and restart notice')
    const stateAfter = (await (await fetch(app.url + '/api/state')).json()).value
    assert.equal(stateAfter.revision, stateBefore.revision, 'font UI did not change the project revision')
    assert.equal(stateAfter.activePath, stateBefore.activePath)
    assert.deepEqual(stateAfter.snapshot, stateBefore.snapshot, 'font UI did not change the saved project snapshot')
    assert.deepEqual(stateAfter.archives, stateBefore.archives, 'font UI did not write or alter archives')
    await evaluate(`document.querySelector('[role="dialog"][aria-label="字体设置"] button')?.click()`)
    const family = fontFamily(id)
    assert.ok((await evaluate(`getComputedStyle(document.querySelector('.look2-stage-text span')).fontFamily`)).includes(family),
      'the actual text span must not override the loaded font')
    const runtime = createRuntime({ canvasWidth: 240, canvasHeight: 160 })
    t.after(() => runtime.destroy())
    const label = runtime.addRoot({ kind: 'textbox', active: true, visible: true, text: 'A\nB', fontSize: 40,
      minimumFontSize: 10, adaptiveFontSize: true, sizeDeltaX: 160, sizeDeltaY: 40,
      fontColor: 0xffffffff, bgColor: 0, enableOutline: false, horizontalAlignment: 'Left', verticalAlignment: 'Top' })
    const session = { runtime, compiled: { canvasId: 'pc-16-9', platform: 'PC' }, history: [] }
    await evaluate(`(async()=>{
      const {PixiPlayRenderer,loadBrowserFont}=await import('/play-renderer.js');
      const cv=document.createElement('canvas');document.body.append(cv);
      window.fontRenderer=new PixiPlayRenderer(cv,{fontReady:loadBrowserFont()});
      await fontRenderer.ready;
    })()`)
    let revision
    for (const [adaptive, minimum, expected] of [[true, 10, 13], [false, 10, 40], [true, 24, 24]]) {
      label.adaptiveFontSize = adaptive
      label.minimumFontSize = minimum
      label.markPlayDirty()
      const scene = playSnapshot(session, { view: true, sceneRev: revision }).scene
      const metrics = await evaluate(`(async()=>{
        await fontRenderer.applyScene(${JSON.stringify(scene)},240,160);
        const text=fontRenderer.nodes.get(${label.Id}).__visual.children.find(child=>typeof child.text==='string');
        const ctx=document.createElement('canvas').getContext('2d');ctx.font='20px '+text.style.fontFamily;
        const cv=fontRenderer.app.renderer.extract.canvas({target:fontRenderer.app.stage,resolution:1});
        const data=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
        let white=0;for(let i=0;i<data.length;i+=4)if(data[i+3]>100&&data[i]>240&&data[i+1]>240&&data[i+2]>240)white++;
        return {family:text.style.fontFamily,width:ctx.measureText('AB').width,white,font:text.style.fontSize,wrap:text.style.wordWrap};
      })()`)
      assert.ok(metrics.family.includes(family))
      assert.ok(Math.abs(metrics.width - 28) < 0.2, JSON.stringify(metrics))
      assert.equal(metrics.font, expected)
      assert.equal(metrics.wrap, false, 'Pixi must consume the host line breaks without wrapping a second time')
      // The synthetic A alone covers 0.6 * 0.7 * size²; allow edge
      // antialiasing while scaling the lower bound with the fitted size.
      assert.ok(metrics.white > expected * expected * 0.25, JSON.stringify(metrics))
      revision = scene.revision
    }
    await evaluate('fontRenderer.destroy()')
  })
})
