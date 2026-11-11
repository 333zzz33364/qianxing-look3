#!/usr/bin/env node

import { SimulatorController } from './lib/controller.js'
import { agentPlayArgs } from 'qxqy-studio/play/audio-policy'
import { listWorkspaceArchives, resolveWorkspaceRoot } from './lib/workspace.js'
import { createPreviewClient } from './lib/preview.js'
import manifest from './package.json' with { type: 'json' }
import { listArchiveWorkspaces } from '../studio/host/archive-management.js'

const SERVER_NAME = 'look3-mcp'
const SERVER_VERSION = manifest.version
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0]
}

function workspaceFromArgs() {
  const index = process.argv.indexOf('--workspace')
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : process.env.LOOK2_WORKSPACE || process.cwd()
}

const workspaceRoot = resolveWorkspaceRoot(workspaceFromArgs())
const webUrlIndex = process.argv.indexOf('--web-url')
const preview = createPreviewClient({
  workspace: workspaceRoot,
  webUrl: webUrlIndex >= 0 ? process.argv[webUrlIndex + 1] : process.env.QXQY_WEB_URL,
  password: process.env.QXQY_WEB_PASSWORD || '',
})
const projects = new Map()
let nextHandle = 1
const requests = new Map()

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const handleProperty = {
  handle: {
    type: 'string',
    description: 'look3_project_open 返回的工程句柄；项目级读写和试玩工具需要它。',
  },
}

