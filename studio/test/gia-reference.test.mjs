import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudio } from '../index.js'
import { importGia, exportGia, inspectGia } from '../gia/codec.js'
import { createGiaRaw } from '../gia/raw-fields.js'

// Synthetic wire cases, not a claimed native non-empty reference schema.
// Field 77 is only known to be length-delimited; arbitrary bytes must survive
// without being validated as UTF-8 or guessed to be a particular target GUID.
const cat = (...parts) => Buffer.concat(parts)
const vi = value => {
  const out = []
  do { out.push((value % 128) | (value >= 128 ? 128 : 0)); value = Math.floor(value / 128) } while (value)
  return Buffer.from(out)
}
const msg = (field, bytes) => cat(vi(field * 8 + 2), vi(bytes.length), bytes)
const num = (field, value) => cat(vi(field * 8), vi(value))
const str = (field, value) => msg(field, Buffer.from(value))
const slot = (field, bytes) => msg(505, msg(503, msg(field, bytes)))
const REF_GUID = 1073744900
const SCRIPT_GUID = 1500000000

function envelope(payload) {
  const head = Buffer.alloc(20), tail = Buffer.alloc(4)
  ;[payload.length + 20, 1, 0x326, 3, payload.length].forEach((value, i) => head.writeUInt32BE(value, i * 4))
  tail.writeUInt32BE(0x679)
  return cat(head, payload, tail)
}

function reference({ inner = Buffer.alloc(0), outer = Buffer.alloc(0), mount = false, transform = true } = {}) {
  const rect = slot(13, msg(12, msg(501, msg(502, msg(508, Buffer.alloc(0))))))
  const content = cat(num(501, REF_GUID), transform ? rect : Buffer.alloc(0),
    msg(505, cat(msg(76, outer), num(501, 66), num(502, 89), msg(503, msg(77, inner)))),
    mount ? slot(74, msg(502, msg(1, num(1, SCRIPT_GUID)))) : Buffer.alloc(0))
  return cat(msg(1, cat(num(2, 1), num(3, 8), num(4, REF_GUID))), str(3, 'Reference'), num(5, 70), msg(19, msg(1, content)))
}

function fields(buffer) {
  let offset = 0
  const read = () => {
    let value = 0, scale = 1, byte
    do { byte = buffer[offset++]; value += (byte & 127) * scale; scale *= 128 } while (byte & 128)
    return value
  }
  const out = []
  while (offset < buffer.length) {
    const tag = read(), wire = tag & 7
    let value
    if (wire === 0) value = read()
    else { const length = wire === 2 ? read() : wire === 5 ? 4 : 8; value = buffer.subarray(offset, offset + length); offset += length }
    out.push([Math.floor(tag / 8), value])
  }
  return out
}
const all = (bytes, field) => fields(bytes).filter(([key]) => key === field).map(([, value]) => value)
const first = (bytes, field) => all(bytes, field)[0] ?? Buffer.alloc(0)

function referenceSlot(bytes) {
  const unit = first(bytes.subarray(20, -4), 1)
  const data = all(first(first(unit, 19), 1), 505).find(row => first(row, 501) === 66)
  return { outer: first(data, 76), inner: first(first(data, 503), 77) }
}

function findNode(root, id) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (node?.id === id) return node
    pending.push(...(node?.children || []))
  }
  return null
}

function firstReference(root) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (node?.kind === 'reference') return node
    pending.push(...(node?.children || []))
  }
  return null
}

function configureLegacyMixedReference(archive, inner, outer) {
  const node = findNode(archive.assets.server.root, 'n4')
  node.referencedPrefabId = inner
  node.giaRaw.templateRefSlot = inner
  delete node.giaRaw.templateRefSlotBase64
  node.giaRaw.templateRefOuterBase64 = outer.toString('base64')
  return node
}

function assertReferenceWire(project, inner, outer) {
  const output = exportGia(project).buffer
  const restored = firstReference(importGia(output).project.root)
  assert.ok(restored, 'exported GIA should retain a reference control')
  assert.equal(restored.giaRaw.templateRefSlotBase64, inner.toString('base64'))
  assert.equal(restored.giaRaw.templateRefOuterBase64, outer.toString('base64'))
}

function scriptUnit() {
  return cat(msg(1, cat(num(2, 30), num(4, SCRIPT_GUID))), str(3, 'dependency'), num(5, 69),
    msg(35, msg(1, cat(num(1, SCRIPT_GUID), str(2, 'dependency'), str(3, 'dependency.lua'), str(5, 'return {}')))))
}

function clientControlGroup() {
  return cat(msg(1, cat(num(2, 1), num(3, 8), num(4, 41))), str(3, '客户端控件容器'), num(5, 21),
    msg(19, msg(1, num(501, 41))))
}

function primitiveGroup() {
  return cat(msg(1, cat(num(2, 1), num(3, 8), num(4, 61))), str(3, '图元素材组'), num(5, 61))
}

