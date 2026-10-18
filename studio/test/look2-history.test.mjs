import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject, findNode } from '../ui/authoring.js'
import { createRuntime } from 'qxqy-lua-runtime'

const open = () => createStudio(createDefaultClientTemplateProject())
test('asset package retains an inactive layout whose only change is a client-control animation', () => {
  const studio = createStudio()
  const state = studio.get().look2
  state.animations[0].keyframeTracks = [{ id: 'layout-motion', nodeId: 'n2', fieldKey: 'anchoredPositionX',
    keyframes: [{ time: 0, value: 0 }, { time: 1, value: 80 }] }]
  studio.setLook2(state, studio.get().version)
  studio.patch({ op: 'selectAsset', assetType: 'client-control-template' })
  const exported = studio.exportData('save-gia')
  assert.ok(exported.files.some(file => file.filename.includes('服务器控件模板')))
  assert.ok(exported.files.some(file => file.filename.includes('脚本')))
  assert.equal(exported.warnings.some(message => message.includes('服务器控件模板仍是默认橱窗')), false)
})

test('new document resets client animation resources and scripts without writing files and can be undone as one edit', () => {
  const studio = open(), state = studio.get().look2
  state.primitiveResources.push({ id: 'old-resource', name: 'Before', imageUrl: 'data:image/png;base64,AAAA' })
  studio.setLook2(state, studio.get().version)
  studio.patch({ op: 'addScript', path: 'old', source: 'print("before")' })
  const before = studio.archiveData(), history = studio.get().history.entries.length
  const current = studio.transaction({ ops: [{ op: 'newDocument' }], expectedRevision: studio.get().version, label: '新建工程' })
  assert.equal(current.history.entries.length, history + 1)
  assert.deepEqual(current.look2.primitiveResources, [])
  assert.deepEqual(current.look2.controlTemplates, [])
  assert.equal(current.scripts.length, 0)
  assert.equal(current.look2.animations.length, 1)
  assert.equal(current.tree.length, 1)
  assert.equal(current.tree[0].name, 'Default_UI')
  studio.history({ action: 'undo', expectedRevision: current.version })
  const undone = studio.archiveData()
  for (const key of ['look2', 'serverLogic', 'activeAssetType']) assert.deepEqual(undone[key], before[key])
  assert.deepEqual(undone.assets.scripts, before.assets.scripts)
  assert.deepEqual(undone.assets.client.root, before.assets.client.root)
})
test('explicit controller layout edits preserve the other three slots and reject malformed transforms atomically', () => {
  const studio = open(), id = studio.get().selectedId
  const before = findNode(studio.archiveData().assets.client.root, id).transformByPlatform
  const transform = structuredClone(before.CONTROLLER_CONSOLE)
  transform.offset.x = 91; transform.rotation.z = 32; transform.scale.z = 2
  studio.transaction({ expectedRevision: studio.get().version, ops: [{ op: 'setPlatformTransform', id, platform: 'CONTROLLER_CONSOLE', transform }] })
  const after = findNode(studio.archiveData().assets.client.root, id).transformByPlatform
  assert.deepEqual(after.CONTROLLER_CONSOLE, transform)
  for (const platform of ['KEYBOARD', 'TOUCHSCREEN', 'CONTROLLER_MOBILE']) assert.deepEqual(after[platform], before[platform])
  const archive = studio.archiveData()
  transform.offset.x = NaN
  assert.throws(() => studio.transaction({ expectedRevision: studio.get().version, ops: [{ op: 'setPlatformTransform', id, platform: 'CONTROLLER_CONSOLE', transform }] }), /finite number/)
  assert.deepEqual(studio.archiveData(), archive)
})
test('shared document revisions remain monotonic when switching assets and reject stale animation edits', () => {
  const studio = open(), state = studio.get().look2, before = studio.get().version
  studio.patch({ op: 'set', key: 'name', value: '客户端修改', expectedRevision: before })
  const revised = studio.get().version
  studio.patch({ op: 'selectAsset', assetType: 'server-control-template', expectedRevision: revised })
  assert.equal(studio.get().version, revised)
  assert.throws(() => studio.setLook2(state, before), /revision conflict/)
  studio.patch({ op: 'renameSave', name: '共享工程', expectedRevision: revised })
  assert.ok(studio.get().version > revised)
  studio.patch({ op: 'selectAsset', assetType: 'client-control-template' })
  assert.equal(studio.get().version, revised + 1)
})
test('atomic tree and resource transaction rolls back every field on a failed operation', () => {
  const studio = open(), before = studio.archiveData(), revision = studio.get().version
  const id = studio.get().selectedId
  assert.throws(() => studio.transaction({ expectedRevision: revision, label: '拖动', ops: [
    { op: 'set', id, key: 'name', value: '改变后' }, { op: 'set', id, key: 'nonexistent', value: 1 },
  ] }), /unknown key/)
  assert.deepEqual(studio.archiveData(), before)
  assert.equal(studio.get().history.entries.length, 0)
})
test('one transaction has one history step, complete undo/redo, and monotonic revisions', () => {
  const studio = open(), before = studio.archiveData(), id = studio.get().selectedId
  const state = studio.get().look2
  state.primitiveResources.push({ id: 'shared', name: '资源', imageUrl: 'data:image/png;base64,AAAA' })
  const changed = studio.transaction({ expectedRevision: studio.get().version, label: '控件和素材', ops: [{ op: 'set', id, key: 'name', value: '动画根' }], state })
  assert.equal(changed.history.entries.length, 2)
  assert.equal(changed.history.entries[1].label, '控件和素材')
  const undone = studio.history({ action: 'undo', expectedRevision: changed.version })
  assert.ok(undone.version > changed.version)
  assert.equal(studio.archiveData().assets.client.root.children[0].name, before.assets.client.root.children[0].name)
  assert.equal(undone.look2.primitiveResources.length, 0)
  const redone = studio.history({ action: 'redo', expectedRevision: undone.version })
  assert.equal(redone.look2.primitiveResources[0].id, 'shared')
  assert.ok(redone.version > undone.version)
  studio.patch({ op: 'set', key: 'name', value: '新分支', expectedRevision: redone.version })
  assert.equal(studio.get().history.canRedo, false)
})
test('stale revision and invalid history action cannot change the document', () => {
  const studio = open(), before = studio.archiveData()
  assert.throws(() => studio.transaction({ expectedRevision: studio.get().version + 1, ops: [] }), /revision conflict/)
  assert.throws(() => studio.history({ action: 'restore', index: 900, expectedRevision: studio.get().version }), /没有可恢复/)
  assert.deepEqual(studio.archiveData(), before)
})
test('duplicate control preserves resources and tracks with independent IDs', () => {
  const studio = open(), rootId = studio.get().selectedId
  const state = studio.get().look2
  state.siteNodes[rootId] = { id: rootId, type: 'container', locked: true, properties: {} }
  state.animations[0].keyframeTracks = [{ id: 'track', nodeId: rootId, fieldKey: 'localScaleX', keyframes: [{ id: 'key', time: 0, value: 1, easeType: 'Linear', interpolation: 'tween' }] }]
  studio.setLook2(state, studio.get().version)
  const after = studio.patch({ op: 'duplicate', id: rootId, expectedRevision: studio.get().version })
  assert.notEqual(after.selectedId, rootId)
  assert.equal(after.look2.siteNodes[after.selectedId].locked, true)
  const tracks = after.look2.animations[0].keyframeTracks
  assert.equal(tracks.length, 2)
  assert.notEqual(tracks[0].id, tracks[1].id)
  assert.notEqual(tracks[0].keyframes[0].id, tracks[1].keyframes[0].id)
  const ids = new Set(), guids = new Set()
  const visit = node => { assert.ok(!ids.has(node.id)); ids.add(node.id); if (node.guid) { assert.ok(!guids.has(node.guid)); guids.add(node.guid) }; node.children.forEach(visit) }
  visit(studio.archiveData().assets.client.root)
})

