import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SimulatorController } from '../host/controller.js'

function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'look3-archive-manage-'))
  const controller = new SimulatorController(workspace)
  t.after(async () => { await controller.dispose(); rmSync(workspace, { recursive: true, force: true }) })
  const manage = body => controller.manageArchive({ ...body, expectedRevision: controller.get().version })
  return { workspace, controller, manage }
}

test('managed workspaces create without a document, rename bound paths and preserve unsaved edits', async t => {
  const { workspace, controller, manage } = fixture(t)
  const initial = controller.studio.archiveData()
  assert.deepEqual(controller.listArchives().workspaces, [{ name: '默认工作区', path: '' }])
  const created = manage({ operation: 'create-workspace', name: '动画甲' })
  assert.equal(created.path, '工作区/动画甲')
  assert.deepEqual(created.archives, [])
  assert.deepEqual(controller.studio.archiveData(), initial)
  controller.saveArchive('工作区/动画甲/原名.save.json')
  const bytes = readFileSync(join(workspace, controller.archivePath))
  controller.patch({ op: 'renameSave', name: '尚未保存的修改' })
  const state = controller.studio.archiveData(), revision = controller.get().version
  const renamed = manage({ operation: 'rename-workspace', path: '工作区/动画甲', name: '动画乙' })
  assert.equal(renamed.snapshot.storage.path, '工作区/动画乙/原名.save.json')
  const document = manage({ operation: 'rename-archive', path: controller.archivePath, name: '新名' })
  assert.equal(document.path, '工作区/动画乙/新名.save.json')
  assert.deepEqual(readFileSync(join(workspace, document.path)), bytes, 'renames never save the in-memory draft')
  assert.deepEqual(controller.studio.archiveData(), state)
  assert.equal(controller.get().version, revision)
  assert.equal(existsSync(join(workspace, '工作区/动画甲')), false)
  assert.equal(existsSync(join(workspace, '工作区/动画乙/原名.save.json')), false)
  controller.saveForScriptSync(document.path, revision)
  assert.equal(JSON.parse(readFileSync(join(workspace, document.path), 'utf8')).meta.name, '尚未保存的修改')
})

test('invalid names, collisions, root/unmanaged moves and stale revisions have no document side effects', t => {
  const { workspace, controller, manage } = fixture(t)
  manage({ operation: 'create-workspace', name: '甲' })
  manage({ operation: 'create-workspace', name: '乙' })
  controller.saveArchive('工作区/甲/a.json')
  const original = readFileSync(join(workspace, '工作区/甲/a.json'))
  for (const name of ['', '..', '../外部', 'CON', 'nul.txt', '名称.', 'a\nb', 'a/b']) assert.throws(() => manage({ operation: 'create-workspace', name }))
  assert.throws(() => manage({ operation: 'create-workspace', name: '甲' }), /EEXIST/)
  assert.throws(() => manage({ operation: 'rename-workspace', path: '工作区/甲', name: '乙' }), /已存在/)
  assert.throws(() => manage({ operation: 'rename-workspace', path: '', name: '新根' }), /默认工作区/)
  mkdirSync(join(workspace, '工作区/无标记'))
  assert.throws(() => manage({ operation: 'rename-workspace', path: '工作区/无标记', name: '误收养' }), /不是受管/)
  writeFileSync(join(workspace, '工作区/甲/冲突.json'), 'protected')
  assert.throws(() => manage({ operation: 'rename-archive', path: '工作区/甲/a.json', name: '冲突.json' }), /EEXIST/)
  assert.throws(() => manage({ operation: 'rename-archive', path: '工作区/甲/冲突.json', name: 'other.json' }))
  assert.throws(() => controller.manageArchive({ operation: 'rename-archive', path: '工作区/甲/a.json', name: 'other', expectedRevision: -1 }), /revision conflict/)
  assert.deepEqual(readFileSync(join(workspace, '工作区/甲/a.json')), original)
  assert.equal(readFileSync(join(workspace, '工作区/甲/冲突.json'), 'utf8'), 'protected')
  assert.equal(controller.archivePath, '工作区/甲/a.json')
})

test('management refuses link escapes and externally edited bound archives', t => {
  const { workspace, controller, manage } = fixture(t)
  controller.saveArchive('a.json')
  writeFileSync(join(workspace, 'a.json'), JSON.stringify({ format: 'qxqy-simulator-save', meta: { name: '外部修改' } }))
  assert.throws(() => manage({ operation: 'rename-archive', path: 'a.json', name: 'b' }), /已变化/)
  assert.equal(existsSync(join(workspace, 'b.save.json')), false)
  const outside = mkdtempSync(join(tmpdir(), 'look3-archive-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(outside, join(workspace, '工作区'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => manage({ operation: 'create-workspace', name: '不得写出' }), /workspace|符号链接/)
  assert.equal(existsSync(join(outside, '不得写出')), false)
})
