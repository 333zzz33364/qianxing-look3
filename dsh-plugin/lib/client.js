import { createEditor } from 'qxqy-editor-ui'

window.__ModuleLoader__.load({
  id: 'look3-dsh-plugin',
  factory: require => {
    const exports = {}
    const React = require('react')
    const editor = createEditor(React, {
      async api(sessionId, action, body) {
        const response = await fetch('/look3-simulator/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...(body || {}) }), ...(action === 'play' ? { signal: AbortSignal.timeout(15_000) } : {}) })
        const envelope = await response.json()
        if (!response.ok || !envelope.ok) throw new Error(envelope.error || 'Request failed')
        return envelope.value
      },
      playUrl: sessionId => '/look3-simulator/play#' + encodeURIComponent(sessionId),
    })
    exports.inject = ['slots']
    exports.apply = ctx => {
      editor.ensureStyle()
      ctx.effect(() => editor.removeStyle, 'look3-simulator: style cleanup')
      ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'look3-simulator', order: 20, label: () => 'look2.0' }, editor.SimulatorView))
    }
    return exports
  },
})