test('removing a client subtree purges node metadata and animation references in one undoable transaction', () => {
  const studio = open(), state = studio.get().look2
  state.siteNodes.n2 = { id: 'n2', type: 'textbox', properties: { text: 'keep' } }
  state.siteNodes.n4 = { id: 'n4', type: 'button', properties: { imageResourceId: 'shared' } }
  state.siteNodes.n5 = { id: 'n5', type: 'textbox', properties: { text: 'remove' } }
  state.primitiveResources.push({ id: 'shared', name: 'Shared image', imageUrl: 'data:image/png;base64,AAAA' })
  state.animations[0].keyframeTracks = [
    { id: 'keep-track', nodeId: 'n2', fieldKey: 'fontSize', keyframes: [] },
    { id: 'remove-track', nodeId: 'n4', fieldKey: 'visible', keyframes: [] },
    { id: 'child-track', nodeId: 'n5', fieldKey: 'visible', keyframes: [] },
  ]
  state.animations[0].events = [
    { id: 'keep-event', time: 0, name: 'root', target: '', params: '' },
    { id: 'remove-event', time: 1, name: 'button', nodeId: 'n4', target: '确认按钮', params: '' },
    { id: 'child-event', time: 2, name: 'label', nodeId: 'n5', target: '确认按钮/按钮文字', params: '' },
  ]
  studio.setLook2(state, studio.get().version)
  const before = studio.get().look2
  const result = studio.transaction({ expectedRevision: studio.get().version, label: '删除按钮分支', ops: [{ op: 'remove', id: 'n4' }] })
  assert.equal(result.history.entries.at(-1).label, '删除按钮分支')
  assert.equal(findNode(studio.archiveData().assets.client.root, 'n4'), null)
  assert.equal(findNode(studio.archiveData().assets.client.root, 'n5'), null)
  assert.equal(result.look2.siteNodes.n2.id, 'n2')
  assert.equal(result.look2.siteNodes.n4, undefined)
  assert.equal(result.look2.siteNodes.n5, undefined)
  assert.deepEqual(result.look2.primitiveResources, before.primitiveResources)
  assert.deepEqual(result.look2.animations[0].keyframeTracks.map(row => row.id), ['keep-track'])
  assert.deepEqual(result.look2.animations[0].events.map(row => row.id), ['keep-event'])

  const undone = studio.history({ action: 'undo', expectedRevision: result.version })
  assert.deepEqual(undone.look2, before)
  assert.ok(findNode(studio.archiveData().assets.client.root, 'n4'))
  assert.ok(findNode(studio.archiveData().assets.client.root, 'n5'))
})

