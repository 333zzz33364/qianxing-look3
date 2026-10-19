import { createCanvas } from '@napi-rs/canvas'
import { localFontStack } from '../host/local-font.js'
import { createTextLayout } from './text-layout-core.js'

export const textLayout = createTextLayout(createCanvas(1, 1).getContext('2d'), localFontStack)