test('opaque template reference bytes survive import, JSON reload, edits and GIA export', () => {
  const inner = Buffer.from('a81f9482808004', 'hex')
  const outer = Buffer.from('ff0080', 'hex')
  const input = envelope(msg(1, reference({ inner, outer })))
  assert.equal(inspectGia(input).templateCount, 1)
  const imported = importGia(input)
  const node = imported.project.root.children[0]
  assert.equal(node.kind, 'reference')
  assert.equal(node.referencedPrefabId, '', 'do not invent a target from opaque bytes')
  assert.equal(node.giaRaw.templateRefSlotBase64, inner.toString('base64'))
  assert.ok(imported.warnings.some(line => line.includes('原始字节')))

  let studio = createStudio(imported.project)
  studio.patch({ op: 'set', id: node.id, key: 'name', value: 'Renamed' })
  studio.patch({ op: 'set', id: node.id, key: 'width', value: 160 })
  studio = createStudio(JSON.parse(Buffer.from(studio.exportData('save').data, 'base64')))
  const before = studio.archiveData()
  assert.throws(() => studio.patch({ op: 'set', id: node.id, key: 'referencedPrefabId', value: '1073742100' }), /原始配置/)
  assert.throws(() => studio.patch({ op: 'set', id: node.id, key: 'giaRaw.templateRefSlot', value: '1073742100' }), /原始配置/)
  assert.deepEqual(studio.archiveData(), before, 'unsupported binding edits must be atomic')

  const output = Buffer.from(studio.exportData('gia').data, 'base64')
  assert.deepEqual(referenceSlot(output), { inner, outer })
  const restored = importGia(output).project.root.children[0]
  assert.equal(restored.name, 'Renamed')
  assert.equal(restored.transformByPlatform.KEYBOARD.size.x, 160)
})

test('empty and legacy textual template reference slots keep their current behavior', () => {
  for (const text of ['', '1073742100', 'template-index-2008']) {
    const inner = Buffer.from(text)
    const imported = importGia(envelope(msg(1, reference({ inner }))))
    assert.equal(imported.project.root.children[0].referencedPrefabId, text)
    assert.deepEqual(referenceSlot(exportGia(imported.project).buffer).inner, inner)
  }
})

test('unrecognized printable template reference bytes stay opaque and reject binding edits', () => {
  const inner = Buffer.from('future-template-reference')
  const input = envelope(msg(1, reference({ inner })))
  const imported = importGia(input)
  const node = imported.project.root.children[0]
  assert.equal(node.referencedPrefabId, '')
  assert.equal(node.giaRaw.templateRefSlotBase64, inner.toString('base64'))

  const studio = createStudio(imported.project)
  const before = studio.archiveData()
  assert.throws(() => studio.patch({ op: 'set', id: node.id, key: 'referencedPrefabId', value: '1073742100' }), /原始配置/)
  assert.deepEqual(studio.archiveData(), before)
  const saved = createStudio(JSON.parse(Buffer.from(studio.exportData('save').data, 'base64')))
  assert.deepEqual(referenceSlot(Buffer.from(saved.exportData('gia').data, 'base64')).inner, inner)
})

test('non-empty outer template-reference bytes make a numeric inner slot opaque', () => {
  const inner = Buffer.from('1073742100')
  const outer = Buffer.from([0xff, 0x00, 0x80, 0x7f])
  const imported = importGia(envelope(msg(1, reference({ inner, outer }))))
  const node = imported.project.root.children[0]
  assert.equal(node.referencedPrefabId, '')
  assert.equal(node.giaRaw.templateRefSlot, '')
  assert.equal(node.giaRaw.templateRefSlotBase64, inner.toString('base64'))
  assert.equal(node.giaRaw.templateRefOuterBase64, outer.toString('base64'))

  let studio = createStudio(imported.project)
  studio.patch({ op: 'set', id: node.id, key: 'name', value: 'outer-byte binding' })
  studio = createStudio(JSON.parse(Buffer.from(studio.exportData('save').data, 'base64')))
  const restored = importGia(Buffer.from(studio.exportData('gia').data, 'base64')).project.root.children[0]
  assert.equal(restored.referencedPrefabId, '')
  assert.deepEqual(Buffer.from(restored.giaRaw.templateRefSlotBase64, 'base64'), inner)
  assert.deepEqual(Buffer.from(restored.giaRaw.templateRefOuterBase64, 'base64'), outer)
})

test('control GUID changes do not rewrite a legacy mixed opaque reference after save reload', () => {
  const outer = Buffer.from([0x9a, 0x00, 0xff, 0x31])
  const archive = createStudio().archiveData()
  const targetGuid = findNode(archive.assets.server.root, 'n2').guid
  const inner = Buffer.from(String(targetGuid))
  configureLegacyMixedReference(archive, inner.toString('utf8'), outer)

  const studio = createStudio(JSON.parse(JSON.stringify(archive)))
  const nextGuid = 1073741990
  studio.patch({ op: 'setControlGuid', id: 'n2', guid: nextGuid, expectedRevision: studio.get().version })
  const saved = studio.archiveData()
  const referenceNode = findNode(saved.assets.server.root, 'n4')
  assert.equal(findNode(saved.assets.server.root, 'n2').guid, nextGuid)
  assert.equal(referenceNode.referencedPrefabId, inner.toString('utf8'))
  assert.equal(referenceNode.giaRaw.templateRefSlot, inner.toString('utf8'))
  assert.equal(referenceNode.giaRaw.templateRefOuterBase64, outer.toString('base64'))
  assertReferenceWire(saved.assets.server, inner, outer)
})

