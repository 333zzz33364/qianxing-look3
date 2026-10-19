import { createTextLayout } from './text-layout-core.js'
import { browserFontStack } from './browser-font.js'

let layout
export function textLayout(item, width, height) {
  layout ||= createTextLayout(document.createElement('canvas').getContext('2d'), browserFontStack)
  return layout(item, width, height)
}
