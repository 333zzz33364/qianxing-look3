import { toJson } from '../json.js'

const SITE_SCHEMA = 'ClientUIAnimationEditor.TweenTimeline@8'
const TIMELINE_LIBRARY_VERSION = '8.3'
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)*$/.test(value)) return null
  return value.split('.').map(Number)
}

function isNewerVersion(required, installed) {
  for (let index = 0; index < Math.max(required.length, installed.length); index += 1) {
    const left = required[index] || 0, right = installed[index] || 0
    if (left !== right) return left > right
  }
  return false
}

export function luaString(value) {
  const bytes = Buffer.from(String(value ?? ''), 'utf8')
  let out = '"'
  for (const byte of bytes) {
    if (byte === 34 || byte === 92) out += `\\${String.fromCharCode(byte)}`
    else if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte)
    else out += `\\${String(byte).padStart(3, '0')}`
  }
  return `${out}"`
}

export function luaValue(value) {
  if (value === null) return 'nil'
  if (value === undefined) throw new Error('Timeline Data 含有未定义值')
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Timeline Data 含有非有限数值')
    return String(value)
  }
  if (typeof value === 'string') return luaString(value)
  if (Array.isArray(value)) return `{ ${value.map(luaValue).join(', ')} }`
  if (value && typeof value === 'object') {
    const fields = Object.keys(value).sort().map(key => {
      const name = /^[1-9]\d*$/.test(key) ? `[${Number(key)}]`
        : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `[${luaString(key)}]`
      return `${name} = ${luaValue(value[key])}`
    })
    return `{ ${fields.join(', ')} }`
  }
  throw new Error('Timeline Data 含有不支持的关键帧值')
}

function allNodes(project) {
  const rows = []
  const visit = (node, root, path) => {
    rows.push({ node, root, path })
    for (const child of node.children || []) visit(child, root, [...path, child.name])
  }
  for (const root of project.root.children || []) {
    if (root.kind !== 'server-container') visit(root, root, [])
  }
  return rows
}

function selectedRoot(project, rootId = '') {
  const roots = (project.root.children || []).filter(node => node.kind !== 'server-container')
  const selected = roots.find(node => node.id === rootId)
  if (rootId && !selected) throw new Error(`Timeline Data root not found: ${rootId}`)
  return selected || roots[0]
}

function pathHasSlashSegment(path) {
  return path.some(segment => String(segment).includes('/'))
}

function assertRepresentablePath(path) {
  if (pathHasSlashSegment(path)) {
    throw new Error(`Timeline Data path is not representable because a control name contains "/": ${path.join('/')}`)
  }
}

function rowsForRoot(project, root) {
  const rows = []
  const visit = (node, path) => {
    rows.push({ node, path })
    for (const child of node.children || []) visit(child, [...path, child.name])
  }
  visit(root, [])
  return rows
}

function eventPath(event, rows, root) {
  if (event.nodeId) {
    const row = rows.find(item => item.node.id === event.nodeId)
    if (row) {
      assertRepresentablePath(row.path)
      return row.path.join('/')
    }
  }
  const target = String(event.target ?? '')
  if (target === root.name) return ''
  const path = target.startsWith(`${root.name}/`)
    ? target.slice(root.name.length + 1)
    : target.replace(/^\/+|\/+$/g, '')
  const matchingRows = rows.filter(item => item.path.join('/') === path)
  const slashName = matchingRows.find(item => pathHasSlashSegment(item.path))
  if (slashName) assertRepresentablePath(slashName.path)
  return path
}

