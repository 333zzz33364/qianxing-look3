// 界面动效素材库：从官方 OSS 目录里按作用域、分类、标签和关键字挑素材。
// 目录只加载一次，失败时给出重试入口，不影响编辑器其它功能。
import { uiVfxCatalog } from '../studio/play/ui-vfx-catalog.js'

export function createUIVfxLibrary(React) {
  const e = React.createElement
  const overlay = {
    position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)', padding: 16,
  }
  const panel = {
    width: 'min(720px, 100%)', maxHeight: 'min(560px, 100%)', display: 'flex', flexDirection: 'column',
    gap: 10, padding: 14, borderRadius: 10, border: '1px solid #454b58', background: '#1f232b', color: '#e2e7f1',
  }
  const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
  const chip = (active) => ({
    padding: '3px 9px', borderRadius: 999, border: `1px solid ${active ? '#7f9cf5' : '#454b58'}`,
    background: active ? '#2f3a52' : 'transparent', color: active ? '#dbe4ff' : '#a7b2c8',
    fontSize: 12, cursor: 'pointer',
  })
  const grid = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 8,
    overflowY: 'auto', flex: 1, minHeight: 120, paddingRight: 4,
  }
  const card = (active) => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 8,
    borderRadius: 8, border: `1px solid ${active ? '#7f9cf5' : '#3a4049'}`,
    background: active ? '#2f3a52' : '#262b34', color: 'inherit', cursor: 'pointer', textAlign: 'center',
  })

  return function UIVfxLibrary({ scope = 'ui', selectedId = null, onSelect, onClose }) {
    const [status, setStatus] = React.useState('loading')
    const [error, setError] = React.useState('')
    const [category, setCategory] = React.useState(0)
    const [tag, setTag] = React.useState(0)
    const [query, setQuery] = React.useState('')

    const load = React.useCallback(() => {
      setStatus('loading')
      setError('')
      uiVfxCatalog.load(true)
        .then(() => setStatus('ready'))
        .catch((cause) => {
          setStatus('error')
          setError(String(cause?.message || cause))
        })
    }, [])

    React.useEffect(() => { load() }, [load])

    React.useEffect(() => {
      const onKey = (event) => { if (event.key === 'Escape') onClose?.() }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const assets = status === 'ready' ? uiVfxCatalog.assets.filter((asset) => asset.scope === scope) : []
    const categories = status === 'ready' ? uiVfxCatalog.categories.filter((item) => item.scope === scope) : []
    const keyword = query.trim().toLowerCase()
    const visible = assets.filter((asset) => {
      if (category && asset.category !== category) return false
      if (tag && !asset.tagList.includes(tag)) return false
      if (!keyword) return true
      return uiVfxCatalog.label(asset).toLowerCase().includes(keyword) || String(asset.id).includes(keyword)
    })

    const header = e('div', { style: { ...row, justifyContent: 'space-between' } },
      e('strong', null, scope === 'screen' ? '选择全屏动效' : '选择界面动效'),
      e('button', { type: 'button', className: 'qxsim-action', onClick: () => onClose?.() }, '关闭'))

    const filters = status === 'ready' ? e('div', { style: { display: 'grid', gap: 6 } },
      e('div', { style: row },
        e('button', { type: 'button', style: chip(!category), onClick: () => setCategory(0) }, '全部'),
        categories.map((item) => e('button', {
          key: item.id, type: 'button', style: chip(category === item.id),
          onClick: () => setCategory(category === item.id ? 0 : item.id),
        }, uiVfxCatalog.categoryLabel(item.id) || `分类 ${item.id}`))),
      e('div', { style: row },
        e('select', {
          value: String(tag), onChange: (event) => setTag(Number(event.target.value)),
          'aria-label': '按标签筛选动效',
          style: { padding: '3px 6px', background: '#262b34', color: 'inherit', border: '1px solid #454b58', borderRadius: 6 },
        }, e('option', { value: '0' }, '全部标签'),
          uiVfxCatalog.tags.map((item) => e('option', { key: item.id, value: String(item.id) }, uiVfxCatalog.tagLabel(item) || `标签 ${item.id}`))),
        e('input', {
          value: query, onChange: (event) => setQuery(event.target.value), placeholder: '搜索名称或编号',
          'aria-label': '搜索界面动效',
          style: { flex: 1, minWidth: 120, padding: '3px 8px', background: '#262b34', color: 'inherit', border: '1px solid #454b58', borderRadius: 6 },
        }),
        e('span', { style: { color: '#8b96ab', fontSize: 12 } }, `${visible.length} / ${assets.length}`))) : null

    let body = null
    if (status === 'loading') body = e('div', { style: { padding: 24, textAlign: 'center', color: '#a7b2c8' } }, '正在加载动效素材…')
    else if (status === 'error') body = e('div', { style: { padding: 24, display: 'grid', gap: 8, justifyItems: 'center' } },
      e('span', { style: { color: '#f3a0a0' } }, `素材加载失败：${error}`),
      e('button', { type: 'button', className: 'qxsim-action', onClick: load }, '重试'))
    else if (!visible.length) body = e('div', { style: { padding: 24, textAlign: 'center', color: '#a7b2c8' } }, '没有符合条件的动效')
    else body = e('div', { style: grid }, visible.map((asset) => e('button', {
      key: asset.id, type: 'button', style: card(asset.id === selectedId),
      title: `${uiVfxCatalog.label(asset)}（#${asset.id}）`,
      onClick: () => onSelect?.(asset),
    },
    asset.icon
      ? e('img', { src: asset.icon, alt: '', loading: 'lazy', width: 64, height: 64, style: { objectFit: 'contain' } })
      : e('span', { style: { width: 64, height: 64, display: 'grid', placeItems: 'center', color: '#7d879b' } }, '✦'),
    e('span', { style: { fontSize: 12, lineHeight: 1.3 } }, uiVfxCatalog.label(asset)),
    e('small', { style: { color: '#8b96ab', fontSize: 10 } }, `#${asset.id}${asset.isLoop ? ' · 循环' : ' · 单次'}`))))

    return e('div', { style: overlay, onClick: (event) => { if (event.target === event.currentTarget) onClose?.() } },
      e('div', { style: panel, role: 'dialog', 'aria-modal': 'true', 'aria-label': '界面动效素材库' },
        header, filters, body))
  }
}
