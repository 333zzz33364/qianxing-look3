import { writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStudio } from '../studio/index.js'

const workspace = fileURLToPath(new URL('../look2-workspace/', import.meta.url))
let revision = 1
while (['save.json', 'gia', 'lua'].some(ext => existsSync(`${workspace}动画联动示例.${revision}.${ext}`))) revision += 1
const stem = `动画联动示例.${revision}`
const transform = { anchorMinX: .5, anchorMinY: .5, anchorMaxX: .5, anchorMaxY: .5, pivotX: .5, pivotY: .5 }
const track = (nodeId, fieldKey, values) => ({ id: `${nodeId}-${fieldKey}`, nodeId, fieldKey,
  keyframes: values.map(([time, value]) => ({ id: `${nodeId}-${fieldKey}-${time}`, time, value, easeType: 'EaseInOut', interpolation: 'tween' })) })
const document = { version: 12, name: stem, previewPresetId: 'pc-16-9', nodes: [
  { ...transform, id: 'demo-root', parentId: null, name: '动画演示容器', type: 'container', sizeDeltaX: 800, sizeDeltaY: 500 },
  { ...transform, id: 'demo-image', parentId: 'demo-root', name: '移动与缩放图形', type: 'image', sizeDeltaX: 120, sizeDeltaY: 120,
    anchorOffsetX: -240, properties: { imageId: 100005, imageColor: { r: 100, g: 180, b: 255, a: 1 } } },
  { ...transform, id: 'demo-text', parentId: 'demo-root', name: '字号动画文本', type: 'textbox', sizeDeltaX: 600, sizeDeltaY: 80,
    anchorOffsetY: 170, properties: { text: 'look2.0 动画联动示例', fontSize: 28, horizontalAlignment: 'Middle' } },
], activeAnimationId: 'demo-animation', animations: [{ id: 'demo-animation', name: '移动、缩放、旋转和字号', duration: 3, keyframeTracks: [
  track('demo-image', 'anchoredPositionX', [[0, -240], [1.5, 240], [3, -240]]),
  track('demo-image', 'localScaleX', [[0, 1], [1.5, 1.6], [3, 1]]),
  track('demo-image', 'localScaleY', [[0, 1], [1.5, 1.6], [3, 1]]),
  track('demo-image', 'localRotationZ', [[0, 0], [3, 360]]),
  track('demo-text', 'fontSize', [[0, 28], [1.5, 40], [3, 28]]),
] }] }
const studio = createStudio()
studio.importData('json', Buffer.from(JSON.stringify(document)).toString('base64'), `${stem}.site.json`)
for (const [format, ext] of [['save', 'save.json'], ['gia', 'gia'], ['animation-lua', 'lua']]) {
  const exported = studio.exportData(format)
  const target = `${workspace}${stem}.${ext}`
  writeFileSync(target, Buffer.from(exported.data, 'base64'), { flag: 'wx' })
  console.log(target)
}
