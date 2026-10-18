import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import agPsd from '../../editor-ui/node_modules/ag-psd/dist/index.js'
import { applyLayerMasks, convertPsdDocument, importPsd, importSpine, PSD_IMPORT_MAX_BYTES } from '../../editor-ui/look2-assets.js'

const makeFile = (name, value, type = 'application/json') => new File([value], name, { type })
const prototypeImageData = (width, height, data) => {
  const dimensions = new WeakMap()
  class ImageDataShape {
    constructor() { dimensions.set(this, { width, height }); this.data = data }
    get width() { return dimensions.get(this).width }
    get height() { return dimensions.get(this).height }
  }
  return new ImageDataShape()
}
function spineFiles(overrides = {}) {
  const spine = {
    skeleton: { spine: '3.8.99', width: 100, height: 100 },
    bones: [{ name: 'root' }],
    slots: [{ name: 'slot', bone: 'root', attachment: 'region' }],
    skins: [{ name: 'default', attachments: { slot: { region: { path: 'region', width: 20, height: 10 } } } }],
    animations: { walk: {
      bones: { root: { translate: [
        { time: 0, x: 0, y: 0, curve: [.25, .1, .75, .9] }, { time: 1, x: 10, y: 0 },
      ] } },
      slots: { slot: { attachment: [{ time: 0, name: 'region' }] } },
      events: [{ time: .5, name: 'step', int: 1 }],
    } },
    ...overrides,
  }
  return [makeFile('skeleton.json', JSON.stringify(spine)), makeFile('region.png', Uint8Array.of(137, 80, 78, 71), 'image/png')]
}

test('PSD pixel masks apply default, density and invert semantics to alpha', () => {
  const image = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 200]) }
  const warnings = new Set()
  const result = applyLayerMasks(image, { name: 'pixel', left: 0, top: 0 }, [{ name: 'group', mask: {
    left: 0, top: 0, userMaskDensity: 128, userMaskFeather: 1,
    imageData: { width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]) },
  } }], warnings)
  assert.deepEqual([...result.data], [10, 20, 30, 150])
  assert.match([...warnings][0], /羽化/)
  const noPixels = applyLayerMasks(image, { name: 'vector' }, [{ name: 'vector', vectorMask: {}, mask: { vectorMask: true } }], warnings)
  assert.deepEqual([...noPixels.data], [10, 20, 30, 200])
  assert.ok([...warnings].some(message => message.includes('矢量蒙版')))
})

test('PSD cached vector raster masks are baked once and reported without claiming editable paths', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Cached vector', left: 0, top: 0, vectorMask: { paths: [] },
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
    mask: { fromVectorData: true, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
  }] }, 'vector-cache.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.equal(encoded.data[3], 100)
  assert.match(result.giaImportStatus, /矢量蒙版已按.*栅格通道烘焙/)
  assert.match(result.giaImportStatus, /矢量路径不可编辑/)
  assert.doesNotMatch(result.giaImportStatus, /没有可烘焙/)
})

test('PSD group cached vector masks report their raster bake and affect descendant pixels', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 2, height: 1, children: [{
    name: 'Vector group', vectorMask: { paths: [] },
    mask: { fromVectorData: true, left: 0, top: 0, imageData: { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) } },
    children: [{ name: 'Child', left: 0, top: 0, imageData: { width: 2, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200, 78, 90, 12, 200]) } }],
  }] }, 'vector-group.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.deepEqual([...encoded.data], [12, 34, 56, 0, 78, 90, 12, 200])
  assert.match(result.giaImportStatus, /Vector group.*矢量蒙版已按.*栅格通道烘焙/)
})