test('same control IDs isolate server locks and tree edits from client Look2 state across history and reopen', () => {
  const studio = open()
  studio.patch({ op: 'selectAsset', assetType: 'server-control-template' })
  const serverBasePreview = structuredClone(studio.get().animationPreviewRoot)
  studio.patch({ op: 'selectAsset', assetType: 'client-control-template' })
  const state = studio.get().look2
  state.siteNodes.n2 = { id: 'n2', type: 'textbox', properties: { text: 'client only' } }
  state.primitiveResources.push({ id: 'client-resource', name: 'Client image', imageUrl: 'data:image/png;base64,AAAA' })
  state.animations[0].keyframeTracks = [{ id: 'client-track', nodeId: 'n2', fieldKey: 'fontSize', keyframes: [] }]
  state.animations[0].events = [{ id: 'client-event', time: .5, name: 'client', nodeId: 'n2', target: '模板标题', params: '' }]
  studio.setLook2(state, studio.get().version)
  studio.patch({ op: 'addScript', path: 'legacy-ambiguous.lua', source: 'print("server target")', controlId: 'n2' })
  assert.equal(studio.get().scripts.find(row => row.path === 'legacy-ambiguous.lua').controlAsset, 'server-control-template')
  let client = studio.patch({ op: 'setEditorLock', id: 'n2', locked: true, expectedRevision: studio.get().version })
  const look2BeforeServerEdits = structuredClone(studio.archiveData().look2)
  assert.equal(client.editorLocks.n2, true)
  assert.equal(studio.archiveData().assets.client.meta.editorLocks.n2, true)

  studio.patch({ op: 'selectAsset', assetType: 'server-control-template' })
  const server = studio.get()
  assert.equal(server.look2.siteNodes.n2, undefined)
  assert.deepEqual(server.look2.primitiveResources, [])
  assert.deepEqual(server.look2.animations[0].keyframeTracks, [])
  assert.deepEqual(server.animationPreviewRoot, serverBasePreview, 'server editing preview must not sample client tracks with the same node ID')
  assert.deepEqual(server.editorLocks, {})
  const serverAnimation = structuredClone(server.look2)
  serverAnimation.animations[0].keyframeTracks = [{ id: 'server-track', nodeId: 'n2', fieldKey: 'fontSize', keyframes: [] }]
  studio.setLook2(serverAnimation, server.version)
  assert.deepEqual(studio.archiveData().look2, look2BeforeServerEdits)

  const locked = studio.patch({ op: 'setEditorLock', id: 'n2', locked: true, expectedRevision: studio.get().version })
  assert.equal(locked.editorLocks.n2, true)
  assert.deepEqual(studio.archiveData().look2, look2BeforeServerEdits)
  assert.equal(studio.archiveData().assets.client.meta.editorLocks.n2, true)

  const duplicated = studio.patch({ op: 'duplicate', id: 'n2', expectedRevision: locked.version })
  const duplicateId = duplicated.selectedId
  assert.equal(duplicated.editorLocks[duplicateId], true)
  assert.deepEqual(studio.archiveData().look2, look2BeforeServerEdits)
  const removed = studio.patch({ op: 'remove', id: 'n2', expectedRevision: duplicated.version })
  assert.equal(removed.editorLocks.n2, undefined)
  assert.equal(removed.scripts.find(row => row.path === 'legacy-ambiguous.lua').mounted, false)
  assert.deepEqual(studio.archiveData().look2, look2BeforeServerEdits)
  const undone = studio.history({ action: 'undo', expectedRevision: removed.version })
  assert.equal(undone.editorLocks.n2, true)
  assert.deepEqual(studio.archiveData().look2, look2BeforeServerEdits)
  const redone = studio.history({ action: 'redo', expectedRevision: undone.version })
  assert.equal(redone.editorLocks.n2, undefined)
  assert.equal(redone.editorLocks[duplicateId], true)
  assert.deepEqual(studio.archiveData().look2, look2BeforeServerEdits)

  let reopened = createStudio(studio.archiveData())
  assert.equal(reopened.get().editorLocks.n2, undefined)
  assert.equal(reopened.get().editorLocks[duplicateId], true)
  reopened.patch({ op: 'selectAsset', assetType: 'client-control-template' })
  client = reopened.get()
  assert.equal(client.editorLocks.n2, true)
  assert.equal(client.look2.animations[0].events[0].id, 'client-event')
  assert.deepEqual(client.look2.primitiveResources.map(row => row.id), ['client-resource'])

  const clientCopy = reopened.patch({ op: 'duplicate', id: 'n2', expectedRevision: client.version })
  const clientCopyId = clientCopy.selectedId
  assert.equal(clientCopy.editorLocks[clientCopyId], true)
  assert.equal(clientCopy.look2.animations[0].keyframeTracks.length, 2)
  assert.equal(clientCopy.look2.animations[0].events.length, 2)
  assert.deepEqual(clientCopy.look2.primitiveResources.map(row => row.id), ['client-resource'])
  assert.deepEqual(reopened.archiveData().look2, clientCopy.look2)

  const clientRemoved = reopened.patch({ op: 'remove', id: 'n2', expectedRevision: clientCopy.version })
  assert.equal(clientRemoved.editorLocks.n2, undefined)
  assert.equal(clientRemoved.look2.siteNodes.n2, undefined)
  assert.deepEqual(clientRemoved.look2.animations[0].keyframeTracks.map(row => row.nodeId), [clientCopyId])
  assert.deepEqual(clientRemoved.look2.animations[0].events.map(row => row.nodeId), [clientCopyId])
  assert.equal(clientRemoved.editorLocks[clientCopyId], true)
  assert.deepEqual(reopened.archiveData().assets.server.meta.editorLocks[duplicateId], true)
  assert.deepEqual(reopened.archiveData().look2.primitiveResources.map(row => row.id), ['client-resource'])

  const clientUndo = reopened.history({ action: 'undo', expectedRevision: clientRemoved.version })
  assert.equal(clientUndo.editorLocks.n2, true)
  assert.ok(clientUndo.look2.siteNodes.n2)
  const clientRedo = reopened.history({ action: 'redo', expectedRevision: clientUndo.version })
  assert.equal(clientRedo.editorLocks.n2, undefined)
  assert.deepEqual(clientRedo.look2.animations[0].events.map(row => row.nodeId), [clientCopyId])
  const look2AfterClientOps = structuredClone(reopened.archiveData().look2)
  const finalReopen = createStudio(reopened.archiveData())
  finalReopen.patch({ op: 'selectAsset', assetType: 'server-control-template' })
  assert.equal(finalReopen.get().editorLocks[duplicateId], true)
  assert.deepEqual(finalReopen.archiveData().look2, look2AfterClientOps)
})

