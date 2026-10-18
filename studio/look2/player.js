import { luaString, luaValue } from './timeline-lua.js'
import { COLOR_FIELDS, EASE_TYPES, RELATIVE_FIELDS, TWEENABLE_FIELDS } from './sampling.js'
import { collectUsedGuids, nextFreeGuid } from '../gia/guid.js'

function stableRootPathId(root) {
  const guid = Number(root?.guid)
  if (Number.isSafeInteger(guid) && guid > 0) return String(guid)
  const id = String(root?.id ?? '')
  const encoded = Array.from(id, character => character.codePointAt(0).toString(16)).join('-')
  return 'id-' + (encoded || 'empty')
}

const FIELD_BY_KEY = new Map(TWEENABLE_FIELDS.map(field => [field.fieldKey, field]))

function supportedField(node, fieldKey, look2) {
  if (look2.siteNodes?.[node.id]?.type === 'primitive' && ['imageColor', 'fillAmount'].includes(fieldKey)) return false
  return FIELD_BY_KEY.get(fieldKey)?.kinds.includes(node.kind) === true
}

function validColor(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
  return value && typeof value === 'object'
    && ['r', 'g', 'b'].every(key => Number.isFinite(Number(value[key])) && Number(value[key]) >= 0 && Number(value[key]) <= 255)
    && (value.a === undefined || Number.isFinite(Number(value.a)) && Number(value.a) >= 0 && Number(value.a) <= 1)
}

function validKeyValue(type, value) {
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'color') return validColor(value)
  if (type === 'groupAlpha') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255
  return Number.isFinite(value)
}

function normalizeTargetPath(value, rootName = '') {
  let path = String(value || '').replace(/^\/+|\/+$/g, '')
  if (rootName && path.startsWith(`${rootName}/`)) path = path.slice(rootName.length + 1)
  else if (path === rootName) path = ''
  return path
}

function normalizeScriptPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function colorFieldsFor(node) {
  if (node.kind === 'image') return ['imageColor']
  if (node.kind === 'textbox' || node.kind === 'textwindow') return ['fontColor', 'bgColor', 'outlineColor']
  return []
}