test('PSD disabled ancestor vector caches retain the active descendant bitmap mask', async () => {
  for (const disabled of [false, true]) {
    let encoded
    const result = await convertPsdDocument({ width: 1, height: 1, children: [{
      name: 'Parent', vectorMask: { disable: disabled, paths: [] },
      mask: { fromVectorData: true, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
      children: [{ name: 'Child',
        mask: { fromVectorData: false, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
        imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
      }],
    }] }, 'ancestor-cache.psd', pixels => { encoded = pixels; return 'encoded' })
    assert.deepEqual([...encoded.data], [12, 34, 56, disabled ? 100 : 0])
    if (disabled) assert.doesNotMatch(result.giaImportStatus, /Parent.*矢量蒙版/)
    else assert.match(result.giaImportStatus, /Parent.*栅格通道烘焙/)
  }
})

test('PSD vector paths without an enabled raster cache retain pixels and report the unsupported boundary', async () => {
  for (const mask of [undefined, { fromVectorData: true, disabled: true,
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } }]) {
    let encoded
    const result = await convertPsdDocument({ width: 1, height: 1, children: [{
      name: 'Unbaked vector', vectorMask: { paths: [] }, mask,
      imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
    }] }, 'unbaked-vector.psd', pixels => { encoded = pixels; return 'encoded' })
    assert.equal(encoded.data[3], 200)
    assert.doesNotMatch(result.giaImportStatus, /矢量蒙版已按.*栅格通道烘焙/)
    assert.match(result.giaImportStatus, mask ? /栅格通道已禁用/ : /没有可烘焙/)
  }
})

test('PSD disabled vector masks do not apply their saved raster cache', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Disabled vector', vectorMask: { disable: true, paths: [] },
    mask: { fromVectorData: true, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
  }] }, 'disabled-vector.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.equal(encoded.data[3], 200)
  assert.doesNotMatch(result.giaImportStatus, /矢量蒙版/)
})

test('PSD non-vector bitmap masks do not imply that vector paths have been rasterized', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Separate vector', vectorMask: { paths: [] },
    mask: { fromVectorData: false, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
  }] }, 'separate-vector.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.equal(encoded.data[3], 100)
  assert.match(result.giaImportStatus, /没有可烘焙/)
  assert.doesNotMatch(result.giaImportStatus, /矢量蒙版已按.*栅格通道烘焙/)
})

test('PSD group opacity bake explicitly reports possible differences in overlapping descendants', async () => {
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Translucent group', opacity: .5, children: [
      { name: 'First', imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 255]) } },
      { name: 'Second', imageData: { width: 1, height: 1, data: new Uint8ClampedArray([56, 34, 12, 255]) } },
    ],
  }] }, 'group-opacity.psd', () => 'encoded')
  assert.match(result.giaImportStatus, /Translucent group.*不透明度.*重叠区域可能不同/)
})

test('PSD standalone real mask channels apply their stored pixels', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Dual mask', realMask: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
  }] }, 'dual-mask.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.deepEqual([...encoded.data], [12, 34, 56, 100])
  assert.doesNotMatch(result.giaImportStatus, /realMask.*未单独处理/)
})

test('PSD real mask takes precedence over the alternate bitmap channel without multiplying both', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Dual masks',
    mask: { fromVectorData: false, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
    realMask: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
  }] }, 'separate-mask.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.deepEqual([...encoded.data], [12, 34, 56, 0])
  assert.match(result.giaImportStatus, /多通道.*优先通道/)
})

test('PSD binary bitmap and real mask channels select the reference editor preferred channel', async () => {
  agPsd.initializeCanvas((width, height) => createCanvas(width, height),
    (width, height) => createCanvas(width, height).getContext('2d').createImageData(width, height))
  const binary = agPsd.writePsd({ width: 1, height: 1, children: [{
    name: 'Binary dual masks', left: 0, top: 0,
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
    mask: { left: 0, top: 0, fromVectorData: false,
      imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
    realMask: { left: 0, top: 0,
      imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
  }] })
  const parsed = agPsd.readPsd(binary, { useImageData: true, skipCompositeImageData: true })
  assert.equal(parsed.children[0].mask.fromVectorData, false)
  assert.equal(parsed.children[0].mask.imageData.data[0], 128)
  assert.equal(parsed.children[0].realMask.imageData.data[0], 0)
  let encoded
  const result = await convertPsdDocument(parsed, 'binary-masks.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.deepEqual([...encoded.data], [12, 34, 56, 0])
  assert.match(result.giaImportStatus, /多通道.*优先通道/)
})

test('PSD disabled preferred real masks do not fall back to the alternate bitmap channel', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{ name: 'Disabled preferred',
    mask: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
    realMask: { disabled: true, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
  }] }, 'disabled-preferred.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.deepEqual([...encoded.data], [12, 34, 56, 200])
  assert.match(result.giaImportStatus, /优先蒙版通道已禁用/)
})

test('PSD preferred masks without pixels and out-of-bounds samples use default color', async () => {
  for (const imageData of [undefined, { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) }]) {
    for (const defaultColor of [undefined, 0, 128, 255]) {
      let encoded
      await convertPsdDocument({ width: 1, height: 1, children: [{ name: 'Preferred default', left: 0, top: 0,
        mask: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
        realMask: { left: 2, top: 0, defaultColor, imageData },
        imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
      }] }, 'preferred-default.psd', pixels => { encoded = pixels; return 'encoded' })
      const expectedAlpha = defaultColor === 0 ? 0 : defaultColor === 128 ? 100 : 200
      assert.deepEqual([...encoded.data], [12, 34, 56, expectedAlpha])
    }
  }
})

