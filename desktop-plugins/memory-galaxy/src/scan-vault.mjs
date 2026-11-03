// Scan an Obsidian vault -> vault-graph.json for the Memory Galaxy plugin.
// Usage: node scan-vault.mjs <vaultDir> <outFile>
import fs from 'node:fs'
import path from 'node:path'

const vault = process.argv[2]
const out = process.argv[3]

const nodes = []
const nodeMap = new Map()
const linkRe = /\[\[([^\]|#]+)/g

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (name !== '.obsidian' && name !== '.git') walk(full)
      continue
    }
    if (!name.toLowerCase().endsWith('.md')) continue

    let content = ''
    try { content = fs.readFileSync(full, 'utf8') } catch { continue }

    const rel = path.relative(vault, full)
    const id = rel.replace(/\\/g, '/').replace(/\.md$/i, '')
    const folder = rel.split(path.sep)[0] || 'Root'
    const label = path.basename(id)

    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')
    const targets = []
    let m
    while ((m = linkRe.exec(cleaned)) !== null) targets.push(m[1].trim())

    const node = {
      id,
      label,
      folder: folder.endsWith('.md') ? 'Root' : folder,
      mtime: Math.floor(st.mtimeMs / 1000),
      linkCount: 0,
      content: content.slice(0, 4000),
      targets
    }
    nodes.push(node)
    nodeMap.set(id.toLowerCase(), node)
  }
}

walk(vault)

const byLabel = new Map()
for (const n of nodes) {
  if (!byLabel.has(n.label.toLowerCase())) byLabel.set(n.label.toLowerCase(), n)
}

const links = []
const seen = new Set()
for (const n of nodes) {
  for (const t of n.targets) {
    const key = t.toLowerCase().replace(/\.md$/, '')
    const target = nodeMap.get(key) || byLabel.get(key)
    if (!target || target.id === n.id) continue
    const sig = n.id + '->' + target.id
    if (seen.has(sig)) continue
    seen.add(sig)
    links.push({ source: n.id, target: target.id })
  }
}

const counts = new Map()
for (const l of links) counts.set(l.source, (counts.get(l.source) || 0) + 1)
for (const n of nodes) { n.linkCount = counts.get(n.id) || 0; delete n.targets }

const times = nodes.map(n => n.mtime)
const min = Math.min(...times)
const max = Math.max(...times)
const range = max - min || 1
for (const n of nodes) n.brightness = (n.mtime - min) / range

fs.writeFileSync(out, JSON.stringify({ vault, generatedAt: new Date().toISOString(), nodes, links }, null, 2))
console.log(`Wrote ${nodes.length} nodes, ${links.length} links -> ${out}`)
