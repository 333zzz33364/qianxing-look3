import { CANVAS_PRESETS, DEFAULT_CANVAS_ID } from '../constants.js'

export function customCanvas(settings) {
  if (!settings) return null
  const width = Number(settings.canvasWidth), height = Number(settings.canvasHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384) return null
  const preset = CANVAS_PRESETS[settings.previewPresetId]
  if (preset && width === preset.width && height === preset.height) return null
  return { id: String(settings.previewPresetId || 'custom'), width, height }
}

export function projectCanvas(project, overrideId = '') {
  const explicit = CANVAS_PRESETS[overrideId]
  const base = explicit || CANVAS_PRESETS[project.canvasId] || CANVAS_PRESETS[DEFAULT_CANVAS_ID]
  const custom = !explicit && project.meta?.customCanvas
  return custom ? { ...base, width: custom.width, height: custom.height, label: `自定义 ${custom.width}×${custom.height}` } : base
}

// Preserve raw site metadata at the boundary; use one canonical canvas in Studio.
export function adoptSiteCanvas(project, look2) {
  const custom = customCanvas(look2?.siteCanvasSettings)
  if (custom) project.meta.customCanvas = custom
}
