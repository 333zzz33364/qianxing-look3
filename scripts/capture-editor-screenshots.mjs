// Capture Look3 editor screenshots for a fixed archive so pixel diffs stay comparable.
// The 2026-10-19 UI comparison fixture is look3-workspace/整合/20261019-收口/界面对照/同工程合成样本.save.json.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWebServer } from '../web/server.js'
import { startTestBrowser } from '../web/test/browser-helper.mjs'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    options[key.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const fixture = options.fixture ? resolve(options.fixture) : null
const output = options.out ? resolve(options.out) : null
const browserPath = options.browser || process.env.QXQY_BROWSER
if (!fixture || !output) {
  console.log('Usage: node scripts/capture-editor-screenshots.mjs --fixture <archive.json> --out <dir> [--sizes 1280x720,1920x1080] [--browser <edge path>] [--label look3]')
  process.exitCode = 2
} else if (!browserPath) {
  console.error('Set QXQY_BROWSER or pass --browser to an Edge executable')
  process.exitCode = 2
} else {
  process.env.QXQY_BROWSER = browserPath
  const sizes = String(options.sizes || '1280x720,1920x1080').split(',').map(text => text.trim())
  const label = options.label || 'look3'
  const archive = readFileSync(fixture)
  const work = mkdtempSync(join(tmpdir(), 'look3-capture-'))
  const workspace = join(work, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'comparison.save.json'), archive)
  mkdirSync(output, { recursive: true })
  const app = await createWebServer({ workspace, initialPath: 'comparison.save.json', port: 0, assetCacheDirectory: join(work, 'asset-cache') })
  let browser
  try {
    browser = await startTestBrowser(join(work, 'browser'))
    await browser.navigate(`${app.url}/editor`)
    await browser.wait(`!!document.querySelector('.look2-main') && !!document.querySelector('.look2-stage')`)
    await browser.wait(`document.querySelector('.look2-tree-row.sel .tree-name')?.textContent.includes('文本框')`)
    const captured = []
    for (const size of sizes) {
      const [width, height] = size.split('x').map(Number)
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
      await browser.wait(`innerWidth === ${width} && document.querySelector('.look2').clientWidth === ${width}`)
      await browser.wait('document.fonts.ready.then(() => true)')
      await browser.wait(`(()=>{const s=document.querySelector('.look2-stage')?.getBoundingClientRect(),w=document.querySelector('.look2-stage-wrap')?.getBoundingClientRect();return !!s&&!!w&&s.width>w.width*0.5&&Math.abs(s.width/s.height-16/9)<0.01})()`)
      const metrics = await browser.evaluate(`(() => {
        const box = selector => {
          const el = document.querySelector(selector); if (!el) return null;
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return { x:+r.x.toFixed(2), y:+r.y.toFixed(2), width:+r.width.toFixed(2), height:+r.height.toFixed(2), background:s.backgroundColor, color:s.color, fontFamily:s.fontFamily, fontSize:s.fontSize };
        };
        return {
          viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}, document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
          selectedTreeText:document.querySelector('.look2-tree-row.sel .tree-name')?.textContent.trim(),
          animationName:document.querySelector('.look2-anim-row button.sel')?.textContent.trim() || document.querySelector('.look2-sequence-name')?.textContent.trim(),
          regions:{tree:box('.look2-main > .look2-pane:first-child'),canvas:box('.look2-stage-column'),animation:box('.look2-main > .look2-animations'),inspector:box('.look2-main > .look2-inspector-pane'),timeline:box('.look2-dock')},
          style:{toolbar:box('.look2-top'),paneHeading:box('.look2-pane-head'),selectedTree:box('.look2-tree-row.sel'),selectedAnimation:box('.look2-anim-row .sel'),stage:box('.look2-stage'),timeline:box('.look2-dock')},
          text:{toolbar:document.querySelector('.look2-top')?.innerText, treeHeading:document.querySelector('.look2-main > .look2-pane:first-child .look2-pane-head')?.innerText, inspectorHeading:document.querySelector('.look2-inspector-pane .look2-pane-head')?.innerText},
          horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
        };
      })()`)
      const image = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, browser.sessionId)
      const filename = `${label}-${width}x${height}.png`
      writeFileSync(join(output, filename), Buffer.from(image.data, 'base64'))
      captured.push({ filename, pngSize: { width, height }, metrics })
    }
    const report = {
      source: {
        fixture, label, browser: browserPath,
        capturedAt: new Date().toISOString(),
        note: 'Look3-only capture for regression and archived-comparison diffs; the original Look2 checkout no longer exists.',
      },
      [label]: captured,
    }
    writeFileSync(join(output, `${label}-量测.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify(captured.map(item => ({ filename: item.filename, regions: Object.keys(item.metrics.regions) })), null, 2))
  } finally {
    await browser?.close().catch(() => {})
    await app?.close().catch(() => {})
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
