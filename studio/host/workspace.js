import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

// Shared filesystem boundary for local host adapters such as MCP and Web.

const SAVE_MARK = 'qxqy-simulator-save'
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dsh', 'coverage'])
const MAX_FILES = 500
const MAX_HEADER_BYTES = 4096
const MAX_DEPTH = 8

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

/** Read only a bounded prefix; listing must not load complete user archives. */
function fileHead(path) {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES)
  const fd = openSync(path, 'r')
  try {
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
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

function walk(dir, root, out, depth) {
  if (out.length >= MAX_FILES || depth > MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  // List this folder's own saves before descending, so a crowded nested folder
  // (acceptance/repair output) can never crowd the user's root saves out.
  const subdirectories = []
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      subdirectories.push(full)
      continue
    }
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue
    try {
      const stat = statSync(full)
      if (stat.size < 20) continue
      const head = fileHead(full)
      // If the save marker is outside the bounded prefix, skip it without reading the whole file.
      if (!head.includes(SAVE_MARK)) continue
      const name = archiveNameFromHead(head) || basename(entry.name, '.json')
      out.push({
        path: relative(root, full).replaceAll('\\', '/'),
        name,
        bytes: stat.size,
        mtime: stat.mtimeMs,
      })
    } catch {
      // Ignore unreadable files while listing a workspace.
    }
  }
  for (const subdirectory of subdirectories) {
    if (out.length >= MAX_FILES) return
    walk(subdirectory, root, out, depth + 1)
  }
}

export function listWorkspaceArchives(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  const archives = []
  walk(root, root, archives, 0)
  archives.sort((a, b) => b.mtime - a.mtime)
  return { bound: true, workspace: root, archives }
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
