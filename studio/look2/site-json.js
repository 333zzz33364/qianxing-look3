import { CANVAS_PRESETS, DEFAULT_SIZE, PLATFORMS } from '../constants.js'
import { createDefaultClientTemplateProject, createNode } from '../ui/authoring.js'
import { createRectTransform } from '../ui/layout.js'
import { layoutTree } from '../ui/inspector.js'
import { toJson } from '../json.js'
import { projectCanvas, adoptSiteCanvas } from '../ui/canvas.js'
import { SITE_TYPE_TO_KIND, KIND_TO_SITE_TYPE, readSiteProperties, writeSiteProperties, readSiteAnimations, writeSiteAnimations } from './site-fields.js'
import { normalizeSiteTemplates, exportSiteTemplates } from './site-templates.js'
import { restoreLegacySiteMasks } from './site-gia.js'
import { migrateSiteTweenClips } from './site-legacy.js'

export const SITE_JSON_VERSION = 12
const SITE_CANVAS_FIELDS = ['deviceMode', 'previewPresetId', 'canvasWidth', 'canvasHeight']
const LEGACY_DEFAULT_SIZE_BY_SITE_TYPE = {
  primitive: [150, 150], container: [280, 180], image: [150, 150], text: [360, 90],
  textWindow: [420, 240], presetButton: [220, 72], cursorEventArea: [240, 140],
  gridScroller: [420, 300], keyHint: [180, 64], uiAnimation: [240, 140],
  fullscreenAnimation: [640, 360], reference: [320, 180],
}

const TYPE_TO_KIND = SITE_TYPE_TO_KIND

export function freshLook2() {
  return {
    version: 1,
    semanticVersion: 2,
    frameRate: 30,
    timelineSnapEnabled: true,
    activeAnimationId: 'animation-default',
    animations: [{ id: 'animation-default', name: '默认动画', duration: 5, keyframeTracks: [], events: [] }],
    controlTemplates: [], primitiveResources: [], siteNodes: {}, siteExtras: {},
  }
}

const COLOR_PROPERTY_FIELDS = ['imageColor', 'fontColor', 'bgColor', 'outlineColor']

function packSiteColor(value) {
  if (typeof value === 'number') return value >>> 0
  if (!value || typeof value !== 'object') return value
  const channel = (number, fallback) => Math.max(0, Math.min(255, Math.round(Number(number ?? fallback) || 0)))
  const alpha = Number(value.a ?? 1)
  const a = channel(alpha <= 1 ? alpha * 255 : alpha, 255)
  return ((a << 24) | (channel(value.r, 0) << 16) | (channel(value.g, 0) << 8) | channel(value.b, 0)) >>> 0
}

function unpackSiteColor(value) {
  if (typeof value !== 'number') return value
  const color = value >>> 0
  return { r: color >>> 16 & 255, g: color >>> 8 & 255, b: color & 255, a: (color >>> 24 & 255) / 255 }
}

function siteBaseValue(siteNode, fieldKey) {
  const properties = siteNode?.properties || {}
  const from = (key, fallback) => siteNode?.[key] ?? fallback
  const values = {
    anchoredPositionX: from('anchorOffsetX', 0), anchoredPositionY: from('anchorOffsetY', 0),
    sizeDeltaX: from('sizeDeltaX', 0), sizeDeltaY: from('sizeDeltaY', 0),
    localScaleX: from('scaleX', 1), localScaleY: from('scaleY', 1), localScaleZ: from('scaleZ', 1),
    localRotationX: from('rotationX', 0), localRotationY: from('rotationY', 0), localRotationZ: from('rotation', 0),
    anchorMinX: from('anchorMinX', 0.5), anchorMinY: from('anchorMinY', 0.5),
    anchorMaxX: from('anchorMaxX', 0.5), anchorMaxY: from('anchorMaxY', 0.5),
    pivotX: from('pivotX', 0.5), pivotY: from('pivotY', 0.5),
    fontSize: properties.fontSize, fillAmount: properties.fillAmount,
    imageColor: properties.imageColor, fontColor: properties.fontColor,
    bgColor: properties.bgColor, outlineColor: properties.outlineColor,
    visible: siteNode?.visible !== false,
  }
  const value = values[fieldKey]
  return COLOR_PROPERTY_FIELDS.includes(fieldKey) ? packSiteColor(value) : value
}

