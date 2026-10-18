const list = value => value == null ? [] : Array.isArray(value) ? value : [value]
const components = node => list(node?.['19']?.['1']?.['505'])

/** Repair the reference editor's pre-mask-support defaults without overriding edits.
 * The converter document remains intact; only the known mask flag is read.
 */
export function restoreLegacySiteMasks(nodes, source, project = null) {
  if (!source?.document?.json || Number(source.imageMaskVersion || 0) >= 1) return
  const document = source.document.json
  const primary = list(document['1'])
  if (!primary.some(node => [21, 70].includes(node?.['5']) && components(node).some(row => row?.['11'] !== undefined))) return
  const original = new Map([...primary, ...list(document['2'])].map(node => [Number(node?.['1']?.['4']), node]))
  const baseline = new Map((source.baseline || []).map(node => [node.id, node]))
  const canonical = new Map()
  const visit = node => { canonical.set(node.id, node); for (const child of node.children || []) visit(child) }
  if (project?.root) visit(project.root)
  for (const node of nodes) {
    if (node?.type !== 'image' || !/^gia_node_\d+$/.test(node.id)) continue
    const native = original.get(Number(node.id.slice('gia_node_'.length)))
    const component = components(native).find(row => row?.['84'] !== undefined)
    if (!component) continue
    const mask = component['503']?.['85'] ?? component['84']
    const enabled = Number(mask?.['501'] || 0) !== 0
    const before = baseline.get(node.id)
    node.properties ||= {}
    if (!before || before.type === 'image' && node.properties.enableMask === before.properties?.enableMask) {
      node.properties.enableMask = enabled
      const control = canonical.get(node.id)
      if (control) control.enableMask = enabled
    }
    if (before?.type === 'image') { before.properties ||= {}; before.properties.enableMask = enabled }
  }
  source.imageMaskVersion = 1
}
