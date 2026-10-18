import { CANVAS_PRESETS, PLATFORMS } from '../constants.js'
import { createDefaultClientTemplateProject, createNode } from '../ui/authoring.js'
import { createRectTransform } from '../ui/layout.js'
import { SITE_TYPE_TO_KIND, KIND_TO_SITE_TYPE, readSiteProperties, writeSiteProperties } from './site-fields.js'

const colors = ['imageColor', 'fontColor', 'bgColor', 'outlineColor']
function pack(value) {
  if (!value || typeof value !== 'object') return value
  return ((Math.round((value.a ?? 1) * 255) << 24) | (value.r << 16) | (value.g << 8) | value.b) >>> 0
}
function unpack(value) {
  if (typeof value !== 'number') return value
  return { r: value >>> 16 & 255, g: value >>> 8 & 255, b: value & 255, a: (value >>> 24 & 255) / 255 }
}

function transform(layout) {
  const rt = createRectTransform()
  for (const [part, x, y, z] of [
    ['anchorMin', 'anchorMinX', 'anchorMinY'], ['anchorMax', 'anchorMaxX', 'anchorMaxY'],
    ['pivot', 'pivotX', 'pivotY'], ['offset', 'anchoredPositionX', 'anchoredPositionY'],
    ['size', 'sizeDeltaX', 'sizeDeltaY'], ['scale', 'scaleX', 'scaleY', 'scaleZ'],
    ['rotation', 'rotationX', 'rotationY', 'rotationZ'],
  ]) {
    rt[part].x = layout[x]; rt[part].y = layout[y]
    if (z) rt[part].z = layout[z]
  }
  return rt
}

/** Read-only migration of the reference's four-device library into shared trees. */
export function normalizeSiteTemplate(entry) {
  if (!Object.hasOwn(entry || {}, 'devices')) return entry
  return { ...entry, project: entry.project?.root ? entry.project : buildSiteTemplateProject(entry), scripts: entry.scripts || [] }
}

function buildSiteTemplateProject(entry, deviceIndex = 0) {
  if (!entry.id || !String(entry.name || '').trim() || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index > 0x7fffffff
    || !Array.isArray(entry.devices) || entry.devices.length !== 4) throw new Error('控件模板库格式无效')
  const devices = entry.devices.map(rows => {
    if (!Array.isArray(rows) || !rows.length) throw new Error(`模板“${entry.name}”没有控件`)
    const map = new Map()
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.sourceNodeIndex) || map.has(row.sourceNodeIndex) || !SITE_TYPE_TO_KIND[row.type]
        || !row.layout || !row.properties || typeof row.name !== 'string'
        || row.parentSourceNodeIndex !== null && !Number.isSafeInteger(row.parentSourceNodeIndex)
        || row.visible !== undefined && typeof row.visible !== 'boolean'
        || typeof row.layout.active !== 'boolean' || !Array.isArray(row.childSourceNodeIndices)
        || !row.childSourceNodeIndices.every(Number.isSafeInteger)) throw new Error('模板控件数据无效')
      for (const key of ['scaleX', 'scaleY', 'scaleZ', 'rotationX', 'rotationY', 'rotationZ', 'anchorMinX', 'anchorMinY',
        'anchorMaxX', 'anchorMaxY', 'anchoredPositionX', 'anchoredPositionY', 'sizeDeltaX', 'sizeDeltaY', 'pivotX', 'pivotY']) {
        if (!Number.isFinite(row.layout[key])) throw new Error('模板控件布局无效')
      }
      map.set(row.sourceNodeIndex, row)
    }
    return map
  })
  // Template resources may have different properties, visibility and even
  // topology on each platform. Select its own hierarchy before instantiation.
  const first = devices[deviceIndex], nodes = new Map()
  for (const [id, row] of first) {
    const kind = SITE_TYPE_TO_KIND[row.type], properties = readSiteProperties(kind, row.properties)
    for (const key of colors) if (properties[key] != null) properties[key] = pack(properties[key])
    const transformByPlatform = Object.fromEntries(PLATFORMS.map((platform, index) => {
      const device = devices[index].get(id) || row
      return [platform, transform(device.layout)]
    }))
    nodes.set(id, createNode(kind, { ...properties, id: `gia_node_${id}`, guid: id,
      name: row.name, active: row.layout.active, visible: row.visible !== false, transformByPlatform, syncAllDevices: false }))
  }
  const project = createDefaultClientTemplateProject()
  project.meta.name = entry.name; project.meta.sourceFormat = 'site-template'; project.root.children = []
  for (const [id, row] of first) {
    const node = nodes.get(id), parent = nodes.get(row.parentSourceNodeIndex)
    if (parent) parent.children.push(node)
    else if (row.parentSourceNodeIndex == null || !first.has(row.parentSourceNodeIndex)) project.root.children.push(node)
  }
  if (!project.root.children.length) throw new Error('模板控件层级存在循环')
  const visited = new Set(), visiting = new Set()
  const visit = node => {
    if (visiting.has(node.id)) throw new Error('模板控件层级存在循环')
    if (visited.has(node.id)) return
    visiting.add(node.id)
    const row = first.get(Number(node.id.slice('gia_node_'.length)))
    const order = new Map([...row.childSourceNodeIndices].reverse().map((id, index) => [id, index]))
    node.children.sort((a, b) => (order.get(a.guid) ?? Infinity) - (order.get(b.guid) ?? Infinity))
    for (const child of node.children) visit(child)
    visiting.delete(node.id); visited.add(node.id)
  }
  for (const root of project.root.children) visit(root)
  if (visited.size !== first.size) throw new Error('模板控件层级包含循环或不可达控件')
  project.selectedId = project.root.children[0].id
  return project
}