export function exportTimelineData(project, rawLook2, rootId = '') {
  const look2 = rawLook2
  const animation = look2.animations.find(row => row.id === look2.activeAnimationId) || look2.animations[0]
  if (!animation) throw new Error('没有可导出的动画')
  const root = selectedRoot(project, rootId)
  if (!root) throw new Error('控件树为空')
  const rootRows = rowsForRoot(project, root)
  const ids = new Set(rootRows.map(row => row.node.id))
  const lines = [
    `-- ${project.meta.name}_${animation.name}`,
    `-- 导出根控件：${root.name}`,
    '-- 与 ClientUIAnimationEditor.TweenTimeline@8 / TweenTimelineLib 8.3 兼容。',
    'local TweenTimelineData = {',
    `    schema = ${luaString(SITE_SCHEMA)},`,
    '    version = 8,',
    `    libVersion = ${luaString(TIMELINE_LIBRARY_VERSION)},`,
    `    duration = ${number(animation.duration)},`,
    '    tracks = {',
  ]
  for (const track of animation.keyframeTracks || []) {
    const row = rootRows.find(item => item.node.id === track.nodeId)
    if (!row) continue
    assertRepresentablePath(row.path)
    lines.push(`        { ${luaString(row.path.join('/'))}, ${luaString(track.fieldKey)}, {`)
    for (const key of [...(track.keyframes || [])].sort((a, b) => Number(a.time) - Number(b.time))) {
      const fields = [number(key.time), key.value, key.relative === true, key.easeType || 'Linear', key.interpolation || 'tween']
      if (key.leftValue !== undefined) {
        if (key._legacyBaseDelta === true || key._legacyBaseLeftDelta === true) {
          throw new Error('Timeline Data 无法导出缺少控件基准值的旧增量关键帧')
        }
        fields.push(key.leftValue, key.leftRelative === true)
      } else if (key.leftRelative === true) {
        throw new Error('Timeline Data 的入侧相对关键帧缺少 leftValue')
      } else if (key._legacyBaseDelta === true || key._legacyBaseLeftDelta === true) {
        throw new Error('Timeline Data 无法导出缺少控件基准值的旧增量关键帧')
      }
      lines.push(`            { ${fields.map(luaValue).join(', ')} },`)
    }
    lines.push('        } },')
  }
  lines.push('    },', '    events = {')
  for (const event of animation.events || []) {
    const target = eventPath(event, rootRows, root)
    // Keep the complete event object so site-specific extension fields survive.
    lines.push(`        ${luaValue({ ...event, target })},`)
  }
  lines.push('    },', '}', '', 'return TweenTimelineData', '')
  return lines.join('\n')
}