test('PSD preferred parent masks compose with the child mask but ignore the alternate parent mask', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{ name: 'Preferred parent',
    mask: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
    realMask: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
    children: [{ name: 'Masked child',
      mask: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
      imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
    }],
  }] }, 'parent-preferred.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.deepEqual([...encoded.data], [12, 34, 56, 50])
  assert.match(result.giaImportStatus, /多通道.*优先通道/)
})

test('PSD vector cache warnings describe the chosen mask channel rather than its ignored alternate', async () => {
  let encoded
  const result = await convertPsdDocument({ width: 1, height: 1, children: [{ name: 'Alternate vector cache',
    vectorMask: { paths: [] },
    mask: { fromVectorData: true, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } },
    realMask: { fromVectorData: false, imageData: { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) } },
    imageData: { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 200]) },
  }] }, 'alternate-vector.psd', pixels => { encoded = pixels; return 'encoded' })
  assert.deepEqual([...encoded.data], [12, 34, 56, 100])
  assert.match(result.giaImportStatus, /没有可烘焙/)
  assert.doesNotMatch(result.giaImportStatus, /矢量蒙版已按.*烘焙/)
})

test('PSD mask and opacity copies preserve prototype-backed ImageData dimensions', async () => {
  const image = prototypeImageData(1, 1, new Uint8ClampedArray([10, 20, 30, 200]))
  assert.equal(Object.hasOwn(image, 'width'), false)
  assert.equal(Object.hasOwn(image, 'height'), false)
  const masked = applyLayerMasks(image, { name: 'pixel', left: 0, top: 0 }, [{ name: 'pixel', mask: {
    left: 0, top: 0, imageData: { width: 1, height: 1, data: new Uint8Array([128]) },
  } }], new Set())
  assert.equal(masked.width, 1)
  assert.equal(masked.height, 1)
  assert.equal(masked.data[3], 100)

  let encoded
  const converted = await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Prototype ImageData', left: 0, top: 0, opacity: 255,
    imageData: prototypeImageData(1, 1, new Uint8ClampedArray([10, 20, 30, 200])),
  }] }, 'prototype.psd', imageData => {
    encoded = imageData
    return 'encoded'
  })
  assert.equal(converted.primitiveResources[0].imageUrl, 'encoded')
  assert.equal(encoded.width, 1)
  assert.equal(encoded.height, 1)

  let opacityEncoded
  await convertPsdDocument({ width: 1, height: 1, children: [{
    name: 'Opacity group', opacity: 128, children: [{
      name: 'Prototype ImageData', left: 0, top: 0,
      imageData: prototypeImageData(1, 1, new Uint8ClampedArray([10, 20, 30, 200])),
    }],
  }] }, 'prototype-opacity.psd', imageData => {
    opacityEncoded = imageData
    return 'encoded'
  })
  assert.equal(opacityEncoded.width, 1)
  assert.equal(opacityEncoded.height, 1)
  assert.equal(opacityEncoded.data[3], 100)
})

