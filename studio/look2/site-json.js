import { CANVAS_PRESETS, PLATFORMS } from '../constants.js'
import { createDefaultClientTemplateProject, createNode } from '../ui/authoring.js'
import { createRectTransform } from '../ui/layout.js'
import { layoutTree } from '../ui/inspector.js'
import { toJson } from '../json.js'
import { projectCanvas, adoptSiteCanvas } from '../ui/canvas.js'

export const SITE_JSON_VERSION = 12
const SITE_CANVAS_FIELDS = ['deviceMode', 'previewPresetId', 'canvasWidth', 'canvasHeight']

const TYPE_TO_KIND = {
  container: 'container', image: 'image', primitive: 'image', textbox: 'textbox', text: 'textbox',
  textwindow: 'textwindow', button: 'button', cursor: 'cursor', grid: 'grid',
  keyhint: 'keyhint', animation: 'animation', fullscreen: 'fullscreen', reference: 'reference',
}
const KIND_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_KIND).map(([type, kind]) => [kind, type]))
// Both image and primitive map to the authoring kind `image`. Use image as the
// default export type, then preserve a resource-backed primitive explicitly.
KIND_TO_TYPE.image = 'image'
KIND_TO_TYPE.textbox = 'textbox'

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
  if (!Array.isArray(out.primitiveResources)) out.primitiveResources = []
  if (!out.siteNodes || typeof out.siteNodes !== 'object' || Array.isArray(out.siteNodes)) out.siteNodes = {}
  if (!out.siteExtras || typeof out.siteExtras !== 'object' || Array.isArray(out.siteExtras)) out.siteExtras = {}
  if (out.siteCanvasSettings && typeof out.siteCanvasSettings === 'object' && !Array.isArray(out.siteCanvasSettings)) {
    const retained = Object.fromEntries(SITE_CANVAS_FIELDS
      .filter((key) => Object.hasOwn(out.siteCanvasSettings, key))
      .map((key) => [key, out.siteCanvasSettings[key]]))
    if (Object.keys(retained).length) out.siteCanvasSettings = retained
    else delete out.siteCanvasSettings
  } else delete out.siteCanvasSettings
  if (!out.animations.some((animation) => animation.id === out.activeAnimationId)) out.activeAnimationId = out.animations[0].id
  out.frameRate = Math.max(1, Math.min(120, Math.trunc(Number(out.frameRate) || 30)))
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

function siteNode(row) {
  const kind = TYPE_TO_KIND[row.type]
  if (!kind) throw new Error(`参考网站的控件类型暂不支持：${row.type}`)
  const properties = { ...(row.properties || {}) }
  if (kind === 'image') {
    const enumFields = ['imageSource', 'imageType', 'softEdgeMode', 'fillType', 'fillHorizontalType', 'fillVerticalType', 'fillRadial90Type', 'fillRadialType']
    for (const field of enumFields) if (typeof properties[field] === 'string') {
      properties[field] = properties[field].replace(/^./, (letter) => letter.toUpperCase())
    }
    const usedFill = properties.fillType != null && properties.fillType !== 'Unused'
    if (properties.fillType === 'Unused') properties.fillType = 'Horizontal'
    properties.enableFill = properties.enableFill ?? (usedFill && properties.fillAmount != null)
  }
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
  const look2 = normalizeLook2({
    semanticVersion: 2,
    frameRate: input.frameRate, timelineSnapEnabled: input.timelineSnapEnabled,
    activeAnimationId: input.activeAnimationId, animations: input.animations?.length ? input.animations : [{ id: 'animation-default', name: '默认动画', duration: input.duration || 5, keyframeTracks: input.keyframeTracks || [] }],
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
  const { boxes } = layoutTree(project.root, projectCanvas(project))
  // A Look project can contain a server-container wrapper. The reference format starts at its client roots.
  const nodes = []
  const visit = (node, parentId = null) => {
    const rt = node.transformByPlatform?.[CANVAS_PRESETS[project.canvasId]?.platform || 'KEYBOARD'] || createRectTransform()
    const original = look2.siteNodes[node.id] || {}
    const box = boxes[node.id]
    const resourceImage = Boolean(original.properties?.imageResourceId || original.properties?.primitiveResourceId)
    nodes.push({
      ...original, id: node.id, parentId, name: node.name,
      type: node.kind === 'image' && (original.type === 'primitive' || resourceImage)
        ? 'primitive' : KIND_TO_TYPE[node.kind] || node.kind,
      active: node.active !== false, visible: node.visible !== false,
      x: box?.centerX ?? original.x ?? 0, y: box?.centerY ?? original.y ?? 0,
      width: box?.width ?? original.width ?? 0, height: box?.height ?? original.height ?? 0,
      scaleX: rt.scale.x, scaleY: rt.scale.y, scaleZ: rt.scale.z,
      rotationX: rt.rotation.x, rotationY: rt.rotation.y, rotation: rt.rotation.z,
      anchorMinX: rt.anchorMin.x, anchorMinY: rt.anchorMin.y,
      anchorMaxX: rt.anchorMax.x, anchorMaxY: rt.anchorMax.y,
      pivotX: rt.pivot.x, pivotY: rt.pivot.y,
      anchorOffsetX: rt.offset.x, anchorOffsetY: rt.offset.y,
      sizeDeltaX: rt.size.x, sizeDeltaY: rt.size.y,
      properties: { ...(original.properties || {}), ...(node.kind === 'textbox' || node.kind === 'textwindow' ? {
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
        reverseMaskArea: node.reverseMaskArea,
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
    for (const child of node.children || []) visit(child, node.id)
  }
  for (const root of project.root.children || []) visit(root)
  const canvas = projectCanvas(project)
  return toJson({
    ...look2.siteExtras,
    version: SITE_JSON_VERSION, hierarchyLayoutVersion: look2.siteExtras.hierarchyLayoutVersion || 2,
    controlModelVersion: look2.siteExtras.controlModelVersion || 2,
    timelineModelVersion: look2.siteExtras.timelineModelVersion || 10,
    name: project.meta.name,
    deviceMode: canvasValue('deviceMode', canvas.device),
    previewPresetId: canvasValue('previewPresetId', project.canvasId),
    canvasWidth: canvasValue('canvasWidth', canvas.width), canvasHeight: canvasValue('canvasHeight', canvas.height),
    duration: look2.animations.find((a) => a.id === look2.activeAnimationId)?.duration || 5,
    frameRate: look2.frameRate, nodes, controlTemplates: look2.controlTemplates,
    primitiveResources: look2.primitiveResources, giaSource: look2.siteExtras.giaSource || null,
    tweenTracks: look2.siteExtras.tweenTracks || [], keyframeTracks: look2.animations.find((a) => a.id === look2.activeAnimationId)?.keyframeTracks || [], animationModelVersion: look2.siteExtras.animationModelVersion || 1,
    animations: look2.animations, activeAnimationId: look2.activeAnimationId,
    timelineSnapEnabled: look2.timelineSnapEnabled, showContainerBones: look2.siteExtras.showContainerBones !== false,
    giaImportStatus: look2.siteExtras.giaImportStatus || '',
  })
}
