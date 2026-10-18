import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceFile = 'docs/上游/来源.json'
const protectedPaths = ['.git', '上游', 'look2-workspace', 'look3-workspace', 'release', 'node_modules']

function git(root, args) {
  return execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.excludesFile=', '-c', 'core.quotePath=false', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

export function inside(root, path) {
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径必须位于千星look3目录内')
  return full
}

export function checkUpstreams({ root = projectRoot, offline = false } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(root, sourceFile), 'utf8'))
  const features = JSON.parse(readFileSync(resolve(root, 'docs/上游/功能清单.json'), 'utf8')).features
  return {
    checkedAt: new Date().toISOString(), modifiesProjectSource: false,
    sources: manifest.sources.map(source => {
      try {
        const referenceRoot = inside(root, source.directory)
        let target = source.commit
        if (!offline) {
          // Fetch objects only; leave the fixed reference checkout and source untouched.
          git(referenceRoot, ['-c', 'http.sslBackend=openssl', 'fetch', '--no-tags', 'origin', source.branch])
          target = git(referenceRoot, ['rev-parse', 'FETCH_HEAD'])
        }
        const changedFiles = git(referenceRoot, ['diff', '--name-only', source.commit, target, '--', ...source.paths]).split('\n').filter(Boolean)
        return {
          id: source.id, referenceCommit: source.commit, acceptedCommit: source.acceptedCommit,
          targetCommit: target, hasUpdates: source.commit !== target, changedFiles,
          affectedFeatures: features.filter(feature => feature.source === source.id && changedFiles.some(path => feature.upstreamPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))).map(feature => feature.id),
          status: 'checked',
        }
      } catch (error) {
        return { id: source.id, status: 'unavailable', error: String(error.message).slice(0, 1500) }
      }
    }),
  }
}

export function applyReviewedPatch(patch, { root = projectRoot } = {}) {
  const file = inside(root, patch)
  if (!existsSync(file)) throw new Error('适配补丁不存在')
  const entries = git(root, ['apply', '--numstat', file]).split('\n').filter(Boolean)
  if (!entries.length) throw new Error('补丁没有文件变更')
  for (const entry of entries) {
    const path = entry.split('\t').slice(2).join('\t').replaceAll('\\', '/')
    if (path.includes(' => ') || path.startsWith('"')) throw new Error('重命名或转义路径请人工核对后应用')
    inside(root, path)
    if (protectedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) throw new Error(`补丁不能修改受保护目录：${path}`)
    if (path.startsWith('docs/上游/')) throw new Error('合入补丁不能修改来源与验收状态')
  }
  // git apply is atomic without --reject; a failing preflight leaves all files intact.
  git(root, ['apply', '--check', file])
  git(root, ['apply', file])
  return { applied: true, files: entries.length, acceptedBaselineChanged: false, next: '运行局部及完整回归、构建和包检查，再记录逐项验收证据。' }
}

export function status(root = projectRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, sourceFile), 'utf8'))
  const catalog = JSON.parse(readFileSync(resolve(root, 'docs/上游/功能清单.json'), 'utf8'))
  return { sources: manifest.sources, counts: catalog.features.reduce((out, feature) => ({ ...out, [feature.status]: (out[feature.status] || 0) + 1 }), {}), features: catalog.features }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = 'status', ...args] = process.argv.slice(2)
    let result
    if (command === 'status') result = status()
    else if (command === 'check') result = checkUpstreams({ offline: args.includes('--offline') })
    else if (command === 'apply') {
      const index = args.indexOf('--patch')
      if (index < 0 || !args[index + 1]) throw new Error('用法：upstream-sync.mjs apply --patch <项目内已审阅的适配补丁>')
      result = applyReviewedPatch(args[index + 1])
    } else throw new Error('支持命令：status、check [--offline] [--output 路径]、apply --patch 路径')
    const outputIndex = args.indexOf('--output')
    const json = JSON.stringify(result, null, 2) + '\n'
    if (outputIndex >= 0) {
      const output = inside(projectRoot, args[outputIndex + 1] || '')
      if (!relative(projectRoot, output).replaceAll('\\', '/').startsWith('look3-workspace/')) throw new Error('报告只能写入look3-workspace，避免覆盖源码与来源记录')
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, json)
    } else process.stdout.write(json)
    if (result.sources?.some(source => source.status === 'unavailable')) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