test('PSD conversion preserves source canvas, group bounds, relative offsets, opacity and hidden pixels', async () => {
  const pixels = (width, height, alpha) => ({
    width, height, data: new Uint8ClampedArray(Array.from({ length: width * height }, () => [12, 34, 56, alpha]).flat()),
  })
  const psd = { width: 100, height: 80, children: [{
    name: 'Group', left: 10, top: 5, opacity: 128, fillOpacity: 255, children: [
      { name: 'Opaque source', left: 20, top: 10, opacity: 128, fillOpacity: 255, imageData: pixels(2, 2, 200) },
      { name: 'Hidden source', left: 40, top: 20, hidden: true, imageData: pixels(2, 2, 255) },
    ],
  }, { name: 'Empty layer', left: 70, top: 30 } ] }
  const converted = await convertPsdDocument(psd, 'layers.psd', image => `mock:${image.width}x${image.height}:${[...image.data].join(',')}`)
  const root = converted.nodes[0]
  const group = converted.nodes.find(item => item.name === 'Group')
  const opaque = converted.nodes.find(item => item.name === 'Opaque source')
  const hidden = converted.nodes.find(item => item.name === 'Hidden source')
  const empty = converted.nodes.find(item => item.name === 'Empty layer')
  assert.equal(root.width, 100)
  assert.equal(root.height, 80)
  assert.equal(root.anchorOffsetX, 0)
  assert.equal(root.anchorOffsetY, 0)
  assert.equal(group.parentId, root.id)
  assert.equal(group.width, 22)
  assert.equal(group.height, 12)
  assert.equal(group.anchorOffsetX, -19)
  assert.equal(group.anchorOffsetY, 24)
  assert.equal(opaque.parentId, group.id)
  assert.equal(opaque.anchorOffsetX, -10)
  assert.equal(opaque.anchorOffsetY, 5)
  assert.match(converted.primitiveResources.find(item => item.id === opaque.properties.imageResourceId).imageUrl, /2x2:12,34,56,50/)
  assert.equal(hidden.visible, false)
  assert.equal(empty.width, 1)
  assert.equal(empty.height, 1)
  assert.match(converted.primitiveResources.find(item => item.id === empty.properties.imageResourceId).imageUrl, /1x1:0,0,0,0/)
})

test('PSD conversion rejects unsupported channel depth and color modes before converting pixels', async () => {
  let encoded = false
  const encode = () => { encoded = true; return 'data:image/png;base64,' }
  for (const bitsPerChannel of [16, 32]) {
    await assert.rejects(convertPsdDocument({ width: 1, height: 1, bitsPerChannel, colorMode: 3, children: [] }, 'deep.psd', encode), /只支持 8 位/)
  }
  await assert.rejects(convertPsdDocument({ width: 1, height: 1, bitsPerChannel: 8, colorMode: 2, children: [] }, 'indexed.psd', encode), /颜色模式 索引色 暂不支持/)
  assert.equal(encoded, false)
})

