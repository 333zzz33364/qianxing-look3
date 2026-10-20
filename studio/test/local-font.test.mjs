import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readLocalFont, localFont, localFontStack, localFontSettings, saveLocalFontSettings, serveLocalFont } from '../host/local-font.js'
import { defaultFontPaths, fontConfigPath, normalizeFontConfig, readFontConfig, writeFontConfig } from '../host/font-config.js'
import { SimulatorController } from '../host/controller.js'
import { textWindowMetrics } from '../play/scroll.js'
import { renderScenePng } from '../host-png.js'
import { geometryFont } from './fixtures/geometry-font.mjs'
import { distributable } from '../../scripts/distribution-filter.mjs'

test('font config is isolated under the Look3 namespace and normalizes supported settings', () => {
  assert.equal(fontConfigPath({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'win32', 'C:\\Users\\test'),
    'C:\\Users\\test\\AppData\\Roaming\\千星look3\\font.json')
  assert.equal(fontConfigPath({ QXQY_FONT_CONFIG_PATH: 'C:\\temp\\font.json' }, 'win32'), 'C:\\temp\\font.json')
  const paths = defaultFontPaths('win32', { SystemDrive: 'D:', ProgramFiles: 'D:\\Programs' })
  assert.equal(paths.length, 4)
  assert.ok(paths.every(path => path.startsWith('D:\\')))
  assert.deepEqual(normalizeFontConfig({ mode: 'custom', path: ' "C:\\Fonts\\font.ttf" ', scope: 'game' }),
    { mode: 'custom', path: 'C:\\Fonts\\font.ttf', scope: 'game' })
  assert.deepEqual(normalizeFontConfig({ mode: 'system', path: 'ignored' }), { mode: 'system', path: '', scope: 'all' })
  assert.throws(() => normalizeFontConfig({ mode: 'custom', path: 'x'.repeat(4097) }), /过长/)
  assert.throws(() => normalizeFontConfig({ mode: 'system', scope: 'workspace' }), /应用范围/)
})

test('local font validates input, stays out of serializable state and drives PNG/measurement/Worker', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qxqy-font-'))
  const path = join(directory, 'private.ttf'), bytes = geometryFont()
  const previous = process.env.QXQY_FONT_PATH
  const previousConfig = process.env.QXQY_FONT_CONFIG_PATH
  const configPath = join(directory, 'font-config.json')
  t.after(() => {
    if (previous === undefined) delete process.env.QXQY_FONT_PATH; else process.env.QXQY_FONT_PATH = previous
    if (previousConfig === undefined) delete process.env.QXQY_FONT_CONFIG_PATH; else process.env.QXQY_FONT_CONFIG_PATH = previousConfig
    rmSync(directory, { recursive: true, force: true })
  })
  assert.equal(readLocalFont(''), null)
  assert.throws(() => readLocalFont('relative.ttf'), /absolute path/)
  assert.throws(() => readLocalFont(join(directory, 'missing.ttf')), error => !error.message.includes(directory) && /readable/.test(error.message))
  writeFileSync(path, Buffer.alloc(20))
  assert.throws(() => readLocalFont(path), /valid TTF or OTF/)
  writeFileSync(path, bytes)
  process.env.QXQY_FONT_PATH = path
  process.env.QXQY_FONT_CONFIG_PATH = configPath
  writeFileSync(configPath, '{ invalid json')
  const font = localFont()
  assert.deepEqual(font.data, bytes)
  const brokenSettings = localFontSettings()
  assert.equal(brokenSettings.environmentPath, path)
  assert.equal(brokenSettings.active.source, 'environment', 'QXQY_FONT_PATH takes priority over a broken saved config')
  assert.match(brokenSettings.error, /字体设置无法读取/)
  const recovered = saveLocalFontSettings({ scope: 'game' })
  assert.equal(readFontConfig(configPath).scope, 'game', 'saving through the settings API replaces a broken config')
  assert.equal(recovered.nextFont.source, 'environment')
  assert.equal(recovered.restartRequired, true)
  const ctx = createCanvas(80, 80).getContext('2d')
  ctx.font = `20px ${localFontStack()}`
  assert.ok(Math.abs(ctx.measureText('AB').width - 28) < 0.2, 'synthetic advances must be 20 + 8 px')
  const metrics = textWindowMetrics({ text: 'AABA', fontSize: 20, showScrollBar: false }, 34, 80)
  assert.deepEqual(metrics.lines, ['A', 'AB', 'A'])
  assert.ok(!JSON.stringify(metrics).includes(directory))

  const item = { id: 1, kind: 'textbox', text: 'A', fontSize: 20, fontColor: 0xffffffff, bgColor: 0,
    enableOutline: false, sourceWidth: 80, sourceHeight: 80, horizontalAlignment: 'Left', verticalAlignment: 'Top',
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 40, ty: 40 } }
  const png = renderScenePng({ format: 'tree-v1', reset: true, nodes: [item] }, 80, 80)
  ctx.drawImage(await loadImage(png.data), 0, 0)
  const pixels = ctx.getImageData(0, 0, 80, 80).data, xs = [], ys = []
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
    const i = (y * 80 + x) * 4
    if (pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) { xs.push(x); ys.push(y) }
  }
  assert.ok(xs.length > 100)
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) + 1 - 12) <= 1, 'PNG uses the 600-unit rectangle, not a system A glyph')
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) + 1 - 14) <= 1)

  // The worker must not read the replaced disk file or inherit a different font.
  writeFileSync(path, 'no longer a font')
  const controller = new SimulatorController(directory, { clockMode: 'manual' })
  try {
    for (const [key, value] of Object.entries({ text: 'AB', fontSize: 40, minimumFontSize: 10,
      adaptiveFontSize: true, width: 32, height: 34 })) controller.patch({ op: 'set', id: 'n2', key, value })
    const editor = controller.get().boxes.find(node => node.id === 'n2').textLayout
    assert.equal(editor.fontSize, 20, '28px available width fits the synthetic AB advances at 20px')
    assert.deepEqual(editor.lines, ['AB'])
    assert.equal(editor.requiredHeight, 33, '24px line box plus 9px textbox occupancy')
    await controller.play('start')
    const snapshot = await controller.play('get', { view: true })
    const node = snapshot.scene.nodes.find(node => node.text === 'AB')
    assert.deepEqual(node.textLayout, editor, 'the real play Worker must use the startup font bytes, not the replaced file')
  } finally {
    await controller.dispose()
  }

  const request = { url: '/qxqy-font/manifest', method: 'GET', headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '127.0.0.1' } }
  const call = async (overrides, options) => {
    const result = {}
    const handled = serveLocalFont({ ...request, ...overrides }, { writeHead(status, headers) { Object.assign(result, { status, headers }) }, end(body) { result.body = body } }, options)
    if (handled && typeof handled.then === 'function') await handled
    return result
  }
  // Real HTTP delivery/authentication is covered in web/test/local-font.test.mjs.
  // Keep only connection properties that an in-process HTTP client cannot fake.
  assert.equal((await call({ socket: { remoteAddress: '192.0.2.10' } })).status, 403)
  for (const headers of [{ host: 'evil.test' },
    { host: request.headers.host, 'x-forwarded-for': '127.0.0.1' }]) assert.equal((await call({ headers })).status, 403)
  const settings = await call({ url: '/qxqy-font/settings' })
  assert.equal(settings.status, 200)
  assert.equal(JSON.parse(settings.body).environmentPath, path)
  assert.equal((await call({ url: '/qxqy-font/settings' }, { settingsEnabled: false })).status, 403)
  assert.equal((await call({ url: '/qxqy-font/settings', headers: { ...request.headers, 'sec-fetch-site': 'cross-site' } })).status, 403)
})

test('distribution excludes font containers and the local-only directory', () => {
  for (const name of ['private.ttf', 'PRIVATE.OTF', 'font.woff', 'font.woff2', 'collection.ttc', '.local-fonts/private.bin']) {
    assert.equal(distributable(join('public', name)), false, name)
  }
  assert.equal(distributable(join('public', 'styles.css')), true)
  assert.equal(distributable(join('studio', 'play', 'browser-font.js')), true)
})
