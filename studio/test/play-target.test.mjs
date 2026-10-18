import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStudio } from '../index.js'
import { SimulatorController } from '../host/controller.js'
import { compileProject } from '../play/compile.js'
import { startPlay } from '../play/session.js'
import { WebSession } from '../../web/lib/session.js'

const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

function clientSite(animations = []) {
  return {
    version: 12,
    name: '试玩目标测试',
    nodes: [
      { id: 'template-a', name: '模板甲', type: 'container', parentId: null, sizeDeltaX: 400, sizeDeltaY: 300 },
      { id: 'image-a', name: '图片甲', type: 'image', parentId: 'template-a', sizeDeltaX: 80, sizeDeltaY: 50, properties: { imageId: 100001 } },
      { id: 'template-b', name: '模板乙', type: 'container', parentId: null, sizeDeltaX: 400, sizeDeltaY: 300 },
      { id: 'image-b', name: '图片乙', type: 'image', parentId: 'template-b', sizeDeltaX: 80, sizeDeltaY: 50, properties: { imageId: 100002 } },
    ],
    animations,
    activeAnimationId: animations[0]?.id || '',
  }
}

const animation = (id, to) => ({
  id,
  name: id,
  duration: 2,
  keyframeTracks: [{ id: `${id}-track`, nodeId: 'image-b', fieldKey: 'anchoredPositionX', keyframes: [
    { time: 0, value: 0 }, { time: 1, value: to },
  ] }],
})

function importClient(studio, document) {
  studio.importData('json', encode(document), 'play-target.site.json')
  return studio
}

function find(rows, name) {
  for (const row of rows || []) {
    if (row.name === name) return row
    const child = find(row.children, name)
    if (child) return child
  }
  return null
}

test('compileProject resolves an explicit client template root and rejects unknown roots', () => {
  const studio = importClient(createStudio(), clientSite())
  const project = studio.archiveData().assets.client
  const compiled = compileProject(project, [], '', { templateRootId: 'template-b' })
  assert.equal(compiled.root.authoringId, 'template-b')
  assert.throws(() => compileProject(project, [], '', { templateRootId: 'missing' }), /client template root not found/)
})

test('play runtime registers valid template library index zero', () => {
  const archive = createStudio().archiveData()
  const client = archive.assets.client
  const template = { ...compileProject(client).templates[0], prefabIndex: 0 }
  const session = startPlay(archive.assets.server, { templatesProject: client, extraTemplates: [template] })
  try {
    const root = session.runtime.roots[0]
    session.runtime.mountScript({
      path: 'template-zero.lua',
      control: root,
      source: `
function OnStart()
  local created = game.InstantiateClientUIControl(0, script.object)
  print("template-zero", created and created.prefabIndex or "missing")
end
`,
    })
    const output = session.runtime.logs.map(row => row.text).join('\n')
    assert.match(output, /template-zero\t0/)
    const created = [...session.runtime.controlsById.values()].find(control => control.prefabIndex === 0)
    assert.ok(created)
    assert.equal(created.parent.Id, root.Id)
  } finally {
    for (const runtime of session.runtimes) runtime.destroy()
  }
})

test('play start selects the requested client template and animation, while old implicit routing remains intact', () => {
  const studio = importClient(createStudio(), clientSite([animation('first', 40), animation('second', 80)]))
  const before = studio.archiveData()
  const started = studio.playStart({ asset: 'client', templateRootId: 'template-b', animationId: 'second', inspect: true })
  assert.deepEqual(started.playTarget, { asset: 'client', templateRootId: 'template-b', animationId: 'second' })
  assert.equal(started.tree[0].authoringId, 'template-b')
  assert.equal(find(started.tree, '图片乙').anchoredPositionX, 0)
  assert.equal(find(studio.playStep(.5, { inspect: true }).tree, '图片乙').anchoredPositionX, 40)
  assert.deepEqual(studio.archiveData(), before, 'runtime playback leaves the editable archive untouched')
  studio.playStop()

  const empty = importClient(createStudio(), clientSite())
  const explicitClient = empty.playStart({ asset: 'client', templateRootId: 'template-b', inspect: true })
  assert.equal(explicitClient.playTarget.asset, 'client')
  assert.equal(explicitClient.tree[0].authoringId, 'template-b')
  empty.playStop()

  const implicit = importClient(createStudio(), clientSite())
  assert.equal(implicit.playStart({ inspect: true }).playTarget.asset, 'server')
  implicit.playStop()
})

test('explicit server target runs the full server interface even when the active editor asset is client', () => {
  const studio = importClient(createStudio(), clientSite([animation('server-start-animation', 40)]))
  const serverRootId = studio.archiveData().assets.server.root.children[0].id
  const snapshot = studio.playStart({ asset: 'server', animationId: 'server-start-animation', inspect: true })
  assert.equal(snapshot.playTarget.asset, 'server')
  assert.equal(snapshot.playTarget.animationId, 'server-start-animation')
  assert.equal(snapshot.tree[0].authoringId, serverRootId)
  studio.playStop()
})

test('WebSession forwards explicit play target and animation options through the shared worker', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'look2-web-play-'))
  const web = new WebSession({ workspace })
  try {
    await web.initialize()
    importClient(web.controller.studio, clientSite([animation('first', 40), animation('second', 80)]))
    const revision = web.controller.get().version
    const before = web.controller.studio.archiveData()
    const snapshot = await web.play('start', {
      asset: 'client', templateRootId: 'template-b', animationId: 'second', expectedRevision: revision, inspect: true,
    })
    assert.deepEqual(snapshot.playTarget, { asset: 'client', templateRootId: 'template-b', animationId: 'second' })
    assert.equal(snapshot.tree[0].authoringId, 'template-b')
    assert.deepEqual(web.controller.studio.archiveData(), before)
    await web.play('stop')
    assert.deepEqual(web.controller.studio.archiveData(), before)
  } finally {
    await web.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('Controller rejects stale starts without killing play, cleans failed starts, and serializes rapid start/stop', async () => {
  const controller = new SimulatorController()
  try {
    const original = controller.studio.archiveData()
    const revision = controller.get().version
    await controller.play('start', { asset: 'server', expectedRevision: revision })
    const oldWorker = controller.worker
    const changed = controller.patch({ op: 'setCanvas', canvasId: 'mobile-16-9', expectedRevision: revision })
    await assert.rejects(controller.play('start', { expectedRevision: revision }), /revision conflict/)
    assert.equal(controller.worker, oldWorker)
    assert.equal((await controller.play('get')).running, true)

    await assert.rejects(controller.play('start', { asset: 'bad-asset' }), /unknown play asset/)
    assert.equal(controller.worker, null, 'failed startup tears down its worker')
    await assert.rejects(controller.play('get'), /play session has not started/)

    const results = await Promise.all([
      controller.play('start', { asset: 'server', expectedRevision: changed.version }),
      controller.play('stop'),
      controller.play('start', { asset: 'client', templateRootId: 'n1', expectedRevision: changed.version }),
      controller.play('stop'),
    ])
    assert.equal(results[0].running, true)
    assert.equal(results[1].running, false)
    assert.equal(results[2].playTarget.asset, 'client')
    assert.equal(results[3].running, false)
    assert.equal(controller.worker, null)
    assert.notDeepEqual(controller.studio.archiveData(), original, 'the intentional canvas edit remains in the authoring project')
  } finally {
    await controller.dispose()
  }
})
