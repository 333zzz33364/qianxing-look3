import { closeSync, existsSync, openSync, opendirSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

// Shared filesystem boundary for local host adapters such as MCP and Web.

const SAVE_MARK = 'qxqy-simulator-save'
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dsh', 'coverage'])
const MAX_FILES = 500
const HEAD_BYTES = 4096
// Scan budgets are env-overridable so large monorepo workspaces (thousands of
// decompiled-source dirs) can still surface their saves in the archive picker;
// defaults stay conservative. 2026-10-13: genshin-ts repo hit both limits and
// workspace/hmlt-qixia/hmlt-qixia.save.json never appeared in the GUI list.
const envInt = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}
// 调用时读取（非模块加载时定格）：进程中途变更/测试密闭性都友好
const scanLimits = () => ({
  entries: envInt('QXQY_SCAN_ENTRY_LIMIT', 10000),
  directories: envInt('QXQY_SCAN_DIR_LIMIT', 1000),
  depth: envInt('QXQY_SCAN_DEPTH_LIMIT', 8),
})

export function resolveWorkspaceRoot(value = '') {
  const candidate = resolve(String(value || process.cwd()))
  if (!existsSync(candidate)) throw new Error(`workspace does not exist: ${candidate}`)
  if (!statSync(candidate).isDirectory()) throw new Error(`workspace is not a directory: ${candidate}`)
  return realpathSync(candidate)
}

function relativePath(root, absolutePath, allowRoot = false) {
  const rel = relative(root, absolutePath)
  if ((!allowRoot && !rel) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path must stay inside the configured workspace')
  }
  return rel
}

/** Resolve an existing workspace file without allowing traversal or symlink escape. */
export function resolveWorkspaceFile(workspaceRoot, requestedPath) {
  const raw = String(requestedPath || '').trim()
  if (!raw || isAbsolute(raw)) throw new Error('path must be a non-empty workspace-relative path')
  const root = realpathSync(resolve(workspaceRoot))
  const lexical = resolve(root, raw)
  relativePath(root, lexical)
  if (!existsSync(lexical)) throw new Error(`file does not exist: ${raw}`)
  const actual = realpathSync(lexical)
  relativePath(root, actual)
  return actual
}

/** Resolve a workspace path for a new file, validating the nearest existing parent. */
export function resolveWorkspaceOutput(workspaceRoot, requestedPath) {
  const raw = String(requestedPath || '').trim()
  if (!raw || isAbsolute(raw)) throw new Error('path must be a non-empty workspace-relative path')
  const root = realpathSync(resolve(workspaceRoot))
  const target = resolve(root, raw)
  relativePath(root, target)
  let parent = dirname(target)
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) throw new Error('unable to resolve output directory')
    parent = next
  }
  relativePath(root, realpathSync(parent), true)
  if (existsSync(target)) relativePath(root, realpathSync(target))
  return target
}

function fileHead(path, size = HEAD_BYTES) {
  const buffer = Buffer.alloc(size)
  const fd = openSync(path, 'r')
  try {
    const bytes = readSync(fd, buffer, 0, size, 0)
    return buffer.subarray(0, bytes).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function skipJsonWhitespace(text, index) {
  while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1
  return index
}

function readJsonString(text, start) {
  if (text[start] !== '"') return null
  let escaped = false
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      try {
        return { value: JSON.parse(text.slice(start, index + 1)), end: index + 1 }
      } catch {
        return null
      }
    }
  }
  return null
}

function skipJsonValue(text, start) {
  const index = skipJsonWhitespace(text, start)
  const first = text[index]
  if (first === '"') return readJsonString(text, index)?.end ?? null
  if (first === '{' || first === '[') {
    const stack = [first === '{' ? '}' : ']']
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      const char = text[cursor]
      if (char === '"') {
        const token = readJsonString(text, cursor)
        if (!token) return null
        cursor = token.end - 1
      } else if (char === '{' || char === '[') {
        stack.push(char === '{' ? '}' : ']')
      } else if (char === '}' || char === ']') {
        if (stack.pop() !== char) return null
        if (!stack.length) return cursor + 1
      }
    }
    return null
  }

  let end = index
  while (end < text.length && !/[\t\n\r ,}\]]/.test(text[end])) end += 1
  if (end === index || end === text.length) return null
  try {
    JSON.parse(text.slice(index, end))
    return end
  } catch {
    return null
  }
}