test('duplicate names are unique by sibling and explicit name collisions fail atomically', () => {
  const studio = open()
  const copied = []
  for (let index = 0; index < 3; index += 1) {
    const result = studio.patch({ op: 'duplicate', id: 'n2', expectedRevision: studio.get().version })
    copied.push(findNode(studio.archiveData().assets.client.root, result.selectedId).name)
  }
  assert.deepEqual(copied, ['模板标题_副本', '模板标题_副本（2）', '模板标题_副本（3）'])
  const before = studio.archiveData(), revision = studio.get().version
  assert.throws(() => studio.patch({ op: 'duplicate', id: 'n2', name: '模板标题_副本', expectedRevision: revision }), /同级控件已存在名称/)
  assert.equal(studio.get().version, revision)
  assert.deepEqual(studio.archiveData(), before)
})

test('duplicated event node binding generates a fresh runtime payload target path', () => {
  const studio = open(), state = studio.get().look2
  state.animations[0].duration = 1
  state.animations[0].events = [{ id: 'source-event', time: 0, name: 'copy', target: '模板标题', nodeId: 'n2', params: 'ok' }]
  studio.setLook2(state, studio.get().version)
  const duplicate = studio.patch({ op: 'duplicate', id: 'n2', expectedRevision: studio.get().version })
  const events = duplicate.look2.animations[0].events
  const copiedEvent = events.find(event => event.nodeId === duplicate.selectedId)
  assert.ok(copiedEvent)
  assert.equal(copiedEvent.target, '模板标题_副本')
  assert.equal(events.find(event => event.nodeId === 'n2').target, '模板标题')

  const exported = studio.exportData('animation-lua', 'n1')
  const playerSource = Buffer.from(exported.data, 'base64').toString('utf8')
  const runtime = createRuntime()
  const root = runtime.addRoot({ name: 'Lua实例化面板', kind: 'container', active: true, children: [
    { name: '模板标题', kind: 'textbox', active: true },
    { name: '模板标题_副本', kind: 'textbox', active: true },
  ] })
  runtime.mountScript({ path: exported.filename, control: root,
    source: `${playerSource}\nfunction Look2OnEvent(event, control) print("event-target:" .. event.target) end` })
  const logs = runtime.logs.map(row => row.text).join('\n')
  assert.match(logs, /event-target:模板标题(?:\r?\n|$)/)
  assert.match(logs, /event-target:模板标题_副本(?:\r?\n|$)/)
})

