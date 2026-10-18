import { importPsd, importSpine } from './look2-assets.js'
import { sampleTrack, EASE_TYPES, TWEENABLE_FIELDS } from '../studio/look2/sampling.js'
import { previewAnimation } from '../studio/look2/preview.js'
import { createPrimitivePreviewSource } from './primitive-preview.js'
import { applyStageImageMask, stageMaskKey } from './stage-image-mask.js'
import { createResourcesPanel } from './look2-resources.js'
import { createDraftCache } from './draft-cache.js'
import { commitInputDraft, createInputDraft } from './input-draft.js'
import { preparePlatformTransformEdit } from './platform-transform-edit.js'
import { inspectorTransformChannels, setAbsoluteKeyframeValue, setTransformTrackValue, transformTrackValue, TRANSFORM_TRACK_PATHS } from './field-groups.js'
import { applyInspectorToTransform, applyMatrix, computeRect, identityMatrix, invertMatrix, localRectMatrix, setAnchorPreset } from '../studio/ui/layout.js'
import { layoutTree } from '../studio/ui/inspector.js'
import { projectCanvas } from '../studio/ui/canvas.js'
import { REFERENCE_THEME, editorIcon } from './look2-theme.js'
import { describeEditorError, emptyErrorLog, ERROR_LOG_CSS, loadErrorLog, saveErrorLog, updateErrorLog } from './error-log.js'
import { buildPlayLog, canStopInlinePlay, playLogFilename, playTargetGuide } from './play-log.js'
import { normalizeImageMeta, rasterizeSlices, supportsImageStretch } from '../studio/assets/image-stretch.js'

const PLAY_TARGET_GUIDE = playTargetGuide()
const playHelpTitle = `${PLAY_TARGET_GUIDE.full.label}：${PLAY_TARGET_GUIDE.full.detail}\n${PLAY_TARGET_GUIDE.template.label}：${PLAY_TARGET_GUIDE.template.detail}\n${PLAY_TARGET_GUIDE.difference}`

const LOOK2_USAGE_STEPS = [
  '左侧控件树：「+ 添加控件」新建控件，单击行选择控件，也可在画布上双击选中。',
  '中间画布：拖动控件摆放，用底部工具条移动／旋转／缩放；右上角可切换画布尺寸与缩放比例。',
  '右侧属性面板：「基础」改位置、大小、状态，「运行时」查看运行字段，「脚本」挂载 Lua 脚本。',
  '底部时间轴：双击空白添加关键帧，拖动菱形调整时间；右键属性轨道可添加关键帧或事件。',
  '右上角「试玩」：选择试玩目标（完整界面／当前模板）后点「▶ 试玩」预览，Esc 退出全屏。',
  '调试面板：查看运行日志、设置运行变量、发送服务端信号，并可「导出试玩日志」。',
  '保存与导出：顶部「保存」把当前工程写入工作区；「导入 / 导出」下拉可选 JSON、GIA、完整存档等格式。',
]

// Plan a group drag before touching the archive. Clamp the shared offset rather
// than every key separately, preserving spacing at the animation boundaries.
export function planKeyframeDrag(animation, selectedKeys, requestedDelta, duration, frameRate, snapEnabled) {
  const selected = new Map()
  for (const item of selectedKeys || []) {
    if (!selected.has(item.trackId)) selected.set(item.trackId, new Set())
    selected.get(item.trackId).add(item.keyId)
  }
  const moving = (animation?.keyframeTracks || []).flatMap(track =>
    (track.keyframes || []).filter(key => selected.get(track.id)?.has(key.id))
      .map(key => ({ trackId: track.id, keyId: key.id, time: Number(key.time) })))
  if (!moving.length || !Number.isFinite(requestedDelta) || !Number.isFinite(duration) || duration <= 0) return { moves: [], shift: 0 }
  const minTime = Math.min(...moving.map(item => item.time))
  const maxTime = Math.max(...moving.map(item => item.time))
  let shift = Math.max(-minTime, Math.min(duration - maxTime, requestedDelta))
  if (snapEnabled && Number.isFinite(frameRate) && frameRate > 0) shift = Math.round(shift * frameRate) / frameRate
  shift = Math.max(-minTime, Math.min(duration - maxTime, shift))
  if (Math.abs(shift) < .00001) return { moves: [], shift: 0 }
  const moves = moving.map(item => ({ ...item, nextTime: Number((item.time + shift).toFixed(4)) }))
  const byTrack = new Map()
  for (const move of moves) {
    if (!byTrack.has(move.trackId)) byTrack.set(move.trackId, new Map())
    byTrack.get(move.trackId).set(move.keyId, move.nextTime)
  }
  for (const track of animation.keyframeTracks || []) {
    if (!byTrack.has(track.id)) continue
    const times = (track.keyframes || []).map(key => byTrack.get(track.id).get(key.id) ?? Number(key.time)).sort((a, b) => a - b)
    if (times.some((time, i) => !Number.isFinite(time) || time < 0 || time > duration + .00001
      || i > 0 && time - times[i - 1] < .0001)) {
      return { moves: [], shift: 0, error: '关键帧移动会产生同轨重叠或越界，操作已取消' }
    }
  }
  return { moves, shift }
}

// Timeline events fire only as playback crosses them. Stable ordering makes
// simultaneous events deterministic; seeking never calls this collector.
export function collectCrossedAnimationEvents(events, from, to, includeStart = false) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  return (events || []).map((event, index) => ({ event, index, time: Number(event.time) }))
    .filter(({ time }) => Number.isFinite(time) && (time > from || includeStart && time === from) && time <= to)
    .sort((left, right) => left.time - right.time || left.index - right.index)
    .map(({ event }) => event)
}

export function appendAnimationEventLog(rows, crossed, at, limit = 50) {
  if (!crossed.length) return rows
  return [...rows, ...crossed.map(event => ({ ...event, at }))].slice(-limit)
}

// Workspace saves live at the root; nested acceptance/repair folders are listed
// separately so the open-archive dropdown is not mixed with test output.
export function groupWorkspaceArchives(archives = []) {
  const root = []
  const other = []
  for (const entry of archives) (String(entry?.path || '').includes('/') ? other : root).push(entry)
  return { root, other }
}

