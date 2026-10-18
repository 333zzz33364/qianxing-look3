// Reproducible synthetic files for native browser Worker and large draft checks.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import agPsd from '../editor-ui/node_modules/ag-psd/dist/index.js'

const output = fileURLToPath(new URL('../look2-workspace/acceptance-2.0.6/', import.meta.url))
await mkdir(output, { recursive: true })
const files = []
async function save(name, bytes) {
  await writeFile(join(output, name), bytes, { flag: 'wx' })
  files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const pixels = (width, height, rgba) => ({ width, height,
  data: new Uint8ClampedArray(Array.from({ length: width * height * 4 }, (_, index) => rgba[index % 4])) })
const psd = { width: 64, height: 48, children: [{ name: '分组与蒙版', opacity: .5, children: [
  { name: '红色偏移图层', left: 5, top: 7, right: 21, bottom: 19,
    imageData: pixels(16, 12, [255, 30, 40, 255]),
    mask: { left: 5, top: 7, right: 21, bottom: 19, defaultColor: 0,
      imageData: pixels(16, 12, [128, 128, 128, 255]) } },
  { name: '隐藏蓝色图层', hidden: true, left: 28, top: 13, right: 36, bottom: 21,
    imageData: pixels(8, 8, [30, 70, 255, 255]) },
] }] }
await save('group-mask.synthetic.psd', agPsd.writePsdBuffer(psd))
await save('invalid.synthetic.psd', Buffer.from('this is not a PSD'))

const canvas = createCanvas(1400, 1400), context = canvas.getContext('2d')
const image = context.createImageData(canvas.width, canvas.height)
let seed = 0x12345678
for (let index = 0; index < image.data.length; index += 4) {
  for (let channel = 0; channel < 3; channel++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    image.data[index + channel] = seed & 255
  }
  image.data[index + 3] = 255
}
context.putImageData(image, 0, 0)
await save('large-draft.synthetic.png', canvas.toBuffer('image/png'))
const imageUrl = canvas.toDataURL('image/png')
const largeSite = { version: 12, name: '大图片草稿验收（合成）', frameRate: 30,
  canvasWidth: 1600, canvasHeight: 900,
  nodes: [{ id: 'large', type: 'primitive', name: '大图资源', parentId: null,
    anchorMinX: .5, anchorMinY: .5, anchorMaxX: .5, anchorMaxY: .5,
    pivotX: .5, pivotY: .5, sizeDeltaX: 350, sizeDeltaY: 350,
    properties: { imageResourceId: 'large-resource', imageSource: 'primitive', imageId: 100001 } }],
  primitiveResources: [{ id: 'large-resource', name: '1400像素合成噪声', imageUrl, previewMode: 'image' }],
  animations: [{ id: 'draft', name: '草稿测试', duration: 2, keyframeTracks: [], events: [] }], activeAnimationId: 'draft' }
await save('large-draft.synthetic.site.json', Buffer.from(JSON.stringify(largeSite)))
const small = createCanvas(20, 12)
small.getContext('2d').fillRect(0, 0, 20, 12)
await save('region.synthetic.png', small.toBuffer('image/png'))
const spine = { skeleton: { spine: '3.8.99', width: 100, height: 100 },
  bones: [{ name: 'root' }, { name: 'child', parent: 'root', x: 12, y: 8, rotation: 25, scaleX: 1.3, scaleY: .7 }],
  slots: [{ name: 'region-slot', bone: 'child', attachment: 'region' }],
  skins: [{ name: 'default', attachments: { 'region-slot': { region: { path: 'region.synthetic', width: 20, height: 12 } } } }],
  animations: { move: { bones: { child: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 20, y: 10 }] } },
    events: [{ time: .5, name: '中点', string: 'synthetic' }] } } }
await save('skeleton.synthetic.json', Buffer.from(JSON.stringify(spine)))
await save('fixture-manifest.json', Buffer.from(JSON.stringify({
  purpose: 'Synthetic native browser import and draft fixtures; not external real-world projects.',
  psdExpected: { width: 64, height: 48, groups: 1, pixelLayers: 2, hiddenLayers: 1,
    redLayer: { left: 5, top: 7, width: 16, height: 12, maskedAlpha: 128 }, groupOpacity: .5 },
  largeImage: { width: 1400, height: 1400, encodedBytes: Buffer.byteLength(imageUrl), exceedsLocalStorageTypicalLimit: true },
  files,
}, null, 2) + '\n'))
console.log(JSON.stringify({ output, files: files.map(({ name, bytes }) => ({ name, bytes })) }, null, 2))
