import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { SimulatorController as SharedSimulatorController } from 'qxqy-studio/host/controller'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listWorkspaceArchives, resolveWorkspaceArchive } from './workspace-archives.js'
import { createImageSource } from '../../studio/host/image-source.js'
import { serveImageAsset } from 'qxqy-studio/host/image-assets'
import { serveAudioAsset } from 'qxqy-studio/host/audio-assets'
import { localFont, serveLocalFont } from 'qxqy-studio/host/local-font'
import { createUpdateChecker } from '../../studio/host/updates.js'
import { localLanguageRequest, systemLanguage } from '../../studio/host/system-language.js'

export const name = 'look3-simulator'
export const inject = ['tools', 'webServer']

const API_PREFIX = '/look3-simulator/api'
const PLAY_PATH = '/look3-simulator/play'
const PLAY_RENDERER_PATH = '/look3-simulator/play-renderer.js'
// Pixel-art-heavy QXQY saves can exceed 2 MiB before base64 transport.
// Keep the local import endpoint comfortably above the current paper-theater bundle.
const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_SESSIONS = 32
const SCREENSHOT_TIMEOUT_MS = 60_000
// Keep the bundled plugin self-contained; bump with the root package version.
const PRODUCT_VERSION = '3.1.1'
const imageSource = createImageSource(process.env.LOOK3_ASSET_CACHE || process.env.LOOK2_ASSET_CACHE || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'look3-image-cache'))

// DSH only adapts session-specific concerns (touch bookkeeping, JSON-string
// tool arguments and its localized workspace errors).  The Studio controller
// owns the actual worker lifecycle and play protocol for every host.
export class SimulatorController extends SharedSimulatorController {
  constructor(workspacePath = '') {
    super(workspacePath)
    this.touchedAt = Date.now()
  }

  touch() {
    this.touchedAt = Date.now()
  }

  get() {
    this.touch()
    return super.get()
  }

  patch(op) {
    this.touch()
    // 宿主可能以 JSON 字符串递参；在控制器入口统一收敛，工具层与 HTTP 层共用。
    return super.patch(jsonParam(op))
  }

  exportData(format, assetType) {
    this.touch()
    return this.studio.exportData(format, assetType)
  }

  importData(format, data, filename, options = {}) {
    this.touch()
    const result = this.studio.importData(format, data, filename, options)
    this.archivePath = ''; this.archiveStamp = ''; this.savedArchive = ''
    this.archiveRelocations.clear()
    return { ...result, snapshot: this.get() }
  }

  listArchives() {
    this.touch()
    return this.activeWorkspacePath() ? super.listArchives() : listWorkspaceArchives('')
  }

  loadArchive(path) {
    this.touch()
    const workspace = this.studio.get().workspace?.path || ''
    const abs = resolveWorkspaceArchive(workspace, path)
    const result = super.loadArchive(relative(realpathSync(workspace), abs))
    return { ...result, snapshot: this.get() }
  }

  async play(action, rawArgs = {}, signal) {
    this.touch()
    return super.play(action, jsonParam(rawArgs) || {}, signal)
  }

  async requestScreenshot(signal) {
    const image = await super.playScreenshot(signal)
    return {
      ...image,
      capturedAt: new Date().toISOString(),
    }
  }

  async requestUiScreenshot(signal) {
    this.touch()
    const image = await super.uiScreenshot(signal)
    return {
      ...image,
      capturedAt: new Date().toISOString(),
    }
  }

  async dispose() {
    await this.terminateWorker()
  }
}

function sessionIdOf(value) {
  const id = String(value || '').trim()
  if (!id || id.length > 256) throw new Error('sessionId is required')
  return id
}