test('PSD worker parses a generated non-empty 8-bit PSD with real ag-psd in its VM', async () => {
  const source = await readFile(new URL('../../editor-ui/look2-psd-worker.js', import.meta.url), 'utf8')
  const workerBody = source
    .replace(/^import \{ initializeCanvas, readPsd \} from 'ag-psd'\s*/m, '')
    .replace(/^import \{ convertPsdDocument, PSD_IMPORT_MAX_BYTES \} from '\.\/look2-assets\.js'\s*/m, '')
  assert.doesNotMatch(workerBody, /^import\s/m)

  const pixels = new Uint8Array([12, 34, 56, 255, 78, 90, 123, 128])
  const psdBuffer = agPsd.writePsd({ width: 2, height: 1, children: [{
    name: 'Actual 8-bit pixels', left: 0, top: 0,
    imageData: { width: 2, height: 1, data: pixels },
  }] })
  const groupMaskPsd = agPsd.writePsd({ width: 2, height: 1, children: [{
    name: 'PSD group', opacity: 128, mask: {
      top: 0, left: 0, bottom: 1, right: 2, defaultColor: 0,
      imageData: { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 128, 128, 128, 255]) },
    },
    children: [
      { name: 'Group pixels', left: 0, top: 0, imageData: { width: 2, height: 1, data: pixels } },
      { name: 'Hidden pixels', left: 0, top: 0, hidden: true, imageData: { width: 1, height: 1, data: new Uint8Array([78, 90, 123, 255]) } },
    ],
  }] })
  assert.ok(psdBuffer.byteLength > 100)

  const responses = []
  let registeredCanvasFactory = null
  let id = 0
  class WorkerOffscreenCanvas {
    constructor(width, height) {
      if (arguments.length < 2 || width === undefined || height === undefined) {
        throw new TypeError("Failed to construct 'OffscreenCanvas': Value is not of type 'unsigned long'.")
      }
      this.width = width; this.height = height; this.pixels = new Uint8Array()
    }
    getContext(kind) {
      if (kind !== '2d') return null
      return {
        createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: image => { this.pixels = new Uint8Array(image.data) },
      }
    }
    async convertToBlob({ type }) { return { type, pixels: new Uint8Array(this.pixels) } }
  }
  const workerGlobal = {
    __dependencies: {
      initializeCanvas: (factory, imageDataFactory) => {
        registeredCanvasFactory = factory
        return agPsd.initializeCanvas(factory, imageDataFactory)
      },
      readPsd: agPsd.readPsd,
      convertPsdDocument,
      PSD_IMPORT_MAX_BYTES,
    },
    OffscreenCanvas: WorkerOffscreenCanvas,
    FileReaderSync: class { readAsDataURL(blob) { return `data:${blob.type};base64,${Buffer.from(blob.pixels).toString('base64')}` } },
    ArrayBuffer,
    crypto: { randomUUID: () => `psd-vm-${++id}` },
    postMessage: value => responses.push(value),
  }
  runInNewContext(`const { initializeCanvas, readPsd, convertPsdDocument, PSD_IMPORT_MAX_BYTES } = __dependencies;\n${workerBody}`, workerGlobal)
  await workerGlobal.onmessage({ data: {
    type: 'look2:parse-psd', requestId: 'real-psd', buffer: psdBuffer, fileName: 'real-8bit.psd',
  } })
  assert.equal(responses.length, 1)
  assert.equal(responses[0].type, 'success', JSON.stringify(responses[0]))
  assert.equal(responses[0].requestId, 'real-psd')
  const importedResource = responses[0].document.primitiveResources.find(row => row.name === 'Actual 8-bit pixels')
  assert.ok(importedResource)
  const payload = Buffer.from(importedResource.imageUrl.split(',')[1], 'base64')
  assert.deepEqual([...payload], [...pixels], 'actual ag-psd ImageData reaches the Worker PNG encoder unchanged')

  await workerGlobal.onmessage({ data: {
    type: 'look2:parse-psd', requestId: 'group-mask-psd', buffer: groupMaskPsd, fileName: 'group-mask.synthetic.psd',
  } })
  assert.equal(responses[1]?.type, 'success', JSON.stringify(responses[1]))
  assert.equal(responses[1].document.nodes.length, 4)
  assert.equal(responses[1].document.nodes.some(row => row.name === 'PSD group'), true)
  assert.equal(responses[1].document.nodes.find(row => row.name === 'Hidden pixels').visible, false)
  const defaultScratchCanvas = registeredCanvasFactory(undefined, undefined)
  assert.deepEqual([defaultScratchCanvas.width, defaultScratchCanvas.height], [1, 1])
})

function psdWorkerHarness(reply) {
  const worker = {
    terminated: false,
    sent: null,
    postMessage(message, transfer) {
      this.sent = { message, transfer }
      if (reply) queueMicrotask(() => this.onmessage?.({ data: reply(message) }))
    },
    terminate() { this.terminated = true },
  }
  return worker
}

const psdWorkerDocument = () => ({ version: 12, nodes: [], primitiveResources: [], animations: [] })
const psdFile = (size = 16) => ({ name: 'fixture.psd', size, arrayBuffer: async () => new ArrayBuffer(size) })

test('PSD worker import transfers bytes, accepts only a valid response and terminates after completion', async () => {
  const worker = psdWorkerHarness(message => ({ type: 'success', requestId: message.requestId, document: psdWorkerDocument() }))
  const result = await importPsd(psdFile(), null, {
    workerUrl: '/test/look2-psd-worker.js', offscreenCanvasSupported: true, createWorker: url => {
      assert.equal(url, '/test/look2-psd-worker.js')
      return worker
    },
  })
  assert.equal(result.version, 12)
  assert.equal(worker.sent.message.type, 'look2:parse-psd')
  assert.equal(worker.sent.transfer[0], worker.sent.message.buffer)
  assert.equal(worker.terminated, true)
})

test('PSD worker timeout and AbortSignal cancel processing without returning partial state', async () => {
  const timeoutWorker = psdWorkerHarness(null)
  await assert.rejects(importPsd(psdFile(), null, {
    offscreenCanvasSupported: true, timeoutMs: 15, createWorker: () => timeoutWorker,
  }), /超过/)
  assert.equal(timeoutWorker.terminated, true)

  const controller = new AbortController()
  const abortedWorker = psdWorkerHarness(message => {
    controller.abort()
    return { type: 'success', requestId: message.requestId, document: psdWorkerDocument() }
  })
  await assert.rejects(importPsd(psdFile(), null, {
    offscreenCanvasSupported: true, signal: controller.signal, createWorker: () => abortedWorker,
  }), error => error.name === 'AbortError')
  assert.equal(abortedWorker.terminated, true)
})