const tools = [
  {
    name: 'look3_script_sync',
    description: '配置实机 Lua 目录复制同步或检查差异。configure 的 args 包含 config(version:1, workspaceDir, clientImportRoot, clientSubdir) 和 expectedRevision；配置随存档保存。AI 不执行复制：保存存档后请用户在 Web 编辑器加载该存档，在 Lua 脚本页面检查并确认复制。',
    inputSchema: objectSchema({ ...handleProperty, action: { type: 'string', enum: ['discover', 'status', 'configure', 'preview'] }, args: { type: 'object', additionalProperties: true } }, ['handle', 'action']),
  },
  {
    name: 'look3_project_open',
    description: '在本 MCP 进程打开工作区存档，或创建一个新的空工程。不会刷新 Web 预览；显示已有存档请调用 look3_preview_open。返回后续工具使用的工程句柄；path 必须是工作区内相对路径。',
    inputSchema: objectSchema({
      path: { type: 'string', description: '可选的 qxqy-simulator-save JSON 相对路径；省略则创建空工程。' },
    }),
  },
  {
    name: 'look3_project_save',
    description: '把当前工程句柄中的修改保存为工作区内的 qxqy-simulator-save JSON。保存回执只确认写盘；需切换或确认 Web 预览时，随后调用 look3_preview_open。path 必须是工作区内相对路径。',
    inputSchema: objectSchema({
      ...handleProperty,
      path: { type: 'string', description: '可选输出路径；省略时沿用最近成功打开或保存的路径，新工程默认 look3-simulator.save.json。' },
    }, ['handle']),
  },
  {
    name: 'look3_studio_get',
    description: '读取指定工程的无损 Authoring JSON 快照、当前 revision、脚本挂载、画布、服务端逻辑与 controlGuidChanges。若有索引变更记录，必须按控件身份同步存档 Lua source 和相关源文件中的索引引用，核对后再确认清除。写操作前应先获取最新 revision。',
    inputSchema: objectSchema(handleProperty, ['handle']),
  },
  {
    name: 'look3_studio_patch',
    description: '修改指定工程。op 必须包含 expectedRevision；冲突时先重新 get 再重算。客户端控件索引用 setControlGuid（id、guid），修改后必须语义核对并更新 Lua 引用；完成后用 acknowledgeControlGuidChanges（changeIds）确认记录，禁止只改索引或盲目替换全部同值数字。',
    inputSchema: objectSchema({
      ...handleProperty,
      op: { type: 'object', description: 'studio.patch 操作对象，例如 {"op":"set","id":"...","key":"text","value":"...","expectedRevision":1}。', additionalProperties: true },
    }, ['handle', 'op']),
  },
  {
    name: 'look3_studio_transaction',
    description: '原子修改控件、动画、素材或模板；失败完整回滚，作为一个撤销记录。',
    inputSchema: objectSchema({ ...handleProperty, label: { type: 'string' }, ops: { type: 'array', items: { type: 'object', additionalProperties: true } }, state: { type: 'object', additionalProperties: true }, expectedRevision: { type: 'integer' } }, ['handle', 'expectedRevision']),
  },
  {
    name: 'look3_studio_history',
    description: '列出、撤销、重做或恢复工程操作记录。恢复操作需要当前 expectedRevision。',
    inputSchema: objectSchema({ ...handleProperty, action: { type: 'string', enum: ['list', 'undo', 'redo', 'restore'] }, index: { type: 'integer' }, expectedRevision: { type: 'integer' } }, ['handle', 'action']),
  },
  {
    name: 'look3_studio_template',
    description: '导入、修改、删除或实例化客户端控件模板；索引必须与千星配置相同。',
    inputSchema: objectSchema({ ...handleProperty, action: { type: 'string', enum: ['import', 'update', 'remove', 'instantiate'] }, id: { type: 'string' }, name: { type: 'string' }, index: { type: 'integer' }, data: { type: 'string', description: '模板GIA的base64内容' }, filename: { type: 'string' }, parentId: { type: 'string' }, expectedRevision: { type: 'integer' } }, ['handle', 'action', 'expectedRevision']),
  },
  {
    name: 'look3_animation_set',
    description: '修改 look2.0 动画、轨道、关键帧和图片资源状态；先 get 读取 look2 与 revision，再提交完整 state。',
    inputSchema: objectSchema({
      ...handleProperty,
      state: { type: 'object', description: 'get 返回的 look2 状态，修改后整体提交。', additionalProperties: true },
      expectedRevision: { type: 'integer' },
    }, ['handle', 'state', 'expectedRevision']),
  },
  {
    name: 'look3_animation_export',
    description: '导出站点 JSON、Timeline/Primitive 数据与运行库、图元 SVG/CSS、动画 Lua、客户端 GIA 或完整 Look 存档；返回 base64 文件内容。',
    inputSchema: objectSchema({
      ...handleProperty,
      format: { type: 'string', enum: ['site-json', 'timeline-data', 'timeline-lib', 'animation-lua', 'primitive-data', 'primitive-lib', 'primitive-svg', 'primitive-css', 'gia', 'save'] },
      rootId: { type: 'string', description: '数据/动画 Lua 的根控件 ID；SVG/CSS 为所选图元控件或资源 ID。运行库导出不要求此字段。' },
    }, ['handle', 'format']),
  },
  {
    name: 'look3_studio_export',
    description: '导出 GIA/JSON/Lua。list 列出客户端控件与 revision；preview 传 controlIds 预览子树；export 默认 gia-partial，以 controlIds 勾选部分组合。父子同时选自动去重，子控件在副本中提升为独立模板，原存档不变。includeScripts 默认 true（包含挂载脚本和未挂载模块）。支持原有 gia/gia-combined/save 等 format。可选 path 写入工作区新文件，不覆盖已有文件；省略则返回 base64。',
    inputSchema: objectSchema({ ...handleProperty,
      action: { type: 'string', enum: ['list', 'preview', 'export'] },
      args: { type: 'object', properties: {
        format: { type: 'string' }, assetType: { type: 'string' },
        controlIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
        includeScripts: { type: 'boolean' }, expectedRevision: { type: 'integer' },
        canvasId: { type: 'string' }, path: { type: 'string' },
      }, additionalProperties: false },
    }, ['handle', 'action']),
  },
  {
    name: 'look3_studio_play',
    description: '控制指定工程的Lua 试玩 Worker：start、step、输入、暂停/继续、设备/多人视角、服务端变量/信号和用例回放。start 可用 args.asset 选择 server 完整界面或 client 模板；client 可指定 templateRootId，animationId 可指定客户端模板实例的启动动画。expectedRevision 可选，传入时必须等于当前工程 revision。start 后才能进行输入和 step；stop 是确定性回收方式。工具启动的试玩默认关闭浏览器音效，显式 muteAudio:false 可打开。',
    inputSchema: objectSchema({
      ...handleProperty,
      action: {
        type: 'string',
        enum: ['start', 'device', 'fps', 'view', 'get', 'step', 'pointer', 'key', 'click', 'pause', 'resume', 'stop', 'serverGet', 'serverSet', 'serverSend', 'history', 'saveCase', 'runCase'],
      },
      args: {
        type: 'object',
        description: '动作参数。start 可选 asset(server|client)、templateRootId、animationId、expectedRevision、canvasId、playerCount、viewPlayerIndex；start/device 可传 fps:30|60（start 默认 30，device 省略则保留），fps 动作用 fps:30|60 原地切换；device 使用 canvasId；pointer 使用 type/x/y/deltaX/deltaY；start/device 可传 clockMode；start/device 默认 muteAudio:true，传 false 才让浏览器出声；step 使用 dt（省略则推进当前帧率的一帧）；serverSet 使用 entityType/name/value。省略 asset 时沿用工程当前自动分流规则。',
        properties: {
          clockMode: { type: 'string', enum: ['manual', 'realtime'] },
          asset: { type: 'string', enum: ['server', 'client'] },
          templateRootId: { type: 'string' },
          animationId: { type: 'string' },
          expectedRevision: { type: 'integer' },
          canvasId: { type: 'string' },
          playerCount: { type: 'integer' },
          viewPlayerIndex: { type: 'integer' },
        },
        additionalProperties: true,
      },
    }, ['handle', 'action']),
  },
  {
    name: 'look3_studio_ui_screenshot',
    description: '获取当前编辑器舞台 PNG，用于检查静态 UI 布局和控件图元；不会启动或步进试玩。',
    inputSchema: objectSchema(handleProperty, ['handle']),
  },
  {
    name: 'look3_studio_play_screenshot',
    description: '获取当前试玩 Runtime 画面的 PNG；必须先 start，截图不调用 step。默认 manual 模式保持当前帧；显式 realtime 模式在调用之间仍自动运行。回执含 frame/time/clockMode。',
    inputSchema: objectSchema(handleProperty, ['handle']),
  },
  {
    name: 'look3_studio_load',
    description: '列出工作区存档与子工作区，或载入相对路径。operation 可显式创建/改名子工作区或改名存档文件，需 handle 与 expectedRevision；改名不保存未保存草稿且拒绝覆盖。不会刷新 Web 预览。',
    inputSchema: objectSchema({
      ...handleProperty,
      path: { type: 'string', description: '省略时列出存档；传入工作区内相对路径时载入该存档。' },
      operation: { type: 'string', enum: ['create-workspace', 'rename-workspace', 'rename-archive'] },
      name: { type: 'string', description: '新工作区名或存档文件名。' },
      expectedRevision: { type: 'integer' },
    }),
  },
  {
    name: 'look3_preview_status',
    description: '查询独立 Web 预览服务的版本、工作区、当前存档和加载错误。连接到 --web-url / QXQY_WEB_URL（默认 http://127.0.0.1:4173），必须与 MCP 使用同一工作区。无需工程句柄。',
    inputSchema: objectSchema({}),
  },
  {
    name: 'look3_preview_open',
    description: '让独立 Web 预览打开或重新加载已保存的存档，返回 Web 确认的路径、名称和 revision；不会保存 MCP 内未落盘的修改。path 为工作区内相对路径，不受自动列表筛选限制。需要已启动同一工作区的 Web 服务，无需工程句柄。',
    inputSchema: objectSchema({ path: { type: 'string', description: '已保存的 qxqy-simulator-save JSON 工作区相对路径。' } }, ['path']),
  },
]