function projectSiteNodes(project) {
  const result = {}
  if (!project?.root) return result
  const platform = CANVAS_PRESETS[project.canvasId]?.platform
  const visit = node => {
    const transform = node.transformByPlatform?.[platform] || Object.values(node.transformByPlatform || {})[0] || {}
    const properties = {}
    for (const key of ['fontSize', 'fillAmount', ...COLOR_PROPERTY_FIELDS]) {
      if (node[key] !== undefined) properties[key] = node[key]
    }
    result[node.id] = {
      anchorOffsetX: transform.offset?.x ?? 0, anchorOffsetY: transform.offset?.y ?? 0,
      sizeDeltaX: transform.size?.x ?? 0, sizeDeltaY: transform.size?.y ?? 0,
      scaleX: transform.scale?.x ?? 1, scaleY: transform.scale?.y ?? 1, scaleZ: transform.scale?.z ?? 1,
      rotationX: transform.rotation?.x ?? 0, rotationY: transform.rotation?.y ?? 0, rotation: transform.rotation?.z ?? 0,
      anchorMinX: transform.anchorMin?.x ?? .5, anchorMinY: transform.anchorMin?.y ?? .5,
      anchorMaxX: transform.anchorMax?.x ?? .5, anchorMaxY: transform.anchorMax?.y ?? .5,
      pivotX: transform.pivot?.x ?? .5, pivotY: transform.pivot?.y ?? .5,
      visible: node.visible !== false, properties,
    }
    for (const child of node.children || []) visit(child)
  }
  for (const child of project.root.children || []) visit(child)
  return result
}

function migrateLegacySemantics(look2, project) {
  const siteNodes = look2.siteNodes || {}
  const fallbackNodes = projectSiteNodes(project)
  for (const animation of look2.animations || []) {
    for (const track of animation.keyframeTracks || []) {
      const fieldKey = track.fieldKey
      const base = siteBaseValue(siteNodes[track.nodeId] || fallbackNodes[track.nodeId], fieldKey)
      for (const key of track.keyframes || []) {
        if (fieldKey === 'groupAlpha') {
          // Prior look2 stored group opacity as a 0–1 fraction. TweenTimeline@8
          // and the reference UI store it on the 0–255 scale.
          if (key.isDelta === true && typeof key.value === 'number') {
            key.value = (1 + key.value) * 255
            delete key.isDelta
          } else if (typeof key.value === 'number' && key.value >= 0 && key.value <= 1) key.value *= 255
          if (key.leftDelta === true && typeof key.leftValue === 'number') {
            key.leftValue = (1 + key.leftValue) * 255
            delete key.leftDelta
          } else if (typeof key.leftValue === 'number' && key.leftValue >= 0 && key.leftValue <= 1) key.leftValue *= 255
        }
        if (fieldKey !== 'groupAlpha' && key.isDelta === true && typeof key.value === 'number') {
          if (typeof base === 'number' && Number.isFinite(base)) {
            key.value = base + key.value
            delete key.isDelta
          } else key._legacyBaseDelta = true
        }
        if (fieldKey !== 'groupAlpha' && key.leftDelta === true && typeof key.leftValue === 'number') {
          if (typeof base === 'number' && Number.isFinite(base)) {
            key.leftValue = base + key.leftValue
            delete key.leftDelta
          } else key._legacyBaseLeftDelta = true
        }
      }
    }
  }
}

