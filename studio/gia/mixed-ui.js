import protobuf from 'protobufjs'

const HEADER_BYTES = 20
const TAIL_BYTES = 4
const TAIL_TAG = 0x0679

function unitId(bytes) {
  const reader = protobuf.Reader.create(bytes)
  let id = 0
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    if ((tag >>> 3) === 4 && (tag & 7) === 0) id = reader.int32()
    else reader.skipType(tag & 7)
  }
  return id
}

function describeUnit(bytes, field) {
  const reader = protobuf.Reader.create(bytes)
  const unit = { field, bytes, id: 0, relatedIds: [], name: '', which: 0 }
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const key = tag >>> 3
    const wire = tag & 7
    if (wire === 2 && key === 1) unit.id = unitId(reader.bytes())
    else if (wire === 2 && key === 2) unit.relatedIds.push(unitId(reader.bytes()))
    else if (wire === 2 && key === 3) unit.name = Buffer.from(reader.bytes()).toString('utf8')
    else if (wire === 0 && key === 5) unit.which = reader.int32()
    else reader.skipType(wire)
  }
  return unit
}

function readUnits(payload) {
  const reader = protobuf.Reader.create(payload)
  const units = []
  const metadata = []
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 2 && (field === 1 || field === 2)) {
      units.push(describeUnit(reader.bytes(), field))
    } else if (wire === 2 && field >= 3 && field <= 5) {
      metadata.push({ field, bytes: reader.bytes() })
    } else {
      reader.skipType(wire)
    }
  }
  return { units, metadata }
}

// A level-wide GIA can contain arbitrary graph schemas. Decode only the
// top-level wire framing before passing UI units to the strict UI codec.
export function extractSupportedUiGia(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < HEADER_BYTES + TAIL_BYTES) return { buffer, mixed: false }
  const payload = buffer.subarray(HEADER_BYTES, -TAIL_BYTES)
  const { units, metadata } = readUnits(payload)
  const graphs = units.filter((unit) => unit.field === 1)
  const groups = graphs.filter((unit) => unit.which === 21)
  const templates = graphs.filter((unit) => unit.which === 70)
  const mixed = groups.length > 1 || graphs.some((unit) => ![21, 69, 70].includes(unit.which))
  if (!mixed) return { buffer, mixed: false }

  const group = groups.find((unit) => unit.name === '客户端控件容器')
  if (!group && !templates.length) {
    throw new Error('混合 GIA 中未找到 Look 支持的客户端控件容器或客户端模板')
  }
  const selectedGraphs = [...(group ? [group] : []), ...templates, ...graphs.filter((unit) => unit.which === 69)]
  const relatedIds = new Set(selectedGraphs.flatMap((unit) => unit.relatedIds))
  const accessories = units.filter((unit) => unit.field === 2 && unit.which === 15)
  const selectedAccessories = []
  for (let changed = true; changed;) {
    changed = false
    for (const unit of accessories) {
      if (!relatedIds.has(unit.id) || selectedAccessories.includes(unit)) continue
      selectedAccessories.push(unit)
      for (const id of unit.relatedIds) relatedIds.add(id)
      changed = true
    }
  }
  const writer = protobuf.Writer.create()
  for (const unit of [...selectedGraphs, ...selectedAccessories]) {
    writer.uint32((unit.field << 3) | 2).bytes(unit.bytes)
  }
  for (const entry of metadata) writer.uint32((entry.field << 3) | 2).bytes(entry.bytes)
  const body = Buffer.from(writer.finish())
  const extracted = Buffer.alloc(HEADER_BYTES + body.length + TAIL_BYTES)
  extracted.writeUInt32BE(extracted.length, 0)
  buffer.copy(extracted, 4, 4, HEADER_BYTES)
  extracted.writeUInt32BE(body.length, 16)
  body.copy(extracted, HEADER_BYTES)
  extracted.writeUInt32BE(TAIL_TAG, HEADER_BYTES + body.length)
  return {
    buffer: extracted,
    mixed: true,
    groupNames: groups.map((unit) => unit.name),
    selectedGroup: group?.name || '',
    templateCount: templates.length,
    skippedGroupCount: groups.length - (group ? 1 : 0),
  }
}
