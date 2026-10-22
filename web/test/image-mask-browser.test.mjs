import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { browserPlugins } from '../../scripts/build.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { startTestBrowser } from './browser-helper.mjs'
import { maskScenes, maskSamples, maskAlphas } from '../../studio/test/fixtures/image-mask.mjs'
import { renderScenePng, flattenScenePaint } from '../../studio/host-png.js'

test('GPU and PNG agree on grouped masks, flat fallback, empty masks and viewport updates', { skip: !process.env.QXQY_BROWSER, timeout: 90_000 }, async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), sourcefile: 'mask-test.js', contents: `
import { PixiPlayRenderer } from './studio/play/pixi-renderer.js';
import { Rectangle } from 'pixi.js';
const renderer = new PixiPlayRenderer(document.querySelector('canvas'));
window.sampleAt = async (scene, points, flat = false) => {
  if (flat) await renderer.render(scene, 240, 160); else await renderer.applyScene(scene, 240, 160);
  const out = renderer.app.renderer.extract.pixels({target: renderer.app.stage, frame: new Rectangle(0,0,240,160)});
  return points.map(([x,y]) => Array.from(out.pixels.slice((y*out.width+x)*4,(y*out.width+x)*4+4)));
};
window.sample = (scene, flat = false) => window.sampleAt(scene, ${JSON.stringify(maskSamples)}, flat);
renderer.ready.then(() => window.ready = true);
` }, bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent', plugins: browserPlugins,
    // The virtual entry resolves './studio/...' from the repo root, but bare
    // 'pixi.js' is a studio dependency that pnpm keeps out of the root store,
    // so esbuild needs studio's node_modules on its lookup path explicitly.
    nodePaths: [fileURLToPath(new URL('../../studio/node_modules', import.meta.url))] })
  const app = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<!doctype html><canvas></canvas><script type="module" src="/bundle.js"></script>')
  })
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const directory = mkdtempSync(join(tmpdir(), 'qxqy-mask-'))
  let browser
  t.after(async () => {
    try { await browser?.close() }
    finally {
      app.closeAllConnections()
      try { await new Promise((resolve, reject) => app.close(error => error ? reject(error) : resolve())) }
      finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    }
  })
  t.diagnostic('mask phase: browser startup')
  browser = await startTestBrowser(directory)
  await browser.navigate(`http://127.0.0.1:${app.address().port}`)
  await browser.wait('window.ready')
  t.diagnostic('mask phase: renderer ready')
  const check = async (scene, alpha, flat = false) => {
    const gpu = await browser.evaluate(`window.sample(${JSON.stringify(flat ? flattenScenePaint(scene) : scene)},${flat})`)
    const ctx = createCanvas(240, 160).getContext('2d')
    ctx.drawImage(await loadImage(renderScenePng(scene, 240, 160, { background: 'transparent' }).data), 0, 0)
    maskSamples.forEach(([x, y], i) => {
      const png = [...ctx.getImageData(x, y, 1, 1).data]
      const expected = [png[0] * png[3] / 255, png[1] * png[3] / 255, png[2] * png[3] / 255, png[3]]
      assert.ok(Math.abs(png[3] - alpha[i]) <= 1, `independent expected alpha at ${x},${y}`)
      gpu[i].forEach((channel, c) => assert.ok(Math.abs(channel - expected[c]) <= 2, `flat=${flat} pixel=${x},${y} GPU=${gpu[i]} PNG=${expected}`))
    })
  }
  for (const [name, scene] of Object.entries(maskScenes())) {
    t.diagnostic(`mask scene: ${name}`)
    await check(scene, maskAlphas[name])
    await check(scene, maskAlphas[name], true)
  }
  // Landmark expectations are independent of the shared coverage helper.
  // Pixels avoid hard boundaries, where GPU rasterization has different AA.
  const extraCases = []
  const single = maskScenes().single
  const reverse = structuredClone(single)
  Object.assign(reverse.nodes.find(node => node.id === 'mask'), { enableSoftEdge: false, reverseMaskArea: true })
  extraCases.push(['reverse outside', reverse, [[50, 80], [90, 80], [180, 80]], [255, 0, 255]])
  const hardPercentage = structuredClone(single)
  Object.assign(hardPercentage.nodes.find(node=>node.id==='mask'), {
    enableSoftEdge:false,softEdgeMode:'Percentage',horizontalSoftRange:50,verticalSoftRange:50,
  })
  extraCases.push(['disabled percentage soft edge',hardPercentage,[[71,80],[80,80],[69,80]],[255,255,0]])
  const percentage = structuredClone(single)
  Object.assign(percentage.nodes.find(node => node.id === 'mask'), {
    softEdgeMode: 'Percentage', horizontalSoftRange: 50, verticalSoftRange: 100,
    softEdgeWidthX: 1, softEdgeWidthY: 99,
  })
  extraCases.push(['percentage range', percentage, [[80, 80], [100, 80], [120, 80]], [107, 255, 255]])
  const nestedReverse = structuredClone(maskScenes().nested)
  Object.assign(nestedReverse.nodes.find(node => node.id === 'mask'), { enableSoftEdge: false })
  Object.assign(nestedReverse.nodes.find(node => node.id === 'inner'), {
    sourceWidth: 40, enableSoftEdge: false, reverseMaskArea: true,
  })
  extraCases.push(['nested reverse', nestedReverse, [[80, 80], [120, 80], [160, 80], [180, 80]], [255, 0, 255, 0]])
  const rotatedNested = structuredClone(nestedReverse)
  Object.assign(rotatedNested.nodes.find(node=>node.id==='root'), {
    group:true,matrix:{a:0,b:0.8,c:-0.8,d:0,tx:120,ty:80},
  })
  rotatedNested.nodes.find(node=>node.id==='inner').group=true
  extraCases.push(['rotated scaled nested reverse',rotatedNested,[[120,50],[120,80],[120,110],[120,140]],[255,0,255,0]])
  for (const clockwise of [true, false]) {
    const radial = structuredClone(single)
    Object.assign(radial.nodes.find(node => node.id === 'mask'), { enableMask: false, enableSoftEdge: false })
    Object.assign(radial.nodes.find(node => node.id === 'red'), {
      sourceWidth: 100, sourceHeight: 100, enableFill: true, fillType: 'Radial360',
      fillRadialType: 'Top', fillClockwise: clockwise, fillAmount: 0.25,
    })
    extraCases.push([`radial clockwise=${clockwise}`, radial, [[140, 60], [100, 60], [140, 100]], clockwise ? [255, 0, 0] : [0, 255, 0]])
  }
  for (const clockwise of [true, false]) {
    for (const fillType of ['Radial90', 'Radial180']) {
      const radial = structuredClone(single)
      Object.assign(radial.nodes.find(node => node.id === 'mask'), { enableMask: false, enableSoftEdge: false })
      Object.assign(radial.nodes.find(node => node.id === 'red'), {
        sourceWidth:100, sourceHeight:100, enableFill:true, fillType,
        fillRadial90Type:'BottomLeft', fillRadialType:'Bottom', fillClockwise:clockwise, fillAmount:0.5,
      })
      const points=fillType==='Radial90'?[[80,60],[160,110]]:[[100,60],[140,60]]
      extraCases.push([`${fillType} clockwise=${clockwise}`,radial,points,clockwise?[255,0]:[0,255]])
    }
  }
  const reverseRadial = structuredClone(reverse)
  Object.assign(reverseRadial.nodes.find(node=>node.id==='mask'), {
    enableFill:true,fillType:'Radial360',fillRadialType:'Top',fillClockwise:true,fillAmount:0.25,
  })
  extraCases.push(['reverse radial mask',reverseRadial,[[130,70],[110,70],[130,90],[180,80]],[0,255,255,255]])
  for (const [name, scene, points, alpha] of extraCases) {
    t.diagnostic(`mask case: ${name}`)
    const context = createCanvas(240, 160).getContext('2d')
    context.drawImage(await loadImage(renderScenePng(scene, 240, 160, { background: 'transparent' }).data), 0, 0)
    for (const flat of [false, true]) {
      const gpu = await browser.evaluate(`window.sampleAt(${JSON.stringify(flat ? flattenScenePaint(scene) : scene)},${JSON.stringify(points)},${flat})`)
      points.forEach(([x, y], index) => {
        const png = [...context.getImageData(x, y, 1, 1).data]
        assert.ok(Math.abs(png[3] - alpha[index]) <= 2, `${name} PNG ${x},${y}: ${png}`)
        const expected = [png[0] * png[3] / 255, png[1] * png[3] / 255, png[2] * png[3] / 255, png[3]]
        gpu[index].forEach((channel, c) => assert.ok(Math.abs(channel - expected[c]) <= 3,
          `${name} flat=${flat} ${x},${y}: GPU=${gpu[index]} PNG=${expected}`))
      })
    }
  }
  // Changing only an ancestor must move the reverse cutout, including across
  // render groups; neither stale local masks nor viewport-sized local sprites do.
  const moved = structuredClone(reverse)
  t.diagnostic('mask phase: incremental viewport updates')
  moved.nodes.find(node => node.id === 'root').group = true
  await browser.evaluate(`window.sample(${JSON.stringify(moved)})`)
  const shiftedRoot = { ...moved.nodes[0], matrix: { ...moved.nodes[0].matrix, tx: 150 } }
  const shifted = await browser.evaluate(`window.sampleAt(${JSON.stringify({format:'tree-v1',reset:false,changed:[shiftedRoot]})},[[80,80],[150,80],[210,80]])`)
  assert.deepEqual(shifted.map(pixel => pixel[3]), [255, 0, 255], 'ancestor motion updates viewport reverse mask')
  const grid = maskScenes().grid
  await check(grid, maskAlphas.grid)
  const item = grid.nodes.find(n => n.id === 'mask')
  for (const [extra, alpha] of [
    [{ softEdgeWidthX: 40 }, [0, 0, 194, 255, 0]],
    [{ sourceWidth: 0 }, [0, 0, 0, 0, 0]],
    [{}, maskAlphas.grid],
    [{ enableMask: false }, maskAlphas.grid],
    [{ clipToParent: false }, maskAlphas.single],
  ]) {
    const updated = { ...item, ...extra }
    const pixels = await browser.evaluate(`window.sample(${JSON.stringify({ format: 'tree-v1', reset: false, changed: [updated] })})`)
    pixels.forEach((p, i) => {
      assert.ok(Math.abs(p[3] - alpha[i]) <= 2, `incremental ${JSON.stringify(extra)}: ${pixels}`)
      assert.equal(p[1], 0, 'no abandoned white clip graphic')
      assert.equal(p[2], 0, 'no abandoned white clip graphic')
    })
  }
})
