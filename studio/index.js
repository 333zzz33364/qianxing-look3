import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { applyPatch, createProject, snapshotProject } from './ui/project.js'
import { adoptSiteCanvas } from './ui/canvas.js'
import { assertSaveVersion } from './ui/migrate-layout.js'
import { createDefaultClientTemplateProject, createDefaultProject, findNode, findParent, walk, nextUniqueId } from './ui/authoring.js'
import {
  startPlay,
  stepPlay,
  playSnapshot,
  injectPlayKey,
  injectPlayClick,
  injectPlayPointer,
  stopPlay,
  setPlayVar,
  getPlayVar,
  sendPlaySignal,
  setPlayView,
  playAdapter,
} from './play/session.js'
import { caseFromHistory, normalizeCase } from './autotest/format.js'
import { replayCase } from './autotest/runner.js'
import { compileProject } from './play/compile.js'
import { toJson, assertNoUndefined } from './json.js'
import { filterLogs } from './log/collect.js'
import { CANVAS_PRESETS } from './constants.js'
import { MAX_PLAYERS, PLAYER_SLOTS, normalizePlayerCount, normalizePlayerIndex, normalizeServerLogic } from 'qxqy-server'
import { exportGia, exportCombinedGia, importGia, inspectGia, validateGiaCompatibility, validateServerGiaCompatibility, exportScriptGia, importScriptGia, isScriptGia } from './gia/codec.js'
import { collectUsedGuids, isValidGuid, nextFreeGuid } from './gia/guid.js'
import { freshLook2, normalizeLook2, importSiteJson, exportSiteJson } from './look2/site-json.js'
import { exportTimelineData, importTimelineData, exportTimelineLibrary, luaValue } from './look2/timeline-lua.js'
import { bakePrimitives, buildPrimitiveData, exportPrimitiveLibrary, renderPrimitiveSvg, exportPrimitiveCss } from './look2/primitives.js'
import { buildAnimationScripts } from './look2/player.js'
import { EditHistory } from './look2/history.js'
import { normalizeScriptSync } from './script-sync-config.js'
import { collectClientNodes } from './gia/client-order.js'
import { projectForSiteTemplate } from './look2/site-templates.js'
import { scriptGuidSignature } from './control-guid-lua.js'

// 脚本与测试从 qxqy-studio 包入口直接消费这些 GIA 工具导出。
export { exportGia, exportCombinedGia, importGia, inspectGia, validateGiaCompatibility, validateServerGiaCompatibility, exportScriptGia, importScriptGia, isScriptGia }

const ENTITY_LABELS = {
  Level: '关卡',
  PlayerSelf: '当前玩家',
  AvatarSelf: '当前角色',
  ...Object.fromEntries(PLAYER_SLOTS.map((name, i) => [name, `玩家${i + 1}`])),
  ...Object.fromEntries(Array.from({ length: MAX_PLAYERS }, (_, i) => [`Avatar${i + 1}`, `角色${i + 1}`])),
}

function listServerVars(server, playerCount = 1) {
  const bags = server?.vars || {}
  const out = []
  const count = Number(playerCount) > 0 ? Number(playerCount) : 1
  const types = ['Level', 'PlayerSelf', 'AvatarSelf']
  if (count > 1) {
    for (let i = 1; i <= count; i += 1) types.push(`Player${i}`, `Avatar${i}`)
  }
  const seen = new Set()
  for (const entityType of types) {
    if (seen.has(entityType) || !bags[entityType]) continue
    seen.add(entityType)
    const bag = bags[entityType] || {}
    for (const name of Object.keys(bag)) {
      out.push(toJson({
        entityType,
        entityLabel: ENTITY_LABELS[entityType] || entityType,
        name,
        type: bag[name]?.type || '',
        value: bag[name]?.value ?? null,
      }))
    }
  }
  return out
}

const SAVE_FORMAT = 'qxqy-simulator-save'
const SCRIPT_BUNDLE_FORMAT = 'qxqy-simulator-scripts'
const SERVER_ASSET = 'server-control-template'
const CLIENT_ASSET = 'client-control-template'
const ASSET_LABELS = {
  [SERVER_ASSET]: '服务器控件模板',
  [CLIENT_ASSET]: '客户端控件模板',
}

function assetKey(assetType) {
  return assetType === CLIENT_ASSET ? 'client' : 'server'
}

function controlGuid(value) {
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))
  if (!numeric || !isValidGuid(value)) throw new Error('控件索引必须是 1–2147483647 范围内的整数')
  return Number(value)
}

function readControlGuidChanges(raw = []) {
  if (!Array.isArray(raw)) throw new Error('controlGuidChanges 必须是数组')
  const ids = new Set()
  return raw.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
      || ![SERVER_ASSET, CLIENT_ASSET].includes(entry.controlAsset)
      || typeof entry.controlId !== 'string' || !entry.controlId || typeof entry.controlName !== 'string') {
      throw new Error('controlGuidChanges 包含无效或重复的变更记录')
    }
    ids.add(entry.id)
    if (entry.batchId !== undefined && (typeof entry.batchId !== 'string' || !entry.batchId)) {
      throw new Error('controlGuidChanges 包含无效的 batchId')
    }
    if (entry.scriptSignature !== undefined && !/^[a-f0-9]{64}$/.test(entry.scriptSignature)) {
      throw new Error('controlGuidChanges 包含无效的 scriptSignature')
    }
    return {
      id: entry.id, controlAsset: entry.controlAsset, controlId: entry.controlId, controlName: entry.controlName,
      oldGuid: controlGuid(entry.oldGuid), newGuid: controlGuid(entry.newGuid),
      ...(entry.batchId ? { batchId: entry.batchId } : {}),
      ...(entry.scriptSignature ? { scriptSignature: entry.scriptSignature } : {}),
    }
  })
}

function normalizeScriptGuid(raw) {
  const candidates = [raw?.guid, raw?.id]
  for (const value of candidates) {
    const guid = Number(value)
    if (Number.isSafeInteger(guid) && guid > 0 && guid <= 0x7fffffff) return guid
  }
  return 0
}

function normalizeScriptEntry(raw) {
  const rawAsset = String(raw?.controlAsset || '')
  const guid = normalizeScriptGuid(raw)
  return {
    id: guid ? String(guid) : String(raw?.id || ''),
    guid,
    path: String(raw?.path || ''),
    source: String(raw?.source || ''),
    controlId: String(raw?.controlId || ''),
    controlAsset: rawAsset === CLIENT_ASSET || rawAsset === 'client' ? CLIENT_ASSET
      : rawAsset === SERVER_ASSET || rawAsset === 'server' ? SERVER_ASSET
        : '',
  }
}

function seedScriptList(seed) {
  const list = []
  const push = (raw, controlAsset = '') => {
    if (!raw) return
    if (raw.path || raw.source) {
      const entry = normalizeScriptEntry(raw)
      list.push(controlAsset ? { ...entry, controlAsset } : entry)
    }
  }
  if (Array.isArray(seed?.assets?.scripts)) {
    for (const raw of seed.assets.scripts) {
      if (raw && (raw.path || raw.source)) list.push(normalizeScriptEntry(raw))
    }
    return list
  }
  push(seed?.assets?.server?.script, SERVER_ASSET)
  push(seed?.assets?.client?.script, CLIENT_ASSET)
  if (seed && seed.format !== SAVE_FORMAT) {
    push(seed?.script)
    for (const raw of seed?.scripts || []) push(raw)
  }
  return list
}

function defaultProject(assetType) {
  return createProject(assetType === CLIENT_ASSET
    ? createDefaultClientTemplateProject()
    : createDefaultProject())
}

const UNBOUND_WORKSPACE_NAME = '未绑定'
const DEFAULT_SAVE_NAME = '未命名存档'
const DEFAULT_PROJECT_NAME = '未命名界面'


