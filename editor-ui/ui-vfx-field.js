// 界面动效属性卡片：显示当前素材、提供素材库入口、重播和内联预览。
// 预览按官方 C/T 双通道合成：底色上 multiply 叠 transmission，再 plus-lighter 叠 emission。
import { uiVfxCatalog } from '../studio/play/ui-vfx-catalog.js'
import { attachUIVfxRenderer } from './ui-vfx-preview.js'
import { createUIVfxLibrary } from './ui-vfx-library.js'

export function createUIVfxField(React) {
  const e = React.createElement
  const UIVfxLibrary = createUIVfxLibrary(React)
  const MAX_PREVIEW = 144

  return function UIVfxField({ field, scope = 'ui', commit }) {
    const [open, setOpen] = React.useState(false)
    const [showPreview, setShowPreview] = React.useState(true)
    const [revision, setRevision] = React.useState(0)
    const [error, setError] = React.useState('')
    const [catalogReady, setCatalogReady] = React.useState(false)
    const videoRef = React.useRef(null)
    const transmissionRef = React.useRef(null)
    const emissionRef = React.useRef(null)

    React.useEffect(() => {
      let alive = true
      uiVfxCatalog.load().then(() => { if (alive) setCatalogReady(true) }).catch(() => { if (alive) setCatalogReady(true) })
      return () => { alive = false }
    }, [])

    const raw = field?.value
    const id = raw === '' || raw === null || raw === undefined || Number.isNaN(Number(raw)) ? null : Number(raw)
    const asset = catalogReady && id ? uiVfxCatalog.byId(id) : null
    const label = asset ? uiVfxCatalog.label(asset) : id ? `#${id}` : '未选择动效'
    const ratio = asset ? asset.width / asset.height : 1
    const boxWidth = asset ? Math.min(MAX_PREVIEW, Math.round(MAX_PREVIEW * (ratio > 1 ? 1 : ratio))) : MAX_PREVIEW
    const boxHeight = asset ? Math.round(boxWidth / ratio) : MAX_PREVIEW

    React.useEffect(() => {
      setError('')
      if (!showPreview || !asset) return undefined
      const video = videoRef.current
      const transmission = transmissionRef.current
      const emission = emissionRef.current
      if (!video || !transmission || !emission) return undefined
      let renderer = null
      try {
        renderer = attachUIVfxRenderer(video, transmission, emission, {
          onError: () => setError('动效视频不是可拆分的 C/T 双通道格式，或浏览器拒绝解码'),
        })
      } catch (cause) {
        setError(String(cause?.message || cause))
        return undefined
      }
      video.play().catch(() => {})
      return () => renderer?.destroy()
    }, [showPreview, asset, revision])

    const select = (next) => {
      setOpen(false)
      setRevision((value) => value + 1)
      void commit?.(field?.key || 'animationId', next ? String(next.id) : '')
    }

    const card = e('div', {
      style: { display: 'flex', alignItems: 'center', gap: 6, padding: 7, border: '1px solid #454b58', borderRadius: 7, background: '#252a34' },
    },
    e('button', {
      type: 'button', onClick: () => setOpen(true),
      style: { display: 'flex', alignItems: 'center', gap: 9, flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', color: '#e2e7f1', textAlign: 'left', cursor: 'pointer' },
    },
    asset?.icon
      ? e('img', { src: asset.icon, alt: '', width: 30, height: 30, style: { objectFit: 'contain', flex: 'none' } })
      : e('span', { style: { width: 30, height: 30, display: 'grid', placeItems: 'center', color: '#7d879b', flex: 'none' } }, '✦'),
    e('span', { style: { display: 'grid', gap: 3, minWidth: 0 } },
      e('strong', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
      e('small', { style: { color: '#a7b2c8', fontSize: 10 } }, id ? `#${id}` : '点击选择'))),
    asset ? e('button', {
      type: 'button', title: '重播预览', 'aria-label': '重播预览', onClick: () => setRevision((value) => value + 1),
      style: { width: 26, height: 30, border: 0, background: 'transparent', color: '#cad3e5', cursor: 'pointer', fontSize: 15 },
    }, '▶') : null,
    id ? e('button', {
      type: 'button', title: '移除动效', 'aria-label': '移除动效', onClick: () => select(null),
      style: { width: 26, height: 30, border: 0, background: 'transparent', color: '#cad3e5', cursor: 'pointer', fontSize: 16 },
    }, '×') : null)

    const meta = e('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6, color: '#9ca9c2', fontSize: 10 } },
      e('span', null, asset ? `${asset.isLoop ? '循环' : '单次'} · ${asset.width}×${asset.height}` : `作用域：${scope === 'screen' ? '全屏' : '界面'}`),
      asset ? e('button', {
        type: 'button', onClick: () => setShowPreview((value) => !value), onClickCapture: undefined,
        style: { border: 0, padding: '3px 0', background: 'transparent', color: '#a9c0f3', cursor: 'pointer', font: 'inherit' },
      }, showPreview ? '隐藏预览' : '显示预览') : null)

    const preview = asset && showPreview ? e('div', { style: { marginTop: 6, display: 'grid', gap: 4 } },
      e('div', {
        style: {
          position: 'relative', width: boxWidth, height: boxHeight, background: 'rgba(255,255,255,0.92)',
          border: '1px solid #454b58', borderRadius: 4, overflow: 'hidden', isolation: 'isolate',
        },
      },
      e('canvas', { ref: transmissionRef, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', mixBlendMode: 'multiply' } }),
      e('canvas', { ref: emissionRef, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', mixBlendMode: 'plus-lighter' } })),
      error ? e('small', { style: { color: '#f3a0a0', fontSize: 10 } }, error) : null) : null

    return e('div', { className: 'qxsim-field qxsim-vfx-field', style: { display: 'grid', position: 'relative' } },
      e('span', { className: 'qxsim-field-label', style: { marginBottom: 4 } }, field?.label || '界面动效'),
      card, meta, preview,
      asset ? e('video', {
        ref: videoRef, src: asset.url, loop: asset.isLoop, muted: true, playsInline: true, autoPlay: true,
        style: { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none', left: -9999 },
      }) : null,
      open ? e(UIVfxLibrary, {
        scope: asset?.scope || scope, selectedId: id, onSelect: select, onClose: () => setOpen(false),
      }) : null)
  }
}
