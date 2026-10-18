export function buildControlGuidSyncPrompt(current) {
  const changes = current.controlGuidChanges || []
  return ['请完成模拟器控件索引与 Lua 引用同步。',
    `工作区：${current.workspace?.path || '请先核对工作区'}`,
    `最新完整存档：${current.storage.path}（编辑器已保存）`,
    `Lua 文件：${(current.scripts || []).map(row => row.path || `内联脚本 ${row.id}`).join('、') || '暂无'}`,
    '先从上述文件重新加载最新存档，不要使用另一个 MCP/Web 进程里的旧工程。',
    `获取新旧映射：读取该 JSON 顶层的 controlGuidChanges 数组，当前共 ${changes.length} 条，必须读取全部记录。oldGuid 是旧索引，newGuid 是新索引；controlAsset + controlId 标识控件，controlName 是名称，id 是记录编号，batchId 是批次。`,
    '获取脚本：读取 assets.scripts 数组；每项的 source 是存档内源码，path 是脚本文件路径（相对路径以工作区为基准）。',
    '按控件身份和变更顺序核对全部 Lua 脚本的索引常量、配置表与调用，修改存档中的 source 及相关 Lua 源文件和生成器映射，避免重建后覆盖。不要全局替换同值数字，也不要改运行时实例 ID 或图片资源 ID。',
    '同一 batchId 是同时映射，须按原值一次性应用，不能逐条替换导致索引串改。',
    '检查旧索引引用并重新试玩；仅在引用全部同步或明确没有引用后，用 acknowledgeControlGuidChanges 的 changeIds 清除已核对记录，保存完整存档。未判断的记录继续保留。',
    '完成后告知用户重新载入这个存档，再通过编辑器下方面板的“同步”更新游戏文件；不要重新导入 GIA，也不要擅自复制到游戏目录。'].join('\n')
}

export function createControlGuidSyncPanel(React) {
  const e = React.createElement
  return function ControlGuidSyncPanel({ snap, prepare, patch, copy, onScripts, onError, reloadArchive }) {
    const [busy, setBusy] = React.useState(false)
    const [plan, setPlan] = React.useState(null)
    const [result, setResult] = React.useState(null)
    const [prompt, setPrompt] = React.useState('')
    const [collapsed, setCollapsed] = React.useState(false)
    const panelRef = React.useRef(null)
    const pending = snap.controlGuidChanges || []
    const latestChangeId = pending.at(-1)?.id || ''
    React.useEffect(() => { setPlan(null); setPrompt('') }, [snap.version, snap.save?.name])
    React.useEffect(() => { setCollapsed(false) }, [latestChangeId, snap.save?.name])
    React.useLayoutEffect(() => { if (prompt && panelRef.current) panelRef.current.scrollTop = 0 }, [prompt])
    const run = fn => async () => {
      setBusy(true)
      try { await fn() } catch (error) { onError(error?.message || String(error)) }
      finally { setBusy(false) }
    }
    const handoff = run(async () => {
      setPrompt(await copy()); setPlan(null)
      if (panelRef.current) panelRef.current.scrollTop = 0
    })
    if (!pending.length && !result) return null
    if (collapsed) return e('div', { style: { flexShrink: 0, padding: '2px 10px' } },
      e('button', { className: 'qxsim-action', onClick: () => setCollapsed(false) }, `Lua 索引待同步（${pending.length} 项）· 展开`))
    return e('section', { ref: panelRef, className: 'qxsim-note', 'aria-label': 'Lua 索引同步', style: { flexShrink: 0, maxHeight: 270, overflow: 'auto', overflowWrap: 'anywhere' } },
      e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        e('strong', null, pending.length ? `下一步：同步 Lua 索引引用（${pending.length} 项）` : '脚本全量替换已完成'),
        e('button', { className: 'qxsim-action', 'aria-label': '关闭索引同步提示', title: '收起提示，保留待同步记录', disabled: busy,
          onClick: () => { if (pending.length) setCollapsed(true); else setResult(null) } }, '关闭')),
      prompt ? e('details', { open: true }, e('summary', null, '同步任务（粘贴给当前项目的 AI）'), e('textarea', { 'aria-label': 'AI 索引同步任务', readOnly: true, value: prompt, rows: 5, style: { width: '100%', boxSizing: 'border-box' } }),
        e('button', { className: 'qxsim-action', disabled: busy, onClick: run(reloadArchive) }, 'AI 已处理，重新载入存档')) : null,
      e('div', null, pending.length ? '控件索引已修改，请选择一种方式同步脚本。' : '请检查替换结果并保存存档，再到「Lua 脚本 → 实机脚本同步」更新游戏里的文件并重新试玩。'),
      pending.length ? e(React.Fragment, null,
        e('div', { role: 'group', 'aria-label': '索引同步方式', style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 5 } },
          e('div', { style: { flex: '1 1 280px' } },
          e('button', { className: 'qxsim-action', disabled: busy, onClick: run(async () => {
            await prepare()
            const next = await patch({ op: 'previewControlGuidSync' })
            const preview = next.controlGuidSyncPreview
            setResult(null); setPrompt('')
            if (!preview.canApply) { setPlan(preview); return }
            const applied = await patch({ op: 'syncControlGuidReferences', planId: preview.id })
            setResult(applied.controlGuidSyncResult); setPlan(null)
          }) }, '全量替换脚本索引'),
          e('div', null, e('strong', null, '可能错误地替换非索引内容。'), '按完整十进制数字替换所有已登记脚本，包括配置表、字符串和注释；同时更新内容一致的工作区源文件，替换前自动备份。')),
          e('div', { style: { flex: '1 1 280px' } },
          e('button', { className: 'qxsim-action', disabled: busy, onClick: handoff }, '复制提示词给 AI'),
          e('div', null, '先保存最新存档，再复制包含映射读取方式和脚本位置的提示词，由 AI 判断哪些引用需要更新。'))),
        e('details', null, e('summary', null, `查看索引变更（${pending.length} 项）`),
          e('ul', null, pending.slice(0, 20).map(row => e('li', { key: row.id }, `${row.controlName}：${row.oldGuid} → ${row.newGuid}`))),
          pending.length > 20 ? e('div', null, '这里显示前 20 项；完整映射随存档保存，复制的任务会引导 AI 读取全部。') : null)) : null,
      plan ? e('div', { 'aria-label': 'Lua 索引同步问题' },
        e('p', null, '源码文件或索引映射存在冲突，本次没有修改脚本。可复制提示词给 AI 处理。'),
        plan.issues.map((issue, i) => e('div', { key: i }, issue)),
        plan.rows.filter(row => row.issues.length).map(row => e('details', { key: row.id, open: true },
          e('summary', null, row.path || '内联脚本'),
          row.issues.slice(0, 12).map((issue, i) => e('div', { key: `i${i}` }, `${issue.line ? `第 ${issue.line} 行：` : ''}${issue.reason}`)),
          row.issues.length > 12 ? e('div', null, '其余问题请由 AI 核对。') : null))) : null,
      result && !pending.length ? e(React.Fragment, null,
        e('div', null, `已替换 ${result.scripts} 个脚本的 ${result.replacements} 处文本，更新 ${result.projectFiles} 个项目文件。备份：${result.backupRoot}`),
        e('button', { className: 'qxsim-action', onClick: onScripts }, '前往 Lua 脚本')) : null)
  }
}