test('PSD import rejects malformed worker protocol, unsupported OffscreenCanvas and oversized files', async () => {
  const malformedWorker = psdWorkerHarness(message => ({ type: 'success', requestId: message.requestId, document: { version: 11 } }))
  await assert.rejects(importPsd(psdFile(), null, {
    offscreenCanvasSupported: true, createWorker: () => malformedWorker,
  }), /文档格式无效/)
  assert.equal(malformedWorker.terminated, true)

  await assert.rejects(importPsd(psdFile(), null, { offscreenCanvasSupported: false, createWorker: () => { throw new Error('must not start') } }), /OffscreenCanvas/)
  await assert.rejects(importPsd(psdFile(PSD_IMPORT_MAX_BYTES + 1), null, { offscreenCanvasSupported: true, createWorker: () => { throw new Error('must not start') } }), /128 MB/)
})

test('Spine 3.8 import preserves bone/slot hierarchy and bakes Bezier curves at 30 Hz', async () => {
  const result = await importSpine(spineFiles())
  const root = result.nodes[0], bone = result.nodes.find(node => node.properties?.spineBone === 'root')
  const slot = result.nodes.find(node => node.properties?.spineSlot === 'slot')
  const image = result.nodes.find(node => node.type === 'primitive')
  assert.ok(bone && slot && image)
  assert.equal(bone.parentId, root.id)
  assert.equal(slot.parentId, bone.id)
  assert.equal(image.parentId, slot.id)
  assert.equal(image.properties.imageResourceId, result.primitiveResources[0].id)
  const move = result.animations[0].keyframeTracks.find(track => track.nodeId === bone.id && track.fieldKey === 'anchoredPositionX')
  assert.equal(move.keyframes.length, 31)
  assert.equal(move.keyframes[0].value, bone.anchorOffsetX)
  assert.equal(move.keyframes.at(-1).value, bone.anchorOffsetX + 90)
  assert.equal(result.animations[0].events[0].name, 'step')
  assert.equal(result.animations[0].events[0].params, '{"int":1}')
})

test('Spine omitted image paths resolve to the attachment key for loose images', async () => {
  const [skeletonFile, image] = spineFiles()
  const spine = JSON.parse(await skeletonFile.text())
  delete spine.skins[0].attachments.slot.region.path
  const result = await importSpine([makeFile('skeleton.json', JSON.stringify(spine)), image])
  assert.equal(result.primitiveResources.length, 1)
  assert.equal(result.primitiveResources[0].name, 'region')
  assert.equal(result.primitiveResources[0].imageUrl,
    `data:image/png;base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`)
  assert.equal(result.nodes.find(node => node.type === 'primitive').properties.imageResourceId,
    result.primitiveResources[0].id)
})

test('Spine omitted image paths select and crop the attachment key from an atlas', async () => {
  const [skeletonFile] = spineFiles()
  const spine = JSON.parse(await skeletonFile.text())
  spine.skins[0].attachments.slot.region = { width: 1, height: 1 }
  const atlas = makeFile('character.atlas', 'sheet.png\nsize: 2,1\nregion\n  rotate: false\n  xy: 1,0\n  size: 1,1\n  orig: 1,1\n  offset: 0,0\n', 'text/plain')
  const sheet = createCanvas(2, 1)
  const context = sheet.getContext('2d')
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1)
  context.fillStyle = '#00ff00'; context.fillRect(1, 0, 1, 1)
  const image = makeFile('sheet.png', sheet.toBuffer('image/png'), 'image/png')
  const originalGlobals = ['document', 'createImageBitmap'].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  try {
    globalThis.document = { createElement: () => createCanvas(1, 1) }
    globalThis.createImageBitmap = async file => loadImage(Buffer.from(await file.arrayBuffer()))
    const result = await importSpine([makeFile('skeleton.json', JSON.stringify(spine)), atlas, image])
    assert.equal(result.primitiveResources.length, 1)
    const cropped = await loadImage(result.primitiveResources[0].imageUrl)
    assert.equal(cropped.width, 1)
    assert.equal(cropped.height, 1)
    const output = createCanvas(1, 1)
    const outputContext = output.getContext('2d')
    outputContext.drawImage(cropped, 0, 0)
    assert.deepEqual([...outputContext.getImageData(0, 0, 1, 1).data], [0, 255, 0, 255])
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
})

