import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createWebServer } from '../server.js'
import { createStudio } from '../../studio/index.js'
import { createNode } from '../../studio/ui/authoring.js'
import { startTestBrowser } from './browser-helper.mjs'

const { createCanvas } = createRequire(new URL('../../studio/package.json', import.meta.url))('@napi-rs/canvas')

function syntheticImage(kind) {
  const size = kind === 'noise' ? 128 : 32
  const canvas = createCanvas(size, size)
  const context = canvas.getContext('2d')
  if (kind === 'circle') {
    context.fillStyle = 'rgba(30, 150, 230, 1)'
    context.beginPath()
    context.ellipse(size / 2, size / 2, 13, 10, 0, 0, Math.PI * 2)
    context.fill()
  } else {
    const image = context.createImageData(size, size)
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4
      let value = (x * 1103515245 + y * 12345 + ((x ^ y) * 2654435761)) >>> 0
      value ^= value >>> 13
      image.data[offset] = value & 255
      image.data[offset + 1] = (value >>> 8) & 255
      image.data[offset + 2] = (value >>> 16) & 255
      image.data[offset + 3] = 255
    }
    context.putImageData(image, 0, 0)
  }
  return canvas.toBuffer('image/png').toString('base64')
}

function sizeNode(node, width, height) {
  for (const transform of Object.values(node.transformByPlatform)) transform.size = { x: width, y: height }
}

function clickScript(selector) {
  return `(() => { const item = document.querySelector(${JSON.stringify(selector)}); if (!item || item.disabled) return false; item.click(); return true; })()`
}

