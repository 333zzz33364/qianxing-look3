import {
  exportPrimitiveCss,
  importPrimitiveCss,
  importPrimitiveSvg,
  renderPrimitiveSvg,
  validateFitData,
} from '../studio/look2/primitives.js'
import { createPrimitiveFitJob, normalizeFitOptions } from './look2-fitting.js'

const DEFAULT_FIT_OPTIONS = Object.freeze({ defaultsVersion: 1, count: 400, resolution: 512, workers: 16, shapes: ['ellipse', 'rectangle'], transparent: true })
const ASSET_DB_NAME = 'look2-reference-assets-v1'
const ASSET_DB_VERSION = 1
const MAX_CATALOG_PAGE = 64

function resourceId() {
  if (globalThis.crypto?.randomUUID) return `resource-${globalThis.crypto.randomUUID()}`
  return `resource-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function dataUrl(mimeType, data) {
  const body = String(data || '')
  if (/^data:/i.test(body)) return body
  if (!body) throw new Error('图片下载结果为空')
  if (!/^[-\w.+]+\/[-\w.+]+$/.test(String(mimeType || ''))) throw new Error('图片 MIME 类型无效')
  return `data:${mimeType};base64,${body.replace(/^base64,/, '')}`
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片文件失败'))
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file) {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

function toSvgUrl(fitData) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderPrimitiveSvg(fitData))}`
}

function openAssetDb() {
  if (!globalThis.indexedDB) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB_NAME, ASSET_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('assets')) database.createObjectStore('assets', { keyPath: 'key' })
      if (!database.objectStoreNames.contains('catalog')) database.createObjectStore('catalog', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开本地图库缓存失败'))
  })
}

async function dbGet(storeName, key) {
  const db = await openAssetDb()
  if (!db) return null
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onsuccess = () => { const value = request.result || null; db.close(); resolve(value) }
    request.onerror = () => { const error = request.error || new Error('读取本地图库缓存失败'); db.close(); reject(error) }
  })
}

async function dbPut(storeName, value) {
  const db = await openAssetDb()
  if (!db) return
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const request = transaction.objectStore(storeName).put(value)
    request.onsuccess = () => {}
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('IndexedDB transaction aborted')) }
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('IndexedDB transaction failed')) }
    request.onerror = () => { const error = request.error || new Error('保存本地图库缓存失败'); db.close(); reject(error) }
  })
}

function labelOf(entry, id) {
  return String(entry?.name || entry?.title || entry?.label || entry?.chineseName || id)
}

function catalogEntries(catalog) {
  return Object.entries(catalog?.imageData || {}).map(([key, value]) => ({ id: String(value?.id ?? key), ...value }))
}

function catalogSpritePath(item, id = item?.id) {
  const imageId = String(id ?? '')
  let raw = String(item?.img || `sprite/${imageId}.png`)
  if (raw.startsWith('/')) raw = raw.slice(1)
  if (raw.startsWith('/') || raw.includes('\\') || !raw.startsWith('sprite/') || !raw.endsWith('.png')) return ''
  const fileName = raw.slice('sprite/'.length, -'.png'.length)
  if (!fileName || !/^[A-Za-z0-9_.-]+$/.test(fileName)) return ''
  return `/look2-assets/${raw}`
}

function makeFitOptions(raw) {
  return {
    defaultsVersion: 1,
    count: Math.max(1, Math.min(1000, Math.trunc(Number(raw?.count) || 400))),
    resolution: [64, 128, 256, 512].includes(Number(raw?.resolution)) ? Number(raw.resolution) : 512,
    workers: Math.max(1, Math.min(16, Math.trunc(Number(raw?.workers) || 16))),
    shapes: [...new Set((Array.isArray(raw?.shapes) ? raw.shapes : DEFAULT_FIT_OPTIONS.shapes).filter((shape) => ['ellipse', 'rectangle', 'triangle'].includes(shape)))],
    transparent: raw?.transparent !== false,
  }
}

function fitExists(resource) {
  try { return Boolean(resource?.fitData && validateFitData(resource.fitData)) }
  catch { return false }
}

function makeDataUrlFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('生成图库缓存失败'))
    reader.readAsDataURL(blob)
  })
}

