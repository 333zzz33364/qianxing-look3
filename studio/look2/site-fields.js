import { normalizeKeyCode, keyCodeNames } from '../ui/keyhint.js'

// Translate reference-editor names at the boundary; the shared authoring model
// remains the single editable state used by every host.
export const SITE_TYPE_TO_KIND = Object.freeze({
  container: 'container', image: 'image', primitive: 'image', text: 'textbox', textbox: 'textbox',
  textWindow: 'textwindow', textwindow: 'textwindow', presetButton: 'button', button: 'button',
  cursorEventArea: 'cursor', cursor: 'cursor', gridScroller: 'grid', grid: 'grid',
  keyHint: 'keyhint', keyhint: 'keyhint', uiAnimation: 'animation', animation: 'animation',
  fullscreenAnimation: 'fullscreen', fullscreen: 'fullscreen', reference: 'reference',
})

export const KIND_TO_SITE_TYPE = Object.freeze({ container: 'container', image: 'image', textbox: 'text',
  textwindow: 'textWindow', button: 'presetButton', cursor: 'cursorEventArea', grid: 'gridScroller',
  keyhint: 'keyHint', animation: 'uiAnimation', fullscreen: 'fullscreenAnimation', reference: 'reference' })

const upper = value => typeof value === 'string' ? value.replace(/^./, letter => letter.toUpperCase()) : value
const lower = value => typeof value === 'string' ? value.replace(/^./, letter => letter.toLowerCase()) : value
const enums = ['imageSource', 'imageType', 'softEdgeMode', 'fillType', 'fillHorizontalType', 'fillVerticalType',
  'fillRadial90Type', 'fillRadialType', 'horizontalAlignment', 'verticalAlignment', 'scrollDirection', 'layoutConstraint', 'layer']
const keyTypes = { keyboardKeyCode: 'KeyboardKeyCode', controllerKeyCode: 'ControllerKeyCode' }

export function readSiteProperties(kind, input = {}) {
  const properties = { ...input }
  for (const key of enums) if (properties[key] != null) properties[key] = upper(properties[key])
  if (kind === 'image') {
    const filled = properties.fillType != null && properties.fillType !== 'Unused'
    if (properties.fillType === 'Unused') properties.fillType = 'Horizontal'
    properties.enableFill ??= filled && properties.fillAmount != null
  }
  if (kind === 'reference' && Object.hasOwn(properties, 'referencedPrefabIndex')) properties.referencedPrefabId = properties.referencedPrefabIndex
  if (kind === 'grid') {
    if (Object.hasOwn(properties, 'itemPrefabIndex')) properties.itemPrefabId = properties.itemPrefabIndex
    if (Object.hasOwn(properties, 'itemCount')) properties.previewCount = properties.itemCount
  }
  if (kind === 'keyhint') for (const key of Object.keys(keyTypes)) if (properties[key] != null) properties[key] = normalizeKeyCode(properties[key], keyTypes[key])
  return properties
}

const fieldsByKind = {
  container: ['isolateNavigation', 'disableKeyEventPassthrough', 'disableCursorEventPassthrough', 'showCursor'],
  image: ['imageId', 'imageSource', 'imageType', 'enableMask', 'enableSoftEdge', 'softEdgeMode', 'softEdgeWidthX',
    'softEdgeWidthY', 'horizontalSoftRange', 'verticalSoftRange', 'reverseMaskArea', 'enableFill', 'fillClockwise',
    'fillType', 'fillHorizontalType', 'fillVerticalType', 'fillRadial90Type', 'fillRadialType', 'fillAmount'],
  textbox: ['text', 'fontSize', 'enableOutline', 'adaptiveFontSize', 'minimumFontSize', 'horizontalAlignment', 'verticalAlignment'],
  textwindow: ['text', 'fontSize', 'enableOutline', 'adaptiveFontSize', 'minimumFontSize', 'horizontalAlignment', 'verticalAlignment', 'interactable', 'showScrollBar'],
  button: ['interactable', 'clickAudioId', 'raycastTarget'], cursor: ['raycastTarget'],
  grid: ['raycastTarget', 'showScrollBar', 'interactable', 'scrollDirection', 'layoutConstraint', 'layoutConstraintFixedCount', 'scrollProgress'],
  keyhint: ['keyboardKeyCode', 'controllerKeyCode'], animation: ['animationId', 'playSoundEffect', 'layer'],
  fullscreen: ['animationId', 'playSoundEffect'], reference: [],
}

export function writeSiteProperties(node) {
  const properties = Object.fromEntries((fieldsByKind[node.kind] || [])
    .filter(key => node[key] !== undefined).map(key => [key, enums.includes(key) ? lower(node[key]) : node[key]]))
  if (node.kind === 'grid') Object.assign(properties, { itemPrefabIndex: node.itemPrefabId, itemCount: node.previewCount })
  if (node.kind === 'reference') properties.referencedPrefabIndex = node.referencedPrefabId
  if (node.kind === 'keyhint') for (const key of Object.keys(keyTypes)) {
    const names = keyCodeNames(keyTypes[key]).filter(name => name !== 'None')
    properties[key] = node[key] === 0 ? 'None' : key === 'keyboardKeyCode' && Number(node[key]) > 43
      ? node[key] : names[node[key] - 1] ?? node[key]
  }
  return properties
}

export function readSiteAnimations(animations) {
  return animations.map(animation => ({ ...animation, keyframeTracks: (animation.keyframeTracks || []).map(track => ({
    ...track, keyframes: (track.keyframes || []).map(frame => {
      const next = { ...frame }
      if (!Object.hasOwn(next, 'leftValue') && Object.hasOwn(next, 'incomingValue')) next.leftValue = next.incomingValue
      if (!Object.hasOwn(next, 'leftRelative') && Object.hasOwn(next, 'incomingRelative')) next.leftRelative = next.incomingRelative
      delete next.incomingValue; delete next.incomingRelative
      return next
    }),
  })) }))
}

export function writeSiteAnimations(animations) {
  return animations.map(animation => ({ ...animation, keyframeTracks: (animation.keyframeTracks || []).map(track => ({
    ...track, keyframes: (track.keyframes || []).map(frame => {
      const next = { ...frame }
      if (Object.hasOwn(next, 'leftValue')) next.incomingValue = next.leftValue
      if (Object.hasOwn(next, 'leftRelative')) next.incomingRelative = next.leftRelative
      delete next.leftValue; delete next.leftRelative
      return next
    }),
  })) }))
}