export function normalizeLook2(raw, project = null) {
  const base = freshLook2()
  if (!raw || typeof raw !== 'object') return base
  const out = { ...base, ...toJson(Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined))) }
  if (!Array.isArray(out.animations) || !out.animations.length) out.animations = base.animations
  for (const animation of out.animations) {
    if (!Array.isArray(animation.events)) animation.events = []
  }
  if (!Array.isArray(out.controlTemplates)) out.controlTemplates = []
  out.controlTemplates = normalizeSiteTemplates(out.controlTemplates)
  out.animations = readSiteAnimations(out.animations)
  if (!Array.isArray(out.primitiveResources)) out.primitiveResources = []
  if (!out.siteNodes || typeof out.siteNodes !== 'object' || Array.isArray(out.siteNodes)) out.siteNodes = {}
  if (!out.siteExtras || typeof out.siteExtras !== 'object' || Array.isArray(out.siteExtras)) out.siteExtras = {}
  restoreLegacySiteMasks(Object.values(out.siteNodes), out.siteExtras.giaSource, project)
  if (out.siteCanvasSettings && typeof out.siteCanvasSettings === 'object' && !Array.isArray(out.siteCanvasSettings)) {
    const retained = Object.fromEntries(SITE_CANVAS_FIELDS
      .filter((key) => Object.hasOwn(out.siteCanvasSettings, key))
      .map((key) => [key, out.siteCanvasSettings[key]]))
    if (Object.keys(retained).length) out.siteCanvasSettings = retained
    else delete out.siteCanvasSettings
  } else delete out.siteCanvasSettings
  if (!out.animations.some((animation) => animation.id === out.activeAnimationId)) out.activeAnimationId = out.animations[0].id
  out.frameRate = Math.max(1, Math.min(240, Math.trunc(Number(out.frameRate) || 30)))
  const semanticVersion = Number(raw.semanticVersion)
  if (!Number.isFinite(semanticVersion) || semanticVersion < 2) migrateLegacySemantics(out, project)
  out.semanticVersion = 2
  return out
}

function siteTransform(row) {
  const rt = createRectTransform()
  rt.anchorMin = { x: Number(row.anchorMinX ?? .5), y: Number(row.anchorMinY ?? .5) }
  rt.anchorMax = { x: Number(row.anchorMaxX ?? .5), y: Number(row.anchorMaxY ?? .5) }
  rt.pivot = { x: Number(row.pivotX ?? .5), y: Number(row.pivotY ?? .5) }
  rt.offset = { x: Number(row.anchorOffsetX ?? 0), y: Number(row.anchorOffsetY ?? 0) }
  rt.size = { x: Number(row.sizeDeltaX ?? row.width ?? 100), y: Number(row.sizeDeltaY ?? row.height ?? 40) }
  rt.scale = { x: Number(row.scaleX ?? 1), y: Number(row.scaleY ?? 1), z: Number(row.scaleZ ?? 1) }
  rt.rotation = { x: Number(row.rotationX ?? 0), y: Number(row.rotationY ?? 0), z: Number(row.rotation ?? 0) }
  return Object.fromEntries(PLATFORMS.map((platform) => [platform, structuredClone(rt)]))
}

function hasSiteLayoutState(row) {
  return ['anchorOffsetX', 'anchorOffsetY', 'sizeDeltaX', 'sizeDeltaY'].every((key) => Number.isFinite(row[key]))
}

function legacyNodeSize(row, node, axis) {
  const raw = row[axis]
  if (Number.isFinite(raw)) return Number(raw)
  const defaults = LEGACY_DEFAULT_SIZE_BY_SITE_TYPE[row.type] || DEFAULT_SIZE[node.kind]
  return Number(defaults?.[axis === 'width' ? 0 : 1] ?? (axis === 'width' ? 100 : 40))
}

function legacyPosition(row, canvas) {
  const hasLayoutState = hasSiteLayoutState(row)
  const x = Number.isFinite(row.x) ? Number(row.x) : 0
  const y = Number.isFinite(row.y) ? Number(row.y) : 0
  return hasLayoutState
    ? { x: Number.isFinite(row.x) ? Number(row.x) : CANVAS_PRESETS['pc-16-9'].width / 2,
      y: Number.isFinite(row.y) ? Number(row.y) : CANVAS_PRESETS['pc-16-9'].height / 2 }
    : { x: canvas.width / 2 + x, y: canvas.height / 2 - y }
}