function createDownload(name, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

/** Build the image resource dialog for a React host supplied by Web or DSH. */
export function createResourcesPanel(React) {
  if (!React?.createElement || !React?.useState || !React?.useEffect || !React?.useRef) throw new Error('createResourcesPanel 需要 React hooks API')
  const h = React.createElement
  const Fragment = React.Fragment

  function ResourcesPanel({
    state,
    getState,
    onChange,
    selectedId,
    onBind,
    onSelectImage,
    onClose,
    onError,
    onMessage,
    onFetchImage,
    workerURL,
  }) {
    const [activeId, setActiveId] = React.useState(selectedId || state?.primitiveResources?.[0]?.id || '')
    const [resourceSearch, setResourceSearch] = React.useState('')
    const [url, setUrl] = React.useState('')
    const [fitOptions, setFitOptions] = React.useState(makeFitOptions(DEFAULT_FIT_OPTIONS))
    const [progress, setProgress] = React.useState(null)
    const [catalog, setCatalog] = React.useState(null)
    const [catalogStatus, setCatalogStatus] = React.useState('正在读取在线图库…')
    const [catalogSearch, setCatalogSearch] = React.useState('')
    const [catalogCategory, setCatalogCategory] = React.useState('')
    const [catalogLimit, setCatalogLimit] = React.useState(MAX_CATALOG_PAGE)
    const [catalogThumbs, setCatalogThumbs] = React.useState({})
    const [message, setMessage] = React.useState('')
    const [localError, setLocalError] = React.useState('')
    const activeJob = React.useRef(null)
    const batchToken = React.useRef(null)
    const singleFitToken = React.useRef(null)
    const fitOptionsSave = React.useRef(Promise.resolve(true))
    const fitOptionsByResource = React.useRef(new Map())
    const loadingThumbs = React.useRef(new Set())
    const fileInput = React.useRef(null)
    const svgInput = React.useRef(null)
    const cssInput = React.useRef(null)

    const resources = Array.isArray(state?.primitiveResources) ? state.primitiveResources : []
    const selectedResource = resources.find((row) => row.id === activeId) || resources[0] || null
    const allState = () => typeof getState === 'function' ? getState() : state
    const reportError = (reason) => {
      const text = String(reason?.message || reason || '操作失败')
      setLocalError(text)
      try { onError?.(text) } catch {}
    }
    const reportMessage = (text) => {
      setMessage(String(text || ''))
      try { onMessage?.(String(text || '')) } catch {}
    }
    const commit = async (fn, label) => {
      if (typeof onChange !== 'function') throw new Error('资源编辑器缺少 onChange 事务回调')
      await onChange(fn, label)
    }
    const updateResource = (id, fn, label) => commit((next) => {
      const resource = next.primitiveResources.find((row) => row.id === id)
      if (!resource) throw new Error('资源已不存在，请刷新后重试')
      fn(resource, next)
    }, label)
    const waitForFitOptionsSaves = async () => {
      let pending
      let saved = true
      do {
        pending = fitOptionsSave.current
        saved = await pending
      } while (pending !== fitOptionsSave.current)
      return saved
    }

    React.useEffect(() => {
      if (selectedId && resources.some((row) => row.id === selectedId)) setActiveId(selectedId)
      else if (!resources.some((row) => row.id === activeId)) setActiveId(resources[0]?.id || '')
    }, [selectedId, resources.length, activeId])

    React.useEffect(() => {
      const id = selectedResource?.id
      if (!id) {
        setFitOptions(makeFitOptions(DEFAULT_FIT_OPTIONS))
        return
      }
      const draft = fitOptionsByResource.current.get(id)
      if (draft?.dirty) {
        setFitOptions(makeFitOptions(draft.value))
        return
      }
      const saved = makeFitOptions(selectedResource.fitOptions || DEFAULT_FIT_OPTIONS)
      fitOptionsByResource.current.set(id, {
        value: saved,
        generation: draft?.generation || 0,
        dirty: false,
      })
      setFitOptions(saved)
    }, [selectedResource?.id, selectedResource?.fitOptions])

    React.useEffect(() => {
      let disposed = false
      const load = async () => {
        let cached = null
        try { cached = (await dbGet('catalog', 'catalog'))?.value || null } catch {}
        if (cached && !disposed) { setCatalog(cached); setCatalogStatus('已载入本地图库缓存') }
        try {
          const response = await fetch('/look2-assets/catalog.json', { cache: 'no-cache' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const fresh = await response.json()
          if (!fresh || typeof fresh.imageData !== 'object' || typeof fresh.category !== 'object') throw new Error('图库目录格式无效')
          if (!disposed) { setCatalog(fresh); setCatalogStatus(`在线目录已更新 · ${Object.keys(fresh.imageData).length} 张图片`) }
          try { await dbPut('catalog', { key: 'catalog', value: fresh, savedAt: Date.now() }) } catch {}
        } catch (error) {
          if (!disposed && !cached) setCatalogStatus(`在线目录暂不可用：${error.message}`)
          else if (!disposed) setCatalogStatus('离线模式 · 正在使用上次保存的图库目录')
        }
      }
      void load()
      return () => { disposed = true }
    }, [])

    const visibleResources = resources.filter((row) => `${row.name || ''} ${row.id || ''}`.toLowerCase().includes(resourceSearch.trim().toLowerCase()))
    const refsFor = (id, current = allState()) => Object.values(current?.siteNodes || {}).filter((row) =>
      row?.properties?.imageResourceId === id || row?.properties?.primitiveResourceId === id).length
    const clearRefs = async (id, remove = false) => {
      await commit((next) => {
        if (!next.primitiveResources.some((resource) => resource.id === id)) throw new Error('资源已不存在，请刷新后重试')
        for (const row of Object.values(next.siteNodes || {})) {
          if (!row?.properties) continue
          if (row.properties.imageResourceId === id) delete row.properties.imageResourceId
          if (row.properties.primitiveResourceId === id) delete row.properties.primitiveResourceId
        }
        if (remove) next.primitiveResources = next.primitiveResources.filter((row) => row.id !== id)
      }, remove ? '移除图片资源及绑定' : '清除图片资源绑定')
      if (remove && activeId === id) setActiveId('')
      reportMessage(remove ? '已移除资源并清除全部绑定' : '已清除资源的全部绑定')
    }

    const addResource = async ({ name, imageUrl, sourceUrl = '', catalogId = null, mimeType = 'image/png' }) => {
      if (!/^data:image\//i.test(imageUrl)) throw new Error('图片资源必须以内嵌 data URL 保存')
      const id = resourceId()
      const record = {
        id, name: String(name || '图片'), imageUrl, mimeType,
        fitData: null, sourceUrl, catalogId,
        fitOptions: { ...makeFitOptions(DEFAULT_FIT_OPTIONS), shapes: [...DEFAULT_FIT_OPTIONS.shapes] },
        previewMode: 'image',
      }
      await commit((next) => { next.primitiveResources.push(record) }, '导入图片资源')
      setActiveId(id)
      reportMessage(`已导入 ${record.name}；图片数据已保存在工程中`)
      return id
    }

    const importLocalImages = async (files) => {
      for (const file of Array.from(files || [])) {
        try {
          const imageUrl = await readFileAsDataUrl(file)
          await addResource({ name: file.name, imageUrl, mimeType: file.type || imageUrl.slice(5, imageUrl.indexOf(';')) || 'image/png' })
        } catch (error) { reportError(error) }
      }
    }

    const importUrl = async () => {
      try {
        const value = url.trim()
        if (!value) throw new Error('请输入图片网址')
        if (typeof onFetchImage !== 'function') throw new Error('当前宿主没有配置图片网址读取回调')
        const result = await onFetchImage(value)
        const imageUrl = dataUrl(result?.mimeType || 'image/png', result?.data)
        await addResource({ name: value.split('/').filter(Boolean).at(-1) || value, imageUrl, sourceUrl: value, mimeType: result?.mimeType || 'image/png' })
        setUrl('')
      } catch (error) { reportError(error) }
    }

    const loadCatalogAsset = async (id, item) => {
      const key = `sprite:${id}`
      const cached = await dbGet('assets', key).catch(() => null)
      if (cached?.dataUrl) {
        setCatalogThumbs((old) => ({ ...old, [id]: cached.dataUrl }))
        return cached.dataUrl
      }
      if (typeof onFetchImage !== 'function') {
        if (cached?.dataUrl) return cached.dataUrl
        throw new Error('当前没有图库图片缓存，也没有配置素材读取回调')
      }
      const path = catalogSpritePath(item, id)
      if (!path) throw new Error('Invalid catalog image path')
      const fetched = await onFetchImage(path)
      const imageDataUrl = dataUrl(fetched?.mimeType || 'image/png', fetched?.data)
      try { await dbPut('assets', { key, id, dataUrl: imageDataUrl, mimeType: fetched?.mimeType || 'image/png', sourceUrl: path, savedAt: Date.now() }) } catch {}
      setCatalogThumbs((old) => ({ ...old, [id]: imageDataUrl }))
      return imageDataUrl
    }

    const categories = Object.entries(catalog?.category || {}).map(([key, value]) => ({ id: String(value?.id ?? key), name: String(value?.name || value?.title || value?.label || value?.id || key), images: Array.isArray(value?.images) ? value.images.map(String) : [] }))
    let listed = catalogEntries(catalog)
    if (catalogCategory) {
      const allowed = new Set(categories.find((item) => item.id === catalogCategory)?.images || [])
      listed = listed.filter((item) => allowed.has(String(item.id)))
    }
    const catalogQuery = catalogSearch.trim().toLowerCase()
    if (catalogQuery) listed = listed.filter((item) => `${item.id} ${labelOf(item, item.id)} ${item.name || ''} ${item.tags || ''}`.toLowerCase().includes(catalogQuery))
    const visibleCatalog = listed.slice(0, catalogLimit)

    React.useEffect(() => {
      let cancelled = false
      const ids = visibleCatalog.map((item) => String(item.id)).filter((id) => !catalogThumbs[id] && !loadingThumbs.current.has(id))
      const workers = Math.min(4, ids.length)
      const load = async () => {
        let cursor = 0
        await Promise.all(Array.from({ length: workers }, async () => {
          while (!cancelled && cursor < ids.length) {
            const id = ids[cursor++]
            loadingThumbs.current.add(id)
            try {
              const item = catalogEntries(catalog).find((row) => String(row.id) === id)
              await loadCatalogAsset(id, item)
            } catch {}
            finally { loadingThumbs.current.delete(id) }
          }
        }))
      }
      if (ids.length) void load()
      return () => { cancelled = true }
    }, [catalogLimit, catalogCategory, catalogSearch, catalog])

    const chooseCatalogAsset = async (item) => {
      try {
        const id = String(item.id)
        const imageUrl = await loadCatalogAsset(id, item)
        const mimeType = imageUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png'
        await addResource({ name: labelOf(item, id), imageUrl, sourceUrl: `/look2-assets/${String(item.img || `sprite/${id}.png`).replace(/^\//, '')}`, catalogId: id, mimeType })
      } catch (error) { reportError(error) }
    }

    const selectCatalogImage = async (item) => {
      const imageId = Number(item.id)
      if (!Number.isSafeInteger(imageId) || imageId < 0) return reportError(`图库图片 ID 无效：${item.id}`)
      if (typeof onSelectImage !== 'function') return chooseCatalogAsset(item)
      try {
        await onSelectImage(imageId)
        reportMessage(`已将图片控件设为官方图片 ID ${imageId}`)
      } catch (error) { reportError(error) }
    }

    const persistFitOptions = (change) => {
      if (!selectedResource) return Promise.resolve(false)
      const id = selectedResource.id
      const previous = fitOptionsByResource.current.get(id)
      const base = previous?.dirty
        ? previous.value
        : makeFitOptions(selectedResource.fitOptions || fitOptions || DEFAULT_FIT_OPTIONS)
      const requested = typeof change === 'function' ? change(makeFitOptions(base)) : change
      const normalized = makeFitOptions(requested)
      const generation = (previous?.generation || 0) + 1
      fitOptionsByResource.current.set(id, { value: normalized, generation, dirty: true })
      setFitOptions(normalized)
      const save = fitOptionsSave.current.then(() => updateResource(id, (resource) => {
        resource.fitOptions = { ...normalized, shapes: [...normalized.shapes] }
      }, '修改拟合选项')).then(() => {
        const latest = fitOptionsByResource.current.get(id)
        if (latest?.generation === generation) {
          latest.dirty = false
          setLocalError('')
        }
        return true
      }).catch((error) => {
        reportError(error)
        return false
      })
      fitOptionsSave.current = save
      return save
    }

    const runFit = async (id, batch, token) => {
      const isCancelled = () => token?.cancelled || (batch ? batchToken.current !== token : singleFitToken.current !== token)
      const throwIfCancelled = () => {
        if (isCancelled()) throw Object.assign(new Error('拟合已取消'), { name: 'AbortError' })
      }
      const optionsSaved = await waitForFitOptionsSaves()
      throwIfCancelled()
      if (!optionsSaved) throw new Error('拟合选项保存失败，请重试')
      const current = allState()
      const resource = current?.primitiveResources?.find((row) => row.id === id)
      if (!resource?.imageUrl) throw new Error('资源没有内嵌图片数据')
      const sourceImageUrl = resource.imageUrl
      const sourceRevision = resource.sourceRevision
      let options = makeFitOptions(resource.fitOptions || fitOptions)
      if (!options.shapes.length) throw new Error('至少选择一种拟合形状')
      if (activeJob.current) throw new Error('已有图元拟合任务正在运行')
      options = normalizeFitOptions(options, globalThis.navigator?.hardwareConcurrency || 1)
      setProgress({ id, name: resource.name, completed: 0, total: options.count, percent: 0, error: 1, actualWorkers: options.actualWorkers })
      let job
      job = createPrimitiveFitJob({
        source: sourceImageUrl,
        options,
        workerURL,
        onProgress: (value) => {
          if (!isCancelled() && activeJob.current === job) setProgress({ id, name: resource.name, ...value, actualWorkers: options.actualWorkers })
        },
      })
      activeJob.current = job
      try {
        const fitData = await job.promise
        throwIfCancelled()
        validateFitData(fitData)
        await updateResource(id, (target) => {
          if (target.imageUrl !== sourceImageUrl || target.sourceRevision !== sourceRevision) {
            throw new Error('拟合期间图片资源已变化，旧拟合结果保持不变')
          }
          target.fitData = fitData
          target.fitOptions = { ...options, actualWorkers: options.actualWorkers, defaultsVersion: 1 }
        }, '生成图元拟合')
        if (!isCancelled()) reportMessage(`${resource.name}：已生成 ${fitData.elements.length} 个图元`)
        return fitData
      } finally {
        if (activeJob.current === job) activeJob.current = null
      }
    }

    const fitOne = async () => {
      if (!selectedResource) return reportError('请先选择图片资源')
      if (batchToken.current || singleFitToken.current) return
      const token = { cancelled: false }
      singleFitToken.current = token
      setLocalError('')
      try { await runFit(selectedResource.id, false, token) }
      catch (error) {
        if (singleFitToken.current === token) {
          if (error?.name === 'AbortError') reportMessage('\u62df\u5408\u5df2\u53d6\u6d88\uff0c\u4fdd\u7559\u539f\u7ed3\u679c')
          else reportError(error)
        }
      } finally {
        if (singleFitToken.current === token) {
          singleFitToken.current = null
          if (!activeJob.current) setProgress(null)
        }
      }
    }

    const showAllFits = async () => {
      const current = allState()
      const rows = Array.isArray(current?.primitiveResources) ? current.primitiveResources : []
      const available = rows.filter(fitExists)
      const availableIds = new Set(available.map((row) => row.id))
      const skipped = rows.length - available.length
      if (!available.length) {
        reportMessage(`未切换拟合预览：${rows.length} 个资源均无有效拟合结果`)
        return
      }
      try {
        await commit((next) => {
          for (const row of next.primitiveResources || []) {
            if (availableIds.has(row.id) && fitExists(row)) row.previewMode = 'fit'
          }
        }, '全部显示拟合')
        reportMessage(`已将 ${available.length} 个资源切换为拟合预览${skipped ? `；${skipped} 个无有效拟合结果，已跳过` : ''}`)
      } catch (error) { reportError(error) }
    }

    const showAllOriginals = async () => {
      const current = allState()
      const rows = Array.isArray(current?.primitiveResources) ? current.primitiveResources : []
      const available = rows.filter((row) => typeof row?.imageUrl === 'string' && row.imageUrl.length > 0)
      const availableIds = new Set(available.map((row) => row.id))
      const skipped = rows.length - available.length
      if (!available.length) {
        reportMessage(`未切换原图预览：${rows.length} 个资源均无原图`)
        return
      }
      try {
        await commit((next) => {
          for (const row of next.primitiveResources || []) {
            if (availableIds.has(row.id) && typeof row.imageUrl === 'string' && row.imageUrl.length > 0) row.previewMode = 'image'
          }
        }, '全部显示原图')
        reportMessage(`已将 ${available.length} 个资源切换为原图预览${skipped ? `；${skipped} 个无原图资源，已跳过` : ''}`)
      } catch (error) { reportError(error) }
    }

    const fitMissing = async () => {
      if (batchToken.current || singleFitToken.current) return
      const token = { cancelled: false }
      batchToken.current = token
      let completed = 0
      let failed = 0
      let cancelled = 0
      try {
        const optionsSaved = await waitForFitOptionsSaves()
        if (token.cancelled) return
        if (!optionsSaved) {
          reportMessage('批量拟合未开始：拟合选项保存失败，待处理资源均未启动')
          return
        }
        const missing = (allState()?.primitiveResources || []).filter((row) => row.imageUrl && !row.fitData)
        if (!missing.length) { reportMessage('没有待拟合的图片资源'); return }
        setLocalError('')
        for (const resource of missing) {
          if (token.cancelled) break
          setActiveId(resource.id)
          try { await runFit(resource.id, true, token); completed += 1 }
          catch (error) {
            if (error?.name === 'AbortError') {
              cancelled += 1
              break
            }
            failed += 1
            reportError(`${resource.name}：${error.message || error}`)
            if (token.cancelled) break
          }
        }
        if (batchToken.current === token) {
          const unprocessed = Math.max(0, missing.length - completed - failed - cancelled)
          const stopped = token.cancelled || cancelled > 0
          reportMessage(stopped
            ? `批量拟合已取消；成功 ${completed} 张，失败 ${failed} 张，取消 ${cancelled} 张，未处理 ${unprocessed} 张`
            : `批量拟合完成；成功 ${completed} 张，失败 ${failed} 张，取消 0 张，未处理 0 张`)
        }
      } finally {
        if (batchToken.current === token) {
          batchToken.current = null
          if (!token.cancelled && !activeJob.current) setProgress(null)
        }
      }
    }

    const cancelFit = () => {
      if (batchToken.current) batchToken.current.cancelled = true
      if (singleFitToken.current) singleFitToken.current.cancelled = true
      activeJob.current?.cancel()
      activeJob.current = null
      setProgress(null)
      reportMessage('正在停止图元拟合…')
    }

    const close = () => {
      if (batchToken.current) batchToken.current.cancelled = true
      if (singleFitToken.current) singleFitToken.current.cancelled = true
      batchToken.current = null
      singleFitToken.current = null
      activeJob.current?.cancel()
      activeJob.current = null
      onClose?.()
    }

    React.useEffect(() => () => {
      if (batchToken.current) batchToken.current.cancelled = true
      if (singleFitToken.current) singleFitToken.current.cancelled = true
      batchToken.current = null
      singleFitToken.current = null
      activeJob.current?.cancel()
      activeJob.current = null
    }, [])

    const importPrimitiveFile = async (file, type) => {
      if (!selectedResource) throw new Error('请先选择要覆盖拟合结果的资源')
      const text = await readFileAsText(file)
      const fitData = type === 'svg' ? importPrimitiveSvg(text) : importPrimitiveCss(text)
      await updateResource(selectedResource.id, (resource) => { resource.fitData = fitData }, type === 'svg' ? '导入 Primitive SVG' : '导入 Shaper CSS')
      reportMessage(`${type.toUpperCase()} 已导入；旧结果已由新图元替换`)
    }

    const renameResource = async (id, name) => {
      if (!name.trim()) throw new Error('资源名称不能为空')
      await updateResource(id, (resource) => { resource.name = name.trim() }, '重命名图片资源')
    }

    const referenceCount = selectedResource ? refsFor(selectedResource.id) : 0
    let fitUrl = ''
    if (selectedResource?.fitData && selectedResource.previewMode === 'fit') {
      try { fitUrl = toSvgUrl(selectedResource.fitData) } catch {}
    }
    const previewUrl = selectedResource
      ? selectedResource.previewMode === 'fit' && fitUrl ? fitUrl : selectedResource.imageUrl
      : ''
    const optionNumber = (label, key, min, max, step = 1) => h('label', { className: 'look2-field', key },
      h('span', null, label),
      h('input', { type: 'number', min, max, step, value: fitOptions[key], onChange: (event) => persistFitOptions((current) => ({ ...current, [key]: event.target.value })) }))
    const urlImport = h('div', { className: 'look2-url-import' },
      h('input', { type: 'url', value: url, placeholder: '粘贴图片网址', onChange: (event) => setUrl(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') void importUrl() } }),
      h('button', { onClick: () => void importUrl() }, '导入网址并嵌入'))

    return h('div', { className: 'look2-modal-backdrop', onClick: close },
      h('section', { className: 'look2-modal look2-resource-manager', role: 'dialog', 'aria-label': '图片与图元资源', onClick: (event) => event.stopPropagation() },
        h('header', null,
          h('strong', null, `图片与图元资源 ${resources.length}`),
          h('span', { className: 'spacer' }),
          h('button', { onClick: () => fileInput.current?.click() }, '导入本地图片'),
          h('button', { onClick: close }, '关闭')),
        h('input', { hidden: true, ref: fileInput, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', multiple: true, onChange: (event) => { void importLocalImages(event.target.files); event.target.value = '' } }),
        h('input', { hidden: true, ref: svgInput, type: 'file', accept: '.svg,image/svg+xml', onChange: (event) => { const file = event.target.files?.[0]; if (file) void importPrimitiveFile(file, 'svg').catch(reportError); event.target.value = '' } }),
        h('input', { hidden: true, ref: cssInput, type: 'file', accept: '.css,text/css', onChange: (event) => { const file = event.target.files?.[0]; if (file) void importPrimitiveFile(file, 'css').catch(reportError); event.target.value = '' } }),
        h('div', { className: 'look2-resource-body' },
          h('aside', { className: 'look2-resource-list' },
            h('button', { style: { width: '100%', margin: '6px 0' }, onClick: () => void showAllFits() }, '全部显示拟合'),
            h('button', { style: { width: '100%', margin: '0 0 6px' }, onClick: () => void showAllOriginals() }, '全部显示原图'),
            h('input', { type: 'search', 'aria-label': '搜索资源', placeholder: '搜索名称或 ID', value: resourceSearch, onChange: (event) => setResourceSearch(event.target.value) }),
            visibleResources.map((item) => h('button', { key: item.id, className: item.id === selectedResource?.id ? 'selected' : '', onClick: () => { setActiveId(item.id); setLocalError('') } },
              h('span', null, item.name || item.id), h('small', null, fitExists(item) ? `${item.fitData.elements.length} 个图元` : '未拟合'))),
            !visibleResources.length ? h('p', null, resources.length ? '没有匹配的图片' : '导入本地图片、网址或在线目录素材') : null),
          h('main', { className: 'look2-resource-detail' }, selectedResource ? h(Fragment, null,
            h('div', { className: 'look2-resource-heading' },
              h('h3', null, selectedResource.name || '图片资源'),
              h('span', null, `绑定 ${referenceCount} 处 · ${selectedResource.catalogId ? `图库 ${selectedResource.catalogId}` : selectedResource.mimeType || '内嵌图片'}`)),
            h('div', { className: 'look2-resource-preview' }, previewUrl
              ? h('img', { src: previewUrl, alt: selectedResource.name || '', onError: () => setLocalError('图片预览无法显示') })
              : h('span', null, '尚无拟合预览')),
            h('div', { className: 'look2-field' }, h('label', null, '名称'), h('input', { key: selectedResource.id, type: 'text', defaultValue: selectedResource.name || '', onBlur: (event) => { if (event.target.value !== selectedResource.name) void renameResource(selectedResource.id, event.target.value).catch(reportError) } })),
            h('div', { className: 'look2-resource-actions' },
              h('button', { onClick: () => onBind?.(selectedResource.id) }, '绑定到选中图片控件'),
              h('button', { disabled: !fitExists(selectedResource), className: selectedResource.previewMode === 'image' ? 'selected' : '', onClick: () => void updateResource(selectedResource.id, (row) => { row.previewMode = 'image' }, '切换原图预览').catch(reportError) }, '原图'),
              h('button', { disabled: !fitExists(selectedResource), className: selectedResource.previewMode === 'fit' ? 'selected' : '', onClick: () => void updateResource(selectedResource.id, (row) => { row.previewMode = 'fit' }, '切换图元预览').catch(reportError) }, '拟合图元'),
              h('button', { disabled: !fitExists(selectedResource), onClick: () => { try { createDownload(`${selectedResource.name || 'primitive'}.svg`, renderPrimitiveSvg(selectedResource.fitData), 'image/svg+xml') } catch (error) { reportError(error) } } }, '导出 SVG'),
              h('button', { disabled: !fitExists(selectedResource), onClick: () => { try { createDownload(`${selectedResource.name || 'primitive'}.css`, exportPrimitiveCss(selectedResource.fitData), 'text/css') } catch (error) { reportError(error) } } }, '导出 Shaper CSS'),
              h('button', { onClick: () => svgInput.current?.click() }, '导入 SVG'),
              h('button', { onClick: () => cssInput.current?.click() }, '导入 CSS')),
            h('div', { className: 'look2-fit-options' },
              h('div', { className: 'look2-fit-options-heading', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                h('h4', null, '\u62df\u5408\u9009\u9879'),
                h('button', { onClick: () => persistFitOptions(() => ({ ...DEFAULT_FIT_OPTIONS, shapes: [...DEFAULT_FIT_OPTIONS.shapes] })) }, '\u6062\u590d\u9ed8\u8ba4')),
              optionNumber('图元数量', 'count', 1, 1000),
              h('label', { className: 'look2-field' }, h('span', null, '分辨率'), h('select', { value: fitOptions.resolution, onChange: (event) => persistFitOptions((current) => ({ ...current, resolution: Number(event.target.value) })) }, [64, 128, 256, 512].map((value) => h('option', { key: value, value }, value)))),
              h('label', { className: 'look2-field' }, h('span', null, `Worker 数（当前可用 ${Math.min(fitOptions.workers, Math.max(1, Number(globalThis.navigator?.hardwareConcurrency) || 1))}）`), h('input', { type: 'number', min: 1, max: 16, value: fitOptions.workers, onChange: (event) => persistFitOptions((current) => ({ ...current, workers: event.target.value })) })),
              h('div', { className: 'look2-fit-shapes' }, ['ellipse', 'rectangle', 'triangle'].map((shape) => h('label', { key: shape }, h('input', { type: 'checkbox', checked: fitOptions.shapes.includes(shape), onChange: (event) => persistFitOptions((current) => ({ ...current, shapes: event.target.checked ? [...current.shapes, shape] : current.shapes.filter((value) => value !== shape) })) }), { ellipse: '椭圆', rectangle: '矩形', triangle: '三角形' }[shape]))),
              h('label', { className: 'look2-field look2-inline-check' }, h('input', { type: 'checkbox', checked: fitOptions.transparent, onChange: (event) => persistFitOptions((current) => ({ ...current, transparent: event.target.checked })) }), '透明背景'),
              h('div', { className: 'look2-resource-actions' },
                h('button', { className: 'primary', disabled: Boolean(progress), onClick: () => void fitOne() }, '生成拟合图元'),
                h('button', { disabled: Boolean(progress), onClick: () => void fitMissing() }, '批量拟合未完成资源'),
                progress ? h('button', { onClick: cancelFit }, '取消') : null),
              progress ? h('div', { className: 'look2-fit-progress' },
                h('div', { className: 'look2-fit-progress-track', role: 'progressbar', 'aria-label': '\u56fe\u5143\u62df\u5408\u8fdb\u5ea6', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.max(0, Math.min(100, Number(progress.percent) || 0)) }, h('span', { style: { width: `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%` } })),
                h('span', null, `${progress.name || ''} · ${progress.completed}/${progress.total} · ${progress.actualWorkers} Workers · 剩余误差 ${Number(progress.error || 0).toFixed(3)}`)) : null),
            urlImport,
            h('div', { className: 'look2-resource-actions' },
              h('button', { disabled: referenceCount === 0, onClick: () => void clearRefs(selectedResource.id).catch(reportError) }, '清除全部绑定'),
              h('button', { className: 'danger', onClick: () => void clearRefs(selectedResource.id, true).catch(reportError) }, '移除资源及绑定')),
          ) : h(Fragment, null, h('p', null, '选择或导入一张图片资源'), urlImport),
          h('div', { className: 'look2-online-catalog' },
            h('header', null, h('strong', null, '在线图片目录'), h('span', { className: 'spacer' }), h('small', null, catalogStatus)),
            h('div', { className: 'look2-resource-actions' },
              h('input', { type: 'search', 'aria-label': '搜索在线图片', placeholder: '搜索 ID 或名称', value: catalogSearch, onChange: (event) => { setCatalogSearch(event.target.value); setCatalogLimit(MAX_CATALOG_PAGE) } }),
              h('select', { value: catalogCategory, onChange: (event) => { setCatalogCategory(event.target.value); setCatalogLimit(MAX_CATALOG_PAGE) } }, [h('option', { key: '', value: '' }, '全部分类'), ...categories.map((item) => h('option', { key: item.id, value: item.id }, item.name))])),
            h('div', { className: 'look2-catalog-grid' }, visibleCatalog.map((item) => h('article', { className: 'look2-catalog-item', key: item.id },
              h('button', { title: `${labelOf(item, item.id)} (${item.id})`, onClick: () => void selectCatalogImage(item) },
                h('img', { src: catalogThumbs[item.id] || catalogSpritePath(item) || undefined, alt: '', loading: 'lazy', onError: async (event) => {
                  const cached = await dbGet('assets', `sprite:${item.id}`).catch(() => null)
                  if (cached?.dataUrl) { setCatalogThumbs((old) => ({ ...old, [item.id]: cached.dataUrl })); event.currentTarget.src = cached.dataUrl }
                  else event.currentTarget.hidden = true
                } }), h('span', null, `${labelOf(item, item.id)} · ${item.id}`)),
              h('button', { className: 'look2-catalog-add', onClick: () => void chooseCatalogAsset(item) }, '添加为图元原图')))),
            catalogLimit < listed.length ? h('button', { onClick: () => setCatalogLimit((value) => value + MAX_CATALOG_PAGE) }, `再显示 ${Math.min(MAX_CATALOG_PAGE, listed.length - catalogLimit)} 张`) : null,
          ),
          localError ? h('p', { className: 'look2-resource-error', role: 'alert' }, localError) : null,
          message ? h('p', { className: 'look2-resource-message', role: 'status' }, message) : null,
        ),
      ),
    )
    )
  }

  return { ResourcesPanel }
}

export { DEFAULT_FIT_OPTIONS, makeFitOptions, toSvgUrl }