// 宿主可能把 type:'json' 参数按 JSON 字符串原样递给 execute（不同 dsh-tools 版本行为不一）。
// 统一在这里收敛：对象原样返回，字符串尝试解析，解析失败视为未提供。
export function jsonParam(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function toolSessionId(exec) {
  return sessionIdOf(exec?.agent?.id)
}

export function headerWorkspace(header) {
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : ''
}

// 会话创建时的工作区（DSH Session.header.cwd）。读取失败或宿主未提供时返回空串，
// 编辑器保持「未绑定」，不再回退到插件进程启动目录。
export function sessionWorkspace(exec) {
  return headerWorkspace(exec?.agent?.session?.header)
}

export async function lookupSessionWorkspace(sessionId, services = {}) {
  const live = services.sessions?.get?.(sessionId)
  const liveCwd = headerWorkspace(live?.header)
  if (liveCwd) return liveCwd
  const inspect = services.sessionPersistence?.inspect
  if (typeof inspect !== 'function') return ''
  try {
    const inspection = await inspect.call(services.sessionPersistence, sessionId)
    return headerWorkspace(inspection?.meta)
  } catch {
    return ''
  }
}

function createRegistry() {
  const sessions = new Map()
  let disposed = false
  function prune() {
    if (sessions.size < MAX_SESSIONS) return
    const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
    if (oldest) {
      sessions.delete(oldest[0])
      void oldest[1].dispose()
    }
  }
  return {
    get(sessionId, workspacePath = '') {
      if (disposed) throw new Error('simulator plugin has been disposed')
      const id = sessionIdOf(sessionId)
      let controller = sessions.get(id)
      if (!controller) {
        prune()
        controller = new SimulatorController(workspacePath)
        sessions.set(id, controller)
      } else if (workspacePath) {
        // 编辑页可能先于任何工具调用创建会话（此时只知道宿主 cwd），
        // 首个工具调用到达时补齐真正的会话工作区。
        controller.studio.setWorkspace(workspacePath)
      }
      controller.touch()
      return controller
    },
    async dispose() {
      disposed = true
      const controllers = [...sessions.values()]
      sessions.clear()
      await Promise.all(controllers.map((controller) => controller.dispose()))
    },
    remapArchives(origin, result) {
      for (const controller of sessions.values()) {
        if (controller.activeWorkspacePath() !== origin.activeWorkspacePath()) continue
        controller.remapStorage(result)
      }
    },
  }
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(text)
}

function loadPlayHtml() {
  if (!playHtmlCache) {
    const candidates = [
      new URL('./play.html', import.meta.url),
      new URL('../lib/play.html', import.meta.url),
    ]
    const hit = candidates.find((url) => existsSync(url))
    if (!hit) throw new Error('standalone play page is missing')
    playHtmlCache = readFileSync(hit, 'utf8')
  }
  return playHtmlCache
}

let playHtmlCache = null

function loadPlayRenderer() {
  // The browser page must consume the bundled ESM output: bare `pixi.js`
  // imports in lib/ are only source code and are not browser-resolvable.
  if (!playRendererCache) {
    const candidates = [
      new URL('../dist/play-renderer.js', import.meta.url),
      new URL('./play-renderer.js', import.meta.url),
    ]
    const hit = candidates.find((url) => existsSync(url))
    if (!hit) throw new Error('standalone play renderer bundle is missing; run npm run build')
    playRendererCache = readFileSync(hit, 'utf8')
  }
  return playRendererCache
}

let playRendererCache = null

function registerRoute(ctx, route) {
  // Unlike tools.register(), webServer.register() returns a plain disposer.
  // Own it in this activation so restart, dependency reload and failed startup
  // all remove the old handler before registering a new session registry.
  return ctx.effect(() => ctx.webServer.register(route), `look3-simulator: ${route.kind} ${route.path}`)
}

function registerPlayPage(ctx) {
  registerRoute(ctx, {
    kind: 'prefix',
    path: PLAY_PATH,
    handler(request, response) {
      const path = new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '')
      if (request.method !== 'GET' || path !== PLAY_PATH) {
        response.statusCode = request.method === 'GET' ? 404 : 405
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.end(request.method === 'GET' ? 'not found' : 'GET required')
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      response.end(loadPlayHtml())
    },
  })
}

function registerPlayRenderer(ctx) {
  registerRoute(ctx, {
    kind: 'exact',
    path: PLAY_RENDERER_PATH,
    handler(request, response) {
      if (request.method !== 'GET') {
        response.statusCode = 405
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.end('GET required')
        return
      }
      try {
        response.statusCode = 200
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        response.end(loadPlayRenderer())
      } catch (error) {
        response.statusCode = 500
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.end(error?.message || String(error))
      }
    },
  })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

function registerTools(ctx, registry) {
  for (const [name, description, action] of [
    ['look3_studio_transaction', '原子修改控件、动画和素材，失败回滚且只产生一个撤销记录。', 'transaction'],
    ['look3_studio_history', '读取、撤销、重做或恢复工程操作记录。', 'history'],
    ['look3_studio_template', '导入、管理或实例化客户端控件模板，索引与游戏配置一致。', 'template'],
  ]) ctx.tools.register(defineTool({
    name, description,
    parameters: { args: { type: 'json', description: '操作参数；修改时必须含 expectedRevision。', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 10_000, isConcurrencySafe: () => false,
    async execute(args, exec) {
      const controller = registry.get(toolSessionId(exec), sessionWorkspace(exec))
      return controller.exclusive(() => controller.studio[action](jsonParam(args.args) || {}))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'look3_animation_set',
    description: '提交 look2.0 动画状态。先用 look3_studio_get 读取 look2 与 revision，修改后整体提交。',
    parameters: {
      state: { type: 'json', description: '完整的 look2 状态', required: true },
      expectedRevision: { type: 'number', description: '当前工程 revision', required: true },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const controller = registry.get(toolSessionId(exec), sessionWorkspace(exec))
      return controller.exclusive(() => controller.studio.setLook2(jsonParam(args.state), args.expectedRevision))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'look3_animation_export',
    description: '导出参考站点 JSON、Timeline Data、可挂载的动画播放 Lua、含动画脚本的客户端 GIA 或完整 Look 存档，返回 base64 文件内容。',
    parameters: {
      format: { type: 'string', enum: ['site-json', 'timeline-data', 'timeline-lib', 'animation-lua', 'primitive-data', 'primitive-lib', 'primitive-svg', 'primitive-css', 'gia', 'save'], required: true },
      rootId: { type: 'string', description: 'Timeline Data 或动画播放 Lua 的可选根控件 ID' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return registry.get(toolSessionId(exec), sessionWorkspace(exec)).studio.exportData(args.format, args.format === 'gia' ? 'client-control-template' : args.rootId)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'look3_script_sync',
    description: '实机 Lua 目录复制同步：discover/status/configure/preview。configure 的 args 包含 config(version:1, workspaceDir, clientImportRoot, clientSubdir) 和 expectedRevision；配置随完整存档保存。preview 只检查差异，复制必须由用户在 Lua 脚本页面检查并确认。',
    parameters: { action: { type: 'string', enum: ['discover', 'status', 'configure', 'preview'], required: true }, args: { type: 'json' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) { return registry.get(toolSessionId(exec), sessionWorkspace(exec)).scriptSyncAction(args.action, jsonParam(args.args) || {}) },
  }))
  ctx.tools.register(defineTool({
    name: 'look3_studio_get',
    description: '读取当前 DeepSeek Harness 会话的千星 UI 编辑器无损 JSON 快照。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return registry.get(toolSessionId(exec), sessionWorkspace(exec)).get()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'look3_studio_play_screenshot',
    description: '获取当前试玩 Runtime 画面的 PNG。Host 与独立试玩页共用 Runtime scene 树（同级先出现的子节点在上）再画成 PNG，不需要打开试玩页或切换标签。仅在需要观察运行时画面、动画或交互结果时调用；若要看编辑器舞台，请改用 look3_studio_ui_screenshot。不会步进时间，也不替代 get {inspect:true} 的结构化断言。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const text = `试玩截图：${value.canvasId || 'unknown'}，Frame ${value.frame ?? 0}，${value.width || 0}×${value.height || 0}`
          + (value.assetWarnings?.length ? `\n素材加载失败（画面中为占位框）：${JSON.stringify(value.assetWarnings)}` : '')
        const content = [{ type: 'text', text }]
        if (value.image) content.push({ type: 'image', attachment: value.image })
        return content
      },
    },
    timeoutMs: SCREENSHOT_TIMEOUT_MS + 1_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const controller = registry.get(toolSessionId(exec), sessionWorkspace(exec))
      const captured = await controller.requestScreenshot(exec.signal)
      const attachments = ctx.get?.('attachments')
      if (!attachments?.saveImage) throw new Error('Harness attachment service is unavailable; cannot return screenshot to AI')
      const ref = await attachments.saveImage({
        data: captured.data,
        mediaType: 'image/png',
        name: `qxqy-play-${captured.canvasId || 'canvas'}-f${captured.frame}.png`,
      })
      const { data, ...metadata } = captured
      return {
        ...metadata,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'look3_studio_ui_screenshot',
    description: '获取当前编辑器舞台的 PNG。Host 根据 boxes 在进程内渲染，不需要打开或保持“模拟器”标签。用于检查静态 UI 布局、选中项和控件图元；不含完整 Chrome DOM 工具栏/检视器。若要看 Lua Runtime 试玩画面，请改用 look3_studio_play_screenshot。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const page = value.page || '模拟器'
        const text = `编辑器截图：${page}，${value.width || 0}×${value.height || 0}`
          + (value.assetWarnings?.length ? `\n素材加载失败（画面中为占位框）：${JSON.stringify(value.assetWarnings)}` : '')
        const content = [{ type: 'text', text }]
        if (value.image) content.push({ type: 'image', attachment: value.image })
        return content
      },
    },
    timeoutMs: SCREENSHOT_TIMEOUT_MS + 1_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const controller = registry.get(toolSessionId(exec), sessionWorkspace(exec))
      const captured = await controller.requestUiScreenshot(exec.signal)
      const attachments = ctx.get?.('attachments')
      if (!attachments?.saveImage) throw new Error('Harness attachment service is unavailable; cannot return screenshot to AI')
      const ref = await attachments.saveImage({
        data: captured.data,
        mediaType: 'image/png',
        name: `qxqy-ui-${captured.page || 'editor'}.png`,
      })
      const { data, ...metadata } = captured
      return {
        ...metadata,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'look3_studio_patch',
    description: '修改当前会话的千星 UI 工程。op 必须携带 expectedRevision。客户端控件索引用 setControlGuid（id、guid）；必须根据快照 controlGuidChanges 更新存档 Lua source 和相关源文件的索引引用并核对，完成后用 acknowledgeControlGuidChanges（changeIds）确认，禁止盲目替换全部同值数字。',
    parameters: {
      op: { type: 'json', required: true, description: '编辑器 patch 对象。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const op = jsonParam(args.op)
      if (!op) throw new Error('patch requires op')
      return registry.get(toolSessionId(exec), sessionWorkspace(exec)).patch(op)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'look3_studio_play',
    description: '控制当前会话的千星 UI 试玩 Worker：启动、步进、输入、暂停、停止、多设备画布切换、多人视角、服务端变量/信号，以及录制回放用例。start 可用 args.asset 选择 server 完整界面或 client 模板；templateRootId 仅用于 client，animationId 可指定客户端模板实例的启动动画；expectedRevision 可选且传入时须与当前工程 revision 一致。',
    parameters: {
      action: {
        type: 'string',
        enum: [
          'start', 'device', 'view', 'get', 'step', 'pointer', 'key', 'click', 'pause', 'resume', 'stop',
          'serverGet', 'serverSet', 'serverSend', 'history', 'saveCase', 'runCase',
        ],
        required: true,
      },
      args: { type: 'json', description: '动作参数；start 可选 asset(server|client)、templateRootId、animationId、expectedRevision、canvasId、playerCount(1-8)、viewPlayerIndex；省略 asset 时沿用原自动分流。device 使用 canvasId；pointer 使用 type/x/y，step 使用 dt；get/start 可用 inspect:true 拉运行树；view 用 playerIndex 切换当前玩家视角；runCase 可带 canvasId/playerCount；serverSet 使用 entityType/name/value；runCase 使用 case。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const playArgs = jsonParam(args.args) || {}
      return registry.get(toolSessionId(exec), sessionWorkspace(exec)).play(args.action, playArgs, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'look3_studio_load',
    description: '列出工作区存档与子工作区或加载相对路径。operation 可显式创建/改名子工作区、改名存档文件，需 expectedRevision；改名保留未保存草稿且拒绝覆盖。',
    parameters: {
      path: { type: 'string', description: '工作区内相对路径，例如 workspace/flappy-fish/flappy-fish.save.json。省略则只列出可拉取存档。' },
      operation: { type: 'string', enum: ['create-workspace', 'rename-workspace', 'rename-archive'] },
      name: { type: 'string' },
      expectedRevision: { type: 'number' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 8_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const controller = registry.get(toolSessionId(exec), sessionWorkspace(exec))
      if (args.operation) return controller.exclusive(() => {
        const result = controller.manageArchive(args)
        registry.remapArchives(controller, result)
        return result
      })
      if (!args.path) return controller.listArchives()
      return controller.loadArchive(args.path)
    },
  }))
}

function registerApi(ctx, registry) {
  const checkUpdates = createUpdateChecker({ packageName: 'look3-dsh-plugin', currentVersion: PRODUCT_VERSION })
  registerRoute(ctx, {
    kind: 'prefix',
    path: API_PREFIX,
    async handler(request, response) {
      const path = new URL(request.url, 'http://localhost').pathname
      const action = path.slice(API_PREFIX.length).replace(/^\/+/, '')
      if (request.method === 'GET' && action === 'system-language') {
        sendJson(response, 200, { ok: true, value: localLanguageRequest(request) ? await systemLanguage() : { language: '', source: 'browser' }, error: null })
        return
      }
      if (request.method === 'GET' && action === 'update-check') {
        try { sendJson(response, 200, { ok: true, value: await checkUpdates(), error: null }) }
        catch (error) { sendJson(response, 502, { ok: false, value: null, error: error?.message || String(error) }) }
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, value: null, error: 'POST required' })
        return
      }
      if (action === 'health') {
        sendJson(response, 200, { ok: true, value: { status: 'ok' }, error: null })
        return
      }
      const abort = new AbortController()
      request.once('aborted', () => abort.abort())
      try {
        const body = await readBody(request)
        const workspacePath = await lookupSessionWorkspace(body.sessionId, {
          sessions: ctx.get?.('sessions'),
          sessionPersistence: ctx.get?.('sessionPersistence'),
        })
        const controller = registry.get(body.sessionId, workspacePath)
        const value = await controller.exclusive(async () => {
        let value
        if (action === 'get') value = controller.get()
        else if (action === 'patch') value = controller.patch(body.op)
        else if (action === 'look2') value = controller.studio.setLook2(body.state, body.expectedRevision)
        else if (action === 'transaction') value = controller.studio.transaction(body)
        else if (action === 'history') value = controller.studio.history(body)
        else if (action === 'template') value = controller.studio.template(body)
        else if (action === 'image-url') value = await imageSource.importUrl(body.url)
        else if (action === 'export') value = controller.exportData(body.format, body.assetType)
        else if (action === 'import') value = controller.importData(body.format, body.data, body.filename, { mode: body.mode })
        else if (action === 'archives') value = controller.listArchives()
        else if (action === 'archive-manage') { value = controller.manageArchive(body); registry.remapArchives(controller, value) }
        else if (action === 'delete-archive') value = controller.deleteArchive(body.path)
        else if (action === 'reveal-archive') value = controller.revealArchive(body.path)
        else if (action === 'load-archive') value = controller.loadArchive(body.path)
        else if (action === 'save') value = controller.saveForScriptSync(body.path, body.expectedRevision)
        else if (action === 'script-sync') value = controller.scriptSyncAction(body.action, body.args || {})
        else if (action === 'script-sync-apply') value = controller.scriptSync.apply(body)
        else if (action === 'image-refresh') {
          await controller.imageAssets.refresh(body.imageId, { imageSource: body.imageSource })
          value = { imageId: body.imageId, imageSource: body.imageSource || 'StaticReference', refreshed: true }
        }
        else if (action === 'play') value = await controller.play(body.action, body.args || {}, abort.signal)
        else throw new Error('unknown API action')
        return value
        })
        sendJson(response, 200, { ok: true, value, error: null })
      } catch (error) {
        sendJson(response, 400, { ok: false, value: null, error: error?.message || String(error) })
      }
    },
  })
}

export function apply(ctx) {
  localFont()
  const registry = createRegistry()
  // Install cleanup before registration can throw, and let Cordis await workers.
  ctx.effect(() => () => registry.dispose(), 'look3-simulator: dispose sessions')
  registerTools(ctx, registry)
  registerApi(ctx, registry)
  registerPlayPage(ctx)
  registerPlayRenderer(ctx)
  for (const worker of ['look2-fit-worker', 'look2-psd-worker']) registerRoute(ctx, {
    kind: 'prefix', path: `/look3-simulator/${worker}.js`,
    handler(request, response) {
      if (request.method !== 'GET' || new URL(request.url, 'http://localhost').pathname !== `/look3-simulator/${worker}.js`) { response.statusCode = 404; response.end(); return }
      const hit = [new URL(`../dist/${worker}.js`, import.meta.url), new URL(`./${worker}.js`, import.meta.url)].find(url => existsSync(url))
      if (!hit) { response.statusCode = 503; response.end('Build the image workers first'); return }
      response.setHeader('content-type', 'text/javascript; charset=utf-8')
      response.setHeader('cache-control', 'no-cache')
      response.end(readFileSync(hit))
    },
  })
  registerRoute(ctx, {
    kind: 'prefix', path: '/look2-assets/',
    async handler(request, response) {
      if (request.method !== 'GET') { response.statusCode = 405; response.end('GET required'); return }
      try {
        const path = new URL(request.url, 'http://localhost').pathname.slice('/look2-assets/'.length)
        const result = await imageSource.asset(path)
        response.statusCode = 200
        response.setHeader('content-type', result.mimeType)
        response.setHeader('cache-control', 'public, max-age=3600')
        response.setHeader('x-look2-cache', result.cache)
        response.setHeader('x-content-type-options', 'nosniff')
        response.end(result.data)
      } catch (error) { sendJson(response, 502, { ok: false, error: String(error.message || error) }) }
    },
  })
  registerRoute(ctx, { kind: 'prefix', path: '/qxqy-assets', handler: (request, response) => serveImageAsset(request, response) })
  registerRoute(ctx, { kind: 'prefix', path: '/qxqy-audio', handler: (request, response) => serveAudioAsset(request, response) })
  registerRoute(ctx, { kind: 'prefix', path: '/qxqy-font', handler: serveLocalFont })
}
