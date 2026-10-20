import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'

test('changing HUD text retains visuals and bounded Pixi resources across scene restarts', {
  skip: !process.env.QXQY_BROWSER, timeout: 90_000,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qxqy-text-churn-'))
  const app = await createWebServer({ workspace: directory, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close(); await app.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  browser = await startTestBrowser(directory)
  await browser.navigate(app.url)
  await browser.wait('document.querySelector("#connection")?.textContent.includes("实时监听中")')
  await browser.evaluate(`(async () => {
    const { PixiPlayRenderer } = await import('/play-renderer.js');
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const renderer = window.churnRenderer = new PixiPlayRenderer(canvas);
    await renderer.ready;
    // Count real render resources without depending on nondeterministic heap GC.
    // These diagnostic fields belong to the pinned Pixi 8.20 implementation.
    window.resourceCounts = () => {
      const gpu = renderer.app.renderer;
      const texts = gpu.renderPipes.text._managedTexts.items;
      const textures = gpu.canvasText._activeTextures;
      return { gpuSources: Object.values(gpu.texture._managedTextures.items).filter(Boolean).length,
        textKeys: Object.keys(texts).length, liveTexts: Object.values(texts).filter(Boolean).length,
        textureKeys: Object.keys(textures).length, liveTextures: Object.values(textures).filter(Boolean).length };
    };
    window.textNode = (id, text) => ({ id, parent: null, z: 0, kind: 'textbox', text,
      fontSize: 24, fontColor: 0xffffffff, bgColor: 0, enableOutline: false,
      sourceWidth: 280, sourceHeight: 60, horizontalAlignment: 'Left', verticalAlignment: 'Top',
      matrix: { a: 1, b: 0, c: 0, d: 1, tx: 160, ty: 60 } });
    window.runTextBatch = async (start, count) => {
      let replaced = 0, previous;
      for (let i = start; i < start + count; i++) {
        const item = textNode(1, 'Score ' + i);
        await renderer.applyScene({ format: 'tree-v1', reset: false, changed: [item] }, 320, 120);
        const visual = renderer.nodes.get(1).__visual;
        if (previous && previous !== visual) replaced++;
        previous = visual;
      }
      const text = previous.__text;
      return { ...resourceCounts(), replaced, text:text.text,
        uploaded:text._gpuData[renderer.app.renderer.uid].currentKey.startsWith(text.text + ':') };
    };
  })()`)
  const shared = await browser.evaluate(`(async () => {
    const renderer = churnRenderer, gpu = renderer.app.renderer;
    await renderer.applyScene({ format:'tree-v1', reset:true, nodes:[textNode(1,'Shared'),textNode(2,'Shared')] },320,120);
    const text = renderer.nodes.get(2).__visual.__text;
    const data = text._gpuData[gpu.uid], texture = data.texture, source = texture.source;
    const before = gpu.canvasText.getReferenceCount(data.currentKey);
    await renderer.applyScene({ format:'tree-v1', reset:false, removed:[1] },320,120);
    const result = { before, after:gpu.canvasText.getReferenceCount(data.currentKey), destroyed:texture.destroyed || source.destroyed };
    // Exercise deferred text re-upload when a previously rendered node is culled.
    renderer.nodes.get(2).visible = false;
    await renderer.applyScene({ format:'tree-v1', reset:false, changed:[textNode(2,'Hidden update')] },320,120);
    renderer.nodes.get(2).visible = true;
    await renderer.applyScene({ format:'tree-v1', reset:false, changed:[] },320,120);
    result.afterHidden = resourceCounts();
    renderer.clearNodes();
    return result;
  })()`)
  // Production visuals own distinct TextStyles (Pixi keys include style uid).
  // Removing one must not release the surviving label's managed texture.
  assert.deepEqual([shared.before, shared.after, shared.destroyed], [1, 1, false], JSON.stringify(shared))
  assert.equal(shared.afterHidden.textureKeys, 1, JSON.stringify(shared))
  const samples = []
  for (let round = 0; round < 3; round++) {
    samples.push(await browser.evaluate(`runTextBatch(${round * 400}, 400)`))
    assert.equal(samples.at(-1).text, `Score ${round * 400 + 399}`)
    assert.equal(samples.at(-1).uploaded, true, 'the latest value must reach the GPU, not just the JS Text')
    await browser.evaluate(`churnRenderer.applyScene({format:'tree-v1',reset:true,nodes:[]},320,120)`)
    const empty = await browser.evaluate('resourceCounts()')
    assert.equal(empty.liveTexts, 0, JSON.stringify(empty))
    assert.equal(empty.liveTextures, 0, JSON.stringify(empty))
    assert.equal(empty.textKeys, 0, JSON.stringify(empty))
    assert.equal(empty.textureKeys, 0, JSON.stringify(empty))
  }
  t.diagnostic(JSON.stringify(samples))
  assert.ok(samples.every(sample => sample.replaced === 0), 'text-only changes must retain the visual/Text/mask objects')
  assert.ok(samples.every(sample => sample.gpuSources <= samples[0].gpuSources + 4), 'texture sources must plateau after warm-up')
  assert.ok(samples.every(sample => sample.textKeys <= 8 && sample.textureKeys <= 128), 'retired text keys must not accumulate across restart')
  const styled = await browser.evaluate(`(async () => {
    const renderer = churnRenderer;
    let visual, text, clip, bar, replaced = 0;
    for (let i = 0; i < 180; i++) {
      // Exercise style replacement and visible scrollbar movement together.
      const item = { ...textNode(7, 'Chat ' + i), kind: 'textwindow',
        fontSize: 20 + i % 3, fontColor: i % 2 ? 0xff00ff00 : 0xffff0000,
        enableOutline: i % 4 === 0, outlineColor: 0xff111111,
        scroll: { lines: Array.from({length:20},(_,line)=>'Message '+i+' line '+line),
          lineHeight:24, textWidth:260, offset:i%100, max:420, contentLength:480, showBar:true } };
      await renderer.applyScene({format:'tree-v1',reset:false,changed:[item]},320,120);
      const next=renderer.nodes.get(7).__visual;
      if (visual && (next!==visual || next.__text!==text || next.__text.mask!==clip || next.__scrollBar!==bar)) replaced++;
      visual=next; text=next.__text; clip=text.mask; bar=next.__scrollBar;
    }
    const result={...resourceCounts(),replaced,font:text.style.fontSize,bar:Boolean(bar),
      uploaded:text._gpuData[renderer.app.renderer.uid].currentKey.startsWith(text.text+':')};
    await renderer.applyScene({format:'tree-v1',reset:true,nodes:[]},320,120);
    result.empty=resourceCounts(); return result;
  })()`)
  t.diagnostic(JSON.stringify({ styledScroll: styled }))
  assert.equal(styled.replaced, 0, 'style/color/scroll changes retain Text, clip, background and visible scrollbar')
  assert.equal(styled.bar, true)
  assert.equal(styled.uploaded, true)
  assert.equal(styled.font, 22)
  assert.ok(styled.textKeys <= 8 && styled.textureKeys <= 128, JSON.stringify(styled))
  assert.deepEqual([styled.empty.liveTexts, styled.empty.liveTextures, styled.empty.textKeys, styled.empty.textureKeys], [0, 0, 0, 0])
  await browser.evaluate('churnRenderer.destroy()')
})