// Self-contained Lua 5.1 compatible playback script for clients that expose
// script:EnableUpdate. It uses the same right/incoming-side sampling contract
// as the editor and TweenTimeline@8.
const PLAYER = String.raw`
local currentAnimation
local currentBindings, currentEvents = {}, {}
local elapsed, playing, initialized = 0, false, false
local colorFields = { "imageColor", "fontColor", "bgColor", "outlineColor" }
local controlledBases, controlledBaseFields = {}, {}
local alphaBases, alphaBaseFields = {}, {}
local eventBindings = {}
local pendingBindingEvents = {}
local function clamp(v, low, high) return math.max(low, math.min(high, v)) end
local function isColorField(field)
    return field == "imageColor" or field == "fontColor" or field == "bgColor" or field == "outlineColor"
end
local function objectId(object) return object.Id or object end
local function normalizeColor(value)
    if type(value) == "table" then
        local alpha = tonumber(value.a)
        if alpha == nil then alpha = 1 end
        if alpha <= 1 then alpha = alpha * 255 end
        return { tonumber(value.r) or 0, tonumber(value.g) or 0, tonumber(value.b) or 0, alpha }
    end
    if type(value) == "number" then
        local r, g, b, a = Color.ToRGBA(value)
        return { r, g, b, a }
    end
    return value
end
local function valueFor(key, base, previous, incoming, color)
    local value, relative = key[2], key[3]
    local legacy = key.legacyBaseDelta
    if incoming and key[6] ~= nil then value, relative, legacy = key[6], key[7], key.legacyBaseLeftDelta
    elseif incoming then incoming = false end
    if color then value = normalizeColor(value) end
    if relative then
        if type(value) == "number" and type(previous) == "number" then return previous + value end
    elseif legacy and type(value) == "number" and type(base) == "number" then
        return base + value
    end
    return value
end
local function addColor(a, b)
    if type(a) ~= "table" or type(b) ~= "table" then return b end
    return { a[1] + (b[1] or 0), a[2] + (b[2] or 0), a[3] + (b[3] or 0), a[4] + (b[4] or 0) }
end
local function mix(a, b, amount)
    if type(a) == "number" and type(b) == "number" then return a + (b - a) * amount end
    if type(a) == "table" and type(b) == "table" then
        local result = {}
        for i = 1, #a do result[i] = (a[i] or 0) + ((b[i] or 0) - (a[i] or 0)) * amount end
        return result
    end
    return a
end
local function bounceOut(t)
    local n1, d1 = 7.5625, 2.75
    if t < 1 / d1 then return n1 * t * t end
    if t < 2 / d1 then t = t - 1.5 / d1; return n1 * t * t + 0.75 end
    if t < 2.5 / d1 then t = t - 2.25 / d1; return n1 * t * t + 0.9375 end
    t = t - 2.625 / d1
    return n1 * t * t + 0.984375
end
local function ease(name, t)
    t = clamp(t, 0, 1)
    if t == 0 or t == 1 then return t end
    if name == "EaseIn" or name == "InQuad" then return t * t
    elseif name == "EaseOut" or name == "OutQuad" then return 1 - (1 - t) * (1 - t)
    elseif name == "EaseInOut" or name == "InOutQuad" then if t < 0.5 then return 2 * t * t else return 1 - (-2 * t + 2) ^ 2 / 2 end
    elseif name == "InSine" then return 1 - math.cos(t * math.pi / 2)
    elseif name == "OutSine" then return math.sin(t * math.pi / 2)
    elseif name == "InOutSine" then return -(math.cos(math.pi * t) - 1) / 2
    elseif name == "InCubic" then return t ^ 3
    elseif name == "OutCubic" then return 1 - (1 - t) ^ 3
    elseif name == "InOutCubic" then if t < 0.5 then return 4 * t ^ 3 else return 1 - (-2 * t + 2) ^ 3 / 2 end
    elseif name == "InQuart" then return t ^ 4
    elseif name == "OutQuart" then return 1 - (1 - t) ^ 4
    elseif name == "InOutQuart" then if t < 0.5 then return 8 * t ^ 4 else return 1 - (-2 * t + 2) ^ 4 / 2 end
    elseif name == "InQuint" then return t ^ 5
    elseif name == "OutQuint" then return 1 - (1 - t) ^ 5
    elseif name == "InOutQuint" then if t < 0.5 then return 16 * t ^ 5 else return 1 - (-2 * t + 2) ^ 5 / 2 end
    elseif name == "InExpo" then return 2 ^ (10 * t - 10)
    elseif name == "OutExpo" then return 1 - 2 ^ (-10 * t)
    elseif name == "InOutExpo" then if t < 0.5 then return 2 ^ (20 * t - 10) / 2 else return (2 - 2 ^ (-20 * t + 10)) / 2 end
    elseif name == "InCirc" then return 1 - math.sqrt(1 - t ^ 2)
    elseif name == "OutCirc" then return math.sqrt(1 - (t - 1) ^ 2)
    elseif name == "InOutCirc" then if t < 0.5 then return (1 - math.sqrt(1 - (2 * t) ^ 2)) / 2 else return (math.sqrt(1 - (-2 * t + 2) ^ 2) + 1) / 2 end
    elseif name == "InBack" then local c = 1.70158; return (c + 1) * t ^ 3 - c * t ^ 2
    elseif name == "OutBack" then local c = 1.70158; return 1 + (c + 1) * (t - 1) ^ 3 + c * (t - 1) ^ 2
    elseif name == "InOutBack" then local c = 1.70158 * 1.525; if t < 0.5 then return ((2 * t) ^ 2 * ((c + 1) * 2 * t - c)) / 2 else return ((2 * t - 2) ^ 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2 end
    elseif name == "InElastic" then return -(2 ^ (10 * t - 10)) * math.sin((t * 10 - 10.75) * 2 * math.pi / 3)
    elseif name == "OutElastic" then return 2 ^ (-10 * t) * math.sin((t * 10 - 0.75) * 2 * math.pi / 3) + 1
    elseif name == "InOutElastic" then local c = 2 * math.pi / 4.5; if t < 0.5 then return -(2 ^ (20 * t - 10) * math.sin((20 * t - 11.125) * c)) / 2 else return (2 ^ (-20 * t + 10) * math.sin((20 * t - 11.125) * c)) / 2 + 1 end
    elseif name == "InBounce" then return 1 - bounceOut(1 - t)
    elseif name == "OutBounce" then return bounceOut(t)
    elseif name == "InOutBounce" then if t < 0.5 then return (1 - bounceOut(1 - 2 * t)) / 2 else return (1 + bounceOut(2 * t - 1)) / 2 end end
    return t
end
local function sample(keys, time, base, color, visible)
    if #keys == 0 then return nil end
    local previous = base
    local right, incoming = {}, {}
    for i, key in ipairs(keys) do
        right[i] = valueFor(key, base, previous, false, color)
        incoming[i] = valueFor(key, base, previous, true, color)
        previous = right[i]
    end
    if time < keys[1][1] then if visible then return base end; return right[1] end
    local index = 1
    while index < #keys and keys[index + 1][1] <= time do index = index + 1 end
    local a, b, from = keys[index], keys[index + 1], right[index]
    if not b or a[5] == "step" then return from end
    local span = b[1] - a[1]
    if span <= 0 then return from end
    local amount = ease(a[4] or "Linear", (time - a[1]) / span)
    return mix(from, incoming[index + 1], amount)
end
local function findPath(root, path)
    local object = root
    if type(path) == "table" then
        for _, name in ipairs(path) do
            if not object then return nil end
            object = object:GetChild(name)
        end
    elseif path and path ~= "" then
        for name in string.gmatch(path, "[^/]+") do
            if not object then return nil end
            object = object:GetChild(name)
        end
    end
    return object
end
local function rememberDirectBase(object, field, color)
    local id = objectId(object)
    local captured = controlledBaseFields[id]
    if not captured then captured = {}; controlledBaseFields[id] = captured end
    if captured[field] then return end
    local ok, value = pcall(function() return object[field] end)
    if not ok or value == nil then return end
    captured[field] = true
    if color then value = normalizeColor(value) end
    controlledBases[#controlledBases + 1] = { object, field, value, color }
end
local function rememberAlpha(object)
    local id = objectId(object)
    local captured = alphaBaseFields[id]
    if not captured then captured = {}; alphaBaseFields[id] = captured end
    local fields = {}
    for _, field in ipairs(colorFields) do
        local ok, packed = pcall(function() return object[field] end)
        if ok and type(packed) == "number" then
            local _, _, _, alpha = Color.ToRGBA(packed)
            if not captured[field] then
                captured[field] = true
                alphaBases[#alphaBases + 1] = { object, field, alpha }
            end
        end
    end
end
local function rememberAlphaTree(root)
    rememberAlpha(root)
    for _, child in ipairs(root:GetChildren()) do rememberAlphaTree(child) end
end
local function restoreBases()
    for _, row in ipairs(controlledBases) do
        local object, field, value, color = row[1], row[2], row[3], row[4]
        if object.alive then
            pcall(function()
                if field == "visible" then object:SetVisible(value)
                elseif color then object[field] = Color.FromRGBA(value[1], value[2], value[3], value[4])
                else object[field] = value end
            end)
        end
    end
    for _, row in ipairs(alphaBases) do
        local object, field, alpha = row[1], row[2], row[3]
        if object.alive then
            pcall(function()
                local r, g, b = Color.ToRGBA(object[field])
                object[field] = Color.FromRGBA(r, g, b, alpha)
            end)
        end
    end
end
local function initialize()
    if initialized then return end
    for _, animation in ipairs(animationData) do
        animation.bindings = {}
        animation.eventsResolved = {}
        animation.groupAlphaById = {}
        for _, track in ipairs(animation.tracks or {}) do
            local object = findPath(script.object, track[1])
            if object then
                local field, color = track[2], track[4] == "color"
                if field == "groupAlpha" then
                    animation.groupAlphaById[objectId(object)] = track[3]
                    rememberAlphaTree(object)
                else
                    rememberDirectBase(object, field, color)
                end
                local base = field == "groupAlpha" and 255 or object[field]
                if color then base = normalizeColor(base) end
                animation.bindings[#animation.bindings + 1] = { object, field, track[3], base, color, track[5] == "boolean" }
            else
                pcall(print, "look2 animation: missing control " .. tostring(track[1]))
            end
        end
        for _, event in ipairs(animation.events or {}) do
            local object = findPath(script.object, event[5])
            if object then
                local handlerTarget = event[6] and findPath(script.object, event[6].targetPath) or nil
                animation.eventsResolved[#animation.eventsResolved + 1] = { event, object, handlerTarget }
            else pcall(print, "look2 animation event: missing control " .. tostring(event[2])) end
        end
    end
    initialized = true
end
local function animationById(id)
    local wanted = tostring(id or "")
    for _, animation in ipairs(animationData) do
        if tostring(animation.id) == wanted then return animation end
    end
    return nil
end
local function applyGroupOpacity(object, inherited, active, groupAlphaById, baseAlpha)
    local keys = groupAlphaById[objectId(object)]
    local factor = inherited
    if keys then factor = clamp(tonumber(sample(keys, elapsed, 255, false, false)) or 255, 0, 255) / 255; active = true end
    if active then
        for _, field in ipairs(colorFields) do
            local ok, packed = pcall(function() return object[field] end)
            if ok and type(packed) == "number" then
                local r, g, b = Color.ToRGBA(packed)
                local originalAlpha = baseAlpha[objectId(object)] and baseAlpha[objectId(object)][field]
                object[field] = Color.FromRGBA(r, g, b, math.floor(clamp((originalAlpha or 255) * factor, 0, 255) + 0.5))
            end
        end
    end
    for _, child in ipairs(object:GetChildren()) do applyGroupOpacity(child, factor, active, groupAlphaById, baseAlpha) end
end
local function apply(time)
    if not currentAnimation then return end
    elapsed = time
    local hasGroup = false
    for _, binding in ipairs(currentAnimation.bindings) do
        local object, field = binding[1], binding[2]
        if field == "groupAlpha" then hasGroup = true
        elseif object.alive then
            local value = sample(binding[3], time, binding[4], binding[5], binding[6])
            if field == "visible" then object:SetVisible(value)
            elseif binding[5] then object[field] = Color.FromRGBA(value[1], value[2], value[3], value[4])
            else object[field] = value end
        end
    end
    if hasGroup then
        local alphaBase = {}
        for _, row in ipairs(alphaBases) do
            local id, field = objectId(row[1]), row[2]
            local fields = alphaBase[id]
            if not fields then fields = {}; alphaBase[id] = fields end
            fields[field] = row[3]
        end
        applyGroupOpacity(script.object, 1, false, currentAnimation.groupAlphaById, alphaBase)
    end
end
local function logEventError(name, message)
    pcall(print, "look2 event " .. tostring(name) .. " failed: " .. tostring(message))
end
local function invokeEventBindings(name, payload, eventObject)
    local bindings = eventBindings[name]
    if not bindings then return end
    for _, binding in ipairs(bindings) do
        local target = findPath(script.object, binding[1])
        local attached
        local ok, result = pcall(function()
            if not target or not target.alive then error("missing target " .. tostring(binding[1])) end
            local found = target:GetScriptByPath(binding[4])
            if found then return found end
            local normalized = string.gsub(tostring(binding[4]), "\\", "/")
            normalized = string.gsub(normalized, "%.lua$", "")
            normalized = string.match(normalized, "([^/]+)$") or normalized
            if normalized ~= binding[4] then return target:GetScriptByPath(normalized) end
            return nil
        end)
        if ok then attached = result else logEventError(name, result) end
        if ok and not attached then logEventError(name, "missing script " .. tostring(binding[4])) end
        if attached then
            local invoked, message = pcall(function()
                attached:Invoke(binding[3], payload, eventObject)
            end)
            if not invoked then logEventError(name, message) end
        end
    end
end
local function invokeStaticEventHandler(name, target, handler, payload, eventObject)
    if not handler then return end
    local ok, attached = pcall(function()
        if not target or not target.alive then error("missing target " .. tostring(handler.targetPath)) end
        local found = target:GetScriptByPath(handler.scriptPath)
        if found then return found end
        local normalized = string.gsub(tostring(handler.scriptPath), "\\", "/")
        normalized = string.gsub(normalized, "%.lua$", "")
        normalized = string.match(normalized, "([^/]+)$") or normalized
        if normalized ~= handler.scriptPath then return target:GetScriptByPath(normalized) end
        return nil
    end)
    if not ok then logEventError(name, attached); return end
    if not attached then
        logEventError(name, "missing script " .. tostring(handler.scriptPath))
        return
    end
    local invoked, message = pcall(function()
        attached:Invoke(handler.functionName, payload, eventObject)
    end)
    if not invoked then logEventError(name, message) end
end
local function fireEvent(entry, deferUnboundBindings)
    local event, object, handlerTarget = entry[1], entry[2], entry[3]
    if not object or not object.alive then return end
    local payload = { time = event[1], name = event[2], target = event[3], params = event[4] }
    local handler = event[6]
    if deferUnboundBindings and (handler or not eventBindings[event[2]]) then
        pendingBindingEvents[#pendingBindingEvents + 1] = { event[2], payload, object, entry }
    elseif handler then
        invokeStaticEventHandler(event[2], handlerTarget, handler, payload, object)
    else
        invokeEventBindings(event[2], payload, object)
    end
    if type(Look2OnEvent) == "function" then
        local ok, message = pcall(Look2OnEvent, payload, object)
        if not ok then logEventError(event[2], message) end
    end
end
local function dispatch(fromTime, toTime, includeStart, deferUnboundBindings)
    if not currentAnimation then return end
    for _, entry in ipairs(currentAnimation.eventsResolved) do
        local time = entry[1][1]
        if (includeStart and time >= fromTime or time > fromTime) and time <= toTime then
            fireEvent(entry, deferUnboundBindings and time == 0)
        end
    end
end
local function flushPendingBindingEvents()
    for _, row in ipairs(pendingBindingEvents) do
        local entry = row[4]
        local event = entry and entry[1]
        if event and event[6] then
            invokeStaticEventHandler(row[1], entry[3], event[6], row[2], row[3])
        elseif eventBindings[row[1]] then
            invokeEventBindings(row[1], row[2], row[3])
        end
    end
    pendingBindingEvents = {}
end
local function startAnimation(animation)
    initialize()
    if not animation then return false end
    script:EnableUpdate(false)
    playing = false
    pendingBindingEvents = {}
    restoreBases()
    currentAnimation = animation
    elapsed = 0
    apply(0)
    dispatch(0, 0, true, true)
    playing = animation.duration > 0
    script:EnableUpdate(playing)
    return true
end
function Look2BindEvent(name, targetPath, functionName, scriptPath)
    local eventName = tostring(name or "")
    local target = findPath(script.object, targetPath or "")
    local handlerName, path = tostring(functionName or ""), tostring(scriptPath or "")
    if eventName == "" or not target or handlerName == "" or path == "" then return false end
    local rows = eventBindings[eventName]
    if not rows then rows = {}; eventBindings[eventName] = rows end
    for _, row in ipairs(rows) do
        if row[1] == targetPath and row[3] == handlerName and row[4] == path then return true end
    end
    rows[#rows + 1] = { targetPath, target, handlerName, path }
    return true
end
function Look2Seek(time)
    initialize()
    if not currentAnimation then currentAnimation = animationById(defaultAnimationId) end
    if not currentAnimation then return 0 end
    elapsed = clamp(tonumber(time) or 0, 0, currentAnimation.duration)
    apply(elapsed)
    return elapsed
end
function Look2Play()
    initialize()
    if not currentAnimation then currentAnimation = animationById(defaultAnimationId) end
    return startAnimation(currentAnimation)
end
function Look2PlayById(id) return startAnimation(animationById(id)) end
function Look2PlayByName(name)
    local wanted, match, count = tostring(name or ""), nil, 0
    for _, animation in ipairs(animationData) do
        if animation.name == wanted then match = animation; count = count + 1 end
    end
    if count ~= 1 then
        pcall(print, count > 1 and ("look2 animation: ambiguous name " .. wanted) or ("look2 animation: unknown name " .. wanted))
        return false
    end
    return startAnimation(match)
end
function Look2Stop()
    initialize()
    script:EnableUpdate(false)
    playing = false
    pendingBindingEvents = {}
    elapsed = 0
    restoreBases()
    return true
end
function Look2Pause() playing = false; script:EnableUpdate(false) end
function Look2Resume()
    if not currentAnimation then currentAnimation = animationById(defaultAnimationId) end
    playing = currentAnimation ~= nil and elapsed < currentAnimation.duration
    script:EnableUpdate(playing)
    return playing
end
function OnEnable() Look2Play() end
function OnDisable() Look2Pause() end
function OnUpdate(dt)
    if not playing or not currentAnimation then return end
    flushPendingBindingEvents()
    local before = elapsed
    local after = math.min(currentAnimation.duration, elapsed + math.max(0, tonumber(dt) or 0))
    apply(after)
    dispatch(before, after, false)
    if elapsed >= currentAnimation.duration then Look2Pause() end
end
` 

