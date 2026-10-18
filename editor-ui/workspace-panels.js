import { createNode } from '../studio/ui/authoring.js'
import { inspectorDto, layoutTree } from '../studio/ui/inspector.js'

export function createWorkspacePanels(React, {
  BaseInspector,
  ControlScriptTab,
  ScriptPage,
  ServerLogicPage,
  cloneServerLogic,
  logicDraftIssues,
  sanitizeLogic,
}) {
  const h = React.createElement
  const WorkspaceContext = React.createContext(null)

  function WorkspaceProvider({ children, beforeActionRef }) {
    const [selectedScriptId, setSelectedScriptId] = React.useState('')
    const [scriptDraft, setScriptDraft] = React.useState(null)
    const [logicDraft, setLogicDraft] = React.useState(() => cloneServerLogic(null))
    const [notice, setNotice] = React.useState('')
    const scriptDraftRef = React.useRef(scriptDraft)
    const logicDraftRef = React.useRef(logicDraft)
    const environmentRef = React.useRef({})
    scriptDraftRef.current = scriptDraft
    logicDraftRef.current = logicDraft


    function syncSnapshot(snap, preferredId = selectedScriptId) {
      environmentRef.current.snap = snap
      const nextId = snap?.scripts?.some(script => script.id === preferredId)
        ? preferredId : (snap?.scripts?.[0]?.id || '')
      setSelectedScriptId(previous => previous === nextId ? previous : nextId)
      const entry = snap?.scripts?.find(script => script.id === nextId) || null
      setScriptDraft(previous => previous?.dirty && previous.id === entry?.id ? previous : entry
        ? { id: entry.id, path: entry.path, source: entry.source, controlId: entry.controlId, controlAsset: entry.controlAsset, dirty: false }
        : null)
      setLogicDraft(previous => previous?.dirty ? previous : cloneServerLogic(snap?.serverLogic))
    }

    function sameScript(left, right) {
      return !!left && !!right && left.id === right.id && left.path === right.path
        && left.source === right.source && left.controlId === right.controlId
        && left.controlAsset === right.controlAsset
    }

    async function saveScriptDraft() {
      const draft = scriptDraftRef.current
      const patch = environmentRef.current.patch
      if (!draft?.dirty) return
      if (!patch) throw new Error('编辑工作区尚未就绪，Lua 修改仍保留在草稿中')
      const submitted = { ...draft }
      await patch({ op: 'updateScript', id: submitted.id, path: submitted.path, source: submitted.source, controlId: submitted.controlId, controlAsset: submitted.controlAsset })
      if (sameScript(scriptDraftRef.current, submitted)) {
        const saved = { ...scriptDraftRef.current, dirty: false }
        scriptDraftRef.current = saved
        setScriptDraft(previous => sameScript(previous, submitted) ? saved : previous)
      }
    }

    async function saveLogicDraft() {
      const draft = logicDraftRef.current
      const patch = environmentRef.current.patch
      if (!draft?.dirty) return
      const issues = logicDraftIssues(draft)
      if (issues.length) throw new Error(issues[0])
      if (!patch) throw new Error('编辑工作区尚未就绪，服务端逻辑修改仍保留在草稿中')
      const submitted = JSON.stringify(draft)
      const next = await patch({ op: 'setServerLogic', logic: sanitizeLogic(draft) })
      if (JSON.stringify(logicDraftRef.current) === submitted) {
        const saved = cloneServerLogic(next.serverLogic)
        logicDraftRef.current = saved
        setLogicDraft(previous => JSON.stringify(previous) === submitted ? saved : previous)
      }
      setNotice('服务端逻辑已提交到当前工程')
    }

    const flush = async () => {
      await saveScriptDraft()
      await saveLogicDraft()
      await environmentRef.current.waitForQueue?.()
    }
    React.useEffect(() => {
      if (!beforeActionRef) return undefined
      beforeActionRef.current = flush
      return () => { if (beforeActionRef.current === flush) beforeActionRef.current = null }
    }, [beforeActionRef])

    const value = {
      selectedScriptId, setSelectedScriptId, scriptDraft, setScriptDraft, scriptDraftRef,
      logicDraft, setLogicDraft, logicDraftRef, notice, setNotice,
      environmentRef, syncSnapshot, saveScriptDraft, saveLogicDraft, flush,
    }
    return h(WorkspaceContext.Provider, { value }, children)
  }

  function useWorkspace() {
    const value = React.useContext(WorkspaceContext)
    if (!value) throw new Error('WorkspaceProvider is missing')
    return value
  }

  function WorkspaceInspector({ mode = 'base', snap, patch, applyFieldGroup, transformPlatform, extraTransformFields, transformHeader, onError, onDiscardInputError, setDockTab }) {
    const workspace = useWorkspace()
    const [propertyClipboard, setPropertyClipboard] = React.useState(null)
    workspace.environmentRef.current = { ...workspace.environmentRef.current, snap, patch, onError }
    React.useEffect(() => { workspace.syncSnapshot(snap, workspace.selectedScriptId) }, [snap, workspace.selectedScriptId])
    const selectedId = snap?.selectedId || ''
    const report = reason => onError?.(String(reason?.message || reason))
    const targetKind = snap?.inspector?.kind || ''
    const targetAsset = snap?.asset?.type || ''
    const targetPlatform = transformPlatform || snap?.canvas?.platform || ''
    const commit = (key, value) => (applyFieldGroup
      ? applyFieldGroup({ id: selectedId, assetType: targetAsset, kind: targetKind, platform: targetPlatform, values: { [key]: value }, label: `设置 ${snap?.inspector?.fields?.find(field => field.key === key)?.label || key}` })
      : patch(key === 'locked'
        ? { op: 'setEditorLock', id: selectedId, locked: value === true }
        : { op: 'set', id: selectedId, key, value })).catch(reason => { report(reason); throw reason })
    commit.discardError = onDiscardInputError
    const canCrossKind = groupId => ['transform', 'creation', 'editor'].includes(groupId)
    const groupCompatible = (groupId, source) => {
      if (!source || source.assetType !== targetAsset || source.platform !== targetPlatform) return false
      if (canCrossKind(groupId)) return true
      if (groupId === 'image' || groupId === 'mask') return source.kind === 'image' && targetKind === 'image'
      return source.kind === targetKind
    }
    const canPasteGroup = (groupId, keys = []) => Boolean(propertyClipboard
      && propertyClipboard.groupId === groupId
      && groupCompatible(groupId, propertyClipboard)
      && Object.keys(propertyClipboard.values || {}).some(key => keys.includes(key)))
    function copyGroup(groupId, values) {
      const entries = Object.entries(values || {})
      if (!entries.length || !selectedId || !targetKind || !targetAsset) return
      setPropertyClipboard({
        groupId, assetType: targetAsset, kind: targetKind, platform: targetPlatform,
        values: Object.fromEntries(entries.map(([key, value]) => [key, value == null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value))])),
      })
    }
    function findSnapshotNode(node, id) {
      if (!node) return null
      if (node.id === id) return node
      for (const child of node.children || []) {
        const found = findSnapshotNode(child, id)
        if (found) return found
      }
      return null
    }
    const transformNode = snap?.root ? findSnapshotNode(snap.root, selectedId) : null
    const groupExtraValues = transformNode?.transformByPlatform?.[targetPlatform]
      ? { transform: { __transform: transformNode.transformByPlatform[targetPlatform] } }
      : {}
    function defaultGroupValues(keys) {
      if (!snap?.inspector || !selectedId) return {}
      const row = snap.tree?.find(item => item.id === selectedId)
      const wrappedServerRoot = targetAsset === 'server-control-template' && snap.root?.kind === 'server-container'
        && snap.root.children?.some(child => child.id === selectedId && child.kind === 'container')
      const isRootContainer = targetKind === 'container' && (snap.root?.kind === 'container' && snap.root.id === selectedId || wrappedServerRoot)
      const defaults = createNode(targetKind, { id: 'look2-property-reset', isRootContainer })
      const boxes = layoutTree(defaults, snap.canvas).boxes
      const defaultFields = new Map(inspectorDto(defaults, snap.canvas, boxes[defaults.id])?.fields?.map(field => [field.key, field]) || [])
      const defaultTransform = defaults.transformByPlatform?.[targetPlatform]
      return Object.fromEntries(keys.flatMap(key => key === 'locked'
        ? [[key, false]]
        : key === '__transform' && defaultTransform ? [[key, defaultTransform]]
          : defaultFields.has(key) ? [[key, defaultFields.get(key).value]] : []))
    }
    async function applyGroup(groupId, keys, values, action) {
      const updates = Object.fromEntries(Object.entries(values || {}).filter(([key]) => keys.includes(key)))
      if (!Object.keys(updates).length) return
      if (!applyFieldGroup) throw new Error('属性组事务接口尚未就绪')
      const groupLabels = { transform: '变换', creation: '创建设置', control: '控件设置', editor: '编辑器设置', image: '图片设置', mask: '遮罩设置' }
      await applyFieldGroup({
        id: selectedId, assetType: targetAsset, kind: targetKind, platform: targetPlatform,
        values: updates, label: `${action}「${groupLabels[groupId] || groupId}」属性组`,
      })
    }
    function pasteGroup(groupId, keys) {
      if (!canPasteGroup(groupId, keys)) return
      void applyGroup(groupId, keys, propertyClipboard.values, '粘贴').catch(report)
    }
    function resetGroup(groupId, keys) {
      void applyGroup(groupId, keys, defaultGroupValues(keys), '重置').catch(report)
    }
    async function createStateChild(key, label) {
      const parentId = snap?.inspector?.id || selectedId
      if (!parentId) return
      try {
        const added = await patch({ op: 'add', kind: 'image', parentId, name: `${label}图片` })
        await patch({ op: 'set', id: parentId, key, value: added.selectedId })
        workspace.setNotice(`${label}已创建并绑定；可在控件树中继续编辑图片。`)
      } catch (reason) { report(reason) }
    }
    async function addScriptMounted(controlId) {
      try {
        const next = await patch({ op: 'addScript', controlId, controlAsset: snap.asset?.type || '' })
        const created = next.scripts?.[next.scripts.length - 1]
        if (created) workspace.setSelectedScriptId(created.id)
        setDockTab?.('lua')
      } catch (reason) { report(reason) }
    }
    async function mountScriptTo(id) {
      try { await patch({ op: 'updateScript', id, controlId: selectedId, controlAsset: snap.asset?.type || '' }) }
      catch (reason) { report(reason) }
    }
    async function unmountScript(id) {
      try { await patch({ op: 'updateScript', id, controlId: '' }) }
      catch (reason) { report(reason) }
    }
    if (!snap?.inspector) return h('div', { className: 'look2-empty-inspector' }, '请选择一个控件查看属性')
    if (mode === 'script') return h(ControlScriptTab, {
      snap,
      addScriptMounted,
      mountScriptTo,
      unmountScript,
      openScript: id => {
        void workspace.saveScriptDraft().then(() => { workspace.setSelectedScriptId(id); setDockTab?.('lua') }).catch(report)
      },
    })
    const inspector = snap.inspector.kind === 'server-container' ? snap.inspector : {
      ...snap.inspector,
      fields: [...(snap.inspector.fields || []), {
        key: 'locked', label: '在编辑器中锁定', type: 'bool', value: !!snap.editorLocks?.[selectedId],
      }],
    }
    return h(React.Fragment, null,
      h(BaseInspector, {
        key: `${snap.asset?.type || ''}:${snap.asset?.key || ''}:${selectedId}:${snap.inspector.id}:${snap.inspector.kind}:${targetPlatform}`,
        inspector, commit, createStateChild,
        onCopyGroup: copyGroup, onPasteGroup: pasteGroup, onResetGroup: resetGroup, canPasteGroup,
        groupExtraValues,
        extraTransformFields,
        transformHeader,
      }),
      h('div', { className: 'qxsim-tree-foot' }, h('button', {
        className: 'qxsim-action danger', style: { width: '100%' },
        onClick: () => { void patch({ op: 'remove' }).catch(report) },
      }, snap.asset?.type === 'client-control-template' && snap.tree.find(item => item.id === selectedId)?.depth === 0 ? '⌫ 删除当前模板' : '⌫ 删除当前控件')))
  }

  function WorkspaceDock({ activeTab, sessionId, snap, patch, api, exportFile, onError, onMessage, waitForQueue }) {
    const workspace = useWorkspace()
    workspace.environmentRef.current = {
      ...workspace.environmentRef.current, snap, patch, api, onError,
      waitForQueue,
    }
    React.useEffect(() => { workspace.syncSnapshot(snap, workspace.selectedScriptId) }, [snap, workspace.selectedScriptId])
    const report = reason => onError?.(String(reason?.message || reason))
    const updateDraft = fields => {
      const previous = workspace.scriptDraftRef.current || workspace.scriptDraft
      if (!previous) return
      const next = { ...previous, ...fields, dirty: true }
      workspace.scriptDraftRef.current = next
      workspace.setScriptDraft(next)
    }
    async function saveScript() {
      try { await workspace.saveScriptDraft(); onMessage?.('Lua 脚本已提交到当前工程') }
      catch (reason) { report(reason) }
    }
    async function addScript(fields = {}) {
      try {
        const next = await patch({ op: 'addScript', ...fields })
        const created = next.scripts?.[next.scripts.length - 1]
        if (created) workspace.setSelectedScriptId(created.id)
        return created
      } catch (reason) { report(reason); throw reason }
    }
    async function removeScript(id) {
      try {
        await patch({ op: 'removeScript', id })
        if (workspace.scriptDraftRef.current?.id === id) workspace.setScriptDraft(null)
        onMessage?.('脚本已删除')
      } catch (reason) { report(reason) }
    }
    async function selectScript(id) {
      try { await workspace.saveScriptDraft(); workspace.setSelectedScriptId(id) }
      catch (reason) { report(reason) }
    }
    const scriptEntry = snap?.scripts?.find(script => script.id === workspace.selectedScriptId)
    const scriptDraft = workspace.scriptDraft?.id === workspace.selectedScriptId
      ? workspace.scriptDraft
      : scriptEntry ? { id: scriptEntry.id, path: scriptEntry.path, source: scriptEntry.source, controlId: scriptEntry.controlId, controlAsset: scriptEntry.controlAsset, dirty: false } : null

    if (activeTab === 'lua') return h(ScriptPage, {
      snap, selectedScriptId: workspace.selectedScriptId, selectScript, draft: scriptDraft, updateDraft,
      saveScript, addScript: () => { void addScript() }, removeScript,
      exportLua: id => { void exportFile('lua', id) }, exportScripts: () => { void exportFile('scripts') },
      exportScriptsGia: () => { void exportFile('scripts-gia') }, notice: workspace.notice,
    })
    if (activeTab === 'logic') return h(ServerLogicPage, {
      snap, draft: workspace.logicDraft, setDraft: next => {
        const previous = workspace.logicDraftRef.current || workspace.logicDraft
        const value = typeof next === 'function' ? next(previous) : next
        workspace.logicDraftRef.current = value
        workspace.setLogicDraft(value)
      },
      saveLogic: () => { void workspace.saveLogicDraft().then(() => onMessage?.('服务端逻辑已提交到当前工程')).catch(report) },
      notice: workspace.notice, error: '',
    })
    return null
  }

  return { Provider: WorkspaceProvider, Inspector: WorkspaceInspector, Dock: WorkspaceDock }
}