test('Look3 resource fitting follows bind, preview, close-cancel and saved reopen lifecycle', {
  skip: !process.env.QXQY_BROWSER, timeout: 120_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'look3-resource-workflow-'))
  const archive = createStudio().archiveData()
  archive.activeAssetType = 'client-control-template'
  archive.assets.client.selectedId = 'n3'
  const clientRoot = archive.assets.client.root.children[0]
  const smallControl = clientRoot.children.find(node => node.id === 'n3')
  assert.ok(smallControl, '默认客户端模板应含图片控件 n3')
  smallControl.name = '窄幅图片控件'
  sizeNode(smallControl, 72, 48)
  const wideControl = createNode('image', { id: 'n6', name: '宽幅图片控件' })
  sizeNode(wideControl, 320, 120)
  clientRoot.children.push(wideControl)

  const circleUrl = `data:image/png;base64,${syntheticImage('circle')}`
  const noiseUrl = `data:image/png;base64,${syntheticImage('noise')}`
  const fittedOptions = { defaultsVersion: 1, count: 12, resolution: 64, workers: 1, shapes: ['ellipse', 'rectangle'], transparent: true }
  const slowOptions = { defaultsVersion: 1, count: 1000, resolution: 128, workers: 1, shapes: ['ellipse'], transparent: true }
  archive.look2.primitiveResources = [
    { id: 'resource-circle', name: '圆形合成资源', imageUrl: circleUrl, sourceRevision: 1, fitData: null, fitOptions: fittedOptions, previewMode: 'image' },
    { id: 'resource-noise', name: '高负载合成资源', imageUrl: noiseUrl, sourceRevision: 1, fitData: null, fitOptions: slowOptions, previewMode: 'image' },
  ]

  const archivePath = 'resource-workflow.save.json'
  await writeFile(join(directory, archivePath), JSON.stringify(archive))
  const app = await createWebServer({ workspace: directory, initialPath: archivePath, port: 0 })
  let browser
  t.after(async () => {
    await browser?.close()
    await app.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  browser = await startTestBrowser(directory)
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1200, deviceScaleFactor: 1, mobile: false }, browser.sessionId)
  await browser.navigate(app.url + '/editor')
  await browser.wait(`!!document.querySelector('button[title="图片资源"]:not([disabled])')`)

  const click = async selector => assert.equal(await browser.evaluate(clickScript(selector)), true, `无法点击 ${selector}`)
  const clickByInput = async selector => {
    const box = await browser.evaluate(`(() => { const item = document.querySelector(${JSON.stringify(selector)}); if (!item) return null; const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()`)
    assert.ok(box && box.width > 0 && box.height > 0, `不可点击目标：${selector}`)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, browser.sessionId)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, browser.sessionId)
  }
  const clickText = async (selector, label) => {
    const expression = `(() => { const root = document.querySelector(${JSON.stringify(selector)}); const item = [...(root || document).querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled); if (!item) return false; item.click(); return true; })()`
    assert.equal(await browser.evaluate(expression), true, `找不到可用按钮“${label}”`)
  }
  const openResources = async () => {
    await click('button[title="图片资源"]')
    await browser.wait(`!!document.querySelector('[role="dialog"][aria-label="图片与图元资源"]')`)
  }
  const closeResources = async () => {
    await clickText('[role="dialog"][aria-label="图片与图元资源"]', '关闭')
    await browser.wait(`!document.querySelector('[role="dialog"][aria-label="图片与图元资源"]')`)
  }

  await openResources()
  await browser.wait(`document.querySelector('[role="dialog"][aria-label="图片与图元资源"]')?.textContent.includes('圆形合成资源')`)
  await clickText('[role="dialog"][aria-label="图片与图元资源"]', '绑定到选中图片控件')
  await browser.wait(`document.querySelector('[role="dialog"][aria-label="图片与图元资源"]')?.textContent.includes('绑定 1 处')`)
  await closeResources()

  await browser.evaluate(`(() => { const item = [...document.querySelectorAll('.look2-tree-row button.tree-name')].find(button => button.textContent.trim() === '宽幅图片控件'); if (!item) return false; item.click(); return true; })()`)
  await browser.wait(`document.querySelector('.look2-tree-row.sel button.tree-name')?.textContent.trim() === '宽幅图片控件'`)
  await openResources()
  await browser.wait(`document.querySelector('[role="dialog"][aria-label="图片与图元资源"]')?.textContent.includes('绑定 1 处')`)
  await clickText('[role="dialog"][aria-label="图片与图元资源"]', '绑定到选中图片控件')
  await browser.wait(`document.querySelector('[role="dialog"][aria-label="图片与图元资源"]')?.textContent.includes('绑定 2 处')`)
  await closeResources()

  await openResources()
  await clickText('[role="dialog"][aria-label="图片与图元资源"]', '批量拟合未完成资源')
  await browser.wait(`document.querySelector('.look2-fit-progress')?.textContent.includes('高负载合成资源') && Number(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) < 100`)
  await closeResources()

  await openResources()
  await browser.wait(`(() => { const rows = [...document.querySelectorAll('.look2-resource-list button')].map(button => button.textContent.trim()); return rows.some(text => text.includes('圆形合成资源') && /[1-9][0-9]* 个图元/.test(text)) && rows.some(text => text.includes('高负载合成资源') && text.includes('未拟合')); })()`)
  await clickText('[role="dialog"][aria-label="图片与图元资源"]', '拟合图元')
  await browser.wait(`document.querySelector('.look2-resource-preview img')?.getAttribute('src')?.startsWith('data:image/svg+xml')`)
  await clickText('[role="dialog"][aria-label="图片与图元资源"]', '原图')
  await browser.wait(`document.querySelector('.look2-resource-preview img')?.getAttribute('src') === ${JSON.stringify(circleUrl)}`)
  await clickText('[role="dialog"][aria-label="图片与图元资源"]', '拟合图元')
  await browser.wait(`document.querySelector('.look2-resource-preview img')?.getAttribute('src')?.startsWith('data:image/svg+xml')`)
  await closeResources()

  await click('button[title="保存当前存档"]')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已保存 ${archivePath}')`)
  const savedPath = join(directory, archivePath)
  const saved = JSON.parse(await readFile(savedPath, 'utf8'))
  const resources = saved.look2.primitiveResources
  const complete = resources.find(resource => resource.id === 'resource-circle')
  const cancelled = resources.find(resource => resource.id === 'resource-noise')
  assert.ok(complete?.fitData?.elements?.length > 0, '已完成的第一项拟合应留在存档中')
  assert.equal(cancelled?.fitData, null, '关闭面板取消的第二项不应产生拟合结果')
  assert.equal(complete.previewMode, 'fit')
  assert.equal(saved.look2.siteNodes.n3.properties.imageResourceId, 'resource-circle')
  assert.equal(saved.look2.siteNodes.n3.properties.primitiveResourceId, 'resource-circle')
  assert.equal(saved.look2.siteNodes.n6.properties.imageResourceId, 'resource-circle')
  assert.equal(saved.look2.siteNodes.n6.properties.primitiveResourceId, 'resource-circle')
  const savedSmallControl = saved.assets.client.root.children[0].children.find(node => node.id === 'n3')
  const savedWideControl = saved.assets.client.root.children[0].children.find(node => node.id === 'n6')
  assert.notDeepEqual(
    Object.values(savedSmallControl.transformByPlatform)[0].size,
    Object.values(savedWideControl.transformByPlatform)[0].size,
  )

  await click('button[title="工作区存档"]')
  const archiveSelect = '[aria-label="工作区存档列表"]'
  await browser.wait(`!!document.querySelector(${JSON.stringify(archiveSelect)})`)
  const options = await browser.evaluate(`([...document.querySelector(${JSON.stringify(archiveSelect)}).options]).map(option => option.value)`)
  assert.ok(options.includes(archivePath), JSON.stringify(options))
  await clickByInput(archiveSelect)
  await browser.key('ArrowDown', 'ArrowDown')
  await browser.key('Enter', 'Enter')
  await browser.wait(`document.querySelector(${JSON.stringify(archiveSelect)})?.value === ${JSON.stringify(archivePath)}`)
  await clickText('.look2-workspace', '打开')
  await browser.wait(`document.querySelector('[role="status"]')?.textContent.includes('已加载 ${archivePath}')`)
  await openResources()
  await browser.wait(`document.querySelector('[role="dialog"][aria-label="图片与图元资源"]')?.textContent.includes('绑定 2 处')`)
  assert.equal(await browser.evaluate(`(() => { const button = [...document.querySelectorAll('[role="dialog"][aria-label="图片与图元资源"] button')].find(item => item.textContent.trim() === '拟合图元'); return button?.classList.contains('selected') ?? false; })()`), true)
  await browser.wait(`(() => { const rows = [...document.querySelectorAll('.look2-resource-list button')].map(button => button.textContent.trim()); return rows.some(text => text.includes('圆形合成资源') && /[1-9][0-9]* 个图元/.test(text)) && rows.some(text => text.includes('高负载合成资源') && text.includes('未拟合')); })()`)
})
