import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createStudio } from '../index.js'
import { renderEditorPng, renderScenePng } from '../host-png.js'
import { CANVAS_PRESETS } from '../constants.js'
import { deleteWorkspaceArchive, listWorkspaceArchives, resolveWorkspaceFile, resolveWorkspaceOutput, resolveWorkspaceRoot, revealWorkspaceArchive } from './workspace.js'
import { readClientLanguageType } from './client-language.js'
import { ScriptSync, contentHash, discoverScriptDirectories } from './script-sync.js'
import { sharedImageAssets } from './image-assets.js'
import { ControlGuidSync } from './control-guid-sync.js'
import { localFont } from './local-font.js'
import { maskContourEnabled, readRenderSettings } from './render-settings.js'
import { DEFAULT_PLAY_FPS, validatePlayFps } from '../play/frame-rate.js'
import { archivePathKey, createArchiveWorkspace, listArchiveWorkspaces, remapArchivePath, renameArchiveWorkspace, renameWorkspaceArchive } from './archive-management.js'

// Keep the interactive default short, but allow project replay runners to raise
// it for control-heavy pixel-art scenes and long deterministic golden cases.
const PLAY_TIMEOUT_MS = Math.max(1_000, Number(process.env.QXQY_PLAY_TIMEOUT_MS) || 8_000)
const SCREENSHOT_TIMEOUT_MS = 8_000