function resolveEventRows(animation, roots, rowsById, existingScripts = [], controlAsset = 'client-control-template') {
  const warnings = [], eventsByRoot = new Map()
  const pathMaps = new Map()
  for (const root of roots) {
    const map = new Map()
    const visit = (node, path) => {
      if (!map.has(path.join('/'))) map.set(path.join('/'), { node, ambiguous: false })
      else map.get(path.join('/')).ambiguous = true
      for (const child of node.children || []) visit(child, [...path, child.name])
    }
    visit(root, [])
    pathMaps.set(root.id, map)
  }
  for (const event of animation.events || []) {
    const name = String(event?.name ?? '')
    const time = Number(event?.time)
    const params = event?.params == null ? '' : String(event.params)
    if (!name || name.length > 320 || !Number.isFinite(time) || time < 0 || time > Number(animation.duration) || params.length > 16384) {
      warnings.push(`动画事件 ${name || event?.id || '(未命名)'} 未导出：名称、时间或参数超出参考站点限制`)
      continue
    }
    let match
    if (event.nodeId && rowsById.has(event.nodeId)) {
      const row = rowsById.get(event.nodeId)
      match = { root: row.root, path: row.path, ambiguous: row.ambiguous }
    } else {
      const wanted = String(event.target ?? '')
      const candidates = []
      for (const root of roots) {
        const path = normalizeTargetPath(wanted, root.name)
        const row = pathMaps.get(root.id).get(path)
        if (row) candidates.push({ root, path, ...row })
      }
      if (candidates.length === 1) match = candidates[0]
      else if (candidates.length > 1) warnings.push(`动画事件 ${name} 未导出：目标 ${wanted || '(根控件)'} 在多个根控件中重名`)
    }
    if (!match) { warnings.push(`动画事件 ${name} 未导出：找不到目标控件 ${event?.target || event?.nodeId || ''}`); continue }
    if (match.ambiguous) { warnings.push(`动画事件 ${name} 未导出：目标路径中有同名控件`); continue }
    const group = eventsByRoot.get(match.root.id) || []
    const target = event?.target == null ? match.path : String(event.target)
    let handler
    if (event?.handler != null) {
      const scriptPath = String(event.handler?.scriptPath ?? '').trim()
      const functionName = String(event.handler?.functionName ?? '').trim()
      const handlerRow = event.handler?.targetNodeId ? rowsById.get(event.handler.targetNodeId) : null
      if (!scriptPath || !functionName) {
        warnings.push('动画事件 ' + name + ' 的处理器无效：scriptPath 和 functionName 不能为空')
      } else if (!handlerRow || handlerRow.root.id !== match.root.id) {
        warnings.push('动画事件 ' + name + ' 的处理器无效：处理脚本目标必须位于事件的同一模板根')
      } else if (handlerRow.ambiguous) {
        warnings.push('动画事件 ' + name + ' 的处理器无效：处理脚本目标路径中有同名控件')
      } else {
        const matches = existingScripts.filter(script => script.controlAsset === controlAsset
          && String(script.controlId || '') === String(event.handler.targetNodeId)
          && normalizeScriptPath(script.path) === normalizeScriptPath(scriptPath))
        if (matches.length === 0) {
          warnings.push('动画事件 ' + name + ' 的处理器无效：目标控件上不存在路径为 ' + scriptPath + ' 的控件脚本')
        } else if (matches.length > 1) {
          warnings.push('动画事件 ' + name + ' 的处理器无效：目标控件上有多个路径为 ' + scriptPath + ' 的客户端脚本')
        } else {
          handler = { targetPath: handlerRow.path, scriptPath, functionName }
        }
      }
    }
    group.push([time, name, target, params, match.path, group.length, handler])
    eventsByRoot.set(match.root.id, group)
  }
  for (const group of eventsByRoot.values()) group.sort((a, b) => a[0] - b[0] || a[5] - b[5])
  return { eventsByRoot, warnings }
}

