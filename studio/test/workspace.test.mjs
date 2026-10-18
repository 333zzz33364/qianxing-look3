import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { deleteWorkspaceArchive, listWorkspaceArchives } from '../host/workspace.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject } from '../ui/authoring.js'

test('workspace lists valid save archives larger than 8 MiB from their bounded header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'look2-workspace-'))
  const filePath = join(root, 'large-save.json')
  const lateMarkerPath = join(root, 'late-marker.json')
  const padding = 'x'.repeat(8 * 1024 * 1024)
  const archive = JSON.stringify({
    format: 'qxqy-simulator-save',
    name: 'Large save',
    padding,
  })
  const lateMarkerArchive = JSON.stringify({
    padding,
    format: 'qxqy-simulator-save',
    name: 'Late marker save',
  })

  try {
    await writeFile(filePath, archive)
    await writeFile(lateMarkerPath, lateMarkerArchive)
    const result = listWorkspaceArchives(root)

    const [listed] = result.archives
    assert.ok(Buffer.byteLength(archive) > 8 * 1024 * 1024)
    assert.ok(Buffer.byteLength(lateMarkerArchive) > 8 * 1024 * 1024)
    assert.equal(result.archives.length, 1)
    assert.equal(listed.path, 'large-save.json')
    assert.equal(listed.name, 'Large save')
    assert.equal(listed.bytes, Buffer.byteLength(archive))
    assert.equal(typeof listed.mtime, 'number')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Studio saves expose the project title before large animation resources in workspace listings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'look2-workspace-title-'))
  const studio = createStudio(createDefaultClientTemplateProject())
  const title = '大图片工程 "正式标题"'
  studio.patch({ op: 'renameSave', name: title })
  const state = studio.get().look2
  state.siteExtras = { ...state.siteExtras, padding: 'x'.repeat(8192) }
  studio.setLook2(state, studio.get().version)
  const serialized = JSON.stringify(studio.archiveData(), null, 2)
  try {
    await writeFile(join(root, 'large-metadata.save.json'), serialized)
    assert.ok(Buffer.byteLength(serialized) > 4096)
    assert.equal(listWorkspaceArchives(root).archives[0]?.name, title)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace title skips nested names and reads escaped meta.name from the bounded header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'look2-workspace-'))
  const filePath = join(root, 'metadata-title.json')
  const title = '工程 "正式标题" \\ 版本'

  try {
    await writeFile(filePath, JSON.stringify({
      format: 'qxqy-simulator-save',
      look2: { animations: [{ name: '动画名' }], siteNodes: { node: { name: '控件名' } } },
      meta: { name: title },
    }))

    const result = listWorkspaceArchives(root)
    assert.equal(result.archives.length, 1)
    assert.equal(result.archives[0].name, title)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace prefers a top-level escaped title and falls back when the header cuts off a title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'look2-workspace-'))
  const topLevelPath = join(root, 'top-level-title.json')
  const partialPath = join(root, 'partial-title.json')
  const title = '顶层 "工程标题" \\ 草稿'

  try {
    await writeFile(topLevelPath, JSON.stringify({
      format: 'qxqy-simulator-save',
      look2: { animations: [{ name: '动画名' }] },
      meta: { name: '元数据标题' },
      name: title,
    }))
    await writeFile(partialPath, '{"format":"qxqy-simulator-save","look2":{"animations":[{"name":"动画名"}]},"meta":{"name":"未完成')

    const result = listWorkspaceArchives(root)
    const topLevel = result.archives.find(row => row.path === 'top-level-title.json')
    const partial = result.archives.find(row => row.path === 'partial-title.json')
    assert.equal(topLevel?.name, title)
    assert.equal(partial?.name, 'partial-title')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace listings keep root saves even when a nested folder is full of saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'look2-workspace-crowd-'))
  const nested = join(root, 'acceptance-test')
  try {
    await mkdir(nested, { recursive: true })
    const body = JSON.stringify({ format: 'qxqy-simulator-save', name: '嵌套存档' })
    for (let index = 0; index < 60; index += 1) await writeFile(join(nested, `nested-${index}.save.json`), body)
    await writeFile(join(root, 'mine.save.json'), JSON.stringify({ format: 'qxqy-simulator-save', name: '我的存档' }))

    const paths = listWorkspaceArchives(root).archives.map(row => row.path)
    assert.ok(paths.includes('mine.save.json'), 'the root save is always listed')
    assert.equal(paths.filter(path => path.startsWith('acceptance-test/')).length, 60, 'nested saves exceed the old 50 cap')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deleteWorkspaceArchive removes a listed save and rejects paths outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'look2-workspace-delete-'))
  const filePath = join(root, 'doomed.save.json')
  try {
    await writeFile(filePath, JSON.stringify({ format: 'qxqy-simulator-save', name: '临时存档' }))
    assert.equal(listWorkspaceArchives(root).archives.length, 1)

    assert.deepEqual(deleteWorkspaceArchive(root, 'doomed.save.json'), { path: 'doomed.save.json' })
    assert.equal(existsSync(filePath), false)
    assert.equal(listWorkspaceArchives(root).archives.length, 0)

    assert.throws(() => deleteWorkspaceArchive(root, '../outside.save.json'), /path must stay inside the configured workspace/)
    assert.throws(() => deleteWorkspaceArchive(root, '/absolute.save.json'), /non-empty workspace-relative path/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