function findWorkspaceRoot(start) {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'simulator', 'studio')) && existsSync(join(dir, 'lua'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

function describeWorkspace(path) {
  if (!path) return { name: UNBOUND_WORKSPACE_NAME, path: '', bound: false }
  return { name: basename(path), path, bound: true }
}

function resolveWorkspaceFile(relOrAbs, cwd = process.cwd()) {
  if (isAbsolute(relOrAbs) && existsSync(relOrAbs)) return relOrAbs
  const start = cwd || process.cwd()
  const root = findWorkspaceRoot(start)
  const fromRoot = resolve(root, relOrAbs)
  if (existsSync(fromRoot)) return fromRoot
  const fromCwd = resolve(start, relOrAbs)
  if (existsSync(fromCwd)) return fromCwd
  throw new Error('script file not found: ' + relOrAbs)
}

export function createStudio(seed, options = {}) {
  if (seed?.format === SAVE_FORMAT) assertSaveVersion(seed.version)
  let migrationWarnings = []
  // 显示用的工作区必须是会话 cwd 本身，缺省保持未绑定，绝不回退到宿主 process.cwd()。
  // 仓库根只用于解析相对路径脚本，不改写顶栏身份。
  let workspacePath = typeof options.workspacePath === 'string' && options.workspacePath
    ? options.workspacePath
    : ''
  const isSave = seed?.format === SAVE_FORMAT && seed.assets
  let controlGuidChanges = readControlGuidChanges(seed?.controlGuidChanges)
  let scriptSync = normalizeScriptSync(seed?.scriptSync)
  let saveMetadata = isSave ? toJson(seed.meta || {}) : {}
  const seededProject = isSave ? null : createProject(seed, { warnings: migrationWarnings })
  const projects = {
    server: isSave && seed.assets.server ? createProject(seed.assets.server, { warnings: migrationWarnings }) : defaultProject(SERVER_ASSET),
    client: isSave && seed.assets.client ? createProject(seed.assets.client, { warnings: migrationWarnings }) : defaultProject(CLIENT_ASSET),
  }
  if (seededProject) projects[assetKey(seededProject.meta.assetType)] = seededProject
  let activeAssetType = isSave && seed.activeAssetType === CLIENT_ASSET
    ? CLIENT_ASSET
    : seededProject?.meta.assetType || SERVER_ASSET
  // 显式存档名（renameSave / 导入存档包写入）优先；否则用中性默认名，不跟目录名漂。
  let explicitSaveName = isSave && seed.meta?.name ? String(seed.meta.name) : ''
  const currentSaveName = () => explicitSaveName || DEFAULT_SAVE_NAME
  if (!seed?.meta?.name && projects.server.meta.name === '未命名界面控件组') {
    projects.server.meta.name = DEFAULT_PROJECT_NAME
  }
  let scripts = []
  const usedScriptGuids = new Set()
  function refreshUsedGuids() {
    usedScriptGuids.clear()
    collectUsedGuids(projects.server.root, usedScriptGuids)
    collectUsedGuids(projects.client.root, usedScriptGuids, { skipServerContainer: true })
    for (const script of scripts) {
      if (isValidGuid(script.guid)) usedScriptGuids.add(Number(script.guid))
    }
  }
  function allocateScriptGuid(preferred = 0) {
    refreshUsedGuids()
    const guid = isValidGuid(preferred) && !usedScriptGuids.has(Number(preferred))
      ? Number(preferred)
      : nextFreeGuid(usedScriptGuids)
    usedScriptGuids.add(guid)
    return guid
  }
  function adoptScript(raw) {
    const entry = normalizeScriptEntry(raw)
    const guid = allocateScriptGuid(entry.guid)
    return { ...entry, guid, id: String(guid) }
  }
  absorbScripts(seedScriptList(seed))
  let serverLogic = normalizeServerLogic(seed?.serverLogic)
  let look2 = normalizeLook2(seed?.look2, projects.client)
  let serverLook2 = normalizeLook2(seed?.look2ByAsset?.server, projects.server)
  const look2For = project => project === projects.client ? look2 : serverLook2
  function storeLook2(state, project = currentProject()) {
    if (project === projects.client) { look2 = normalizeLook2(state, project); syncClientEditorLocks(false) }
    else serverLook2 = normalizeLook2(state, project)
  }
  const savedClientLocks = isSave
    ? Object.hasOwn(seed.assets.client?.meta || {}, 'editorLocks')
    : Object.hasOwn(seed?.meta || {}, 'editorLocks')
  function syncClientEditorLocks(migrateLegacy = false) {
    projects.client.meta.editorLocks ||= {}
    if (migrateLegacy) {
      for (const [id, siteNode] of Object.entries(look2.siteNodes || {})) {
        if (siteNode?.locked === true && findNode(projects.client.root, id)) {
          projects.client.meta.editorLocks[id] = true
        }
      }
    }
    for (const id of Object.keys(projects.client.meta.editorLocks)) {
      const node = findNode(projects.client.root, id)
      if (!node) continue
      const original = look2.siteNodes[id] || { id, type: node.kind, properties: {} }
      look2.siteNodes[id] = { ...original, locked: true }
    }
  }
  syncClientEditorLocks(!savedClientLocks)
  adoptSiteCanvas(projects.client, look2)
  let play = null
  // 试玩侧设备画布：显式指定后粘性生效（隐式重启沿用），playStop 后回到跟随编辑器画布。
  let playCanvasId = ''
  let playPlayerCount = 1
  let playViewPlayerIndex = 1
  const editHistory = new EditHistory(captureEdit, restoreEdit)

  function captureEdit() {
    return toJson({ projects, activeAssetType, explicitSaveName, scripts, serverLogic, look2, serverLook2, migrationWarnings, controlGuidChanges, scriptSync, saveMetadata })
  }

  function restoreEdit(saved, increment) {
    const revision = Math.max(projects.server.version, projects.client.version) + 1
    projects.server = toJson(saved.projects.server)
    projects.client = toJson(saved.projects.client)
    activeAssetType = saved.activeAssetType
    explicitSaveName = saved.explicitSaveName
    scripts = toJson(saved.scripts)
    serverLogic = toJson(saved.serverLogic)
    look2 = toJson(saved.look2)
    serverLook2 = toJson(saved.serverLook2)
    migrationWarnings = [...saved.migrationWarnings]
    controlGuidChanges = toJson(saved.controlGuidChanges)
    scriptSync = toJson(saved.scriptSync)
    saveMetadata = toJson(saved.saveMetadata)
    if (increment) projects.server.version = projects.client.version = revision
    refreshUsedGuids()
  }

  function transaction({ ops = [], state, label = '修改工程', expectedRevision } = {}) {
    if (!Number.isInteger(expectedRevision)) throw new Error('expectedRevision is required')
    checkRevision({ expectedRevision })
    if (!Array.isArray(ops)) throw new Error('事务 ops 必须为数组')
    const revision = Math.max(projects.server.version, projects.client.version) + 1
    editHistory.run(label, () => {
      let clientCanvasSelected = false
      for (const op of ops) {
        if (!op || typeof op !== 'object') throw new Error('事务中包含无效操作')
        const { expectedRevision: ignored, ...operation } = op
        const targetProject = currentProject()
        patchCore(operation)
        if (operation.op === 'setCanvas' && targetProject === projects.client && CANVAS_PRESETS[operation.canvasId]) {
          clientCanvasSelected = true
        }
      }
      if (state !== undefined) {
        storeLook2(state)
      }
      if (clientCanvasSelected) delete look2.siteCanvasSettings
      projects.server.version = projects.client.version = revision
      reconcileScriptMounts()
    })
    return get()
  }

  function history({ action = 'list', index, expectedRevision } = {}) {
    if (action === 'list') return { ...get(), history: editHistory.describe() }
    if (!['undo', 'redo', 'restore'].includes(action)) throw new Error('未知历史操作')
    if (!Number.isInteger(expectedRevision)) throw new Error('expectedRevision is required')
    checkRevision({ expectedRevision })
    editHistory.move(action, index)
    return get()
  }

  function normalizePlayCanvasId(raw) {
    const key = String(raw || '').trim()
    if (!key) return ''
    if (!CANVAS_PRESETS[key]) {
      throw new Error(`unknown canvas preset: ${key} (available: ${Object.keys(CANVAS_PRESETS).join(', ')})`)
    }
    return key
  }

  const currentProject = () => projects[assetKey(activeAssetType)]

  function findControlTarget(controlId) {
    if (!controlId) return null
    for (const [key, project] of [['server', projects.server], ['client', projects.client]]) {
      const node = findNode(project.root, controlId)
      if (node && node.kind !== 'server-container') return { key, node }
    }
    return null
  }

  function resolveScriptTarget(script) {
    if (!script.controlId) return null
    const assetKey = script.controlAsset === CLIENT_ASSET ? 'client' : script.controlAsset === SERVER_ASSET ? 'server' : null
    if (assetKey) {
      const node = findNode(projects[assetKey].root, script.controlId)
      if (node && node.kind !== 'server-container') return { key: assetKey, node }
      return null
    }
    return findControlTarget(script.controlId)
  }

  function reconcileScriptMounts() {
    for (const script of scripts) {
      if (script.controlId && !script.controlAsset) {
        const target = findControlTarget(script.controlId)
        if (target) script.controlAsset = target.key === 'client' ? CLIENT_ASSET : SERVER_ASSET
      }
      if (script.controlId && !resolveScriptTarget(script)) {
        script.controlId = ''
        script.controlAsset = ''
      }
    }
  }

  function collectSubtreeIds(node) {
    const ids = new Set()
    if (node) walk(node, row => ids.add(String(row.id)))
    return ids
  }

  function purgeLook2NodeReferences(ids, state = look2) {
    if (!ids?.size) return
    for (const id of ids) delete state.siteNodes?.[id]
    for (const animation of state.animations || []) {
      if (Array.isArray(animation.keyframeTracks)) {
        animation.keyframeTracks = animation.keyframeTracks.filter(track => !ids.has(String(track.nodeId)))
      }
      if (Array.isArray(animation.events)) {
        animation.events = animation.events.filter(event => !ids.has(String(event.nodeId)))
      }
    }
  }

  function scriptMountFromGenericSlot(guid) {
    if (!isValidGuid(guid)) return null
    for (const [assetType, project] of [[SERVER_ASSET, projects.server], [CLIENT_ASSET, projects.client]]) {
      let controlId = ''
      walk(project.root, (node) => {
        if (!controlId && (node.scriptMappingIds || []).includes(Number(guid))) controlId = node.id
      })
      if (controlId) return { controlId, controlAsset: assetType }
    }
    return null
  }

  function rewriteGenericScriptGuid(mount, previousGuid, nextGuid) {
    const project = projects[assetKey(mount.controlAsset)]
    const node = project && findNode(project.root, mount.controlId)
    if (!node) return
    node.scriptMappingIds = (node.scriptMappingIds || []).map((guid) => (
      Number(guid) === Number(previousGuid) ? Number(nextGuid) : guid
    ))
  }
  reconcileScriptMounts()

  function describeScripts() {
    return scripts.map((script) => {
      const target = resolveScriptTarget(script)
      const assetType = target ? (target.key === 'client' ? CLIENT_ASSET : SERVER_ASSET) : ''
      return toJson({
        id: script.id,
        guid: script.guid || 0,
        path: script.path || '',
        source: script.source || '',
        controlId: script.controlId || '',
        controlAsset: script.controlAsset || assetType,
        controlName: target?.node.name || '',
        assetType,
        assetLabel: target ? ASSET_LABELS[assetType] : '',
        mounted: Boolean(target),
      })
    })
  }

  function mountTargetRows() {
    const out = []
    const collect = (project, assetType) => {
      walk(project.root, (node) => {
        if (node.kind === 'server-container') return
        out.push(toJson({ id: node.id, name: node.name, kind: node.kind, assetType, assetLabel: ASSET_LABELS[assetType] }))
      })
    }
    collect(projects.server, SERVER_ASSET)
    collect(projects.client, CLIENT_ASSET)
    return out
  }

  function factoryFingerprint(project) {
    const rows = []
    walk(project.root, (node) => {
      if (node.kind === 'server-container') return
      rows.push(JSON.stringify({
        kind: node.kind,
        guid: node.guid,
        name: node.name,
        text: node.text ?? null,
        imageId: node.imageId ?? null,
        imageSource: node.imageSource ?? null,
        imageType: node.imageType ?? null,
        fontSize: node.fontSize ?? null,
        adaptiveFontSize: node.adaptiveFontSize ?? null,
        minimumFontSize: node.minimumFontSize ?? null,
        fontColor: node.fontColor ?? null,
        bgColor: node.bgColor ?? null,
        imageColor: node.imageColor ?? null,
        fillType: node.fillType ?? null,
        fillAmount: node.fillAmount ?? null,
        syncAllDevices: node.syncAllDevices !== false,
        transformByPlatform: node.transformByPlatform || null,
      }))
    })
    return rows.join('/')
  }

  const FACTORY_CLIENT_FINGERPRINT = factoryFingerprint(createDefaultClientTemplateProject())
  const FACTORY_SERVER_FINGERPRINT = factoryFingerprint(createDefaultProject())

  function isFactoryDefaultProject(project) {
    const fingerprint = factoryFingerprint(project)
    return project.meta?.assetType === CLIENT_ASSET
      ? fingerprint === FACTORY_CLIENT_FINGERPRINT
      : fingerprint === FACTORY_SERVER_FINGERPRINT
  }

  function safeFilePart(name, fallback) {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '-').trim()
    return cleaned || fallback
  }

  function assetExportStem(project) {
    const save = safeFilePart(currentSaveName(), DEFAULT_SAVE_NAME)
    const kind = project.meta?.assetType === CLIENT_ASSET ? '客户端控件模板' : '服务器控件模板'
    return `${save} · ${kind}`
  }

  function buildCombinedControlProject() {
    const hostRoot = (projects.server.root.children || []).find((node) => node.kind === 'container')
      || projects.server.root.children?.[0]
    if (!hostRoot) throw new Error('整合包需要服务端客户端控件容器下至少有一个根控件')
    const animation = allAnimationBundles()
    const result = exportCombinedGia(animation.server.project, animation.client.project, {
      scripts: [...animation.scripts, ...scripts],
      fileName: `${safeFilePart(currentSaveName(), DEFAULT_SAVE_NAME)} · 整合包.gia`,
    })
    result.warnings.push(...animation.warnings)
    return result
  }

  function saveDescriptor() {
    const describe = (project) => ({
      type: project.meta.assetType,
      name: project.meta.name,
      sourceFile: project.meta.sourceFile || '',
    })
    return {
      format: SAVE_FORMAT,
      name: currentSaveName(),
      activeAssetType,
      assets: {
        server: describe(projects.server),
        client: describe(projects.client),
        scripts: describeScripts(),
      },
    }
  }

  function archiveData() {
    return toJson({
      format: SAVE_FORMAT,
      version: 4,
      meta: { ...saveMetadata, name: currentSaveName() },
      look2,
      look2ByAsset: { server: serverLook2 },
      activeAssetType,
      serverLogic,
      controlGuidChanges,
      scriptSync,
      assets: {
        server: projects.server,
        client: projects.client,
        scripts: scripts.map((script) => toJson({
          id: script.id,
          guid: script.guid || 0,
          path: script.path || '',
          source: script.source || '',
          controlId: script.controlId || '',
          controlAsset: script.controlAsset || '',
        })),
      },
    })
  }

  function get() {
    const project = currentProject()
    const snap = snapshotProject(project)
    snap.version = Math.max(projects.server.version, projects.client.version)
    snap.workspace = describeWorkspace(workspacePath)
    snap.save = saveDescriptor()
    snap.scripts = describeScripts()
    snap.mountTargets = mountTargetRows()
    snap.serverLogic = serverLogic
    // Both assets contain client controls. Their animation state is independent.
    snap.look2 = toJson(look2For(project))
    snap.history = editHistory.describe()
    snap.animationPreviewRoot = compileProject(project).root
    snap.migrationWarnings = [...migrationWarnings]
    snap.look2Warnings = templateReferenceWarnings()
    snap.controlGuidChanges = toJson(controlGuidChanges)
    if (activeAssetType === CLIENT_ASSET) {
      const ordered = collectClientNodes(project, true)
      snap.clientGuidAutofill = {
        count: ordered.length,
        templateCount: ordered.filter(({ parent }) => parent?.kind === 'server-container').length,
        selectedOffset: ordered.findIndex(({ node }) => node.id === snap.selectedId),
      }
    }
    snap.scriptSync = toJson(scriptSync)
    assertNoUndefined(snap)
    return snap
  }

  function templateReferenceWarnings() {
    const known = new Set(compileProject(projects.client).templates.map(row => Number(row.prefabIndex)))
    for (const entry of look2.controlTemplates || []) if (entry.project?.root) known.add(Number(entry.index))
    const warnings = []
    const inspect = project => walk(project.root, node => {
      if (node.kind !== 'reference' || node.referencedPrefabId == null || node.referencedPrefabId === '') return
      const index = Number(node.referencedPrefabId)
      if (!Number.isSafeInteger(index) || index < 0 || !known.has(index)) {
        warnings.push(`${node.name}: 当前工程未导入控件模板索引 ${node.referencedPrefabId}`)
      }
    })
    inspect(projects.server); inspect(projects.client)
    for (const entry of look2.controlTemplates || []) if (entry.project?.root) inspect(entry.project)
    return [...new Set(warnings)]
  }

  function checkRevision(op) {
    const project = currentProject()
    const revision = Math.max(projects.server.version, projects.client.version)
    if (op.expectedRevision !== undefined && Number(op.expectedRevision) !== revision) {
      throw new Error(`revision conflict: expected ${op.expectedRevision}, current ${revision}`)
    }
    return project
  }

  function setScriptMount(script, controlId, controlAsset = '') {
    const value = String(controlId || '')
    if (value) {
      const asset = controlAsset === CLIENT_ASSET ? CLIENT_ASSET : controlAsset === SERVER_ASSET ? SERVER_ASSET : ''
      const probe = { controlId: value, controlAsset: asset }
      const target = resolveScriptTarget(probe)
      if (!target) throw new Error('挂载目标必须是存档内的客户端控件或客户端控件模板')
      script.controlAsset = asset || (target.key === 'client' ? CLIENT_ASSET : SERVER_ASSET)
    } else {
      script.controlAsset = ''
    }
    script.controlId = value
  }

  function applyScriptOp(op) {
    const project = checkRevision(op)
    if (op.op === 'addScript') {
      const script = adoptScript({ path: String(op.path || ''), source: String(op.source || ''), controlId: '', controlAsset: '' })
      if (op.controlId !== undefined && op.controlId !== '') setScriptMount(script, op.controlId, op.controlAsset)
      scripts.push(script)
    } else if (op.op === 'updateScript') {
      const script = scripts.find((row) => row.id === op.id)
      if (!script) throw new Error(`脚本不存在: ${op.id}`)
      if (op.controlId !== undefined) setScriptMount(script, op.controlId, op.controlAsset)
      if (op.path !== undefined) script.path = String(op.path)
      if (op.source !== undefined) script.source = String(op.source)
    } else if (op.op === 'removeScript') {
      const before = scripts.length
      scripts = scripts.filter((row) => row.id !== op.id)
      if (scripts.length === before) throw new Error(`脚本不存在: ${op.id}`)
    }
    project.version += 1
    return get()
  }

  function setControlGuid(op) {
    const project = checkRevision(op)
    const node = findNode(project.root, op.id ?? project.selectedId)
    if (!node || node.kind === 'server-container') throw new Error('仅客户端控件或客户端控件模板允许修改索引')
    const guid = controlGuid(op.guid)
    controlGuid(node.guid)
    if (op.autoFillClientGuids !== undefined && typeof op.autoFillClientGuids !== 'boolean') {
      throw new Error('autoFillClientGuids 必须是布尔值')
    }
    const automatic = op.autoFillClientGuids === true
    if (automatic && activeAssetType !== CLIENT_ASSET) {
      throw new Error('自动填充仅支持客户端模板列表；服务端界面的索引需单独填写')
    }
    const targets = automatic ? collectClientNodes(project, true).map(({ node }) => node) : [node]
    const base = guid - targets.indexOf(node)
    const mappings = targets.map((target, offset) => ({
      node: target, oldGuid: controlGuid(target.guid), newGuid: controlGuid(base + offset),
    }))
    const changes = mappings.filter(({ oldGuid, newGuid }) => oldGuid !== newGuid)
    if (!changes.length) return get()
    const remap = new Map(mappings.map(({ oldGuid, newGuid }) => [oldGuid, newGuid]))
    if (remap.size !== mappings.length) throw new Error('客户端模板存在重复旧索引，无法自动填充；请先消除歧义')
    const targetSet = new Set(targets)
    const nodes = []
    for (const entry of Object.values(projects)) {
      walk(entry.root, (candidate) => {
        if (entry === projects.client && candidate.kind === 'server-container') return
        nodes.push({ node: candidate, project: entry })
      })
    }
    const occupied = new Map([
      ...nodes.filter((entry) => !targetSet.has(entry.node)).map(({ node }) => [Number(node.guid), node.name]),
      ...scripts.map((script) => [Number(script.guid), script.path || 'Lua 脚本']),
    ])
    for (const { newGuid } of changes) {
      if (occupied.has(newGuid)) throw new Error(`控件索引 ${newGuid} 已被「${occupied.get(newGuid)}」占用；请先填写它的实际索引。本次未修改任何索引。`)
    }
    // These three fields are explicit GUID references. Internal ids, button
    // state ids, image ids and Lua numbers must never be replaced by value.
    const references = []
    const collectReference = (owner, key, entry) => {
      const value = owner?.[key]
      if ((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())))
        && remap.has(Number(value)) && remap.get(Number(value)) !== Number(value)) {
        references.push({ owner, key, project: entry.project, oldGuid: Number(value), newGuid: remap.get(Number(value)) })
      }
    }
    for (const entry of nodes) {
      collectReference(entry.node, 'referencedPrefabId', entry)
      collectReference(entry.node, 'itemPrefabId', entry)
      collectReference(entry.node.giaRaw, 'templateRefSlot', entry)
    }
    const occurrences = new Map()
    for (const { node } of nodes) occurrences.set(Number(node.guid), (occurrences.get(Number(node.guid)) || 0) + 1)
    for (const { oldGuid } of references) {
      if (occurrences.get(oldGuid) !== 1) throw new Error(`旧索引 ${oldGuid} 在多棵资产树中重复，无法确定模板引用归属；请先消除歧义后修改`)
    }
    // All validation is complete before changing either tree or the ledger.
    // One batch is a simultaneous permutation, never a chain of replacements.
    const batchId = automatic ? randomUUID() : ''
    const scriptSignature = scriptGuidSignature(scripts)
    for (const { node, oldGuid, newGuid } of changes) {
      node.guid = newGuid
      controlGuidChanges.push({
        id: randomUUID(), controlAsset: activeAssetType, controlId: node.id,
        controlName: node.name, oldGuid, newGuid, scriptSignature, ...(batchId ? { batchId } : {}),
      })
    }
    const changedProjects = new Set([project])
    for (const { owner, key, project: referencedProject, newGuid } of references) {
      owner[key] = typeof owner[key] === 'string' ? String(newGuid) : newGuid
      changedProjects.add(referencedProject)
    }
    for (const changed of changedProjects) changed.version += 1
    return get()
  }

  function acknowledgeControlGuidChanges(op) {
    const project = checkRevision(op)
    if (!Array.isArray(op.changeIds) || !op.changeIds.length
      || op.changeIds.some((id) => typeof id !== 'string' || !controlGuidChanges.some((change) => change.id === id))) {
      throw new Error('请明确指定已核对 Lua 引用的有效索引变更记录 changeIds')
    }
    const acknowledged = new Set(op.changeIds)
    controlGuidChanges = controlGuidChanges.filter((change) => !acknowledged.has(change.id))
    project.version += 1
    return get()
  }

  function patchCore(op) {
    if (!op || typeof op !== 'object') throw new Error('patch requires op')
    if (op.op === 'setScriptSync') {
      const project = checkRevision(op)
      scriptSync = normalizeScriptSync(op.config)
      project.version += 1
      return get()
    }
    if (op.op === 'setControlGuid') return setControlGuid(op)
    if (op.op === 'acknowledgeControlGuidChanges') return acknowledgeControlGuidChanges(op)
    if (op.op === 'newDocument') {
      const name = String(op.name || '未命名工程').trim()
      if (!name) throw new Error('工程名称不能为空')
      const blank = importSiteJson({ version: 12, name, previewPresetId: 'pc-16-9', nodes: [{
        id: `root_${crypto.randomUUID()}`, parentId: null, name: 'Default_UI', type: 'container',
        anchorMinX: 0, anchorMinY: 0, anchorMaxX: 1, anchorMaxY: 1,
        pivotX: .5, pivotY: .5, sizeDeltaX: 0, sizeDeltaY: 0, properties: {},
      }] })
      projects.server = defaultProject(SERVER_ASSET)
      projects.client = blank.project
      look2 = blank.look2
      serverLook2 = freshLook2()
      scripts = []
      serverLogic = normalizeServerLogic({})
      migrationWarnings = []
      controlGuidChanges = []
      scriptSync = null
      saveMetadata = {}
      explicitSaveName = name
      activeAssetType = CLIENT_ASSET
      return get()
    }
    if (op.op === 'setServerLogic') {
      const project = checkRevision(op)
      serverLogic = normalizeServerLogic(op.logic)
      project.version += 1
      return get()
    }
    if (op.op === 'addScript' || op.op === 'updateScript' || op.op === 'removeScript') {
      return applyScriptOp(op)
    }
    if (op.op === 'selectAsset') {
      activeAssetType = op.assetType === CLIENT_ASSET ? CLIENT_ASSET : SERVER_ASSET
      return get()
    }
    if (op.op === 'renameSave') {
      const name = String(op.name || '').trim()
      if (!name) throw new Error('存档名称不能为空')
      explicitSaveName = name
      return get()
    }
    if (op.op === 'newAsset') {
      const project = checkRevision(op)
      const nextAssetType = op.assetType === CLIENT_ASSET ? CLIENT_ASSET : SERVER_ASSET
      if (nextAssetType === CLIENT_ASSET) {
        const oldIds = new Set()
        for (const child of projects.client.root.children || []) {
          for (const id of collectSubtreeIds(child)) oldIds.add(id)
        }
        purgeLook2NodeReferences(oldIds)
      }
      activeAssetType = nextAssetType
      const next = defaultProject(activeAssetType)
      next.version = project.version + 1
      projects[assetKey(activeAssetType)] = next
      controlGuidChanges = controlGuidChanges.filter(change => change.controlAsset !== activeAssetType)
      if (nextAssetType === SERVER_ASSET) serverLook2 = freshLook2()
      reconcileScriptMounts()
      return get()
    }
    if (op.op === 'duplicate') {
      duplicateControl(op)
      return get()
    }
    if (op.op === 'set' && op.key === 'locked') {
      // Retain compatibility with callers predating the editor lock domain operation.
      return patchCore({ ...op, op: 'setEditorLock', locked: op.value === true })
    }
    if (op.op === 'setEditorLock') {
      const project = checkRevision(op)
      if (typeof op.locked !== 'boolean') throw new Error('locked 必须为布尔值')
      const id = String(op.id || project.selectedId)
      const node = findNode(project.root, id)
      if (!node || node.kind === 'server-container') throw new Error('控件不存在或不能锁定')
      project.meta.editorLocks ||= {}
      if (op.locked === true) project.meta.editorLocks[id] = true
      else delete project.meta.editorLocks[id]
      if (project === projects.client) {
        const original = look2.siteNodes[id] || { id, type: node.kind, properties: {} }
        look2.siteNodes[id] = { ...original, locked: op.locked === true }
      }
      project.version += 1
      return get()
    }
    const project = currentProject()
    const removedIds = op.op === 'remove'
      ? collectSubtreeIds(findNode(project.root, op.id || project.selectedId))
      : null
    if ((op.op === 'add' || op.op === 'addTemplate') && op.kind === 'primitive') {
      applyPatch(project, { ...op, kind: 'image', name: op.name || '图元图片' })
      const id = project.selectedId
      if (project === projects.client) {
        look2.siteNodes[id] = { id, type: 'primitive', properties: { imageUrl: '', imageResourceId: null, previewMode: 'image' } }
      }
    } else {
      applyPatch(project, op)
      if (op.op === 'setCanvas' && project === projects.client && CANVAS_PRESETS[op.canvasId]) {
        delete look2.siteCanvasSettings
      }
    }
    if (removedIds?.size) {
      for (const id of removedIds) delete project.meta.editorLocks?.[id]
      purgeLook2NodeReferences(removedIds, look2For(project))
    }
    reconcileScriptMounts()
    return get()
  }

  function patch(op) {
    if (!op || typeof op !== 'object') throw new Error('patch requires op')
    checkRevision(op)
    const revision = Math.max(projects.server.version, projects.client.version) + 1
    const { expectedRevision: ignored, ...operation } = op
    const apply = () => {
      patchCore(operation)
      if (op.op === 'setControlGuid' && Math.max(projects.server.version, projects.client.version) === revision - 1) return
      if (op.op !== 'selectAsset') projects.server.version = projects.client.version = revision
    }
    const tracksImportedCanvasSettings = op.op === 'setCanvas'
      && currentProject() === projects.client
      && !!look2.siteCanvasSettings
      && !!CANVAS_PRESETS[op.canvasId]
    if (['select', 'selectAsset', 'pick'].includes(op.op)
      || (op.op === 'setCanvas' && !tracksImportedCanvasSettings)) {
      apply()
      return get()
    }
    editHistory.run(op?.label || ({ set: '修改控件属性', setEditorLock: op.locked ? '锁定控件' : '解锁控件', add: '新增控件', remove: '删除控件', duplicate: '复制控件', reparent: '调整控件层级', moveSibling: '调整控件层序', setCanvas: '选择画布' })[op?.op] || '修改工程', apply)
    return get()
  }

  function copyBranch(source, project, extraUsed = new Set()) {
    const branch = toJson(source), idMap = new Map(), guidMap = new Map()
    const used = collectUsedGuids(projects.server.root)
    collectUsedGuids(projects.client.root, used)
    for (const script of scripts) if (script.guid) used.add(script.guid)
    for (const guid of extraUsed) used.add(guid)
    let sequence = 1
    walk(branch, node => {
      let id
      do { id = `look2-copy-${sequence++}` } while (findNode(project.root, id) || [...idMap.values()].includes(id))
      idMap.set(node.id, id)
      const guid = nextFreeGuid(used); used.add(guid)
      if (node.guid) guidMap.set(Number(node.guid), guid)
      node.id = id; node.guid = guid
      delete node.giaInfoIndex
      delete node.giaInfoIndexSource
      node.scriptMappingIds = []
    })
    walk(branch, node => {
      for (const key of ['unavailableChildId', 'hoverChildId', 'pressedChildId', 'selectedChildId']) {
        if (node[key]) node[key] = idMap.get(node[key]) || null
      }
    })
    return { branch, idMap, guidMap }
  }

  function animationEventTargetPath(project, nodeId) {
    let node = findNode(project.root, nodeId)
    if (!node) return ''
    const parts = []
    while (true) {
      const parent = findParent(project.root, node.id)
      if (!parent) return ''
      if (parent === project.root) break
      parts.push(node.name)
      node = parent
    }
    return parts.reverse().join('/')
  }

  function duplicateControl(op) {
    const project = checkRevision(op)
    const source = findNode(project.root, op.id || project.selectedId)
    if (!source || source.kind === 'server-container') throw new Error('请选择要复制的客户端控件')
    const parent = op.parentId ? findNode(project.root, op.parentId) : findParent(project.root, source.id)
    if (!parent || parent.kind === 'server-container' && source.kind !== 'container') throw new Error('无效的复制目标')
    const siblingNames = new Set((parent.children || []).map(row => row.name))
    let name
    if (op.name !== undefined) {
      name = String(op.name ?? '').trim()
      if (!name) throw new Error('复制名称不能为空')
      if (siblingNames.has(name)) throw new Error(`同级控件已存在名称“${name}”；请更换复制名称`)
    } else {
      const baseName = `${source.name}_副本`
      name = baseName
      let suffix = 2
      while (siblingNames.has(name)) name = `${baseName}（${suffix++}）`
    }
    const { branch, idMap } = copyBranch(source, project)
    branch.name = name
    parent.children.push(branch)
    const animationState = look2For(project)
    for (const [oldId, newId] of idMap) {
      if (project.meta.editorLocks?.[oldId]) project.meta.editorLocks[newId] = true
      if (animationState.siteNodes[oldId]) {
        animationState.siteNodes[newId] = { ...toJson(animationState.siteNodes[oldId]), id: newId, parentId: idMap.get(animationState.siteNodes[oldId].parentId) || parent.id }
      }
    }
    {
      for (const animation of animationState.animations) {
        const added = []
        for (const track of animation.keyframeTracks || []) if (idMap.has(track.nodeId)) {
          const copy = toJson(track)
          copy.id = `track_${crypto.randomUUID()}`
          copy.nodeId = idMap.get(track.nodeId)
          for (const key of copy.keyframes || []) key.id = `key_${crypto.randomUUID()}`
          added.push(copy)
        }
        animation.keyframeTracks.push(...added)
        animation.events ||= []
        for (const event of [...animation.events]) if (idMap.has(event.nodeId)) {
          const nodeId = idMap.get(event.nodeId)
          const copy = { ...toJson(event), id: `event_${crypto.randomUUID()}`, nodeId,
            target: animationEventTargetPath(project, nodeId) }
          if (copy.handler && idMap.has(copy.handler.targetNodeId)) {
            const oldTargetId = copy.handler.targetNodeId
            copy.handler.targetNodeId = idMap.get(oldTargetId)
            if (scripts.some(script => script.controlAsset === project.meta.assetType
              && script.controlId === oldTargetId && script.path === copy.handler.scriptPath)) {
              copy.handler.scriptPath = `副本-${copy.handler.scriptPath}`
            }
          }
          animation.events.push(copy)
        }
      }
    }
    for (const script of [...scripts]) if (script.controlAsset === project.meta.assetType && idMap.has(script.controlId)) {
      const adopted = adoptScript({ ...script, guid: 0, id: '', controlId: idMap.get(script.controlId), path: `副本-${script.path}` })
      scripts.push(adopted)
      const target = findNode(project.root, adopted.controlId)
      target.scriptMappingIds.push(adopted.guid)
    }
    project.selectedId = branch.id
    project.version += 1
  }

  function template(input = {}) {
    const { action, id, expectedRevision } = input
    if (!Number.isInteger(expectedRevision)) throw new Error('expectedRevision is required')
    checkRevision({ expectedRevision })
    editHistory.run(({ import: '导入控件模板', update: '修改控件模板', remove: '删除控件模板', instantiate: '实例化控件模板' })[action] || '修改控件模板', () => {
      if (action === 'import') {
        if (typeof input.data !== 'string' || !input.data) throw new Error('请提供模板 GIA')
        const imported = importGia(Buffer.from(input.data, 'base64'))
        const project = createProject(imported.clientProject || imported.project)
        if (project.meta.assetType !== CLIENT_ASSET) throw new Error('请导入客户端控件模板 GIA')
        const index = input.index === undefined ? Math.max(0, ...look2.controlTemplates.map(row => Number(row.index) || 0)) + 1 : Number(input.index)
        checkTemplateIndex(index)
        look2.controlTemplates.push({ id: `template_${crypto.randomUUID()}`, name: String(input.name || project.meta.name || '控件模板'), index,
          project: toJson(project), scripts: toJson(imported.scripts || []), filename: basename(input.filename || 'template.gia'), warnings: imported.warnings || [] })
      } else {
        const entry = look2.controlTemplates.find(row => row.id === id)
        if (!entry) throw new Error('控件模板不存在')
        if (action === 'update') {
          if (input.index !== undefined) {
            const index = Number(input.index)
            checkTemplateIndex(index, id)
            if (index !== entry.index) remapTemplateReferences(entry.index, index)
            entry.index = index
          }
          if (input.name !== undefined) {
            if (!String(input.name).trim()) throw new Error('模板名称不能为空')
            entry.name = String(input.name).trim()
          }
        } else if (action === 'remove') {
          look2.controlTemplates = look2.controlTemplates.filter(row => row.id !== id)
        } else if (action === 'instantiate') {
          const project = projects.client
          const parent = findNode(project.root, input.parentId || project.selectedId)
          if (!parent) throw new Error('实例化父控件不存在')
          if (!entry.project?.root) throw new Error('此模板没有可实例化的控件树；请重新导入 GIA')
          const templateProject = projectForSiteTemplate(entry, project.canvasId)
          const source = templateProject.root.children?.find(row => row.id === templateProject.selectedId) || templateProject.root.children?.[0]
          if (!source) throw new Error('控件模板为空')
          const usedScripts = new Set((entry.scripts || []).map(row => Number(row.guid)).filter(isValidGuid))
          const { branch, idMap } = copyBranch(source, project, usedScripts)
          const baseName = String(input.name ?? entry.name ?? source.name).trim()
          if (!baseName) throw new Error('实例化名称不能为空')
          const names = new Set(parent.children.map(node => node.name))
          if (input.name !== undefined && names.has(baseName)) throw new Error(`同级控件已存在名称“${baseName}”`)
          branch.name = baseName
          let suffix = 2
          while (names.has(branch.name)) branch.name = `${baseName}（${suffix++}）`
          parent.children.push(branch)
          for (const raw of entry.scripts || []) {
            const oldId = raw.controlId || (() => {
              let result = ''
              walk(source, node => { if ((node.scriptMappingIds || []).includes(Number(raw.guid))) result = node.id })
              return result
            })()
            if (!idMap.has(oldId)) continue
            const script = adoptScript({ ...raw, guid: 0, id: '', controlId: idMap.get(oldId), controlAsset: CLIENT_ASSET })
            scripts.push(script)
            findNode(project.root, script.controlId).scriptMappingIds.push(script.guid)
          }
          project.selectedId = branch.id
          activeAssetType = CLIENT_ASSET
          const validated = createProject(project)
          projects.client = validated
        } else throw new Error('未知模板操作')
      }
      projects.server.version = projects.client.version = Math.max(projects.server.version, projects.client.version) + 1
    })
    return get()
  }

  function remapTemplateReferences(previous, next) {
    const remap = (owner, key) => {
      const value = owner?.[key]
      if (value !== null && value !== undefined && value !== '' && Number(value) === previous) {
        owner[key] = typeof value === 'string' ? String(next) : next
      }
    }
    for (const project of [projects.server, projects.client, ...look2.controlTemplates.map(entry => entry.project).filter(Boolean)]) {
      walk(project.root, node => {
        if (node.kind === 'reference') { remap(node, 'referencedPrefabId'); remap(node.giaRaw, 'templateRefSlot') }
        if (node.kind === 'grid') remap(node, 'itemPrefabId')
      })
    }
    for (const entry of look2.controlTemplates) {
      for (const device of entry.devices || []) for (const row of device) {
        if (row.type === 'reference') remap(row.properties, 'referencedPrefabIndex')
        if (row.type === 'gridScroller') remap(row.properties, 'itemPrefabIndex')
      }
    }
    for (const state of [look2, serverLook2]) {
      for (const node of Object.values(state.siteNodes || {})) {
        if (node.type === 'reference') remap(node.properties, 'referencedPrefabIndex')
        if (['grid', 'gridScroller'].includes(node.type)) remap(node.properties, 'itemPrefabIndex')
      }
    }
  }

  function checkTemplateIndex(index, excludingId = '') {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) throw new Error('模板索引必须为 0–2147483647 范围内的整数')
    if (look2.controlTemplates.some(row => row.id !== excludingId && Number(row.index) === index)) throw new Error('模板索引已存在')
  }

  function scriptsInProject(assetType) {
    return scripts.filter((script) => {
      const target = resolveScriptTarget(script)
      return Boolean(target && (target.key === 'client') === (assetType === CLIENT_ASSET))
    })
  }

  function animationBundle(options = {}, assetType = CLIENT_ASSET, generatedScripts = []) {
    const project = projects[assetKey(assetType)]
    const state = look2For(project)
    const baked = project === projects.client ? bakePrimitives(project, state) : { project, warnings: [] }
    const otherProject = project === projects.client ? projects.server : projects.client
    const animation = buildAnimationScripts(baked.project, state, [...scripts, ...generatedScripts], [otherProject.root], { ...options, assetType })
    return { ...animation, project: baked.project, warnings: [...baked.warnings, ...animation.warnings, ...templateReferenceWarnings()] }
  }

  function allAnimationBundles(serverOptions = {}, clientOptions = {}) {
    const client = animationBundle(clientOptions, CLIENT_ASSET)
    const server = animationBundle(serverOptions, SERVER_ASSET, client.scripts)
    return { client, server, scripts: [...client.scripts, ...server.scripts], warnings: [...client.warnings, ...server.warnings] }
  }

  function exportData(format = 'json', requestedAssetType = '') {
    const result = exportDataRaw(format, requestedAssetType)
    if (controlGuidChanges.length && !['save', 'archive'].includes(String(format).toLowerCase())) {
      const warnings = controlGuidChanges.map((change) => `控件索引待核对 Lua 引用：${ASSET_LABELS[change.controlAsset]} / ${change.controlName} (${change.controlId})：${change.oldGuid} → ${change.newGuid}。请按语义更新脚本中的控件索引引用，核对后确认变更记录 ${change.id}；不要全局替换同值数字。`)
      result.warnings = [...new Set([...(result.warnings || []), ...warnings])]
    }
    return result
  }

  function exportDataRaw(format = 'json', requestedAssetType = '') {
    const normalized = String(format).toLowerCase()
    if (['timeline-lib', 'primitive-lib', 'primitive-data', 'primitive-svg', 'primitive-css'].includes(normalized)) {
      let source, filename, mimeType = 'text/x-lua'
      if (normalized === 'timeline-lib') { source = exportTimelineLibrary(); filename = 'TweenTimelineLib.lua' }
      else if (normalized === 'primitive-lib') { source = exportPrimitiveLibrary(); filename = 'PrimitiveImageLib.lua' }
      else if (normalized === 'primitive-data') {
        const rootId = requestedAssetType || projects.client.selectedId || projects.client.root.children?.[0]?.id
        source = `return ${luaValue(buildPrimitiveData(projects.client, look2, rootId))}\n`
        filename = 'PrimitiveData.lua'
      } else {
        const nodeId = requestedAssetType || projects.client.selectedId
        const properties = look2.siteNodes[nodeId]?.properties || {}
        const resource = look2.primitiveResources.find(row => row.id === nodeId || row.id === (properties.imageResourceId || properties.primitiveResourceId))
        if (!resource?.fitData) throw new Error('所选控件或图片资源没有拟合结果')
        source = normalized === 'primitive-svg' ? renderPrimitiveSvg(resource.fitData) : exportPrimitiveCss(resource.fitData)
        filename = `${safeFilePart(resource.name, '图元')}.${normalized === 'primitive-svg' ? 'svg' : 'css'}`
        mimeType = normalized === 'primitive-svg' ? 'image/svg+xml' : 'text/css'
      }
      return toJson({ filename, mimeType, encoding: 'base64', data: Buffer.from(source, 'utf8').toString('base64'), warnings: [] })
    }
    if (normalized === 'animation-lua') {
      const bundle = animationBundle({}, activeAssetType)
      const script = requestedAssetType ? bundle.scripts.find(row => row.controlId === requestedAssetType) : bundle.scripts[0]
      if (!script) throw new Error('此根控件没有可播放的动画轨道；请检查轨道属性、关键帧及控件层级')
      return toJson({ filename: script.path, mimeType: 'text/x-lua', encoding: 'base64',
        data: Buffer.from(script.source, 'utf8').toString('base64'), warnings: bundle.warnings })
    }
    if (normalized === 'timeline-data') {
      const state = look2For(currentProject())
      const source = exportTimelineData(currentProject(), state, requestedAssetType)
      const animation = state.animations.find((row) => row.id === state.activeAnimationId)
      return toJson({
        filename: `${(animation?.name || '动画').replace(/[\\/:*?"<>|]/g, '-')}-TweenTimelineData.lua`,
        mimeType: 'text/x-lua', encoding: 'base64',
        data: Buffer.from(source, 'utf8').toString('base64'), warnings: [],
      })
    }
    if (normalized === 'site-json') {
      const project = currentProject()
      if (project.root.kind === 'server-container' && !project.root.children.length) {
        throw new Error('当前界面为空，请先添加容器后再导出站点 JSON；空界面可使用完整存档保存')
      }
      const document = exportSiteJson(currentProject(), look2For(currentProject()))
      return toJson({
        filename: `${currentSaveName().replace(/[\\/:*?"<>|]/g, '-')}.site.json`,
        mimeType: 'application/json', encoding: 'base64',
        data: Buffer.from(JSON.stringify(document, null, 2), 'utf8').toString('base64'),
        warnings: ['参考网站 JSON 只包含客户端 UI 与动画；Look 的服务端逻辑和 Lua 脚本保存在完整存档中。'],
      })
    }
    if (normalized === 'save' || normalized === 'archive') {
      const data = Buffer.from(JSON.stringify(archiveData(), null, 2), 'utf8')
      return toJson({
        filename: `${currentSaveName().replace(/[\\/:*?"<>|]/g, '-')} · 资产包.json`,
        mimeType: 'application/json',
        encoding: 'base64',
        data: data.toString('base64'),
        warnings: [],
      })
    }
    if (normalized === 'save-gia' || normalized === 'archive-gia') {
      // 官方编辑器中三类资产本就是独立 GIA 文件（UIControlGroup / UIControlTemplate 列表 / script.gia），
      // 没有单文件混合格式的证据，因此资产包 GIA 以多文件交付，不捏造合并格式。
      // 另一类 UI 若仍是出厂默认且当前没在看、也没有脚本挂上去，就不要夹带进压缩包，
      // 否则用户会以为「页面上的 Flappy Fish」导出成了「Lua实例化面板」。
      const files = []
      const warnings = []
      const generatedScripts = allAnimationBundles().scripts
      const collect = (format, assetType = '') => {
        const result = exportData(format, assetType)
        files.push(toJson({
          filename: result.filename,
          mimeType: result.mimeType,
          encoding: result.encoding,
          data: result.data,
          warnings: result.warnings || [],
        }))
        warnings.push(...(result.warnings || []))
      }
      const includeUi = (assetType, skipMessage) => {
        const project = projects[assetKey(assetType)]
        const visible = assetType === activeAssetType
        const mounted = [...scripts, ...generatedScripts].some((script) => script.controlAsset === assetType && script.controlId)
        if (!visible && isFactoryDefaultProject(project) && !mounted) {
          warnings.push(skipMessage)
          return
        }
        collect('gia', assetType)
      }
      includeUi(SERVER_ASSET, '服务器控件模板仍是默认橱窗，未改动且当前未显示，已从资产包 GIA 中省略。')
      includeUi(CLIENT_ASSET, '客户端控件模板仍是默认「Lua实例化面板」，未改动且当前未显示，已从资产包 GIA 中省略。')
      if (scripts.some((script) => script.path || script.source) || generatedScripts.length) collect('scripts-gia')
      if (!files.length) {
        throw new Error('资产包 GIA 没有可导出的已改动项；请先编辑当前界面，或改用「当前界面 GIA」。')
      }
      return toJson({
        format: 'qxqy-gia-package',
        files,
        warnings: [...new Set(warnings)],
      })
    }
    if (normalized === 'gia-combined' || normalized === 'combined-gia' || normalized === 'combined') {
      const result = buildCombinedControlProject()
      return toJson({
        filename: `${safeFilePart(currentSaveName(), DEFAULT_SAVE_NAME)} · 整合包.gia`,
        mimeType: 'application/octet-stream',
        encoding: 'base64',
        data: result.buffer.toString('base64'),
        warnings: [...new Set(result.warnings || [])],
      })
    }
    if (normalized === 'scripts') {
      const animation = allAnimationBundles()
      const bundle = toJson({
        format: SCRIPT_BUNDLE_FORMAT,
        version: 1,
        scripts: [...animation.scripts, ...scripts].map((script) => toJson({
          id: script.id,
          guid: script.guid || 0,
          path: script.path || '',
          source: script.source || '',
          controlId: script.controlId || '',
          controlAsset: script.controlAsset || '',
        })),
      })
      const data = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8')
      return toJson({
        filename: `${safeFilePart(currentSaveName(), DEFAULT_SAVE_NAME)} · 脚本.json`,
        mimeType: 'application/json',
        encoding: 'base64',
        data: data.toString('base64'),
        warnings: animation.warnings,
      })
    }
    if (normalized === 'scripts-gia' || normalized === 'scriptsgia') {
      const animation = allAnimationBundles()
      const result = exportScriptGia([...animation.scripts, ...scripts])
      return toJson({
        filename: `${safeFilePart(currentSaveName(), DEFAULT_SAVE_NAME)} · 脚本.gia`,
        mimeType: 'application/octet-stream',
        encoding: 'base64',
        data: result.buffer.toString('base64'),
        warnings: [...result.warnings, ...animation.warnings],
      })
    }
    if (normalized === 'lua') {
      const script = scripts.find((row) => row.id === requestedAssetType)
        || scripts.find((row) => row.path === requestedAssetType)
      if (!script) throw new Error('没有可导出的 Lua 脚本，请先在“Lua 脚本”页创建')
      const filename = basename(script.path || '') || `qxqy-script-${script.id}`
      return toJson({
        filename: /\.lua$/i.test(filename) ? filename : `${filename}.lua`,
        mimeType: 'text/x-lua',
        encoding: 'base64',
        data: Buffer.from(script.source || '', 'utf8').toString('base64'),
        warnings: [],
      })
    }
    const project = requestedAssetType
      ? projects[assetKey(requestedAssetType)]
      : currentProject()
    const baseName = assetExportStem(project)
    if (normalized === 'json') {
      const payload = toJson({ ...project, scripts: scriptsInProject(project.meta.assetType), controlGuidChanges: controlGuidChanges.filter(change => change.controlAsset === project.meta.assetType) })
      const data = Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
      return toJson({
        filename: `${baseName}.json`,
        mimeType: 'application/json',
        encoding: 'base64',
        data: data.toString('base64'),
        warnings: [],
      })
    }
    if (normalized === 'gia') {
      const animation = animationBundle({}, project.meta.assetType)
      const result = exportGia(animation.project || project, project.meta.assetType === CLIENT_ASSET
        ? { scripts: [...animation.scripts, ...scriptsInProject(CLIENT_ASSET)] }
        : {})
      result.warnings.push(...animation.warnings)
      const excludedScripts = project.meta.assetType === CLIENT_ASSET ? [] : [...animation.scripts, ...scriptsInProject(SERVER_ASSET)]
      if (excludedScripts.length) result.warnings.unshift(`当前服务器控件 GIA 不包含 ${excludedScripts.length} 个 Lua 脚本的源码；请使用「资产包 GIA 整合包」，或另行导入脚本包并核对挂载。`)
      return toJson({
        filename: `${baseName}.gia`,
        mimeType: 'application/octet-stream',
        encoding: 'base64',
        data: result.buffer.toString('base64'),
        warnings: result.warnings,
      })
    }
    throw new Error(`unsupported export format: ${format}`)
  }

  function absorbScripts(rawList) {
    for (const raw of rawList) {
      const entry = normalizeScriptEntry(raw)
      if (!entry.path && !entry.source) continue
      const genericMount = entry.controlId ? null : scriptMountFromGenericSlot(entry.guid)
      const script = adoptScript(genericMount ? { ...entry, ...genericMount } : entry)
      const mount = genericMount || (entry.controlId && entry.controlAsset ? entry : null)
      if (mount && script.guid !== entry.guid) {
        // A separately imported UI asset can share a GUID with the inactive
        // default tree. Keep the newly allocated script GUID and repair the
        // GenericSlot reference so the restored mount remains exportable.
        rewriteGenericScriptGuid(mount, entry.guid, script.guid)
      }
      if (script.controlId && !resolveScriptTarget(script)) {
        script.controlId = ''
        script.controlAsset = ''
      }
      scripts.push(script)
    }
  }

  function importDataCore(format, base64, filename = '', options = {}) {
    const normalized = String(format || '').toLowerCase()
    if (typeof base64 !== 'string' || !base64) throw new Error('import data is required')
    const bytes = Buffer.from(base64, 'base64')
    let next
    let warnings = []
    let metadata = {}
    let importedScripts = []
    if (normalized === 'json') {
      try {
        next = JSON.parse(bytes.toString('utf8'))
      } catch {
        throw new Error('JSON 文件无效')
      }
      if (next?.project) next = next.project
      if (Number(next?.version) === 12 && Array.isArray(next?.nodes)) {
        const imported = importSiteJson(next)
        projects.client = createProject(imported.project)
        controlGuidChanges = controlGuidChanges.filter(change => change.controlAsset !== CLIENT_ASSET)
        activeAssetType = CLIENT_ASSET
        explicitSaveName = String(next.name || basename(filename).replace(/\.json$/i, '') || explicitSaveName)
        look2 = imported.look2
        syncClientEditorLocks(true)
        return toJson({ snapshot: get(), warnings: [], metadata: { format: 'site-json' } })
      }
      if (next?.format === SAVE_FORMAT && next?.assets) {
        assertSaveVersion(next.version)
        // Validate both assets before committing either: unsupported layouts
        // must not leave a half-imported archive in the active session.
        const nextServer = createProject(next.assets.server || createDefaultProject(), { warnings })
        const nextClient = createProject(next.assets.client || createDefaultClientTemplateProject(), { warnings })
        const nextServerLogic = normalizeServerLogic(next.serverLogic)
        const nextChanges = readControlGuidChanges(next.controlGuidChanges)
        const nextScriptSync = normalizeScriptSync(next.scriptSync)
        projects.server = nextServer
        projects.client = nextClient
        migrationWarnings = [...warnings]
        activeAssetType = next.activeAssetType === CLIENT_ASSET ? CLIENT_ASSET : SERVER_ASSET
        explicitSaveName = String(next.meta?.name || basename(filename).replace(/\.json$/i, '') || explicitSaveName)
        serverLogic = nextServerLogic
        controlGuidChanges = nextChanges
        scriptSync = nextScriptSync
        saveMetadata = toJson(next.meta || {})
        look2 = normalizeLook2(next.look2, projects.client)
        serverLook2 = normalizeLook2(next.look2ByAsset?.server, projects.server)
        syncClientEditorLocks(!Object.hasOwn(next.assets.client?.meta || {}, 'editorLocks'))
        adoptSiteCanvas(projects.client, look2)
        scripts = []
        usedScriptGuids.clear()
        absorbScripts(seedScriptList(next))
        reconcileScriptMounts()
        return toJson({ snapshot: get(), warnings, metadata: { format: SAVE_FORMAT } })
      }
    } else if (normalized === 'lua') {
      const project = currentProject()
      const timeline = importTimelineData(bytes.toString('utf8'), project, look2For(project), options)
      if (timeline) {
        storeLook2(timeline, project)
        project.version += 1
        return toJson({ snapshot: get(), warnings, metadata: { format: 'timeline-data' } })
      }
      scripts.push(adoptScript({
        path: basename(filename || 'imported.lua'),
        source: bytes.toString('utf8'),
        controlId: '',
      }))
      return toJson({ snapshot: get(), warnings, metadata: { assetType: 'lua-script' } })
    } else if (normalized === 'gia') {
      if (isScriptGia(bytes)) {
        const imported = importScriptGia(bytes)
        absorbScripts(imported.scripts)
        return toJson({ snapshot: get(), warnings: imported.warnings, metadata: imported.metadata })
      }
      const imported = importGia(bytes)
      next = imported.project
      warnings = imported.warnings
      metadata = imported.metadata
      if (imported.clientProject) {
        projects.client = createProject(imported.clientProject)
        controlGuidChanges = controlGuidChanges.filter(change => change.controlAsset !== CLIENT_ASSET)
        warnings.push('整合包已拆回「UI控件-服务端」与「UI控件-客户端」；客户端模板边界已保留。')
      }
      const mountByGuid = new Map()
      const collectMounts = (project, controlAsset) => {
        if (!project) return
        walk(project.root, (node) => {
          for (const guid of node.scriptMappingIds || []) {
            const existing = mountByGuid.get(Number(guid))
            if (existing) {
              warnings.push(`脚本 GUID ${guid} 同时挂载到多个控件，已保留“${existing.controlAsset === SERVER_ASSET ? '服务端' : '客户端'}”目标。`)
              continue
            }
            mountByGuid.set(Number(guid), { controlId: node.id, controlAsset })
          }
        })
      }
      collectMounts(imported.project, imported.project.meta.assetType)
      collectMounts(imported.clientProject, CLIENT_ASSET)
      importedScripts = (imported.scripts || []).map((script) => (
        mountByGuid.has(Number(script.guid))
          ? { ...script, ...mountByGuid.get(Number(script.guid)) }
          : script
      ))
    } else {
      throw new Error(`unsupported import format: ${format}`)
    }
    const importedProject = createProject(next, { warnings })
    const importedChanges = readControlGuidChanges(next?.controlGuidChanges)
    if (importedChanges.some((change) => change.controlAsset !== importedProject.meta.assetType)) {
      throw new Error('单资产 JSON 的索引变更记录必须属于当前导入资产')
    }
    const nextChanges = readControlGuidChanges([
      ...controlGuidChanges.filter((change) => change.controlAsset !== importedProject.meta.assetType),
      ...importedChanges,
    ])
    migrationWarnings = [...warnings]
    const key = assetKey(importedProject.meta.assetType)
    projects[key] = importedProject
    controlGuidChanges = nextChanges
    if (key === 'client' || metadata.combined) look2 = freshLook2()
    if (key === 'server') serverLook2 = freshLook2()
    activeAssetType = importedProject.meta.assetType
    const project = projects[key]
    if (filename) {
      project.meta.name = basename(filename).replace(/\.(json|gia)$/i, '') || project.meta.name
      project.meta.sourceFile = basename(filename)
      project.meta.sourceFormat = normalized
    }
    absorbScripts(importedScripts)
    absorbScripts(next?.scripts || [])
    if (next?.script && (next.script.path || next.script.source)) {
      absorbScripts([next.script])
    }
    return toJson({ snapshot: get(), warnings, metadata })
  }

  function importData(format, base64, filename = '', options = {}) {
    let result
    const revision = Math.max(projects.server.version, projects.client.version) + 1
    editHistory.run(`导入 ${filename || format}`, () => {
      result = importDataCore(format, base64, filename, options)
      projects.server.version = projects.client.version = revision
    })
    return { ...result, snapshot: get() }
  }

  function pick(x, y) {
    return patch({ op: 'pick', x, y })
  }

  // 会话工作区可能在首个 HTTP/工具调用时才可知。只改显示与脚本解析根，不改存档名。
  function setWorkspace(path) {
    const next = typeof path === 'string' && path ? path : ''
    if (!next || next === workspacePath) return
    workspacePath = next
  }

  function resolveScriptSource(script) {
    let source = script.source || ''
    if (!source.trim() && script.path.trim()) {
      try {
        source = readFileSync(resolveWorkspaceFile(script.path, workspacePath), 'utf8')
      } catch (err) {
        throw new Error(`脚本 ${script.path} 读取失败: ${err?.message || err}`)
      }
    }
    return source
  }

  function playStart(options = {}) {
    if (options.expectedRevision !== undefined) {
      if (!Number.isInteger(options.expectedRevision)) throw new Error('expectedRevision must be an integer')
      checkRevision({ expectedRevision: options.expectedRevision })
    }
    const requested = normalizePlayCanvasId(options.canvasId)
    const nextCanvasId = requested || playCanvasId
    let nextPlayerCount = playPlayerCount
    if (options.playerCount !== undefined && options.playerCount !== null && options.playerCount !== '') {
      nextPlayerCount = normalizePlayerCount(options.playerCount)
    }
    let nextViewPlayerIndex = playViewPlayerIndex > nextPlayerCount ? 1 : playViewPlayerIndex
    if (options.viewPlayerIndex !== undefined && options.viewPlayerIndex !== null && options.viewPlayerIndex !== '') {
      nextViewPlayerIndex = normalizePlayerIndex(options.viewPlayerIndex, nextPlayerCount)
    }
    const requestedAsset = options.asset
    if (requestedAsset !== undefined && requestedAsset !== 'server' && requestedAsset !== 'client') {
      throw new Error(`unknown play asset: ${String(requestedAsset)}`)
    }
    if (options.templateRootId !== undefined && options.templateRootId !== null && typeof options.templateRootId !== 'string') {
      throw new Error('templateRootId must be a string')
    }
    const templateRootId = options.templateRootId == null ? '' : options.templateRootId.trim()
    if (options.templateRootId !== undefined && options.templateRootId !== null && !templateRootId) {
      throw new Error('templateRootId must be a non-empty string')
    }
    if (options.animationId !== undefined && options.animationId !== null && typeof options.animationId !== 'string') {
      throw new Error('animationId must be a string')
    }
    const requestedAnimationId = options.animationId == null ? '' : options.animationId.trim()
    if (options.animationId !== undefined && options.animationId !== null && !requestedAnimationId) {
      throw new Error('animationId must be a non-empty string')
    }
    if (requestedAsset === 'server' && templateRootId) {
      throw new Error('templateRootId requires a client asset')
    }
    const animationAsset = options.animationAsset || (requestedAsset === 'client' || templateRootId ? CLIENT_ASSET : activeAssetType)
    if (![SERVER_ASSET, CLIENT_ASSET].includes(animationAsset)) throw new Error('Invalid animationAsset')
    const animationState = look2For(projects[assetKey(animationAsset)])
    const selectedAnimation = requestedAnimationId
      ? animationState.animations.find(row => String(row.id) === requestedAnimationId)
      : animationState.animations.find(row => row.id === animationState.activeAnimationId) || animationState.animations[0]
    if (requestedAnimationId && !selectedAnimation) throw new Error(`animation not found: ${requestedAnimationId}`)
    const selectedOptions = requestedAnimationId ? { animationId: requestedAnimationId } : {}
    const animation = allAnimationBundles(animationAsset === SERVER_ASSET ? selectedOptions : {}, animationAsset === CLIENT_ASSET ? selectedOptions : {})
    const extraTemplates = []
    const extraTemplateScripts = []
    for (const entry of look2.controlTemplates) {
      if (!entry.project?.root || !Number.isSafeInteger(entry.index) || entry.index < 0) continue
      const compiled = compileProject(createProject(projectForSiteTemplate(entry, nextCanvasId || currentProject().canvasId)), entry.scripts || [], nextCanvasId)
      const root = compiled.templates[0]
      if (root) { root.prefabIndex = entry.index; extraTemplates.push(root) }
      extraTemplateScripts.push(...(entry.scripts || []))
    }
    const resolvedScripts = [...animation.scripts, ...scripts].map((script) => {
      try {
        return {
          id: script.id,
          guid: script.guid || 0,
          path: script.path || script.id,
          source: resolveScriptSource(script),
          controlId: script.controlId || '',
          controlAsset: script.controlAsset || '',
        }
      } catch (err) {
        return { id: script.id, guid: script.guid || 0, path: script.path || script.id, source: `error([==[ ${String(err.message).replace(/]=+]/g, '] =]')} ])`, controlId: script.controlId || '', controlAsset: script.controlAsset || '' }
      }
    })
    const byAsset = (assetKey) => resolvedScripts.filter((script) => {
      const probe = { controlId: script.controlId, controlAsset: script.controlAsset }
      const target = script.controlId ? resolveScriptTarget(probe) : null
      return Boolean(target && target.key === assetKey)
    })
    const hasAnimation = Boolean(selectedAnimation?.keyframeTracks?.length || selectedAnimation?.events?.length)
      || look2.primitiveResources.some(resource => resource.fitData && Object.values(look2.siteNodes).some(node => (node.properties?.imageResourceId || node.properties?.primitiveResourceId) === resource.id))
      || resolvedScripts.some(row => row.controlAsset === CLIENT_ASSET && row.source.startsWith('-- look2.0 generated animation player'))
    const sceneAsset = requestedAsset || (templateRootId || (requestedAnimationId && animationAsset === CLIENT_ASSET)
      ? 'client'
      : activeAssetType === CLIENT_ASSET && hasAnimation ? 'client' : 'server')
    const nextPlay = startPlay(sceneAsset === 'client' ? animation.client.project : animation.server.project, {
      templatesProject: animation.client.project,
      extraTemplates,
      scripts: [...resolvedScripts, ...extraTemplateScripts],
      sceneScripts: byAsset(sceneAsset),
      templateScripts: byAsset('client'),
      serverConfig: { logic: serverLogic },
      canvasId: nextCanvasId,
      playerCount: nextPlayerCount,
      viewPlayerIndex: nextViewPlayerIndex,
      templateRootId: sceneAsset === 'client' ? templateRootId : '',
    })
    if (play) stopPlay(play)
    play = nextPlay
    playCanvasId = nextCanvasId
    playPlayerCount = nextPlayerCount
    playViewPlayerIndex = nextViewPlayerIndex
    play.playTarget = {
      asset: sceneAsset,
      templateRootId: sceneAsset === 'client' ? templateRootId || play.compiled.root.authoringId : '',
      animationId: requestedAnimationId || selectedAnimation?.id || '',
    }
    play.animationWarnings = animation.warnings
    return playGet(options)
  }

  // 多设备试玩：切换设备 = 以该设备画布重建运行时（新生命周期，与真机换设备一致）。
  function playSetCanvas(rawCanvasId, options = {}) {
    const canvasId = normalizePlayCanvasId(rawCanvasId)
    if (!canvasId) throw new Error('playSetCanvas requires canvasId')
    return playStart({ ...options, canvasId })
  }

  function playGet(options = {}) {
    if (!play) return toJson({ running: false, tree: [], logs: [], serverLogs: [], serverVars: [] })
    const snap = playSnapshot(play, options)
    snap.animationWarnings = [...(play.animationWarnings || [])]
    snap.playTarget = { ...(play.playTarget || {}) }
    snap.running = true
    snap.logs = filterLogs(snap.logs)
    snap.serverLogs = filterLogs(snap.server?.logs || [])
    snap.serverVars = listServerVars(snap.server, snap.playerCount || 1)
    return snap
  }

  function playStep(dt, options = {}) {
    if (!play) playStart()
    stepPlay(play, dt)
    if (options.observe === false) {
      return toJson({
        running: true,
        time: play.runtime.clock.time,
        frame: play.runtime.clock.frame,
        paused: !!play.debugPaused,
        levelTimePaused: !!play.runtime.clock.paused,
        playerCount: play.playerCount || 1,
        viewPlayerIndex: play.viewPlayerIndex || 1,
      })
    }
    return playGet(options)
  }

  function playRun(frames = 0) {
    playStart()
    const n = Math.max(0, Number(frames) || 0)
    for (let i = 0; i < n; i++) stepPlay(play, 1 / 30)
    return playGet()
  }

  function playStop() {
    if (play) stopPlay(play)
    play = null
    playCanvasId = ''
    playPlayerCount = 1
    playViewPlayerIndex = 1
    return toJson({ running: false, tree: [], logs: [], serverLogs: [], serverVars: [] })
  }

  function playSetView(playerIndex, options = {}) {
    const session = requirePlay()
    playViewPlayerIndex = setPlayView(session, playerIndex)
    return options.observe === false ? null : playGet(options)
  }

  function playKey(typeName, options = {}) {
    if (!play) throw new Error('play session has not started')
    injectPlayKey(play, typeName)
    return options.observe === false ? null : playGet(options)
  }

  function playClick(name, options = {}) {
    if (!play) throw new Error('play session has not started')
    injectPlayClick(play, name)
    return options.observe === false ? null : playGet(options)
  }

  function playPointer(type, x, y, options = {}) {
    if (!play) throw new Error('play session has not started')
    injectPlayPointer(play, type, x, y)
    return options.observe === false ? null : playGet(options)
  }

  function playPause(options = {}) {
    if (!play) return options.observe === false ? null : playGet(options)
    playAdapter(play).pause()
    return options.observe === false ? null : playGet(options)
  }

  function playResume(options = {}) {
    if (!play) return options.observe === false ? null : playGet(options)
    playAdapter(play).resume()
    return options.observe === false ? null : playGet(options)
  }

  function requirePlay() {
    if (!play) throw new Error('play session has not started')
    return play
  }

  function playServerGet(entityType, name) {
    const session = requirePlay()
    if (!entityType && !name) {
      const snap = playGet()
      return toJson({ vars: snap.serverVars || [] })
    }
    return toJson({
      entityType: String(entityType || ''),
      name: String(name || ''),
      value: getPlayVar(session, entityType, name),
    })
  }

  function playServerSet(entityType, name, value) {
    const session = requirePlay()
    setPlayVar(session, entityType, name, value)
    return playGet()
  }

  function playServerSend(name, params = [], target = 'PlayerSelf') {
    const session = requirePlay()
    sendPlaySignal(session, name, params, target)
    return playGet()
  }

  function playHistory() {
    const snap = playGet()
    return toJson({
      events: snap.history || [],
      case: caseFromHistory(snap.history || [], { playerCount: snap.playerCount || 1 }),
    })
  }

  function playSaveCase(raw = {}) {
    const snap = playGet()
    const spec = normalizeCase({
      name: raw.name || '',
      dt: raw.dt,
      playerCount: raw.playerCount || snap.playerCount || 1,
      events: raw.events || snap.history || [],
      asserts: raw.asserts || [],
    })
    return toJson(spec)
  }

  function playRunCase(rawCase, options = {}) {
    const spec = normalizeCase(rawCase)
    playStart({ ...options, playerCount: options.playerCount || spec.playerCount || 1 })
    const session = requirePlay()
    session.recording = false
    try {
      return replayCase(playAdapter(session), rawCase)
    } finally {
      session.recording = true
    }
  }

  // 轻量状态：worker 时钟每 tick 轮询用，禁止构建全量快照。
  function playStatus() {
    if (!play) return { running: false, paused: false, time: 0, frame: 0, playerCount: 1, viewPlayerIndex: 1 }
    const clock = play.runtime.clock
    return {
      running: true,
      paused: !!play.debugPaused,
      levelTimePaused: !!clock.paused,
      time: clock.time,
      frame: clock.frame,
      playerCount: play.playerCount || 1,
      viewPlayerIndex: play.viewPlayerIndex || 1,
    }
  }

  function setLook2(next, expectedRevision) {
    if (!Number.isInteger(expectedRevision)) throw new Error('expectedRevision is required')
    checkRevision({ expectedRevision })
    const revision = Math.max(projects.server.version, projects.client.version) + 1
    editHistory.run('修改动画或素材', () => {
      storeLook2(next)
      projects.server.version = projects.client.version = revision
    })
    return get()
  }

  const api = {
    get,
    patch,
    setWorkspace,
    exportData,
    importData,
    setLook2,
    pick,
    playStart,
    playSetCanvas,
    playSetView,
    playGet,
    playStatus,
    playStep,
    playRun,
    playStop,
    playKey,
    playClick,
    playPointer,
    playPause,
    playResume,
    playServerGet,
    playServerSet,
    playServerSend,
    playHistory,
    playSaveCase,
    playRunCase,
    archiveData,
    transaction,
    history,
    template,
  }
  Object.defineProperty(api, '_project', { enumerable: false, get: currentProject })
  return api
}
