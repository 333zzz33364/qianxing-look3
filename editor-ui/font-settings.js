import { FONT_ROUTE } from '../studio/fonts.js'

const endpoint = `${FONT_ROUTE}/settings`

async function request(config) {
  const response = await fetch(endpoint, {
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    ...(config ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) } : {}),
  })
  if (response.status === 404) throw new Error('当前宿主尚未加载字体设置功能，请重启 Web 或 DSH 后重试。')
  if (!response.ok) throw new Error(await response.text() || '无法读取字体设置')
  return response.json()
}

export function createFontSettings(React) {
  const h = React.createElement
  return function FontSettings({ onClose }) {
    const [settings, setSettings] = React.useState(null)
    const [mode, setMode] = React.useState('auto')
    const [path, setPath] = React.useState('')
    const [scope, setScope] = React.useState('all')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [notice, setNotice] = React.useState('')
    const [attempt, setAttempt] = React.useState(0)
    React.useEffect(() => {
      let active = true
      setError('')
      request().then(value => {
        if (!active) return
        setSettings(value)
        setMode(value.mode)
        setScope(value.scope || 'all')
        setPath(value.environmentPath || value.path || value.active.path || value.defaultPaths[0] || '')
      }, reason => { if (active) setError(reason.message) })
      return () => { active = false }
    }, [attempt])

    const locked = Boolean(settings?.environmentPath)
    async function save(event) {
      event.preventDefault()
      setBusy(true); setError(''); setNotice('')
      try {
        const value = await request(locked ? { scope } : { mode, path, scope })
        setSettings(value)
        const detected = !locked && mode === 'auto'
          ? value.nextFont.path ? `找到字体：${value.nextFont.path}。` : '默认位置未找到字体，将使用系统字体。'
          : ''
        setNotice(`已保存。${detected}重启 Web、MCP 或 DSH 宿主，并刷新编辑器及试玩页后生效。`)
      } catch (reason) { setError(reason.message) }
      finally { setBusy(false) }
    }

    return h('div', {
      className: 'look2-modal-backdrop',
      onClick: () => { if (!busy) onClose() },
      onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose() } },
    }, h('div', {
      className: 'look2-modal lua-import look2-font-modal', role: 'dialog', 'aria-modal': true,
      'aria-label': '字体设置', onClick: event => event.stopPropagation(),
    },
    h('header', null, h('strong', null, '字体设置'), h('span', { className: 'spacer' }),
      h('button', { type: 'button', disabled: busy, onClick: onClose }, '关闭')),
    h('form', { className: 'look2-font-settings-form', onSubmit: save },
      h('p', null, '字体设置保存在本机，不会写入工程存档或分发包。保存后需重启宿主并刷新页面。'),
      settings ? h(React.Fragment, null,
        h('p', { style: { overflowWrap: 'anywhere' } }, `当前字体：${settings.active.path || '系统字体'}`),
        locked ? h('p', { role: 'status' }, '字体文件由环境变量 QXQY_FONT_PATH 指定；此处仍可调整应用范围。') : null,
        settings.error ? h('p', { role: 'alert' }, settings.error) : null,
        h('label', { className: 'look2-field wide' }, h('span', null, '字体来源'),
          h('select', { autoFocus: true, 'aria-label': '字体来源', value: mode, disabled: busy || locked,
            onChange: event => { setMode(event.target.value); setNotice('') } },
          h('option', { value: 'auto' }, '自动查找游戏默认字体'),
          h('option', { value: 'custom' }, '指定本机字体文件'),
          h('option', { value: 'system' }, '使用系统字体'))),
        mode === 'custom' || locked ? h('label', { className: 'look2-field wide' }, h('span', null, '字体文件路径'),
          h('input', { type: 'text', 'aria-label': '字体文件路径', value: path, required: mode === 'custom', disabled: busy || locked,
            spellCheck: false, placeholder: settings.defaultPaths[0] || 'C:\\path\\to\\font.ttf',
            onChange: event => { setPath(event.target.value); setNotice('') } }),
          h('small', null, '填写 TTF / OTF 绝对路径，最大 32 MiB；可粘贴带引号的 Windows 路径。')) : null,
        mode === 'auto' && !locked ? h('div', null,
          h('p', null, '按顺序尝试下列位置；均未找到时使用系统字体。安装在其他目录时请选择“指定本机字体文件”。'),
          settings.defaultPaths.length ? h('ul', { style: { paddingLeft: 20, overflowWrap: 'anywhere' } },
            settings.defaultPaths.map(value => h('li', { key: value }, value))) : h('p', null, '当前系统不自动查找，请指定字体文件。')) : null,
        h('label', { className: 'look2-field wide' }, h('span', null, '应用范围'),
          h('select', { 'aria-label': '应用范围', value: scope, disabled: busy,
            onChange: event => { setScope(event.target.value); setNotice('') } },
          h('option', { value: 'game' }, '仅游戏内文本'), h('option', { value: 'all' }, '整体 UI')),
          h('small', null, '仅游戏内文本用于画布、试玩和截图；整体 UI 还会替换千星look3工具界面字体。')),
        settings.restartRequired && !notice ? h('p', { role: 'status' }, '已有设置需要应用；请重启宿主并刷新页面。') : null,
      ) : !error ? h('p', null, '正在读取设置…') : null,
      error ? h('p', { role: 'alert' }, error) : null,
      error && !settings ? h('button', { type: 'button', disabled: busy, onClick: () => setAttempt(value => value + 1) }, '重试') : null,
      notice ? h('p', { role: 'status', style: { overflowWrap: 'anywhere' } }, notice) : null,
      h('footer', null,
        h('button', { type: 'button', disabled: busy, onClick: onClose }, '关闭'),
        h('button', { type: 'submit', className: 'primary', disabled: busy || !settings }, busy ? '保存中…' : '保存设置')))))
  }
}
