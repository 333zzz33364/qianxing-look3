import { getLanguagePreference, getLocale, loadSystemLanguage, localizePage, setLanguagePreference, subscribeLocale, t } from '../studio/i18n.js'

export function createEditorFooter(React, { updatePath = '', languagePath = '' } = {}) {
  const h = React.createElement
  return function EditorFooter() {
    const [locale, setLocale] = React.useState(getLocale())
    const [status, setStatus] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    React.useEffect(() => {
      const unsubscribe = subscribeLocale(value => setLocale(value))
      void loadSystemLanguage({ url: languagePath }).then(() => localizePage())
      return unsubscribe
    }, [])
    React.useEffect(() => { localizePage() }, [locale, status])
    async function checkUpdates() {
      setBusy(true); setStatus(t('正在检查更新…'))
      try {
        const response = await fetch(updatePath, { cache: 'no-store' })
        const body = await response.json()
        if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`)
        const value = body.value || body
        setStatus(value.status === 'available' ? `${t('发现新版本')} ${value.latestVersion}`
          : value.status === 'current' ? t('当前已是最新版本') : t('暂时无法检查更新'))
      } catch (error) { setStatus(`${t('暂时无法检查更新')}：${error.message || error}`) }
      finally { setBusy(false) }
    }
    return h('footer', { className: 'qxsim-footer', 'data-i18n-root': true },
      h('span', { className: 'qxsim-footer-note' }, status || t('更新检查仅读取发布信息，不会自动安装。')),
      h('span', { className: 'spacer' }),
      h('label', { className: 'qxsim-footer-language' }, h('span', null, t('语言')), h('select', {
        value: locale, 'aria-label': t('语言'), onChange: event => setLanguagePreference(event.target.value),
      }, h('option', { value: 'zh-CN' }, t('中文')), h('option', { value: 'en-US' }, t('English')))),
      h('button', { className: 'qxsim-action', type: 'button', disabled: busy || !updatePath, onClick: checkUpdates }, t('检查更新')))
  }
}
