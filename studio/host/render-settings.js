import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MASK_CONTOUR_MODES = ['geometry', 'contour']

// geometry: descendants are clipped by the control rectangle and its fill/soft
// edge only, which is what device evidence shows. contour additionally follows
// the image texture alpha, which the author preview used to do on its own.
export function normalizeRenderSettings(value) {
  const mode = value?.maskContour
  if (mode !== undefined && !MASK_CONTOUR_MODES.includes(mode)) throw new Error('请选择遮罩覆盖规则：几何矩形或透明轮廓')
  return { maskContour: mode || 'geometry' }
}

export function renderSettingsPath(env = process.env, platform = process.platform, home = homedir()) {
  if (env.QXQY_RENDER_CONFIG_PATH) return env.QXQY_RENDER_CONFIG_PATH
  const base = platform === 'win32' ? (env.APPDATA || join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || join(home, '.config'))
  return join(base, '千星look3', 'render.json')
}

export function readRenderSettings(file = renderSettingsPath()) {
  if (!existsSync(file)) return { maskContour: 'geometry' }
  try { return normalizeRenderSettings(JSON.parse(readFileSync(file, 'utf8'))) }
  catch { throw new Error('本机渲染设置无法读取，请在渲染设置中重新保存') }
}

export function writeRenderSettings(value, file = renderSettingsPath()) {
  const settings = normalizeRenderSettings(value)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } catch (cause) { throw new Error('无法保存本机渲染设置，请检查配置目录的写入权限', { cause }) }
  finally { rmSync(temporary, { force: true }) }
  return settings
}

export function maskContourEnabled(settings) {
  return normalizeRenderSettings(settings).maskContour === 'contour'
}