test('new client asset clears stale node animation state but preserves shared resources and templates', () => {
  const studio = open(), state = studio.get().look2
  state.siteNodes.n2 = { id: 'n2', type: 'textbox', properties: {} }
  state.animations[0].keyframeTracks = [{ id: 'stale-track', nodeId: 'n2', fieldKey: 'fontSize', keyframes: [] }]
  state.animations[0].events = [{ id: 'stale-event', time: 0, name: 'stale', nodeId: 'n2', target: '模板标题', params: '' }]
  state.primitiveResources.push({ id: 'kept-resource', name: 'Keep', imageUrl: 'data:image/png;base64,AAAA' })
  state.controlTemplates.push({ id: 'kept-template', name: 'Imported', index: 12 })
  studio.setLook2(state, studio.get().version)
  const result = studio.patch({ op: 'newAsset', assetType: 'client-control-template', expectedRevision: studio.get().version })
  assert.equal(result.look2.siteNodes.n2, undefined)
  assert.deepEqual(result.look2.animations[0].keyframeTracks, [])
  assert.deepEqual(result.look2.animations[0].events, [])
  assert.equal(result.look2.primitiveResources[0].id, 'kept-resource')
  assert.equal(result.look2.controlTemplates[0].id, 'kept-template')
})

test('duplicating an event handler target remaps its control and copied script as one undoable edit', () => {
  const studio = open()
  studio.patch({ op: 'addScript', controlId: 'n2', controlAsset: 'client-control-template', path: 'events/handler.lua',
    source: 'function OnEvent(payload) print("handler-copy", script.object.name, payload.target) end' })
  const state = studio.get().look2
  state.animations[0].events = [{ id: 'bound', name: 'bound', time: .1, nodeId: 'n2', target: '模板标题', params: '',
    handler: { targetNodeId: 'n2', scriptPath: 'events/handler.lua', functionName: 'OnEvent' } }]
  studio.setLook2(state, studio.get().version)
  const before = studio.archiveData()
  const duplicate = studio.patch({ op: 'duplicate', id: 'n2', expectedRevision: studio.get().version })
  const events = duplicate.look2.animations[0].events
  assert.equal(events[0].handler.targetNodeId, 'n2')
  assert.deepEqual(events[1].handler, { targetNodeId: duplicate.selectedId, scriptPath: '副本-events/handler.lua', functionName: 'OnEvent' })
  studio.playStart({ asset: 'client' })
  const logs = studio.playStep(.1).logs.map(row => row.text).join('\n')
  assert.match(logs, /handler-copy\t模板标题\t模板标题/)
  assert.match(logs, /handler-copy\t模板标题_副本\t模板标题_副本/)
  studio.playStop()
  studio.history({ action: 'undo', expectedRevision: studio.get().version })
  const restored = studio.archiveData()
  assert.deepEqual(restored.look2, before.look2)
  assert.deepEqual(restored.assets.scripts, before.assets.scripts)
})