function jsonText(value) {
  const text = JSON.stringify(value, null, 2)
  return text === undefined ? 'null' : text
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: jsonText({ error: error?.message || String(error) }) }],
  }
}

function controllerFor(handle) {
  const id = String(handle || '').trim()
  const controller = projects.get(id)
  if (!controller) throw new Error(`unknown project handle: ${id || '(empty)'}`)
  return controller
}

function projectSummary(handle, controller, openedPath = '') {
  const snapshot = controller.get()
  return {
    handle,
    workspace: workspaceRoot,
    path: openedPath ? openedPath.replaceAll('\\', '/') : '',
    name: snapshot.save?.name || '',
    revision: snapshot.version,
    activeAssetType: snapshot.asset?.type || '',
  }
}

async function callTool(name, args = {}, signal) {
  if (name === 'look3_preview_status') return preview.status(signal)
  if (name === 'look3_preview_open') return preview.open(args.path, signal)
  if (name === 'look3_project_open') {
    const handle = `project-${nextHandle++}`
    const controller = new SimulatorController(workspaceRoot, { clockMode: 'manual' })
    try {
      const path = String(args.path || '').trim()
      if (path) controller.loadArchive(path)
      projects.set(handle, controller)
      return projectSummary(handle, controller, path)
    } catch (error) {
      await controller.dispose()
      throw error
    }
  }

  if (name === 'look3_studio_load' && !args.handle && !args.path && !args.operation) {
    return { ...listWorkspaceArchives(workspaceRoot), workspaces: listArchiveWorkspaces(workspaceRoot) }
  }

  const controller = controllerFor(args.handle)
  return controller.exclusive(async () => {
    if (name === 'look3_project_save') return {
      ...controller.saveForScriptSync(args.path || controller.archivePath || 'look3-simulator.save.json', controller.get().version),
      preview: { status: 'not-requested', message: 'Saved to disk. Call look3_preview_open with the returned path to switch or confirm the Web preview.' },
    }
    if (name === 'look3_studio_get') return controller.get()
    if (name === 'look3_script_sync') return controller.scriptSyncAction(args.action, args.args || {})
    if (name === 'look3_studio_patch') return controller.patch(args.op)
    if (name === 'look3_studio_transaction') return controller.studio.transaction(args)
    if (name === 'look3_studio_history') return controller.studio.history(args)
    if (name === 'look3_studio_template') return controller.studio.template(args)
    if (name === 'look3_animation_set') return controller.studio.setLook2(args.state, args.expectedRevision)
    if (name === 'look3_animation_export') return controller.studio.exportData(args.format, args.format === 'gia' ? 'client-control-template' : args.rootId)
    if (name === 'look3_studio_export') return controller.exportAction(args.action, args.args || {})
    if (name === 'look3_studio_play') return controller.play(args.action, agentPlayArgs(args.action, args.args || {}), signal)
    if (name === 'look3_studio_ui_screenshot') return controller.uiScreenshot(signal)
    if (name === 'look3_studio_play_screenshot') return controller.playScreenshot(signal)
    if (name === 'look3_studio_load') {
      if (args.operation) {
        const result = controller.manageArchive(args)
        for (const sibling of projects.values()) sibling.remapStorage(result)
        return result
      }
      return args.path ? controller.loadArchive(args.path) : controller.listArchives()
    }
    throw new Error(`unknown tool: ${name}`)
  })
}