function legacyLinearTransform(row) {
  const radians = (Number(row.rotation) || 0) * Math.PI / 180
  const scaleX = Number.isFinite(row.scaleX) ? Number(row.scaleX) : 1
  const scaleY = Number.isFinite(row.scaleY) ? Number(row.scaleY) : 1
  const cosine = Math.cos(radians), sine = Math.sin(radians)
  return { a: cosine * scaleX, b: sine * scaleX, c: -sine * scaleY, d: cosine * scaleY }
}

function multiplyLinear(parent, local) {
  return {
    a: parent.a * local.a + parent.c * local.b,
    b: parent.b * local.a + parent.d * local.b,
    c: parent.a * local.c + parent.c * local.d,
    d: parent.b * local.c + parent.d * local.d,
  }
}

function inverseLegacyVector(matrix, x, y) {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  if (Math.abs(determinant) < 1e-6) return { x: 0, y: 0 }
  return {
    x: (matrix.d * x - matrix.c * y) / determinant,
    y: (-matrix.b * x + matrix.a * y) / determinant,
  }
}

function roundLayout(value) {
  return Number(value.toFixed(2))
}

/** Match UGC's pre-hierarchyLayoutVersion=2 world-position migration. */
function migrateLegacyHierarchyLayout(input, project, byId) {
  const canvas = projectCanvas(project)
  const rows = new Map(input.nodes.map((row) => [String(row.id), row]))
  const migrated = new Map()
  const ordered = []
  const visit = (node) => {
    ordered.push(node)
    for (const child of node.children || []) visit(child)
  }
  for (const root of project.root.children || []) visit(root)

  for (const node of ordered) {
    const row = rows.get(node.id)
    if (!row) continue
    const world = legacyPosition(row, canvas)
    const parentId = row.parentId == null ? null : String(row.parentId)
    const parent = parentId == null ? null : byId.get(parentId)
    const parentWorld = parentId == null ? null : migrated.get(parentId)
    const width = legacyNodeSize(row, node, 'width')
    const height = legacyNodeSize(row, node, 'height')
    const transform = legacyLinearTransform(row)
    let localX = world.x
    let localY = world.y
    let worldMatrix = transform
    let parentWidth = canvas.width
    let parentHeight = canvas.height

    if (parent && parentWorld) {
      const parentRow = rows.get(parent.id)
      const parentWidthActual = legacyNodeSize(parentRow, parent, 'width')
      const parentHeightActual = legacyNodeSize(parentRow, parent, 'height')
      const local = inverseLegacyVector(parentWorld.matrix, world.x - parentWorld.x, world.y - parentWorld.y)
      localX = (Number.isFinite(parentRow.pivotX) ? Number(parentRow.pivotX) : 0.5) * parentWidthActual + local.x
      localY = (Number.isFinite(parentRow.pivotY) ? Number(parentRow.pivotY) : 0.5) * parentHeightActual + local.y
      parentWidth = parentWidthActual
      parentHeight = parentHeightActual
      worldMatrix = multiplyLinear(parentWorld.matrix, transform)
    }

    const anchorMinX = Number.isFinite(row.anchorMinX) ? Number(row.anchorMinX) : 0.5
    const anchorMinY = Number.isFinite(row.anchorMinY) ? Number(row.anchorMinY) : 0.5
    const anchorMaxX = Number.isFinite(row.anchorMaxX) ? Number(row.anchorMaxX) : 0.5
    const anchorMaxY = Number.isFinite(row.anchorMaxY) ? Number(row.anchorMaxY) : 0.5
    const pivotX = Number.isFinite(row.pivotX) ? Number(row.pivotX) : 0.5
    const pivotY = Number.isFinite(row.pivotY) ? Number(row.pivotY) : 0.5
    const anchorX = ((1 - pivotX) * anchorMinX + pivotX * anchorMaxX) * parentWidth
    const anchorY = ((1 - pivotY) * anchorMinY + pivotY * anchorMaxY) * parentHeight
    const sizeX = width - (anchorMaxX - anchorMinX) * parentWidth
    const sizeY = height - (anchorMaxY - anchorMinY) * parentHeight
    const offsetX = roundLayout(localX - anchorX)
    const offsetY = roundLayout(localY - anchorY)
    const sizeDeltaX = roundLayout(sizeX)
    const sizeDeltaY = roundLayout(sizeY)
    for (const platform of PLATFORMS) {
      const rt = node.transformByPlatform[platform]
      rt.offset = { x: offsetX, y: offsetY }
      rt.size = { x: sizeDeltaX, y: sizeDeltaY }
    }
    migrated.set(node.id, { x: world.x, y: world.y, matrix: worldMatrix })
  }
}