test('template import/index/instantiate are undoable and invalid indices roll back', () => {
  const source = open(), target = open(), data = source.exportData('gia', 'client-control-template').data
  let result = target.template({ action: 'import', data, name: '按钮面板', index: 12, expectedRevision: target.get().version })
  const entry = result.look2.controlTemplates[0]
  assert.equal(entry.index, 12)
  assert.throws(() => target.template({ action: 'import', data, index: 12, expectedRevision: result.version }), /索引已存在/)
  result = target.template({ action: 'instantiate', id: entry.id, parentId: result.selectedId, expectedRevision: result.version })
  assert.equal(findNode(target.archiveData().assets.client.root, result.selectedId).name, '按钮面板')
  target.history({ action: 'undo', expectedRevision: result.version })
  assert.equal(target.get().look2.controlTemplates.length, 1)
  assert.ok(!findNode(target.archiveData().assets.client.root, result.selectedId))
})

test('imported control template index 12 is registered for Runtime InstantiateClientUIControl', () => {
  const source = open(), target = createStudio()
  const data = source.exportData('gia', 'client-control-template').data
  let result = target.template({ action: 'import', data, name: 'Runtime 12', index: 12, expectedRevision: target.get().version })
  result = target.patch({ op: 'addScript', id: 'n1', controlId: 'n1', controlAsset: 'server-control-template', path: 'instantiate-12',
    source: 'function OnStart() local child = game.InstantiateClientUIControl(12, script.object); print("runtime-index-12", child ~= nil, child and child.prefabIndex) end',
    expectedRevision: result.version })
  const play = target.playStart({ inspect: true })
  assert.match(play.logs.map(row => row.text).join('\n'), /runtime-index-12\ttrue\t12/)
  assert.ok(play.tree[0].children.some(child => child.instantiated && child.prefabId === 12))
  target.playStop()
})

test('template references report missing indices and imported templates with scripts survive save/reopen and repeated reuse', () => {
  const source = open(), target = open(), parentId = target.get().selectedId
  source.patch({ op: 'addScript', path: '模板逻辑', source: 'function OnStart() print("template-script") end', controlId: source.get().selectedId, controlAsset: 'client-control-template' })
  target.patch({ op: 'add', kind: 'reference', parentId })
  target.patch({ op: 'set', key: 'referencedPrefabId', value: '12' })
  assert.ok(target.get().look2Warnings.some(row => /模板索引 12/.test(row)))
  const imported = target.template({ action: 'import', data: source.exportData('gia', 'client-control-template').data, index: 12, name: '可复用模板', expectedRevision: target.get().version })
  assert.deepEqual(imported.look2Warnings, [])
  const entry = imported.look2.controlTemplates[0]
  assert.ok(entry.scripts.some(row => /template-script/.test(row.source)))
  const reopened = createStudio(JSON.parse(Buffer.from(target.exportData('save').data, 'base64').toString('utf8')))
  assert.deepEqual(reopened.get().look2.controlTemplates, imported.look2.controlTemplates)
  assert.deepEqual(reopened.get().look2Warnings, [])
  for (let index = 0; index < 2; index++) reopened.template({ action: 'instantiate', id: entry.id, parentId, expectedRevision: reopened.get().version })
  const names = findNode(reopened.archiveData().assets.client.root, parentId).children.map(node => node.name)
  assert.ok(names.includes('可复用模板')); assert.ok(names.includes('可复用模板（2）'))
  reopened.template({ action: 'remove', id: entry.id, expectedRevision: reopened.get().version })
  assert.ok(reopened.get().look2Warnings.some(row => /模板索引 12/.test(row)))
})
