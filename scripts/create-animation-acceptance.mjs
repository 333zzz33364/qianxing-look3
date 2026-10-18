import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const node = (id, name, type, parentId, y, width, height, properties) => ({
  id, name, type, parentId, anchorMinX: .5, anchorMinY: .5, anchorMaxX: .5, anchorMaxY: .5,
  pivotX: .5, pivotY: .5, anchorOffsetX: 0, anchorOffsetY: y, sizeDeltaX: width, sizeDeltaY: height, properties,
})
const track = (field, values, target = 'event-image') => ({ id: `track-${field}`, nodeId: target, fieldKey: field,
  keyframes: values.map((key, index) => ({ id: `${field}-${index}`, interpolation: 'tween', easeType: 'Linear', ...key })) })
const site = { version: 12, name: '时间轴与60条同刻事件验收（合成）', frameRate: 24,
  timelineSnapEnabled: true, nodes: [
    node('event-root', '动画验收容器', 'container', null, 0, 700, 450, {}),
    node('event-image', '事件五角星', 'image', 'event-root', 30, 80, 80, { imageId: 100005 }),
    node('event-text', '事件文本', 'textbox', 'event-root', -110, 480, 60, { text: '同刻事件顺序与最近50条日志', fontSize: 24 }),
  ], animations: [{ id: 'timeline-check', name: '关键帧与事件验收', duration: 3, keyframeTracks: [
    track('anchoredPositionX', [{ time: 0, value: 0 }, { time: 1, value: 100, relative: true }, { time: 2, value: -100, relative: true }]),
    track('localRotationZ', [{ time: 0, value: 350 }, { time: 2, value: 730 }]),
    track('imageColor', [{ time: 0, value: { r: 255, g: 100, b: 40, a: 1 } }, { time: 2, value: { r: 40, g: 100, b: 255, a: .5 } }]),
    track('groupAlpha', [{ time: 0, value: 255 }, { time: 2, value: 80 }]),
    track('fontSize', [{ time: 0, value: 24 }, { time: 2, value: 40 }], 'event-text'),
  ], events: Array.from({ length: 60 }, (_, index) => ({ id: `event-${index + 1}`, time: .5,
    name: `顺序事件${String(index + 1).padStart(2, '0')}`, nodeId: 'event-text', target: '事件文本',
    params: JSON.stringify({ index: index + 1 }) })) }], activeAnimationId: 'timeline-check' }
const output = fileURLToPath(new URL('../look2-workspace/acceptance-2.0.6/timeline-ui.1.site.json', import.meta.url))
writeFileSync(output, JSON.stringify(site, null, 2) + '\n', { flag: 'wx' })
console.log(output)