function abortError() {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

function validateClockMode(value) {
  if (value !== 'manual' && value !== 'realtime') throw new Error('clockMode must be manual or realtime')
  return value
}

// A broken local setting must not stop the host; fall back to the device rule.
function safeRenderSettings() {
  try { return readRenderSettings() } catch { return { maskContour: 'geometry' } }
}

export class SimulatorController {
  constructor(workspacePath = '', { imageAssets = sharedImageAssets(), clockMode = 'realtime' } = {}) {
    localFont()
    this.renderSettings = safeRenderSettings()
    // The DSH adapter can begin before its host exposes a workspace.  Keep the
    // controller usable in that state instead of silently binding it to the
    // process cwd; Web and MCP always pass an explicit workspace.
    this.workspacePath = workspacePath ? resolveWorkspaceRoot(workspacePath) : ''
    this.studio = createStudio(undefined, this.workspacePath ? { workspacePath: this.workspacePath } : undefined)
    this.worker = null
    this.pending = new Map()
    this.sequence = 1
    this.lock = Promise.resolve()
    this.playLock = Promise.resolve()
    this.archivePath = ''
    this.archiveStamp = ''
    this.savedArchive = ''
    this.archiveRelocations = new Set()
    this.scriptSync = new ScriptSync(this)
    this.controlGuidSync = new ControlGuidSync(this)
    this.imageAssets = imageAssets
    this.defaultClockMode = validateClockMode(clockMode)
    this.playClockMode = this.defaultClockMode
    this.playFps = DEFAULT_PLAY_FPS
  }

  /** Serialize calls for one project handle, including worker operations. */
  async exclusive(task) {
    const previous = this.lock
    let release
    this.lock = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }

  /** Serialize worker lifecycle calls even when a host bypasses exclusive(). */
  async exclusivePlay(task) {
    const previous = this.playLock
    let release
    this.playLock = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }

  get() {
    return { ...this.studio.get(), storage: { path: this.archivePath } }
  }

  exportData(format, assetType, options = {}) {
    return this.studio.exportData(format, assetType, options)
  }

  exportAction(action, args = {}) {
    if (action === 'list') return this.studio.exportChoices()
    if (action === 'preview') return this.studio.exportPreview(args)
    if (action !== 'export') throw new Error(`unknown export action: ${action}`)
    const result = this.exportData(args.format || 'gia-partial', args.assetType || '', args)
    if (!args.path) return result
    if (!this.activeWorkspacePath()) throw new Error('workspace is not bound')
    if (result.files) throw new Error('path requires a single-file export format')
    const absolute = resolveWorkspaceOutput(this.activeWorkspacePath(), args.path)
    mkdirSync(dirname(absolute), { recursive: true })
    // Explicit file output only. Never overwrite a save, source or previous
    // export by accident; agents can choose a new output name.
    const data = Buffer.from(result.data, 'base64')
    writeFileSync(absolute, data, { flag: 'wx' })
    const { data: _data, ...metadata } = result
    return { ...metadata, path: String(args.path).replaceAll('\\', '/'), bytes: data.length }
  }

  importData(format, data, filename, options = {}) {
    // Studio imports roll back through the edit history, so a failed validation
    // must not detach the save the session is still bound to.
    const result = this.studio.importData(format, data, filename, options)
    this.archivePath = ''; this.archiveStamp = ''; this.savedArchive = ''
    this.archiveRelocations.clear()
    this.scriptSync.plan = null
    this.scriptSync.lastResult = null
    this.controlGuidSync.plan = null
    return { ...result, snapshot: this.get() }
  }

  scriptSyncAction(action, args = {}) {
    if (action === 'discover') return discoverScriptDirectories()
    if (action === 'status') return { config: this.get().scriptSync, lastResult: this.scriptSync.lastResult }
    if (action === 'configure') {
      if (!Number.isInteger(args.expectedRevision)) throw new Error('expectedRevision is required')
      return this.patch({ op: 'setScriptSync', config: args.config, expectedRevision: args.expectedRevision })
    }
    if (action === 'preview') return this.scriptSync.preview()
    if (action === 'save') return this.saveArchiveChecked(args.path, args.expectedRevision)
    throw new Error('unknown script sync action (AI 可配置和预览；复制需在编辑器中确认)')
  }

  assertSavedArchive() {
    if (!this.archivePath || this.savedArchive !== JSON.stringify(this.studio.archiveData())) throw new Error('请先保存当前完整存档，再确认复制')
    const path = resolveWorkspaceFile(this.activeWorkspacePath(), this.archivePath)
    if (contentHash(readFileSync(path)) !== this.archiveStamp) throw new Error('存档文件已变化，请重新加载并检查')
  }

  saveArchiveChecked(path = this.archivePath, expectedRevision) {
    // Editor saves and script-sync saves share one entry point so both hosts
    // enforce the same revision, rename-alias and on-disk fingerprint checks.
    if (!Number.isInteger(expectedRevision)) throw new Error('expectedRevision is required')
    if (typeof path !== 'string' || !path.trim()) throw new Error('save requires a workspace-relative path for a new archive')
    if (expectedRevision !== this.get().version) throw new Error('revision conflict: reload before saving')
    if (this.archiveRelocations.has(archivePathKey(path))) throw new Error('存档已改名，请刷新存档路径后保存')
    const absolute = resolveWorkspaceOutput(this.activeWorkspacePath(), path)
    const original = this.archivePath ? resolveWorkspaceOutput(this.activeWorkspacePath(), this.archivePath) : ''
    if (this.archiveStamp && archivePathKey(absolute) === archivePathKey(original) && !existsSync(absolute)) {
      throw new Error('存档文件已移动或删除，请重新加载或另存为新路径')
    }
    if (existsSync(absolute)) {
      if (archivePathKey(absolute) !== archivePathKey(original)) throw new Error('保存失败：目标文件已存在，但当前会话未关联此文件。请改用一个未使用的存档文件名保存；如需使用已有文件，请先导出「资产包 JSON（三类合一）」备份当前修改，再从顶部「⤓ 工作区存档」选择该文件。')
      if (contentHash(readFileSync(absolute)) !== this.archiveStamp) throw new Error('保存失败：磁盘上的存档已被外部修改，当前版本无法直接覆盖。请改用一个未使用的存档文件名保存；如需使用磁盘上的最新版本，请先导出「资产包 JSON（三类合一）」备份当前修改，再从顶部「⤓ 工作区存档」重新选择该文件。')
    }
    return this.saveArchive(path)
  }

  patch(op) {
    if (op?.op === 'previewControlGuidSync') return { ...this.get(), controlGuidSyncPreview: this.controlGuidSync.preview() }
    if (op?.op === 'syncControlGuidReferences') return this.controlGuidSync.apply(op)
    return { ...this.studio.patch(op), storage: { path: this.archivePath } }
  }

  listArchives() {
    const workspace = this.activeWorkspacePath()
    if (!workspace) return { bound: false, archives: [], workspaces: [] }
    return { ...listWorkspaceArchives(workspace), workspaces: listArchiveWorkspaces(workspace) }
  }

  manageArchive({ operation, path, name, expectedRevision } = {}) {
    if (expectedRevision !== this.get().version) throw new Error('revision conflict: reload before managing archives')
    const workspace = this.activeWorkspacePath()
    if (!workspace) throw new Error('workspace is not bound')
    const functions = { 'create-workspace': createArchiveWorkspace, 'rename-workspace': renameArchiveWorkspace, 'rename-archive': renameWorkspaceArchive }
    const mutate = functions[operation]
    if (!Object.hasOwn(functions, operation)) throw new Error('unknown archive operation')
    const preview = { operation, previousPath: String(path || '').replaceAll('\\', '/'), path: '__renamed__' }
    const changesActive = remapArchivePath(this.archivePath, preview) !== this.archivePath
    if (changesActive && this.archivePath && contentHash(readFileSync(resolveWorkspaceFile(workspace, this.archivePath))) !== this.archiveStamp) throw new Error('存档文件已变化，请重新加载后改名')
    const result = operation === 'create-workspace' ? mutate(workspace, name) : mutate(workspace, path, name)
    this.remapStorage(result)
    return { ...result, ...this.listArchives(), snapshot: this.get() }
  }

  remapStorage(result) {
    const previous = this.archivePath
    this.archivePath = remapArchivePath(previous, result)
    if (previous !== this.archivePath) this.archiveRelocations.add(archivePathKey(previous))
    this.archiveRelocations.delete(archivePathKey(this.archivePath))
  }

  loadArchive(path) {
    const workspacePath = this.activeWorkspacePath()
    if (!workspacePath) throw new Error('workspace is not bound')
    const absolute = resolveWorkspaceFile(workspacePath, path)
    const bytes = readFileSync(absolute)
    const result = this.studio.importData('json', bytes.toString('base64'), basename(absolute))
    this.archivePath = String(path).trim().replaceAll('\\', '/')
    this.archiveStamp = contentHash(bytes)
    this.savedArchive = JSON.stringify(this.studio.archiveData())
    this.archiveRelocations.clear()
    return { ...result, snapshot: this.get() }
  }

  deleteArchive(path) {
    const workspacePath = this.activeWorkspacePath()
    if (!workspacePath) throw new Error('workspace is not bound')
    const result = deleteWorkspaceArchive(workspacePath, path)
    if (String(path).replaceAll('\\', '/') === this.archivePath) {
      this.archivePath = ''; this.archiveStamp = ''; this.savedArchive = ''
    }
    return result
  }

  revealArchive(path) {
    const workspacePath = this.activeWorkspacePath()
    if (!workspacePath) throw new Error('workspace is not bound')
    return revealWorkspaceArchive(workspacePath, path)
  }

  saveArchive(path = this.archivePath || 'qxqy-simulator.save.json') {
    const requestedPath = String(path).trim()
    const workspacePath = this.activeWorkspacePath()
    if (!workspacePath) throw new Error('workspace is not bound')
    const absolute = resolveWorkspaceOutput(workspacePath, requestedPath)
    mkdirSync(dirname(absolute), { recursive: true })
    const data = Buffer.from(JSON.stringify(this.studio.archiveData(), null, 2) + '\n', 'utf8')
    writeFileSync(absolute, data)
    this.archivePath = requestedPath.replaceAll('\\', '/')
    this.archiveStamp = contentHash(data)
    this.savedArchive = JSON.stringify(this.studio.archiveData())
    return {
      path: this.archivePath,
      bytes: data.length,
      revision: this.studio.get().version,
      name: this.studio.get().save?.name || '',
    }
  }

  activeWorkspacePath() {
    const workspace = this.studio.get().workspace
    return workspace?.bound && workspace.path ? String(workspace.path) : this.workspacePath
  }

  createWorker() {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', workerData: { localFont: localFont()?.data ?? null } })
    worker.on('message', (message) => {
      const pending = this.pending.get(message?.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error || 'play worker failed'))
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.worker = null
      this.rejectPending(error)
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null
      this.rejectPending(new Error(`play worker exited with code ${code}`))
    })
    this.worker = worker
    return worker
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  async terminateWorker(reason = new Error('play worker terminated')) {
    const worker = this.worker
    this.worker = null
    this.rejectPending(reason)
    if (worker) await worker.terminate().catch(() => {})
  }

  request(action, args, signal, timeoutMs = PLAY_TIMEOUT_MS) {
    const worker = this.worker || this.createWorker()
    const id = this.sequence++
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        callback(value)
      }
      const onAbort = () => {
        this.pending.delete(id)
        finish(reject, abortError())
        void this.terminateWorker(abortError())
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`play worker timed out after ${timeoutMs}ms`)
        finish(reject, error)
        void this.terminateWorker(error)
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage({ id, action, args })
      } catch (error) {
        this.pending.delete(id)
        finish(reject, error)
        void this.terminateWorker(error)
      }
    })
  }

  async play(action, args = {}, signal) {
    return this.exclusivePlay(() => this.playUnlocked(action, args, signal))
  }

  assertExpectedRevision(args = {}) {
    if (args.expectedRevision === undefined) return
    if (!Number.isInteger(args.expectedRevision)) throw new Error('expectedRevision must be an integer')
    const current = this.studio.get().version
    if (args.expectedRevision !== current) {
      throw new Error(`revision conflict: expected ${args.expectedRevision}, current ${current}`)
    }
  }

  startPayload(args) {
    return {
      ...args,
      archive: this.studio.archiveData(),
      workspacePath: this.activeWorkspacePath(),
    }
  }

  async startWorker(payload, signal) {
    try {
      return await this.request('start', payload, signal)
    } catch (error) {
      // A failed startup must not leave a clocked worker or half-built Studio
      // alive behind the next start/stop request.
      await this.terminateWorker(error)
      throw error
    }
  }

  async playUnlocked(action, args = {}, signal) {
    if ((action === 'start' || action === 'device') && !args.language) {
      const language = readClientLanguageType()
      if (language) args = { ...args, language }
    }
    if (action === 'start') {
      // Check before terminating the current worker. A stale start must leave
      // the active play session untouched so the caller can refresh its view.
      this.assertExpectedRevision(args)
      const clockMode = validateClockMode(args.clockMode ?? this.defaultClockMode)
      const fps = validatePlayFps(args.fps ?? DEFAULT_PLAY_FPS)
      const payload = this.startPayload({ ...args, clockMode, fps })
      this.playClockMode = clockMode
      this.playFps = fps
      await this.terminateWorker()
      return this.startWorker(payload, signal)
    }
    if (action === 'device') {
      this.assertExpectedRevision(args)
      const canvasId = String(args.canvasId || '').trim()
      if (!CANVAS_PRESETS[canvasId]) {
        throw new Error(`unknown canvas preset: ${canvasId || '(empty)'} (available: ${Object.keys(CANVAS_PRESETS).join(', ')})`)
      }
      const clockMode = validateClockMode(args.clockMode ?? this.playClockMode)
      const fps = validatePlayFps(args.fps ?? this.playFps)
      const payload = this.startPayload({ ...args, canvasId, clockMode, fps })
      this.playClockMode = clockMode
      this.playFps = fps
      await this.terminateWorker()
      return this.startWorker(payload, signal)
    }
    if (action === 'stop') {
      if (!this.worker) return { running: false, tree: [], logs: [] }
      try {
        return await this.request('stop', args, signal)
      } finally {
        await this.terminateWorker()
      }
    }
    if (!this.worker) throw new Error('play session has not started')
    if (action === 'fps') {
      const fps = validatePlayFps(args.fps)
      const value = await this.request(action, { ...args, fps }, signal)
      this.playFps = fps
      return value
    }
    return this.request(action, args, signal)
  }

  async playScreenshot(signal) {
    const snapshot = await this.exclusivePlay(async () => {
      if (!this.worker) throw new Error('play session has not started')
      return this.request('get', { view: true }, signal, SCREENSHOT_TIMEOUT_MS)
    })
    const assets = await this.imageAssets.prepare(snapshot.scene?.nodes, signal)
    const image = renderScenePng(snapshot.scene, snapshot.canvasWidth, snapshot.canvasHeight, {
      ...assets,
      contour: maskContourEnabled(this.renderSettings),
    })
    return {
      data: image.data,
      canvasId: String(snapshot.canvasId || ''),
      frame: Number.isFinite(Number(snapshot.frame)) ? Number(snapshot.frame) : 0,
      time: Number.isFinite(Number(snapshot.time)) ? Number(snapshot.time) : 0,
      clockMode: snapshot.clockMode,
      fps: snapshot.fps,
      width: image.width,
      height: image.height,
      pixelWidth: image.pixelWidth,
      pixelHeight: image.pixelHeight,
      assetWarnings: [...assets.warnings, ...(snapshot.effects || []).map(effect => ({ animationId: effect.animationId,
        error: 'UI effect video frames are available in browser playback only; omitted from this PNG' }))],
    }
  }

  async uiScreenshot(signal) {
    const snapshot = this.studio.get()
    const assets = await this.imageAssets.prepare(snapshot.boxes, signal)
    const image = renderEditorPng(snapshot, assets)
    return {
      data: image.data,
      page: image.page,
      width: image.width,
      height: image.height,
      pixelWidth: image.pixelWidth,
      pixelHeight: image.pixelHeight,
      assetWarnings: [...assets.warnings, ...snapshot.boxes.filter(box => ['animation', 'fullscreen'].includes(box.kind) && box.visibleInHierarchy !== false && box.animationId)
        .map(box => ({ animationId: box.animationId, error: 'UI effect video frames are available in browser playback only; omitted from this PNG' }))],
    }
  }

  async dispose() {
    await this.exclusivePlay(() => this.terminateWorker())
  }
}