// Fixed pixel layouts represent atlas packing; they do not reuse the importer's transforms.
for (const [rotation, packedRows] of [
  ['false', [[0, 1, 2], [3, 4, 5]]],
  ['true', [[2, 5], [1, 4], [0, 3]]],
  ['90', [[2, 5], [1, 4], [0, 3]]],
  ['180', [[5, 4, 3], [2, 1, 0]]],
  ['270', [[3, 0], [4, 1], [5, 2]]],
]) {
  for (const padded of [false, true]) {
    test(`Spine atlas rotate:${rotation} restores asymmetric edge pixels${padded ? ' with trim offsets' : ''}`, async () => {
      const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]]
      const width = padded ? 7 : 3, height = padded ? 6 : 2
      const offsetX = padded ? 2 : 0, offsetY = padded ? 1 : 0
      const [skeletonFile] = spineFiles()
      const spine = JSON.parse(await skeletonFile.text())
      spine.skins[0].attachments.slot.region = { width, height }
      const sheetWidth = packedRows[0].length + 1, sheetHeight = packedRows.length + 1
      const atlas = makeFile('character.atlas', `sheet.png\nsize: ${sheetWidth},${sheetHeight}\nregion\n  rotate: ${rotation}\n  xy: 1,1\n  size: 3,2\n  orig: ${width},${height}\n  offset: ${offsetX},${offsetY}\n`, 'text/plain')
      const sheet = createCanvas(sheetWidth, sheetHeight)
      const context = sheet.getContext('2d')
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, sheetWidth, sheetHeight)
      for (let y = 0; y < packedRows.length; y++) {
        for (let x = 0; x < packedRows[y].length; x++) {
          context.fillStyle = `rgb(${colors[packedRows[y][x]].join(',')})`
          context.fillRect(x + 1, y + 1, 1, 1)
        }
      }
      const image = makeFile('sheet.png', sheet.toBuffer('image/png'), 'image/png')
      const originalGlobals = ['document', 'createImageBitmap'].map(name =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)])
      try {
        globalThis.document = { createElement: () => createCanvas(1, 1) }
        globalThis.createImageBitmap = async file => loadImage(Buffer.from(await file.arrayBuffer()))
        const result = await importSpine([makeFile('skeleton.json', JSON.stringify(spine)), atlas, image])
        assert.equal(result.primitiveResources.length, 1)
        const cropped = await loadImage(result.primitiveResources[0].imageUrl)
        assert.equal(cropped.width, width)
        assert.equal(cropped.height, height)
        const output = createCanvas(width, height)
        const outputContext = output.getContext('2d')
        outputContext.drawImage(cropped, 0, 0)
        const expected = new Uint8ClampedArray(width * height * 4)
        const top = height - offsetY - 2
        for (let i = 0; i < colors.length; i++) {
          expected.set([...colors[i], 255], ((top + Math.floor(i / 3)) * width + offsetX + i % 3) * 4)
        }
        assert.deepEqual([...outputContext.getImageData(0, 0, width, height).data], [...expected])
      } finally {
        for (const [name, descriptor] of originalGlobals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else delete globalThis[name]
        }
      }
    })
  }
}

