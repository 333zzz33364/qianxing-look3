import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { createStudio } from '../studio/index.js'

const workspace = fileURLToPath(new URL('../look2-workspace/', import.meta.url))
mkdirSync(workspace, { recursive: true })
const outputs = [['save', 'save.json'], ['site-json', 'site.json'], ['gia', 'gia'], ['animation-lua', 'lua'],
  ['timeline-data', 'timeline.lua'], ['timeline-lib', 'TweenTimelineLib.lua'], ['primitive-data', 'primitive.lua'],
  ['primitive-lib', 'PrimitiveImageLib.lua'], ['primitive-svg', 'svg'], ['primitive-css', 'css']]
let revision = 1
while (outputs.some(([, extension]) => existsSync(`${workspace}功能对齐示例.${revision}.${extension}`))) revision++
const name = `功能对齐示例.${revision}`
const element = (type, x, y, width, height, color, rotation = 0) => ({ type, imageId: { rectangle: 100001, ellipse: 100002, triangle: 100003 }[type], x, y, width, height, rotation, color })
const fitData = { version: 1, width: 240, height: 160, elements: [
  element('rectangle', 0, 0, 240, 160, { r: 20, g: 26, b: 40, a: 1 }),
  element('rectangle', -55, 0, 100, 130, { r: 239, g: 77, b: 98, a: 1 }),
  element('ellipse', 55, 20, 100, 100, { r: 79, g: 160, b: 255, a: .9 }),
  element('triangle', 55, -35, 65, 60, { r: 255, g: 209, b: 84, a: 1 }, 20),
] }
const canvas = createCanvas(fitData.width, fitData.height), context = canvas.getContext('2d')
context.translate(fitData.width / 2, fitData.height / 2); context.scale(1, -1)
for (const row of fitData.elements) {
  context.save(); context.translate(row.x, row.y); context.rotate(row.rotation * Math.PI / 180)
  context.fillStyle = `rgba(${row.color.r},${row.color.g},${row.color.b},${row.color.a})`
  context.beginPath()
  if (row.type === 'rectangle') context.rect(-row.width / 2, -row.height / 2, row.width, row.height)
  else if (row.type === 'ellipse') context.ellipse(0, 0, row.width / 2, row.height / 2, 0, 0, Math.PI * 2)
  else { context.moveTo(0, row.height / 2); context.lineTo(row.width / 2, -row.height / 2); context.lineTo(-row.width / 2, -row.height / 2); context.closePath() }
  context.fill(); context.restore()
}
const anchors = { anchorMinX: .5, anchorMinY: .5, anchorMaxX: .5, anchorMaxY: .5, pivotX: .5, pivotY: .5 }
const node = (id, label, type, parentId, x, y, width, height, properties = {}) => ({ ...anchors, id, name: label, type, parentId, anchorOffsetX: x, anchorOffsetY: y, sizeDeltaX: width, sizeDeltaY: height, properties })
const track = (nodeId, fieldKey, keys) => ({ id: `${nodeId}-${fieldKey}`, nodeId, fieldKey, keyframes: keys.map((key, index) => ({ id: `${nodeId}-${fieldKey}-${index}`, interpolation: 'tween', easeType: 'InOutSine', ...key })) })
const site = { version: 12, name, previewPresetId: 'pc-16-9', frameRate: 30, exampleNote: '图片内嵌、三种图元、前帧增量、RGBA、透明度与事件', nodes: [
  node('root', '功能演示容器', 'container', null, 0, 0, 900, 500),
  node('title', '说明标题', 'textbox', 'root', 0, 180, 820, 65, { text: 'look2.0 · 在线素材 / 图元 / 动画', fontSize: 30, fontColor: { r: 235, g: 240, b: 255, a: 1 }, horizontalAlignment: 'Middle' }),
  node('fitted', '三形状内嵌图片', 'primitive', 'root', -220, -15, 360, 240, { imageResourceId: 'sample-resource', imageSource: 'primitive' }),
  node('native', '在线五角星', 'image', 'root', 225, 0, 150, 150, { imageId: 100005, imageType: 'basic', imageColor: { r: 255, g: 209, b: 84, a: 1 } }),
  node('caption', '使用说明', 'textbox', 'root', 0, -190, 820, 70, { text: '左侧保存原图和图元；右侧在线素材。播放观察透明度、颜色与事件。', fontSize: 22, fontColor: { r: 170, g: 188, b: 215, a: 1 }, horizontalAlignment: 'Middle' }),
], primitiveResources: [{ id: 'sample-resource', name: '三种图元演示', imageUrl: canvas.toDataURL('image/png'), fitData, previewMode: 'fit', fitOptions: { count: 400, resolution: 512, workers: 16, shapes: ['ellipse', 'rectangle', 'triangle'], transparent: true } }], animations: [{ id: 'demo', name: '增量、旋转、颜色和透明度', duration: 4, keyframeTracks: [
  track('fitted', 'groupAlpha', [{ time: 0, value: 255 }, { time: 2, value: 80 }, { time: 4, value: 255 }]),
  track('native', 'anchoredPositionY', [{ time: 0, value: 0 }, { time: 1, value: 80, relative: true }, { time: 2, value: -80, relative: true }, { time: 4, value: 0 }]),
  track('native', 'localRotationZ', [{ time: 0, value: 0 }, { time: 4, value: 720 }]),
  track('native', 'imageColor', [{ time: 0, value: { r: 255, g: 209, b: 84, a: 1 } }, { time: 2, value: { r: 79, g: 160, b: 255, a: .7 } }, { time: 4, value: { r: 255, g: 209, b: 84, a: 1 } }]),
], events: [{ id: 'midpoint', time: 2, name: '到达中点', nodeId: 'native', target: '在线五角星', params: '{"phase":"middle"}' }] }], activeAnimationId: 'demo' }
const studio = createStudio()
studio.importData('json', Buffer.from(JSON.stringify(site)).toString('base64'), `${name}.site.json`)
for (const [format, extension] of outputs) {
  const exported = studio.exportData(format, ['primitive-svg', 'primitive-css'].includes(format) ? 'sample-resource' : ['gia'].includes(format) ? 'client-control-template' : ['animation-lua', 'timeline-data', 'primitive-data'].includes(format) ? 'root' : undefined)
  writeFileSync(`${workspace}${name}.${extension}`, Buffer.from(exported.data, 'base64'), { flag: 'wx' })
  console.log(`${name}.${extension}${exported.warnings?.length ? ` (${exported.warnings.length} warnings)` : ''}`)
}
