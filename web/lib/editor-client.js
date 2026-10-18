import React from 'react'
import { createRoot } from 'react-dom/client'
import { createEditor } from 'qxqy-editor-ui'

const key = 'look2-editor-session'
const returnSession = new URLSearchParams(location.hash.slice(1)).get('session')
let sessionId = /^[a-zA-Z0-9_-]{1,100}$/.test(returnSession || '') ? returnSession : ''
if (!sessionId) {
  try { sessionId = sessionStorage.getItem(key) || '' } catch { /* Storage may be disabled. */ }
}
if (!sessionId) {
  sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
}
try { sessionStorage.setItem(key, sessionId) } catch { /* The return fragment keeps the session across reloads. */ }
const editor = createEditor(React, {
  async api(sessionId, action, body = {}) {
    const response = await fetch(`/editor/api/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...body }),
      ...(action === 'play' ? { signal: AbortSignal.timeout(15_000) } : {}),
    })
    const envelope = await response.json()
    if (!response.ok || !envelope.ok) throw new Error(envelope.error || '请求失败')
    return envelope.value
  },
  playUrl: id => `/editor/play#${encodeURIComponent(id)}`,
  saveToWorkspace: true,
})
editor.ensureStyle()
createRoot(document.getElementById('editor')).render(React.createElement(editor.SimulatorView, { sessionId }))
