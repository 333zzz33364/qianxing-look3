import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { resolveWorkspaceFile, resolveWorkspaceOutput, resolveWorkspaceRoot } from './workspace.js'

const DIRECTORY = '工作区'
const MARKER = '.look3-workspace.json'
const FORMAT = 'look3-workspace'
const portable = value => String(value || '').trim().replaceAll('\\', '/')

function validName(value) {
  if (typeof value !== 'string') throw new Error('名称必须是文字')
  const name = value.trim()
  if (!name || name.length > 100 || name.startsWith('.') || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(name) || name.endsWith('.')
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) throw new Error('名称为空、过长或含无效字符')
  return name
}

function noLinks(root, path) {
  let current = root
  for (const segment of relative(root, resolve(root, path)).split(/[\\/]/)) {
    current = join(current, segment)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('工作区管理不支持符号链接')
  }
}

function managedWorkspace(root, requestedPath) {
  const path = portable(requestedPath)
  const parts = path.split('/')
  if (parts.length !== 2 || parts[0] !== DIRECTORY || validName(parts[1]) !== parts[1]) throw new Error('只能改名受管子工作区；默认工作区不可改名')
  noLinks(root, path)
  const absolute = resolveWorkspaceFile(root, path)
  if (!lstatSync(absolute).isDirectory()) throw new Error('工作区不是文件夹')
  const marker = join(absolute, MARKER)
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || JSON.parse(readFileSync(marker, 'utf8')).format !== FORMAT) throw new Error('该文件夹不是受管工作区')
  return { path, absolute, name: parts[1] }
}

export function listArchiveWorkspaces(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  const entries = [{ name: '默认工作区', path: '' }]
  const base = join(root, DIRECTORY)
  if (!existsSync(base) || lstatSync(base).isSymbolicLink() || !lstatSync(base).isDirectory()) return entries
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const managed = managedWorkspace(root, `${DIRECTORY}/${entry.name}`)
      entries.push({ name: managed.name, path: managed.path })
    } catch { /* Unrelated folders are never treated as editable workspaces. */ }
  }
  return [entries[0], ...entries.slice(1).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))]
}

export function createArchiveWorkspace(workspaceRoot, requestedName) {
  const root = resolveWorkspaceRoot(workspaceRoot), name = validName(requestedName)
  const path = `${DIRECTORY}/${name}`
  const absolute = resolveWorkspaceOutput(root, path)
  noLinks(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  // The leaf is exclusive: creating a workspace never adopts an existing folder.
  mkdirSync(absolute)
  try { writeFileSync(join(absolute, MARKER), JSON.stringify({ format: FORMAT, version: 1 }) + '\n', { flag: 'wx' }) }
  catch (error) { rmdirSync(absolute); throw error }
  return { operation: 'create-workspace', path, name }
}

export function renameArchiveWorkspace(workspaceRoot, requestedPath, requestedName) {
  const root = resolveWorkspaceRoot(workspaceRoot), name = validName(requestedName)
  const source = managedWorkspace(root, requestedPath)
  const path = `${DIRECTORY}/${name}`
  if (source.path === path) return { operation: 'rename-workspace', path, previousPath: source.path, name }
  const destination = resolveWorkspaceOutput(root, path)
  noLinks(root, path)
  if (existsSync(destination)) throw new Error('名称已存在，不能覆盖工作区')
  renameSync(source.absolute, destination)
  return { operation: 'rename-workspace', path, previousPath: source.path, name }
}

export function renameWorkspaceArchive(workspaceRoot, requestedPath, requestedName) {
  const root = resolveWorkspaceRoot(workspaceRoot)
  const name = validName(requestedName)
  const source = resolveWorkspaceFile(root, requestedPath)
  noLinks(root, portable(requestedPath))
  if (!lstatSync(source).isFile() || JSON.parse(readFileSync(source, 'utf8')).format !== 'qxqy-simulator-save') throw new Error('只能改名 Look 存档文件')
  const filename = /\.json$/i.test(name) ? name : `${name}.save.json`
  const previousPath = portable(relative(root, source))
  const path = portable(join(dirname(previousPath), filename))
  if (previousPath === path) return { operation: 'rename-archive', path, previousPath, name: filename }
  const destination = resolveWorkspaceOutput(root, path)
  noLinks(root, path)
  // A hard link claims the destination exclusively, even if another tab creates
  // that filename between validation and mutation. Contents are never rewritten.
  linkSync(source, destination)
  try { unlinkSync(source) }
  catch (error) { unlinkSync(destination); throw error }
  return { operation: 'rename-archive', path, previousPath, name: basename(destination) }
}

export function remapArchivePath(path, result) {
  const value = portable(path), previous = portable(result.previousPath)
  const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!previous) return value
  if (equal(value, previous)) return result.path
  if (result.operation === 'rename-workspace' && equal(value.slice(0, previous.length + 1), previous + '/')) return result.path + value.slice(previous.length)
  return value
}