test('template-index changes do not rewrite a legacy mixed opaque reference after save reload', () => {
  const outer = Buffer.from([0xa8, 0x01, 0x80, 0x00])
  const archive = createStudio().archiveData()
  const inner = Buffer.from('2008')
  configureLegacyMixedReference(archive, inner.toString('utf8'), outer)
  const studio = createStudio(JSON.parse(JSON.stringify(archive)))
  const source = createStudio().exportData('gia', 'client-control-template')
  studio.template({ action: 'import', data: source.data, index: 2008, name: '重编号模板', expectedRevision: studio.get().version })
  const template = studio.archiveData().look2.controlTemplates[0]
  studio.template({ action: 'update', id: template.id, index: 2009, expectedRevision: studio.get().version })

  const saved = studio.archiveData()
  const referenceNode = findNode(saved.assets.server.root, 'n4')
  assert.equal(referenceNode.referencedPrefabId, '2008')
  assert.equal(referenceNode.giaRaw.templateRefSlot, '2008')
  assert.equal(referenceNode.giaRaw.templateRefOuterBase64, outer.toString('base64'))
  assertReferenceWire(saved.assets.server, inner, outer)
})

test('non-UI resources are skipped and accessory script mappings keep client mounts', () => {
  const dependency = cat(msg(1, num(4, 1500000001)), str(3, 'unsupported resource'), num(5, 123))
  for (const scriptLocation of [1, 2]) {
    const input = envelope(cat(msg(1, reference({ mount: true })), msg(scriptLocation, scriptUnit()), msg(2, dependency)))
    const imported = importGia(input)
    assert.equal(imported.project.root.children.length, 1)
    assert.equal(imported.scripts.length, 1)
    assert.ok(imported.warnings.some(line => line.includes('跳过 1 个非 UI')))

    const target = createStudio()
    const result = target.importData('gia', input.toString('base64'), 'reference.gia')
    const script = result.snapshot.scripts.find(row => row.path === 'dependency.lua')
    assert.equal(script.controlAsset, 'client-control-template')
    assert.equal(script.controlName, 'Reference')
    assert.equal(script.mounted, true)
  }
})

test('mixed GIA reports unsupported primitive groups separately from non-UI dependencies', () => {
  const dependency = cat(msg(1, num(4, 1500000001)), str(3, 'unsupported resource'), num(5, 123))
  const input = envelope(cat(msg(1, clientControlGroup()), msg(1, reference()), msg(1, primitiveGroup()), msg(2, dependency)))
  const imported = importGia(input)
  assert.equal(imported.project.meta.assetType, 'client-control-template')
  assert.ok(imported.warnings.some(line => line.includes('跳过 1 个尚未支持的图元素材组（which=61）')))
  assert.ok(imported.warnings.some(line => line.includes('跳过 1 个非 UI / 非脚本依赖单元')))

  assert.throws(() => importGia(envelope(msg(1, primitiveGroup()))), /尚未支持导入图元素材组（which=61）.*仅支持客户端 UI 控件容器（which=21）和客户端模板（which=70）/)
})

test('invalid UI transforms reject import without changing the existing save', () => {
  const target = createStudio()
  const before = target.archiveData()
  const input = envelope(cat(msg(1, reference({ transform: false, mount: true })), msg(2, scriptUnit())))
  assert.throws(() => target.importData('gia', input.toString('base64'), 'invalid.gia'), /缺少多平台变换/)
  assert.deepEqual(target.archiveData(), before)
})

test('opaque reference payloads stay internal, survive JSON reloads and reject non-base64', () => {
  const inner = Buffer.from([1, 2, 3, 4]).toString('base64')
  const outer = Buffer.from([9, 8]).toString('base64')
  const raw = createGiaRaw('reference', { templateRefSlotBase64: inner, templateRefOuterBase64: outer })
  assert.equal(raw.templateRefSlotBase64, inner)
  assert.equal(raw.templateRefOuterBase64, outer)

  // 空字符串表示没有可保留的字节，不写入也不会被当作模板索引。
  const empty = createGiaRaw('reference', { templateRefSlotBase64: '' })
  assert.equal(Object.hasOwn(empty, 'templateRefSlotBase64'), false)

  assert.throws(() => createGiaRaw('reference', { templateRefSlotBase64: 'not base64!!' }), /must be base64/)
  assert.throws(() => createGiaRaw('reference', { templateRefOuterBase64: 42 }), /must be base64/)

  // 只有 reference 保留这些内部字段，其他控件类型忽略它们。
  const image = createGiaRaw('image', { templateRefSlotBase64: inner })
  assert.equal(Object.hasOwn(image, 'templateRefSlotBase64'), false)
})
