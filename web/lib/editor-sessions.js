import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SimulatorController } from 'qxqy-studio/host/controller'
import { resolveWorkspaceFile, resolveWorkspaceOutput } from 'qxqy-studio/host/workspace'
import { archivePathKey, remapArchivePath } from '../../studio/host/archive-management.js'

const ACTIONS = new Set(['get', 'patch', 'look2', 'transaction', 'history', 'template', 'image-url', 'import', 'export', 'archives', 'archive-manage', 'load-archive', 'delete-archive', 'reveal-archive', 'save', 'play', 'script-sync', 'script-sync-apply', 'image-refresh'])
const stamp = path => createHash('sha256').update(readFileSync(path)).digest('hex')

// One trusted operator, with independent editor tabs and their play windows.
// These identifiers are not tenant authorization; network access is authenticated.
export class EditorSessions {
  constructor(workspace, { initialPath = '', maxSessions = 8, imageAssets } = {}) {
    this.workspace = workspace
    this.initialPath = initialPath
    this.maxSessions = maxSessions
    this.sessions = new Map()
    this.imageAssets = imageAssets
  }

  getSession(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid editor sessionId')
    if (!this.sessions.has(id)) {
      if (this.sessions.size >= this.maxSessions) throw new Error('Editor session limit reached; save your work and restart the server')
      const controller = new SimulatorController(this.workspace, { imageAssets: this.imageAssets })
      const row = { controller, path: '', fileStamp: '' }
      if (this.initialPath) this.load(row, this.initialPath)
      this.sessions.set(id, row)
    }
    return this.sessions.get(id)
  }

  snapshot(row) {
    return { ...row.controller.get(), storage: { path: row.path } }
  }

  load(row, path) {
    const absolute = resolveWorkspaceFile(this.workspace, path)
    const result = row.controller.loadArchive(path)
    row.path = String(path).replaceAll('\\', '/')
    row.fileStamp = stamp(absolute)
    row.relocatedPaths?.clear()
    return { ...result, snapshot: this.snapshot(row) }
  }

  async call(action, body, signal) {
    if (!ACTIONS.has(action)) throw new Error('Unknown editor action')
    const row = this.getSession(body.sessionId)
    const controller = row.controller
    return controller.exclusive(async () => {
      if (action === 'get') return this.snapshot(row)
      if (action === 'image-refresh') {
        await controller.imageAssets.refresh(body.imageId, { imageSource: body.imageSource })
        return { imageId: body.imageId, imageSource: body.imageSource || 'StaticReference', refreshed: true }
      }
      if (action === 'script-sync') return controller.scriptSyncAction(body.action, body.args || {})
      if (action === 'script-sync-apply') return controller.scriptSync.apply(body)
      if (action === 'archives') return controller.listArchives()
      if (action === 'archive-manage') {
        const result = controller.manageArchive(body)
        for (const sibling of this.sessions.values()) {
          const previous = sibling.path
          sibling.path = remapArchivePath(previous, result)
          sibling.controller.remapStorage(result)
          if (previous !== sibling.path) {
            sibling.relocatedPaths ||= new Set()
            sibling.relocatedPaths.add(archivePathKey(previous))
          }
          sibling.relocatedPaths?.delete(archivePathKey(sibling.path))
        }
        return { ...result, snapshot: this.snapshot(row) }
      }
      if (action === 'patch') {
        if (!Number.isInteger(body.op?.expectedRevision)) throw new Error('expectedRevision is required')
        return { ...controller.patch(body.op), storage: { path: row.path } }
      }
      if (action === 'look2') return { ...controller.studio.setLook2(body.state, body.expectedRevision), storage: { path: row.path } }
      if (action === 'transaction') { controller.studio.transaction(body); return this.snapshot(row) }
      if (action === 'history') { controller.studio.history(body); return this.snapshot(row) }
      if (action === 'template') { controller.studio.template(body); return this.snapshot(row) }
      if (action === 'image-url') {
        if (!this.imageSource) throw new Error('在线图片服务未配置')
        return this.imageSource.importUrl(body.url)
      }
      if (action === 'export') return controller.studio.exportData(body.format, body.assetType)
      if (action === 'reveal-archive') return controller.revealArchive(body.path)
      if (action === 'delete-archive') {
        const result = controller.deleteArchive(body.path)
        const deleted = String(body.path || '').replaceAll('\\', '/')
        if (row.path === deleted) { row.path = ''; row.fileStamp = '' }
        return result
      }
      if (action === 'play') return controller.play(body.action, body.args || {}, signal)
      if (action === 'load-archive' || action === 'import') {
        await controller.play('stop')
        if (action === 'load-archive') return this.load(row, body.path)
        const result = controller.studio.importData(body.format, body.data, body.filename, { mode: body.mode })
        controller.archivePath = ''; controller.archiveStamp = ''; controller.savedArchive = ''
        controller.archiveRelocations.clear()
        row.path = ''
        row.fileStamp = ''
        row.relocatedPaths?.clear()
        return { ...result, snapshot: this.snapshot(row) }
      }
      if (action === 'save') {
        if (body.expectedRevision !== controller.get().version) throw new Error('revision conflict: reload before saving')
        if (row.relocatedPaths?.has(archivePathKey(body.path))) throw new Error('存档已改名，请刷新存档路径后保存')
        const absolute = resolveWorkspaceOutput(this.workspace, body.path)
        const original = row.path ? resolveWorkspaceOutput(this.workspace, row.path) : ''
        if (row.fileStamp && archivePathKey(absolute) === archivePathKey(original) && !existsSync(absolute)) {
          throw new Error('存档文件已移动或删除，请重新加载或另存为新路径')
        }
        if (existsSync(absolute)) {
          if (archivePathKey(absolute) !== archivePathKey(original) || stamp(absolute) !== row.fileStamp) {
            throw new Error('File changed or already exists; load it again or save under a new path')
          }
        }
        const result = controller.saveArchive(body.path)
        row.path = result.path
        row.fileStamp = stamp(absolute)
        return result
      }
    })
  }

  async dispose() {
    await Promise.all([...this.sessions.values()].map(row => row.controller.exclusive(() => row.controller.dispose())))
    this.sessions.clear()
  }
}