test('Spine image matching preserves dotted stems and strips only known image extensions', async () => {
  const cases = [
    { path: 'region.synthetic', fileName: 'region.synthetic.png', type: 'image/png' },
    { path: 'art/region.synthetic.jpg', fileName: 'region.synthetic.jpg', relativePath: 'character/art/region.synthetic.jpg', type: 'image/jpeg' },
  ]
  for (const sample of cases) {
    const [skeletonFile] = spineFiles()
    const spine = JSON.parse(await skeletonFile.text())
    spine.skins[0].attachments.slot.region.path = sample.path
    const image = makeFile(sample.fileName, Uint8Array.of(137, 80, 78, 71), sample.type)
    if (sample.relativePath) Object.defineProperty(image, 'webkitRelativePath', { value: sample.relativePath })
    const result = await importSpine([makeFile('skeleton.json', JSON.stringify(spine)), image])
    assert.equal(result.primitiveResources.length, 1)
    assert.match(result.primitiveResources[0].imageUrl, /^data:image\//)
  }
})

test('Spine Bezier samples stay on 30 Hz boundaries when the segment does not align to a frame', async () => {
  const files = spineFiles()
  const spine = JSON.parse(await files[0].text())
  spine.animations.walk.bones.root.translate = [
    { time: .02, x: 0, y: 0, curve: [.25, .1, .75, .9] }, { time: .955, x: 10, y: 0 },
  ]
  const result = await importSpine([makeFile('skeleton.json', JSON.stringify(spine)), files[1]])
  const move = result.animations[0].keyframeTracks.find(track => track.fieldKey === 'anchoredPositionX')
  for (let index = 1; index < move.keyframes.length - 1; index += 1) {
    assert.ok(Math.abs(move.keyframes[index].time - move.keyframes[index - 1].time - 1 / 30) < 1e-9)
  }
  assert.ok(move.keyframes.at(-1).time - move.keyframes.at(-2).time < 1 / 30)
  assert.equal(move.keyframes.at(-1).time, .955)
})

test('Spine importer rejects unsupported attachments and unresolved regions instead of dropping them', async () => {
  const mesh = spineFiles({ skins: [{ name: 'default', attachments: { slot: { region: { type: 'mesh', path: 'region' } } } }] })
  await assert.rejects(importSpine(mesh), /只接受 region 附件/)
  const missing = spineFiles({ skins: [{ name: 'default', attachments: { slot: { region: { path: 'missing', width: 20, height: 10 } } } }] })
  await assert.rejects(importSpine(missing), /图片缺失/)
  const missingAnimated = spineFiles({ animations: { walk: { slots: { slot: { attachment: [{ time: 0, name: 'absent' }] } } } } })
  await assert.rejects(importSpine(missingAnimated), /不存在的附件/)
  const badEvent = spineFiles({ animations: { walk: { events: [{ time: null, name: 'step' }] } } })
  await assert.rejects(importSpine(badEvent), /非法事件时间/)
})

test('Spine importer warns for setup shear, constraints, cross-bone slots and draw order timelines', async () => {
  const result = await importSpine(spineFiles({
    bones: [{ name: 'root', shearX: 12 }, { name: 'child', parent: 'root' }],
    slots: [
      { name: 'slot', bone: 'root', attachment: 'region', blend: 'additive', dark: '000000' },
      { name: 'child-slot', bone: 'child', attachment: null },
    ],
    skins: [{ name: 'default', bones: ['child'], attachments: { slot: { region: { path: 'region', width: 20, height: 10 } }, 'child-slot': {} } }],
    ik: [{ name: 'leg constraint' }],
    transform: [{ name: 'weapon constraint' }],
    path: [{ name: 'path constraint' }],
    animations: { walk: {
      bones: { root: { shear: [{ time: 0, x: 3, y: 4 }] } },
      draworder: [{ time: .5, offsets: [{ slot: 'slot', offset: 1 }] }],
    } },
  }))
  const status = result.giaImportStatus
  assert.match(status, /setup shear/)
  assert.match(status, /含 shear 轨道/)
  assert.match(status, /IK 约束.*leg constraint/)
  assert.match(status, /transform 约束.*weapon constraint/)
  assert.match(status, /path 约束.*path constraint/)
  assert.match(status, /跨骨骼全局显示顺序可能不同/)
  assert.match(status, /插槽 draw order 变化/)
  assert.match(status, /双色 tint/)
  assert.match(status, /additive 混合/)
})

test('Spine importer accepts only precise 3.8 version strings', async () => {
  for (const spineVersion of ['3.8', '3.8.99']) {
    const result = await importSpine(spineFiles({ skeleton: { spine: spineVersion, width: 100, height: 100 } }))
    assert.equal(result.nodes[0].name, 'skeleton')
  }
  for (const spineVersion of ['3.80.1', '3.8x', '3.8.99-beta', '3.9.0', 3.8, null]) {
    await assert.rejects(importSpine(spineFiles({ skeleton: { spine: spineVersion, width: 100, height: 100 } })), /只支持版本号为 3\.8/)
  }
})