function siteNode(row) {
  const kind = TYPE_TO_KIND[row.type]
  if (!kind) throw new Error(`参考网站的控件类型暂不支持：${row.type}`)
  const properties = readSiteProperties(kind, row.properties)
  const packedColors = Object.fromEntries(COLOR_PROPERTY_FIELDS
    .filter(field => properties[field] != null)
    .map(field => [field, packSiteColor(properties[field])]))
  return createNode(kind, {
    ...properties, ...packedColors, id: String(row.id), name: String(row.name || row.type),
    active: row.active !== false, visible: row.visible !== false,
    canControllerFocus: row.canControllerFocus === true,
    transformByPlatform: siteTransform(row),
  })
}

export function importSiteJson(input) {
  if (Number(input?.version) !== SITE_JSON_VERSION || !Array.isArray(input.nodes)) {
    throw new Error(`仅支持参考网站 version ${SITE_JSON_VERSION} 的 JSON 工程`)
  }
  input = toJson(input)
  restoreLegacySiteMasks(input.nodes, input.giaSource)
  const project = createDefaultClientTemplateProject()
  project.meta.name = String(input.name || '导入动画')
  project.meta.sourceFormat = 'site-json'
  project.root.children = []
  const byId = new Map()
  const siteNodes = {}
  for (const row of input.nodes) {
    if (!row?.id || byId.has(String(row.id))) throw new Error('参考网站工程含重复或空控件 ID')
    const node = siteNode(row)
    byId.set(node.id, node)
    siteNodes[node.id] = toJson(row)
  }
  for (const row of input.nodes) {
    const node = byId.get(String(row.id))
    const parent = row.parentId == null ? project.root : byId.get(String(row.parentId))
    if (!parent) throw new Error(`控件 ${row.name || row.id} 的父级不存在`)
    if (parent === node) throw new Error(`控件 ${row.name || row.id} 不能成为自己的父级`)
    parent.children.push(node)
  }
  const visited = new Set()
  const visiting = new Set()
  const visit = (node) => {
    if (visiting.has(node.id)) throw new Error('参考网站工程的控件层级存在循环')
    if (visited.has(node.id)) return
    visiting.add(node.id)
    for (const child of node.children) visit(child)
    visiting.delete(node.id)
    visited.add(node.id)
  }
  for (const root of project.root.children) visit(root)
  if (visited.size !== byId.size) throw new Error('参考网站工程包含未连接到根控件的控件或循环')
  if (!project.root.children.length) throw new Error('参考网站工程没有根控件')
  project.selectedId = project.root.children[0].id
  project.canvasId = CANVAS_PRESETS[input.previewPresetId] ? input.previewPresetId : 'pc-16-9'
  const known = new Set(['version', 'name', 'deviceMode', 'previewPresetId', 'canvasWidth', 'canvasHeight', 'duration', 'frameRate', 'nodes', 'controlTemplates', 'primitiveResources', 'keyframeTracks', 'animations', 'activeAnimationId', 'timelineSnapEnabled'])
  const siteExtras = Object.fromEntries(Object.entries(input).filter(([key]) => !known.has(key)))
  const siteCanvasSettings = Object.fromEntries(SITE_CANVAS_FIELDS
    .filter((key) => Object.hasOwn(input, key))
    .map((key) => [key, input[key]]))
  adoptSiteCanvas(project, { siteCanvasSettings })
  const hasLegacyWorldLayout = input.nodes.some((row) => Number.isFinite(row.x) || Number.isFinite(row.y))
  if (input.hierarchyLayoutVersion !== 2 && hasLegacyWorldLayout) migrateLegacyHierarchyLayout(input, project, byId)
  const look2 = normalizeLook2({
    semanticVersion: 2,
    frameRate: input.frameRate, timelineSnapEnabled: input.timelineSnapEnabled,
    activeAnimationId: input.activeAnimationId, animations: input.animations?.length ? input.animations : [{ id: 'animation-default', name: '默认动画', duration: input.duration || 5,
      keyframeTracks: input.keyframeTracks || migrateSiteTweenClips(input, project) }],
    controlTemplates: input.controlTemplates, primitiveResources: input.primitiveResources,
    siteNodes, siteExtras,
    siteCanvasSettings,
  })
  adoptSiteCanvas(project, look2)
  return { project, look2 }
}

