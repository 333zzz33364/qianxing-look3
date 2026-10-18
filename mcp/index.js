#!/usr/bin/env node

import { SimulatorController } from './lib/controller.js'
import { listWorkspaceArchives, resolveWorkspaceRoot } from './lib/workspace.js'
import manifest from './package.json' with { type: 'json' }

const SERVER_NAME = 'look2-mcp'
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
    description: 'look2_project_open 返回的工程句柄；项目级读写和试玩工具需要它。',
  },
}

const tools = [
  {
    name: 'look2_project_open',
    description: '打开工作区中的千星模拟器存档，或创建一个新的空工程。返回后续工具使用的工程句柄；path 必须是工作区内相对路径。',
    inputSchema: objectSchema({
      path: { type: 'string', description: '可选的 qxqy-simulator-save JSON 相对路径；省略则创建空工程。' },
    }),
  },
  {
    name: 'look2_project_save',
    description: '将工程当前状态保存为 qxqy-simulator-save JSON。会创建缺失的工作区子目录；path 必须是工作区内相对路径。',
    inputSchema: objectSchema({
      ...handleProperty,
      path: { type: 'string', description: '可选输出路径，默认 qxqy-simulator.save.json。' },
    }, ['handle']),
  },
  {
    name: 'look2_studio_get',
    description: '读取指定工程的无损 Authoring JSON 快照、当前 revision、脚本挂载、画布和服务端逻辑。写操作前应先调用它获取最新 revision。',
    inputSchema: objectSchema(handleProperty, ['handle']),
  },
  {
    name: 'look2_studio_patch',
    description: '修改指定工程。op 对象必须包含 expectedRevision；发生 revision conflict 时先重新 get，再基于新快照重算 patch。',
    inputSchema: objectSchema({
      ...handleProperty,
      op: { type: 'object', description: 'studio.patch 操作对象，例如 {"op":"set","id":"...","key":"text","value":"...","expectedRevision":1}。', additionalProperties: true },
    }, ['handle', 'op']),
  },
  {
    name: 'look2_studio_transaction',
    description: '原子修改控件、动画、素材或模板；失败完整回滚，作为一个撤销记录。',
    inputSchema: objectSchema({ ...handleProperty, label: { type: 'string' }, ops: { type: 'array', items: { type: 'object', additionalProperties: true } }, state: { type: 'object', additionalProperties: true }, expectedRevision: { type: 'integer' } }, ['handle', 'expectedRevision']),
  },
  {
    name: 'look2_studio_history',
    description: '列出、撤销、重做或恢复工程操作记录。恢复操作需要当前 expectedRevision。',
    inputSchema: objectSchema({ ...handleProperty, action: { type: 'string', enum: ['list', 'undo', 'redo', 'restore'] }, index: { type: 'integer' }, expectedRevision: { type: 'integer' } }, ['handle', 'action']),
  },
  {
    name: 'look2_studio_template',
    description: '导入、修改、删除或实例化客户端控件模板；索引必须与千星配置相同。',
    inputSchema: objectSchema({ ...handleProperty, action: { type: 'string', enum: ['import', 'update', 'remove', 'instantiate'] }, id: { type: 'string' }, name: { type: 'string' }, index: { type: 'integer' }, data: { type: 'string', description: '模板GIA的base64内容' }, filename: { type: 'string' }, parentId: { type: 'string' }, expectedRevision: { type: 'integer' } }, ['handle', 'action', 'expectedRevision']),
  },
  {
    name: 'look2_animation_set',
    description: '修改 look2.0 动画、轨道、关键帧和图片资源状态；先 get 读取 look2 与 revision，再提交完整 state。',
    inputSchema: objectSchema({
      ...handleProperty,
      state: { type: 'object', description: 'get 返回的 look2 状态，修改后整体提交。', additionalProperties: true },
      expectedRevision: { type: 'integer' },
    }, ['handle', 'state', 'expectedRevision']),
  },
  {
    name: 'look2_animation_export',
    description: '导出站点 JSON、Timeline/Primitive 数据与运行库、图元 SVG/CSS、动画 Lua、客户端 GIA 或完整 Look 存档；返回 base64 文件内容。',
    inputSchema: objectSchema({
      ...handleProperty,
      format: { type: 'string', enum: ['site-json', 'timeline-data', 'timeline-lib', 'animation-lua', 'primitive-data', 'primitive-lib', 'primitive-svg', 'primitive-css', 'gia', 'save'] },
      rootId: { type: 'string', description: '数据/动画 Lua 的根控件 ID；SVG/CSS 为所选图元控件或资源 ID。运行库导出不要求此字段。' },
    }, ['handle', 'format']),
  },
  {
    name: 'look2_studio_play',
    description: '控制指定工程的确定性 Lua 试玩 Worker：start、step、输入、暂停/继续、设备/多人视角、服务端变量/信号和用例回放。start 可用 args.asset 选择 server 完整界面或 client 模板；client 可指定 templateRootId，animationId 可指定客户端模板实例的启动动画。expectedRevision 可选，传入时必须等于当前工程 revision。start 后才能进行输入和 step；stop 是确定性回收方式。',
    inputSchema: objectSchema({
      ...handleProperty,
      action: {
        type: 'string',
        enum: ['start', 'device', 'view', 'get', 'step', 'pointer', 'key', 'click', 'pause', 'resume', 'stop', 'serverGet', 'serverSet', 'serverSend', 'history', 'saveCase', 'runCase'],
      },
      args: {
        type: 'object',
        description: '动作参数。start 可选 asset(server|client)、templateRootId、animationId、expectedRevision、canvasId、playerCount、viewPlayerIndex；device 使用 canvasId；pointer 使用 type/x/y；step 使用 dt；serverSet 使用 entityType/name/value。省略 asset 时沿用工程当前自动分流规则。',
        properties: {
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
    name: 'look2_studio_ui_screenshot',
    description: '获取当前编辑器舞台 PNG，用于检查静态 UI 布局和控件图元；不会启动或步进试玩。',
    inputSchema: objectSchema(handleProperty, ['handle']),
  },
  {
    name: 'look2_studio_play_screenshot',
    description: '获取当前试玩 Runtime 画面的 PNG，用于检查 Lua、动画和输入后的实际画面；必须先 start，不会步进时间。',
    inputSchema: objectSchema(handleProperty, ['handle']),
  },
  {
    name: 'look2_studio_load',
    description: '列出工作区内的 qxqy-simulator-save JSON，或将指定相对路径的存档载入已有工程句柄。',
    inputSchema: objectSchema({
      ...handleProperty,
      path: { type: 'string', description: '省略时列出存档；传入工作区内相对路径时载入该存档。' },
    }),
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
  if (name === 'look2_project_open') {
    const handle = `project-${nextHandle++}`
    const controller = new SimulatorController(workspaceRoot)
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

  if (name === 'look2_studio_load' && !args.handle && !args.path) {
    return listWorkspaceArchives(workspaceRoot)
  }

  const controller = controllerFor(args.handle)
  return controller.exclusive(async () => {
    if (name === 'look2_project_save') return controller.saveArchive(args.path)
    if (name === 'look2_studio_get') return controller.get()
    if (name === 'look2_studio_patch') return controller.patch(args.op)
    if (name === 'look2_studio_transaction') return controller.studio.transaction(args)
    if (name === 'look2_studio_history') return controller.studio.history(args)
    if (name === 'look2_studio_template') return controller.studio.template(args)
    if (name === 'look2_animation_set') return controller.studio.setLook2(args.state, args.expectedRevision)
    if (name === 'look2_animation_export') return controller.studio.exportData(args.format, args.format === 'gia' ? 'client-control-template' : args.rootId)
    if (name === 'look2_studio_play') return controller.play(args.action, args.args || {}, signal)
    if (name === 'look2_studio_ui_screenshot') return controller.uiScreenshot()
    if (name === 'look2_studio_play_screenshot') return controller.playScreenshot(signal)
    if (name === 'look2_studio_load') {
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
      instructions: 'Optionally call look2_studio_load without a handle to find saves, then use look2_project_open. Keep the returned handle and call look2_project_save after edits. Paths are workspace-relative.',
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
