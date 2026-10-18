// A playtest toggle is one button: rapid double-clicks must not start and then
// immediately cancel the same session. Starting stamps this grace window.
export const PLAY_STOP_GRACE_MS = 600

export function canStopInlinePlay(startedAt, now = Date.now(), grace = PLAY_STOP_GRACE_MS) {
  const started = Number(startedAt)
  if (!Number.isFinite(started) || started <= 0) return true
  return Number(now) - started >= grace
}

export function playTargetGuide() {
  return {
    full: {
      value: 'full',
      label: '完整界面',
      detail: '试玩当前界面的全部控件（服务端 UI 根节点），不受控件树当前选中项影响。',
    },
    template: {
      value: 'template',
      label: '当前模板',
      detail: '只试玩当前选中的客户端控件模板子树；需先切换到客户端模板并选中模板或其子控件。',
    },
    difference: '区别：完整界面覆盖整个界面，当前模板只覆盖选中的单个客户端控件模板；当前模板仅在客户端模板资产下可用。',
  }
}

export function buildPlayLog(parts = {}) {
  const now = parts.now ?? Date.now()
  return {
    exportedAt: new Date(now).toISOString(),
    sessionId: parts.sessionId || '',
    project: {
      name: parts.saveName || '',
      path: parts.filePath || '',
      assetType: parts.assetType || '',
      canvas: parts.canvas ?? null,
    },
    play: {
      target: parts.playTarget === 'template' ? 'template' : 'full',
      running: Boolean(parts.running),
    },
    status: parts.status ?? null,
    server: parts.server ?? null,
    controls: parts.tree ?? [],
    logs: parts.logs ?? [],
  }
}

export function playLogFilename(now = Date.now()) {
  return `look2-play-log-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`
}