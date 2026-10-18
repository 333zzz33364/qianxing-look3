import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createStudio } from '../studio/index.js'

const workspace = fileURLToPath(new URL('../look2-workspace/', import.meta.url))
mkdirSync(workspace, { recursive: true })
const extensions = ['save.json', 'site.json', 'gia', 'player.lua', 'controller.lua', 'host.lua', '说明.md']
let version = 1
while (extensions.some(extension => existsSync(`${workspace}融合联动示例.${version}.${extension}`))) version++
const name = `融合联动示例.${version}`
const node = (id, label, type, parentId, x, y, width, height, properties = {}) => ({
  id, name: label, type, parentId, anchorMinX: .5, anchorMinY: .5, anchorMaxX: .5, anchorMaxY: .5,
  pivotX: .5, pivotY: .5, anchorOffsetX: x, anchorOffsetY: y, sizeDeltaX: width, sizeDeltaY: height, properties,
})
const track = (id, field, values) => ({ id: `track-${id}`, nodeId: 'star', fieldKey: field,
  keyframes: values.map(([time, value], index) => ({ id: `${id}-${index}`, time, value, interpolation: 'tween', easeType: 'Linear' })) })
const studio = createStudio()
studio.importData('json', Buffer.from(JSON.stringify({ version: 12, name, frameRate: 30, nodes: [
  node('panel', '融合演示容器', 'container', null, 0, 0, 440, 360, { showCursor: true }),
  node('title', '说明标题', 'textbox', 'panel', 0, 130, 430, 60, { text: '按钮或按键 1：切换动画', fontSize: 24, horizontalAlignment: 'Middle' }),
  node('star', '动画五角星', 'image', 'panel', 0, 20, 100, 100, { imageId: 100005 }),
  node('button', '动画切换按钮', 'button', 'panel', 0, -100, 240, 55),
  node('label', '按钮文字', 'textbox', 'button', 0, 0, 240, 55, { text: '切换动画', fontSize: 22, horizontalAlignment: 'Middle', verticalAlignment: 'Middle' }),
], animations: [
  { id: 'rise', name: '上升', duration: 1, keyframeTracks: [track('rise', 'anchoredPositionY', [[0, 20], [1, 90]])],
    events: [{ id: 'mid', name: '中点', time: .5, nodeId: 'panel', target: '', params: 'rise',
      handler: { targetNodeId: 'panel', scriptPath: 'fusion/controller.lua', functionName: 'OnMidpoint' } }] },
  { id: 'turn', name: '旋转', duration: 1, keyframeTracks: [track('turn', 'localRotationZ', [[0, 0], [1, 360]])], events: [] },
], activeAnimationId: 'rise' })).toString('base64'), `${name}.site.json`)
studio.patch({ op: 'addScript', controlId: 'panel', controlAsset: 'client-control-template', path: 'fusion/controller.lua', source: '' })
studio.patch({ op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'fusion/host.lua', source: '' })
const player = studio.exportData('animation-lua', 'panel')
const controller = `local player, turn = nil, false
local function switch()
    turn = not turn
    player:Invoke("Look2PlayByName", turn and "旋转" or "上升")
end
function OnMidpoint(payload, target) print("fusion-event", payload.name, payload.params) end
function OnStart()
    player = script.object:GetScriptByPath(${JSON.stringify(player.filename.replace(/\.lua$/i, ''))})
    if not player then error("Missing generated animation player") end
    player:Invoke("Look2BindEvent", "中点", "", "OnMidpoint", "fusion/controller.lua")
    script.object:GetChild("动画切换按钮"):AddCursorEventListener(Enum.CursorEventType.CursorClick, function()
        game.ServerSignal("Fusion_Play"):SendSignal()
    end)
    script.object:AddKeyEventListener(Enum.KeyEventType.KeyboardCraftspersonKey1Down, switch)
    script:RegisterServerSignalHandler("Fusion_PlayAck", switch)
end
`
const rootGuid = studio.archiveData().assets.client.root.children[0].guid
const host = `function OnStart()
    local a = game.InstantiateClientUIControl(${rootGuid}, script.object)
    local b = game.InstantiateClientUIControl(${rootGuid}, script.object)
    a.anchoredPositionX = -260
    b.anchoredPositionX = 260
    print("fusion-instances", a ~= nil, b ~= nil)
end
`
for (const [path, source] of [['fusion/controller.lua', controller], ['fusion/host.lua', host]]) {
  studio.patch({ op: 'updateScript', id: studio.get().scripts.find(row => row.path === path).id, source })
}
studio.patch({ op: 'setServerLogic', logic: { rules: [{ id: 'fusion', signalName: 'Fusion_Play', actions: [
  { kind: 'setCustomVariable', entityType: 'PlayerSelf', name: 'LastAnimation', value: '旋转／上升' },
  { kind: 'sendClientScriptSignal', target: 'PlayerSelf', signalName: 'Fusion_PlayAck', params: [] },
] }] } })
const outputs = new Map([
  ['save.json', studio.exportData('save')], ['site.json', studio.exportData('site-json')],
  ['gia', studio.exportData('gia-combined')], ['player.lua', studio.exportData('animation-lua', 'panel')],
])
for (const [extension, exported] of outputs) writeFileSync(`${workspace}${name}.${extension}`, Buffer.from(exported.data, 'base64'), { flag: 'wx' })
writeFileSync(`${workspace}${name}.controller.lua`, controller, { flag: 'wx' })
writeFileSync(`${workspace}${name}.host.lua`, host, { flag: 'wx' })
writeFileSync(`${workspace}${name}.说明.md`, `# ${name}

打开完整 save.json，选择客户端模板试玩单个实例，或选择完整界面试玩两个模板实例。当前动画自动播放“上升”；按钮通过服务端模拟规则返回 Fusion_PlayAck 信号，再经 GetScriptByPath/Invoke 切换“旋转／上升”；按键 1 直接调用同一处理器。调试面板可查看 LastAnimation、信号与 fusion-event 日志。停止后动画、工程与历史保留编辑前状态。

站点 JSON 仅含客户端控件和动画，不能携带 Lua 或服务逻辑。完整存档保存这些内容。GIA 包带客户端与服务端控件、脚本源码及映射；导入千星时需核对播放器与 fusion/controller.lua 挂在“融合演示容器”，fusion/host.lua 挂在服务端根容器。Fusion_Play → Fusion_PlayAck 为 Look 的模拟规则，千星须按同名信号建立服务端节点图；模拟规则本身不能用 GIA 导入。单独 Lua 文件需建立脚本映射，并使用播放器的原路径 ${player.filename}。千星实机尚未验证。
`, { flag: 'wx' })
console.log(`${name}: ${extensions.length} files`)