export function exportSiteJson(project, rawLook2) {
  const look2 = normalizeLook2(rawLook2, project)
  const retainedCanvas = look2.siteCanvasSettings || {}
  const canvasValue = (key, fallback) => Object.hasOwn(retainedCanvas, key) ? retainedCanvas[key] : fallback
  const canvas = projectCanvas(project)
  const { boxes } = layoutTree(project.root, projectCanvas(project))
  // A Look project can contain a server-container wrapper. The reference format starts at its client roots.
  const nodes = []
  const visit = (node, parentId = null, parentSize = canvas) => {
    const rt = node.transformByPlatform?.[CANVAS_PRESETS[project.canvasId]?.platform || 'KEYBOARD'] || createRectTransform()
    const original = look2.siteNodes[node.id] || {}
    const box = boxes[node.id]
    const anchorReferenceX = parentSize.width * ((1 - rt.pivot.x) * rt.anchorMin.x + rt.pivot.x * rt.anchorMax.x)
    const anchorReferenceY = parentSize.height * ((1 - rt.pivot.y) * rt.anchorMin.y + rt.pivot.y * rt.anchorMax.y)
    const resourceImage = Boolean(original.properties?.imageResourceId || original.properties?.primitiveResourceId)
    nodes.push({
      ...original, id: node.id, parentId, name: node.name,
      type: node.kind === 'image' && (original.type === 'primitive' || resourceImage)
        ? 'primitive' : TYPE_TO_KIND[original.type] === node.kind ? original.type : KIND_TO_SITE_TYPE[node.kind] || node.kind,
      active: node.active !== false, visible: node.visible !== false,
      x: anchorReferenceX + rt.offset.x, y: anchorReferenceY + rt.offset.y,
      width: box?.width ?? original.width ?? 0, height: box?.height ?? original.height ?? 0,
      scaleX: rt.scale.x, scaleY: rt.scale.y, scaleZ: rt.scale.z,
      rotationX: rt.rotation.x, rotationY: rt.rotation.y, rotation: rt.rotation.z,
      anchorMinX: rt.anchorMin.x, anchorMinY: rt.anchorMin.y,
      anchorMaxX: rt.anchorMax.x, anchorMaxY: rt.anchorMax.y,
      pivotX: rt.pivot.x, pivotY: rt.pivot.y,
      anchorOffsetX: rt.offset.x, anchorOffsetY: rt.offset.y,
      sizeDeltaX: rt.size.x, sizeDeltaY: rt.size.y,
      properties: { ...(original.properties || {}), ...writeSiteProperties(node), ...(node.kind === 'textbox' || node.kind === 'textwindow' ? {
        text: node.text, fontSize: node.fontSize,
        fontColor: unpackSiteColor(node.fontColor), bgColor: unpackSiteColor(node.bgColor), outlineColor: unpackSiteColor(node.outlineColor),
      } : {}), ...(node.kind === 'image' ? {
        imageId: node.imageId,
        imageType: String(node.imageType || 'Basic').replace(/^./, letter => letter.toLowerCase()),
        imageSource: (original.properties?.imageResourceId || original.properties?.primitiveResourceId) ? 'primitive' : String(node.imageSource || 'StaticReference').replace(/^./, (letter) => letter.toLowerCase()),
        ...((original.properties?.imageResourceId || original.properties?.primitiveResourceId) ? {
          imageResourceId: original.properties.imageResourceId || original.properties.primitiveResourceId,
        } : {}),
        imageColor: unpackSiteColor(node.imageColor),
        enableMask: node.enableMask, enableSoftEdge: node.enableSoftEdge,
        softEdgeMode: String(node.softEdgeMode || 'Pixel').replace(/^./, (letter) => letter.toLowerCase()),
        softEdgeWidthX: node.softEdgeWidthX, softEdgeWidthY: node.softEdgeWidthY,
        horizontalSoftRange: node.horizontalSoftRange, verticalSoftRange: node.verticalSoftRange,
        reverseMaskArea: node.reverseMaskArea, enableFill: node.enableFill, fillClockwise: node.fillClockwise,
        fillType: node.enableFill ? String(node.fillType || 'Horizontal').replace(/^./, (letter) => letter.toLowerCase()) : 'unused',
        fillHorizontalType: String(node.fillHorizontalType || 'Left').replace(/^./, (letter) => letter.toLowerCase()),
        fillVerticalType: String(node.fillVerticalType || 'Top').replace(/^./, (letter) => letter.toLowerCase()),
        fillRadial90Type: String(node.fillRadial90Type || 'BottomLeft').replace(/^./, (letter) => letter.toLowerCase()),
        fillRadialType: String(node.fillRadialType || 'Bottom').replace(/^./, (letter) => letter.toLowerCase()),
        fillAmount: node.enableFill ? node.fillAmount : null,
      } : {}), ...(node.kind === 'container' ? {
        isolateNavigation: node.isolateNavigation, disableKeyEventPassthrough: node.disableKeyEventPassthrough,
        disableCursorEventPassthrough: node.disableCursorEventPassthrough, showCursor: node.showCursor,
      } : {}) },
    })
    const childParentSize = node.kind === 'server-container' || !box
      ? canvas : { width: box.width, height: box.height }
    for (const child of node.children || []) visit(child, node.id, childParentSize)
  }
  for (const root of project.root.children || []) visit(root)
  const animations = writeSiteAnimations(look2.animations, nodes)
  return toJson({
    ...look2.siteExtras,
    version: SITE_JSON_VERSION, hierarchyLayoutVersion: 2,
    controlModelVersion: 2,
    timelineModelVersion: 10,
    name: project.meta.name,
    deviceMode: canvasValue('deviceMode', canvas.device),
    previewPresetId: canvasValue('previewPresetId', project.canvasId),
    canvasWidth: canvasValue('canvasWidth', canvas.width), canvasHeight: canvasValue('canvasHeight', canvas.height),
    duration: look2.animations.find((a) => a.id === look2.activeAnimationId)?.duration || 5,
    frameRate: look2.frameRate, nodes, controlTemplates: exportSiteTemplates(look2.controlTemplates),
    primitiveResources: look2.primitiveResources, giaSource: look2.siteExtras.giaSource || null,
    tweenTracks: look2.siteExtras.tweenTracks || [], keyframeTracks: animations.find((a) => a.id === look2.activeAnimationId)?.keyframeTracks || [], animationModelVersion: look2.siteExtras.animationModelVersion || 1,
    animations, activeAnimationId: look2.activeAnimationId,
    timelineSnapEnabled: look2.timelineSnapEnabled, showContainerBones: look2.siteExtras.showContainerBones !== false,
    giaImportStatus: look2.siteExtras.giaImportStatus || '',
  })
}
