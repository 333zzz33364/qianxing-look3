import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer } from '../server.js'
import { startTestBrowser } from './browser-helper.mjs'
import { geometryFont } from '../../studio/test/fixtures/geometry-font.mjs'
import { createRuntime } from '../../client/lua-runtime/src/index.js'
import { playSnapshot, paintList } from '../../studio/play/session.js'

const TEXT = '<color=red><b>A</b></color><i>B</i><size=12><color=#00ff0080>A</color></size>'

test('富文本在编辑器画布与真实 WebGL 中按 run 绘制、增量更新并释放视口纹理', {
  skip: !process.env.QXQY_BROWSER, timeout: 120_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'look3-rich-text-'))
  const path = join(directory, 'font.ttf'), previous = process.env.QXQY_FONT_PATH
  await writeFile(path, geometryFont())
  process.env.QXQY_FONT_PATH = path
  let app, browser
  const runtime = createRuntime({ canvasWidth: 240, canvasHeight: 160 })
  t.after(async () => {
    runtime.destroy()
    await browser?.close(); await app?.close()
    if (previous === undefined) delete process.env.QXQY_FONT_PATH; else process.env.QXQY_FONT_PATH = previous
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  app = await createWebServer({ workspace: directory, port: 0 })
  browser = await startTestBrowser(directory)
  const { evaluate, wait } = browser
  await browser.navigate(app.url + '/editor')
  await wait(`Boolean(document.querySelector('[data-qxsim-session-id], .look2'))`)
  await evaluate(`(async () => {
    const sessionId = document.querySelector('[data-qxsim-session-id]')?.dataset.qxsimSessionId
      || sessionStorage.getItem('look2-editor-session');
    const api = async (action, body = {}) => (await (await fetch('/editor/api/' + action, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({sessionId,...body})
    })).json()).value;
    let state = await api('get');
    for (const [key,value] of Object.entries(${JSON.stringify({ text: TEXT, fontSize: 32, fontColor: 0xff0000ff,
      bgColor: 0, enableOutline: false, width: 200, height: 100, horizontalAlignment: 'Left', verticalAlignment: 'Top' })})) {
      state = await api('patch',{op:{op:'set',id:'n2',key,value,expectedRevision:state.version}});
    }
  })()`)
  await browser.navigate(app.url + '/editor')
  await wait(`document.querySelector('.look2-rich-text')?.getAttribute('aria-label') === 'ABA'`)
  await evaluate(`window.colors = (canvas, premultiplied = false) => {
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let red=0,green=0,blue=0;
    for(let i=0;i<data.length;i+=4){
      if(data[i]>240&&data[i+1]<10&&data[i+3]>240)red++;
      if(Math.abs(data[i+1]-(premultiplied?128:255))<=2&&data[i]<10&&Math.abs(data[i+3]-128)<=1)green++;
      if(data[i+2]>240&&data[i]<10&&data[i+3]>240)blue++;
    }
    return {red,green,blue};
  }`)
  const editor = await evaluate(`colors(document.querySelector('.look2-rich-text'))`)
  assert.ok(editor.red > 10 && editor.green > 5 && editor.blue > 10, JSON.stringify(editor))

  const label = runtime.addRoot({ kind: 'textbox', active: true, visible: true, text: TEXT, fontSize: 32,
    fontColor: 0xff0000ff, bgColor: 0, enableOutline: false, sizeDeltaX: 200, sizeDeltaY: 100,
    horizontalAlignment: 'Left', verticalAlignment: 'Top' })
  const session = { runtime, compiled: { canvasId: 'pc-16-9', platform: 'PC' }, history: [] }
  let scene = playSnapshot(session, { view: true }).scene
  await evaluate(`(async () => {
    const {PixiPlayRenderer,loadBrowserFont}=await import('/play-renderer.js');
    const canvas=document.createElement('canvas');document.body.append(canvas);
    window.richRenderer=new PixiPlayRenderer(canvas,{fontReady:loadBrowserFont()});await richRenderer.ready;
    // Pixi 8.20 的 WebGL 提取结果为预乘 RGB，与 Canvas 2D 不同。
    window.gpuColors=()=>colors(richRenderer.app.renderer.extract.canvas({target:richRenderer.app.stage,resolution:1}),true);
    window.sourceCount=()=>Object.values(richRenderer.app.renderer.texture._managedTextures.items).filter(Boolean).length;
    await richRenderer.applyScene(${JSON.stringify(scene)},240,160);
    window.richTexture=richRenderer.nodes.get(${label.Id}).__visual.__richText.texture;
  })()`)
  const gpu = await evaluate('gpuColors()')
  assert.ok(gpu.red > 10 && gpu.green > 5 && gpu.blue > 10, JSON.stringify(gpu))
  await evaluate(`richRenderer.render(${JSON.stringify(paintList(session))},240,160)`)
  assert.deepEqual(await evaluate('gpuColors()'), gpu, '扁平回退路径同样绘制样式化 run')

  // 同尺寸的连续颜色变化必须复用自持纹理并上传到 GPU，而不是只改宿主 canvas。
  await evaluate(`richRenderer.applyScene(${JSON.stringify(scene)},240,160)`)
  await evaluate(`void (window.richTexture=richRenderer.nodes.get(${label.Id}).__visual.__richText.texture)`)
  const baseCount = await evaluate('sourceCount()')
  const variants = []
  for (const color of ['red', 'lime']) {
    label.text = `<color=${color}>AAAA</color>`
    label.markPlayDirty()
    const patch = playSnapshot(session, { view: true, sceneRev: scene.revision }).scene
    variants.push(patch); scene = patch
  }
  const churn = await evaluate(`(async () => {
    const scenes=${JSON.stringify(variants)};let replaced=0;
    for(let i=0;i<200;i++) {
      await richRenderer.applyScene(scenes[i%2],240,160);
      if(richRenderer.nodes.get(${label.Id}).__visual.__richText.texture!==richTexture)replaced++;
    }
    return {replaced,count:sourceCount(),colors:gpuColors()};
  })()`)
  assert.equal(churn.replaced, 0)
  assert.ok(churn.count <= baseCount + 2, JSON.stringify(churn))
  assert.equal(churn.colors.red, 0, '上一帧的红色上传必须被替换')
  const visibleLime = await evaluate(`(() => {
    const cv=richRenderer.app.renderer.extract.canvas({target:richRenderer.app.stage,resolution:1});
    const data=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;let count=0;
    for(let i=0;i<data.length;i+=4)if(data[i]<10&&data[i+1]>240&&data[i+3]>240)count++;
    return count;
  })()`)
  assert.ok(visibleLime > 100, '最后一次颜色更新已到达 GPU')

  label.text = 'AB'
  label.markPlayDirty()
  const plain = playSnapshot(session, { view: true, sceneRev: scene.revision }).scene
  const cleanup = await evaluate(`(async () => {
    const source=richTexture.source;
    await richRenderer.applyScene(${JSON.stringify(plain)},240,160);
    const result={destroyed:richTexture.destroyed,sourceDestroyed:source.destroyed,
      plain:richRenderer.nodes.get(${label.Id}).__visual.__text.text};
    richRenderer.destroy();return result;
  })()`)
  assert.deepEqual(cleanup, { destroyed: true, sourceDestroyed: true, plain: 'AB' })
})
