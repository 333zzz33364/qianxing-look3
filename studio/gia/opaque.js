// Non-UI GraphUnits (node graphs, primitive material groups, other tools'
// assets) are opaque to the authoring model. Keep their original wire bytes so
// opening and re-saving such a GIA does not drop them.
import protobuf from 'protobufjs'

const { Reader } = protobuf

const SCRIPT_WHICH = 69

function varint(value) {
  const bytes = []
  let rest = Number(value) >>> 0
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

function lengthDelimited(field, bytes) {
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes])
}

function readVarintField(bytes, wanted) {
  const reader = Reader.create(bytes)
  let value = null
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      const current = reader.uint32()
      if (field === wanted) value = current
    } else reader.skipType(wire)
  }
  return value
}

function describeUnit(bytes, bag) {
  const reader = Reader.create(bytes)
  const unit = { bag, bytes, which: 0, guid: null, name: '' }
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 2 && field === 1) unit.guid = readVarintField(reader.bytes(), 4)
    else if (wire === 2 && field === 3) unit.name = Buffer.from(reader.bytes()).toString('utf8')
    else if (wire === 0 && field === 5) unit.which = reader.uint32()
    else reader.skipType(wire)
  }
  return unit
}

/**
 * Split a GIA payload into UI units the authoring model consumes and the
 * remaining units, which are returned verbatim.
 * `consumedGuids` lists the GUIDs the importer actually materialized, so UI
 * units belonging to groups it skipped are preserved too.
 */
export function readOpaqueUnits(input, { consumedGuids = new Set() } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < 24) return { units: [], rootFields: [] }
  const payload = buffer.subarray(20, buffer.length - 4)
  const reader = Reader.create(payload)
  const units = []
  const rootFields = []
  while (reader.pos < reader.len) {
    const start = reader.pos
    const tag = reader.uint32()
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 2 && (field === 1 || field === 2)) {
      const described = describeUnit(reader.bytes(), field === 1 ? 'graph' : 'accessories')
      const script = Number(described.which) === SCRIPT_WHICH
      const consumed = Number.isSafeInteger(described.guid) && consumedGuids.has(described.guid)
      if (!script && !consumed) {
        units.push({
          bag: described.bag,
          which: Number(described.which) || 0,
          guid: Number.isSafeInteger(described.guid) ? described.guid : null,
          name: described.name,
          base64: described.bytes.toString('base64'),
        })
      }
    } else {
      reader.skipType(wire)
      if (field >= 3 && field <= 5) continue
      rootFields.push({ field, wire, raw: payload.subarray(start, reader.pos).toString('base64') })
    }
  }
  return { units, rootFields }
}

export function opaqueUsedGuids(opaque) {
  const used = new Set()
  for (const unit of opaque?.units || []) {
    if (Number.isSafeInteger(unit.guid) && unit.guid > 0) used.add(unit.guid)
  }
  return used
}

/** Append preserved units and unknown root fields to an encoded GIA payload. */
export function appendOpaqueUnits(payload, opaque) {
  const units = opaque?.units || []
  const rootFields = opaque?.rootFields || []
  if (!units.length && !rootFields.length) return payload
  return Buffer.concat([
    payload,
    ...units.map((unit) => lengthDelimited(unit.bag === 'accessories' ? 2 : 1, Buffer.from(unit.base64, 'base64'))),
    ...rootFields.map((entry) => Buffer.from(entry.raw, 'base64')),
  ])
}

export function opaqueSummary(opaque) {
  const units = opaque?.units || []
  return {
    units: units.length,
    rootFields: (opaque?.rootFields || []).length,
    which: [...new Set(units.map((unit) => Number(unit.which) || 0))].sort((left, right) => left - right),
  }
}
