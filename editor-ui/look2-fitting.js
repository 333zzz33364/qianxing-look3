const SHAPES = new Set(['ellipse', 'rectangle', 'triangle'])
const RESOLUTIONS = new Set([64, 128, 256, 512])
const IMAGE_IDS = Object.freeze({ rectangle: 100001, ellipse: 100002, triangle: 100003 })

function intInRange(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback
}

export function normalizeFitOptions(input = {}, hardwareConcurrency = globalThis.navigator?.hardwareConcurrency || 1) {
  const count = intInRange(input.count, 400, 1, 1000)
  const requestedResolution = Number(input.resolution)
  const resolution = RESOLUTIONS.has(requestedResolution) ? requestedResolution : 512
  const requestedWorkers = intInRange(input.workers, 16, 1, 16)
  const hardware = intInRange(hardwareConcurrency, 1, 1, 16)
  const shapes = [...new Set((Array.isArray(input.shapes) ? input.shapes : ['ellipse', 'rectangle']).filter((shape) => SHAPES.has(shape)))]
  if (!shapes.length) throw new Error('至少选择一种拟合形状')
  return { count, resolution, workers: requestedWorkers, actualWorkers: Math.min(requestedWorkers, hardware), shapes, transparent: input.transparent !== false }
}

function abortError() {
  const error = new Error('图元拟合已取消')
  error.name = 'AbortError'
  return error
}

/** Create an incremental worker-backed image-fit job. Call cancel() to stop all worker work. */
export function createPrimitiveFitJob({ source, options, workerURL, onProgress, WorkerClass = globalThis.Worker, hardwareConcurrency } = {}) {
  if (!source) throw new Error('拟合需要图片 data URL')
  if (!workerURL) throw new Error('未配置图元拟合 Worker URL')
  if (typeof WorkerClass !== 'function') throw new Error('当前浏览器不支持 Web Worker 图元拟合')
  const config = normalizeFitOptions(options, hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 1)
  let workers = []
  let settled = false
  let cancelled = false
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject
    try {
      for (let index = 0; index < config.actualWorkers; index += 1) workers.push(new WorkerClass(workerURL))
    } catch (error) {
      for (const worker of workers) {
        try { worker.terminate() } catch {}
      }
      workers = []
      reject(error)
      return
    }
    const terminate = () => {
      for (const worker of workers) {
        worker.onmessage = null
        worker.onerror = null
        try { worker.terminate() } catch {}
      }
      workers = []
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      terminate()
      reject(error instanceof Error ? error : new Error(String(error || '图元拟合 Worker 失败')))
    }
    let lastError = 0
    const finish = (fit) => {
      if (settled) return
      settled = true
      terminate()
      try { onProgress?.({ completed: iteration, total: config.count, percent: iteration / config.count * 100, error: lastError, elements: fit.elements.length }) } catch {}
      resolve(fit)
    }

    let meta = null
    let readyCount = 0
    let iteration = 0
    let elements = []
    let responseRows = []
    let commitCount = 0
    let currentCandidate = null
    const handleMessage = (workerIndex, event) => {
      if (settled) return
      const message = event?.data || {}
      try {
        if (message.type === 'error') throw new Error(message.message || '图元拟合 Worker 失败')
        if (message.type === 'decoded' && workerIndex === 0) {
          meta = { width: message.width, height: message.height, gridWidth: message.gridWidth, gridHeight: message.gridHeight, pixels: new Uint8ClampedArray(message.pixels) }
          if (!config.transparent) elements.push({
            type: 'rectangle', imageId: IMAGE_IDS.rectangle, x: 0, y: 0,
            width: meta.width, height: meta.height, rotation: 0,
            color: { r: 255, g: 255, b: 255, a: 1 },
          })
          for (let index = 0; index < workers.length; index += 1) {
            const pixels = meta.pixels.slice()
            workers[index].postMessage({
              type: 'init', workerIndex: index, width: meta.width, height: meta.height,
              gridWidth: meta.gridWidth, gridHeight: meta.gridHeight, pixels: pixels.buffer,
              transparent: config.transparent, shapes: config.shapes, workerCount: workers.length,
            }, [pixels.buffer])
          }
          return
        }
        if (message.type === 'ready') {
          readyCount += 1
          if (readyCount === workers.length) searchNext()
          return
        }
        if (message.type === 'candidate') {
          responseRows[workerIndex] = message.candidate || null
          if (Number.isFinite(Number(message.error))) lastError = Math.max(0, Number(message.error))
          if (responseRows.filter((row) => row !== undefined).length === workers.length) {
            currentCandidate = responseRows.filter(Boolean).sort((a, b) => b.improvement - a.improvement)[0] || null
            if (!currentCandidate || currentCandidate.improvement <= 0) {
              finish({ version: 1, width: meta.width, height: meta.height, elements })
              return
            }
            commitCount = 0
            for (const worker of workers) worker.postMessage({ type: 'commit', iteration, candidate: currentCandidate })
          }
          return
        }
        if (message.type === 'committed') {
          commitCount += 1
          if (commitCount === workers.length) {
            elements.push(currentCandidate.element)
            iteration += 1
            const remaining = Math.max(0, Number(message.remaining) || 0)
            lastError = Number(message.error) || 0
            try { onProgress?.({ completed: iteration, total: config.count, percent: Math.min(100, iteration / config.count * 100), error: lastError, remaining }) } catch {}
            if (iteration >= config.count || remaining <= 1e-8) finish({ version: 1, width: meta.width, height: meta.height, elements })
            else searchNext()
          }
          return
        }
      } catch (error) { fail(error) }
    }
    function searchNext() {
      if (settled || cancelled) return
      responseRows = new Array(workers.length)
      for (const worker of workers) worker.postMessage({ type: 'search', iteration })
    }
    workers.forEach((worker, index) => {
      worker.onmessage = (event) => handleMessage(index, event)
      worker.onerror = (event) => fail(new Error(event?.message || '图元拟合 Worker 运行失败'))
    })
    workers[0].postMessage({ type: 'decode', source, resolution: config.resolution })
  })
  return {
    promise,
    options: config,
    cancel() {
      if (settled || cancelled) return
      cancelled = true
      settled = true
      for (const worker of workers) {
        worker.onmessage = null
        worker.onerror = null
        try { worker.terminate() } catch {}
      }
      workers = []
      rejectPromise(abortError())
    },
  }
}
