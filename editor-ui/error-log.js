export const ERROR_LOG_LIMIT = 100

export const ERROR_LOG_CSS = `
.look2-top .look2-error-trigger{display:block;max-width:190px;min-width:85px;padding:3px 5px;border:1px solid #596777;background:#242a33;border-radius:4px;text-align:left;cursor:pointer;flex:0 1 auto}
.look2-top .look2-error-trigger.error{color:#ffaaa5;border-color:#b45b59}.look2-error-trigger:focus-visible{outline:2px solid #78b7ff;outline-offset:2px}
.look2 .look2-error-history{width:min(760px,calc(100vw - 28px));max-width:calc(100vw - 28px);max-height:calc(100vh - 32px);min-height:180px;overflow:hidden}
.look2-error-history header{flex-wrap:wrap;gap:5px}.look2-error-list{overflow:auto;min-height:0;flex:1;padding:10px 14px;overscroll-behavior:contain}
.look2-error-help{font-size:11px;color:#b7c2d1}.look2-error-entry{padding:10px;margin:8px 0;border:1px solid #66464b;border-radius:5px;background:#30282d;overflow-wrap:anywhere}
.look2-error-entry p{white-space:pre-wrap;line-height:1.5;margin:5px 0}.look2-error-time,.look2-error-entry small{font-size:11px;color:#bfc8d6}.look2-error-entry summary{cursor:pointer;margin-top:8px}
.look2-error-entry pre{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;max-height:220px;overflow:auto;padding:8px;background:#1c2028;font-size:11px}
`

const RULES = [
  [/server container only accepts container nodes/i, '最外层客户端控件容器只能直接包含容器节点；请将按钮等控件添加到内部容器。', 'The outer client UI wrapper only accepts container nodes. Add other controls inside a client container.'],
  [/revision conflict|版本冲突/i, '工程版本已变化，请重新读取当前状态后重试。', 'The document revision has changed. Refresh the current state and try again.'],
  [/add: parent not found|找不到父容器/i, '添加失败：找不到目标父容器，请重新选择容器。', 'Cannot add the control: the parent container was not found. Select a container again.'],
  [/cannot remove root/i, '无法直接删除存档结构的根节点。', 'The structural document root cannot be removed directly.'],
  [/moveSibling: node not found/i, '调整层序失败：控件或同级父容器不存在。', 'Cannot reorder: the control or its parent was not found.'],
  [/最外层客户端控件容器只能直接包含容器节点/, null, 'The outer client UI wrapper only accepts container nodes. Move other controls into an inner container.'],
  [/控件不能移动到自身或其后代下面/, null, 'A control cannot be moved into itself or one of its descendants.'],
  [/reparent: (node|parent) not found/i, '调整层级失败：控件或目标父级不存在，请重新选择。', 'Cannot change hierarchy: the control or target parent was not found.'],
  [/当前界面为空.*站点 JSON/, null, 'The UI is empty. Add a container before exporting site JSON, or use a full save to keep an empty UI.'],
  [/当前界面为空.*GIA/, null, 'The UI is empty. Add a container before exporting GIA.'],
  [/客户端控件模板列表至少需要一个模板/, null, 'Add at least one client template before exporting GIA.'],
  [/File changed or already exists/i, '目标文件已变化或已存在，请重新载入或另存为新文件。', 'The file has changed or already exists. Reload it or save under a new name.'],
  [/Failed to fetch|NetworkError|fetch failed|网络请求失败/i, '网络请求失败，请检查编辑器服务和连接后重试。', 'The network request failed. Check the editor service and connection, then retry.'],
  [/试玩期间.*只读/, null, 'The document is read-only during play. Stop play before editing.'],
  [/上一个输入未能提交|上一个输入未提交/, null, 'The previous input could not be committed. Correct that input before continuing.'],
  [/编辑资产已切换/, null, 'The active asset has changed. Select the target again and retry.'],
  [/所选控件或编辑资产已变化/, null, 'The selected control or active asset has changed. Select it again and retry.'],
  [/同级.*(名称|命名).*(重复|已存在)|同级.*已存在.*名称|duplicate.*name/i, '同级控件中已有该名称，请使用不同名称。', 'A sibling already uses this name. Choose a unique control name.'],
  [/请输入.*数字|有效数字|必须.*有限数|finite number|finite numeric/i, '请输入有效的有限数值。', 'Enter a valid finite number.'],
  [/图元控件仅适用于客户端控件模板/, null, 'Primitive controls are only available in client control templates.'],
  [/至少保留一个动画/, null, 'Keep at least one animation in the document.'],
  [/事件名称不能为空或超过 320 字节/, null, 'An event name must not be empty or exceed 320 bytes.'],
  [/事件参数超过 16384 字节/, null, 'Event parameters must not exceed 16384 bytes.'],
]

export function describeEditorError(value) {
  const raw = String(value?.message ?? value ?? '')
  const chinese = /[\u3400-\u9fff]/.test(raw)
  const rule = RULES.find(([pattern]) => pattern.test(raw))
  return {
    raw,
    zh: chinese ? raw : rule?.[1] || '操作失败，请查看下方英文原始错误。',
    en: chinese ? rule?.[2] || 'The operation failed. See the original error for details.' : raw,
    translated: Boolean(rule),
  }
}

export const emptyErrorLog = () => ({ current: '', entries: [], nextId: 1 })

export function updateErrorLog(state, update, now = Date.now()) {
  const value = typeof update === 'function' ? update(state.current) : update
  const current = String(value?.message ?? value ?? '')
  if (typeof update === 'function' && current === state.current) return state
  if (!current) return { ...state, current: '' }
  const previous = state.entries.at(-1)
  // Adjacent notifications of the same failure share a row, retaining the count and times.
  if (previous?.raw === current && now - previous.lastAt >= 0 && now - previous.lastAt <= 1000) {
    return { ...state, current, entries: [...state.entries.slice(0, -1), { ...previous, lastAt: now, count: previous.count + 1 }] }
  }
  const entry = { id: state.nextId, raw: current, firstAt: now, lastAt: now, count: 1 }
  return { current, nextId: state.nextId + 1, entries: [...state.entries, entry].slice(-ERROR_LOG_LIMIT) }
}

const storageKey = sessionId => `look2-error-log:${sessionId}`

export function loadErrorLog(sessionId, storage) {
  try {
    const source = storage ?? globalThis.sessionStorage
    const parsed = JSON.parse(source?.getItem(storageKey(sessionId)) || 'null')
    if (!parsed || !Array.isArray(parsed.entries)) return emptyErrorLog()
    const entries = parsed.entries.filter(row => typeof row?.raw === 'string' && row.raw
      && Number.isSafeInteger(row.id) && row.id > 0 && Number.isFinite(row.firstAt) && Number.isFinite(row.lastAt)
      && Number.isSafeInteger(row.count) && row.count > 0).slice(-ERROR_LOG_LIMIT)
    return { current: typeof parsed.current === 'string' ? parsed.current : '', entries,
      nextId: Math.max(0, ...entries.map(row => row.id)) + 1 }
  } catch { return emptyErrorLog() }
}

export function saveErrorLog(sessionId, state, storage) {
  try {
    const target = storage ?? globalThis.sessionStorage
    target?.setItem(storageKey(sessionId), JSON.stringify(state))
  } catch { /* A full or unavailable browser store must not interrupt editing. */ }
}
