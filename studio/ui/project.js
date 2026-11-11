import { CANVAS_PRESETS, DEFAULT_CANVAS_ID, CANONICAL_CANVAS_BY_PLATFORM, PLATFORMS, LAYOUT_SCHEMA_VERSION } from '../constants.js'
import { toJson } from '../json.js'
import {
  addChild,
  clientRoot,
  createDefaultClientTemplateProject,
  createDefaultProject,
  createNode,
  findNode,
  findParent,
  nextUniqueId,
  removeNode,
  sanitizeNode,
  selectedTemplateRoot,
  walk,
} from './authoring.js'
import {
  applyInspectorToTransform,
  canvasBox,
  computeRect,
  platformOfPreset,
  setAnchorPreset,
} from './layout.js'
import { readCurrentTransform, syncPlatformTransforms } from './sync.js'
import { hitTest, inspectorDto, layoutTree, painterBoxes, treeRows } from './inspector.js'
import { rawFieldDefinition, sanitizeRawFieldValue } from '../gia/raw-fields.js'
import { assignGuids } from '../gia/codec.js'
import { collectUsedGuids, nextFreeGuid } from '../gia/guid.js'
import { migrateLayout } from './migrate-layout.js'
import { ensureClientAssetIndices } from '../gia/asset-indices.js'
import { getPlatformTransform } from './transforms.js'
import { projectCanvas, customCanvas } from './canvas.js'
import { KEY_HINT_DEVICES, normalizeKeyHintCode } from '../key-hints.js'

function parentBoxOf(project, nodeId, boxes, canvasId = project.canvasId) {
  const parent = findParent(project.root, nodeId)
  const preset = canvasId === project.canvasId ? projectCanvas(project) : canvasId
  if (!parent || parent.kind === 'server-container') return canvasBox(preset)
  return boxes[parent.id] || canvasBox(preset)
}

export function createProject(seed, { warnings = [] } = {}) {
  if (!seed) seed = createDefaultProject()
  seed = migrateLayout(seed, warnings)
  if ((seed.root || seed.layoutSchemaVersion !== undefined) && seed.layoutSchemaVersion !== LAYOUT_SCHEMA_VERSION) {
    throw new Error(`仅支持 layoutSchemaVersion=${LAYOUT_SCHEMA_VERSION} 的四平台布局，不支持旧画布布局或其他版本`)
  }
  const assetType = seed.meta?.assetType === 'client-control-template'
    ? 'client-control-template'
    : 'server-control-template'
  const base = assetType === 'client-control-template' ? createDefaultClientTemplateProject() : createDefaultProject()
  const root = sanitizeNode(seed.root || base.root)
  const nodeIds = new Set()
  walk(root, node => nodeIds.add(String(node.id)))
  const editorLocks = {}
  if (seed.meta?.editorLocks && typeof seed.meta.editorLocks === 'object' && !Array.isArray(seed.meta.editorLocks)) {
    for (const [id, locked] of Object.entries(seed.meta.editorLocks)) {
      if (locked === true && nodeIds.has(id)) editorLocks[id] = true
    }
  }
  const project = {
    layoutSchemaVersion: LAYOUT_SCHEMA_VERSION,
    version: Number.isSafeInteger(seed.version) && seed.version > 0 ? seed.version : 1,
    meta: {
      ...seed.meta,
      name: String(seed.meta?.name || base.meta.name),
      assetType,
      sourceFormat: String(seed.meta?.sourceFormat || base.meta.sourceFormat),
      sourceFile: String(seed.meta?.sourceFile || ''),
      editorLocks,
      ...(seed.meta?.editorTemplateId ? { editorTemplateId: String(seed.meta.editorTemplateId) } : {}),
      ...(customCanvas({ previewPresetId: seed.meta?.customCanvas?.id, canvasWidth: seed.meta?.customCanvas?.width, canvasHeight: seed.meta?.customCanvas?.height })
        ? { customCanvas: customCanvas({ previewPresetId: seed.meta.customCanvas.id, canvasWidth: seed.meta.customCanvas.width, canvasHeight: seed.meta.customCanvas.height }) } : {}),
      ...(seed.meta?.gameVersion ? { gameVersion: String(seed.meta.gameVersion) } : {}),
      ...(seed.meta?.giaFilePath ? { giaFilePath: String(seed.meta.giaFilePath) } : {}),
      ...(Number.isSafeInteger(Number(seed.meta?.giaOwnerUid)) ? { giaOwnerUid: Number(seed.meta.giaOwnerUid) } : {}),
      ...(Number.isSafeInteger(Number(seed.meta?.giaTimestamp)) ? { giaTimestamp: Number(seed.meta.giaTimestamp) } : {}),
      ...(Number.isSafeInteger(Number(seed.meta?.giaFileId)) ? { giaFileId: Number(seed.meta.giaFileId) } : {}),
      ...(seed.meta?.giaFileName ? { giaFileName: String(seed.meta.giaFileName) } : {}),
      ...(Number.isSafeInteger(seed.meta?.giaNextAssetIndex) && seed.meta.giaNextAssetIndex >= 2
        ? { giaNextAssetIndex: seed.meta.giaNextAssetIndex } : {}),
      ...(Number.isSafeInteger(seed.meta?.giaAssetIndexSchemaVersion) && seed.meta.giaAssetIndexSchemaVersion > 0
        ? { giaAssetIndexSchemaVersion: seed.meta.giaAssetIndexSchemaVersion } : {}),
      ...(Number.isSafeInteger(Number(seed.meta?.giaModeFlag)) && Number(seed.meta.giaModeFlag) >= 0
        ? { giaModeFlag: Number(seed.meta.giaModeFlag) }
        : {}),
    },
    canvasId: seed.canvasId && CANVAS_PRESETS[seed.canvasId] ? seed.canvasId : DEFAULT_CANVAS_ID,
    keyHintDevice: KEY_HINT_DEVICES.includes(seed.keyHintDevice) ? seed.keyHintDevice : 'auto',
    selectedId: seed.selectedId === '' ? '' : seed.selectedId || base.selectedId,
    root,
  }
  validateProjectReferences(project)
  ensureClientAssetIndices(project, { warnings })
  return project
}