export function createAnimationView(React, { api, playUrl, InlinePlay, usePlayLauncher, WorkspaceInspector, WorkspaceDock }) {
  const h = React.createElement
  const icon = (name, size) => editorIcon(h, name, size)
  function DraftInput({ value, type = 'text', rows, min, max, step, disabled, ariaLabel, title, onCommit, onDiscardError, readCommitted, inputStyle, wrapperStyle }) {
    const initial = value == null ? '' : String(value)
    const [draft, setDraft] = React.useState(initial)
    const [failed, setFailed] = React.useState(false)
    const draftRef = React.useRef(null)
    const discardErrorRef = React.useRef(onDiscardError)
    discardErrorRef.current = onDiscardError
    if (!draftRef.current) draftRef.current = createInputDraft(initial, { onDiscardError: reason => discardErrorRef.current?.(reason) })
    const latestPropRef = React.useRef(initial)
    latestPropRef.current = initial
    React.useEffect(() => {
      const synced = draftRef.current.sync(initial)
      if (synced.changed) setDraft(synced.value)
    }, [initial])
    const submit = async (submitted = draftRef.current.value) => {
      const result = await commitInputDraft(draftRef.current, async rawValue => {
        const parsed = type === 'number' ? Number(rawValue) : rawValue
        const response = await onCommit(parsed)
        const committed = readCommitted ? readCommitted(response, parsed) : parsed
        return committed == null ? '' : String(committed)
      }, submitted)
      if (!result.ok) {
        if (result.current) setFailed(true)
      } else if (result.changed) {
        setDraft(result.value)
        setFailed(false)
      }
    }
    const retry = failed && draftRef.current.dirty
      ? h('button', {
        className: 'mini', type: 'button',
        onMouseDown: event => event.preventDefault(),
        onClick: event => { event.preventDefault(); event.stopPropagation(); void submit(draftRef.current.value) },
      }, '重试')
      : null
    const inputProps = {
      value: draft,
      disabled: !!disabled,
      'aria-label': ariaLabel,
      title,
      style: inputStyle,
      onChange: event => {
        setDraft(draftRef.current.edit(event.target.value))
        setFailed(false)
      },
      onBlur: () => { if (draftRef.current.dirty) void submit(draftRef.current.value) },
      onKeyDown: event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(draftRef.current.reset(latestPropRef.current))
          setFailed(false)
        }
      },
    }
    if (type === 'number') { inputProps.min = min; inputProps.max = max; inputProps.step = step }
    const input = rows
      ? h('textarea', { ...inputProps, rows })
      : h('input', { ...inputProps, type })
    return h('div', { className: 'look2-draft-input', style: { display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, width: rows ? '100%' : undefined, ...wrapperStyle } }, input, retry)
  }
  const STYLE_ID = 'look2-animation-style'
  const { ResourcesPanel } = createResourcesPanel(React)
  const CSS = `
.look2{--bg:#171a20;--panel:#20242c;--panel2:#292e38;--line:#363d49;--line2:#2d333d;--text:#e7eaf0;--muted:#929baa;--blue:#5c95ef;display:flex;position:relative;flex-direction:column;width:100%;height:100%;min-height:0;color:var(--text);background:var(--bg);font:12px/1.35 Inter,'Microsoft YaHei UI',sans-serif;overflow:hidden}
.look2 *{box-sizing:border-box}.look2 button,.look2 input,.look2 select,.look2 textarea{font:inherit}.look2 button{color:inherit;border:1px solid var(--line);border-radius:4px;background:var(--panel2);cursor:pointer}.look2 button:hover{border-color:var(--blue);background:#343c49}.look2 button:disabled{opacity:.4;cursor:default}.look2 input,.look2 select,.look2 textarea{color:var(--text);border:1px solid var(--line);border-radius:4px;background:#171a20;min-width:0}.look2 input[type=number]{width:68px;padding:3px 5px}.look2 input[type=text],.look2 textarea{padding:4px 6px}.look2 select{padding:4px 6px}.look2 button{padding:4px 7px}.look2 .spacer{flex:1}.look2 .tool-select{width:auto;max-width:130px}.look2 .tool-group{display:flex;align-items:center;gap:3px;padding:0 4px;border-right:1px solid #454b56}.look2 .tool-group:last-child{border:0}.look2 .primary{background:#315b99;border-color:#5590ed}
.look2-top{display:flex;align-items:center;gap:4px;min-height:39px;height:39px;flex:0 0 39px;padding:4px 8px;border-bottom:1px solid var(--line);background:#22262e;white-space:nowrap}.look2-top strong{font-size:14px;margin-right:6px;white-space:nowrap}.look2-top .file-name{width:116px}.look2-sub{display:flex;align-items:center;gap:5px;padding:4px 9px;border-bottom:1px solid var(--line);background:#1c2027;min-height:29px}.look2-sub .selected{color:#fff;background:#315b99;border-color:#5793ef}.look2-status{padding:3px 9px;color:var(--muted);border-bottom:1px solid var(--line);height:23px;min-height:23px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.look2-status.error{color:#ffa5a5}
.look2-main{display:grid;grid-template-columns:var(--tree-width,252px) minmax(220px,1fr) var(--anim-width,192px) var(--inspector-width,306px);flex:1;min-height:0;overflow:hidden}.look2-pane{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line);background:var(--panel);overflow:hidden}.look2-pane:last-child{border-right:0;border-left:1px solid var(--line)}.look2-pane.collapsed{width:28px}.look2-pane-head{display:flex;align-items:center;justify-content:space-between;gap:5px;min-height:33px;height:33px;padding:4px 7px;border-bottom:1px solid var(--line);font-weight:600;white-space:nowrap}.look2-pane-head .head-title{overflow:hidden;text-overflow:ellipsis}.look2-scroll{flex:1;overflow:auto;scrollbar-color:#505864 #20242c;scrollbar-width:thin}.look2-tree-tools{display:flex;gap:4px;padding:5px;border-bottom:1px solid var(--line2)}.look2-tree-tools input{width:100%;height:26px}.look2-tree-row{display:flex;align-items:center;gap:3px;width:100%;height:25px;padding:2px 5px;border:0!important;border-radius:0!important;background:transparent!important;text-align:left;white-space:nowrap;overflow:hidden}.look2-tree-row.sel{background:#2a4264!important}.look2-tree-row.drag-over{box-shadow:inset 0 0 0 1px var(--blue)}.look2-tree-row .tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.look2-tree-row .tree-action{width:20px;height:20px;padding:0;border:0;background:transparent;font-size:11px;color:var(--muted)}.look2-tree-row.hidden-node .tree-name{opacity:.42;text-decoration:line-through}.look2-tree-row.locked-node .tree-name{color:#dbb766}.look2-add{display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:5px;border-top:1px solid var(--line)}.look2-add button{font-size:10px;padding:3px 4px}
.look2-resize-x{width:4px;cursor:col-resize;background:transparent;z-index:2}.look2-resize-x:hover{background:#548cf066}.look2-stage-wrap{position:relative;display:flex;flex:1 1 auto;align-items:center;justify-content:center;min-width:0;min-height:0;overflow:hidden;background:#2a2f38;background-image:radial-gradient(#ffffff10 .65px,transparent .65px);background-size:8px 8px;touch-action:none}.look2-stage{position:absolute;left:50%;top:50%;flex:none;overflow:hidden;border:1px solid #70849b;background:#1b2631;box-shadow:0 7px 25px #0008;touch-action:none;transform:translate(calc(-50% + var(--pan-x,0px)),calc(-50% + var(--pan-y,0px)))}.look2-stage:before{content:'';position:absolute;left:50%;top:0;bottom:0;border-left:1px dashed #ffffff1c;pointer-events:none}.look2-stage:after{content:'';position:absolute;top:50%;left:0;right:0;border-top:1px dashed #ffffff1c;pointer-events:none}.look2-box{position:absolute;display:grid;place-items:center;border:1px solid #9baabb85;background:#69a5ff20;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;cursor:move}.look2-box.container{background:#69a5ff08;border-style:dashed}.look2-box.textbox,.look2-box.textwindow{color:white;background:#263950}.look2-box.image{background:#528dc445}.look2-box.sel{border-color:#66b4ff}.look2-box span{font-size:10px;max-width:100%;overflow:hidden;text-overflow:ellipsis;background:#111a23a8;padding:1px 3px;pointer-events:none}.look2-stage-bones{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}.look2-bone{stroke:#e5bc62;stroke-width:1.2;fill:none;opacity:.68}.look2-gizmo{position:absolute;z-index:4;border:1px solid #83c4ff;box-shadow:0 0 0 1px #16202a;pointer-events:none}.look2-gizmo.rotated{transform-origin:top left}.look2-handle{position:absolute;width:8px;height:8px;border:1px solid #f2f7ff;border-radius:2px;background:#3990ec;pointer-events:auto;touch-action:none}.look2-handle.nw{left:-4px;top:-4px;cursor:nwse-resize}.look2-handle.n{left:50%;top:-4px;transform:translateX(-50%);cursor:ns-resize}.look2-handle.ne{right:-4px;top:-4px;cursor:nesw-resize}.look2-handle.e{right:-4px;top:50%;transform:translateY(-50%);cursor:ew-resize}.look2-handle.se{right:-4px;bottom:-4px;cursor:nwse-resize}.look2-handle.s{left:50%;bottom:-4px;transform:translateX(-50%);cursor:ns-resize}.look2-handle.sw{left:-4px;bottom:-4px;cursor:nesw-resize}.look2-handle.w{left:-4px;top:50%;transform:translateY(-50%);cursor:ew-resize}.look2-rotate-handle{position:absolute;left:50%;top:-24px;width:8px;height:8px;border:1px solid white;border-radius:50%;background:#f08f5b;pointer-events:auto;cursor:crosshair}.look2-gizmo-line{position:absolute;left:50%;top:-17px;height:13px;border-left:1px solid #83c4ff}
.look2-inspector{padding:4px 8px;overflow:auto}.look2-inspector-tabs{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--line)}.look2-inspector-tabs button{border:0;border-radius:0;background:transparent;color:var(--muted);padding:6px}.look2-inspector-tabs button.active{color:#fff;border-bottom:2px solid var(--blue)}.look2-field{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:5px 0;min-height:26px}.look2-field label{color:var(--muted);font-size:11px}.look2-field input[type=text]{width:150px}.look2-field input[type=checkbox]{width:15px;height:15px}.look2-field input[type=color]{width:32px;height:24px;padding:1px}.look2-field select{max-width:165px}.look2-inspector h3{font-size:11px;margin:11px 0 4px;padding:4px 0;border-bottom:1px solid var(--line2);color:#c5ccd7}.look2-field.wide{align-items:flex-start;flex-direction:column}.look2-field.wide input,.look2-field.wide textarea{width:100%}.look2-animations button{display:block;width:100%;margin:2px 0;text-align:left}.look2-animations button.sel{background:#315b99;border-color:#6096ed}.look2-anim-row{display:flex;align-items:center;gap:3px}.look2-anim-row>button:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.look2-anim-row .mini{padding:3px 5px}
.look2-timeline{height:209px;min-height:132px;max-height:60%;display:flex;flex:0 0 auto;flex-direction:column;border-top:1px solid var(--line);background:#1d2128}.look2-timeline-resize{height:4px;cursor:row-resize;background:#252b34}.look2-timeline-resize:hover{background:#548cf066}.look2-timeline-top{display:flex;align-items:center;gap:5px;height:31px;min-height:31px;padding:3px 8px;border-bottom:1px solid var(--line)}.look2-timeline-top input[type=range]{width:110px}.look2-timeline-top input.timeline-seek{flex:1}.look2-time-readout{width:56px;text-align:center;color:#c8d1df;font-variant-numeric:tabular-nums}.look2-timeline-body{display:flex;flex:1;min-height:0;overflow:hidden}.look2-timeline-names{flex:0 0 230px;overflow:auto;border-right:1px solid var(--line);scrollbar-width:thin}.look2-timeline-scroll{flex:1;min-width:0;overflow:auto;position:relative;scrollbar-width:thin}.look2-ruler-row,.look2-event-row,.look2-track{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:25px;border-bottom:1px solid #303640}.look2-ruler-row{height:24px;min-height:24px}.look2-ruler-name,.look2-track-name{position:sticky;left:0;z-index:2;display:flex;align-items:center;gap:5px;padding:2px 6px;border-right:1px solid var(--line);background:#20242c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.look2-ruler-lane,.look2-track-lane,.look2-event-lane{height:25px;position:relative;background-color:#1b1f26}.look2-ruler-lane{height:24px;background-image:repeating-linear-gradient(90deg,transparent 0,transparent calc(var(--minor-step) - 1px),#343b45 calc(var(--minor-step) - 1px),#343b45 var(--minor-step))}.look2-ruler-mark{position:absolute;top:0;height:100%;border-left:1px solid #667181;color:#aab3c0;font-size:9px;padding:1px 3px}.look2-track-lane{height:25px;background-image:repeating-linear-gradient(90deg,transparent 0,transparent calc(var(--minor-step) - 1px),#303640 calc(var(--minor-step) - 1px),#303640 var(--minor-step))}.look2-track{min-height:25px}.look2-track-name{font-size:10px}.look2-track-name select{max-width:100px;padding:2px;font-size:10px}.look2-track-lane .look2-key{position:absolute;top:3px;transform:translateX(-50%);width:15px;height:17px;padding:0!important;border:0!important;background:transparent!important;color:#e7bf5b!important;font-size:13px!important;z-index:1}.look2-key.sel{color:#fff!important;text-shadow:0 0 6px #79baff}.look2-key.multi{color:#72c8ff!important}.look2-event-lane{background-image:repeating-linear-gradient(90deg,transparent 0,transparent calc(var(--minor-step) - 1px),#303640 calc(var(--minor-step) - 1px),#303640 var(--minor-step))}.look2-event-dot{position:absolute;top:3px;transform:translateX(-50%);color:#de8df6!important;border:0!important;background:transparent!important;padding:0!important}.look2-playhead{position:absolute;z-index:5;top:0;bottom:0;width:1px;background:#fc654d;pointer-events:none;box-shadow:0 0 4px #ff765b}.look2-key-editor{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:4px 8px;border-top:1px solid var(--line);min-height:35px}.look2-key-editor input[type=number]{width:70px}.look2-key-editor input[type=text]{width:115px}.look2-key-editor .color-value{display:flex;align-items:center;gap:3px}.look2-key-editor input[type=color]{width:28px;height:22px;padding:1px}.look2-event-editor{display:grid;grid-template-columns:80px 1fr 1fr 1fr auto;gap:5px;padding:4px 8px;border-top:1px solid var(--line)}.look2-event-log{position:absolute;right:8px;bottom:8px;z-index:6;max-width:300px;max-height:100px;overflow:auto;background:#10151bdc;border:1px solid var(--line);border-radius:4px;padding:4px 7px;font:10px/1.4 ui-monospace,monospace}
.look2-modal-backdrop{position:absolute;inset:0;z-index:20;display:grid;place-items:center;background:#080b12bc}.look2-modal{width:min(860px,95vw);height:min(610px,85vh);display:flex;flex-direction:column;background:#20242c;border:1px solid #515d70;border-radius:7px;box-shadow:0 20px 55px #000b}.look2-modal.lua-import{width:min(460px,92vw);height:auto;max-height:85vh}.look2-modal header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);min-height:38px}.look2-modal header .spacer{flex:1}.look2-resource-body{display:grid;grid-template-columns:230px 1fr;min-height:0;flex:1}.look2-context-menu{position:fixed;z-index:50;min-width:160px;max-height:75vh;overflow:auto;padding:4px;background:#252b35;border:1px solid #5c6675;border-radius:5px;box-shadow:0 8px 24px #0009}.look2-context-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;border-radius:2px;padding:5px 8px}.look2-context-menu button:hover{background:#34465f}.look2-history-list,.look2-template-list{min-height:0;overflow:auto;padding:8px}.look2-history-row,.look2-template-row{display:flex;align-items:center;gap:6px;padding:5px;border-bottom:1px solid var(--line2)}.look2-history-row button:first-child,.look2-template-row button:first-child{flex:1;text-align:left}.look2-template-row input{width:64px}.look2-modal form{padding:10px}
@media(max-width:1050px){.look2-main{grid-template-columns:min(var(--tree-width,252px),210px) minmax(0,1fr) min(var(--anim-width,192px),160px) min(var(--inspector-width,306px),240px)}.look2-timeline-names{flex-basis:190px}.look2-ruler-row,.look2-event-row,.look2-track{grid-template-columns:190px minmax(0,1fr)}}@media(max-width:760px){.look2-main{grid-template-columns:min(var(--tree-width,252px),34px) minmax(0,1fr) min(var(--anim-width,192px),34px) min(var(--inspector-width,306px),230px)}.look2-main .look2-pane.collapsed{width:100%}.look2-top{overflow:auto}.look2-inspector-pane{position:absolute;right:0;top:68px;bottom:0;width:min(270px,100%);z-index:8;box-shadow:-8px 0 22px #0008}}
nav[aria-label="look2.0 工作区"]{position:relative!important;flex:0 0 54px!important;height:54px!important;margin:10px 10px!important;padding:0 10px!important;gap:0!important;overflow:hidden;background:#eeedff!important;color:#fff!important;border:0!important;border-radius:8px!important}.look2+*{}nav[aria-label="look2.0 工作区"]:before{content:'✨ 客户端 UI 动画编辑器';position:absolute;left:65px;right:250px;top:0;height:54px;display:flex;align-items:center;padding:0 20px;border-radius:10px;background:linear-gradient(105deg,#676be0,#516be5 55%,#00b9ec);box-shadow:0 2px 8px #676be766;color:#fff;font-size:20px;font-weight:700;pointer-events:none}nav[aria-label="look2.0 工作区"] button:first-child{width:55px!important;height:54px!important;padding:0!important;border:0!important;border-radius:8px!important;background:#9587e9!important;color:#fff!important;font-size:0!important}nav[aria-label="look2.0 工作区"] button:first-child:before{content:'☰';font-size:26px}nav[aria-label="look2.0 工作区"] button:nth-child(2){position:absolute;right:78px;top:7px;height:40px;background:#fff!important;border:1px solid #dad9e8!important;border-radius:7px!important;color:#333a4a!important;font-size:11px!important;padding:0 11px!important;z-index:1}nav[aria-label="look2.0 工作区"] button:nth-child(2):after{content:'  ↗'}nav[aria-label="look2.0 工作区"] span{position:absolute;right:10px;top:17px;margin:0!important;color:#333a4a!important;font-size:11px}.look2{margin:0 10px 10px!important;width:auto!important;height:auto!important;flex:1 1 auto!important;border-radius:0 0 7px 7px}.look2-top{height:48px;min-height:48px;flex-basis:48px;padding:5px 8px;background:#292e37}.look2-top strong{display:none}.look2-sub:has(button){flex:0 0 auto}.look2-status{height:0;min-height:0;padding:0;border:0;overflow:hidden;flex:0 0 0}.look2-main{min-height:240px}.look2-pane{position:relative}.look2-pane.collapsed{justify-content:flex-start}.look2-pane.collapsed .look2-pane-head{justify-content:center;padding:2px}.look2-stage-column{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line)}.look2-stage-tools{display:flex;align-items:center;gap:5px;height:27px;min-height:27px;padding:3px 8px;background:#252a33;border-top:1px solid var(--line);font-size:10px;color:#aab4c1}.look2-stage-tools button{padding:2px 5px;font-size:10px}.look2-stage-tools .active{color:#fff;background:#355d9a}.look2-tree-toolbar{display:flex;align-items:center;gap:4px}.look2-tree-toolbar button{padding:2px 5px}.look2-track-group{display:grid;align-items:center;height:22px;min-height:22px;padding:0;border-bottom:1px solid #343a45;background:#272d37;color:#aeb8c6;font-size:10px}.look2-track-group button{border:0;background:transparent;padding:1px 6px;color:inherit;text-align:left}.look2-ruler-mark.major{border-left-color:#8793a4;color:#d0d7e1}.look2-timeline{height:var(--timeline-height,209px);min-height:145px;max-height:none;border-top:0;flex-basis:var(--timeline-height,209px)}.look2-timeline-resize{flex:0 0 4px}.look2-timeline-top{height:39px;min-height:39px;background:#242a33}.look2-timeline-body{display:grid;grid-template-columns:minmax(0,1fr) 223px}.look2-timeline-scroll{height:100%}.look2-key-inspector{min-width:0;overflow:auto;border-left:1px solid var(--line);padding:5px 8px;background:#232832}.look2-key-inspector h4{margin:1px 0 5px;color:#e1e7ef;font-size:10px}.look2-key-inspector .look2-field{min-height:22px;margin:3px 0}.look2-key-inspector .look2-field label{font-size:10px}.look2-key-inspector .look2-field input[type=number]{width:85px}.look2-event-editor{grid-template-columns:1fr;max-height:130px;overflow:auto}.look2-event-editor input,.look2-event-editor select,.look2-event-editor textarea{width:100%}.look2-event-log{bottom:4px;left:240px;right:auto}.look2-modal header .spacer{flex:1}.look2-modal .modal-content{min-height:0;flex:1;overflow:auto}.look2-modal .look2-field{padding:0 10px}.look2-modal .look2-field input[type=text]{width:250px}
 .look2-platform-picker{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;margin:4px 0 8px}.look2-platform-picker button{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;padding:3px 1px}.look2-platform-picker button.selected{background:#315b99;border-color:#5c95ef;color:#fff}.look2-platform-picker button span{font-size:15px;line-height:18px;background:transparent;padding:0}.look2-platform-picker button small{font-size:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.look2-platform-transform{margin-top:10px;padding-top:5px;border-top:1px solid var(--line2)}.look2-platform-transform.look2-platform-compact{margin-top:0;padding-top:0;border-top:0}.look2-platform-transform>small{display:block;color:var(--muted);margin-bottom:6px}.look2-platform-value{display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;gap:5px;margin:4px 0}.look2-platform-value>label{color:var(--muted);font-size:10px}.look2-platform-axes{display:grid;gap:3px}.look2-platform-axes label{display:flex;align-items:center;gap:2px;min-width:0}.look2-platform-axes label small{color:var(--muted);font-size:9px}.look2-platform-axes input{width:100%;min-width:0;padding:3px 4px}.look2-stage-coordinates{color:#d0d9e6;font-variant-numeric:tabular-nums}
.look2-stage-visual{position:absolute;inset:0;overflow:hidden;pointer-events:none;user-select:none}.look2-stage-image-mask{position:absolute;inset:0;overflow:hidden}.look2-stage-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain;pointer-events:none}.look2-stage-text{position:absolute;inset:0;display:flex;box-sizing:border-box;overflow:hidden;padding:2px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:none;pointer-events:none}.look2-mask-guides{position:absolute;inset:4%;border:1px dashed #f6d06c;pointer-events:none}.look2-mask-guides.reverse{border-color:#ff8d8d;background:repeating-linear-gradient(135deg,#ff8d8d18 0 4px,transparent 4px 9px)}.look2-mask-guides:after{content:attr(data-label);position:absolute;right:2px;top:2px;padding:1px 3px;border-radius:2px;background:#121820bf;color:#f6d06c;font:8px/1.2 sans-serif}.look2-box .look2-image-placeholder{position:absolute;inset:0;display:grid;place-items:center;color:#e4c477;font-size:10px;text-align:center;background:repeating-conic-gradient(#343b45 0% 25%,#262d36 0% 50%) 50%/12px 12px;overflow:hidden}.look2-stage-defs{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
  .look2-box{display:block;place-items:unset;border:0;background:transparent;overflow:visible;white-space:normal;text-overflow:clip}
  .look2-box.container,.look2-box.textbox,.look2-box.textwindow,.look2-box.image{border:0;background:transparent;color:inherit}
  .look2-box.sel{border:0;z-index:auto}
  .look2-stage-subtree{position:absolute;inset:0;overflow:visible}
  .look2-box-backdrop{position:absolute;inset:0;background:#69a5ff20;pointer-events:none}
  .look2-box-backdrop.container{background:#69a5ff08}
  .look2-box-backdrop.textbox,.look2-box-backdrop.textwindow{background:#263950}
  .look2-box-backdrop.image{background:#528dc445}
  .look2-box-content{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;user-select:none}
  .look2-box-outline{position:absolute;inset:0;border:1px solid #9baabb85;pointer-events:none}
  .look2-box.container .look2-box-outline{border-style:dashed}
  .look2-box.sel .look2-box-outline{border-color:#66b4ff}
  .look2{margin:0!important;width:100%!important;height:100%!important;flex:1 1 auto!important;border-radius:0!important}
  .look2-top{height:auto;min-height:48px;flex-basis:auto;flex-wrap:wrap;overflow-x:auto;overflow-y:hidden}
  .look2-top strong{display:block!important}
  .look2-asset-switch{display:grid;grid-template-columns:1fr 1fr;gap:2px;margin:4px 5px;padding:2px;border:1px solid var(--line);border-radius:15px;background:#171a20}
  .look2-asset-switch button{min-width:0;padding:3px 5px;border:0;border-radius:12px;background:transparent;color:var(--muted);font-size:10px;white-space:nowrap}
  .look2-asset-switch button.active{background:#3569cf;color:#fff}
  .look2-dock{height:var(--timeline-height,209px);min-height:150px;max-height:60%;display:flex;flex:0 0 auto;flex-direction:column;border-top:1px solid var(--line);background:#1d2128}
  .look2-dock:fullscreen{width:100vw;height:100vh;min-height:0;max-height:none;flex:none;color:#e1e7ef;background:#1d2128}.look2-dock:fullscreen>.look2-timeline-resize{display:none}
  .look2-dock-tabs{height:32px;min-height:32px;display:flex;align-items:stretch;gap:2px;padding:2px 6px;border-bottom:1px solid var(--line);background:#242a33}
  .look2-dock-tabs button{min-width:64px;padding:0 10px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--muted)}
  .look2-dock-tabs button.active{border-bottom-color:var(--blue);color:var(--text);background:#5c95ef14}
  .look2-dock-content{flex:1;min-height:0;display:flex;overflow:hidden}
  .look2-dock-content>.look2-timeline-body{flex:1;min-height:0}
  .look2-sync-panels{flex:1;min-width:0;color:var(--text)}
  .look2-guid-editor{margin:6px 0 8px;padding:8px;border:1px solid var(--line);border-radius:5px;background:#1c2027}
  .look2-guid-editor>strong{font-size:11px;color:#c5ccd7}
  .look2-guid-note{margin:5px 0;padding:5px;border-radius:4px;background:#242a33;color:var(--muted);font-size:10px;line-height:1.4;overflow-wrap:anywhere}
  .look2-guid-note.error{color:#ff9a9a}
  .look2-runtime-debug{display:grid;grid-template-columns:minmax(220px,1fr) minmax(220px,1fr);gap:8px;width:100%;min-height:0;overflow:auto;padding:9px;background:var(--workspace)}
  .look2-debug-card{min-width:0;overflow:auto;padding:9px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
  .look2-debug-card h3{margin:0 0 7px;font-size:12px}
  .look2-debug-card pre{max-height:220px;overflow:auto;margin:5px 0;padding:7px;background:#151920;border-radius:4px;color:#c8d2df;font:10px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
  .look2-debug-row{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:5px 0}
  .look2-debug-row input,.look2-debug-row select{min-width:0;flex:1 1 90px}
  .look2-play-config{display:flex;align-items:center;gap:4px;flex:0 0 auto}
  .look2-play-config label{font-size:10px;color:var(--muted)}
  .look2-play-config select{max-width:125px}
  .look2-top .play-group{padding-left:5px;border-left:1px solid var(--line)}
  .look2-workspace{display:flex;flex-direction:column;gap:6px;padding:7px 9px;border-bottom:1px solid var(--line);background:#1c2027}
  .look2-workspace-row{display:flex;align-items:center;gap:6px;min-width:0}
  .look2-workspace-row>span{flex:0 0 auto;color:var(--muted);font-size:11px}
  .look2-workspace-row .file-name{flex:1 1 200px;min-width:120px}
  .look2-workspace-row .look2-archive-select{flex:0 1 560px;min-width:180px}
  .look2-workspace-row .look2-danger{color:#ffb4b4;border-color:#7d4a4a;background:#3a2a2e}
  .look2-workspace-row .look2-danger:hover{border-color:#a25a5a;background:#4a3034}
  .look2-archive-filter{display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:11px;white-space:nowrap;cursor:pointer}
  .look2-archive-filter input{width:14px;height:14px}
  .look2-usage{border:1px solid var(--line);border-radius:6px;background:#20242c;padding:0 10px}
  .look2-usage>summary{cursor:pointer;padding:6px 0;color:var(--text);font-size:12px;font-weight:600}
  .look2-usage-list{margin:0 0 9px;padding-left:20px;color:var(--muted);font-size:11px;line-height:1.75}
  .look2-empty-inspector{padding:18px 10px;color:var(--muted);text-align:center}
  .look2.playing .look2-pane,.look2.playing .look2-stage-tools,.look2.playing .look2-timeline,.look2.playing .look2-top .tool-group:not(.play-group){pointer-events:none;opacity:.55}
  .look2.playing .look2-dock-tabs{pointer-events:auto;opacity:1}
  .look2.playing .look2-stage-column{pointer-events:auto}
  .look2-dock-readonly{display:flex;flex:1;min-width:0;min-height:0;margin:0;padding:0;border:0;overflow:hidden}
  .look2-dock-readonly>div{flex:1;min-width:0;min-height:0;max-height:100%;overflow:auto}
  .look2-static-note{padding:10px;color:var(--muted);line-height:1.6}
  .look2.playing .look2-dock-tabs button:not([aria-selected="true"]){opacity:.75}
  @media(max-width:820px){.look2-inspector-pane{position:relative;right:auto;top:auto;bottom:auto;width:auto;z-index:auto;box-shadow:none}.look2-dock-readonly{overflow:auto}.look2-timeline-top{overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}.look2-timeline-top>*{flex:0 0 auto}.look2-timeline-top input.timeline-seek{flex:1 0 120px}.look2-timeline-names{flex-basis:150px}.look2-ruler-row,.look2-event-row,.look2-track{grid-template-columns:150px minmax(0,1fr)}}
  @media(max-width:1100px){.look2-main{--responsive-tree:minmax(150px,20vw);--responsive-anim:minmax(140px,18vw);--responsive-inspector:minmax(215px,25vw);grid-template-columns:var(--responsive-tree) minmax(0,1fr) var(--responsive-anim) var(--responsive-inspector)}.look2-main.hide-tree{--responsive-tree:28px}.look2-main.hide-animator{--responsive-anim:28px}.look2-main.hide-inspector{--responsive-inspector:28px}}
  @media(max-width:820px){.look2-main{--responsive-tree:minmax(128px,22vw);--responsive-inspector:minmax(200px,40vw);--responsive-anim-row:minmax(190px,.9fr);grid-template-columns:var(--responsive-tree) minmax(0,1fr) var(--responsive-inspector);grid-template-rows:minmax(170px,1.1fr) var(--responsive-anim-row)}.look2-main>.look2-pane:nth-child(1){grid-column:1;grid-row:1}.look2-main>.look2-stage-column{grid-column:2 / 4;grid-row:1}.look2-main>.look2-animations{grid-column:1;grid-row:2}.look2-main>.look2-inspector-pane{grid-column:2 / 4;grid-row:2;border-top:1px solid var(--line);border-left:0}.look2-main.hide-tree{--responsive-tree:28px}.look2-main.hide-animator.hide-inspector{--responsive-anim-row:28px}.look2-main.hide-animator>.look2-stage-column{grid-column:2 / 4}.look2-main.hide-animator>.look2-animations{grid-column:1;grid-row:2}.look2-main.hide-inspector{--responsive-inspector:28px}.look2-main.hide-inspector>.look2-stage-column{grid-column:2 / 4}.look2-dock{height:var(--timeline-height,180px);min-height:142px}.look2-timeline-body{grid-template-columns:minmax(0,1fr) minmax(140px,28vw)}.look2-timeline-names{flex-basis:150px}.look2-ruler-row,.look2-event-row,.look2-track{grid-template-columns:150px minmax(0,1fr)}.look2-event-editor{grid-template-columns:1fr 1fr}.look2-runtime-debug{grid-template-columns:1fr 1fr}}
  @media(max-width:520px){.look2-top{max-height:96px}.look2-main{--tiny-tree:104px;grid-template-columns:var(--tiny-tree) minmax(0,1fr);grid-template-rows:minmax(170px,1fr) minmax(76px,.35fr)}.look2-main>.look2-pane:nth-child(1){grid-column:1;grid-row:1}.look2-main>.look2-stage-column{grid-column:2;grid-row:1}.look2-main>.look2-animations{grid-column:1;grid-row:2}.look2-main>.look2-inspector-pane{grid-column:2;grid-row:2}.look2-main.hide-tree{--tiny-tree:28px}.look2-main.hide-tree>.look2-stage-column{grid-column:2}.look2-main.hide-animator.hide-inspector{grid-template-rows:minmax(170px,1fr) 28px}.look2-main.hide-animator>.look2-stage-column{grid-column:2}.look2-main.hide-inspector>.look2-stage-column{grid-column:2}.look2-dock{height:var(--timeline-height,160px);min-height:132px}.look2-timeline-names{flex-basis:112px}.look2-ruler-row,.look2-event-row,.look2-track{grid-template-columns:112px minmax(0,1fr)}.look2-timeline-body{grid-template-columns:minmax(0,1fr)}.look2-key-inspector{display:none}.look2-runtime-debug{grid-template-columns:minmax(0,1fr)}.look2-play-config label{display:none}.look2-play-config select{max-width:96px}}
  .look2-anim-row>button:first-child{width:auto;white-space:nowrap}
  .look2-anim-row>button:first-child>span,.look2-anim-row>button:first-child>small{display:block;overflow:hidden;text-overflow:ellipsis}
  .look2-animations .look2-anim-row>.mini{width:24px;flex:0 0 24px}
  ` + REFERENCE_THEME + ERROR_LOG_CSS
  const TRACK_FIELDS = TWEENABLE_FIELDS.map(field => [field.fieldKey, field.label])
  const PLATFORM_OPTIONS = [
    { id: 'KEYBOARD', symbol: '⌨', label: '\u952e\u9f20' },
    { id: 'TOUCHSCREEN', symbol: '▣', label: '\u89e6\u5c4f' },
    { id: 'CONTROLLER_CONSOLE', symbol: '🎮', label: '\u4e3b\u673a\u624b\u67c4' },
    { id: 'CONTROLLER_MOBILE', symbol: '▰', label: '\u624b\u673a\u624b\u67c4' },
  ]
  const labelOf = key => TRACK_FIELDS.find(row => row[0] === key)?.[1] || key
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const clone = value => JSON.parse(JSON.stringify(value))
  const snapResult = value => value?.snapshot || value
  function openDraftDb() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('此浏览器不支持 IndexedDB')); return }
      const request = indexedDB.open('look2-drafts', 1)
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts') }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB 草稿库'))
    })
  }
  async function draftDbRequest(method, key, value) {
    const db = await openDraftDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', method === 'put' || method === 'delete' ? 'readwrite' : 'readonly')
      const store = tx.objectStore('drafts')
      const request = method === 'put' ? store.put(value, key) : method === 'delete' ? store.delete(key) : store.get(key)
      let result
      request.onsuccess = () => { result = request.result }
      request.onerror = () => reject(request.error || new Error('IndexedDB 草稿操作失败'))
      tx.oncomplete = () => { db.close(); resolve(result) }
      tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB 草稿事务失败')) }
    })
  }
  function download(result) {
    const binary = atob(result.data)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || 'application/octet-stream' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename || 'look2-export'
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function downloadText(filename, text, mimeType = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = CSS; document.head.append(style)
  }
  const primitivePreviewSource = createPrimitivePreviewSource()
  function StageImage({ src, tint, imageType = 'Basic', borderUrl = '', fitContain = false, maskBox = {}, contentOpacity = 1, label = '', children }) {
    const canvasRef = React.useRef(null)
    const [failed, setFailed] = React.useState(false)
    const [border, setBorder] = React.useState(null)
    const [mask, setMask] = React.useState(null)
    const maskKey = `${src}|${imageType}|${borderUrl}|${fitContain}|${stageMaskKey(maskBox)}|${JSON.stringify(border)}`
    React.useEffect(() => {
      if (!borderUrl) { setBorder(null); return undefined }
      let alive = true
      const url = new URL(borderUrl, location.origin)
      if (url.origin !== location.origin || !/^\/look2-assets\/border\/\d+\.json$/.test(url.pathname) || url.search || url.hash) { setBorder(null); return undefined }
      fetch(url.pathname, { credentials: 'same-origin', cache: 'force-cache', redirect: 'error' })
        .then(response => { if (!response.ok) throw new Error('border unavailable'); return response.json() })
        .then(value => { if (alive && value && typeof value === 'object' && value.m_Border && typeof value.m_Border === 'object') setBorder(value) })
        .catch(() => { if (alive) setBorder(null) })
      return () => { alive = false }
    }, [borderUrl])
    React.useEffect(() => {
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      if (!canvas || !context || !src) return undefined
      setFailed(false)
      let alive = true
      const image = new Image()
      let observer = null
      let resizeFrame = 0
      image.decoding = 'async'
      const draw = () => {
        if (!alive || !image.complete || !(image.naturalWidth || image.width)) return
        // Layout dimensions exclude ancestor rotation/skew/scale. Using the
        // transformed bounding rectangle distorts nine-slice borders and masks.
        const rect = { width: canvas.clientWidth, height: canvas.clientHeight }
        const pixelRatio = Math.min(2, Math.max(1, Number(window.devicePixelRatio || 1)))
        const scale = Math.min(pixelRatio, 1024 / Math.max(1, rect.width, rect.height))
        const width = Math.max(1, Math.round(rect.width * scale))
        const height = Math.max(1, Math.round(rect.height * scale))
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
        context.clearRect(0, 0, width, height)
        const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1)
        const sourceHeight = Math.max(1, image.naturalHeight || image.height || 1)
        const drawSource = () => {
        if (fitContain) {
          const ratio = Math.min(width / sourceWidth, height / sourceHeight)
          const drawWidth = sourceWidth * ratio
          const drawHeight = sourceHeight * ratio
          context.drawImage(image, 0, 0, sourceWidth, sourceHeight, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
        } else if (String(imageType).toLowerCase() === 'stretch') {
          let meta = null
          try { meta = normalizeImageMeta(border) } catch { /* invalid border metadata uses Basic preview */ }
          if (supportsImageStretch(meta)) {
            const createCanvas = (w, h) => { const out = document.createElement('canvas'); out.width = w; out.height = h; return out }
            const sliced = rasterizeSlices(image, meta, rect.width, rect.height, createCanvas)
            context.drawImage(sliced, 0, 0, width, height)
          } else context.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height)
        } else context.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height)
        }
        context.globalCompositeOperation = 'source-over'
        drawSource()
        if (maskBox.enableMask || [tint?.r, tint?.g, tint?.b].some(value => value != null && value !== 255)) {
          const pixels = context.getImageData(0, 0, width, height)
          const coverage = applyStageImageMask(pixels, maskBox, tint)
          context.putImageData(pixels, 0, 0)
          if (coverage) {
            const maskCanvas = document.createElement('canvas')
            maskCanvas.width = width; maskCanvas.height = height
            const maskContext = maskCanvas.getContext('2d')
            const maskPixels = maskContext.createImageData(width, height)
            maskPixels.data.set(coverage)
            maskContext.putImageData(maskPixels, 0, 0)
            const url = maskCanvas.toDataURL('image/png')
            setMask(previous => previous?.key === maskKey && previous.url === url ? previous : { key: maskKey, url })
          }
        }
      }
      const queueDraw = () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(draw) }
      image.onload = () => { if (alive) { queueDraw(); if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(queueDraw); observer.observe(canvas) } } }
      image.onerror = () => { if (alive) { canvas.width = 1; canvas.height = 1; context.clearRect(0, 0, 1, 1); setFailed(true) } }
      image.src = src
      return () => { alive = false; observer?.disconnect(); cancelAnimationFrame(resizeFrame); image.onload = null; image.onerror = null }
    }, [maskKey, tint?.r, tint?.g, tint?.b])
    const masked = maskBox.enableMask === true
    const maskImage = masked ? mask?.key === maskKey && !failed ? `url("${mask.url}")` : 'linear-gradient(transparent,transparent)' : undefined
    const childrenStyle = masked ? { overflow: 'hidden', maskImage, WebkitMaskImage: maskImage,
      maskMode: 'alpha', maskSize: '100% 100%', WebkitMaskSize: '100% 100%',
      maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat' } : { overflow: 'visible' }
    return h(React.Fragment, null,
      h('div', { className: 'look2-box-content', style: { opacity: contentOpacity } },
        h('canvas', { ref: canvasRef, className: 'look2-stage-image', style: { opacity: Math.max(0, Math.min(1, Number(tint?.a ?? 1))), objectFit: 'fill' }, 'aria-hidden': true }),
        failed || !src ? h('span', { className: 'look2-image-placeholder' }, failed ? '图片无法显示' : label) : null),
      h('div', { className: 'look2-stage-subtree', style: childrenStyle }, children))
  }
  function AnimationView({ sessionId, beforeActionRef, onWorkspaceReady }) {
    const [snap, setSnap] = React.useState(null)
    const snapRef = React.useRef(null)
    const queue = React.useRef(Promise.resolve())
    const fileRef = React.useRef(null)
    const folderRef = React.useRef(null)
    const templateFileRef = React.useRef(null)
    const stageWrapRef = React.useRef(null)
    const editorRootRef = React.useRef(null)
    const dockRef = React.useRef(null)
    const timelineRef = React.useRef(null)
    const timelineInitialFitRef = React.useRef(false)
    const dragRef = React.useRef(null)
    const panelResizeRef = React.useRef(null)
    const panRef = React.useRef(null)
    const playbackCursorRef = React.useRef(0)
    const playbackTimerRef = React.useRef(null)
    const includeStartEventRef = React.useRef(false)
    const keyClipboardRef = React.useRef([])
    const nodeClipboardRef = React.useRef(null)
    const hotkeyRef = React.useRef(null)
    const [message, setMessage] = React.useState('')
    const [errorLog, setErrorLog] = React.useState(() => loadErrorLog(sessionId))
    const error = errorLog.current
    const setError = update => {
      const now = Date.now()
      setErrorLog(current => updateErrorLog(current, update, now))
    }
    const playLauncher = usePlayLauncher?.({ sessionId, api, playUrl, onError: reason => setError(String(reason?.message || reason)) })
    const [showErrors, setShowErrors] = React.useState(false)
    React.useEffect(() => { saveErrorLog(sessionId, errorLog) }, [sessionId, errorLog])
    const [playhead, setPlayhead] = React.useState(0)
    const [playing, setPlaying] = React.useState(false)
    const [trackField, setTrackField] = React.useState('anchoredPositionX')
    const [selectedKey, setSelectedKey] = React.useState(null)
    const [selectedKeys, setSelectedKeys] = React.useState([])
    const [selectedEventId, setSelectedEventId] = React.useState(null)
    const [filePath, setFilePath] = React.useState('look2.0.1.save.json')
    const [pendingLuaFile, setPendingLuaFile] = React.useState(null)
    const [timelineImportMode, setTimelineImportMode] = React.useState('append')
    const [archives, setArchives] = React.useState([])
    const [draft, setDraft] = React.useState(null)
    const [showWorkspace, setShowWorkspace] = React.useState(false)
    const [showResources, setShowResources] = React.useState(false)
    const [showTemplates, setShowTemplates] = React.useState(false)
    const [showPlayHelp, setShowPlayHelp] = React.useState(false)
    const [selectedArchive, setSelectedArchive] = React.useState('')
    const [pendingArchiveDelete, setPendingArchiveDelete] = React.useState('')
    const [showTestArchives, setShowTestArchives] = React.useState(false)
    const [showHistory, setShowHistory] = React.useState(false)
    const [showEventLog, setShowEventLog] = React.useState(false)
    const [contextMenu, setContextMenu] = React.useState(null)
    const [treeSearch, setTreeSearch] = React.useState('')
    const [collapsedTree, setCollapsedTree] = React.useState({})
    const [hiddenNodes, setHiddenNodes] = React.useState({})
    const [treeDragOver, setTreeDragOver] = React.useState('')
    const [inspectorTab, setInspectorTab] = React.useState('base')
    const [inspectorPlatform, setInspectorPlatform] = React.useState('KEYBOARD')
    const [showRuntimeFields, setShowRuntimeFields] = React.useState(true)
    const [animatorCollapsed, setAnimatorCollapsed] = React.useState(false)
    const [collapsedGroups, setCollapsedGroups] = React.useState({})
    const [boneView, setBoneView] = React.useState(false)
    const [timelineHeight, setTimelineHeight] = React.useState(209)
    const [pixelsPerSecond, setPixelsPerSecond] = React.useState(80)
    const [timelineWidth, setTimelineWidth] = React.useState(0)
    const [stageSize, setStageSize] = React.useState({ width: 1, height: 1 })
    const [stagePointer, setStagePointer] = React.useState(null)
    const [zoom, setZoom] = React.useState(1)
    const [pan, setPan] = React.useState({ x: 0, y: 0 })
    const [editMode, setEditMode] = React.useState('combined')
    const [panelWidths, setPanelWidths] = React.useState({ tree: 252, animator: 192, inspector: 306 })
    const [hiddenPanels, setHiddenPanels] = React.useState({})
    const [eventLog, setEventLog] = React.useState([])
    const [historyNote, setHistoryNote] = React.useState('')
    const draftCacheRef = React.useRef(null)
    const psdImportControllerRef = React.useRef(null)
    const lastQueueErrorRef = React.useRef(null)
    const lastQueueErrorLabelRef = React.useRef('')
    const playControllerRef = React.useRef(null)
    const playStartedAtRef = React.useRef(0)
    const playStartingRef = React.useRef(false)
    const dockTabBeforePlayRef = React.useRef(null)
    const [dockTab, setDockTab] = React.useState('animation')
    const [dockFullscreen, setDockFullscreen] = React.useState(false)
    const [inlinePlaying, setInlinePlaying] = React.useState(false)
    const [playStarting, setPlayStarting] = React.useState(false)
    const [inlineStartOptions, setInlineStartOptions] = React.useState(null)
    const [playTarget, setPlayTarget] = React.useState('full')
    const [playerCount, setPlayerCount] = React.useState(1)
    const [playSnapshot, setPlaySnapshot] = React.useState(null)
    const [runtimeInspection, setRuntimeInspection] = React.useState(null)
    const [playReady, setPlayReady] = React.useState(false)
    const [inspectBusy, setInspectBusy] = React.useState(false)
    React.useEffect(() => {
      const panel = dockRef.current
      if (!panel) return
      const owner = panel.ownerDocument
      const update = () => setDockFullscreen(owner.fullscreenElement === panel)
      owner.addEventListener('fullscreenchange', update)
      return () => {
        owner.removeEventListener('fullscreenchange', update)
        if (owner.fullscreenElement === panel) void owner.exitFullscreen().catch(() => {})
      }
    }, [Boolean(snap)])
    async function toggleDockFullscreen() {
      const panel = dockRef.current
      if (!panel) return
      try {
        if (panel.ownerDocument.fullscreenElement === panel) await panel.ownerDocument.exitFullscreen()
        else if (panel.requestFullscreen) await panel.requestFullscreen()
        else throw new Error('当前浏览器不支持全屏，请使用桌面浏览器')
      } catch (reason) { setError(`无法切换面板全屏：${reason.message || reason}`) }
    }
    const interactionLocked = inlinePlaying || playStarting
    const readOnlyMessage = '试玩期间工程处于只读状态；停止试玩后再操作'
    const stopIfLocked = () => { if (!interactionLocked) return false; setError(readOnlyMessage); return true }
    const [serverEntity, setServerEntity] = React.useState('PlayerSelf')
    const [serverVariable, setServerVariable] = React.useState('')
    const [serverValue, setServerValue] = React.useState('0')
    const [signalName, setSignalName] = React.useState('')
    const [signalParams, setSignalParams] = React.useState('[]')
    const [signalTarget, setSignalTarget] = React.useState('PlayerSelf')
    const errorRef = React.useRef('')
    errorRef.current = error
    const [psdImportName, setPsdImportName] = React.useState('')
    const accept = next => { const value = snapResult(next); snapRef.current = value; setSnap(value); return value }
    async function refreshRevisionForRetry(reason, current) {
      if (!/revision conflict/i.test(String(reason?.message || reason))) return
      try {
        const latest = snapResult(await api(sessionId, 'get'))
        if (latest && Number(latest.version) > Number(current?.version)
          && latest.selectedId === current?.selectedId && latest.asset?.type === current?.asset?.type) {
          // Refresh only the revision source; visible inputs and local drafts remain intact.
          snapRef.current = latest
        }
      } catch {}
    }
    const discardInputError = reason => {
      // A cancelled field may only release its own failure, not another input's.
      if (lastQueueErrorRef.current !== reason) return
      lastQueueErrorRef.current = null
      lastQueueErrorLabelRef.current = ''
      const message = String(reason?.message || reason)
      setError(current => current === message ? '' : current)
    }
    const run = (task, label = '', blockOnFailure = true) => {
      const promise = queue.current.then(task, task)
      queue.current = promise.catch(reason => {
        if (!blockOnFailure) return
        lastQueueErrorRef.current = reason
        if (label) lastQueueErrorLabelRef.current = label
      })
      return promise.then(result => {
        if (blockOnFailure && label && lastQueueErrorLabelRef.current === label) {
          lastQueueErrorRef.current = null
          lastQueueErrorLabelRef.current = ''
          setError('')
        }
        return result
      }, reason => {
        if (blockOnFailure) {
          lastQueueErrorRef.current = reason
          if (label) lastQueueErrorLabelRef.current = label
        }
        throw reason
      })
    }
    const beforeAction = React.useCallback(async ({ blur = true } = {}) => {
      if (blur) {
        const active = typeof document === 'undefined' ? null : document.activeElement
        if (editorRootRef.current?.contains(active) && typeof active?.blur === 'function') active.blur()
        await Promise.resolve()
      }
      await beforeActionRef?.current?.()
      await queue.current
      if (lastQueueErrorRef.current) {
        const reason = lastQueueErrorRef.current
        setError(String(reason?.message || reason))
        throw reason instanceof Error ? reason : new Error(String(reason))
      }
      return snapRef.current
    }, [beforeActionRef])
    React.useEffect(() => {
      onWorkspaceReady?.({ beforeAction, getSnapshot: () => snapRef.current, getError: () => errorRef.current })
      return () => onWorkspaceReady?.(null)
    }, [beforeAction, onWorkspaceReady])
    const abortPsdImport = () => { psdImportControllerRef.current?.abort(); psdImportControllerRef.current = null; setPsdImportName('') }
    React.useEffect(() => () => abortPsdImport(), [])
    React.useEffect(() => {
      const target = stageWrapRef.current
      if (!target) return
      const measure = () => setStageSize({ width: target.clientWidth || 1, height: target.clientHeight || 1 })
      measure()
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
      observer?.observe(target)
      window.addEventListener('resize', measure)
      return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
    }, [snap?.canvas?.width, snap?.canvas?.height, hiddenPanels.tree, hiddenPanels.animator, hiddenPanels.inspector])
    React.useEffect(() => {
      if (snap?.canvas?.platform) setInspectorPlatform(snap.canvas.platform)
    }, [snap?.canvas?.id])
    React.useEffect(() => {
      const handle = event => {
        if (event.key === 'Escape') setShowErrors(false)
        if (hotkeyRef.current) hotkeyRef.current(event)
      }
      window.addEventListener('keydown', handle)
      const closeContext = event => { if (event.type === 'blur' || (event.button === 0 && !event.target?.closest?.('.look2-context-menu'))) setContextMenu(null) }
      window.addEventListener('blur', closeContext)
      window.addEventListener('pointerdown', closeContext)
      return () => { window.removeEventListener('keydown', handle); window.removeEventListener('blur', closeContext); window.removeEventListener('pointerdown', closeContext) }
    }, [])
    const scheduleDraft = () => {
      void draftCacheRef.current?.schedule(
        () => api(sessionId, 'export', { format: 'save' }),
        () => queue.current,
      )
    }
    const refreshArchives = async () => { try { const result = await api(sessionId, 'archives'); setArchives(result.archives || []) } catch {} }
    React.useEffect(() => {
      let alive = true
      const draftCache = createDraftCache({
        sessionId,
        request: draftDbRequest,
        onError: reason => setMessage(`浏览器草稿未保存：${String(reason?.message || reason)}`),
      })
      draftCacheRef.current = draftCache
      api(sessionId, 'get').then(current => {
        if (alive) { accept(current); setFilePath(current.storage?.path || 'look2.0.1.save.json'); refreshArchives() }
      }).catch(reason => alive && setError(String(reason.message || reason)))
      draftDbRequest('get', sessionId).then(value => {
        if (alive && value) setDraft(value)
        else if (alive) {
          try { const raw = localStorage.getItem(`look2-draft:${sessionId}`); if (raw) setDraft(JSON.parse(raw)) } catch {}
        }
      }).catch(() => {
        try { const raw = localStorage.getItem(`look2-draft:${sessionId}`); if (alive && raw) setDraft(JSON.parse(raw)) } catch {}
      })
      return () => {
        alive = false
        draftCache.dispose()
        if (draftCacheRef.current === draftCache) draftCacheRef.current = null
      }
    }, [sessionId])
    React.useEffect(() => {
      const measure = () => {
        const width = timelineRef.current?.clientWidth || 0
        setTimelineWidth(width)
        if (width > 230 && !timelineInitialFitRef.current) {
          const current = snapRef.current?.look2
          const animation = current?.animations?.find(item => item.id === current.activeAnimationId) || current?.animations?.[0]
          setPixelsPerSecond(Math.max(24, (width - 230) / Math.max(.1, animation?.duration || 5)))
          timelineInitialFitRef.current = true
        }
      }
      measure()
      const observer = typeof ResizeObserver === 'undefined' || !timelineRef.current ? null : new ResizeObserver(measure)
      if (timelineRef.current) observer?.observe(timelineRef.current)
      return () => observer?.disconnect()
    }, [snap?.canvas?.width, snap?.asset?.type, dockTab, hiddenPanels.tree, hiddenPanels.animator, hiddenPanels.inspector, timelineHeight])
    React.useEffect(() => { playbackCursorRef.current = playhead }, [playhead])
    React.useEffect(() => {
      if (!playing || !snap) return
      const animation = snap.look2.animations.find(a => a.id === snap.look2.activeAnimationId)
      const duration = Number(animation?.duration || 5)
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now(); const delta = (now - last) / 1000; last = now
        const from = playbackCursorRef.current
        const next = Math.min(duration, from + delta)
        playbackCursorRef.current = next
        const includeStart = includeStartEventRef.current
        includeStartEventRef.current = false
        const crossed = collectCrossedAnimationEvents(animation.events, from, next, includeStart)
        if (crossed.length) setEventLog(rows => appendAnimationEventLog(rows, crossed, now))
        setPlayhead(next)
      }, 33)
      playbackTimerRef.current = timer
      return () => { clearInterval(timer); if (playbackTimerRef.current === timer) playbackTimerRef.current = null }
    }, [playing, snap?.asset?.type, snap?.look2?.activeAnimationId, snap?.look2?.animations])
    React.useEffect(() => {
      setPlaying(false); setEventLog([]); setPlayhead(0)
      setSelectedKey(null); setSelectedKeys([]); setSelectedEventId(null)
      timelineInitialFitRef.current = false
    }, [snap?.asset?.type])
    React.useEffect(() => { setPlaying(false); setEventLog([]); includeStartEventRef.current = false }, [snap?.look2?.activeAnimationId])
    React.useEffect(() => {
      const animation = snap?.look2?.animations.find(a => a.id === snap.look2.activeAnimationId)
      if (playing && animation && playhead >= Number(animation.duration)) setPlaying(false)
    }, [playhead, playing, snap?.look2?.animations, snap?.look2?.activeAnimationId])
    const transact = (label, { ops, state, guard, prepare, blockOnFailure = !ops || ops.some(op => ['set', 'renameSave'].includes(op.op)) } = {}) => {
      if (inlinePlaying) return Promise.reject(new Error('试玩期间工程处于只读状态；停止试玩后再编辑'))
      const assetType = snapRef.current?.asset?.type
      return run(async () => {
        // Check after earlier field commits finish; structural errors must not trap selection.
        if (lastQueueErrorRef.current && ops?.some(op => ['select', 'selectAsset'].includes(op.op))) {
          throw new Error('上一个输入未能提交；请修正当前字段后再切换控件或资产')
        }
        const current = snapRef.current
        guard?.(current)
        const prepared = prepare?.(current)
        if (prepared?.skip) return current
        const transactionOps = prepared ? prepared.ops : ops
        const transactionState = prepared ? prepared.state : state
        let next
        try { next = await api(sessionId, 'transaction', { label, ops: transactionOps, state: transactionState, expectedRevision: current.version }) }
        catch (reason) { await refreshRevisionForRetry(reason, current); throw reason }
        if (!lastQueueErrorRef.current || blockOnFailure && lastQueueErrorLabelRef.current === label) {
          lastQueueErrorRef.current = null; lastQueueErrorLabelRef.current = ''
          setError('')
        }
        scheduleDraft(); return accept(next)
      }, label, blockOnFailure).catch(reason => { setError(String(reason.message || reason)); throw reason })
    }
    const patch = (op, label = op.op === 'set' ? `设置 ${op.id}/${op.key}` : op.op || '编辑控件') => transact(label, { ops: [op] })
    function selectControl(id, label = '选择控件') {
      if (stopIfLocked()) return
      const assetType = snapRef.current?.asset?.type
      return beforeAction().then(() => transact(label, { ops: [{ op: 'select', id }], guard: current => {
        if (current.asset.type !== assetType) throw new Error('编辑资产已切换，请重新选择控件')
      } })).catch(reason => setError(String(reason.message || reason)))
    }
    const applyFieldGroup = ({ id, assetType, kind, platform, values, label }) => {
      const initial = snapRef.current
      if (!initial || initial.selectedId !== id || initial.asset?.type !== assetType || initial.inspector?.kind !== kind || inspectorPlatform !== platform) {
        return Promise.reject(new Error('所选控件或编辑资产已变化，请重新操作属性组'))
      }
      const prepare = current => {
        const initial = current
        const ops = []
        let nextState = null
        const entries = Object.entries(values || {})
        const animation = initial.canvas?.platform === platform
          ? initial.look2.animations.find(item => item.id === initial.look2.activeAnimationId) || initial.look2.animations[0]
          : null
        let recordTime = 0
        if (animation) {
          const frameRate = Math.max(1, Number(initial.look2.frameRate) || 30)
          const rawTime = Math.max(0, Math.min(Number(animation.duration) || 5, Number(playhead) || 0))
          recordTime = Number((initial.look2.timelineSnapEnabled ? Math.round(rawTime * frameRate) / frameRate : rawTime).toFixed(4))
        }
        const sourceNode = findProjectNode(initial.root, id)
        const sourceTransform = sourceNode?.transformByPlatform?.[platform]
        const directTransformKeys = new Set(['posX', 'posY', 'width', 'height', 'rotationZ', 'anchorType', 'anchorMinX', 'anchorMinY', 'anchorMaxX', 'anchorMaxY', 'pivotX', 'pivotY'])
        const primitive = initial.asset?.type === 'client-control-template' && initial.look2.siteNodes?.[id]?.type === 'primitive'

        function normalizeTrackValue(fieldKey, value) {
          const definition = TWEENABLE_FIELDS.find(field => field.fieldKey === fieldKey && field.kinds.includes(kind))
          if (!definition || (primitive && ['imageColor', 'fillAmount'].includes(fieldKey))) return null
          if (definition.type === 'boolean') return typeof value === 'boolean' ? value : null
          if (definition.type === 'color') {
            if (typeof value === 'string' && !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error(`${fieldKey} 颜色值无效`)
            const color = colorParts(value)
            if (![color.r, color.g, color.b, color.a].every(Number.isFinite) || color.r < 0 || color.r > 255 || color.g < 0 || color.g > 255 || color.b < 0 || color.b > 255 || color.a < 0 || color.a > 1) throw new Error(`${fieldKey} 颜色值超出范围`)
            return { r: color.r, g: color.g, b: color.b, a: color.a }
          }
          const number = Number(value)
          if (!Number.isFinite(number)) throw new Error(`${fieldKey} 必须是有限数字`)
          if (fieldKey === 'fillAmount' && (number < 0 || number > 1)) throw new Error('fillAmount 必须在 0 到 1 之间')
          if (fieldKey === 'groupAlpha' && (number < 0 || number > 255)) throw new Error('groupAlpha 必须在 0 到 255 之间')
          return number
        }
        function recordTrack(fieldKey, requestedValue) {
          const value = normalizeTrackValue(fieldKey, requestedValue)
          if (value === null) return false
          const track = animation?.keyframeTracks?.find(item => item.nodeId === id && item.fieldKey === fieldKey)
          if (!track) return false
          nextState ||= clone(initial.look2)
          const targetAnimation = nextState.animations.find(item => item.id === animation.id)
          const targetTrack = targetAnimation?.keyframeTracks?.find(item => item.id === track.id)
          if (!targetTrack) return false
          let keyframe = targetTrack.keyframes.find(item => Math.abs(Number(item.time) - recordTime) < .0001)
          if (!keyframe) {
            keyframe = { id: uid('key'), time: recordTime, value: clone(value), easeType: 'Linear', interpolation: fieldKey === 'visible' ? 'step' : 'tween' }
            targetTrack.keyframes.push(keyframe)
            targetTrack.keyframes.sort((left, right) => left.time - right.time)
          }
          setAbsoluteKeyframeValue(keyframe, value)
          return true
        }

        const rawTransform = Object.hasOwn(values || {}, '__transform') ? values.__transform : null
        let nextTransform = null
        const changedChannels = {}
        if (sourceTransform && rawTransform && typeof rawTransform === 'object') {
          nextTransform = clone(rawTransform)
          for (const fieldKey of Object.keys(TRANSFORM_TRACK_PATHS)) {
            const before = transformTrackValue(sourceTransform, fieldKey)
            const after = transformTrackValue(nextTransform, fieldKey)
            if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(before - after) > 1e-9) changedChannels[fieldKey] = after
          }
        } else if (sourceTransform && entries.some(([key]) => directTransformKeys.has(key))) {
          const layout = layoutTree(initial.root, projectCanvas(initial), platform)
          const box = layout.boxes[id]
          const parentId = initial.tree.find(item => item.id === id)?.parentId
          const parentNode = parentId ? findProjectNode(initial.root, parentId) : null
          const parentBox = parentNode && parentNode.kind !== 'server-container' ? layout.boxes[parentId] : layout.canvas
          if (box && parentBox) {
            const result = inspectorTransformChannels(sourceTransform, parentBox, box, Object.fromEntries(entries.filter(([key]) => directTransformKeys.has(key))))
            nextTransform = result.transform
            Object.assign(changedChannels, result.channels)
          }
        }

        const animatedTransformFields = new Set()
        const syncEntry = entries.find(([key]) => key === 'syncAllDevices')
        // Reapplying an unchanged enabled flag resynchronizes from the canvas
        // platform and would erase the explicitly pasted controller transform.
        // Apply an actual flag change before the selected platform override.
        if (syncEntry && syncEntry[1] !== (sourceNode?.syncAllDevices !== false)) {
          ops.push({ op: 'set', id, key: 'syncAllDevices', value: syncEntry[1] })
        }
        if (nextTransform) {
          const baseTransform = clone(nextTransform)
          for (const [fieldKey, value] of Object.entries(changedChannels)) {
            if (!recordTrack(fieldKey, value)) continue
            animatedTransformFields.add(fieldKey)
            setTransformTrackValue(baseTransform, fieldKey, transformTrackValue(sourceTransform, fieldKey))
          }
          if (JSON.stringify(baseTransform) !== JSON.stringify(sourceTransform)) ops.push({ op: 'setPlatformTransform', id, platform, transform: baseTransform })
        }

        for (const [key, value] of entries) {
          if (key === '__transform') continue
          if (key === 'locked') { ops.push({ op: 'setEditorLock', id, locked: value === true }); continue }
          if (key === 'syncAllDevices') continue
          if (directTransformKeys.has(key)) {
            const linkedTrack = Object.entries({ posX: 'anchoredPositionX', posY: 'anchoredPositionY', width: 'sizeDeltaX', height: 'sizeDeltaY', rotationZ: 'localRotationZ', anchorMinX: 'anchorMinX', anchorMinY: 'anchorMinY', anchorMaxX: 'anchorMaxX', anchorMaxY: 'anchorMaxY', pivotX: 'pivotX', pivotY: 'pivotY' }).find(([inspectorKey]) => inspectorKey === key)?.[1]
            if (linkedTrack && animatedTransformFields.has(linkedTrack)) continue
            if (nextTransform) continue
            ops.push({ op: 'set', id, key, value })
            continue
          }
          if (!recordTrack(key, value)) ops.push({ op: 'set', id, key, value })
        }
        if (!ops.length && !nextState) return { skip: true }
        return { ops, state: nextState || undefined }
      }
      return transact(label || '修改属性组', {
        prepare,
        guard: current => {
          if (current?.selectedId !== id || current?.asset?.type !== assetType || current?.inspector?.kind !== kind || inspectorPlatform !== platform) {
            throw new Error('所选控件或编辑资产已变化，请重新操作属性组')
          }
        },
      })
    }
    async function selectAsset(assetType) {
      if (stopIfLocked()) return
      if (snapRef.current?.asset?.type === assetType) return
      try {
        const next = await patch({ op: 'selectAsset', assetType }, '切换编辑资产')
        setTreeSearch('')
        setInspectorTab('base')
        if (assetType === 'server-control-template') setPlayTarget('full')
        setMessage(`已切换到${next.asset?.label || assetType}`)
      } catch (reason) { setError(String(reason.message || reason)) }
    }
    const editState = (fn, label = '编辑动画') => {
      if (inlinePlaying) return Promise.reject(new Error('试玩期间工程处于只读状态；停止试玩后再编辑'))
      const assetType = snapRef.current?.asset?.type
      return run(async () => {
        const current = snapRef.current
        if (current.asset?.type !== assetType && (state !== undefined || ops?.some(op => !['selectAsset', 'newDocument', 'renameSave'].includes(op.op)))) {
          throw new Error('编辑资产已切换，请在当前资产中重新操作')
        }
        if (current.asset?.type !== assetType) throw new Error('编辑资产已切换，请在当前资产中重新操作')
        const nextState = clone(current.look2); fn(nextState)
        let next
        try { next = await api(sessionId, 'transaction', { label, state: nextState, expectedRevision: current.version }) }
        catch (reason) { await refreshRevisionForRetry(reason, current); throw reason }
        if (!lastQueueErrorRef.current || lastQueueErrorLabelRef.current === label) {
          lastQueueErrorRef.current = null; lastQueueErrorLabelRef.current = ''; setError('')
        }
        scheduleDraft(); return accept(next)
      }, label).catch(reason => { setError(String(reason.message || reason)); lastQueueErrorRef.current = reason; lastQueueErrorLabelRef.current = label; throw reason })
    }
    async function historyAction(action, index) {
      if (stopIfLocked()) return
      try {
        if (lastQueueErrorRef.current && action !== 'list') throw new Error('上一个输入未能提交；修正当前字段后再撤销或重做')
        const result = await run(() => api(sessionId, 'history', { action, index, expectedRevision: snapRef.current.version }), `history:${action}`)
        if (action === 'list') setHistoryNote('歷史記錄已重新載入')
        else { accept(result); scheduleDraft(); setMessage(action === 'undo' ? '已撤销' : action === 'redo' ? '已重做' : '已恢复历史版本') }
      } catch (reason) { setError(String(reason.message || reason)) }
    }
    const undo = () => { if (snap?.history?.canUndo) void historyAction('undo') }
    const redoAction = () => { if (snap?.history?.canRedo) void historyAction('redo') }
    async function importFile(file, timelineMode = null) {
      if (stopIfLocked()) return
      if (!file) return
      abortPsdImport()
      try {
        const extension = file.name.toLowerCase()
        if (extension.endsWith('.lua') && timelineMode === null) {
          setPendingLuaFile(file); setTimelineImportMode('append'); return
        }
        if (extension.endsWith('.psd')) {
          const controller = new AbortController()
          psdImportControllerRef.current = controller
          setPsdImportName(file.name)
          setMessage(`正在后台导入 ${file.name}`)
          const workerUrl = location.pathname.includes('/look2-simulator') ? '/look2-simulator/look2-psd-worker.js' : '/look2-psd-worker.js'
          try {
            const document = await importPsd(file, snapRef.current?.canvas, { signal: controller.signal, workerUrl })
            if (!controller.signal.aborted) await importSiteDocument(document, file.name)
          } finally {
            if (psdImportControllerRef.current === controller) { psdImportControllerRef.current = null; setPsdImportName('') }
          }
          return
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        const format = extension.endsWith('.gia') ? 'gia' : extension.endsWith('.lua') ? 'lua' : 'json'
        await beforeAction()
        const result = await run(() => api(sessionId, 'import', { format, data: btoa(binary), filename: file.name, ...(format === 'lua' ? { mode: timelineMode } : {}) }), 'import')
        accept(result.snapshot); scheduleDraft(); setMessage(`已导入 ${file.name}`); setFilePath('look2.0.1.save.json'); resetTimelineUi()
        if (format === 'lua') setPendingLuaFile(null)
      } catch (reason) { if (reason?.name !== 'AbortError') setError(String(reason.message || reason)) }
    }
    async function importSiteDocument(value, name) {
      if (stopIfLocked()) throw new Error(readOnlyMessage)
      await beforeAction()
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      const result = await run(() => api(sessionId, 'import', { format: 'json', data: btoa(binary), filename: `${name}.json` }), 'import')
      accept(result.snapshot); scheduleDraft(); setMessage(`已导入 ${name}，${value.nodes.length - 1} 个控件`); setFilePath('look2.0.1.save.json'); resetTimelineUi()
    }
    async function importSpineFolder(files) {
      if (stopIfLocked()) return
      if (snapRef.current?.asset?.type !== 'client-control-template') { setError('Spine 动画仅适用于客户端控件模板'); return }
      abortPsdImport()
      try { await importSiteDocument(await importSpine(files), 'Spine 动画') }
      catch (reason) { setError(String(reason.message || reason)) }
    }
    function bindResource(id) {
      if (snapRef.current?.asset?.type !== 'client-control-template') { setError('图元资源仅适用于客户端控件模板'); return }
      const selected = snapRef.current?.selectedId
      if (!selected || snapRef.current?.inspector?.kind !== 'image') { setError('请先选择一个图片控件'); return }
      void editState(next => { next.siteNodes ||= {}; const original = next.siteNodes[selected] || { id: selected, type: 'image', properties: {} }; original.properties = { ...(original.properties || {}), imageSource: 'primitive', imageResourceId: id, primitiveResourceId: id }; next.siteNodes[selected] = original }, '绑定图片资源')
    }
    async function fetchResourceImage(value) {
      const raw = String(value || '').trim()
      if (!raw || raw.startsWith('//')) throw new Error('图片网址必须是绝对 HTTP(S) 地址或受支持的 look2 素材路径')
      const isLocalPath = raw.startsWith('/')
      let url
      try { url = isLocalPath ? new URL(raw, location.origin) : new URL(raw) }
      catch { throw new Error('图片网址格式无效') }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 HTTP(S) 图片网址')
      if (url.origin === location.origin) {
        const safeAsset = /^\/look2-assets\/(?:canvas-background\.png|sprite\/[A-Za-z0-9_.-]+\.png|border\/[A-Za-z0-9_.-]+\.json)$/i.test(url.pathname)
        if (!isLocalPath && !url.pathname.startsWith('/look2-assets/')) throw new Error('同源图片必须使用 look2 素材路径')
        if (!safeAsset || url.search || url.hash || url.username || url.password) throw new Error('只允许读取 look2 素材目录中的图片')
        const response = await fetch(url.pathname, { cache: 'force-cache', credentials: 'same-origin', redirect: 'error' })
        if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`)
        const blob = await response.blob()
        const mimeType = blob.type || 'image/png'
        if (!/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/i.test(mimeType)) throw new Error(`素材类型不是受支持的图片：${mimeType}`)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        return { data: btoa(binary), mimeType }
      }
      if (isLocalPath || url.username || url.password) throw new Error('本地路径不能发送到外部图片导入接口')
      const result = await api(sessionId, 'image-url', { url: url.href })
      const mimeType = String(result?.mimeType || '')
      if (!/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/i.test(mimeType) || !result?.data) throw new Error(`远程结果不是受支持的图片：${mimeType || '未知类型'}`)
      return { data: result.data, mimeType }
    }
    function selectNativeImage(imageId) {
      const current = snapRef.current
      if (current?.asset?.type !== 'client-control-template') { setError('图集资源仅适用于客户端控件模板'); return }
      const selected = current?.selectedId
      if (!selected || current?.inspector?.kind !== 'image') { setError('先选择一个图片控件，再选图库素材'); return }
      if (current.look2.siteNodes?.[selected]?.type === 'primitive') { setError('图元图片请将图库素材添加为图元原图，再使用“绑定到选中图片控件”'); return }
      const nextState = clone(current.look2)
      nextState.siteNodes ||= {}
      const original = nextState.siteNodes[selected] || { id: selected, type: 'image', properties: {} }
      original.properties = { ...(original.properties || {}), imageId: Number(imageId), imageSource: 'StaticReference' }
      delete original.properties.imageResourceId
      delete original.properties.primitiveResourceId
      nextState.siteNodes[selected] = original
      return transact('绑定图库图片', { ops: [{ op: 'set', id: selected, key: 'imageId', value: Number(imageId) }, { op: 'set', id: selected, key: 'imageSource', value: 'StaticReference' }], state: nextState })
    }
    async function exportFile(format, arg = '') {
      try {
        if (stopIfLocked()) return
        if (snapRef.current?.asset?.type !== 'client-control-template' && ['primitive-data', 'primitive-lib', 'primitive-svg', 'primitive-css'].includes(format)) {
          throw new Error('图元数据仅能从客户端控件模板导出')
        }
        await beforeAction()
        const current = snapRef.current
        const rootId = current.animationPreviewRoot.authoringId
        const assetType = format === 'lua' ? arg
          : ['json', 'gia'].includes(format) ? arg || current.asset?.type || ''
          : ['animation-lua', 'timeline-data', 'timeline-lib', 'primitive-data'].includes(format) ? rootId
          : ['primitive-svg', 'primitive-css'].includes(format) ? current.selectedId : ''
        const result = await api(sessionId, 'export', { format, assetType })
        const warnings = [...new Set([...(result.warnings || []), ...(result.files || []).flatMap(file => file.warnings || [])])]
        if (Array.isArray(result.files) && result.files.length) {
          for (const file of result.files) download(file)
          setMessage(`已导出 ${result.files.length} 个 GIA 文件（${result.files.map(file => file.filename).join('、')}）${warnings.length ? `；${warnings.join('；')}` : ''}`)
        } else {
          download(result); setMessage(`已导出 ${result.filename}${warnings.length ? `；${warnings.join('；')}` : ''}`)
        }
      }
      catch (reason) { setError(String(reason.message || reason)) }
    }
    async function save() {
      try { if (stopIfLocked()) return; await beforeAction(); const result = await api(sessionId, 'save', { path: filePath, expectedRevision: snapRef.current.version }); await draftCacheRef.current?.clear().catch(() => {}); setMessage(`已保存 ${result.path}`); setDraft(null); localStorage.removeItem(`look2-draft:${sessionId}`); refreshArchives() }
      catch (reason) { setError(String(reason.message || reason)) }
    }
    function findTemplateRoot(current, nodeId) {
      let row = current?.tree?.find(item => item.id === nodeId)
      while (row?.parentId) {
        const parent = current.tree.find(item => item.id === row.parentId)
        if (!parent || parent.kind === 'server-container') break
        row = parent
      }
      return row?.kind === 'server-container' ? current.animationPreviewRoot?.authoringId || '' : row?.id || ''
    }
    async function startInlinePlay() {
      if (interactionLocked || playStartingRef.current) return
      playStartingRef.current = true
      setPlaying(false)
      clearInterval(playbackTimerRef.current)
      playbackTimerRef.current = null
      setContextMenu(null)
      const activeElement = document.activeElement
      if (editorRootRef.current?.contains(activeElement) && typeof activeElement?.blur === 'function') activeElement.blur()
      await Promise.resolve()
      setPlayStarting(true)
      try {
        await beforeAction({ blur: false })
        const current = snapRef.current
        if (!current) throw new Error('工程尚未载入')
        setShowWorkspace(false)
        setShowHistory(false)
        setShowTemplates(false)
        setShowResources(false)
        setPendingLuaFile(null)
        const asset = playTarget === 'template' ? 'client' : 'server'
        const templateRootId = playTarget === 'template' ? findTemplateRoot(current, current.selectedId) : ''
        if (playTarget === 'template' && !templateRootId) throw new Error('先在控件树中选择一个模板或其子控件')
        if (playTarget === 'template' && current.asset?.type !== 'client-control-template') throw new Error('先切换到客户端模板，再选择模板试玩')
        const options = {
          asset,
          ...(templateRootId ? { templateRootId } : {}),
          animationId: current.look2?.activeAnimationId || '',
          animationAsset: current.asset?.type,
          expectedRevision: current.version,
          playerCount: Math.max(1, Math.min(8, Number(playerCount) || 1)),
        }
        setError('')
        setRuntimeInspection(null)
        setPlaySnapshot(null)
        setInlineStartOptions(options)
        dockTabBeforePlayRef.current = dockTab
        setDockTab('debug')
        playStartedAtRef.current = Date.now()
        setInlinePlaying(true)
      } catch (reason) { setError(String(reason.message || reason)) }
      finally { playStartingRef.current = false; setPlayStarting(false) }
    }
    function finishInlinePlay() {
      playControllerRef.current = null
      setPlayReady(false)
      setInspectBusy(false)
      setInlinePlaying(false)
      setInlineStartOptions(null)
      setPlaySnapshot(null)
      setRuntimeInspection(null)
      if (dockTabBeforePlayRef.current) setDockTab(dockTabBeforePlayRef.current)
      dockTabBeforePlayRef.current = null
    }
    function stopInlinePlay() {
      // A double-click on the shared play/stop button must not cancel the session
      // it just started; ignore stop during the short grace window after start.
      if (inlinePlaying && !canStopInlinePlay(playStartedAtRef.current)) {
        setMessage('试玩刚开始，请稍候再停止')
        return
      }
      const controller = playControllerRef.current
      if (controller?.stop) {
        void controller.stop().catch(reason => {
          if (playControllerRef.current === controller) setError(String(reason?.message || reason))
        })
        return
      }
      // Unmounting the not-yet-ready surface runs its serialized start/stop cleanup.
      finishInlinePlay()
    }
    function startExternalPlay() {
      if (!playLauncher || interactionLocked || playStarting) return
      void playLauncher.open(async () => {
        await beforeAction({ blur: false })
        setError('')
      })
    }
    async function refreshPlayInspection(expectedController = playControllerRef.current) {
      const controller = expectedController
      if (!controller || playControllerRef.current !== controller) return
      setInspectBusy(true)
      try {
        const inspection = await controller.inspect()
        if (playControllerRef.current === controller) setRuntimeInspection(inspection)
      } catch (reason) {
        if (playControllerRef.current === controller) setError(String(reason.message || reason))
      } finally {
        if (playControllerRef.current === controller) setInspectBusy(false)
      }
    }
    async function sendPlayAction(action, args) {
      const controller = playControllerRef.current
      if (!controller) return
      try {
        await controller.act(action, args)
        if (playControllerRef.current === controller) await refreshPlayInspection(controller)
      } catch (reason) {
        if (playControllerRef.current === controller) setError(String(reason.message || reason))
      }
    }
    function resetTimelineUi() {
      setHiddenNodes({})
      setPlaying(false)
      playbackCursorRef.current = 0
      includeStartEventRef.current = false
      setPlayhead(0)
      setEventLog([])
      setSelectedKey(null)
      setSelectedKeys([])
      setSelectedEventId(null)
    }
    async function newDocument() {
      if (stopIfLocked()) return
      abortPsdImport()
      try {
        await beforeAction()
        await patch({ op: 'newDocument' }, '新建工程')
        const used = new Set(archives.map(entry => entry.path))
        let index = 1
        while (used.has(`look2.0.${index}.save.json`)) index++
        setFilePath(`look2.0.${index}.save.json`)
        resetTimelineUi()
        setMessage('已新建工程；保存后写入工作区，可撤销恢复原工程')
      } catch (reason) { setError(String(reason.message || reason)) }
    }
    async function load(path) {
      if (stopIfLocked()) return
      abortPsdImport()
      try { await beforeAction(); const result = await run(() => api(sessionId, 'load-archive', { path }), 'load'); await draftCacheRef.current?.clear().catch(() => {}); localStorage.removeItem(`look2-draft:${sessionId}`); setDraft(null); accept(result.snapshot); setFilePath(path); resetTimelineUi(); setMessage(`已加载 ${path}`); setShowWorkspace(false) }
      catch (reason) { setError(String(reason.message || reason)) }
    }
    async function revealArchive(path) {
      if (!path) return
      try { await api(sessionId, 'reveal-archive', { path }); setMessage(`已在文件管理器中打开 ${path} 所在文件夹`) }
      catch (reason) { setError(String(reason.message || reason)) }
    }
    async function confirmArchiveDelete() {
      const path = pendingArchiveDelete
      if (!path) return
      try {
        await api(sessionId, 'delete-archive', { path })
        setSelectedArchive(current => current === path ? '' : current)
        setMessage(`已删除 ${path}`)
        refreshArchives()
      } catch (reason) { setError(String(reason.message || reason)) }
      finally { setPendingArchiveDelete('') }
    }
    async function ignoreDraft() {
      try { await draftCacheRef.current?.clear().catch(() => {}) } finally {
        localStorage.removeItem(`look2-draft:${sessionId}`)
        setDraft(null)
      }
    }
    async function recoverDraft() {
      if (stopIfLocked()) return
      abortPsdImport()
      try {
        if (draft?.format === 'archive') {
          await beforeAction()
          const result = await run(() => api(sessionId, 'import', { format: 'json', data: draft.data, filename: '浏览器草稿.save.json' }), 'recover')
          accept(result.snapshot)
        } else if (draft?.look2) await editState(next => Object.assign(next, draft.look2), '恢复浏览器草稿')
        else throw new Error('草稿格式不受支持')
        // Recovery is still unsaved work: keep the durable backup until save/load/ignore.
        scheduleDraft()
        resetTimelineUi()
        setDraft(null); setMessage('已恢复浏览器草稿；点击保存才会写入工作区文件')
      } catch (reason) { setError(String(reason.message || reason)) }
    }
    const errorDetails = error ? describeEditorError(error) : null
    const errorHistoryDialog = showErrors ? h('div', { className: 'look2-modal-backdrop', onClick: () => setShowErrors(false) },
      h('div', { className: 'look2-modal look2-error-history', role: 'dialog', 'aria-modal': true, 'aria-label': '错误历史', onClick: event => event.stopPropagation() },
        h('header', null, h('strong', null, `错误历史 / Error history (${errorLog.entries.length})`), h('span', { className: 'spacer' }),
          h('button', { onClick: () => setErrorLog(emptyErrorLog()) }, '清空记录 / Clear'),
          h('button', { onClick: () => setShowErrors(false), autoFocus: true }, '关闭 / Close')),
        h('div', { className: 'look2-error-list' },
          h('p', { className: 'look2-error-help' }, '最近 100 条记录；当前标签页刷新后保留。Repeated notifications within one second are grouped.'),
          errorLog.entries.length ? [...errorLog.entries].reverse().map(entry => {
            const detail = describeEditorError(entry.raw)
            return h('article', { key: entry.id, className: 'look2-error-entry' },
              h('div', { className: 'look2-error-time' }, new Date(entry.lastAt).toLocaleString('zh-CN', { hour12: false }), entry.count > 1 ? ` · 通知 ${entry.count} 次 / ${entry.count} notifications` : ''),
              h('p', { lang: 'zh-CN' }, h('strong', null, '中文：'), detail.zh),
              h('p', { lang: 'en' }, h('strong', null, 'English: '), detail.en),
              !detail.translated ? h('small', null, '未匹配到专用翻译，保留原始错误。No specific translation is available; the original error is preserved.') : null,
              h('details', null, h('summary', null, '原始错误 / Original error'), h('pre', null, detail.raw)))
          }) : h('p', null, '暂无错误记录 / No errors recorded.')))) : null
    const errorTrigger = h('button', { type: 'button', className: `look2-archive-status look2-error-trigger${error ? ' error' : ''}`,
      title: errorDetails ? `${errorDetails.zh}\n${errorDetails.en}\n点击查看错误历史 / View error history` : '查看错误历史 / View error history',
      'aria-label': '查看错误历史', 'aria-haspopup': 'dialog', 'aria-expanded': showErrors, onClick: () => setShowErrors(true) },
      errorDetails ? `${errorDetails.zh} / ${errorDetails.en}` : `错误历史 / Errors (${errorLog.entries.length})`)
    if (!snap) return h('div', { className: 'look2' }, error ? errorTrigger : '正在打开动画工作台…', errorHistoryDialog)
    const state = snap.look2
    const clientTemplates = snap.asset?.type === 'client-control-template'
    const clientSiteNodes = clientTemplates ? state.siteNodes || {} : {}
    const clientPrimitiveResources = clientTemplates ? state.primitiveResources || [] : []
    const active = state.animations.find(a => a.id === state.activeAnimationId) || state.animations[0]
    const duration = Math.max(.1, Number(active.duration || 5))
    const row = snap.tree.find(item => item.id === snap.selectedId)
    const treeRowById = new Map(snap.tree.map(item => [item.id, item]))
    const selectedFields = snap.inspector?.fields || []
    const controllerPlatform = inspectorPlatform.startsWith('CONTROLLER_')
    function findProjectNode(node, id) {
      if (!node) return null
      if (node.id === id) return node
      for (const child of node.children || []) { const found = findProjectNode(child, id); if (found) return found }
      return null
    }
    const platformNode = findProjectNode(snap.root, snap.selectedId)
    const platformTransform = platformNode?.transformByPlatform?.[inspectorPlatform] || null
    const primitiveNodeSelected = clientSiteNodes[snap.selectedId]?.type === 'primitive'
    const trackFieldOptions = TWEENABLE_FIELDS.filter(field => field.kinds.includes(row?.kind) && !(primitiveNodeSelected && ['imageColor', 'fillAmount'].includes(field.fieldKey)))
    const activeTrackField = trackFieldOptions.some(field => field.fieldKey === trackField) ? trackField : trackFieldOptions[0]?.fieldKey || ''
    const allTracks = active.keyframeTracks || []
    const events = active.events || []
    const previewBoxes = previewAnimation(snap.animationPreviewRoot, active, playhead, snap.canvas)
    const selectedTrack = allTracks.find(item => item.id === selectedKey?.trackId)
    const key = selectedTrack?.keyframes?.find(item => item.id === selectedKey?.keyId)
    const selectedEvent = events.find(event => event.id === selectedEventId)
    const eventNodeId = selectedEvent?.nodeId || nodeFromPath(selectedEvent?.target || '') || snap.animationPreviewRoot?.authoringId || ''
    const eventRootId = eventNodeId ? findTemplateRoot(snap, eventNodeId) : ''
    const eventScripts = eventRootId ? (snap.scripts || []).filter(script => script.controlAsset === snap.asset?.type
      && script.controlId && findTemplateRoot(snap, script.controlId) === eventRootId) : []
    const selectedHandler = selectedEvent?.handler || null
    const selectedHandlerScript = eventScripts.find(script => script.path === selectedHandler?.scriptPath && script.controlId === selectedHandler?.targetNodeId)
    const canvasFit = Math.max(.01, Math.min((stageSize.width - 30) / snap.canvas.width, (stageSize.height - 30) / snap.canvas.height))
    const stageScale = canvasFit * zoom
    const stageCssWidth = Math.max(1, snap.canvas.width * stageScale)
    const stageCssHeight = Math.max(1, snap.canvas.height * stageScale)
    const stageUnitX = Math.max(0, stageCssWidth - 2) / snap.canvas.width || stageScale
    const stageUnitY = Math.max(0, stageCssHeight - 2) / snap.canvas.height || stageScale
    const timelineContentWidth = Math.max(480, timelineWidth - 230, Math.round(duration * pixelsPerSecond))
    const totalTimelineWidth = 230 + timelineContentWidth
    const frameCount = Math.ceil(duration * state.frameRate)
    const frameStride = Math.max(1, Math.ceil(frameCount / 10))
    const frames = Array.from({ length: Math.floor(frameCount / frameStride) + 1 }, (_, index) => index * frameStride)
    if (frames[frames.length - 1] !== frameCount) frames.push(frameCount)
    const minorStep = Math.max(2, pixelsPerSecond * frameStride / state.frameRate)
    const selectedLocked = !!snap.editorLocks?.[snap.selectedId]
    function updateAnimation(fn, label = '编辑动画') {
      const animationId = active.id
      const promise = editState(next => { const target = next.animations.find(a => a.id === animationId); if (!target || next.activeAnimationId !== animationId) throw new Error('动画已删除或切换，请重新选择'); fn(target, next) }, label)
      // Detached UI actions still report through editState; mark their rejection handled while preserving it for awaited drafts.
      void promise.catch(() => {})
      return promise
    }
    function updateEvent(eventId, fn, label = '编辑事件') { return updateAnimation(animation => { const event = (animation.events || []).find(item => item.id === eventId); if (!event) throw new Error('事件已删除，请重新选择'); fn(event) }, label) }
    function defaultValueForTrack(field, base) {
      if (field === 'visible') return base?.visible !== false
      if (field === 'groupAlpha') return Number(base?.groupAlpha ?? 255)
      if (/Color$/.test(field)) return base?.[field] && typeof base[field] === 'object' ? clone(base[field]) : { r: 255, g: 255, b: 255, a: 1 }
      if (field.startsWith('localScale')) return Number(base?.[field] ?? 1)
      return Number(base?.[field] ?? 0)
    }
    function addTrack() {
      if (!row || !trackFieldOptions.some(field => field.fieldKey === activeTrackField)) return
      const existing = allTracks.find(track => track.nodeId === row.id && track.fieldKey === activeTrackField)
      if (existing) {
        const first = existing.keyframes?.[0]
        if (first) {
          setSelectedKey({ trackId: existing.id, keyId: first.id })
          setSelectedKeys([{ trackId: existing.id, keyId: first.id }])
          setSelectedEventId(null)
        }
        return
      }
      let created = null
      const animationId = active.id
      void updateAnimation(animation => {
        animation.keyframeTracks ||= []
        if (animation.keyframeTracks.some(track => track.nodeId === row.id && track.fieldKey === activeTrackField)) throw new Error('该控件已有相同属性轨道')
        const base = previewBoxes.find(box => box.id === row.id)?.base
        const value = defaultValueForTrack(activeTrackField, base)
        created = { id: uid('track'), nodeId: row.id, fieldKey: activeTrackField,
          keyframes: [{ id: uid('key'), time: snapTime(playhead), value, relative: false, easeType: 'Linear', interpolation: activeTrackField === 'visible' ? 'step' : 'tween' }] }
        animation.keyframeTracks.push(created)
      }, '新增動畫軌道').then(result => {
        if (!created || result?.look2?.activeAnimationId !== animationId) return
        setSelectedKey({ trackId: created.id, keyId: created.keyframes[0].id })
        setSelectedKeys([{ trackId: created.id, keyId: created.keyframes[0].id }])
        setSelectedEventId(null)
      }).catch(() => {})
    }
    function snapTime(value) {
      const bounded = Math.max(0, Math.min(duration, Number(value) || 0))
      return Number((state.timelineSnapEnabled ? Math.round(bounded * state.frameRate) / state.frameRate : bounded).toFixed(4))
    }
    function addKeyframe(track, requestedTime = playhead) {
      const time = snapTime(requestedTime)
      const animationId = active.id
      const existing = track.keyframes?.find(item => Math.abs(Number(item.time) - time) < .0001)
      if (existing) {
        setPlayhead(time)
        setSelectedKey({ trackId: track.id, keyId: existing.id })
        setSelectedKeys([{ trackId: track.id, keyId: existing.id }])
        setSelectedEventId(null)
        return
      }
      let created = null
      void updateAnimation(animation => {
        const target = animation.keyframeTracks?.find(item => item.id === track.id)
        if (!target) throw new Error('轨道已删除，请重新选择')
        if (target.keyframes.some(item => Math.abs(Number(item.time) - time) < .0001)) throw new Error('该时刻已有关键帧，请重新选择')
        const base = defaultValueForTrack(target.fieldKey, previewBoxes.find(box => box.id === track.nodeId)?.base)
        const value = sampleTrack(target, time, base) ?? base
        created = { id: uid('key'), time, value, relative: false, easeType: 'Linear', interpolation: target.fieldKey === 'visible' ? 'step' : 'tween' }
        target.keyframes.push(created)
        target.keyframes.sort((a, b) => a.time - b.time)
      }, '新增关键帧').then(result => {
        if (!created || result?.look2?.activeAnimationId !== animationId) return
        setPlayhead(time)
        setSelectedKey({ trackId: track.id, keyId: created.id })
        setSelectedKeys([{ trackId: track.id, keyId: created.id }])
        setSelectedEventId(null)
      }).catch(() => {})
    }
    function addKeyframeAt(trackId, requestedTime) {
      void run(async () => {
        const current = snapRef.current
        if (!current) return
        const currentState = current.look2
        const animation = currentState.animations.find(item => item.id === currentState.activeAnimationId) || currentState.animations[0]
        const track = animation?.keyframeTracks?.find(item => item.id === trackId)
        if (!animation || !track) return
        const time = snapTime(requestedTime)
        const existing = track.keyframes.find(item => Math.abs(Number(item.time) - time) < .0001)
        if (existing) {
          setPlayhead(time)
          setSelectedKey({ trackId, keyId: existing.id })
          setSelectedKeys([{ trackId, keyId: existing.id }])
          setSelectedEventId(null)
          return
        }

        const nextState = clone(currentState)
        const nextAnimation = nextState.animations.find(item => item.id === animation.id)
        const nextTrack = nextAnimation.keyframeTracks.find(item => item.id === trackId)
        const preview = previewAnimation(current.animationPreviewRoot, animation, time, current.canvas)
        const base = defaultValueForTrack(nextTrack.fieldKey, preview.find(box => box.id === nextTrack.nodeId)?.base)
        const value = sampleTrack(nextTrack, time, base) ?? base
        const created = { id: uid('key'), time, value, relative: false, easeType: 'Linear', interpolation: nextTrack.fieldKey === 'visible' ? 'step' : 'tween' }
        nextTrack.keyframes.push(created)
        nextTrack.keyframes.sort((a, b) => a.time - b.time)
        const next = await api(sessionId, 'transaction', { label: '新增关键帧', state: nextState, expectedRevision: current.version })
        setError('')
        scheduleDraft()
        accept(next)
        if (snapRef.current?.look2?.activeAnimationId !== animation.id) return
        setPlayhead(time)
        setSelectedKey({ trackId, keyId: created.id })
        setSelectedKeys([{ trackId, keyId: created.id }])
        setSelectedEventId(null)
      }, `keyframe:add:${trackId}`).catch(reason => setError(String(reason.message || reason)))
    }
    function updateKey(field, value) {
      return updateKeyValues({ [field]: value })
    }
    function updateKeyValues(values) {
      if (!selectedKey) return Promise.reject(new Error('未选择关键帧'))
      return updateAnimation(animation => {
        const target = animation.keyframeTracks.find(item => item.id === selectedKey.trackId)?.keyframes.find(item => item.id === selectedKey.keyId)
        if (!target) throw new Error('关键帧已删除；请重新选择')
        const updates = typeof values === 'function' ? values(target) : values
        for (const [field, value] of Object.entries(updates)) {
          const nextValue = typeof value === 'function' ? value(target[field]) : value
          if (typeof nextValue === 'number' && !Number.isFinite(nextValue)) throw new Error('关键帧数值必须是有限数字')
          target[field] = field === 'time' ? snapTime(nextValue) : nextValue
        }
      }, '编辑关键帧')
    }
    function removeSelectedKeys() {
      if (!selectedKeys.length) return
      const animationId = active.id
      const ids = new Map()
      for (const item of selectedKeys) { const list = ids.get(item.trackId) || new Set(); list.add(item.keyId); ids.set(item.trackId, list) }
      void updateAnimation(animation => {
        let removed = 0
        animation.keyframeTracks = animation.keyframeTracks.filter(track => {
          const remove = ids.get(track.id)
          if (remove) {
            const before = track.keyframes.length
            track.keyframes = track.keyframes.filter(item => !remove.has(item.id))
            removed += before - track.keyframes.length
            if (before > track.keyframes.length && track.keyframes.length === 0) return false
          }
          return true
        })
        if (!removed) throw new Error('选中关键帧已删除，请重新选择')
      }, '删除关键帧').then(result => {
        if (result?.look2?.activeAnimationId !== animationId) return
        setSelectedKey(current => current && ids.get(current.trackId)?.has(current.keyId) ? null : current)
        setSelectedKeys(current => current.filter(item => !ids.get(item.trackId)?.has(item.keyId)))
      }).catch(() => {})
    }
    function copySelectedKeys() {
      const ids = new Map()
      for (const item of selectedKeys) { const set = ids.get(item.trackId) || new Set(); set.add(item.keyId); ids.set(item.trackId, set) }
      keyClipboardRef.current = allTracks.flatMap(track => (track.keyframes || []).filter(item => ids.get(track.id)?.has(item.id)).map(item => ({
        trackId: track.id, nodeId: track.nodeId, fieldKey: track.fieldKey, time: item.time, key: clone(item),
      })))
      if (keyClipboardRef.current.length) setMessage(`已复制 ${keyClipboardRef.current.length} 个关键帧`)
    }
    async function pasteKeys() {
      const clipboard = keyClipboardRef.current
      if (!clipboard.length) return
      const origin = Math.min(...clipboard.map(item => item.time))
      const created = []
      const animationId = active.id
      let result
      try { result = await updateAnimation(animation => {
        for (const entry of clipboard) {
          let target = animation.keyframeTracks.find(track => track.id === entry.trackId)
          if (!target) target = animation.keyframeTracks.find(track => track.nodeId === entry.nodeId && track.fieldKey === entry.fieldKey)
          if (!target) continue
          const copy = { ...clone(entry.key), id: uid('key'), time: snapTime(playhead + entry.time - origin) }
          target.keyframes = target.keyframes.filter(item => Math.abs(item.time - copy.time) >= .0001)
          target.keyframes.push(copy); target.keyframes.sort((a, b) => a.time - b.time); created.push({ trackId: target.id, keyId: copy.id })
        }
        if (!created.length) throw new Error('没有可粘贴的目标轨道，请重新选择')
      }, '粘贴关键帧') } catch { return }
      if (created.length && result?.look2?.activeAnimationId === animationId) {
        setSelectedKeys(created); setSelectedKey(created[created.length - 1]); setSelectedEventId(null)
        setMessage(`已粘贴 ${created.length} 个关键帧`)
      }
    }
    function removeTrack(trackId) {
      const animationId = active.id
      void updateAnimation(animation => {
        if (!animation.keyframeTracks.some(track => track.id === trackId)) throw new Error('轨道已删除，请重新选择')
        animation.keyframeTracks = animation.keyframeTracks.filter(track => track.id !== trackId)
      }, '删除动画轨道').then(result => {
        if (result?.look2?.activeAnimationId !== animationId) return
        setSelectedKey(current => current?.trackId === trackId ? null : current)
        setSelectedKeys(current => current.filter(item => item.trackId !== trackId))
      }).catch(() => {})
    }
    function addEvent(requestedTime = playhead) {
      const id = uid('event')
      const time = snapTime(requestedTime)
      const animationId = active.id
      const nodeId = row?.kind === 'server-container' ? snap.animationPreviewRoot?.authoringId || '' : snap.selectedId || ''
      void updateAnimation(animation => { animation.events ||= []; animation.events.push({ id, time, name: '触发事件', nodeId, target: nodePath(nodeId), params: '' }) }, '新增事件')
        .then(result => {
          if (result?.look2?.activeAnimationId !== animationId) return
          setPlayhead(time)
          setSelectedEventId(id)
          setSelectedKey(null)
          setSelectedKeys([])
        }).catch(() => {})
    }
    function removeEvent(eventId) {
      const animationId = active.id
      void updateAnimation(animation => {
        if (!(animation.events || []).some(event => event.id === eventId)) throw new Error('事件已删除，请重新选择')
        animation.events = animation.events.filter(event => event.id !== eventId)
      }, '删除事件')
        .then(result => {
          if (result?.look2?.activeAnimationId !== animationId) return
          setSelectedEventId(current => current === eventId ? null : current)
        }).catch(() => {})
    }
    function addAnimation() {
      let createdId = ''
      void editState(next => {
        const animation = { id: uid('animation'), name: `动画 ${next.animations.length + 1}`, duration: 5, keyframeTracks: [], events: [] }
        next.animations.push(animation)
        next.activeAnimationId = animation.id
        createdId = animation.id
      }, '新增动画').then(result => {
        if (!createdId || result?.look2?.activeAnimationId !== createdId) return
        setPlayhead(0); setSelectedKey(null); setSelectedKeys([]); setSelectedEventId(null)
      }).catch(() => {})
    }
    function duplicateAnimation(id) {
      let copyId = ''
      void editState(next => {
        const source = next.animations.find(animation => animation.id === id)
        if (!source) throw new Error('动画已删除，请重新选择')
        const copy = clone(source); copy.id = uid('animation'); copy.name = `${source.name} 副本`
        for (const track of copy.keyframeTracks || []) { track.id = uid('track'); for (const keyframe of track.keyframes || []) keyframe.id = uid('key') }
        for (const event of copy.events || []) event.id = uid('event')
        next.animations.push(copy); next.activeAnimationId = copy.id
        copyId = copy.id
      }, '复制动画').then(result => {
        if (!copyId || result?.look2?.activeAnimationId !== copyId) return
        setPlayhead(0); setSelectedKey(null); setSelectedKeys([]); setSelectedEventId(null)
      }).catch(() => {})
    }
    function removeAnimation(id) {
      if (state.animations.length <= 1) { setError('至少保留一个动画'); return }
      let changedActive = false
      void editState(next => {
        if (!next.animations.some(animation => animation.id === id)) throw new Error('动画已删除，请重新选择')
        if (next.animations.length <= 1) throw new Error('至少保留一个动画')
        changedActive = next.activeAnimationId === id
        next.animations = next.animations.filter(animation => animation.id !== id)
        if (changedActive) next.activeAnimationId = next.animations[0].id
      }, '删除动画')
        .then(result => {
          if (!changedActive || !result?.look2?.activeAnimationId) return
          setPlayhead(0); setSelectedKey(null); setSelectedKeys([]); setSelectedEventId(null)
        })
        .catch(() => {})
    }
    function addControl(kind) {
      if (kind === 'primitive' && snapRef.current?.asset?.type !== 'client-control-template') { setError('图元控件仅适用于客户端控件模板'); return }
      if (stopIfLocked()) return
      const assetType = snapRef.current.asset.type
      return beforeAction().then(() => transact('新增控件', { blockOnFailure: false, guard: current => {
        if (current.asset.type !== assetType) throw new Error('编辑资产已切换，请重新添加控件')
      }, prepare: current => {
        const selected = current.tree.find(item => item.id === current.selectedId)
        const isRoot = current.asset.type === 'client-control-template' && kind === 'container' && (!selected || selected.depth === 0)
        const previewRootId = current.animationPreviewRoot?.authoringId
        const fallbackParentId = current.tree.some(item => item.id === previewRootId && item.kind !== 'server-container') ? previewRootId : current.root.id
        const op = isRoot ? { op: 'addTemplate', kind, name: '容器节点' }
          : { op: 'add', kind, parentId: selected?.id || fallbackParentId, resolveParent: true,
            name: { textbox: '文本框', image: '图片', primitive: '图元图片', button: '预设按钮', container: '容器节点' }[kind] || kind }
        return { ops: [op] }
      } })).catch(reason => setError(String(reason.message || reason)))
    }
    function duplicateControl(id) {
      const item = snap.tree.find(control => control.id === id)
      if (!item) return
      void patch({ op: 'duplicate', id, parentId: item.parentId }, '复制控件')
    }
    function deleteControl(id) {
      if (!id || stopIfLocked()) return
      const assetType = snapRef.current.asset.type
      return beforeAction().then(() => transact('删除控件', {
        ops: [{ op: 'remove', id }],
        guard: current => {
          if (current.asset.type !== assetType) throw new Error('编辑资产已切换，请重新选择要删除的控件')
        },
      })).then(result => {
        const ids = new Set(result.tree.map(item => item.id))
        setHiddenNodes(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${assetType}:`) || ids.has(key.slice(assetType.length + 1)))))
        return result
      }).catch(reason => setError(String(reason.message || reason)))
    }
    const hiddenNodeKey = id => `${snap.asset?.type}:${id}`
    function isNodeHidden(id) {
      return [id, ...(treeRowById.get(id)?.ancestorIds || [])].some(nodeId => hiddenNodes[hiddenNodeKey(nodeId)])
    }
    function setNodeHidden(id) {
      const key = hiddenNodeKey(id)
      setHiddenNodes(current => ({ ...current, [key]: !current[key] }))
    }
    function setNodeLocked(id, locked) { void patch({ op: 'setEditorLock', id, locked: !!locked }, locked ? '锁定控件' : '解锁控件') }
    function moveNode(id, direction) {
      const assetType = snapRef.current.asset.type
      return beforeAction().then(() => transact({ up: '上移控件', down: '下移控件', top: '置顶控件', bottom: '置底控件' }[direction], {
        ops: [{ op: 'moveSibling', id, direction }],
        guard: current => {
          if (current.asset.type !== assetType) throw new Error('编辑资产已切换，请重新选择要调整层序的控件')
        },
      }))
        .catch(reason => setError(String(reason.message || reason)))
    }
    function reparentNode(id, parentId) {
      if (id === parentId || stopIfLocked()) return
      const assetType = snapRef.current.asset.type
      return beforeAction().then(() => transact('调整控件层级', { ops: [{ op: 'reparent', id, parentId }], guard: current => {
        if (current.asset.type !== assetType) throw new Error('编辑资产已切换，请重新选择要调整层级的控件')
      } })).catch(reason => setError(String(reason.message || reason)))
    }
    function treeDrop(event, target) {
      event.preventDefault(); setTreeDragOver('')
      const id = event.dataTransfer.getData('text/look2-node')
      if (!id || id === target.id) return
      if (stopIfLocked()) return
      const rect = event.currentTarget.getBoundingClientRect()
      const inside = ['container', 'server-container'].includes(target.kind) && event.clientY >= rect.top + rect.height * .25 && event.clientY <= rect.bottom - rect.height * .25
      if (inside) return reparentNode(id, target.id)
      const after = event.clientY > rect.top + rect.height / 2
      const assetType = snapRef.current.asset.type
      return beforeAction().then(() => transact('调整控件顺序', { blockOnFailure: false, guard: current => {
        if (current.asset.type !== assetType) throw new Error('编辑资产已切换，请重新选择要调整层级的控件')
      }, prepare: current => {
        const parentOf = nodeId => {
          const row = current.tree.find(item => item.id === nodeId)
          return row?.parentId ? findProjectNode(current.root, row.parentId)
            : current.root.children?.some(node => node.id === nodeId) ? current.root : null
        }
        const sourceParent = parentOf(id), targetParent = parentOf(target.id)
        if (!sourceParent || !targetParent) return { skip: true }
        const sameParent = sourceParent.id === targetParent.id
        const siblings = targetParent.children.filter(node => node.id !== id)
        const targetIndex = siblings.findIndex(node => node.id === target.id) + (after ? 1 : 0)
        const sourceIndex = sameParent ? sourceParent.children.findIndex(node => node.id === id) : siblings.length
        const direction = sourceIndex > targetIndex ? 'up' : 'down'
        const ops = sameParent ? [] : [{ op: 'reparent', id, parentId: targetParent.id }]
        ops.push(...Array.from({ length: Math.abs(sourceIndex - targetIndex) }, () => ({ op: 'moveSibling', id, direction })))
        return ops.length ? { ops } : { skip: true }
      } })).catch(reason => setError(String(reason.message || reason)))
    }
    function contextFor(event, type, data) {
      event.preventDefault(); event.stopPropagation()
      if (interactionLocked) return
      setContextMenu({ type, data, x: Math.max(4, Math.min(window.innerWidth - 180, event.clientX)), y: Math.max(4, Math.min(window.innerHeight - 260, event.clientY)) })
    }
    function selectedKeyEntries() {
      const ids = new Set(selectedKeys.map(item => `${item.trackId}:${item.keyId}`))
      return allTracks.flatMap(track => (track.keyframes || []).filter(item => ids.has(`${track.id}:${item.id}`)).map(item => ({ track, key: item })))
    }
    function selectKey(trackId, keyId, event) {
      const item = { trackId, keyId }
      if (event.ctrlKey || event.metaKey || event.shiftKey) setSelectedKeys(rows => rows.some(row => row.trackId === trackId && row.keyId === keyId) ? rows.filter(row => row.trackId !== trackId || row.keyId !== keyId) : [...rows, item])
      else setSelectedKeys([item])
      setSelectedKey(item)
    }
    function startKeyDrag(event, track, item) {
      if (event.button != null && event.button !== 0) return
      event.stopPropagation()
      const target = { trackId: track.id, keyId: item.id }
      const contains = selectedKeys.some(key => key.trackId === track.id && key.keyId === item.id)
      const modified = event.ctrlKey || event.metaKey || event.shiftKey
      const selected = modified
        ? contains ? selectedKeys.filter(key => key.trackId !== track.id || key.keyId !== item.id) : [...selectedKeys, target]
        : contains ? selectedKeys : [target]
      setSelectedKeys(selected)
      setSelectedKey(selected.some(key => key.trackId === track.id && key.keyId === item.id) ? target : selected[selected.length - 1] || null)
      setSelectedEventId(null); setPlayhead(item.time)
      dragRef.current = selected.some(key => key.trackId === track.id && key.keyId === item.id)
        ? { type: 'keys', x: event.clientX, time: item.time, selected }
        : null
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    function finishKeyDrag(event) {
      const drag = dragRef.current
      if (!drag || drag.type !== 'keys') return
      dragRef.current = null
      const delta = (event.clientX - drag.x) / pixelsPerSecond
      if (Math.abs(delta) < .01) return
      const initialPlan = planKeyframeDrag(active, drag.selected, delta, duration, state.frameRate, state.timelineSnapEnabled)
      if (initialPlan.error) { setError(initialPlan.error); return }
      if (!initialPlan.moves.length) return
      void updateAnimation(animation => {
        const plan = planKeyframeDrag(animation, drag.selected, delta, animation.duration, state.frameRate, state.timelineSnapEnabled)
        if (plan.error || !plan.moves.length) throw new Error(plan.error || '关键帧位置已变化，请重新拖动')
        const movesByTrack = new Map()
        for (const move of plan.moves) {
          if (!movesByTrack.has(move.trackId)) movesByTrack.set(move.trackId, new Map())
          movesByTrack.get(move.trackId).set(move.keyId, move.nextTime)
        }
        for (const track of animation.keyframeTracks) {
          const updated = movesByTrack.get(track.id)
          if (!updated) continue
          for (const item of track.keyframes) if (updated.has(item.id)) item.time = updated.get(item.id)
          track.keyframes.sort((a, b) => a.time - b.time)
        }
      }, '移动关键帧').then(() => setPlayhead(snapTime(drag.time + initialPlan.shift))).catch(() => {})
    }
    function stageWorldPoint(event) {
      const stage = event.currentTarget.closest('.look2-stage') || stageWrapRef.current?.querySelector('.look2-stage')
      const rect = stage?.getBoundingClientRect()
      if (!rect || !snapRef.current) return { x: 0, y: 0 }
      const current = snapRef.current.canvas
      return { x: (event.clientX - rect.left) * current.width / rect.width, y: current.height - (event.clientY - rect.top) * current.height / rect.height }
    }
    function parentMatrixFor(id) {
      const item = snap.tree.find(control => control.id === id)
      const parent = item && previewBoxes.find(box => box.id === item.parentId)
      return parent?.matrix || identityMatrix()
    }
    function beginStageGesture(event, box, type = 'move', handle = '') {
      if (event.button === 1) return
      if (editMode === 'hand' && type === 'hand') return
      event.stopPropagation()
      const item = snap.tree.find(control => control.id === box.id)
      if (snap.editorLocks?.[box.id]) return
      if (inspectorPlatform.startsWith('CONTROLLER_')) { void selectControl(box.id); return }
      if (snap.canvas.platform !== inspectorPlatform) { setMessage('Switching preview device; wait for the canvas to update before dragging.'); return }
      const world = stageWorldPoint(event)
      const parentInverse = invertMatrix(parentMatrixFor(box.id)) || identityMatrix()
      const parentLocal = applyMatrix(parentInverse, world.x, world.y)
      const inverse = invertMatrix(box.matrix) || identityMatrix()
      const local = applyMatrix(inverse, world.x, world.y)
      const projectNode = findProjectNode(snap.root, box.id)
      const baseTransform = projectNode?.transformByPlatform?.[inspectorPlatform]
      const pivot = baseTransform?.pivot || { x: 0.5, y: 0.5 }
      const pivotWorld = applyMatrix(box.matrix, box.left + box.width * pivot.x, box.bottom + box.height * pivot.y)
      const centerLocal = applyMatrix(parentInverse, pivotWorld.x, pivotWorld.y)
      dragRef.current = { type, id: box.id, handle, startWorld: world, startLocal: local, startParentLocal: parentLocal,
        centerLocal, baseBox: box, startAngle: Math.atan2(parentLocal.y - centerLocal.y, parentLocal.x - centerLocal.x),
        startRotation: Number(baseTransform?.rotation?.z ?? box.base?.localRotationZ ?? box.localRotationZ ?? 0), platform: inspectorPlatform, moved: false }
      event.currentTarget.setPointerCapture?.(event.pointerId)
      void selectControl(box.id)
    }
    function finishStageGesture(event) {
      const drag = dragRef.current; dragRef.current = null
      if (!drag || !snapRef.current) return
      const currentSnap = snapRef.current
      if (currentSnap.canvas?.platform !== drag.platform) return
      const projectNode = findProjectNode(currentSnap.root, drag.id)
      const sourceTransform = projectNode?.transformByPlatform?.[drag.platform]
      if (!sourceTransform) return
      let transform = clone(sourceTransform)
      const current = stageWorldPoint(event)
      const moved = Math.hypot(current.x - drag.startWorld.x, current.y - drag.startWorld.y)
      if (moved < 1.5) return
      const ops = [{ op: 'setPlatformTransform', id: drag.id, platform: drag.platform, transform }]
      if (drag.type === 'move') {
        const invParent = invertMatrix(parentMatrixFor(drag.id)) || identityMatrix()
        const end = applyMatrix(invParent, current.x, current.y)
        const dx = end.x - drag.startParentLocal.x, dy = end.y - drag.startParentLocal.y
        transform.offset = { ...transform.offset, x: Number(transform.offset?.x || 0) + dx, y: Number(transform.offset?.y || 0) + dy }
      } else if (drag.type === 'rotate') {
        const invParent = invertMatrix(parentMatrixFor(drag.id)) || identityMatrix()
        const end = applyMatrix(invParent, current.x, current.y)
        const angle = Math.atan2(end.y - drag.centerLocal.y, end.x - drag.centerLocal.x)
        const delta = (angle - drag.startAngle) * 180 / Math.PI
        transform.rotation = { ...transform.rotation, z: drag.startRotation + delta }
      } else if (drag.type === 'resize') {
        const local = applyMatrix(invertMatrix(drag.baseBox.matrix) || identityMatrix(), current.x, current.y)
        const dx = local.x - drag.startLocal.x, dy = local.y - drag.startLocal.y
        const sx = drag.handle.includes('e') ? 1 : drag.handle.includes('w') ? -1 : 0
        const sy = drag.handle.includes('n') ? 1 : drag.handle.includes('s') ? -1 : 0
        const layout = layoutTree(currentSnap.root, projectCanvas(currentSnap), drag.platform)
        const box = layout.boxes[drag.id]
        if (!box) return
        const parentId = currentSnap.tree.find(item => item.id === drag.id)?.parentId
        const parentNode = parentId ? findProjectNode(currentSnap.root, parentId) : null
        const parentBox = parentNode && parentNode.kind !== 'server-container' ? layout.boxes[parentId] : layout.canvas
        if (!parentBox) return
        const width = Math.max(1, box.width + sx * dx)
        const height = Math.max(1, box.height + sy * dy)
        const fixedX = sx > 0 ? 0 : sx < 0 ? 1 : .5
        const fixedY = sy > 0 ? 0 : sy < 0 ? 1 : .5
        const fixedBefore = applyMatrix(localRectMatrix(box, transform),
          box.left + box.width * fixedX, box.bottom + box.height * fixedY)
        const resized = applyInspectorToTransform(parentBox, transform, {
          posX: box.centerX, posY: box.centerY, width, height,
        })
        const resizedBox = computeRect(parentBox, resized)
        const fixedAfter = applyMatrix(localRectMatrix(resizedBox, resized),
          resizedBox.left + width * fixedX, resizedBox.bottom + height * fixedY)
        // Keep the opposite visual edge or corner fixed, including rotation,
        // scale, off-center pivots and a drag beyond the minimum size.
        Object.assign(transform, applyInspectorToTransform(parentBox, resized, {
          posX: resizedBox.centerX + fixedBefore.x - fixedAfter.x,
          posY: resizedBox.centerY + fixedBefore.y - fixedAfter.y,
          width, height,
        }))
      }
      if (ops.length) void transact(drag.type === 'move' ? '移动控件' : drag.type === 'rotate' ? '旋转控件' : '调整控件尺寸', { ops })
    }
    function onStageWheel(event) {
      event.preventDefault()
      const scale = event.deltaY < 0 ? 1.1 : 1 / 1.1
      const next = Math.max(.15, Math.min(6, zoom * scale))
      const rect = stageWrapRef.current?.getBoundingClientRect()
      if (rect) {
        const cx = event.clientX - (rect.left + rect.width / 2) - pan.x
        const cy = event.clientY - (rect.top + rect.height / 2) - pan.y
        const ratio = next / zoom
        setPan(current => ({ x: current.x - cx * (ratio - 1), y: current.y - cy * (ratio - 1) }))
      }
      setZoom(next)
    }
    function updateStagePointer(event) {
      const stage = stageWrapRef.current?.querySelector('.look2-stage')
      const rect = stage?.getBoundingClientRect()
      if (!rect || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        setStagePointer(current => current === null ? current : null)
        return
      }
      const canvas = snapRef.current?.canvas
      if (!canvas) return
      const x = Math.max(0, Math.min(canvas.width, Math.round((event.clientX - rect.left) * canvas.width / rect.width)))
      const y = Math.max(0, Math.min(canvas.height, Math.round(canvas.height - (event.clientY - rect.top) * canvas.height / rect.height)))
      setStagePointer(current => current?.x === x && current?.y === y ? current : { x, y })
    }
    function startPan(event) {
      if (event.button !== 1 && !(event.button === 0 && editMode === 'hand')) {
        if (event.button === 0 && (event.target === event.currentTarget || event.target.classList?.contains('look2-stage'))) {
          void selectControl('', '取消选中控件')
        }
        return
      }
      event.preventDefault(); panRef.current = { x: event.clientX, y: event.clientY, pan }; event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    function movePointer(event) {
      if (event.target?.closest?.('.look2-stage')) updateStagePointer(event)
      else setStagePointer(current => current === null ? current : null)
      if (panelResizeRef.current) {
        const resize = panelResizeRef.current, delta = event.clientX - resize.x
        if (resize.kind === 'tree') setPanelWidths(value => ({ ...value, tree: Math.max(180, Math.min(420, resize.width + delta)) }))
        if (resize.kind === 'animator') setPanelWidths(value => ({ ...value, animator: Math.max(140, Math.min(340, resize.width - delta)) }))
        if (resize.kind === 'inspector') setPanelWidths(value => ({ ...value, inspector: Math.max(230, Math.min(430, resize.width - delta)) }))
        if (resize.kind === 'timeline') setTimelineHeight(Math.max(145, Math.min(420, resize.height + resize.y - event.clientY)))
      }
      if (panRef.current) { const drag = panRef.current; setPan({ x: drag.pan.x + event.clientX - drag.x, y: drag.pan.y + event.clientY - drag.y }) }
    }
    function endPointer() { panelResizeRef.current = null; panRef.current = null }
    function cancelPointer() { endPointer(); dragRef.current = null }
    function startPanelResize(event, kind) {
      event.preventDefault(); event.stopPropagation()
      const widthKey = kind === 'tree' ? 'tree' : kind
      panelResizeRef.current = { kind, x: event.clientX, width: panelWidths[widthKey] }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    function startTimelineResize(event) {
      event.preventDefault(); panelResizeRef.current = { kind: 'timeline', y: event.clientY, height: timelineHeight }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    async function importTemplate(file) {
      if (stopIfLocked()) return
      if (!file) return
      try {
        const assetType = snapRef.current?.asset?.type
        if (assetType !== 'client-control-template') throw new Error('控件模板只能导入客户端模板资产')
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        const result = await run(() => {
          if (snapRef.current?.asset?.type !== assetType) throw new Error('编辑资产已切换，请重新导入模板')
          return api(sessionId, 'template', { action: 'import', data: btoa(binary), name: file.name.replace(/\.gia$/i, ''), expectedRevision: snapRef.current.version })
        }, 'template:import')
        accept(result); scheduleDraft(); setMessage(`已加入模板 ${file.name}`)
      } catch (reason) { setError(String(reason.message || reason)) }
    }
    function updateTemplate(id, values) {
      if (stopIfLocked()) return Promise.reject(new Error(readOnlyMessage))
      return run(async () => {
        const current = snapRef.current
        let result
        try { result = await api(sessionId, 'template', { action: 'update', id, ...values, expectedRevision: current.version }) }
        catch (reason) { await refreshRevisionForRetry(reason, current); throw reason }
        const next = accept(result)
        scheduleDraft()
        return next
      }, `template:update:${id}`).catch(reason => { setError(String(reason.message || reason)); throw reason })
    }
    async function removeTemplate(id) {
      if (stopIfLocked()) return
      try { const result = await run(() => api(sessionId, 'template', { action: 'remove', id, expectedRevision: snapRef.current.version }), `template:remove:${id}`); accept(result); scheduleDraft() }
      catch (reason) { setError(String(reason.message || reason)) }
    }
    async function instantiateTemplate(template) {
      if (stopIfLocked()) return
      try {
        const result = await run(() => api(sessionId, 'template', { action: 'instantiate', id: template.id, parentId: row?.id || snap.tree[0]?.id, index: template.index, expectedRevision: snapRef.current.version }), `template:instantiate:${template.id}`)
        accept(result); scheduleDraft(); setShowTemplates(false); setMessage(`已实例化模板 ${template.name}`)
      } catch (reason) { setError(String(reason.message || reason)) }
    }
    function keyDownEditor(event) {
      if (showErrors) return
      if (interactionLocked) {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.preventDefault()
        return
      }
      const target = event.target
      if (target && (target.matches('input,textarea,select') || target.isContentEditable)) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoAction() : undo(); return }
      if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redoAction(); return }
      if (mod && event.key.toLowerCase() === 'c' && selectedKeys.length) { event.preventDefault(); copySelectedKeys(); return }
      if (mod && event.key.toLowerCase() === 'v' && keyClipboardRef.current.length) { event.preventDefault(); pasteKeys(); return }
      if (mod && event.key.toLowerCase() === 'd' && selectedKeys.length) { event.preventDefault(); copySelectedKeys(); pasteKeys(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { if (selectedKeys.length) { event.preventDefault(); removeSelectedKeys() } }
    }
    hotkeyRef.current = keyDownEditor
    function worldCenter(box) { return applyMatrix(box.matrix || identityMatrix(), box.centerX, box.centerY) }
    function stageImageSource(box) {
      const original = clientSiteNodes[box.id]
      const resourceId = original?.properties?.imageResourceId ?? original?.properties?.primitiveResourceId
      const resource = clientPrimitiveResources.find(item => item.id === resourceId)
      const fitted = !!resource && resource.previewMode === 'fit' && resource.fitData
      const officialId = original?.properties?.imageId ?? box.base?.imageId ?? box.imageId
      const source = original?.properties?.imageSource ?? box.base?.imageSource
      const officialUrl = source === 'StaticReference' && Number.isSafeInteger(Number(officialId)) && Number(officialId) >= 0 ? `/look2-assets/sprite/${Number(officialId)}.png` : ''
      const src = fitted ? primitivePreviewSource(resource.fitData) : resource?.imageUrl || resource?.dataUrl || officialUrl
      const imageType = String(original?.properties?.imageType ?? box.imageType ?? box.base?.imageType ?? '').toLowerCase()
      const borderUrl = officialUrl && imageType === 'stretch' ? `/look2-assets/border/${Number(officialId)}.json` : ''
      return { src, resource, original, borderUrl, fitContain: !!fitted }
    }
    function stageBoxStyle(box) {
      const matrix = box.matrix || identityMatrix()
      return { left: `${100 * box.topLeft.x / snap.canvas.width}%`, top: `${100 * (snap.canvas.height - box.topLeft.y) / snap.canvas.height}%`,
        width: `${100 * Math.max(0, box.width) / snap.canvas.width}%`, height: `${100 * Math.max(0, box.height) / snap.canvas.height}%`,
        transform: stageCssMatrix(matrix), transformOrigin: 'top left', opacity: 1,
        background: 'transparent' }
    }
    function stageCssMatrix(matrix) {
      const sx = stageUnitX, sy = stageUnitY
      return `matrix(${matrix.a},${-sy / sx * matrix.b},${-sx / sy * matrix.c},${matrix.d},0,0)`
    }
    function stageNestedBoxStyle(box, parent) {
      const local = localRectMatrix(box, box)
      const localTopLeft = applyMatrix(local, box.left, box.top)
      return { left: `${(localTopLeft.x - parent.left) * stageUnitX}px`, top: `${-(localTopLeft.y - parent.top) * stageUnitY}px`,
        width: `${Math.max(0, box.width) * stageUnitX}px`, height: `${Math.max(0, box.height) * stageUnitY}px`,
        transform: stageCssMatrix(local), transformOrigin: 'top left', opacity: 1, background: 'transparent' }
    }
    function stageBoxAlpha(box) {
      const alpha = Number(box.alpha ?? 1)
      return alpha > 1 ? alpha / 255 : alpha
    }
    function stageBoxContentStyle(box) { return { opacity: stageBoxAlpha(box) } }
    function rgbaCss(value) {
      const color = colorParts(value)
      const alpha = Math.max(0, Math.min(1, Number(color.a ?? 1)))
      return `rgba(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)},${alpha})`
    }
    function stageBoxContent(box, children = []) {
      if (box.kind === 'textbox' || box.kind === 'textwindow') {
        const fontSize = Math.max(1, Number(box.fontSize || 12) * stageScale)
        const horizontal = box.horizontalAlignment === 'Right' ? 'flex-end' : box.horizontalAlignment === 'Middle' ? 'center' : 'flex-start'
        const vertical = box.verticalAlignment === 'Bottom' ? 'flex-end' : box.verticalAlignment === 'Middle' ? 'center' : 'flex-start'
        const outline = box.enableOutline ? `${Math.max(1, fontSize * .12)}px ${rgbaCss(box.outlineColor)}` : 'none'
        return h('div', { className: 'look2-stage-text', style: { color: rgbaCss(box.fontColor), background: rgbaCss(box.bgColor), fontFamily: box.fontFamily || box.fontName || 'Inter, "Microsoft YaHei UI", "Microsoft YaHei", sans-serif', fontSize: `${fontSize}px`, lineHeight: `${fontSize * 1.2}px`, justifyContent: horizontal, alignItems: vertical, WebkitTextStroke: outline, paintOrder: 'stroke fill' } }, String(box.text ?? ''))
      }
      if (box.kind === 'image') {
        const { src, borderUrl, original, fitContain } = stageImageSource(box)
        const tint = colorParts(box.imageColor)
        const imageType = String(original?.properties?.imageType ?? box.imageType ?? box.base?.imageType ?? 'Basic').toLowerCase() === 'stretch' ? 'Stretch' : 'Basic'
        return h(StageImage, { src, tint, imageType, borderUrl, fitContain, maskBox: box, contentOpacity: stageBoxAlpha(box),
          label: `${box.name}${box.imageId != null ? ` · ${box.imageId}` : ''}` }, children)
      }
      if (box.kind === 'button') {
        const fontSize = Math.max(1, Number(box.fontSize || 12) * stageScale)
        return h('div', { className: 'look2-stage-text', style: { justifyContent: 'center', alignItems: 'center', color: '#fff', background: '#3268cf', border: '1px solid #70a0ff', borderRadius: `${Math.max(3, 6 * stageScale)}px`, fontSize: `${fontSize}px` } }, String(box.text || box.name || ''))
      }
      return h('span', null, box.name)
    }
    const selectedPreview = previewBoxes.find(box => box.id === snap.selectedId)
    const stageBackground = clientTemplates && state.siteExtras?.backgroundChoice === 'blank' ? 'none' : "url('/look2-assets/canvas-background.png')"
    const previewById = new Map(previewBoxes.map(box => [box.id, box]))
    const stageChildrenById = new Map()
    const stageRoots = []
    for (const box of previewBoxes) {
      const parentId = treeRowById.get(box.id)?.parentId
      if (parentId && previewById.has(parentId)) {
        const children = stageChildrenById.get(parentId) || []
        children.push(box); stageChildrenById.set(parentId, children)
      } else stageRoots.push(box)
    }
    function renderStageNode(box, parent = null) {
      if (!box.visible || isNodeHidden(box.id)) return null
      const children = stageChildrenById.get(box.id) || []
      const renderedChildren = children.map(child => renderStageNode(child, box))
      const maskGuide = box.enableMask
        ? h('div', { className: `look2-mask-guides${box.reverseMaskArea ? ' reverse' : ''}`, style: { opacity: stageBoxAlpha(box) }, 'data-label': box.reverseMaskArea ? 'MASK ↺' : 'MASK' }) : null
      return h('div', { key: box.id, className: `look2-box ${box.kind}${box.id === snap.selectedId ? ' sel' : ''}`,
        style: parent ? stageNestedBoxStyle(box, parent) : stageBoxStyle(box),
        onPointerDown: event => beginStageGesture(event, box, editMode === 'combined' ? 'move' : editMode),
        onPointerUp: finishStageGesture,
        onDoubleClick: () => void selectControl(box.id) },
      h('div', { className: `look2-box-backdrop ${box.kind}`, style: { opacity: stageBoxAlpha(box) } }),
      h('div', { className: 'look2-stage-subtree', style: { overflow: 'visible' } },
        box.kind === 'image' ? stageBoxContent(box, renderedChildren) : [
          h('div', { className: 'look2-box-content', style: stageBoxContentStyle(box) }, stageBoxContent(box)),
          renderedChildren]),
      h('div', { className: 'look2-box-outline' }),
      maskGuide)
    }
    const bones = boneView ? previewBoxes.flatMap(box => {
      if (!box.visible || isNodeHidden(box.id)) return []
      const parent = previewBoxes.find(item => item.id === treeRowById.get(box.id)?.parentId)
      if (!parent || box.kind === 'server-container') return []
      const a = worldCenter(parent), b = worldCenter(box)
      return [h('line', { key: `bone-${box.id}`, className: 'look2-bone', x1: a.x, y1: snap.canvas.height - a.y, x2: b.x, y2: snap.canvas.height - b.y }),
        h('circle', { key: `joint-${box.id}`, className: 'look2-bone', cx: b.x, cy: snap.canvas.height - b.y, r: 3 })]
    }) : null
    const gizmo = selectedPreview && !controllerPlatform && snap.canvas.platform === inspectorPlatform && !isNodeHidden(selectedPreview.id) && !selectedLocked ? h('div', { className: 'look2-gizmo', style: stageBoxStyle(selectedPreview) },
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(handle => h('span', { key: handle, className: `look2-handle ${handle}`, onPointerDown: event => beginStageGesture(event, selectedPreview, 'resize', handle), onPointerUp: finishStageGesture })),
      h('span', { className: 'look2-gizmo-line' }), h('span', { className: 'look2-rotate-handle', onPointerDown: event => beginStageGesture(event, selectedPreview, 'rotate'), onPointerUp: finishStageGesture })) : null
    const stage = h('div', { className: 'look2-stage-column' },
      h('div', { className: 'look2-stage-heading', inert: interactionLocked }, icon('scene'), h('strong', null, '场景画布'),
        h('button', { className: boneView ? 'active' : '', onClick: () => setBoneView(!boneView), title: '骨骼视图' }, '以骨骼模式使用'),
        h('span', { className: 'look2-stage-hint' }, '拖动控件 · 滚轮缩放 · 中键平移'),
        h('span', { className: 'look2-canvas-ratio' }, `${snap.canvas.width / snap.canvas.height === 16 / 9 ? '16:9' : `${snap.canvas.width}:${snap.canvas.height}`}`)),
      h('div', { className: 'look2-stage-wrap', ref: stageWrapRef,
        inert: playStarting,
        ...(!interactionLocked ? { onWheel: onStageWheel, onPointerDown: startPan, onPointerMove: movePointer, onPointerLeave: () => setStagePointer(null), onPointerUp: event => { if (panRef.current) endPointer(); else finishStageGesture(event) }, onPointerCancel: cancelPointer } : {}),
        onContextMenu: event => contextFor(event, 'stage', null) },
        inlinePlaying && InlinePlay ? h(InlinePlay, {
          sessionId, startOptions: inlineStartOptions,
          onSnapshot: next => { setPlaySnapshot(next) },
          onError: reason => setError(String(reason?.message || reason)),
          onReady: controller => { playControllerRef.current = controller; setPlayReady(true) },
          onStopped: finishInlinePlay,
        }) : h('div', { className: 'look2-stage', style: { width: `${stageCssWidth}px`, height: `${stageCssHeight}px`, '--pan-x': `${pan.x}px`, '--pan-y': `${pan.y}px`, backgroundColor: '#1b2631', backgroundImage: stageBackground, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }, 'aria-label': '场景画布' },
          stageRoots.map(box => renderStageNode(box)),
          boneView ? h('svg', { className: 'look2-stage-bones', viewBox: `0 0 ${snap.canvas.width} ${snap.canvas.height}`, preserveAspectRatio: 'none' }, bones) : null,
          gizmo),
        !inlinePlaying ? h('div', { className: 'look2-stage-status' }, `${snap.canvas.label}  ${snap.canvas.width} × ${snap.canvas.height}  X ${stagePointer?.x ?? 0}  Y ${stagePointer?.y ?? 0}`) : null),
      !inlinePlaying ? h('div', { className: 'look2-stage-tools' },
        h('button', { className: editMode === 'combined' ? 'active' : '', onClick: () => setEditMode('combined'), title: '三合一：拖动移动、顶部手柄旋转、边角调整尺寸' }, icon('transform'), '三合一'),
        h('button', { className: editMode === 'move' ? 'active' : '', onClick: () => setEditMode('move'), title: '移动控件' }, icon('move'), '移动'),
        h('button', { className: editMode === 'rotate' ? 'active' : '', onClick: () => setEditMode('rotate'), title: '旋转控件' }, icon('rotate'), '旋转'),
        h('button', { className: editMode === 'resize' ? 'active' : '', onClick: () => setEditMode('resize'), title: '调整尺寸' }, icon('scale'), '缩放'),
        h('span', { className: 'look2-tool-hint' }, '拖动控件移动 · 顶部手柄旋转 · 四角及边缘调整大小')) : null)
    function colorParts(value) {
      if (value && typeof value === 'object') return { r: Number(value.r ?? 255), g: Number(value.g ?? 255), b: Number(value.b ?? 255), a: Number(value.a ?? 1) }
      let hex = typeof value === 'string' ? value.replace(/^#/, '') : (Number(value ?? 0xffffffff) >>> 0).toString(16).padStart(8, '0')
      if (hex.length === 6) hex = `ff${hex}`
      if (hex.length !== 8) hex = 'ffffffff'
      return { r: parseInt(hex.slice(2, 4), 16), g: parseInt(hex.slice(4, 6), 16), b: parseInt(hex.slice(6, 8), 16), a: parseInt(hex.slice(0, 2), 16) / 255 }
    }
    function colorHex(value) { const c = colorParts(value); return `#${[c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}` }
    function colorObject(hex, alpha = 1) { const raw = hex.replace(/^#/, ''); return { r: parseInt(raw.slice(0, 2), 16), g: parseInt(raw.slice(2, 4), 16), b: parseInt(raw.slice(4, 6), 16), a: alpha } }
    function nodePath(id) {
      const item = treeRowById.get(id)
      if (!item || item.depth === 0) return ''
      const names = []; let current = item
      while (current && current.depth > 0) { names.push(current.name); current = treeRowById.get(current.parentId) }
      return names.reverse().join('/')
    }
    function nodeFromPath(path) { return snap.tree.find(item => nodePath(item.id) === path)?.id || '' }
    function commitInspectorTransform(key, value) {
      const current = snapRef.current
      const id = current?.selectedId
      const platform = inspectorPlatform
      const node = id ? findProjectNode(current.root, id) : null
      const source = node?.transformByPlatform?.[platform]
      if (!source) return
      let transform = clone(source)
      if (key === 'rotationZ') {
        transform.rotation = { ...transform.rotation, z: Number(value) }
      } else {
        const layout = layoutTree(current.root, projectCanvas(current), platform)
        const box = layout.boxes[id]
        if (!box) return
        const parentId = current.tree.find(item => item.id === id)?.parentId
        const parentNode = parentId ? findProjectNode(current.root, parentId) : null
        const parentBox = parentNode && parentNode.kind !== 'server-container' ? layout.boxes[parentId] : layout.canvas
        if (!parentBox) return
        if (key === 'anchorType') transform = setAnchorPreset(transform, value)
        else if (key === 'anchorMinX') transform.anchorMin = { ...transform.anchorMin, x: Number(value) }
        else if (key === 'anchorMinY') transform.anchorMin = { ...transform.anchorMin, y: Number(value) }
        else if (key === 'anchorMaxX') transform.anchorMax = { ...transform.anchorMax, x: Number(value) }
        else if (key === 'anchorMaxY') transform.anchorMax = { ...transform.anchorMax, y: Number(value) }
        else if (key === 'pivotX') transform.pivot = { ...transform.pivot, x: Number(value) }
        else if (key === 'pivotY') transform.pivot = { ...transform.pivot, y: Number(value) }
        const inspector = { posX: box.centerX, posY: box.centerY, width: box.width, height: box.height }
        if (['posX', 'posY', 'width', 'height'].includes(key)) inspector[key] = Number(value)
        transform = applyInspectorToTransform(parentBox, transform, inspector)
      }
      return patch({ op: 'setPlatformTransform', id, platform, transform }, `Update ${platform} transform`)
    }
    function fieldInput(field) {
      const commit = value => platformTransformKeys.has(field.key)
        ? commitInspectorTransform(field.key, value)
        : patch({ op: 'set', id: snap.selectedId, key: field.key, value }, 'Modify ' + field.label)
      const commitImmediate = value => { void Promise.resolve(commit(value)).catch(reason => setError(String(reason?.message || reason))) }
      if (field.type === 'note') return h('div', { className: 'look2-field wide', key: field.key }, h('label', null, field.label), h('span', null, field.value))
      if (field.type === 'bool') return h('div', { className: 'look2-field', key: field.key }, h('label', null, field.label), h('input', { type: 'checkbox', checked: !!field.value, disabled: !!field.readonly, onChange: event => commitImmediate(event.target.checked) }))
      if (field.type === 'enum' || field.type === 'node') return h('div', { className: 'look2-field', key: field.key }, h('label', null, field.label), h('select', { value: String(field.value ?? ''), disabled: !!field.readonly, onChange: event => commitImmediate(event.target.value) }, (field.options || []).map(option => h('option', { key: String(option.value), value: option.value }, option.label))))
      if (field.type === 'percent') { const value = Math.max(0, Math.min(1, Number(field.value || 0))); return h('div', { className: 'look2-field', key: field.key }, h('label', null, field.label), h('input', { type: 'range', min: 0, max: 100, value: Math.round(value * 100), onChange: event => commitImmediate(Number(event.target.value) / 100) }), h('span', null, `${Math.round(value * 100)}%`)) }
      if (field.type === 'color') {
        const parts = colorParts(field.value), hex = colorHex(field.value)
        const id = snap.selectedId, assetType = snap.asset?.type
        const commitChannel = (channel, value) => {
          void transact('Modify ' + field.label, { prepare: current => {
            if (current.selectedId !== id || current.asset?.type !== assetType) throw new Error('所选控件或编辑资产已变化，请重新编辑颜色')
            const latest = current.inspector?.fields?.find(item => item.key === field.key && item.type === 'color')
            if (!latest || latest.readonly) throw new Error('当前颜色字段不可编辑')
            const color = colorParts(latest.value)
            let rgb = colorHex(color).slice(1)
            if (channel === 'rgb') {
              if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('颜色值无效')
              rgb = value.slice(1)
            } else {
              const alpha = Number(value)
              if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error('透明度必须在 0 到 1 之间')
              color.a = alpha
            }
            const argb = `#${Math.round(color.a * 255).toString(16).padStart(2, '0')}${rgb}`.toUpperCase()
            return { ops: [{ op: 'set', id, key: field.key, value: argb }] }
          } }).catch(reason => setError(String(reason?.message || reason)))
        }
        return h('div', { className: 'look2-field', key: field.key }, h('label', null, field.label),
          h('input', { type: 'color', value: hex, disabled: !!field.readonly, onChange: event => commitChannel('rgb', event.target.value) }),
          h('input', { type: 'range', min: 0, max: 1, step: .01, value: parts.a, disabled: !!field.readonly, title: 'Alpha 0–1', 'aria-label': `${field.label} alpha`, onChange: event => commitChannel('alpha', event.target.value) }),
          h('span', null, `${Math.round(parts.a * 100)}%`))
      }
      return h('div', { className: `look2-field${field.type === 'text' ? ' wide' : ''}`, key: field.key },
        h('label', null, field.label), h(DraftInput, {
          onDiscardError: discardInputError,
          key: `${snap.asset?.type || ''}:${snap.selectedId}:${inspectorPlatform}:${field.key}:${field.type}`,
          value: field.value, type: field.type === 'number' ? 'number' : 'text', rows: field.type === 'text' ? 3 : undefined,
          disabled: !!field.readonly, ariaLabel: field.label,
          onCommit: commit,
          readCommitted: (saved, fallback) => {
            const committed = saved?.inspector?.fields?.find(item => item.key === field.key)
            return committed ? committed.value : fallback
          },
        }))
    }
    const selectedIsPrimitive = clientSiteNodes[snap.selectedId]?.type === 'primitive'
    const basicFieldKeys = new Set(['name', 'active', 'visible', 'canControllerFocus', 'posX', 'posY', 'width', 'height', 'rotationZ', 'syncAllDevices', 'anchorType', 'anchorMinX', 'anchorMinY', 'anchorMaxX', 'anchorMaxY', 'pivotX', 'pivotY', 'imageType'])
    const platformTransformKeys = new Set(['posX', 'posY', 'width', 'height', 'rotationZ', 'anchorType', 'anchorMinX', 'anchorMinY', 'anchorMaxX', 'anchorMaxY', 'pivotX', 'pivotY'])
    const basicFields = selectedFields.filter(field => basicFieldKeys.has(field.key) && !(controllerPlatform && platformTransformKeys.has(field.key)) && !(selectedIsPrimitive && field.key === 'imageType'))
    const runtimeFields = selectedFields.filter(field => !basicFieldKeys.has(field.key))
    function selectInspectorPlatform(platform) {
      setInspectorPlatform(platform)
      if (platform === snap.canvas.platform) return
      const preset = snap.canvas.presets?.find(item => item.platform === platform)
      if (preset && preset.id !== snap.canvasId) void patch({ op: 'setCanvas', canvasId: preset.id }, 'Switch preview device')
    }
    const platformPicker = h('div', { key: 'transform-device', className: 'look2-platform-picker', role: 'group', 'aria-label': 'Transform device' }, PLATFORM_OPTIONS.map(option => h('button', {
      key: option.id, type: 'button', className: inspectorPlatform === option.id ? 'selected' : '', title: option.label, 'aria-label': option.label,
      onClick: () => selectInspectorPlatform(option.id),
    }, icon(option.id === 'KEYBOARD' ? 'monitor' : option.id === 'TOUCHSCREEN' ? 'phone' : 'gamepad', 22), h('small', null, option.label))))
    const imageInspectorTools = inspectorTab === 'base' && row?.kind === 'image' && !selectedIsPrimitive && clientTemplates ? h(React.Fragment, null,
      h('h3', null, '\u56fe\u7247\u7d20\u6750'),
      h('div', { className: 'look2-field' }, h('label', null, '\u56fe\u7247\u7d20\u6750'), h('button', { onClick: () => setShowResources(true) }, '\u9009\u62e9\u7d20\u6750')),
    ) : null
    function commitPlatformTransform(section, axis, value) {
      if (!snap.selectedId) return Promise.reject(new Error('当前平台变换不可用'))
      const id = snap.selectedId
      const assetType = snap.asset?.type
      const kind = snap.inspector?.kind
      const platform = inspectorPlatform
      const label = `更新 ${platform} 变换`
      return transact(label, {
        guard: current => {
          if (current?.selectedId !== id || current?.asset?.type !== assetType || current?.inspector?.kind !== kind) {
            throw new Error('所选控件或编辑资产已变化，请重新操作平台变换')
          }
        },
        prepare: current => preparePlatformTransformEdit(current, {
          id, platform, section, axis, value, playhead, makeId: () => uid('key'),
        }),
      })
    }
    const transformSections = [
      { key: 'scale', label: '\u7f29\u653e', axes: ['x', 'y', 'z'] },
      { key: 'rotation', label: '\u65cb\u8f6c', axes: ['x', 'y', 'z'] },
      { key: 'anchorMin', label: 'Anchor Min', axes: ['x', 'y'] },
      { key: 'anchorMax', label: 'Anchor Max', axes: ['x', 'y'] },
      { key: 'offset', label: '\u4f4d\u7f6e\u504f\u79fb', axes: ['x', 'y'] },
      { key: 'size', label: '\u5c3a\u5bf8', axes: ['x', 'y'] },
      { key: 'pivot', label: '\u8f74\u5fc3', axes: ['x', 'y'] },
    ]
    const editableTransformSections = controllerPlatform ? transformSections : [
      transformSections[0], { ...transformSections[1], axes: ['x', 'y'] },
    ]
    const platformTransformEditor = platformTransform ? h('div', { className: `look2-platform-transform${controllerPlatform ? '' : ' look2-platform-compact'}` },
      controllerPlatform ? h('h3', null, `${PLATFORM_OPTIONS.find(option => option.id === inspectorPlatform)?.label || inspectorPlatform} Transform`) : null,
      editableTransformSections.map(section => h('div', { className: 'look2-platform-value', key: section.key },
        h('label', null, section.label),
        h('div', { className: 'look2-platform-axes', style: { gridTemplateColumns: `repeat(${section.axes.length}, minmax(0, 1fr))` } }, section.axes.map(axis => h('div', { className: 'look2-platform-axis', key: axis, style: { display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 } },
          h('small', null, axis.toUpperCase()), h(DraftInput, {
            onDiscardError: discardInputError,
            key: `${snap.asset?.type || ''}:${snap.selectedId}:${inspectorPlatform}:${section.key}.${axis}`,
            value: platformTransform[section.key]?.[axis] ?? 0, type: 'number', step: 'any',
            ariaLabel: `${section.label} ${axis}`, wrapperStyle: { flex: 1 }, inputStyle: { width: '100%', minWidth: 0 },
            onCommit: value => Number.isFinite(value)
              ? commitPlatformTransform(section.key, axis, value)
              : Promise.reject(new Error('变换值必须是有限数字')),
            readCommitted: (saved, fallback) => {
              const node = saved?.root ? findProjectNode(saved.root, snap.selectedId) : null
              return node?.transformByPlatform?.[inspectorPlatform]?.[section.key]?.[axis] ?? fallback
            },
          }))))))) : null
    const treeMatches = treeSearch.trim() ? snap.tree.filter(item => {
      const query = treeSearch.toLocaleLowerCase()
      return item.name.toLocaleLowerCase().includes(query) || item.kind.toLocaleLowerCase().includes(query) || item.ancestorIds?.some(id => treeRowById.get(id)?.name.toLocaleLowerCase().includes(query))
    }) : snap.tree.filter(item => !item.ancestorIds?.some(id => collapsedTree[id]))
    const trackGroups = snap.tree.filter(item => item.kind !== 'server-container').map(item => ({ nodeId: item.id, label: item.name, depth: item.depth, tracks: [] }))
    for (const track of allTracks) {
      const key = track.nodeId || ''
      let group = trackGroups.find(item => item.nodeId === key)
      if (!group) { group = { nodeId: key, label: treeRowById.get(key)?.name || key || '动画', tracks: [] }; trackGroups.push(group) }
      group.tracks.push(track)
    }
    const timelineCols = `230px ${timelineContentWidth}px`
    const rulerMarks = frames.map(frame => {
      const seconds = frame / state.frameRate
      const isMajor = frame % state.frameRate === 0
      return h('span', { key: frame, className: `look2-ruler-mark${isMajor ? ' major' : ''}`, style: { left: `${seconds * pixelsPerSecond}px` } }, `${frame}f`)
    })
    function timeFromLane(event) { const rect = event.currentTarget.getBoundingClientRect(); return snapTime((event.clientX - rect.left) / pixelsPerSecond) }
    const resourcePanel = showResources && clientTemplates ? h('div', { className: 'look2-modal-backdrop', onClick: () => setShowResources(false) },
      h('div', { className: 'look2-modal', role: 'dialog', 'aria-label': '图片资源', onClick: event => event.stopPropagation() },
        h(ResourcesPanel, { state, getState: () => snapRef.current?.look2, onChange: (fn, label) => editState(fn, label), selectedId: snap.selectedId,
          onBind: bindResource, onSelectImage: selectNativeImage, onClose: () => setShowResources(false), onError: reason => setError(String(reason?.message || reason)), onMessage: setMessage,
          onFetchImage: fetchResourceImage, workerURL: location.pathname.includes('/look2-simulator') ? '/look2-simulator/look2-fit-worker.js' : '/look2-fit-worker.js' }))) : null
    const controlLabels = { container: '容器', image: '图片', primitive: '图元图片', textbox: '文本框', button: '按钮', cursor: '光标区域', grid: '网格视窗', textwindow: '文本视窗', reference: '模板引用', keyhint: '按键提示', animation: '界面动效', fullscreen: '全屏动效' }
    const paneClasses = `look2-main${hiddenPanels.tree ? ' hide-tree' : ''}${hiddenPanels.animator ? ' hide-animator' : ''}${hiddenPanels.inspector ? ' hide-inspector' : ''}`
    const treePane = h('aside', { className: `look2-pane${hiddenPanels.tree ? ' collapsed' : ''}`, inert: interactionLocked, style: { '--panel-width': `${panelWidths.tree}px` } },
      h('div', { className: 'look2-pane-head' }, hiddenPanels.tree ? h('button', { title: '展开控件层级', onClick: () => setHiddenPanels(current => ({ ...current, tree: false })) }, '›') : h(React.Fragment, null,
        h('span', { className: 'head-title' }, `控件层级 ${snap.tree.length}`), h('div', { className: 'look2-tree-toolbar' },
          h('button', { title: '新建容器', onClick: () => addControl('container') }, '+'), h('button', { title: '折叠控件面板', onClick: () => setHiddenPanels(current => ({ ...current, tree: true })) }, '‹')))),
      !hiddenPanels.tree ? h(React.Fragment, null,
        h('div', { className: 'look2-tree-tools' }, h('input', { type: 'search', value: treeSearch, placeholder: '⌕ 搜索控件', 'aria-label': '搜索控件', onChange: event => setTreeSearch(event.target.value) })),
        h('div', { className: 'look2-scroll look2-tree-list' }, treeMatches.map(item => {
          const locked = !!snap.editorLocks?.[item.id], hidden = !!hiddenNodes[hiddenNodeKey(item.id)]
          return h('div', { key: item.id, className: `look2-tree-row${item.id === snap.selectedId ? ' sel' : ''}${hidden ? ' hidden-node' : ''}${locked ? ' locked-node' : ''}${treeDragOver === item.id ? ' drag-over' : ''}`,
            style: { paddingLeft: `${4 + item.depth * 13}px` }, draggable: true, onDragStart: event => event.dataTransfer.setData('text/look2-node', item.id),
            onDragOver: event => { event.preventDefault(); setTreeDragOver(item.id) }, onDragLeave: () => setTreeDragOver(''), onDrop: event => treeDrop(event, item),
            onContextMenu: event => contextFor(event, 'node', item.id) },
            h('button', { className: 'tree-action', title: item.childCount ? '折叠或展开子级' : '无子级', onClick: () => item.childCount && setCollapsedTree(current => ({ ...current, [item.id]: !current[item.id] })) }, item.childCount ? collapsedTree[item.id] ? '›' : '⌄' : ''),
            h('button', { className: 'tree-name', title: `${item.kind} · ${item.name}`, onClick: () => selectControl(item.id) }, icon(['image', 'primitive'].includes(item.kind) ? 'image' : ['textbox', 'textwindow'].includes(item.kind) ? 'text' : item.kind === 'animation' ? 'sliders' : 'container', 15), `${item.name}`),
            h('button', { className: 'tree-action', title: hidden ? '在画布显示' : '在画布隐藏', onClick: () => setNodeHidden(item.id) }, icon(hidden ? 'eye-off' : 'eye', 14)),
            h('button', { className: 'tree-action tree-lock', title: locked ? '解锁' : '锁定', onClick: () => setNodeLocked(item.id, !locked) }, icon('lock', 13)))
        })),
        h('div', { className: 'look2-tree-footer' },
          h('details', { className: 'look2-add-menu' }, h('summary', null, icon('plus'), '添加控件'),
            h('div', { className: 'look2-add' }, Object.entries(controlLabels).filter(([kind]) => clientTemplates || kind !== 'primitive').map(([kind, label]) => h('button', { key: kind, onClick: event => { event.currentTarget.closest('details')?.removeAttribute('open'); addControl(kind) } }, icon(kind === 'image' || kind === 'primitive' ? 'image' : 'container', 14), label)))),
          h('button', { className: 'look2-tree-delete', title: '删除选中控件', disabled: !row, onClick: () => deleteControl(snap.selectedId) }, icon('trash')))) : null,
      !hiddenPanels.tree ? h('div', { className: 'look2-resize-x', style: { position: 'absolute', right: 0, top: 0, bottom: 0 }, onPointerDown: event => startPanelResize(event, 'tree') }) : null)
    const animatorPane = h('aside', { className: `look2-pane look2-animations${hiddenPanels.animator ? ' collapsed' : ''}`, inert: interactionLocked },
      h('div', { className: 'look2-pane-head' }, hiddenPanels.animator ? h('button', { title: '展开动画面板', onClick: () => setHiddenPanels(current => ({ ...current, animator: false })) }, '‹') : h(React.Fragment, null,
        h('div', { className: 'look2-animator-title' }, h('span', { className: 'head-title' }, 'Animations'), h('small', null, `Animator · ${state.animations.length} 个动画`)), h('div', { className: 'look2-tree-toolbar' }, h('button', { title: '新增动画', onClick: addAnimation }, '+'), h('button', { title: '折叠动画面板', onClick: () => setHiddenPanels(current => ({ ...current, animator: true })) }, '›')))),
      !hiddenPanels.animator ? h(React.Fragment, null,
        h('div', { className: 'look2-scroll', style: { padding: 6 } }, state.animations.map(animation => h('div', { className: 'look2-anim-row', key: animation.id, onContextMenu: event => contextFor(event, 'animation', animation.id) },
          h('button', { className: animation.id === active.id ? 'sel' : '', title: `${animation.name} · ${animation.duration}s`, onClick: () => {
              if (animation.id === active.id) return
              const targetId = animation.id
              void editState(next => {
                if (!next.animations.some(item => item.id === targetId)) throw new Error('动画已删除，请重新选择')
                next.activeAnimationId = targetId
              }, '切换动画').then(result => {
                if (result?.look2?.activeAnimationId !== targetId) return
                setPlayhead(0); setSelectedKey(null); setSelectedKeys([]); setSelectedEventId(null)
              }).catch(() => {})
            } },
            h('span', null, `${animation.name}`), h('small', null, `${animation.duration} s · ${(animation.keyframeTracks || []).length} 条轨道`)),
          h('button', { className: 'mini', title: '更多操作', onClick: event => contextFor(event, 'animation', animation.id) }, '⋯')))),
        h('div', { className: 'look2-inspector' },
          h('div', { className: 'look2-field wide' }, h('label', null, '动画名称'), h('input', { key: `${active.id}:name`, type: 'text', defaultValue: active.name, onBlur: event => { const name = event.target.value.trim(); if (name && name !== active.name) void updateAnimation(animation => { animation.name = name }, '重命名动画') } })),
          h('div', { className: 'look2-field' }, h('label', null, '时长 (s)'), h(DraftInput, {
            onDiscardError: discardInputError,
            key: `${snap.asset?.type || ''}:${active.id}:duration`, value: active.duration, type: 'number', min: .1, step: .1, ariaLabel: '时长 (s)',
            onCommit: async value => {
              if (!Number.isFinite(value) || value < .1) throw new Error('动画时长必须是至少 0.1 秒的有限数字')
              const result = await updateAnimation(animation => {
                let lastTime = 0
                for (const event of animation.events || []) lastTime = Math.max(lastTime, Number(event.time))
                for (const track of animation.keyframeTracks || []) {
                  for (const key of track.keyframes || []) lastTime = Math.max(lastTime, Number(key.time))
                }
                if (value < lastTime) throw new Error(`动画时长不能短于最后一个关键帧或事件（${lastTime} 秒）`)
                animation.duration = value
              }, '修改动画时长')
              playbackCursorRef.current = Math.min(playbackCursorRef.current, value)
              setPlayhead(current => Math.min(current, value))
              return result
            },
            readCommitted: (saved, fallback) => saved?.look2?.animations?.find(item => item.id === active.id)?.duration ?? fallback,
          })),
          h('div', { className: 'look2-field' }, h('button', { title: '复制动画', onClick: () => duplicateAnimation(active.id) }, '复制动画'), h('button', { disabled: state.animations.length < 2, onClick: () => removeAnimation(active.id) }, '删除')))) : null,
      !hiddenPanels.animator ? h('div', { className: 'look2-resize-x', style: { position: 'absolute', left: 0, top: 0, bottom: 0 }, onPointerDown: event => startPanelResize(event, 'animator') }) : null)
    const legacyInspector = WorkspaceInspector ? h(WorkspaceInspector, {
      mode: inspectorTab === 'script' ? 'script' : 'base', snap, patch, applyFieldGroup, transformPlatform: inspectorPlatform,
      transformHeader: platformPicker,
      extraTransformFields: controllerPlatform ? null : platformTransformEditor,
      onError: reason => setError(String(reason?.message || reason)), onDiscardInputError: discardInputError, setDockTab,
    }) : null
    const inspectorContent = inspectorTab === 'runtime' ? h(React.Fragment, null,
      h('div', { className: 'look2-field' }, h('button', { onClick: () => setShowRuntimeFields(!showRuntimeFields) }, showRuntimeFields ? '收起全部运行时字段' : '展开全部运行时字段')),
      showRuntimeFields ? runtimeFields.map(fieldInput) : null)
      : inspectorTab === 'script' ? legacyInspector : legacyInspector || h(React.Fragment, null,
      h('h3', null, '变换'), basicFields.filter(field => ['posX', 'posY', 'width', 'height', 'rotationZ', 'anchorType', 'anchorMinX', 'anchorMinY', 'anchorMaxX', 'anchorMaxY', 'pivotX', 'pivotY'].includes(field.key)).map(fieldInput),
      controllerPlatform ? null : platformTransformEditor,
      h('h3', null, '状态'), basicFields.filter(field => ['name', 'active', 'visible', 'canControllerFocus', 'syncAllDevices'].includes(field.key)).map(fieldInput),
      h('div', { className: 'look2-field' }, h('button', { onClick: () => duplicateControl(snap.selectedId) }, '复制控件'), h('button', { onClick: () => deleteControl(snap.selectedId) }, '删除控件'))
    )
    const inspectorTabs = h('div', { className: 'look2-inspector-tabs' },
      h('button', { className: inspectorTab === 'base' ? 'active' : '', onClick: () => setInspectorTab('base') }, '基础'),
      h('button', { className: inspectorTab === 'runtime' ? 'active' : '', onClick: () => setInspectorTab('runtime') }, '运行时'),
      h('button', { className: `look2-script-tab${inspectorTab === 'script' ? ' active' : ''}`, title: '脚本挂载', 'aria-label': '脚本', onClick: () => setInspectorTab('script') }, icon('code')))
    const inspectorPane = h('aside', { className: `look2-pane look2-inspector-pane${hiddenPanels.inspector ? ' collapsed' : ''}`, inert: interactionLocked },
      h('div', { className: 'look2-pane-head' }, hiddenPanels.inspector ? h('button', { title: '展开属性面板', onClick: () => setHiddenPanels(current => ({ ...current, inspector: false })) }, '‹') : h(React.Fragment, null,
        h('div', { className: 'look2-inspector-title' }, h('strong', null, row?.name || '控件属性'), h('small', null, `${controlLabels[row?.kind] || row?.kind || '节点'} · 控件详情`)), h('button', { title: '收起属性面板', onClick: () => setHiddenPanels(current => ({ ...current, inspector: true })) }, icon('sliders')))),
      !hiddenPanels.inspector ? h(React.Fragment, null,
        inspectorTabs,
        h('div', { className: 'look2-scroll look2-inspector' }, inspectorTab === 'script' ? inspectorContent : h(React.Fragment, null, !WorkspaceInspector || inspectorTab === 'runtime' ? platformPicker : null, imageInspectorTools, inspectorContent, controllerPlatform ? platformTransformEditor : null))) : null,
      !hiddenPanels.inspector ? h('div', { className: 'look2-resize-x', style: { position: 'absolute', left: 0, top: 0, bottom: 0 }, onPointerDown: event => startPanelResize(event, 'inspector') }) : null)
    const renderTrack = track => h('div', { key: track.id, className: 'look2-track', style: { gridTemplateColumns: timelineCols, width: `${totalTimelineWidth}px` } },
      h('div', { className: 'look2-track-name', title: labelOf(track.fieldKey), onContextMenu: event => contextFor(event, 'track', track.id) },
        h('button', { className: 'tree-action', title: '选择轨道控件', onClick: () => selectControl(track.nodeId, '选择轨道控件') }, '◇'),
        h('span', null, labelOf(track.fieldKey)), h('button', { className: 'tree-action', title: '在播放头添加关键帧', onClick: () => addKeyframe(track) }, '+'),
        h('button', { className: 'tree-action', title: '删除轨道', onClick: () => removeTrack(track.id) }, '×')),
      h('div', { className: 'look2-track-lane', style: { width: `${timelineContentWidth}px`, '--minor-step': `${minorStep}px` }, onDoubleClick: event => { addKeyframe(track, timeFromLane(event)) }, onPointerDown: event => { if (event.target === event.currentTarget) setPlayhead(timeFromLane(event)) }, onContextMenu: event => { if (event.target !== event.currentTarget) return; contextFor(event, 'timeline-lane', { trackId: track.id, time: timeFromLane(event) }) } },
        (track.keyframes || []).map(item => h('button', { key: item.id, className: `look2-key${selectedKeys.some(row => row.trackId === track.id && row.keyId === item.id) ? ' sel' : ''}${selectedKeys.length > 1 && selectedKeys.some(row => row.trackId === track.id && row.keyId === item.id) ? ' multi' : ''}`,
          style: { left: `${item.time * pixelsPerSecond}px` }, title: `${item.time.toFixed(3)}s · ${typeof item.value === 'object' ? JSON.stringify(item.value) : item.value}`,
          onClick: event => { if (event.detail === 0) { selectKey(track.id, item.id, event); setPlayhead(item.time); setSelectedEventId(null) } },
          onPointerDown: event => startKeyDrag(event, track, item), onPointerUp: finishKeyDrag,
          onPointerCancel: () => { if (dragRef.current?.type === 'keys') dragRef.current = null },
          onContextMenu: event => { selectKey(track.id, item.id, event); contextFor(event, 'key', { trackId: track.id, keyId: item.id }) } }, track.fieldKey === 'visible' ? (item.value ? '◆' : '◇') : '◆'))))
    const timelineTrackRows = trackGroups.flatMap(group => {
      const heading = h('div', { key: `group-${group.nodeId}`, className: 'look2-track-group', 'data-selected': group.nodeId === snap.selectedId, style: { gridTemplateColumns: timelineCols, width: `${totalTimelineWidth}px` } },
        h('button', { className: 'look2-ruler-name', style: { paddingLeft: `${8 + (group.depth || 0) * 13}px` }, onClick: () => setCollapsedGroups(current => ({ ...current, [group.nodeId]: !current[group.nodeId] })) }, `${collapsedGroups[group.nodeId] ? '›' : '⌄'}`, icon('container', 13), group.label),
        h('div', { className: 'look2-ruler-lane', style: { width: `${timelineContentWidth}px`, '--minor-step': `${minorStep}px` } }))
      return collapsedGroups[group.nodeId] ? [heading] : [heading, ...group.tracks.map(renderTrack)]
    })
    const timelineRuler = h('div', { className: 'look2-ruler-row', style: { gridTemplateColumns: timelineCols, width: `${totalTimelineWidth}px` } },
      h('div', { className: 'look2-ruler-name' }, '控件 / 属性轨道'),
      h('div', { className: 'look2-ruler-lane', style: { width: `${timelineContentWidth}px`, '--minor-step': `${minorStep}px`, cursor: 'pointer' }, onPointerDown: event => setPlayhead(timeFromLane(event)) }, rulerMarks))
    const eventTimelineRow = h('div', { className: 'look2-event-row', style: { gridTemplateColumns: timelineCols, width: `${totalTimelineWidth}px` } },
      h('div', { className: 'look2-ruler-name' }, h('span', null, '事件'), h('button', { title: '在播放头添加事件', onClick: () => addEvent() }, '+')),
      h('div', { className: 'look2-event-lane', style: { width: `${timelineContentWidth}px`, '--minor-step': `${minorStep}px` }, onDoubleClick: event => { addEvent(timeFromLane(event)) }, onPointerDown: event => { if (event.target === event.currentTarget) setPlayhead(timeFromLane(event)) } },
        events.map(event => h('button', { key: event.id, className: 'look2-event-dot', style: { left: `${Number(event.time) * pixelsPerSecond}px` }, title: `${event.time}s · ${event.name}`,
          onClick: () => { setSelectedEventId(event.id); setSelectedKey(null); setSelectedKeys([]); setPlayhead(Number(event.time)) }, onContextMenu: context => { contextFor(context, 'event', event.id) } }, '◆'))))
    const readKeyField = (saved, field, fallback) => saved?.look2?.animations?.find(item => item.id === active.id)
      ?.keyframeTracks?.find(item => item.id === selectedKey?.trackId)?.keyframes?.find(item => item.id === selectedKey?.keyId)?.[field] ?? fallback
    const valueEditor = (value, fieldKey, label, field) => {
      const setter = next => updateKey(field, next)
      if (typeof value === 'boolean') return h('select', { 'aria-label': label, value: String(value), onChange: event => setter(event.target.value === 'true') }, h('option', { value: 'true' }, '显示'), h('option', { value: 'false' }, '隐藏'))
      const draftKey = `${active.id}:${selectedKey?.trackId}:${selectedKey?.keyId}:${field}`
      if (value && typeof value === 'object') return h('span', { className: 'color-value' }, h('input', { type: 'color', 'aria-label': label, value: colorHex(value), onChange: event => {
        const hex = event.target.value
        void setter(current => colorObject(hex, Number(current?.a ?? 1)))
      } }), h(DraftInput, { key: `${draftKey}:alpha`, type: 'number', min: 0, max: 1, step: .01, title: 'Alpha 0–1', ariaLabel: `${label} Alpha`, value: Number(value.a ?? 1), onDiscardError: discardInputError,
        onCommit: alpha => setter(current => {
          if (!Number.isFinite(alpha)) throw new Error('关键帧数值必须是有限数字')
          return { ...current, a: Math.max(0, Math.min(1, alpha)) }
        }), readCommitted: (saved, fallback) => readKeyField(saved, field, {})?.a ?? fallback }))
      return h(DraftInput, { key: draftKey, type: 'number', ariaLabel: label, min: fieldKey === 'groupAlpha' ? 0 : undefined, max: fieldKey === 'groupAlpha' ? 255 : undefined, step: 'any', value: Number(value ?? 0), onCommit: setter, onDiscardError: discardInputError,
        readCommitted: (saved, fallback) => readKeyField(saved, field, fallback) })
    }
    const keyInspector = key ? h('div', { className: 'look2-key-inspector' },
      h('h4', null, `◇ ${labelOf(selectedTrack.fieldKey)} · ${selectedTrack.fieldKey === 'visible' ? '阶跃' : '关键帧'}`),
      h('div', { className: 'look2-field' }, h('label', null, '时间'), h(DraftInput, { key: `${active.id}:${selectedTrack.id}:${key.id}:time`, type: 'number', min: 0, max: duration, step: 1 / state.frameRate, ariaLabel: '关键帧时间', value: key.time, onCommit: value => updateKey('time', value), onDiscardError: discardInputError,
        readCommitted: (saved, fallback) => readKeyField(saved, 'time', fallback) })),
      h('div', { className: 'look2-field' }, h('label', null, '属性值'), valueEditor(key.value, selectedTrack.fieldKey, '关键帧属性值', 'value')),
      key.leftValue !== undefined ? h('div', { className: 'look2-field' }, h('label', null, '入侧值'), valueEditor(key.leftValue, selectedTrack.fieldKey, '入侧属性值', 'leftValue')) : null,
      key.leftValue === undefined ? h('button', { onClick: () => updateKeyValues(target => ({ leftValue: clone(target.value), leftRelative: false })) }, '添加入侧跳变值') : h('button', { onClick: () => updateKey('leftValue', undefined) }, '移除入侧值'),
      selectedTrack.fieldKey !== 'visible' ? h(React.Fragment, null,
        h('div', { className: 'look2-field' }, h('label', null, '缓动'), h('select', { value: key.easeType || 'Linear', onChange: event => updateKey('easeType', event.target.value) }, EASE_TYPES.map(value => h('option', { key: value, value }, value)))),
        h('div', { className: 'look2-field' }, h('label', null, '插值'), h('select', { value: key.interpolation || 'tween', onChange: event => updateKey('interpolation', event.target.value) }, h('option', { value: 'tween' }, '补间'), h('option', { value: 'step' }, '阶跃'))),
        TWEENABLE_FIELDS.find(field => field.fieldKey === selectedTrack.fieldKey)?.relative ? h('div', { className: 'look2-field' }, h('label', null, '相对前帧'), h('input', { type: 'checkbox', checked: key.relative === true, onChange: event => updateKey('relative', event.target.checked) })) : null,
        key.leftValue !== undefined ? h('div', { className: 'look2-field' }, h('label', null, '入侧相对前帧'), h('input', { type: 'checkbox', checked: key.leftRelative === true, onChange: event => updateKey('leftRelative', event.target.checked) })) : null
      ) : null,
      h('div', { className: 'look2-field' }, h('button', { onClick: copySelectedKeys }, '复制'), h('button', { onClick: pasteKeys, disabled: !keyClipboardRef.current.length }, '粘贴'), h('button', { onClick: removeSelectedKeys }, `删除${selectedKeys.length > 1 ? ` (${selectedKeys.length})` : ''}`))) : selectedEvent ? h('div', { className: 'look2-key-inspector' },
      h('h4', null, '事件'),
      h('div', { className: 'look2-field' }, h('label', null, '时间'), h('input', { key: `${selectedEvent.id}:time`, type: 'number', min: 0, max: duration, step: 1 / state.frameRate, defaultValue: Number(selectedEvent.time), onBlur: event => { const value = Number(event.target.value); if (Number.isFinite(value)) { const time = snapTime(value); if (time !== Number(selectedEvent.time)) void updateEvent(selectedEvent.id, item => { item.time = time }) } } })),
      h('div', { className: 'look2-field wide' }, h('label', null, '名称'), h('input', { key: `${selectedEvent.id}:name`, type: 'text', defaultValue: selectedEvent.name || '', onBlur: event => {
         const name = event.target.value.trim()
         if (!name || new TextEncoder().encode(name).length > 320) { setError('事件名称不能为空或超过 320 字节'); return }
         if (name !== (selectedEvent.name || '')) void updateEvent(selectedEvent.id, item => { item.name = name })
       } })),
      h('div', { className: 'look2-field wide' }, h('label', null, '目标控件'), h('select', { value: selectedEvent.nodeId || nodeFromPath(selectedEvent.target || ''), onChange: event => { const nodeId = event.target.value; const target = nodePath(nodeId); void updateEvent(selectedEvent.id, item => { item.nodeId = nodeId; item.target = target }) } }, h('option', { value: '' }, '界面根'), snap.tree.filter(item => item.kind !== 'server-container').map(item => h('option', { key: item.id, value: item.id }, `${'　'.repeat(Math.max(0, item.depth - 1))}${item.name}`)))),
      h('div', { className: 'look2-field wide' }, h('label', null, '参数字符串'), h('textarea', { key: `${selectedEvent.id}:params`, defaultValue: typeof selectedEvent.params === 'string' ? selectedEvent.params : JSON.stringify(selectedEvent.params || []), rows: 3, onBlur: event => {
         const value = event.target.value
         if (new TextEncoder().encode(value).length > 16384) { setError('事件参数超过 16384 字节'); return }
         const previous = typeof selectedEvent.params === 'string' ? selectedEvent.params : JSON.stringify(selectedEvent.params || [])
         if (value !== previous) void updateEvent(selectedEvent.id, item => { item.params = value })
       } })),
      h('div', { className: 'look2-field wide' }, h('label', null, '处理脚本'), h('select', {
        value: selectedHandlerScript ? `${selectedHandlerScript.path}|${selectedHandlerScript.controlId}` : selectedHandler ? '__invalid__' : '',
        onChange: event => {
          const script = eventScripts.find(item => `${item.path}|${item.controlId}` === event.target.value)
          void updateEvent(selectedEvent.id, item => {
            if (!script) { delete item.handler; return }
            item.handler = { scriptPath: script.path, functionName: item.handler?.functionName || 'OnAnimationEvent', targetNodeId: script.controlId }
          })
        },
      }, h('option', { value: '' }, '不绑定'), selectedHandler && !selectedHandlerScript ? h('option', { value: '__invalid__', disabled: true }, `失效绑定：${selectedHandler.scriptPath || '(无路径)'} · ${selectedHandler.functionName || 'OnAnimationEvent'}`) : null,
      eventScripts.map(script => h('option', { key: `${script.id}:${script.controlId}`, value: `${script.path}|${script.controlId}` }, `${script.path} · ${snap.tree.find(item => item.id === script.controlId)?.name || script.controlId}`)))),
      h('div', { className: 'look2-field wide' }, h('label', null, '处理函数'), h('input', {
        key: `${selectedEvent.id}:handler:${selectedHandler?.scriptPath || ''}:${selectedHandler?.targetNodeId || ''}`,
        type: 'text', disabled: !selectedHandlerScript, placeholder: 'OnAnimationEvent',
        defaultValue: selectedHandler?.functionName || 'OnAnimationEvent',
        onBlur: event => {
          if (!selectedHandlerScript) return
          const functionName = event.target.value.trim() || 'OnAnimationEvent'
          if (functionName !== (selectedHandler?.functionName || 'OnAnimationEvent')) void updateEvent(selectedEvent.id, item => {
            item.handler = { scriptPath: selectedHandlerScript.path, functionName, targetNodeId: selectedHandlerScript.controlId }
          })
        },
      })),
      h('button', { onClick: () => removeEvent(selectedEvent.id) }, '删除事件')) : h('div', { className: 'look2-key-inspector' },
        h('div', { className: 'look2-key-empty' }, h('span', { className: 'diamond', 'aria-hidden': true }, '◇'), h('strong', null, '选择菱形关键帧'), h('p', null, '编辑时间、属性值与下一段补间。', h('br'), '右键属性轨道可添加关键帧。')),
        h('div', { className: 'look2-field' }, h('button', { onClick: () => addEvent() }, '＋ 事件'), h('button', { onClick: copySelectedKeys, disabled: !selectedKeys.length }, '复制关键帧')))
    const timeline = h('section', { className: 'look2-timeline', inert: interactionLocked, style: { height: '100%', minHeight: 0, maxHeight: 'none', flex: '1 1 auto' }, 'aria-label': '关键帧时间轴' },
      h('div', { className: 'look2-timeline-top' }, h('span', { className: 'look2-sequence-name' }, icon('sliders', 14), ' ', active.name), h('button', { title: '回到起点', onClick: () => { setPlaying(false); setPlayhead(0) } }, icon('skip-back', 14)),
        h('button', { title: '播放或暂停', 'aria-label': playing ? '暂停动画' : '播放动画', 'aria-pressed': playing, onClick: () => { if (!playing) { const from = playhead >= duration ? 0 : playhead; playbackCursorRef.current = from; includeStartEventRef.current = from === 0; setPlayhead(from); if (from === 0) setEventLog([]) }; setPlaying(!playing) } }, icon(playing ? 'pause' : 'play', 14)),
        h('span', { className: 'look2-time-readout' }, `${playhead.toFixed(2)}s · ${Math.round(playhead * state.frameRate)}f`),
        h('input', { className: 'timeline-seek', type: 'range', min: 0, max: duration, step: 1 / state.frameRate, value: Math.min(duration, playhead), onChange: event => setPlayhead(Number(event.target.value)) }),
        h('span', null, '帧率'), h('input', { type: 'number', min: 1, max: 240, value: state.frameRate, onChange: event => { const value = Number(event.target.value); if (value >= 1 && value <= 240) void editState(next => { next.frameRate = Math.trunc(value) }, '修改帧率') } }),
        h('button', { className: state.timelineSnapEnabled ? 'selected' : '', title: '按帧吸附', onClick: () => void editState(next => { next.timelineSnapEnabled = !next.timelineSnapEnabled }, '切换时间吸附') }, '吸附'),
        h('button', { title: '缩小时间轴', onClick: () => setPixelsPerSecond(value => Math.max(24, value / 1.2)) }, '−'), h('button', { title: '放大时间轴', onClick: () => setPixelsPerSecond(value => Math.min(320, value * 1.2)) }, '+'),
        h('button', { className: showEventLog ? 'selected' : '', title: '播放事件日志', onClick: () => setShowEventLog(!showEventLog) }, '日志'),
        h('select', { title: '新建轨道属性', value: activeTrackField, disabled: !trackFieldOptions.length, onChange: event => setTrackField(event.target.value) }, trackFieldOptions.map(field => h('option', { key: field.fieldKey, value: field.fieldKey }, field.label))),
        h('button', { title: '添加当前控件的轨道', onClick: addTrack, disabled: !row || !trackFieldOptions.length }, '+轨道'),
        h('span', { className: 'look2-timeline-hint' }, '双击空白添加关键帧 · 拖动菱形调整时间')),
      h('div', { className: 'look2-timeline-body' },
        h('div', { className: 'look2-timeline-scroll', ref: timelineRef },
          h('div', { style: { position: 'relative', width: `${totalTimelineWidth}px`, minHeight: '100%' } },
            timelineRuler, eventTimelineRow, timelineTrackRows,
            h('div', { className: 'look2-playhead', style: { left: `${230 + playhead * pixelsPerSecond}px` } }),
            showEventLog && eventLog.length ? h('div', { className: 'look2-event-log', role: 'log', style: { maxHeight: 180, overflowY: 'auto' } }, eventLog.map((event, index) => h('div', { key: `${event.id}:${event.at}:${index}` }, `${event.name} · ${Number(event.time).toFixed(2)}s · ${event.target || ''} · ${typeof event.params === 'string' ? event.params : JSON.stringify(event.params || [])}`))) : null)),
        keyInspector))
    const inspected = runtimeInspection?.inspection || runtimeInspection || {}
    const runtimeTree = inspected.tree || playSnapshot?.tree || []
    const runtimeLogs = inspected.logs || playSnapshot?.logs || []
    const runtimeServer = inspected.server || playSnapshot?.server || {}
    const debugJson = value => { try { return JSON.stringify(value ?? null, null, 2) } catch { return String(value) } }
    function exportPlayLog() {
      try {
        const log = buildPlayLog({
          sessionId, saveName: snap.save?.name, filePath, assetType: snap.asset?.type, canvas: snap.canvas,
          playTarget, running: inlinePlaying, status: playSnapshot, server: runtimeServer, tree: runtimeTree, logs: runtimeLogs,
        })
        downloadText(playLogFilename(), JSON.stringify(log, null, 2))
        setMessage(`已导出试玩日志（运行日志 ${runtimeLogs.length} 条）`)
      } catch (reason) { setError(String(reason?.message || reason)) }
    }
    const debugPanel = h('div', { className: 'look2-runtime-debug' },
      h('section', { className: 'look2-debug-card' },
        h('h3', null, '运行状态与控件树'),
        h('div', { className: 'look2-debug-row' }, h('span', null, inlinePlaying ? '运行中' : '已停止'),
          h('button', { disabled: !playReady || inspectBusy, onClick: () => void refreshPlayInspection() }, inspectBusy ? '读取中…' : '刷新运行快照'),
          h('button', { className: 'look2-export-play-log', title: '把运行状态、控件树、运行日志和服务端信息导出为 JSON', onClick: exportPlayLog }, '导出试玩日志')),
        h('pre', null, debugJson({ status: playSnapshot, server: runtimeServer })),
        h('h3', null, '运行控件'), h('pre', null, debugJson(runtimeTree))),
      h('section', { className: 'look2-debug-card' },
        h('h3', null, `运行日志${runtimeLogs.length ? ` · ${runtimeLogs.length}` : ''}`),
        h('pre', { role: 'log' }, debugJson(runtimeLogs)),
        h('h3', null, '设置运行变量'),
        h('div', { className: 'look2-debug-row' },
          h('select', { value: serverEntity, onChange: event => setServerEntity(event.target.value), 'aria-label': '变量实体' }, ['PlayerSelf', 'Level', ...Array.from({ length: 8 }, (_, index) => `Player${index + 1}`)].map(value => h('option', { key: value, value }, value))),
          h('input', { value: serverVariable, placeholder: '变量名', 'aria-label': '变量名', onChange: event => setServerVariable(event.target.value) }),
          h('input', { value: serverValue, placeholder: 'JSON 值', 'aria-label': '变量值', onChange: event => setServerValue(event.target.value) }),
          h('button', { disabled: !playReady || !serverVariable.trim(), onClick: () => {
            let value
            try { value = JSON.parse(serverValue) } catch { value = serverValue }
            void sendPlayAction('serverSet', { entityType: serverEntity, name: serverVariable.trim(), value })
          } }, '写入')),
        h('h3', null, '发送服务端信号'),
        h('div', { className: 'look2-debug-row' },
          h('input', { value: signalName, placeholder: '信号名', 'aria-label': '信号名', onChange: event => setSignalName(event.target.value) }),
          h('input', { value: signalParams, placeholder: '参数 JSON 数组', 'aria-label': '信号参数', onChange: event => setSignalParams(event.target.value) }),
          h('select', { value: signalTarget, onChange: event => setSignalTarget(event.target.value), 'aria-label': '信号目标' }, ['PlayerSelf', 'AllPlayers', ...Array.from({ length: 8 }, (_, index) => `Player${index + 1}`)].map(value => h('option', { key: value, value }, value))),
          h('button', { disabled: !playReady || !signalName.trim(), onClick: () => {
            try {
              const params = JSON.parse(signalParams || '[]')
              if (!Array.isArray(params)) throw new Error('信号参数必须是 JSON 数组')
              void sendPlayAction('serverSend', { name: signalName.trim(), params, target: signalTarget })
            } catch (reason) { setError(String(reason.message || reason)) }
          } }, '发送'))))
    const dockContent = dockTab === 'animation' ? timeline : dockTab === 'debug' ? debugPanel
      : WorkspaceDock ? h(WorkspaceDock, {
        activeTab: dockTab, sessionId, snap, patch, api, exportFile,
        onError: reason => setError(String(reason?.message || reason)), onMessage: setMessage,
        waitForQueue: () => queue.current, getSnapshot: () => snapRef.current, onSaved: accept,
        onReloadArchive: path => load(path), setDockTab,
      }) : null
    const dock = h('section', { ref: dockRef, className: 'look2-dock', style: { '--timeline-height': `${timelineHeight}px` }, 'aria-label': '动画、脚本与调试面板',
      onKeyDownCapture: event => {
        if (event.key === 'Escape' && dockRef.current?.ownerDocument.fullscreenElement === dockRef.current) {
          event.preventDefault()
          event.stopPropagation()
          void toggleDockFullscreen()
        }
      } },
      h('div', { className: 'look2-timeline-resize', onPointerDown: startTimelineResize }),
      h('div', { className: 'look2-dock-tabs', role: 'tablist', 'aria-label': '工作区面板' },
        h('span', null, icon('scene', 14), '动画时间轴', h('span', { className: 'spacer' })),
        [['animation', '动画'], ['lua', 'Lua'], ['logic', '逻辑'], ['sync', (snap.controlGuidChanges?.length || 0) ? `同步 (${snap.controlGuidChanges.length})` : '同步'], ['debug', '调试']].map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', className: dockTab === id ? 'active' : '', 'aria-selected': dockTab === id, disabled: interactionLocked && id !== 'debug', onClick: () => setDockTab(id) }, label)),
        h('button', { type: 'button', title: dockFullscreen ? '退出面板全屏（Esc）' : '全屏显示当前面板', 'aria-label': dockFullscreen ? '退出面板全屏' : '面板全屏', 'aria-pressed': dockFullscreen, onClick: () => void toggleDockFullscreen() }, icon('fullscreen', 14))),
      h('div', { className: 'look2-dock-content' }, ['lua', 'logic'].includes(dockTab) ? h('fieldset', { className: 'look2-dock-readonly', disabled: interactionLocked }, dockContent) : dockContent),
      h('div', { className: 'look2-dock-footer' }, dockTab === 'animation' ? 'Ctrl+C / Ctrl+V 复制粘贴关键帧 · Delete 删除所选关键帧' : dockTab === 'sync' ? '控件索引校准 · Lua 索引引用 · 实机脚本更新' : 'Look 工作区 · Lua 脚本、逻辑与运行调试'))
    const importControl = h(React.Fragment, null,
      h('input', { hidden: true, ref: fileRef, type: 'file', accept: '.json,.gia,.lua,.psd', onChange: event => { void importFile(event.target.files?.[0]); event.target.value = '' } }),
      h('input', { hidden: true, ref: element => {
        folderRef.current = element
        if (element) { element.setAttribute('webkitdirectory', ''); element.setAttribute('directory', '') }
      }, type: 'file', webkitdirectory: '', directory: '', multiple: true, onChange: event => { void importSpineFolder(event.target.files); event.target.value = '' } }),
      h('input', { hidden: true, ref: templateFileRef, type: 'file', accept: '.gia', onChange: event => { void importTemplate(event.target.files?.[0]); event.target.value = '' } }))
    const masthead = h('header', { className: 'look2-masthead' },
      h('button', { className: 'look2-menu-button', title: '工作区存档', 'aria-label': '工作区存档', disabled: interactionLocked, onClick: () => setShowWorkspace(!showWorkspace) }, icon('menu', 30)),
      h('div', { className: 'look2-brand' }, h('span', { className: 'look2-brand-mark', 'aria-hidden': true }, '✦'), h('strong', null, '客户端 UI 动画编辑器'), h('small', null, 'look2.0'),
        h('span', { className: 'look2-brand-credit' }, '幻萌（emo）致谢：晓末L444，嘟嘟可')),
      h('div', { className: 'look2-look-tools', 'aria-label': 'Look 工具' },
        h('div', { className: 'look2-asset-switch', role: 'group', 'aria-label': '编辑资产', inert: interactionLocked },
          h('button', { type: 'button', className: clientTemplates ? '' : 'active', onClick: () => void selectAsset('server-control-template') }, '服务端 UI'),
          h('button', { type: 'button', className: clientTemplates ? 'active' : '', onClick: () => void selectAsset('client-control-template') }, '客户端模板')),
      h('div', { className: 'tool-group play-group' },
        h('div', { className: 'look2-play-config' }, h('label', null, '目标'), h('select', { value: playTarget, disabled: interactionLocked, 'aria-label': '试玩目标', onChange: event => setPlayTarget(event.target.value) },
          h('option', { value: 'full' }, PLAY_TARGET_GUIDE.full.label), h('option', { value: 'template', disabled: !clientTemplates }, PLAY_TARGET_GUIDE.template.label)),
          h('span', { className: 'look2-play-target-help' },
            h('button', { type: 'button', className: 'look2-play-help-trigger', 'aria-label': '试玩目标说明', 'aria-expanded': showPlayHelp, title: playHelpTitle, onClick: () => setShowPlayHelp(value => !value) }, '▾'),
            showPlayHelp ? h('div', { className: 'look2-play-help-backdrop', 'aria-hidden': true, onClick: () => setShowPlayHelp(false) }) : null,
            showPlayHelp ? h('div', { className: 'look2-play-help-panel', role: 'tooltip' },
              h('span', { className: 'look2-play-help-row' }, h('b', null, PLAY_TARGET_GUIDE.full.label), '：', PLAY_TARGET_GUIDE.full.detail),
              h('span', { className: 'look2-play-help-row' }, h('b', null, PLAY_TARGET_GUIDE.template.label), '：', PLAY_TARGET_GUIDE.template.detail),
              h('span', { className: 'look2-play-help-diff' }, PLAY_TARGET_GUIDE.difference)) : null),
          h('label', null, '人数'), h('select', { value: playerCount, disabled: interactionLocked, 'aria-label': '试玩人数', onChange: event => setPlayerCount(Number(event.target.value)) }, Array.from({ length: 8 }, (_, index) => h('option', { key: index + 1, value: index + 1 }, `${index + 1}人`)))),
         h('button', { type: 'button', className: inlinePlaying ? 'look2-play-stop' : 'primary', disabled: playStarting, onClick: () => inlinePlaying ? stopInlinePlay() : void startInlinePlay() }, inlinePlaying ? '停止试玩' : playStarting ? '准备试玩…' : '▶ 试玩'),
         playLauncher ? h('button', { type: 'button', title: '在新窗口打开完整界面试玩', disabled: interactionLocked || playLauncher.opening, onClick: startExternalPlay }, playLauncher.opening ? '打开中…' : '新窗口') : null)))
    const topBar = h('header', { className: 'look2-top' },
      h('div', { className: 'tool-group', inert: interactionLocked },
        h('button', { title: '工作区存档', onClick: () => setShowWorkspace(!showWorkspace) }, icon('folder'), '工作区'),
        h('div', { className: 'look2-project-copy' }, h('strong', { title: snap.save?.name || filePath }, snap.save?.name || '默认工作区'), h('small', { title: filePath }, filePath || '新建动画')),
        h('button', { title: '新建工程', onClick: () => void newDocument() }, icon('plus'), '新建文件'),
        h('button', { title: '保存当前存档', onClick: () => void save() }, icon('save'), '保存'),
        h('button', { title: '撤销', 'aria-label': '撤销', onClick: undo, disabled: !snap.history?.canUndo }, icon('undo')),
        h('button', { title: '重做', 'aria-label': '重做', onClick: redoAction, disabled: !snap.history?.canRedo }, icon('redo')),
        h('button', { title: '历史记录', 'aria-label': '历史记录', onClick: () => setShowHistory(true) }, icon('history'))),
      h('div', { className: 'tool-group', inert: interactionLocked }, h('select', { className: 'tool-select', title: '导入文件', defaultValue: '', onChange: event => { const action = event.target.value; event.target.value = ''; if (action === 'spine') folderRef.current?.click(); else fileRef.current?.click() } }, h('option', { value: '', disabled: true }, '导入'), h('option', { value: 'file' }, 'JSON / GIA / PSD / Lua'), h('option', { value: 'spine', disabled: !clientTemplates }, 'Spine 3.8 文件夹')),
        h('select', { className: 'tool-select', title: '导出文件', defaultValue: '', onChange: event => { const [format, arg = ''] = event.target.value.split('|'); event.target.value = ''; if (format) void exportFile(format, arg) } }, h('option', { value: '', disabled: true }, '导出'), h('option', { value: 'site-json' }, '站点 JSON'), h('option', { value: 'json' }, '当前界面 Authoring JSON'), h('option', { value: 'gia' }, 'GIA'), h('option', { value: 'gia-combined' }, 'GIA 整合包（控件+脚本）'), h('option', { value: 'save-gia' }, '资产包 GIA（已改动项）'), h('option', { value: 'save' }, '完整存档'), h('option', { value: 'timeline-data' }, 'Timeline Data'), h('option', { value: 'timeline-lib' }, 'TweenTimelineLib 8.3'), h('option', { value: 'animation-lua' }, '播放脚本 Lua'), h('option', { value: 'primitive-data', disabled: !clientTemplates }, 'PrimitiveData'), h('option', { value: 'primitive-lib', disabled: !clientTemplates }, 'PrimitiveImageLib'), h('option', { value: 'primitive-svg', disabled: !clientTemplates }, '图元 SVG'), h('option', { value: 'primitive-css', disabled: !clientTemplates }, '图元 CSS'))),
      h('div', { className: 'tool-group', inert: interactionLocked },
        h('button', { title: '控件模板', disabled: !clientTemplates, onClick: () => setShowTemplates(true) }, '控件模板'),
        h('button', { title: '图片资源', disabled: !clientTemplates, onClick: () => setShowResources(true) }, '图片资源')),
      !error ? h('span', { className: 'look2-archive-status', title: message, role: 'status' }, message || '已载入 · 自动保存') : null,
      errorTrigger,
      psdImportName ? h('button', { title: `取消导入 ${psdImportName}`, onClick: () => { abortPsdImport(); setMessage('PSD 导入已取消；保留当前工程') } }, '取消 PSD 导入') : null,
      h('div', { className: 'tool-group', inert: interactionLocked },
        h('select', { className: 'look2-lua-tools', title: 'Lua 工具', 'aria-label': 'Lua 工具', defaultValue: '', onChange: event => { const format = event.target.value; event.target.value = ''; if (format === 'import') fileRef.current?.click(); else if (format) void exportFile(format) } },
          h('option', { value: '', disabled: true }, 'Lua 工具'), h('option', { value: 'import' }, '导入 Lua / Timeline Data'), h('option', { value: 'timeline-data' }, '导出 Timeline Data'), h('option', { value: 'timeline-lib' }, '导出 TweenTimelineLib'), h('option', { value: 'animation-lua' }, '导出播放脚本'), h('option', { value: 'primitive-data', disabled: !clientTemplates }, '导出图元数据'), h('option', { value: 'primitive-lib', disabled: !clientTemplates }, '导出图元运行库')),
        h('span', { className: 'look2-lib-version', title: '可导出的 TweenTimelineLib 版本' }, 'Lib:v8.3')),
      h('span', { className: 'spacer' }),
      h('div', { className: 'tool-group', inert: interactionLocked }, h('select', { className: 'tool-select canvas-select', title: '画布尺寸', value: snap.meta?.customCanvas ? '__custom__' : snap.canvasId, onChange: event => { if (event.target.value !== '__custom__') void patch({ op: 'setCanvas', canvasId: event.target.value }, '切换画布尺寸') } },
        snap.meta?.customCanvas ? h('option', { value: '__custom__', disabled: true }, `${snap.canvas.label} · ${snap.canvas.width}×${snap.canvas.height}`) : null,
        snap.canvas.presets.map(preset => h('option', { key: preset.id, value: preset.id }, preset.label)))),
      h('div', { className: 'look2-zoom-control', inert: interactionLocked },
        h('button', { title: '缩小', onClick: () => setZoom(value => Math.max(.15, value / 1.15)) }, '−'),
        h('span', { title: '画布实际缩放比例' }, `${Math.round(stageScale * 100)}%`),
        h('button', { title: '放大', onClick: () => setZoom(value => Math.min(6, value * 1.15)) }, '+')),
      h('button', { title: '适应画布', disabled: interactionLocked, onClick: () => { setZoom(1); setPan({ x: 0, y: 0 }) } }, icon('fit', 20)), importControl)
    const historyModal = showHistory ? h('div', { className: 'look2-modal-backdrop', onClick: () => setShowHistory(false) }, h('div', { className: 'look2-modal', role: 'dialog', 'aria-label': '历史记录', onClick: event => event.stopPropagation() },
      h('header', null, h('strong', null, `历史记录 ${snap.history?.entries?.length || 0}`), h('span', { className: 'spacer' }), h('button', { onClick: () => setShowHistory(false) }, '关闭')),
      h('div', { className: 'look2-history-list' }, (snap.history?.entries || []).slice().reverse().map(entry => h('div', { className: 'look2-history-row', key: entry.index },
        h('button', { className: entry.index === snap.history.cursor ? 'selected' : '', onClick: () => { void historyAction('restore', entry.index); setShowHistory(false) } }, `${entry.index === snap.history.cursor ? '● ' : ''}${entry.label || '编辑'} · ${entry.index}`)))))) : null
    const timelineImportModal = pendingLuaFile ? h('div', { className: 'look2-modal-backdrop', onClick: () => setPendingLuaFile(null) }, h('div', { className: 'look2-modal lua-import', role: 'dialog', 'aria-label': 'Timeline Lua 导入方式', onClick: event => event.stopPropagation() },
      h('header', null, h('strong', null, '导入 Timeline Lua'), h('span', { className: 'spacer' }), h('button', { onClick: () => setPendingLuaFile(null) }, '关闭')),
      h('div', { className: 'look2-field wide', style: { padding: '12px 14px 4px' } }, h('label', null, pendingLuaFile.name), h('span', null, 'Timeline Data 可追加为新动画或替换当前动画；普通 Lua 脚本仍会按脚本导入。')),
      h('div', { className: 'look2-field', style: { padding: '4px 14px' } }, h('label', null, 'Timeline Data 处理方式'), h('select', { value: timelineImportMode, onChange: event => setTimelineImportMode(event.target.value) }, h('option', { value: 'append' }, '追加为新动画'), h('option', { value: 'replace' }, '替换当前动画'))),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '8px 14px 14px' } }, h('button', { onClick: () => setPendingLuaFile(null) }, '取消'), h('button', { className: 'primary', onClick: () => void importFile(pendingLuaFile, timelineImportMode) }, '导入')))) : null
    const templateModal = showTemplates && clientTemplates ? h('div', { className: 'look2-modal-backdrop', onClick: () => setShowTemplates(false) }, h('div', { className: 'look2-modal', role: 'dialog', 'aria-label': '控件模板', onClick: event => event.stopPropagation() },
      h('header', null, h('strong', null, `控件模板 ${state.controlTemplates.length}`), h('span', { className: 'spacer' }), h('button', { onClick: () => templateFileRef.current?.click() }, '导入 GIA'), h('button', { onClick: () => setShowTemplates(false) }, '关闭')),
      Array.isArray(snap.look2Warnings) && snap.look2Warnings.length ? h('div', { role: 'alert', style: { margin: '8px 10px 0', padding: '8px 10px', color: '#ffe0a3', background: '#4b371d', border: '1px solid #85653a', borderRadius: 4 } }, snap.look2Warnings.map((warning, index) => h('div', { key: `look2-warning-${index}` }, String(warning)))) : null,
      h('div', { className: 'look2-template-list' }, state.controlTemplates.map((template, index) => h('div', { className: 'look2-template-row', key: template.id },
        h(DraftInput, { key: `${template.id}:name`, value: template.name || `模板 ${index + 1}`, type: 'text', ariaLabel: `${template.name || '模板'}名称`,
          onDiscardError: discardInputError,
          onCommit: name => updateTemplate(template.id, { name: name.trim() }),
          readCommitted: next => next.look2.controlTemplates.find(item => item.id === template.id)?.name }),
        h('label', null, '索引'), h(DraftInput, { key: `${template.id}:index`, type: 'number', min: 1, value: template.index ?? (index + 1), ariaLabel: `${template.name || '模板'}索引`,
          onDiscardError: discardInputError,
          onCommit: order => updateTemplate(template.id, { index: order }),
          readCommitted: next => next.look2.controlTemplates.find(item => item.id === template.id)?.index }),
        h('button', { title: '实例化到所选容器', onClick: () => void instantiateTemplate(template) }, '实例化'), h('button', { title: '删除模板', onClick: () => void removeTemplate(template.id) }, '×')))))) : null
    const contextData = contextMenu?.data
    function setContextEase(ease) {
      const target = contextMenu?.data
      if (!target?.trackId || !target?.keyId) return
      void updateAnimation(animation => {
        const track = animation.keyframeTracks.find(item => item.id === target.trackId)
        const keyframe = track?.keyframes.find(item => item.id === target.keyId)
        if (keyframe && track.fieldKey !== 'visible') keyframe.easeType = ease
      }, `设置缓动为 ${ease}`)
    }
    const contextTrack = contextData?.trackId ? allTracks.find(track => track.id === contextData.trackId) : null
    const contextNode = treeRowById.get(contextData)
    const contextParent = contextNode?.parentId ? findProjectNode(snap.root, contextNode.parentId)
      : snap.root.children?.some(node => node.id === contextData) ? snap.root : null
    const contextIndex = contextParent?.children.findIndex(node => node.id === contextData) ?? -1
    const atTop = contextIndex <= 0
    const atBottom = contextIndex < 0 || contextIndex === contextParent.children.length - 1
    const contextItems = contextMenu?.type === 'node' ? [
      ['选择控件', () => selectControl(contextData)], ['复制控件', () => duplicateControl(contextData)], ['删除控件', () => deleteControl(contextData)],
      ['上移层级', () => moveNode(contextData, 'up'), atTop], ['下移层级', () => moveNode(contextData, 'down'), atBottom],
      ['置顶', () => moveNode(contextData, 'top'), atTop], ['置底', () => moveNode(contextData, 'bottom'), atBottom],
      ['在画布隐藏 / 显示', () => setNodeHidden(contextData)],
      [snap.editorLocks?.[contextData] ? '解锁控件' : '锁定控件', () => setNodeLocked(contextData, !snap.editorLocks?.[contextData])],
      ...(row && row.id !== contextData ? [[`移入“${row.name}”`, () => reparentNode(contextData, row.id)]] : []),
    ] : contextMenu?.type === 'key' ? [
      ['复制选中关键帧', copySelectedKeys], ['粘贴到播放头', pasteKeys], ['删除选中关键帧', removeSelectedKeys],
      ...(contextTrack?.fieldKey === 'visible' ? [] : EASE_TYPES.map(ease => [`缓动 · ${ease}`, () => setContextEase(ease)])),
    ] : contextMenu?.type === 'timeline-lane' ? [['在此处添加关键帧', () => addKeyframeAt(contextData.trackId, contextData.time)]]
      : contextMenu?.type === 'animation' ? [['复制动画', () => duplicateAnimation(contextData)], ['删除动画', () => removeAnimation(contextData)]]
      : contextMenu?.type === 'track' ? [['添加当前关键帧', () => { const track = allTracks.find(item => item.id === contextData); if (track) addKeyframe(track) }], ['删除轨道', () => removeTrack(contextData)]]
        : contextMenu?.type === 'event' ? [['删除事件', () => removeEvent(contextData)]]
          : contextMenu?.type === 'stage' ? [...(clientTemplates ? [[state.siteExtras?.backgroundChoice === 'blank' ? '显示参考背景图' : '隐藏参考背景图', () => void editState(next => { next.siteExtras.backgroundChoice = next.siteExtras.backgroundChoice === 'blank' ? 'reference' : 'blank' }, '切换画布背景')]] : []), ['重置画布视图', () => { setZoom(1); setPan({ x: 0, y: 0 }) }]] : []
    const contextMenuView = contextMenu && !interactionLocked ? h('div', { className: 'look2-context-menu', style: { left: contextMenu.x, top: contextMenu.y }, onPointerDown: event => event.stopPropagation() }, contextItems.map(([label, action, disabled], index) => h('button', { key: `${label}-${index}`, disabled: !!disabled, onClick: () => { setContextMenu(null); void Promise.resolve().then(action).catch(reason => setError(String(reason?.message || reason))) } }, label))) : null
    const { root: rootArchives, other: otherArchives } = groupWorkspaceArchives(archives)
    const visibleArchiveCount = showTestArchives ? archives.length : rootArchives.length
    const archiveOption = entry => h('option', { key: entry.path, value: entry.path }, String(entry.path || '').includes('/') ? `${entry.name || entry.path} · ${entry.path}` : (entry.name || entry.path))
    const workspaceRow = showWorkspace ? h('div', { className: 'look2-workspace', inert: interactionLocked },
      h('div', { className: 'look2-workspace-row' },
        h('span', null, '工程名'), h(DraftInput, { value: snap.save?.name || '', ariaLabel: '工程名称', title: '工程名称',
          wrapperStyle: { flex: '0 1 160px' }, inputStyle: { width: '100%', minWidth: 0 },
          onDiscardError: discardInputError,
          onCommit: name => patch({ op: 'renameSave', name }, '修改工程名称'),
          readCommitted: next => next.save.name }),
        h('span', null, '存档路径'), h('input', { className: 'file-name', type: 'text', 'aria-label': '项目存档路径', value: filePath, onChange: event => setFilePath(event.target.value), title: filePath }), h('button', { onClick: () => void save() }, '保存')),
      h('details', { className: 'look2-usage' }, h('summary', null, '使用说明'),
        h('ol', { className: 'look2-usage-list' }, LOOK2_USAGE_STEPS.map((step, index) => h('li', { key: index }, step)))),
      h('div', { className: 'look2-workspace-row' },
        h('span', null, '存档'),
        h('select', { className: 'look2-archive-select', 'aria-label': '工作区存档列表', value: selectedArchive, onChange: event => setSelectedArchive(event.target.value) },
          h('option', { value: '' }, visibleArchiveCount ? `选择存档（共 ${visibleArchiveCount} 个）` : '工作区暂无存档'),
          rootArchives.length ? h('optgroup', { label: '工作区存档' }, rootArchives.map(archiveOption)) : null,
          showTestArchives && otherArchives.length ? h('optgroup', { label: '测试文件' }, otherArchives.map(archiveOption)) : null),
        h('button', { disabled: !selectedArchive, onClick: () => selectedArchive && void load(selectedArchive) }, '打开'),
        h('button', { disabled: !selectedArchive, title: '在文件管理器中打开所在文件夹', onClick: () => void revealArchive(selectedArchive) }, '打开文件夹'),
        h('button', { className: 'look2-danger', disabled: !selectedArchive, title: '永久删除所选存档', onClick: () => setPendingArchiveDelete(selectedArchive) }, '删除'),
        h('label', { className: 'look2-archive-filter', title: '关闭时只显示工作区存档，打开后一并显示子目录里的测试文件' },
          h('input', { type: 'checkbox', checked: showTestArchives, onChange: event => {
            const next = event.target.checked
            setShowTestArchives(next)
            if (!next && String(selectedArchive).includes('/')) setSelectedArchive('')
          } }),
          '显示测试文件'))) : null
    const archiveDeleteModal = pendingArchiveDelete ? h('div', { className: 'look2-modal-backdrop', onClick: () => setPendingArchiveDelete('') },
      h('div', { className: 'look2-modal lua-import', role: 'dialog', 'aria-label': '删除存档', onClick: event => event.stopPropagation() },
        h('header', null, h('strong', null, '删除存档'), h('span', { className: 'spacer' }), h('button', { onClick: () => setPendingArchiveDelete('') }, '关闭')),
        h('div', { className: 'look2-field wide', style: { padding: '12px 14px 4px' } },
          h('label', null, pendingArchiveDelete),
          h('span', null, '将从工作区磁盘上永久删除该文件，删除后无法恢复。')),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '8px 14px 14px' } },
          h('button', { onClick: () => setPendingArchiveDelete('') }, '取消'),
          h('button', { className: 'primary', onClick: () => void confirmArchiveDelete() }, '确认删除')))) : null
    const draftRow = draft ? h('div', { className: 'look2-sub', inert: interactionLocked }, h('span', null, '发现 IndexedDB 自动草稿'), h('button', { onClick: () => void recoverDraft() }, '恢复草稿'), h('button', { onClick: () => void ignoreDraft() }, '忽略')) : null
    return h('div', { ref: editorRootRef, className: `look2${inlinePlaying ? ' playing' : playStarting ? ' starting' : ''}`, onPointerMove: movePointer, onPointerUp: endPointer, onPointerCancel: cancelPointer,
      onContextMenu: event => { if (!inlinePlaying && event.target === event.currentTarget) contextFor(event, 'stage', null) },
      style: { '--tree-width': `${hiddenPanels.tree ? 28 : panelWidths.tree}px`, '--anim-width': `${hiddenPanels.animator ? 28 : panelWidths.animator}px`, '--inspector-width': `${hiddenPanels.inspector ? 28 : panelWidths.inspector}px` } },
      masthead, topBar, workspaceRow, draftRow,
      h('div', { className: paneClasses }, treePane, stage, animatorPane, inspectorPane), dock,
       resourcePanel, historyModal, templateModal, timelineImportModal, archiveDeleteModal, contextMenuView, errorHistoryDialog,
       playLauncher?.overlay)
  }
  return { AnimationView, ensureStyle }
}