function objectStringField(text, start, fieldName) {
  if (text[start] !== '{') return { end: null, value: null }
  let index = start + 1
  let value = null
  while (index < text.length) {
    index = skipJsonWhitespace(text, index)
    if (text[index] === '}') return { end: index + 1, value }
    const key = readJsonString(text, index)
    if (!key) return { end: null, value }
    index = skipJsonWhitespace(text, key.end)
    if (text[index] !== ':') return { end: null, value }
    index = skipJsonWhitespace(text, index + 1)

    if (key.value === fieldName) {
      if (text[index] === '"') {
        const token = readJsonString(text, index)
        if (!token) return { end: null, value }
        value = token.value
        index = token.end
      } else {
        value = null
        const end = skipJsonValue(text, index)
        if (end === null) return { end: null, value }
        index = end
      }
    } else {
      const end = skipJsonValue(text, index)
      if (end === null) return { end: null, value }
      index = end
    }

    index = skipJsonWhitespace(text, index)
    if (text[index] === ',') index += 1
    else if (text[index] === '}') return { end: index + 1, value }
    else return { end: null, value }
  }
  return { end: null, value }
}

function archiveNameFromHead(text) {
  let index = skipJsonWhitespace(text, 0)
  if (text[index] !== '{') return null
  index += 1
  let topName = null
  let metaName = null

  while (index < text.length) {
    index = skipJsonWhitespace(text, index)
    if (text[index] === '}') break
    const key = readJsonString(text, index)
    if (!key) break
    index = skipJsonWhitespace(text, key.end)
    if (text[index] !== ':') break
    index = skipJsonWhitespace(text, index + 1)

    if (key.value === 'name') {
      if (text[index] === '"') {
        const token = readJsonString(text, index)
        if (!token) break
        topName = token.value
        index = token.end
      } else {
        topName = null
        const end = skipJsonValue(text, index)
        if (end === null) break
        index = end
      }
    } else if (key.value === 'meta' && text[index] === '{') {
      const parsed = objectStringField(text, index, 'name')
      metaName = parsed.value
      if (parsed.end === null) break
      index = parsed.end
    } else {
      if (key.value === 'meta') metaName = null
      const end = skipJsonValue(text, index)
      if (end === null) break
      index = end
    }

    index = skipJsonWhitespace(text, index)
    if (text[index] === ',') index += 1
    else if (text[index] === '}') break
    else break
  }

  if (typeof topName === 'string' && topName.trim()) return topName
  if (typeof metaName === 'string' && metaName.trim()) return metaName
  return null
}

function walk(dir, root, out, depth, discovery) {
  const L = discovery.limits
  if (depth > L.depth) {
    discovery.depthLimitedDirectories += 1
    return
  }
  if (discovery.scannedDirectories >= L.directories) {
    discovery.directoryLimitReached = true
    return
  }
  let entries
  try {
    // Stream directory entries so a single large directory cannot bypass the
    // traversal budget by allocating an unbounded readdir array first.
    discovery.scannedDirectories += 1
    entries = opendirSync(dir)
  } catch {
    discovery.unreadableEntries += 1
    return
  }
  const subdirectories = []
  try {
    let entry
    while ((entry = entries.readSync())) {
      if (discovery.scannedEntries >= L.entries) {
        discovery.entryLimitReached = true
        return
      }
      discovery.scannedEntries += 1
      if (entry.name.startsWith('.') || (entry.isDirectory() && SKIP_DIRS.has(entry.name))) {
        discovery.skippedEntries += 1
        if (entry.isDirectory()) discovery.skippedDirectories += 1
        continue
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        subdirectories.push(full)
        continue
      }
      // Symlinks are deliberately not followed during discovery. Explicit file
      // opens still use resolveWorkspaceFile's workspace boundary validation.
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue
      discovery.scannedJsonFiles += 1
      try {
        const stat = statSync(full)
        const head = fileHead(full)
        if (!head.includes(SAVE_MARK)) continue
        const name = archiveNameFromHead(head) || basename(entry.name, '.json')
        out.push({
          path: relative(root, full).replaceAll('\\', '/'),
          name,
          bytes: stat.size,
          mtime: stat.mtimeMs,
        })
      } catch {
        discovery.unreadableEntries += 1
      }
    }
  } catch {
    discovery.unreadableEntries += 1
  } finally {
    try { entries.closeSync() } catch { discovery.unreadableEntries += 1 }
  }
  for (const child of subdirectories) {
    if (discovery.entryLimitReached || discovery.directoryLimitReached) break
    walk(child, root, out, depth + 1, discovery)
  }
}