export function buildAnimationScripts(project, look2, existingScripts = [], otherRoots = [], options = {}) {
  const warnings = [], scripts = []
  const sourceAnimations = Array.isArray(look2?.animations) ? look2.animations : []
  if (!sourceAnimations.length) return { scripts, warnings }

  const requestedAsset = options?.assetType ?? project.meta?.assetType
  const controlAsset = requestedAsset === 'server-control-template' || requestedAsset === 'server'
    ? 'server-control-template' : 'client-control-template'
  const roots = (project.root.children || []).filter(root => root.kind !== 'server-container')
  const nodes = new Map()
  const visit = (node, root, path, ambiguous = false) => {
    nodes.set(node.id, { node, root, path, ambiguous })
    const counts = new Map()
    for (const child of node.children || []) counts.set(child.name, (counts.get(child.name) || 0) + 1)
    for (const child of node.children || []) visit(child, root, [...path, child.name], ambiguous || counts.get(child.name) > 1)
  }
  for (const root of roots) visit(root, root, [])

  const hasRequestedId = options?.animationId !== undefined && options.animationId !== null
  const requestedId = hasRequestedId ? String(options.animationId) : null
  const defaultCandidate = hasRequestedId
    ? sourceAnimations.find(animation => String(animation.id) === requestedId)
    : sourceAnimations.find(animation => String(animation.id) === String(look2.activeAnimationId)) || sourceAnimations[0]
  if (!defaultCandidate) throw new Error('找不到要启动的动画' + (requestedId ? ': ' + requestedId : ''))

  const idCounts = new Map()
  for (const animation of sourceAnimations) {
    const id = String(animation?.id ?? '')
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1)
  }
  const validAnimations = []
  const seenIds = new Set()
  for (const animation of sourceAnimations) {
    const id = String(animation?.id ?? '')
    const name = String(animation?.name ?? '')
    if (!id) {
      warnings.push('动画 ' + (name || '(未命名)') + ' 未导出：缺少动画 ID')
      continue
    }
    if (idCounts.get(id) > 1) {
      if (!seenIds.has(id)) warnings.push('动画 ID ' + id + ' 重复，相关动画未导出')
      seenIds.add(id)
      continue
    }
    const duration = Number(animation.duration)
    if (!Number.isFinite(duration) || duration <= 0) {
      warnings.push('动画 ' + (name || id) + ' 未导出：时长必须是大于 0 的有限数值')
      continue
    }

    const groups = new Map(), acceptedTracks = [], targets = new Set()
    for (const track of animation.keyframeTracks || []) {
      const row = nodes.get(track.nodeId)
      const descriptor = FIELD_BY_KEY.get(track.fieldKey)
      const label = (row?.node.name || track.nodeId) + ' / ' + track.fieldKey
      const skip = reason => warnings.push('动画 ' + name + ' 的轨道 ' + label + ' 未导出：' + reason)
      if (!row) { skip('控件已不存在'); continue }
      if (row.ambiguous) { skip('路径中有同名兄弟控件，请先重命名'); continue }
      if (!descriptor || !supportedField(row.node, track.fieldKey, look2)) { skip('当前控件类型不支持此属性'); continue }
      const target = String(row.node.id) + '\0' + track.fieldKey
      if (targets.has(target)) { skip('同一控件属性有重复轨道'); continue }
      const keys = [...(track.keyframes || [])].sort((a, b) => Number(a.time) - Number(b.time))
      if (!keys.length) continue
      const times = []
      let invalid = false
      for (const key of keys) {
        const time = Number(key.time)
        if (!Number.isFinite(time) || time < 0 || time > duration
          || !validKeyValue(descriptor.type, key.value)
          || key.leftValue !== undefined && !validKeyValue(descriptor.type, key.leftValue)
          || !EASE_TYPES.includes(key.easeType || 'Linear')
          || !['tween', 'step'].includes(key.interpolation || 'tween')
          || descriptor.type === 'boolean' && ((key.interpolation || 'tween') !== 'step' || key.relative === true || key.leftRelative === true || key.leftValue !== undefined)
          || key.relative === true && !RELATIVE_FIELDS.has(track.fieldKey)
          || key.leftRelative === true && !RELATIVE_FIELDS.has(track.fieldKey)
          || key.isDelta === true && !RELATIVE_FIELDS.has(track.fieldKey)
          || key.leftDelta === true && !RELATIVE_FIELDS.has(track.fieldKey)) { invalid = true; break }
        if (times.some(previous => Math.abs(previous - time) <= 1e-6)) { invalid = true; break }
        times.push(time)
      }
      if (invalid) { skip('关键帧值、时间、缓动、相对类型或重复时间不受支持'); continue }
      targets.add(target)
      const luaRow = [row.path, track.fieldKey, keys.map(key => {
        const values = { 1: Number(key.time), 2: key.value, 3: key.relative === true,
          4: key.easeType || 'Linear', 5: key.interpolation || 'tween' }
        if (key.leftValue !== undefined) {
          values[6] = key.leftValue
          values[7] = key.leftRelative === true
        }
        if (key._legacyBaseDelta === true || key.isDelta === true) values.legacyBaseDelta = true
        if (key._legacyBaseLeftDelta === true || key.leftDelta === true) values.legacyBaseLeftDelta = true
        return values
      }), descriptor.type, descriptor.type === 'boolean']
      acceptedTracks.push({ track, row, luaRow })
    }

    const claims = new Map(), conflicts = new Map()
    const claim = (field, candidate) => {
      const owners = claims.get(field) || []
      owners.push(candidate)
      claims.set(field, owners)
    }
    const claimSubtreeColors = (node, candidate) => {
      for (const field of colorFieldsFor(node)) claim(String(node.id) + '\0' + field, candidate)
      for (const child of node.children || []) claimSubtreeColors(child, candidate)
    }
    for (const candidate of acceptedTracks) {
      if (candidate.track.fieldKey === 'groupAlpha') claimSubtreeColors(candidate.row.node, candidate)
      else if (COLOR_FIELDS.has(candidate.track.fieldKey)) claim(String(candidate.row.node.id) + '\0' + candidate.track.fieldKey, candidate)
    }
    for (const [field, owners] of claims) if (owners.length > 1) {
      for (const owner of owners) {
        const conflictsForOwner = conflicts.get(owner) || new Set()
        conflictsForOwner.add(field)
        conflicts.set(owner, conflictsForOwner)
      }
    }
    for (const candidate of acceptedTracks) {
      if (conflicts.has(candidate)) {
        warnings.push('动画 ' + name + ' 的轨道 ' + candidate.row.node.name + ' / ' + candidate.track.fieldKey
          + ' 未导出：组合透明度与颜色轨道覆盖同一目标字段')
        continue
      }
      const rows = groups.get(candidate.row.root.id) || []
      rows.push(candidate.luaRow)
      groups.set(candidate.row.root.id, rows)
    }

    const resolved = resolveEventRows(animation, roots, nodes, existingScripts, controlAsset)
    warnings.push(...resolved.warnings.map(message => '动画 ' + name + '：' + message))
    validAnimations.push({ id, name, duration, groups, eventsByRoot: resolved.eventsByRoot })
  }

  if (!validAnimations.some(animation => animation.id === String(defaultCandidate.id))) {
    throw new Error('默认启动动画无法编译: ' + String(defaultCandidate.name || defaultCandidate.id))
  }
  const defaultId = String(defaultCandidate.id)
  const nameCounts = new Map()
  for (const animation of validAnimations) nameCounts.set(animation.name, (nameCounts.get(animation.name) || 0) + 1)
  for (const [name, count] of nameCounts) {
    if (count > 1) warnings.push('动画名称 ' + name + ' 重复；Look2PlayByName 会拒绝此名称')
  }

  const used = collectUsedGuids(project.root)
  for (const root of otherRoots) collectUsedGuids(root, used)
  for (const entry of existingScripts) if (entry.guid) used.add(Number(entry.guid))
  for (const root of roots) {
    const rows = validAnimations.map(animation => ({
      id: animation.id,
      name: animation.name,
      duration: animation.duration,
      tracks: animation.groups.get(root.id) || [],
      events: (animation.eventsByRoot.get(root.id) || []).map(event => {
        const row = event.slice(0, 5)
        if (event[6]) row.push(event[6])
        return row
      }),
    }))
    if (!rows.some(animation => animation.tracks.length || animation.events.length)) continue
    const guid = nextFreeGuid(used)
    used.add(guid)
    let path = 'look2-animation-' + stableRootPathId(root) + '.1.lua'
    while (existingScripts.some(entry => entry.path === path)) path = 'look2-' + path
    const source = '-- look2.0 generated animation player\n'
      + '-- default animation: ' + luaString(defaultCandidate.name || defaultId) + '\n'
      + 'local animationData = ' + luaValue(rows) + '\n'
      + 'local defaultAnimationId = ' + luaString(defaultId) + '\n'
      + PLAYER
    scripts.push({ id: String(guid), guid, path, controlId: root.id, controlAsset, source })
  }

  const boundImages = [...nodes.values()].some(({ node }) => node.kind === 'image'
    && (look2.siteNodes?.[node.id]?.properties?.imageResourceId || look2.siteNodes?.[node.id]?.properties?.primitiveResourceId))
  if (boundImages) warnings.push('图片资源尚未转换为千星图元；运行时和 GIA 使用控件的 imageId。')
  return { scripts, warnings }
}
