import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStudio } from '../studio/index.js'
import { createDefaultClientTemplateProject, createNode } from '../studio/ui/authoring.js'
import { PLATFORMS } from '../studio/constants.js'

const seed = createDefaultClientTemplateProject()
const panel = seed.root.children[0]
panel.name = '属性与父级变换验收（合成）'
const kinds = ['textbox', 'image', 'button', 'cursor', 'grid', 'reference', 'textwindow', 'keyhint', 'animation', 'fullscreen']
panel.children = kinds.map((kind, index) => {
  const node = createNode(kind, { id: `check-${kind}`, name: `验收-${kind}` })
  if (kind === 'textbox' || kind === 'textwindow') node.text = `属性验收 ${kind}`
  for (const platform of PLATFORMS) {
    const transform = node.transformByPlatform[platform]
    if (kind !== 'fullscreen') {
      transform.offset.x = (index % 5 - 2) * 230
      transform.offset.y = (Math.floor(index / 5) ? -1 : 1) * 160
    }
  }
  return node
})
const parent = createNode('container', { id: 'scaled-parent', name: '旋转25度缩放父级' })
for (const platform of PLATFORMS) {
  const transform = parent.transformByPlatform[platform]
  transform.size.x = 400; transform.size.y = 240
  transform.rotation.z = 25; transform.scale.x = 1.5; transform.scale.y = .6
}
const child = createNode('textbox', { id: 'scaled-child', name: '缩放父级下的拖动文本', text: '拖动并对照父级逆矩阵' })
parent.children = [child]
panel.children.unshift(parent)
const studio = createStudio(seed)
const result = studio.exportData('save')
const output = fileURLToPath(new URL('../look2-workspace/acceptance-2.0.6/control-ui.1.save.json', import.meta.url))
writeFileSync(output, Buffer.from(result.data, 'base64'), { flag: 'wx' })
console.log(output)
