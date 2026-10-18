import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { importPrimitiveCss, importPrimitiveSvg, validateFitData } from '../../studio/look2/primitives.js'

const mcpDir = fileURLToPath(new URL('..', import.meta.url))
const entry = join(mcpDir, 'index.js')

function startServer(workspace) {
  const child = spawn(process.execPath, [entry, '--workspace', workspace], {
    cwd: mcpDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = ''
  const responses = new Map()
  const diagnostics = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => diagnostics.push(chunk))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      responses.get(message.id)?.resolve(message)
      responses.delete(message.id)
    }
  })
  let id = 0
  return {
    child,
    diagnostics,
    request(method, params = {}) {
      const requestId = ++id
      return new Promise((resolve, reject) => {
        responses.set(requestId, { resolve, reject })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
      })
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

async function stopServer(server) {
  server.child.kill()
  await once(server.child, 'exit')
}

test('MCP handshake exposes simulator tools and supports an edit/save round trip', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'qxqy-mcp-'))
  const server = startServer(workspace)
  try {
    const initialized = await server.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    assert.equal(initialized.result.protocolVersion, '2024-11-05')
    assert.equal(initialized.result.serverInfo.name, 'look3-mcp')
    assert.ok(initialized.result.capabilities.tools)
    server.notify('notifications/initialized')

    const listed = await server.request('tools/list')
    const names = listed.result.tools.map((tool) => tool.name)
    assert.deepEqual(names, [
      'look3_project_open', 'look3_project_save', 'look3_studio_get', 'look3_studio_patch',
      'look3_studio_transaction', 'look3_studio_history', 'look3_studio_template',
      'look3_animation_set', 'look3_animation_export',
      'look3_studio_play', 'look3_studio_ui_screenshot', 'look3_studio_play_screenshot', 'look3_studio_load',
    ])
    const playArgsSchema = listed.result.tools.find((tool) => tool.name === 'look3_studio_play').inputSchema.properties.args
    assert.deepEqual(playArgsSchema.properties.asset.enum, ['server', 'client'])
    assert.equal(playArgsSchema.properties.templateRootId.type, 'string')
    assert.equal(playArgsSchema.properties.animationId.type, 'string')
    assert.equal(playArgsSchema.properties.expectedRevision.type, 'integer')

    const archives = await server.request('tools/call', {
      name: 'look3_studio_load',
      arguments: {},
    })
    assert.deepEqual(archives.result.structuredContent.archives, [])

    const opened = await server.request('tools/call', { name: 'look3_project_open', arguments: {} })
    assert.equal(opened.result.isError, undefined)
    const handle = opened.result.structuredContent.handle

    const got = await server.request('tools/call', { name: 'look3_studio_get', arguments: { handle } })
    const revision = got.result.structuredContent.version
    const patched = await server.request('tools/call', {
      name: 'look3_studio_patch',
      arguments: { handle, op: { op: 'renameSave', name: 'MCP test', expectedRevision: revision } },
    })
    assert.equal(patched.result.structuredContent.save.name, 'MCP test')

    const saved = await server.request('tools/call', {
      name: 'look3_project_save',
      arguments: { handle, path: 'nested/test.save.json' },
    })
    assert.ok(saved.result.structuredContent, JSON.stringify(saved))
    assert.equal(saved.result.structuredContent.path, 'nested/test.save.json')
    const savedJson = JSON.parse(readFileSync(join(workspace, 'nested', 'test.save.json'), 'utf8'))
    assert.equal(savedJson.format, 'qxqy-simulator-save')
    assert.equal(savedJson.meta.name, 'MCP test')

    const screenshot = await server.request('tools/call', {
      name: 'look3_studio_ui_screenshot',
      arguments: { handle },
    })
    assert.equal(screenshot.result.content[1].type, 'image')
    assert.equal(screenshot.result.content[1].mimeType, 'image/png')
    assert.ok(screenshot.result.content[1].data.length > 100)

    const beforePlay = await server.request('tools/call', { name: 'look3_studio_get', arguments: { handle } })
    const started = await server.request('tools/call', {
      name: 'look3_studio_play',
      arguments: { handle, action: 'start', args: { asset: 'server', expectedRevision: beforePlay.result.structuredContent.version } },
    })
    assert.equal(started.result.structuredContent.running, true)
    assert.equal(started.result.structuredContent.playTarget.asset, 'server')
    const playScreenshot = await server.request('tools/call', {
      name: 'look3_studio_play_screenshot',
      arguments: { handle },
    })
    assert.equal(playScreenshot.result.content[1].type, 'image')
    const stopped = await server.request('tools/call', {
      name: 'look3_studio_play',
      arguments: { handle, action: 'stop', args: {} },
    })
    assert.equal(stopped.result.structuredContent.running, false)
  } finally {
    await stopServer(server)
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('MCP JSON-RPC executes look2 transactions, history, animation updates, and all primitive exports', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'qxqy-mcp-look2-'))
  const server = startServer(workspace)
  const tool = async (name, args = {}) => {
    const response = await server.request('tools/call', { name, arguments: args })
    return response.result
  }
  const value = (result) => {
    assert.notEqual(result?.isError, true, result?.content?.[0]?.text || 'MCP tool call failed')
    assert.ok(result?.structuredContent, 'MCP tool must return structured JSON content')
    return result.structuredContent
  }
  const findNode = (root, id) => {
    if (root?.id === id) return root
    for (const child of root?.children || []) {
      const found = findNode(child, id)
      if (found) return found
    }
    return null
  }
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'look2 integration', version: '1' } })
    server.notify('notifications/initialized')
    const opened = value(await tool('look3_project_open'))
    const handle = opened.handle
    let snapshot = value(await tool('look3_studio_get', { handle }))

    snapshot = value(await tool('look3_studio_transaction', {
      handle,
      label: 'select client template for integration export',
      expectedRevision: snapshot.version,
      ops: [{ op: 'selectAsset', assetType: 'client-control-template' }],
    }))
    const templateRoot = snapshot.root.children.find((node) => node.kind === 'container') || snapshot.root.children[0]
    const all = []
    const visit = (node) => { if (node) { all.push(node); for (const child of node.children || []) visit(child) } }
    visit(snapshot.root)
    const image = all.find((node) => node.kind === 'image')
    assert.ok(templateRoot?.id, 'client template root is available')
    assert.ok(image?.id, 'client template includes an image for primitive exports')

    const resourceId = 'mcp-fit-resource'
    const beforeLook2 = snapshot.look2
    const look2 = structuredClone(beforeLook2)
    look2.primitiveResources.push({
      id: resourceId,
      name: 'MCP embedded FitData',
      mimeType: 'image/png',
      imageUrl: 'data:image/png;base64,aGVsbG8=',
      previewMode: 'image',
      fitData: {
        version: 1,
        width: 16,
        height: 16,
        elements: [{ type: 'ellipse', imageId: 100002, x: 0, y: 0, width: 8, height: 6, rotation: 15, color: { r: 240, g: 30, b: 10, a: 1 } }],
      },
    })
    const previousSiteNode = look2.siteNodes[image.id] || { id: image.id, type: 'image', properties: {} }
    look2.siteNodes[image.id] = {
      ...previousSiteNode,
      id: image.id,
      type: 'primitive',
      properties: { ...(previousSiteNode.properties || {}), imageResourceId: resourceId, previewMode: 'image' },
    }
    const animation = look2.animations.find((row) => row.id === look2.activeAnimationId) || look2.animations[0]
    animation.keyframeTracks = [{
      id: 'mcp-track-x', nodeId: image.id, fieldKey: 'anchoredPositionX', interpolation: 'tween',
      keyframes: [
        { id: 'mcp-key-0', time: 0, value: 0, relative: false, easeType: 'Linear', interpolation: 'tween' },
        { id: 'mcp-key-1', time: 1, value: 12, relative: true, easeType: 'OutQuad', interpolation: 'tween' },
      ],
    }]

    const historyBefore = value(await tool('look3_studio_history', { handle, action: 'list' }))
    const committed = value(await tool('look3_studio_transaction', {
      handle,
      label: 'atomic primitive and animation setup',
      expectedRevision: snapshot.version,
      ops: [{ op: 'set', id: image.id, key: 'imageId', value: 100001 }],
      state: look2,
    }))
    assert.equal(committed.version, snapshot.version + 1)
    assert.equal(committed.look2.primitiveResources.length, beforeLook2.primitiveResources.length + 1)
    assert.equal(committed.look2.animations[0].keyframeTracks[0].nodeId, image.id)
    assert.equal(findNode(committed.root, image.id).imageId, 100001)
    assert.equal(committed.history.entries.length, historyBefore.history.entries.length + 1, 'a combined patch and look2 state write is one undo record')

    const alteredState = structuredClone(committed.look2)
    alteredState.primitiveResources[0].name = 'must roll back'
    const failedTransaction = await tool('look3_studio_transaction', {
      handle,
      label: 'failing atomic transaction',
      expectedRevision: committed.version,
      ops: [
        { op: 'set', id: image.id, key: 'imageId', value: 100003 },
        { op: 'set', id: 'missing-control', key: 'imageId', value: 100003 },
      ],
      state: alteredState,
    })
    assert.equal(failedTransaction.isError, true)
    const afterFailure = value(await tool('look3_studio_get', { handle }))
    assert.equal(afterFailure.version, committed.version)
    assert.deepEqual(afterFailure.look2, committed.look2)
    assert.equal(findNode(afterFailure.root, image.id).imageId, 100001)

    const conflict = await tool('look3_studio_transaction', {
      handle, expectedRevision: committed.version - 1,
      ops: [{ op: 'set', id: image.id, key: 'imageId', value: 100003 }],
    })
    assert.equal(conflict.isError, true)
    const afterConflict = value(await tool('look3_studio_get', { handle }))
    assert.equal(afterConflict.version, committed.version)
    assert.deepEqual(afterConflict.look2, committed.look2)

    const undone = value(await tool('look3_studio_history', { handle, action: 'undo', expectedRevision: committed.version }))
    assert.equal(undone.look2.primitiveResources.length, beforeLook2.primitiveResources.length)
    assert.equal(findNode(undone.root, image.id).imageId, image.imageId)
    assert.equal(undone.history.canRedo, true)
    const redone = value(await tool('look3_studio_history', { handle, action: 'redo', expectedRevision: undone.version }))
    assert.equal(redone.look2.primitiveResources.length, beforeLook2.primitiveResources.length + 1)
    assert.equal(findNode(redone.root, image.id).imageId, 100001)

    const editedAnimation = structuredClone(redone.look2)
    editedAnimation.animations[0].keyframeTracks[0].keyframes[1].value = 20
    const animationSet = value(await tool('look3_animation_set', {
      handle, expectedRevision: redone.version, state: editedAnimation,
    }))
    assert.equal(animationSet.look2.animations[0].keyframeTracks[0].keyframes[1].value, 20)
    const staleAnimation = await tool('look3_animation_set', {
      handle, expectedRevision: redone.version, state: redone.look2,
    })
    assert.equal(staleAnimation.isError, true)

    const beforeExports = value(await tool('look3_studio_get', { handle }))
    const exported = new Map()
    for (const format of ['timeline-lib', 'primitive-data', 'primitive-lib', 'primitive-svg', 'primitive-css']) {
      const rootId = format === 'primitive-data' ? templateRoot.id
        : format === 'primitive-svg' || format === 'primitive-css' ? image.id : undefined
      const result = value(await tool('look3_animation_export', { handle, format, ...(rootId ? { rootId } : {}) }))
      assert.equal(result.encoding, 'base64', format)
      assert.ok(result.data.length > 0, format)
      exported.set(format, Buffer.from(result.data, 'base64').toString('utf8'))
    }
    assert.match(exported.get('timeline-lib'), /TweenTimelineLib/)
    assert.match(exported.get('primitive-lib'), /PrimitiveImageLib/)
    assert.match(exported.get('primitive-data'), /groups\s*=\s*\{/)
    assert.match(exported.get('primitive-data'), /elements\s*=\s*\{/)
    const assertFitRoundTrip = (actual, expected) => {
      const parsed = validateFitData(actual)
      assert.equal(parsed.version, expected.version)
      assert.equal(parsed.width, expected.width)
      assert.equal(parsed.height, expected.height)
      assert.equal(parsed.elements.length, expected.elements.length)
      for (let index = 0; index < expected.elements.length; index += 1) {
        const before = expected.elements[index], after = parsed.elements[index]
        assert.equal(after.type, before.type)
        assert.equal(after.imageId, before.imageId)
        for (const key of ['x', 'y', 'width', 'height', 'rotation']) assert.ok(Math.abs(after[key] - before[key]) < 1e-6, `${key} round trip: ${after[key]} != ${before[key]}`)
        assert.deepEqual(after.color, before.color)
      }
    }
    const expectedFit = beforeExports.look2.primitiveResources.at(-1).fitData
    assertFitRoundTrip(importPrimitiveSvg(exported.get('primitive-svg')), expectedFit)
    assertFitRoundTrip(importPrimitiveCss(exported.get('primitive-css')), expectedFit)

    const afterExports = value(await tool('look3_studio_get', { handle }))
    assert.equal(afterExports.version, beforeExports.version, 'exports are read-only')
    assert.deepEqual(afterExports.look2, beforeExports.look2)
    assert.deepEqual(afterExports.root, beforeExports.root, 'GIA/primitive exports must not bake into the authoring project')
  } finally {
    await stopServer(server)
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('tool failures are returned as MCP isError results', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'qxqy-mcp-error-'))
  const server = startServer(workspace)
  try {
    const result = await server.request('tools/call', {
      name: 'look3_studio_get',
      arguments: { handle: 'missing' },
    })
    assert.equal(result.result.isError, true)
    assert.match(result.result.content[0].text, /unknown project handle/)
  } finally {
    await stopServer(server)
    rmSync(workspace, { recursive: true, force: true })
  }
})