export function normalizeSiteTemplates(entries) {
  const ids = new Set(), indices = new Set()
  return entries.map(entry => {
    if (entry?.id && ids.has(entry.id) || Number.isSafeInteger(entry?.index) && indices.has(entry.index)) throw new Error('控件模板 ID 或索引重复')
    if (entry?.id) ids.add(entry.id)
    if (Number.isSafeInteger(entry?.index)) indices.add(entry.index)
    const normalized = normalizeSiteTemplate(entry)
    if (entry?.devices) for (let index = 0; index < 4; index++) buildSiteTemplateProject(entry, index)
    return normalized
  })
}

export function projectForSiteTemplate(entry, canvasId = 'pc-16-9') {
  if (!entry?.devices) return entry?.project
  const platform = CANVAS_PRESETS[canvasId]?.platform || 'KEYBOARD'
  return buildSiteTemplateProject(entry, Math.max(0, PLATFORMS.indexOf(platform)))
}

/** Keep both the reference library representation and local script extensions. */
export function exportSiteTemplates(entries) {
  return entries.map(entry => {
    // Imported device trees are immutable source data: library operations only
    // rename/reindex or create copies. Preserve their opaque per-device fields.
    if (entry.devices) return entry
    if (!entry.project?.root) return entry
    const nodes = [], ids = new Map(), used = new Set()
    const collect = node => {
      let id = Number(node.guid)
      if (!Number.isSafeInteger(id) || id <= 0 || used.has(id)) { id = 1; while (used.has(id)) id++ }
      ids.set(node.id, id); used.add(id); nodes.push(node)
      for (const child of node.children || []) collect(child)
    }
    for (const root of entry.project.root.children || []) collect(root)
    const parents = new Map()
    for (const node of nodes) for (const child of node.children || []) parents.set(child.id, node.id)
    const devices = PLATFORMS.map(platform => nodes.map(node => {
      const rt = node.transformByPlatform[platform], properties = writeSiteProperties(node)
      for (const key of colors) if (node[key] !== undefined) properties[key] = unpack(node[key])
      return { sourceNodeIndex: ids.get(node.id), parentSourceNodeIndex: ids.get(parents.get(node.id)) ?? null,
        childSourceNodeIndices: [...(node.children || [])].reverse().map(child => ids.get(child.id)),
        name: node.name, type: KIND_TO_SITE_TYPE[node.kind], visible: node.visible !== false, properties,
        layout: { active: node.active !== false, scaleX: rt.scale.x, scaleY: rt.scale.y, scaleZ: rt.scale.z,
          rotationX: rt.rotation.x, rotationY: rt.rotation.y, rotationZ: rt.rotation.z,
          anchorMinX: rt.anchorMin.x, anchorMinY: rt.anchorMin.y, anchorMaxX: rt.anchorMax.x, anchorMaxY: rt.anchorMax.y,
          anchoredPositionX: rt.offset.x, anchoredPositionY: rt.offset.y, sizeDeltaX: rt.size.x, sizeDeltaY: rt.size.y,
          pivotX: rt.pivot.x, pivotY: rt.pivot.y } }
    }))
    return { ...entry, sourceName: entry.sourceName || entry.filename || '', warnings: entry.warnings || [], devices }
  })
}
