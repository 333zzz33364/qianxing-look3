import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { extractSupportedUiGia } from '../studio/gia/mixed-ui.js'
import { importGia } from '../studio/gia/codec.js'

const [sourcePath, outputPrefix] = process.argv.slice(2)
if (!sourcePath || !outputPrefix) {
  console.error('用法：node scripts/extract-ui-gia.mjs <源文件.gia> <输出前缀>')
  process.exitCode = 1
} else {
  const source = await readFile(resolve(sourcePath))
  const extracted = extractSupportedUiGia(source)
  if (!extracted.mixed) throw new Error('源文件不是含多种资产的混合 GIA')
  const imported = importGia(extracted.buffer)
  const prefix = resolve(outputPrefix)
  const manifest = {
    source: resolve(sourcePath),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    gameVersion: imported.metadata.gameVersion,
    extractedGroup: extracted.selectedGroup,
    clientTemplates: imported.clientProject?.root.children.map((node) => ({ name: node.name, kind: node.kind })) || [],
    skippedServerGroups: extracted.groupNames.filter((name) => name !== extracted.selectedGroup),
    warnings: imported.warnings,
  }
  await mkdir(dirname(prefix), { recursive: true })
  await writeFile(`${prefix}.gia`, extracted.buffer, { flag: 'wx' })
  await writeFile(`${prefix}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  console.log(`已提取 ${manifest.extractedGroup} 和 ${manifest.clientTemplates.length} 个客户端模板：${prefix}.gia`)
  console.log(`另有 ${manifest.skippedServerGroups.length} 个服务端控件组未适配，清单：${prefix}.json`)
}