class LuaLiteralParser {
  constructor(source, offset = 0) { this.source = source; this.index = offset }
  trivia() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) { this.index += 1; continue }
      if (this.source.startsWith('--', this.index)) {
        const end = this.source.indexOf('\n', this.index + 2)
        this.index = end < 0 ? this.source.length : end + 1
        continue
      }
      break
    }
  }
  take(token) { this.trivia(); if (this.source.startsWith(token, this.index)) { this.index += token.length; return true }; return false }
  identifier() {
    this.trivia()
    const match = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (!match) return null
    this.index += match[0].length
    return match[0]
  }
  string() {
    this.trivia()
    const quote = this.source[this.index]
    if (quote !== '"' && quote !== "'") throw new Error('Timeline Lua 常量字符串格式错误')
    this.index += 1
    const bytes = []
    const append = value => bytes.push(...Buffer.from(value, 'utf8'))
    while (this.index < this.source.length) {
      const char = this.source[this.index++]
      if (char === quote) return Buffer.from(bytes).toString('utf8')
      if (char !== '\\') { append(char); continue }
      if (this.index >= this.source.length) throw new Error('Timeline Lua 字符串转义不完整')
      const escaped = this.source[this.index++]
      const simple = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\x0b', '\\': '\\', '"': '"', "'": "'" }
      if (Object.hasOwn(simple, escaped)) { append(simple[escaped]); continue }
      if (escaped === 'z') { while (/\s/.test(this.source[this.index] || '')) this.index += 1; continue }
      if (escaped === 'x') {
        const hex = this.source.slice(this.index, this.index + 2)
        if (!/^[\da-f]{2}$/i.test(hex)) throw new Error('Timeline Lua 十六进制转义格式错误')
        bytes.push(parseInt(hex, 16)); this.index += 2; continue
      }
      if (/\d/.test(escaped)) {
        const digits = escaped + (this.source.slice(this.index).match(/^\d{0,2}/)?.[0] || '')
        const byte = Number(digits)
        if (byte > 255) throw new Error('Timeline Lua 十进制字符串转义超出字节范围')
        bytes.push(byte); this.index += digits.length - 1; continue
      }
      if (escaped === '\n') { append('\n'); continue }
      throw new Error(`Timeline Lua 字符串含有不支持的转义：\\${escaped}`)
    }
    throw new Error('Timeline Lua 字符串没有结束引号')
  }
  value() {
    this.trivia()
    const char = this.source[this.index]
    if (char === '{') return this.table()
    if (char === '"' || char === "'") return this.string()
    if (char === '-' || char === '+' || char === '.' || /\d/.test(char || '')) {
      const match = this.source.slice(this.index).match(/^[+-]?(?:0[xX][\da-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/)
      if (!match) throw new Error('Timeline Lua 数值常量格式错误')
      this.index += match[0].length
      return Number(match[0])
    }
    const identifier = this.identifier()
    if (identifier === 'true') return true
    if (identifier === 'false') return false
    if (identifier === 'nil') return null
    if (identifier) throw new Error(`Timeline Lua 含有非字面量表达式：${identifier}`)
    throw new Error('Timeline Lua 含有不支持的表达式')
  }
  table() {
    this.index += 1
    const array = [], object = {}
    let hasKeyed = false
    this.trivia()
    while (!this.take('}')) {
      this.trivia()
      const start = this.index
      let key, keyed = false
      if (this.take('[')) {
        key = this.value()
        if (!this.take(']') || !this.take('=')) throw new Error('Timeline Lua 表键格式错误')
        keyed = true
      } else {
        const candidate = this.identifier()
        if (candidate && this.take('=')) { key = candidate; keyed = true }
        else this.index = start
      }
      const value = this.value()
      if (keyed) {
        hasKeyed = true
        object[String(key)] = value
      } else array.push(value)
      if (this.take('}')) break
      if (!this.take(',') && !this.take(';')) throw new Error('Timeline Lua 表格缺少逗号')
      this.trivia()
      if (this.take('}')) break
    }
    if (!hasKeyed) return array
    for (let i = 0; i < array.length; i += 1) object[String(i + 1)] = array[i]
    return object
  }
}

function triviaOnly(text) {
  return text.replace(/--[^\n]*/g, '').trim() === ''
}

export function parseTimelineLuaLiteral(source) {
  const text = String(source || '')
  const assignment = /\b(?:local\s+)?(TweenTimelineData|TimelineData)\s*=/.exec(text)
  const returned = !assignment && /\breturn\s*\{/.exec(text)
  if (!assignment && !returned) return null
  const start = assignment ? assignment.index + assignment[0].length : returned.index + returned[0].length - 1
  const prefix = text.slice(0, assignment ? assignment.index : returned.index)
  if (!triviaOnly(prefix)) throw new Error('只允许导入常量 Timeline Data Lua 表，文件前部含有可执行代码')
  const parser = new LuaLiteralParser(text, start)
  const value = parser.value()
  const suffix = text.slice(parser.index)
  const expected = assignment?.[1]
  if (assignment) {
    const rest = suffix.replace(/^\s*(?:return\s+[A-Za-z_][A-Za-z0-9_]*)?\s*/, '')
    if (!triviaOnly(rest) || /\breturn\s+/.test(suffix) && !new RegExp(`^\\s*return\\s+${expected}\\b`).test(suffix)) {
      throw new Error('只允许导入常量 Timeline Data Lua 表，文件尾部含有可执行代码')
    }
  } else if (!triviaOnly(suffix)) throw new Error('Timeline Lua 表后含有可执行代码')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Timeline Data 顶层必须是常量表')
  return value
}

function normalizeTimelineKey(raw, version) {
  if (Array.isArray(raw)) {
    const key = { time: Number(raw[0]), value: raw[1], relative: raw[2] === true,
      easeType: typeof raw[3] === 'string' ? raw[3] : 'Linear', interpolation: raw[4] === 'step' ? 'step' : 'tween' }
    if (raw.length > 5 && raw[5] !== null) key.leftValue = raw[5]
    if (raw.length > 6) key.leftRelative = raw[6] === true
    if (raw[7] === true) key._legacyBaseDelta = true
    if (raw[8] === true) key._legacyBaseLeftDelta = true
    return key
  }
  if (!raw || typeof raw !== 'object') throw new Error('Timeline Data 含有非法关键帧')
  const key = { ...raw, time: Number(raw.time), relative: raw.relative === true || raw.isRelative === true }
  if (raw.isDelta === true) { key._legacyBaseDelta = true; delete key.isDelta }
  if (raw.leftDelta === true && raw.leftRelative !== true) key._legacyBaseLeftDelta = true
  delete key.isRelative
  return key
}

function normalizeTimelineTracks(data, version) {
  const rawTracks = data.tracks || data.keyframeTracks || data.tweens || []
  if (!Array.isArray(rawTracks)) throw new Error('Timeline Data tracks 必须是数组')
  return rawTracks.map(raw => {
    const path = Array.isArray(raw) ? raw[0] : raw.path ?? raw.target ?? raw.targetPath ?? ''
    const fieldKey = Array.isArray(raw) ? raw[1] : raw.fieldKey ?? raw.field ?? raw.property
    const rawKeys = Array.isArray(raw) ? raw[2] : raw.keyframes ?? raw.keys ?? raw.frames
    if (typeof fieldKey !== 'string' || !Array.isArray(rawKeys)) throw new Error('Timeline Data 含有无法识别的动画轨道')
    return { path: Array.isArray(path) ? path.join('/') : String(path), fieldKey,
      keyframes: rawKeys.map(key => normalizeTimelineKey(key, version)) }
  })
}

function normalizeTimelineEvents(data) {
  const rawEvents = data.events || []
  if (!Array.isArray(rawEvents)) throw new Error('Timeline Data events 必须是数组')
  return rawEvents.map(raw => {
    if (Array.isArray(raw)) return { time: Number(raw[0]), name: String(raw[1] ?? ''), target: String(raw[2] ?? ''), params: String(raw[3] ?? '') }
    if (!raw || typeof raw !== 'object') throw new Error('Timeline Data 含有非法事件')
    return { ...raw, time: Number(raw.time), name: String(raw.name ?? ''), target: String(raw.target ?? ''), params: raw.params == null ? '' : String(raw.params) }
  })
}

function extractTimelineData(source) {
  const text = String(source || '')
  const schemaMentions = [...text.matchAll(/ClientUIAnimationEditor\.TweenTimeline@(\d+)/g)].map(match => match[1])
  const data = parseTimelineLuaLiteral(text)
  if (!data) return null
  const supportedVersion = version => Number.isInteger(version) && version >= 3 && version <= 8
  const readSchemaVersion = (value, sourceName) => {
    if (typeof value !== 'string') throw new Error(`Timeline Data ${sourceName} schema 格式无效`)
    const match = /^ClientUIAnimationEditor\.TweenTimeline@(\d+)$/.exec(value)
    if (!match) throw new Error(`Timeline Data ${sourceName} schema 不受支持：${value}`)
    const version = Number(match[1])
    if (!supportedVersion(version) || String(version) !== match[1]) {
      throw new Error(`Timeline Data schema 版本不受支持：${match[1]}（支持 3–8）`)
    }
    return version
  }
  const mentionVersions = schemaMentions.map(value => {
    const version = Number(value)
    if (!supportedVersion(version) || String(version) !== value) {
      throw new Error(`Timeline Data 源码 schema 版本不受支持：${value}（支持 3–8）`)
    }
    return version
  })
  const uniqueMentionVersions = [...new Set(mentionVersions)]
  if (uniqueMentionVersions.length > 1) throw new Error('Timeline Data 源码含有互相矛盾的 schema 版本')
  const sourceSchemaVersion = uniqueMentionVersions[0]
  const tableSchemaVersion = Object.hasOwn(data, 'schema') ? readSchemaVersion(data.schema, '字面表') : undefined
  if (sourceSchemaVersion != null && tableSchemaVersion != null && sourceSchemaVersion !== tableSchemaVersion) {
    throw new Error('Timeline Data 源码与字面表 schema 版本不一致')
  }
  const schemaVersion = tableSchemaVersion ?? sourceSchemaVersion
  const dataLibraryVersion = data.libVersion == null ? null : versionParts(data.libVersion)
  if (data.libVersion != null && !dataLibraryVersion) {
    throw new Error(`Timeline Data libVersion 格式无效：${String(data.libVersion)}`)
  }
  if (dataLibraryVersion && isNewerVersion(dataLibraryVersion, versionParts(TIMELINE_LIBRARY_VERSION))) {
    throw new Error(`Timeline Data 需要 TweenTimelineLib v${data.libVersion}，当前为 v${TIMELINE_LIBRARY_VERSION}`)
  }
  const hasVersion = Object.hasOwn(data, 'version')
  const tableVersion = hasVersion ? data.version : undefined
  if (hasVersion && (!supportedVersion(tableVersion))) {
    throw new Error(`Timeline Data version 不受支持：${String(tableVersion)}（支持 3–8 的整数）`)
  }
  if (schemaVersion != null && tableVersion != null && schemaVersion !== tableVersion) {
    throw new Error('Timeline Data schema 与 version 不一致')
  }
  let libraryVersion
  if (schemaVersion == null && tableVersion == null && dataLibraryVersion != null) {
    libraryVersion = Number(dataLibraryVersion[0])
    if (!supportedVersion(libraryVersion)) throw new Error(`Timeline Data libVersion 不受支持：${data.libVersion}`)
  }
  const explicitVersion = schemaVersion ?? tableVersion ?? libraryVersion
  const hasTracks = 'tracks' in data || 'keyframeTracks' in data || 'tweens' in data
  const hasEvents = 'events' in data
  if (explicitVersion == null && (schemaVersion != null || hasTracks || hasEvents)) {
    throw new Error('Timeline Data 缺少可识别的 schema、version 或 libVersion')
  }
  if (explicitVersion == null) return null
  if (!supportedVersion(explicitVersion)) throw new Error(`Timeline Data 版本不受支持：${explicitVersion}（支持 3–8）`)
  if (schemaVersion == null && !hasTracks && !hasEvents) return null
  return { data, version: explicitVersion }
}

function findPathRows(project, root, requestedPath) {
  const rows = rowsForRoot(project, root)
  let path = String(requestedPath || '').replace(/^\/+|\/+$/g, '')
  if (path === root.name) path = ''
  else if (path.startsWith(`${root.name}/`)) path = path.slice(root.name.length + 1)
  const matches = rows.filter(row => row.path.join('/') === path)
  if (matches.length !== 1) return { row: null, ambiguous: matches.length > 1 }
  if (pathHasSlashSegment(matches[0].path)) return { row: null, ambiguous: false, unrepresentable: true }
  return { row: matches[0], ambiguous: false }
}

export function importTimelineData(source, project, rawLook2, options = {}) {
  const parsed = extractTimelineData(source)
  if (!parsed) return null
  const { data, version } = parsed
  const duration = Number(data.duration ?? data.length ?? 5)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Timeline Data 动画时长必须大于 0')
  const root = selectedRoot(project, options.rootId || '')
  if (!root) throw new Error('请先导入或建立控件层级')
  const tracks = []
  for (const record of normalizeTimelineTracks(data, version)) {
    const match = findPathRows(project, root, record.path)
    if (match.unrepresentable) throw new Error(`Timeline Data path is not representable because a control name contains "/": ${record.path}`)
    if (match.ambiguous) throw new Error(`Timeline Data 控件路径重名：${record.path || root.name}`)
    if (!match.row) throw new Error(`Timeline Data 找不到控件：${record.path || root.name}`)
    tracks.push({ id: `track_${crypto.randomUUID()}`, nodeId: match.row.node.id, fieldKey: record.fieldKey,
      keyframes: record.keyframes.map(key => ({ id: `key_${crypto.randomUUID()}`, ...key })) })
  }
  const eventRecords = normalizeTimelineEvents(data)
  if (!tracks.length && !eventRecords.length) throw new Error('Timeline Data 没有可识别的轨道或事件')
  const validEventId = event => typeof event.id === 'string' && event.id.trim() ? event.id : ''
  const reservedEventIds = new Set(eventRecords.map(validEventId).filter(Boolean))
  const usedEventIds = new Set()
  const newEventId = () => {
    let id
    do { id = `event_${crypto.randomUUID()}` } while (reservedEventIds.has(id) || usedEventIds.has(id))
    return id
  }
  const events = eventRecords.map(event => {
    const match = findPathRows(project, root, event.target)
    if (match.unrepresentable) throw new Error(`Timeline Data path is not representable because a control name contains "/": ${event.target}`)
    if (match.ambiguous) throw new Error(`Timeline Data 事件目标重名：${event.target}`)
    if (!match.row) throw new Error(`Timeline Data 找不到事件目标：${event.target}`)
    const sourceId = validEventId(event)
    const id = sourceId && !usedEventIds.has(sourceId) ? sourceId : newEventId()
    usedEventIds.add(id)
    return { ...event, id, target: event.target || match.row.path.join('/'), nodeId: match.row.node.id }
  })
  const look2 = toJson(rawLook2)
  const mode = options.mode === 'replace' ? 'replace' : 'append'
  if (mode === 'replace') {
    const current = look2.animations.find(row => row.id === look2.activeAnimationId) || look2.animations[0]
    const animation = { ...(current || {}), id: current?.id || `animation_${crypto.randomUUID()}`,
      name: current?.name || data.name || '导入的 Timeline Data', duration,
      keyframeTracks: tracks, events }
    if (current) look2.animations = look2.animations.map(row => row.id === current.id ? animation : row)
    else look2.animations.push(animation)
    look2.activeAnimationId = animation.id
  } else {
    const animation = { id: `animation_${crypto.randomUUID()}`, name: data.name || '导入的 Timeline Data', duration, keyframeTracks: tracks, events }
    look2.animations.push(animation)
    look2.activeAnimationId = animation.id
  }
  return look2
}

const TIMELINE_LIBRARY = String.raw`-- TweenTimelineLib ${TIMELINE_LIBRARY_VERSION} (ClientUIAnimationEditor.TweenTimeline@8)
local TweenTimelineLib = { Schema = "ClientUIAnimationEditor.TweenTimeline@8", Version = "${TIMELINE_LIBRARY_VERSION}" }
local baseAlphas = setmetatable({}, { __mode = "k" })
local colors = { imageColor = true, fontColor = true, bgColor = true, outlineColor = true }
local relativeFields = { anchoredPositionX = true, anchoredPositionY = true, sizeDeltaX = true, sizeDeltaY = true, localScaleX = true, localScaleY = true, localScaleZ = true }
local transformFields = { anchoredPositionX = true, anchoredPositionY = true, sizeDeltaX = true, sizeDeltaY = true,
    localScaleX = true, localScaleY = true, localScaleZ = true, localRotationX = true, localRotationY = true, localRotationZ = true,
    anchorMinX = true, anchorMinY = true, anchorMaxX = true, anchorMaxY = true, pivotX = true, pivotY = true }
local textColors = { fontColor = true, bgColor = true, outlineColor = true }

local function clamp(value, low, high) return math.max(low, math.min(high, value)) end
local function objectId(object) return object.Id or object end
local function values(object)
    return object and object.GetChildren and object:GetChildren() or {}
end
local function children(object, fn)
    fn(object)
    for _, child in ipairs(values(object)) do children(child, fn) end
end
local function resolve(root, path)
    if type(path) == "table" then
        local object = root
        for _, name in ipairs(path) do if object then object = object:GetChild(name) end end
        return object
    end
    local object = root
    for name in string.gmatch(tostring(path or ""), "[^/]+") do
        if not object then return nil end
        object = object:GetChild(name)
    end
    return object
end
local function color(value)
    if type(value) == "number" then return value end
    if type(value) ~= "table" then error("TweenTimelineLib: color value must be RGBA") end
    local alpha = tonumber(value.a)
    if alpha == nil then alpha = 1 end
    if alpha <= 1 then alpha = alpha * 255 end
    return Color.FromRGBA(value.r or 0, value.g or 0, value.b or 0, alpha)
end
local function resolveValue(value, relative, previous)
    if relative then
        if type(value) ~= "number" or type(previous) ~= "number" then error("TweenTimelineLib: relative key value must be numeric") end
        return previous + value
    end
    return value
end
local function supportsField(object, field)
    if field == "groupAlpha" or field == "visible" or transformFields[field] then return true end
    local ok, value = pcall(typeof, object)
    local kind = ok and tostring(value) or tostring(object.typeofName or "")
    if field == "imageColor" or field == "fillAmount" or field == "softEdgeWidthX" or field == "softEdgeWidthY"
        or field == "horizontalSoftRange" or field == "verticalSoftRange" then return kind == "ClientUIImageControl" end
    if field == "scrollProgress" then return kind == "ClientUIGridScrollerControl" end
    if field == "fontSize" or textColors[field] then
        return kind == "ClientUITextBox" or kind == "ClientUITextBoxControl"
            or kind == "ClientUIWindowControl" or kind == "ClientUITextWindowControl"
    end
    return false
end
local function validColor(value)
    if type(value) == "number" then return value >= 0 and value <= 4294967295 end
    if type(value) ~= "table" then return false end
    for _, key in ipairs({ "r", "g", "b" }) do
        local channel = tonumber(value[key])
        if not channel or channel < 0 or channel > 255 then return false end
    end
    local alpha = value.a == nil and 1 or tonumber(value.a)
    return alpha ~= nil and alpha >= 0 and alpha <= 1
end
local keyRows
local function validateKeys(field, raw, duration)
    local keys = keyRows(raw)
    for _, key in ipairs(keys) do
        local time, value = tonumber(key[1]), key[2]
        if not time or time < 0 or time > duration then error("TweenTimelineLib: keyframe time out of range") end
        if key[3] == true and not relativeFields[field] or key[7] == true and not relativeFields[field] then
            error("TweenTimelineLib: relative values are not supported for " .. tostring(field))
        end
        if key[5] ~= nil and key[5] ~= "tween" and key[5] ~= "step" then error("TweenTimelineLib: invalid interpolation") end
        local ease = key[4] or "Linear"
        if not Enum.EaseType[ease] and not ({ EaseIn = true, EaseOut = true, EaseInOut = true })[ease] then error("TweenTimelineLib: invalid easing") end
        if field == "visible" then
            if type(value) ~= "boolean" or key[5] ~= "step" or key[3] == true or key[6] ~= nil then
                error("TweenTimelineLib: visible keys must be step booleans without relative or incoming values")
            end
        elseif field == "groupAlpha" then
            if type(value) ~= "number" or value < 0 or value > 255
                or key[6] ~= nil and (type(key[6]) ~= "number" or key[6] < 0 or key[6] > 255) then
                error("TweenTimelineLib: groupAlpha must be between 0 and 255")
            end
        elseif colors[field] then
            if not validColor(value) or key[6] ~= nil and not validColor(key[6]) then error("TweenTimelineLib: invalid RGBA key value") end
        elseif type(value) ~= "number" or key[6] ~= nil and type(key[6]) ~= "number" then
            error("TweenTimelineLib: numeric tracks require numeric key values")
        end
    end
    return keys
end
keyRows = function(raw)
    local keys = {}
    for i, key in ipairs(raw or {}) do keys[i] = key end
    table.sort(keys, function(a, b) return a[1] < b[1] end)
    for i = 2, #keys do if math.abs(keys[i][1] - keys[i - 1][1]) <= 0.000001 then error("TweenTimelineLib: duplicate keyframe times") end end
    return keys
end
local function convert(field, value)
    if colors[field] then return color(value) end
    if field == "groupAlpha" then return tonumber(value) end
    return value
end
local function resolveEase(name)
    if name == "EaseIn" then name = "InQuad"
    elseif name == "EaseOut" then name = "OutQuad"
    elseif name == "EaseInOut" then name = "InOutQuad" end
    return Enum.EaseType[name] or Enum.EaseType.Linear
end
local function reserve(claimed, object, field)
    local id = objectId(object)
    claimed[id] = claimed[id] or {}
    if claimed[id][field] then error("TweenTimelineLib: conflicting animation target " .. tostring(field)) end
    claimed[id][field] = true
end
local function cacheAlpha(object, field)
    local id = objectId(object)
    baseAlphas[id] = baseAlphas[id] or {}
    if baseAlphas[id][field] ~= nil then return baseAlphas[id][field] end
    local ok, packed = pcall(function() return object[field] end)
    if not ok or type(packed) ~= "number" then return nil end
    local _, _, _, alpha = Color.ToRGBA(packed)
    baseAlphas[id][field] = alpha
    return alpha
end
local function trackIntoSequence(sequence, object, field, rawKeys, duration, claimed, converter)
    reserve(claimed, object, field)
    local keys = validateKeys(field, rawKeys, duration)
    if #keys == 0 then return end
    local initial = object[field]
    local previous = initial
    local right, incoming = {}, {}
    for i, key in ipairs(keys) do
        right[i] = convert(field, resolveValue(key[2], key[3] == true, previous))
        incoming[i] = key[6] ~= nil and convert(field, resolveValue(key[6], key[7] == true, previous)) or right[i]
        previous = right[i]
    end
    local function setValue(value)
        if field == "visible" then object:SetVisible(value) else object[field] = value end
    end
    local visibleBeforeFirst = field == "visible" and keys[1][1] > 0
    local initialValue = right[1]
    if visibleBeforeFirst then initialValue = initial end
    sequence:InsertCallback(0, function() setValue(initialValue) end)
    -- 设备时序下 Sequence 在下一次更新才执行 0 秒回调；编辑器仍需在创建时显示首帧。
    setValue(initialValue)
    for i, key in ipairs(keys) do
        if i < #keys then
            local nextKey = keys[i + 1]
            local span = nextKey[1] - key[1]
            if span < 0 or nextKey[1] > duration then error("TweenTimelineLib: keyframe time out of range") end
            if span > 0 and key[5] ~= "step" then
                local targetValue = converter and converter(incoming[i + 1], nextKey, i + 1) or incoming[i + 1]
                local easeType = resolveEase(key[4] or "Linear")
                local tween = game.Tween(object, { [field] = targetValue }, span):SetEase(easeType)
                sequence:Insert(key[1], tween)
            end
        end
        local rightValue = converter and converter(right[i], key, i) or right[i]
        sequence:InsertCallback(key[1], function() setValue(rightValue) end)
    end
end
local function targetColors(root, groupKeys, duration, sequence, claimed)
    children(root, function(object)
        for field in pairs(colors) do
            local baseAlpha = cacheAlpha(object, field)
            if baseAlpha ~= nil then
                local ok, packed = pcall(function() return object[field] end)
                if not ok or type(packed) ~= "number" then return end
                local r, g, b = Color.ToRGBA(packed)
                local keys = {}
                for i, key in ipairs(groupKeys) do
                    local value = clamp(tonumber(key[2]) or 255, 0, 255)
                    local colorValue = Color.FromRGBA(r, g, b, math.floor(baseAlpha * value / 255 + 0.5))
                    local row = { key[1], colorValue, false, key[4] or "Linear", key[5] or "tween" }
                    if key[6] ~= nil then
                        local left = clamp(tonumber(key[6]) or value, 0, 255)
                        row[6] = Color.FromRGBA(r, g, b, math.floor(baseAlpha * left / 255 + 0.5)); row[7] = false
                    end
                    keys[i] = row
                end
                trackIntoSequence(sequence, object, field, keys, duration, claimed)
            end
        end
    end)
end
function TweenTimelineLib.ResetBaseAlphas(root)
    if not root then baseAlphas = setmetatable({}, { __mode = "k" }); return end
    children(root, function(object) baseAlphas[objectId(object)] = nil end)
end
local function validateTimelineVersion(data)
    local function versionParts(value)
        if type(value) ~= "string" or not value:match("^%d[%d%.]*$")
            or value:sub(-1) == "." or value:find("..", 1, true) then return nil end
        local parts = {}
        for part in value:gmatch("%d+") do parts[#parts + 1] = tonumber(part) end
        return #parts > 0 and parts or nil
    end
    local function isNewerVersion(required, installed)
        for index = 1, math.max(#required, #installed) do
            local left, right = required[index] or 0, installed[index] or 0
            if left ~= right then return left > right end
        end
        return false
    end
    local requiredLibrary
    if data.libVersion ~= nil then
        requiredLibrary = versionParts(data.libVersion)
        if not requiredLibrary then error("TweenTimelineLib: invalid libVersion " .. tostring(data.libVersion)) end
        local installed = versionParts(TweenTimelineLib.Version)
        if isNewerVersion(requiredLibrary, installed) then
            error("TweenTimelineLib: data requires library v" .. tostring(data.libVersion) .. ", installed v" .. TweenTimelineLib.Version)
        end
    end
    local schemaVersion
    if data.schema ~= nil then
        if type(data.schema) ~= "string" then error("TweenTimelineLib: timeline schema must be a string") end
        local digits = string.match(data.schema, "^ClientUIAnimationEditor%.TweenTimeline@(%d+)$")
        if not digits then error("TweenTimelineLib: unsupported timeline schema " .. tostring(data.schema)) end
        schemaVersion = tonumber(digits)
        if schemaVersion < 3 or schemaVersion > 8 then
            error("TweenTimelineLib: unsupported timeline schema version " .. tostring(schemaVersion) .. " (supported: 3-8)")
        end
    end
    local version = data.version
    if version == nil and schemaVersion ~= nil then version = schemaVersion end
    if version == nil and requiredLibrary then version = requiredLibrary[1] end
    if type(version) ~= "number" or version % 1 ~= 0 or version < 3 or version > 8 then
        error("TweenTimelineLib: unsupported or missing timeline version (supported: 3-8)")
    end
    if schemaVersion ~= nil and version ~= schemaVersion then
        error("TweenTimelineLib: timeline schema/version mismatch")
    end
    return version
end
function TweenTimelineLib.Create(root, data, options)
    if not root or type(data) ~= "table" then error("TweenTimelineLib: root and timeline data are required") end
    validateTimelineVersion(data)
    if type(data.tracks) ~= "table" then error("TweenTimelineLib: timeline tracks are required") end
    options = options or {}
    local duration = tonumber(data.duration) or 0
    if duration <= 0 then error("TweenTimelineLib: duration must be positive") end
    local sequence = game.TweenSequence()
    sequence:AppendInterval(duration)
    local claimed, events = {}, {}
    for _, track in ipairs(data.tracks) do
        local object = resolve(root, track[1])
        if not object then error("TweenTimelineLib: target path not found: " .. tostring(track[1])) end
        local field = track[2]
        if not supportsField(object, field) then error("TweenTimelineLib: unsupported field " .. tostring(field)) end
        if field == "groupAlpha" then targetColors(object, validateKeys(field, track[3], duration), duration, sequence, claimed)
        else trackIntoSequence(sequence, object, field, track[3], duration, claimed) end
    end
    local onEvent = options.onEvent
    for index, event in ipairs(data.events or {}) do events[index] = { event = event, target = resolve(root, event.target), index = index } end
    table.sort(events, function(a, b) if a.event.time == b.event.time then return a.index < b.index end; return a.event.time < b.event.time end)
    for _, row in ipairs(events) do
        local event, control = row.event, row.target
        if not control then error("TweenTimelineLib: event target path not found: " .. tostring(event.target)) end
        if type(event.time) ~= "number" or event.time < 0 or event.time > duration then error("TweenTimelineLib: event time out of range") end
        if type(event.name) ~= "string" or #event.name < 1 or #event.name > 320 then error("TweenTimelineLib: invalid event name") end
        if event.params ~= nil and (type(event.params) ~= "string" or #event.params > 16384) then error("TweenTimelineLib: invalid event params") end
        sequence:InsertCallback(event.time, function()
            if control.alive and type(onEvent) == "function" then
                local ok, message = pcall(onEvent, event, control)
                if not ok then pcall(print, "TweenTimelineLib event " .. tostring(event.name) .. " failed: " .. tostring(message)) end
            end
        end)
    end
    return sequence
end
TweenTimelineLib.create = TweenTimelineLib.Create
return TweenTimelineLib
`

export function exportTimelineLibrary() { return TIMELINE_LIBRARY }