export function listWorkspaceArchives(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  const archives = []
  const discovery = {
    truncated: false,
    warnings: [],
    scannedDirectories: 0,
    scannedEntries: 0,
    scannedJsonFiles: 0,
    matchedArchives: 0,
    skippedDirectories: 0,
    skippedEntries: 0,
    unreadableEntries: 0,
    depthLimitedDirectories: 0,
    entryLimitReached: false,
    directoryLimitReached: false,
    limits: { archives: MAX_FILES, headBytes: HEAD_BYTES, ...scanLimits() },
    policy: { excludedDirectories: [...SKIP_DIRS], hiddenEntries: false, symlinks: false, validatesJson: false },
  }
  walk(root, root, archives, 0, discovery)
  // Select the newest files only after scanning the bounded workspace, instead
  // of keeping whichever 50 files the filesystem happens to enumerate first.
  archives.sort((a, b) => Number(a.path.includes('/')) - Number(b.path.includes('/')) || b.mtime - a.mtime || a.path.localeCompare(b.path))
  discovery.matchedArchives = archives.length
  if (archives.length > MAX_FILES) discovery.warnings.push(`发现 ${archives.length} 个存档，仅显示修改时间最新的 ${MAX_FILES} 个；其他存档可通过指定路径打开。`)
  if (discovery.entryLimitReached || discovery.directoryLimitReached) discovery.warnings.push(`自动发现达到扫描上限（${discovery.limits.entries} 项 / ${discovery.limits.directories} 个目录），列表可能不完整；可通过指定路径打开存档。`)
  if (discovery.depthLimitedDirectories) discovery.warnings.push(`自动发现跳过 ${discovery.depthLimitedDirectories} 个超过 ${discovery.limits.depth} 层的目录；可通过指定路径打开其中的存档。`)
  if (discovery.skippedEntries) discovery.warnings.push('自动发现跳过隐藏项及生成目录（如 node_modules、dist）；可通过指定路径打开其中的存档。')
  if (discovery.unreadableEntries) discovery.warnings.push(`自动发现无法读取 ${discovery.unreadableEntries} 个文件或目录；请检查访问权限，或通过指定路径查看具体错误。`)
  discovery.truncated = archives.length > MAX_FILES || discovery.entryLimitReached || discovery.directoryLimitReached || discovery.depthLimitedDirectories > 0
  return { bound: true, workspace: root, archives: archives.slice(0, MAX_FILES), discovery }
}

/** Permanently delete one workspace archive; the path must stay inside the workspace. */
export function deleteWorkspaceArchive(workspaceRoot, requestedPath) {
  const absolute = resolveWorkspaceFile(workspaceRoot, requestedPath)
  unlinkSync(absolute)
  return { path: String(requestedPath).replaceAll('\\', '/') }
}

/** Reveal a workspace archive in the host file manager. Local hosts only. */
export function revealWorkspaceArchive(workspaceRoot, requestedPath) {
  const absolute = resolveWorkspaceFile(workspaceRoot, requestedPath)
  const target = String(requestedPath).replaceAll('\\', '/')
  const run = process.platform === 'win32'
    ? ['explorer.exe', [`/select,${absolute}`]]
    : process.platform === 'darwin'
      ? ['open', ['-R', absolute]]
      : ['xdg-open', [dirname(absolute)]]
  const child = spawn(run[0], run[1], { detached: true, stdio: 'ignore' })
  // A missing file manager must not crash the editor process.
  child.on('error', () => {})
  child.unref()
  return { path: target, revealed: true }
}