function contentFor(value) {
  if (value && Buffer.isBuffer(value.data)) {
    const { data, ...metadata } = value
    return {
      content: [
        { type: 'text', text: jsonText(metadata) },
        { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
      ],
      structuredContent: metadata,
    }
  }
  const result = { content: [{ type: 'text', text: jsonText(value) }] }
  if (value && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value
  return result
}

async function handleRequest(request) {
  const method = request?.method
  const params = request?.params || {}
  if (method === 'initialize') {
    return {
      protocolVersion: negotiateProtocolVersion(params.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'The Web preview is a separate process. look3_project_open and look3_studio_load only change this MCP process and do not update the browser. Save handle edits with look3_project_save, then call look3_preview_open with its returned path to switch or confirm the Web preview. Existing saved files, including externally generated saves, can be previewed directly without rewriting them. look3_preview_status checks the Web version, workspace and active file. Start Web with the same --workspace and configure --web-url / QXQY_WEB_URL if it is not at http://127.0.0.1:4173. Saving succeeds independently of Web connectivity.',
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools }
  if (method === 'tools/call') {
    const name = String(params.name || '')
    if (!tools.some((tool) => tool.name === name)) throw new Error(`unknown tool: ${name || '(empty)'}`)
    return contentFor(await callTool(name, params.arguments || {}, params.signal))
  }
  throw Object.assign(new Error(`method not found: ${method || '(empty)'}`), { code: -32601 })
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendError(id, error, code = -32603) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message: error?.message || String(error) } })
}

async function dispatch(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    sendError(request?.id, new Error('invalid JSON-RPC request'), -32600)
    return
  }
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') {
    if (request.method === 'notifications/cancelled') {
      const cancelled = requests.get(request.params?.requestId)
      cancelled?.abort()
    }
    return
  }
  if (request.id === undefined || request.id === null) return
  const abort = new AbortController()
  requests.set(request.id, abort)
  try {
    const result = await handleRequest({ ...request, params: { ...(request.params || {}), signal: abort.signal } })
    send({ jsonrpc: '2.0', id: request.id, result })
  } catch (error) {
    if (error?.code === -32601) sendError(request.id, error, -32601)
    else if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: toolError(error) })
    else sendError(request.id, error)
  } finally {
    requests.delete(request.id)
  }
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline).trim()
    input = input.slice(newline + 1)
    if (!line) continue
    try {
      void dispatch(JSON.parse(line))
    } catch {
      sendError(null, new Error('invalid JSON'), -32700)
    }
  }
})

async function dispose() {
  await Promise.all([...projects.values()].map((controller) => controller.dispose()))
  projects.clear()
}

process.once('SIGINT', () => { void dispose().finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void dispose().finally(() => process.exit(0)) })
process.stdin.on('end', () => { void dispose() })