function validateProjectReferences(project) {
  const ids = new Set()
  walk(project.root, (node) => {
    if (typeof node.id !== 'string' || !node.id) throw new Error('node id must be a non-empty string')
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`)
    ids.add(node.id)
  })
  if (project.selectedId !== '' && !ids.has(project.selectedId)) project.selectedId = clientRoot(project.root).id
}

function nextUniqueGuid(root) {
  return nextFreeGuid(collectUsedGuids(root))
}

function isNodeInside(root, id) {
  let found = false
  walk(root, (node) => { if (node.id === id) found = true })
  return found
}

function reparentPreservingCurrentCanvas(project, node, oldParent, newParent) {
  const before = layoutTree(project.root, projectCanvas(project))
  const oldBox = before.boxes[node.id]
  const oldIndex = oldParent.children.findIndex((child) => child.id === node.id)
  if (oldIndex < 0) throw new Error('reparent: source node is not attached')
  oldParent.children.splice(oldIndex, 1)
  newParent.children.push(node)
  if (!oldBox) return
  const after = layoutTree(project.root, projectCanvas(project))
  const newParentBox = newParent.kind === 'server-container'
    ? canvasBox(projectCanvas(project))
    : after.boxes[newParent.id] || canvasBox(projectCanvas(project))
  const current = readCurrentTransform(node.transformByPlatform, project.canvasId)
  const next = applyInspectorToTransform(newParentBox, current, {
    posX: oldBox.centerX,
    posY: oldBox.centerY,
    width: oldBox.width,
    height: oldBox.height,
  })
  writeTransform(project, node, next)
}

function rowsForProject(project, guidById) {
  if (project.root.kind === 'server-container' && !project.root.children.length) return []
  if (project.meta.assetType !== 'client-control-template') return treeRows(project.root, guidById)
  return (project.root.children || []).flatMap((node) => treeRows(node, guidById))
}

function visibleBoxesForProject(project, boxes) {
  if (project.root.kind === 'server-container' && !project.root.children.length) return []
  const ordered = painterBoxes(project.root, boxes)
  if (project.meta.assetType !== 'client-control-template') return ordered
  const template = selectedTemplateRoot(project)
  const ids = new Set()
  if (template && template.kind !== 'server-container') walk(template, (node) => ids.add(node.id))
  return ordered.filter((box) => ids.has(box.id))
}

export function snapshotProject(project) {
  const { canvas, boxes } = layoutTree(project.root, projectCanvas(project), undefined, project.keyHintDevice)
  const guidById = assignGuids(project, new Set(), { preserveLegacy: true })
  const selected = findNode(project.root, project.selectedId)
  const selectedBox = selected ? boxes[selected.id] : null
  return toJson({
    layoutSchemaVersion: LAYOUT_SCHEMA_VERSION,
    version: project.version,
    meta: { ...project.meta },
    canvasId: project.canvasId,
    keyHintDevice: project.keyHintDevice || 'auto',
    canvas: {
      id: project.canvasId,
      width: canvas.width,
      height: canvas.height,
      platform: CANVAS_PRESETS[project.canvasId].platform,
      label: projectCanvas(project).label,
      presets: Object.values(CANVAS_PRESETS).map((p) => ({
        id: p.id,
        label: p.label,
        width: p.width,
        height: p.height,
        platform: p.platform,
      })),
    },
    selectedId: project.selectedId,
    asset: {
      type: project.meta.assetType,
      label: project.meta.assetType === 'client-control-template' ? '客户端控件模板' : '服务端控件模板',
      templateCount: project.meta.assetType === 'client-control-template' ? project.root.children.length : project.root.kind === 'server-container' && !project.root.children.length ? 0 : 1,
      currentTemplateId: project.meta.assetType === 'client-control-template' && project.root.children.length ? selectedTemplateRoot(project)?.id || '' : '',
    },
    editorLocks: { ...(project.meta.editorLocks || {}) },
    tree: rowsForProject(project, guidById),
    boxes: visibleBoxesForProject(project, boxes),
    inspector: inspectorDto(selected, project.canvasId, selectedBox || canvas, guidById),
    root: project.root,
  })
}

function writeTransform(project, node, nextRt) {
  const sourceLayout = layoutTree(project.root, projectCanvas(project))
  const sourceParentBox = parentBoxOf(project, node.id, sourceLayout.boxes)
  const targetParentBoxByPlatform = {}
  if (node.syncAllDevices !== false) {
    for (const platform of PLATFORMS) {
      if (platform === platformOfPreset(project.canvasId)) continue
      const canvasId = CANONICAL_CANVAS_BY_PLATFORM[platform]
      const targetLayout = layoutTree(project.root, canvasId, platform)
      targetParentBoxByPlatform[platform] = parentBoxOf(project, node.id, targetLayout.boxes, canvasId)
    }
  }
  node.transformByPlatform = syncPlatformTransforms({
    transformByPlatform: node.transformByPlatform,
    source: nextRt,
    canvasId: project.canvasId,
    syncAllDevices: node.syncAllDevices !== false,
    sourceParentBox,
    targetParentBoxByPlatform,
  })
}

const DIRECT_FIELDS = new Set([
  'name', 'active', 'visible', 'canControllerFocus',
  'isolateNavigation', 'disableKeyEventPassthrough', 'disableCursorEventPassthrough', 'showCursor',
  'fontSize', 'adaptiveFontSize', 'minimumFontSize', 'fontColor', 'bgColor',
  'enableOutline', 'outlineColor', 'horizontalAlignment', 'verticalAlignment', 'text',
  'imageId', 'imageSource', 'imageType', 'imageColor', 'enableMask', 'enableSoftEdge', 'softEdgeMode',
  'softEdgeWidthX', 'softEdgeWidthY', 'horizontalSoftRange', 'verticalSoftRange',
  'enableFill', 'fillClockwise', 'fillType', 'fillHorizontalType', 'fillVerticalType',
  'fillRadial90Type', 'fillRadialType', 'fillAmount', 'reverseMaskArea',
  'raycastTarget', 'interactable', 'clickAudioId', 'defaultChildId',
  'hoverChildId', 'pressedChildId', 'unavailableChildId',
  'showScrollBar', 'cellSizeX', 'cellSizeY', 'spacingX', 'spacingY',
  'padding1X', 'padding1Y', 'padding2X', 'padding2Y', 'previewCount',
  'scrollProgress', 'scrollDirection', 'layoutConstraint', 'layoutConstraintFixedCount', 'itemPrefabId', 'referencedPrefabId', 'animationId', 'playSoundEffect', 'layer',
  'keyboardKeyCode', 'controllerKeyCode',
])

const COMPUTED = new Set(['posX', 'posY', 'width', 'height'])
const ANCHOR_KEYS = new Set(['anchorMinX', 'anchorMinY', 'anchorMaxX', 'anchorMaxY', 'pivotX', 'pivotY'])

function parseColor(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('#')) {
      const hex = s.slice(1)
      if (hex.length === 6) return (0xff000000 | parseInt(hex, 16)) >>> 0
      if (hex.length === 8) return parseInt(hex, 16) >>> 0
    }
    const n = Number(s)
    if (Number.isFinite(n)) return n >>> 0
  }
  throw new Error('color must be an ARGB integer or #RRGGBB/#AARRGGBB string')
}

function finiteNumber(value, key) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${key} must be a finite number`)
  return number
}

function booleanValue(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  throw new Error('boolean field requires true or false')
}

const NUMBER_FIELDS = new Set([
  'scrollProgress', 'layoutConstraintFixedCount', 'itemPrefabId', 'fontSize', 'minimumFontSize', 'imageId', 'clickAudioId', 'softEdgeWidthX',
  'softEdgeWidthY', 'horizontalSoftRange', 'verticalSoftRange', 'fillAmount',
  'cellSizeX', 'cellSizeY', 'spacingX', 'spacingY', 'padding1X', 'padding1Y',
  'padding2X', 'padding2Y', 'previewCount',
])
const BOOLEAN_FIELDS = new Set([
  'active', 'visible', 'canControllerFocus', 'isolateNavigation',
  'disableKeyEventPassthrough', 'disableCursorEventPassthrough', 'showCursor',
  'adaptiveFontSize', 'enableOutline', 'enableMask', 'enableSoftEdge',
  'enableFill', 'fillClockwise', 'reverseMaskArea', 'raycastTarget', 'interactable', 'showScrollBar',
  'playSoundEffect',
])
const STRING_FIELDS = new Set([
  'name', 'imageSource', 'horizontalAlignment', 'verticalAlignment', 'text', 'softEdgeMode',
  'fillType', 'fillHorizontalType', 'fillVerticalType', 'fillRadial90Type', 'fillRadialType',
  'scrollDirection', 'layoutConstraint', 'referencedPrefabId', 'animationId',
])
const STATE_NODE_FIELDS = new Set([
  'defaultChildId', 'hoverChildId', 'pressedChildId', 'unavailableChildId',
])
const ENUM_VALUES = {
  layer: ['AboveAllControls', 'BelowAllControls'],
  scrollDirection: ['Vertical', 'Horizontal'],
  layoutConstraint: ['AutoWrap', 'Fixed'],
  imageType: ['Basic', 'Stretch', null],
  imageSource: ['StaticReference', 'Prefab'],
  softEdgeMode: ['Percentage', 'Pixel'],
  fillType: ['Horizontal', 'Vertical', 'Radial90', 'Radial180', 'Radial360'],
  fillHorizontalType: ['Left', 'Right'],
  fillVerticalType: ['Bottom', 'Top'],
  fillRadial90Type: ['BottomLeft', 'TopLeft', 'TopRight', 'BottomRight'],
  fillRadialType: ['Bottom', 'Left', 'Top', 'Right'],
}

function applyPatchMutating(project, op) {
  if (!op || typeof op !== 'object') throw new Error('patch requires op')
  const type = op.op
  if (type === 'setPlatformTransform') {
    if (!PLATFORMS.includes(op.platform)) throw new Error(`unknown platform ${op.platform}`)
    const node = findNode(project.root, op.id || project.selectedId)
    if (!node || node.kind === 'server-container') throw new Error('setPlatformTransform: control not found')
    node.transformByPlatform[op.platform] = getPlatformTransform({ [op.platform]: op.transform }, op.platform)
    return project
  }
  if (type === 'select') {
    if (op.id === '' || op.id === null) {
      if (project.meta.assetType === 'client-control-template') {
        project.meta.editorTemplateId = selectedTemplateRoot(project)?.id || ''
      }
      project.selectedId = ''
    } else if (op.id && findNode(project.root, op.id)) project.selectedId = op.id
    return project
  }
  if (type === 'pick') {
    const { boxes } = layoutTree(project.root, projectCanvas(project))
    const visible = visibleBoxesForProject(project, boxes)
    const id = hitTest(visible, Number(op.x), Number(op.y))
    if (id) project.selectedId = id
    return project
  }
  if (type === 'setCanvas') {
    if (op.canvasId && CANVAS_PRESETS[op.canvasId]) {
      project.canvasId = op.canvasId
      delete project.meta.customCanvas
    }
    return project
  }
  if (type === 'setKeyHintDevice') {
    if (!KEY_HINT_DEVICES.includes(op.device)) throw new Error(`unknown key hint preview device: ${op.device}`)
    project.keyHintDevice = op.device
    return project
  }
  if (type === 'setScript') {
    throw new Error('脚本由存档统一管理，请使用 addScript / updateScript / removeScript 操作')
  }
  if (type === 'newAsset') {
    const next = op.assetType === 'client-control-template'
      ? createDefaultClientTemplateProject()
      : createDefaultProject()
    project.version = next.version
    project.meta = next.meta
    project.canvasId = next.canvasId
    project.keyHintDevice = 'auto'
    project.selectedId = next.selectedId
    project.root = next.root
    return project
  }
  if (type === 'addTemplate') {
    if (project.meta.assetType !== 'client-control-template') throw new Error('只有客户端控件模板工程可以新增模板')
    const child = createNode(op.kind, {
      id: nextUniqueId(project.root),
      guid: nextUniqueGuid(project.root),
      name: op.name || `新${op.kind === 'container' ? '容器节点' : op.kind}模板`,
    })
    project.root.children.push(child)
    project.selectedId = child.id
    return project
  }
  if (type === 'add') {
    let parent = findNode(project.root, op.parentId || project.selectedId || project.root.id)
    if (!parent) throw new Error('add: parent not found')
    if (op.resolveParent === true && parent.kind === 'server-container' && op.kind !== 'container') {
      parent = parent.children.find(node => node.kind === 'container')
      if (!parent) {
        parent = addChild(project.root, 'container', {
          id: nextUniqueId(project.root), guid: nextUniqueGuid(project.root), name: '容器节点',
        })
      }
    }
    const id = op.id === undefined ? nextUniqueId(project.root) : String(op.id)
    if (!id.trim()) throw new Error('add: id must be a non-empty string')
    if (findNode(project.root, id)) throw new Error(`duplicate node id: ${id}`)
    const child = addChild(parent, op.kind, {
      id,
      guid: nextUniqueGuid(project.root),
      name: op.name,
      ...(op.transformByPlatform !== undefined ? { transformByPlatform: op.transformByPlatform } : {}),
      ...(op.syncAllDevices !== undefined ? { syncAllDevices: op.syncAllDevices } : {}),
    })
    project.selectedId = child.id
    return project
  }
  if (type === 'reparent') {
    const node = findNode(project.root, op.id || project.selectedId)
    const oldParent = node ? findParent(project.root, node.id) : null
    const newParent = findNode(project.root, op.parentId)
    if (!node || node.kind === 'server-container' || !oldParent) throw new Error('reparent: node not found')
    if (!newParent) throw new Error('reparent: parent not found')
    if (newParent.id === node.id || isNodeInside(node, newParent.id)) throw new Error('控件不能移动到自身或其后代下面')
    if (project.meta.assetType !== 'client-control-template' && newParent.kind === 'server-container' && node.kind !== 'container') {
      throw new Error('最外层客户端控件容器只能直接包含容器节点；请移入内部容器')
    }
    if (newParent.kind === 'server-container' && oldParent.kind === 'server-container') return project
    reparentPreservingCurrentCanvas(project, node, oldParent, newParent)
    project.selectedId = node.id
    return project
  }
  if (type === 'moveSibling') {
    const node = findNode(project.root, op.id || project.selectedId)
    const parent = node ? findParent(project.root, node.id) : null
    if (!node || !parent) throw new Error('moveSibling: node not found')
    const from = parent.children.findIndex((child) => child.id === node.id)
    const to = op.direction === 'top' ? 0 : op.direction === 'bottom' ? parent.children.length - 1
      : op.direction === 'up' ? from - 1 : op.direction === 'down' ? from + 1 : from
    if (to === from || to < 0 || to >= parent.children.length) return project
    parent.children.splice(from, 1)
    parent.children.splice(to, 0, node)
    project.selectedId = node.id
    return project
  }
  if (type === 'remove') {
    const id = op.id || project.selectedId
    if (!id) return project
    if (id === project.root.id) {
      // Keep the file's structural envelope so an empty asset can be saved and rebuilt.
      if (project.root.kind === 'server-container') project.root.children = []
      else project.root = createNode('server-container', { id: 'sc1', name: '客户端控件容器' })
      project.selectedId = ''
      delete project.meta.editorTemplateId
      return project
    }
    const parent = findParent(project.root, id)
    if (removeNode(project.root, id)) {
      walk(project.root, (node) => {
        if (node.kind !== 'button') return
        for (const key of STATE_NODE_FIELDS) {
          if (node[key] && !findNode(project.root, node[key])) node[key] = null
        }
      })
      project.selectedId = parent?.kind === 'server-container'
        ? !parent.children.length ? '' : project.meta.assetType === 'client-control-template' ? parent.children[0].id : parent.id
        : parent?.id || ''
      if (project.meta.editorTemplateId && !findNode(project.root, project.meta.editorTemplateId)) delete project.meta.editorTemplateId
    }
    return project
  }
  if (type === 'set') {
    const node = findNode(project.root, op.id || project.selectedId)
    if (!node) throw new Error('set: node not found')
    let key = op.key
    if (key === 'reverseMask') key = 'reverseMaskArea'
    let value = op.value
    if (node.kind === 'reference' && ['referencedPrefabId', 'giaRaw.templateRefSlot'].includes(key)
      && (node.giaRaw.templateRefSlotBase64 || node.giaRaw.templateRefOuterBase64)) {
      throw new Error('该模板引用含尚未解析的原始配置，暂不能改写目标索引；请在官方编辑器修改后重新导入')
    }
    if (key.startsWith('giaRaw.')) {
      const rawKey = key.slice('giaRaw.'.length)
      if (!rawKey || rawKey.includes('.')) throw new Error('invalid raw GIA field path')
      const definition = rawFieldDefinition(node.kind, rawKey)
      if (!definition) throw new Error(`unknown raw GIA field for ${node.kind}: ${rawKey}`)
      node.giaRaw ||= {}
      node.giaRaw[rawKey] = sanitizeRawFieldValue(definition, value)
      if (rawKey === 'footerField505' && [0, 1].includes(node.giaRaw[rawKey])) node.canControllerFocus = node.giaRaw[rawKey] === 1
      if (node.kind === 'cursor' && rawKey === 'cursorField501' && [0, 1].includes(node.giaRaw[rawKey])) node.raycastTarget = node.giaRaw[rawKey] === 1
      if ((node.kind === 'textbox' || node.kind === 'textwindow') && rawKey === 'textAlign') {
        const alignment = { 0: 'Left', 1: 'Middle', 2: 'Right' }[node.giaRaw[rawKey]]
        if (alignment) node.horizontalAlignment = alignment
      }
      if (node.kind === 'image' && rawKey === 'imageFillType') {
        const fillType = { 1: 'Horizontal', 2: 'Vertical', 3: 'Radial90', 4: 'Radial180', 5: 'Radial360' }[node.giaRaw[rawKey]]
        if (fillType) node.fillType = fillType
      }
      if (node.kind === 'image' && rawKey === 'imageSlotType' && [0, 1].includes(node.giaRaw[rawKey])) node.imageType = node.giaRaw[rawKey] === 0 ? 'Basic' : 'Stretch'
      if (node.kind === 'image') {
        const semantic = {
          imageField503: ['fillHorizontalType', ['Left', 'Right']],
          imageField504: ['fillVerticalType', ['Bottom', 'Top']],
          imageField506: ['fillRadial90Type', ['BottomLeft', 'TopLeft', 'TopRight', 'BottomRight']],
          imageField507: ['fillRadialType', ['Bottom', 'Left', 'Top', 'Right']],
        }[rawKey]
        if (semantic && semantic[1][node.giaRaw[rawKey]] !== undefined) node[semantic[0]] = semantic[1][node.giaRaw[rawKey]]
        if (rawKey === 'imageField505' && [0, 1].includes(node.giaRaw[rawKey])) node.fillClockwise = node.giaRaw[rawKey] === 1
      }
      if (node.kind === 'keyhint' && rawKey === 'keyHintField502') node.keyboardKeyCode = node.giaRaw[rawKey]
      if (node.kind === 'keyhint' && rawKey === 'keyHintField501') node.controllerKeyCode = node.giaRaw[rawKey]
      return project
    }
    if (key === 'syncAllDevices') {
      node.syncAllDevices = booleanValue(value)
      if (node.syncAllDevices) {
        const current = readCurrentTransform(node.transformByPlatform, project.canvasId)
        writeTransform(project, node, current)
      }
      return project
    }
    if (DIRECT_FIELDS.has(key)) {
      if (key === 'keyboardKeyCode' || key === 'controllerKeyCode') {
        if (node.kind !== 'keyhint') throw new Error(`${key} requires a key hint control`)
        value = normalizeKeyHintCode(value, key === 'keyboardKeyCode' ? 'keyboard' : 'controller')
      }
      if (key === 'layer' && node.kind !== 'animation') throw new Error('layer is only available on UI animations')
      if (key === 'playSoundEffect' && !['animation', 'fullscreen'].includes(node.kind)) throw new Error('playSoundEffect requires an animation control')
      if (key.endsWith('Color')) value = parseColor(value)
      if (NUMBER_FIELDS.has(key)) {
        value = finiteNumber(value, key)
        if (value < 0) throw new Error(`${key} must not be negative`)
        if (key === 'imageId' || key === 'clickAudioId') value = Math.trunc(value)
        if (['fillAmount', 'scrollProgress'].includes(key) && value > 1) throw new Error(`${key} must be between 0 and 1`)
      }
      if (BOOLEAN_FIELDS.has(key)) value = booleanValue(value)
      if (STRING_FIELDS.has(key)) value = String(value ?? '')
      if (key === 'horizontalAlignment' && !['Left', 'Middle', 'Right'].includes(value)) {
        throw new Error('invalid horizontalAlignment')
      }
      if (key === 'verticalAlignment' && !['Top', 'Middle', 'Bottom'].includes(value)) {
        throw new Error('invalid verticalAlignment')
      }
      if (ENUM_VALUES[key] && !ENUM_VALUES[key].includes(value)) {
        throw new Error(`invalid ${key}`)
      }
      if (key === 'layer' && node.kind !== 'animation') throw new Error('layer is only available on UI animations')
      if (key === 'playSoundEffect' && !['animation', 'fullscreen'].includes(node.kind)) throw new Error('playSoundEffect requires an animation control')
      if (STATE_NODE_FIELDS.has(key)) {
        if (value === '' || value === undefined || value === null) value = null
        else {
          value = String(value)
          const stateNode = findNode(project.root, value)
          if (!stateNode || stateNode === node || stateNode.kind === 'server-container' || !(node.children || []).some((child) => child.id === value)) {
            throw new Error(`${key} must reference a direct child of this button`)
          }
        }
      }
      if (node.kind === 'image' && (key === 'imageId' || key === 'imageSource') && node[key] !== value) {
        node.imageType = null
        node.giaRaw.imageSlotType = 0
      }
      node[key] = value
      if (key === 'canControllerFocus') node.giaRaw.footerField505 = value ? 1 : 0
      if (node.kind === 'cursor' && key === 'raycastTarget') node.giaRaw.cursorField501 = value ? 1 : 0
      if ((node.kind === 'textbox' || node.kind === 'textwindow') && key === 'horizontalAlignment') {
        node.giaRaw.textAlign = { Left: 0, Middle: 1, Right: 2 }[value]
      }
      if ((node.kind === 'textbox' || node.kind === 'textwindow') && key === 'verticalAlignment') {
        delete node.giaRaw.textVerticalAlign
      }
      if (node.kind === 'image' && key === 'fillType') {
        const rawFillType = { Horizontal: 1, Vertical: 2, Radial90: 3, Radial180: 4, Radial360: 5 }[value]
        if (rawFillType) node.giaRaw.imageFillType = rawFillType
      }
      if (node.kind === 'image' && key === 'fillHorizontalType') node.giaRaw.imageField503 = ['Left', 'Right'].indexOf(value)
      if (node.kind === 'image' && key === 'fillRadial90Type') node.giaRaw.imageField506 = ['BottomLeft', 'TopLeft', 'TopRight', 'BottomRight'].indexOf(value)
      if (node.kind === 'image' && key === 'fillClockwise') node.giaRaw.imageField505 = value ? 1 : 0
      if (node.kind === 'image' && key === 'fillVerticalType') node.giaRaw.imageField504 = ['Bottom', 'Top'].indexOf(value)
      if (node.kind === 'image' && key === 'fillRadialType') node.giaRaw.imageField507 = ['Bottom', 'Left', 'Top', 'Right'].indexOf(value)
      if (node.kind === 'image' && key === 'imageType') node.giaRaw.imageSlotType = value === 'Stretch' ? 1 : 0
      if (node.kind === 'reference' && key === 'referencedPrefabId') node.giaRaw.templateRefSlot = value
      if (node.kind === 'grid' && key === 'previewCount') node.giaRaw.gridField511 = Math.trunc(value)
      if (node.kind === 'keyhint' && (key === 'keyboardKeyCode' || key === 'controllerKeyCode') && typeof value === 'number') {
        node.giaRaw[key === 'keyboardKeyCode' ? 'keyHintField502' : 'keyHintField501'] = value
      }
      if ((node.kind === 'animation' || node.kind === 'fullscreen') && key === 'animationId') {
        node.giaRaw[node.kind === 'animation' ? 'effectSlot' : 'fullscreenEffectSlot'] = value
      }
      return project
    }
    const { boxes } = layoutTree(project.root, projectCanvas(project))
    const pBox = parentBoxOf(project, node.id, boxes)
    const current = readCurrentTransform(node.transformByPlatform, project.canvasId)
    if (key === 'anchorType') {
      const vis = inspectorFromRectSafe(boxes[node.id])
      let next = setAnchorPreset(current, value)
      next = applyInspectorToTransform(pBox, next, vis)
      writeTransform(project, node, next)
      return project
    }
    if (['rotationX', 'rotationY', 'rotationZ'].includes(key)) {
      const next = {
        ...current,
        rotation: { ...current.rotation, [key.slice(-1).toLowerCase()]: finiteNumber(value, key) },
      }
      writeTransform(project, node, next)
      return project
    }
    if (ANCHOR_KEYS.has(key)) {
      const vis = inspectorFromRectSafe(boxes[node.id])
      const next = { ...current, anchorMin: { ...current.anchorMin }, anchorMax: { ...current.anchorMax }, pivot: { ...current.pivot } }
      if (key === 'anchorMinX') next.anchorMin.x = finiteNumber(value, key)
      if (key === 'anchorMinY') next.anchorMin.y = finiteNumber(value, key)
      if (key === 'anchorMaxX') next.anchorMax.x = finiteNumber(value, key)
      if (key === 'anchorMaxY') next.anchorMax.y = finiteNumber(value, key)
      if (key === 'pivotX') next.pivot.x = finiteNumber(value, key)
      if (key === 'pivotY') next.pivot.y = finiteNumber(value, key)
      writeTransform(project, node, applyInspectorToTransform(pBox, next, vis))
      return project
    }
    if (COMPUTED.has(key)) {
      const vis = inspectorFromRectSafe(boxes[node.id])
      const numeric = finiteNumber(value, key)
      if ((key === 'width' || key === 'height') && numeric < 0) throw new Error(`${key} must not be negative`)
      vis[key] = numeric
      writeTransform(project, node, applyInspectorToTransform(pBox, current, vis))
      return project
    }
    throw new Error(`set: unknown key ${key}`)
  }
  if (type === 'replace') {
    const next = createProject(op.project)
    project.version = next.version
    project.meta = next.meta
    project.canvasId = next.canvasId
    project.selectedId = next.selectedId
    project.root = next.root
    return project
  }
  throw new Error(`unknown op ${type}`)
}

export function applyPatch(project, op) {
  if (!op || typeof op !== 'object') throw new Error('patch requires op')
  if (op.expectedRevision !== undefined && Number(op.expectedRevision) !== project.version) {
    throw new Error(`revision conflict: expected ${op.expectedRevision}, current ${project.version}`)
  }
  const previousVersion = project.version
  const next = JSON.parse(JSON.stringify(project))
  applyPatchMutating(next, op)
  validateProjectReferences(next)
  ensureClientAssetIndices(next)
  next.version = previousVersion + 1
  Object.keys(project).forEach((key) => { delete project[key] })
  Object.assign(project, next)
  return project
}

function inspectorFromRectSafe(box) {
  if (!box) return { posX: 0, posY: 0, width: 0, height: 0 }
  return { posX: box.centerX, posY: box.centerY, width: box.width, height: box.height }
}
