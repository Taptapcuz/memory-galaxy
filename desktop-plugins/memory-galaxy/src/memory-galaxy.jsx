/**
 * Memory Galaxy — live graph view of the Obsidian vault inside Hermes Desktop.
 *
 * Standalone desktop plugin. Only `@hermes/plugin-sdk` and `react*` may be
 * imported (the renderer's ESM allowlist), so this renders on a 2D canvas with
 * its own perspective projection and force-directed layout.
 *
 * Data comes from the app bridge (`window.hermesDesktop.readDir/readFileText`),
 * re-scanned on an interval, so the map tracks the vault instead of a snapshot.
 * `src/graph.json` is only a fallback for a shell without the bridge.
 */
import { ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import FALLBACK_GRAPH from './graph.json'

const ID = 'memory-galaxy'
const ROUTE = '/memory-galaxy'

/** The plugin context, captured in register(); ctx.rest is the only door to the
 *  backend that can launch obsidian:// (the renderer blocks non-web schemes). */
let pluginCtx = null

const RESCAN_MS = 20_000
const WARMUP_ITERATIONS = 260
const GLOW_SCALE = 46

const FOLDER_COLORS = {
  Daily: [79, 195, 247],
  Decisions: [186, 104, 200],
  Projects: [129, 199, 132],
  Shared: [255, 183, 77],
  Root: [154, 164, 178]
}

function colorOf(folder) {
  return FOLDER_COLORS[folder] ?? FOLDER_COLORS.Root
}

function bridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop : undefined
}

function basename(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** Parse [[wikilinks]] out of markdown, skipping fenced and inline code. */
function wikilinksIn(text) {
  const cleaned = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')
  const out = []
  const re = /\[\[([^\]|#]+)/g
  let m
  while ((m = re.exec(cleaned)) !== null) {
    const target = m[1].trim()
    if (target) out.push(target)
  }
  return out
}

/** Walk the vault through the app bridge and build {nodes, links}. */
async function scanVault(vaultPath, previousMtimes) {
  const desktop = bridge()
  if (!desktop?.readDir || !desktop?.readFileText) return null

  const files = []
  const walk = async dir => {
    const result = await desktop.readDir(dir)
    const entries = (result && result.entries) || []
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (entry.name === '.obsidian' || entry.name === '.git' || entry.name === '.trash') continue
        await walk(entry.path)
        continue
      }
      if (!/\.md$/i.test(entry.name)) continue
      files.push(entry)
    }
  }
  await walk(vaultPath)
  if (!files.length) return { nodes: [], links: [], vault: vaultPath, scannedAt: Date.now() }

  const nodes = []
  const byId = new Map()
  const byLabel = new Map()
  const cheap = files.length > 250

  for (const file of files) {
    let read
    try {
      read = await desktop.readFileText(file.path)
    } catch {
      continue
    }
    const text = (read && read.text) || ''
    const rel = String(file.path).slice(String(vaultPath).length + 1)
    const id = rel.replace(/\\/g, '/').replace(/\.md$/i, '')
    const segments = id.split('/')
    const folder = segments.length > 1 ? segments[0] : 'Root'
    const label = segments[segments.length - 1]

    const node = {
      id,
      label,
      folder,
      mtime: previousMtimes[id] ?? 0,
      linkCount: 0,
      content: cheap ? '' : text.slice(0, 4000),
      targets: wikilinksIn(text)
    }
    nodes.push(node)
    byId.set(id.toLowerCase(), node)
    if (!byLabel.has(label.toLowerCase())) byLabel.set(label.toLowerCase(), node)
  }

  const links = []
  const seen = new Set()
  for (const node of nodes) {
    for (const raw of node.targets) {
      const key = raw.toLowerCase().replace(/\.md$/, '')
      const target = byId.get(key) || byLabel.get(key)
      if (!target || target.id === node.id) continue
      const sig = node.id + '->' + target.id
      if (seen.has(sig)) continue
      seen.add(sig)
      links.push({ source: node.id, target: target.id })
    }
  }

  const counts = new Map()
  for (const link of links) counts.set(link.source, (counts.get(link.source) || 0) + 1)
  for (const node of nodes) {
    node.linkCount = counts.get(node.id) || 0
    delete node.targets
  }

  // Recency: the bridge exposes no mtime, so known notes keep the timestamp
  // recorded at build time and anything new counts as newest (brightest).
  const now = Date.now() / 1000
  const times = nodes.map(n => (n.mtime > 0 ? n.mtime : now))
  const min = Math.min(...times)
  const max = Math.max(...times)
  const range = max - min || 1
  nodes.forEach((node, i) => {
    node.brightness = (times[i] - min) / range
  })

  return { nodes, links, vault: vaultPath, scannedAt: Date.now() }
}

function signatureOf(graph) {
  if (!graph) return ''
  const nodes = graph.nodes.map(n => n.id + ':' + n.linkCount).join('|')
  const links = graph.links.map(l => l.source + '>' + l.target).join('|')
  return nodes + '#' + links
}

function starRadius(node) {
  return 3.1 + node.linkCount * 1.6
}

/** 3D force-directed layout: repulsion between stars, springs on wikilinks. */
function layout(nodes, links) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const pos = nodes.map((_, i) => {
    const radius = 6 + 3 * Math.sqrt(i)
    const angle = i * golden
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(i * 1.7) * 2.2,
      z: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      vz: 0
    }
  })

  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = links
    .map(l => [index.get(l.source), index.get(l.target)])
    .filter(([a, b]) => a !== undefined && b !== undefined)

  const repulsion = 34
  const spring = 0.035
  const restLength = 9
  const gravity = 0.012
  const damping = 0.82

  for (let step = 0; step < WARMUP_ITERATIONS; step += 1) {
    for (let i = 0; i < pos.length; i += 1) {
      const a = pos[i]
      for (let j = i + 1; j < pos.length; j += 1) {
        const b = pos[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dz = a.z - b.z
        let d2 = dx * dx + dy * dy + dz * dz
        if (d2 < 0.01) {
          dx = (i - j) * 0.1 + 0.05
          dy = 0.05
          dz = 0.1
          d2 = dx * dx + dy * dy + dz * dz
        }
        const d = Math.sqrt(d2)
        const f = repulsion / d2
        const ux = (dx / d) * f
        const uy = (dy / d) * f
        const uz = (dz / d) * f
        a.vx += ux
        a.vy += uy
        a.vz += uz
        b.vx -= ux
        b.vy -= uy
        b.vz -= uz
      }
    }

    for (const [i, j] of edges) {
      const a = pos[i]
      const b = pos[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001
      const f = (d - restLength) * spring
      const ux = (dx / d) * f
      const uy = (dy / d) * f
      const uz = (dz / d) * f
      a.vx += ux
      a.vy += uy
      a.vz += uz
      b.vx -= ux
      b.vy -= uy
      b.vz -= uz
    }

    for (const p of pos) {
      p.vx -= p.x * gravity
      p.vy -= p.y * gravity
      p.vz -= p.z * gravity
      p.vx *= damping
      p.vy *= damping
      p.vz *= damping
      p.x += p.vx
      p.y += p.vy
      p.z += p.vz
    }
  }

  // Re-centre on the origin and scale to a readable sphere.
  const cx = pos.reduce((s, p) => s + p.x, 0) / (pos.length || 1)
  const cy = pos.reduce((s, p) => s + p.y, 0) / (pos.length || 1)
  const cz = pos.reduce((s, p) => s + p.z, 0) / (pos.length || 1)
  let extent = 0
  for (const p of pos) {
    p.x -= cx
    p.y -= cy
    p.z -= cz
    extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))
  }
  const scale = extent > 0 ? 16 / extent : 1
  return pos.map(p => ({ x: p.x * scale, y: p.y * scale, z: p.z * scale }))
}

function MemoryGalaxyPage() {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [graph, setGraph] = useState(null)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)
  const [hover, setHover] = useState(null)
  const [preview, setPreview] = useState(null)
  const [openState, setOpenState] = useState('idle') // idle | opening | opened | failed
  const [openMessage, setOpenMessage] = useState('')
  const [scannedAt, setScannedAt] = useState(null)
  const mtimesRef = useRef({})
  const signatureRef = useRef('')
  const stateRef = useRef({
    yaw: 0.6,
    pitch: -0.32,
    distance: 46,
    target: 46,
    dragging: false,
    lastX: 0,
    lastY: 0,
    pointer: { x: -1e5, y: -1e5, inside: false },
    hoverId: null,
    dragNode: -1,
    dragDepth: 0,
    dragMoved: 0,
    positions: []
  })

  const reload = useCallback(async () => {
    const vaultPath = FALLBACK_GRAPH.vault
    if (!vaultPath) {
      setError('No vault path recorded — run rebuild.sh to bake one in.')
      setStatus('error')
      return
    }

    // Seed recency from the build-time snapshot once, so notes keep their
    // relative ages even though the bridge exposes no mtime.
    if (!Object.keys(mtimesRef.current).length) {
      for (const node of FALLBACK_GRAPH.nodes || []) {
        if (node.mtime) mtimesRef.current[node.id] = node.mtime
      }
    }

    let next = null
    try {
      next = await scanVault(vaultPath, mtimesRef.current)
    } catch {
      next = null
    }

    if (!next || !next.nodes.length) {
      // Bridge missing (older shell) or vault unreadable: fall back to the
      // graph baked at build time so the pane still shows something.
      next = { ...FALLBACK_GRAPH, scannedAt: null }
    }

    for (const node of next.nodes) {
      if (node.mtime) mtimesRef.current[node.id] = node.mtime
    }

    const sig = signatureOf(next)
    setScannedAt(next.scannedAt ?? null)
    if (sig !== signatureRef.current) {
      signatureRef.current = sig
      setGraph(next)
    }
    setStatus('ready')
  }, [])

  useEffect(() => {
    reload()
    const timer = setInterval(reload, RESCAN_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reload])

  const nodes = graph ? graph.nodes : []
  const links = graph ? graph.links : []

  const positions = useMemo(() => (nodes.length ? layout(nodes, links) : []), [nodes, links])
  useEffect(() => {
    stateRef.current.positions = positions
  }, [positions])

  const adjacency = useMemo(() => {
    const map = new Map()
    for (const node of nodes) map.set(node.id, new Set())
    for (const link of links) {
      const a = map.get(link.source)
      const b = map.get(link.target)
      if (a) a.add(link.target)
      if (b) b.add(link.source)
    }
    return map
  }, [nodes, links])

  const obsidianUriFor = note => {
    const vaultRoot = String(FALLBACK_GRAPH.vault || '').replace(/[\/]+$/, '')
    return (
      'obsidian://open?vault=' + encodeURIComponent(basename(vaultRoot)) +
      '&file=' + encodeURIComponent(note.id)
    )
  }

  const openInObsidian = useCallback(async note => {
    if (!note) return

    const vaultRoot = String(FALLBACK_GRAPH.vault || '').replace(/[\/]+$/, '')
    setOpenState('opening')
    setOpenMessage('')

    // Preferred: the plugin backend runs on the machine Hermes runs on and
    // hands obsidian:// to the OS handler. The renderer's own external-open
    // route only allows http/https/mailto, so obsidian:// is refused there.
    if (!vaultRoot) {
      setOpenState('failed')
      setOpenMessage('No vault path recorded — run rebuild.sh.')
      return
    }

    try {
      const res = pluginCtx && pluginCtx.rest
        ? await pluginCtx.rest('/open', {
            method: 'POST',
            body: { vault: vaultRoot, path: vaultRoot + '/' + note.id + '.md' },
            timeoutMs: 15000
          })
        : null
      if (res && res.ok) {
        setOpenState('opened')
        return
      }
    } catch (err) {
      const detail = err && err.message ? err.message : String(err)
      setOpenState('failed')
      setOpenMessage(detail)
      console.warn('[memory-galaxy] backend open failed: ' + detail)
      return
    }

    // Fallback: a shell whose external-open route permits custom schemes.
    try {
      const desktop = bridge()
      if (desktop && typeof desktop.openExternal === 'function') {
        const opened = await desktop.openExternal(obsidianUriFor(note))
        if (opened) {
          setOpenState('opened')
          return
        }
      }
    } catch (err) {
      console.warn('[memory-galaxy] openExternal failed: ' + (err && err.message ? err.message : err))
    }

    setOpenState('failed')
    setOpenMessage('Obsidian did not accept the link.')
  }, [])

  const copyDeepLink = useCallback(async note => {
    const uri = obsidianUriFor(note)
    try {
      const ok = pluginCtx && pluginCtx.os && pluginCtx.os.writeClipboard
        ? await pluginCtx.os.writeClipboard(uri)
        : false
      setOpenState(ok ? 'opened' : 'failed')
      setOpenMessage(ok ? 'Deep link copied — paste it into Obsidian.' : uri)
    } catch {
      setOpenState('failed')
      setOpenMessage(uri)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !nodes.length) return undefined

    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return undefined

    const state = stateRef.current
    let raf = 0
    let disposed = false

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (!w || !h) return
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)

    const backdrop = []
    for (let i = 0; i < 300; i += 1) {
      backdrop.push({
        x: (Math.sin(i * 12.9898) * 43758.5453) % 1,
        y: (Math.sin(i * 78.233) * 12345.6789) % 1,
        r: 0.4 + ((i * 37) % 11) / 11
      })
    }

    const project = (point, w, h) => {
      if (!point) return null
      const cosY = Math.cos(state.yaw)
      const sinY = Math.sin(state.yaw)
      const cosP = Math.cos(state.pitch)
      const sinP = Math.sin(state.pitch)
      const x1 = point.x * cosY - point.z * sinY
      const z1 = point.x * sinY + point.z * cosY
      const y2 = point.y * cosP - z1 * sinP
      const z2 = point.y * sinP + z1 * cosP + state.distance
      if (z2 <= 0.6) return null
      const f = Math.min(w, h) * 0.9
      return { x: w / 2 + (x1 * f) / z2, y: h / 2 + (y2 * f) / z2, depth: z2 }
    }

    /** Latest projection of every node, shared with the pointer handlers. */
    const screenView = []

    const draw = () => {
      if (disposed) return
      raf = requestAnimationFrame(draw)

      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (!w || !h) return

      if (!state.dragging) state.yaw += 0.0014
      state.distance += (state.target - state.distance) * 0.12

      ctx2d.fillStyle = '#04060d'
      ctx2d.fillRect(0, 0, w, h)

      for (const star of backdrop) {
        const sx = ((star.x + 1) % 1) * w
        const sy = ((star.y + 1) % 1) * h
        ctx2d.globalAlpha = 0.16 + star.r * 0.28
        ctx2d.fillStyle = '#9fb0c8'
        ctx2d.fillRect(sx, sy, star.r * 0.8, star.r * 0.8)
      }
      ctx2d.globalAlpha = 1

      const points = state.positions
      screenView.length = 0
      for (let i = 0; i < nodes.length; i += 1) screenView.push(project(points[i], w, h))
      const screen = screenView
      const indexOf = new Map(nodes.map((node, i) => [node.id, i]))
      const hoveredId = state.hoverId
      const neighbours = hoveredId ? adjacency.get(hoveredId) : null

      for (const link of links) {
        const a = indexOf.get(link.source)
        const b = indexOf.get(link.target)
        if (a === undefined || b === undefined) continue
        const pa = screen[a]
        const pb = screen[b]
        if (!pa || !pb) continue
        const touches = hoveredId && (link.source === hoveredId || link.target === hoveredId)
        const base = Math.max(0.04, Math.min(0.34, 24 / (pa.depth + pb.depth)))
        if (hoveredId && !touches) {
          ctx2d.strokeStyle = 'rgba(70,95,130,' + base * 0.35 + ')'
        } else if (touches) {
          ctx2d.strokeStyle = 'rgba(190,215,245,0.9)'
        } else {
          ctx2d.strokeStyle = 'rgba(90,125,168,' + base + ')'
        }
        ctx2d.lineWidth = touches ? 1.6 : 1
        ctx2d.beginPath()
        ctx2d.moveTo(pa.x, pa.y)
        ctx2d.lineTo(pb.x, pb.y)
        ctx2d.stroke()
      }

      const order = nodes.map((node, i) => ({ node, i, p: screen[i] })).filter(o => o.p)
      order.sort((a, b) => b.p.depth - a.p.depth)
      let candidate = null

      for (const item of order) {
        const node = item.node
        const p = item.p
        const rgb = colorOf(node.folder)
        const r = rgb[0]
        const g = rgb[1]
        const bl = rgb[2]
        const brightness = 0.45 + (node.brightness ?? 0.5) * 0.55
        const scale = Math.min(2.8, GLOW_SCALE / p.depth)
        const radius = starRadius(node) * scale
        const isHovered = hoveredId === node.id
        const isNeighbour = neighbours ? neighbours.has(node.id) : false
        const dim = hoveredId && !isHovered && !isNeighbour
        const alpha = Math.min(1, brightness * (0.5 + scale * 0.35)) * (dim ? 0.22 : 1)

        const glow = ctx2d.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 3.2)
        glow.addColorStop(0, 'rgba(255,255,255,' + Math.min(1, alpha) + ')')
        glow.addColorStop(0.22, 'rgba(' + r + ',' + g + ',' + bl + ',' + alpha * 0.85 + ')')
        glow.addColorStop(0.6, 'rgba(' + r + ',' + g + ',' + bl + ',' + alpha * 0.18 + ')')
        glow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx2d.fillStyle = glow
        ctx2d.beginPath()
        ctx2d.arc(p.x, p.y, radius * 3.2, 0, Math.PI * 2)
        ctx2d.fill()

        ctx2d.fillStyle = 'rgba(255,255,255,' + Math.min(1, alpha + 0.25) + ')'
        ctx2d.beginPath()
        ctx2d.arc(p.x, p.y, Math.max(1.1, radius * 0.5), 0, Math.PI * 2)
        ctx2d.fill()

        if (isHovered) {
          ctx2d.strokeStyle = 'rgba(255,255,255,0.5)'
          ctx2d.lineWidth = 1
          ctx2d.beginPath()
          ctx2d.arc(p.x, p.y, radius * 3.2, 0, Math.PI * 2)
          ctx2d.stroke()
        }

        if (isHovered || isNeighbour) {
          ctx2d.font = isHovered
            ? '600 12px ui-sans-serif, system-ui, sans-serif'
            : '11px ui-sans-serif, system-ui, sans-serif'
          ctx2d.fillStyle = isHovered ? 'rgba(236,244,255,0.95)' : 'rgba(200,215,235,0.7)'
          ctx2d.textAlign = 'center'
          ctx2d.fillText(node.label, p.x, p.y - radius * 3.2 - 6)
        }

        if (state.pointer.inside) {
          const dx = state.pointer.x - p.x
          const dy = state.pointer.y - p.y
          const hit = radius * 3.2
          if (dx * dx + dy * dy <= hit * hit) {
            if (!candidate || p.depth < candidate.p.depth) candidate = item
          }
        }
      }

      const nextHoverId = candidate ? candidate.node.id : null
      if (nextHoverId !== state.hoverId) {
        state.hoverId = nextHoverId
        setHover(candidate ? candidate.node : null)
        canvas.style.cursor = candidate ? 'pointer' : 'grab'
      }
    }
    draw()

    // Camera basis, so a screen-space drag can move a star in the plane at its
    // own depth (both vectors are perpendicular to the view axis, so depth and
    // therefore apparent size stay put while you drag).
    const basis = () => {
      const cosY = Math.cos(state.yaw)
      const sinY = Math.sin(state.yaw)
      const cosP = Math.cos(state.pitch)
      const sinP = Math.sin(state.pitch)
      return {
        right: { x: cosY, y: 0, z: -sinY },
        up: { x: -sinY * sinP, y: cosP, z: -cosY * sinP }
      }
    }

    const onPointerDown = event => {
      state.lastX = event.clientX
      state.lastY = event.clientY
      state.dragMoved = 0

      // Grab the star under the cursor; otherwise orbit the camera.
      if (state.hoverId) {
        const index = nodes.findIndex(n => n.id === state.hoverId)
        const p = index >= 0 ? screenView[index] : null
        if (p) {
          state.dragging = true
          state.dragNode = index
          state.dragDepth = p.depth
          canvas.style.cursor = 'grabbing'
          return
        }
      }

      state.dragging = true
      state.dragNode = -1
    }

    const onPointerUp = () => {
      const wasNode = state.dragNode >= 0
      const moved = state.dragMoved
      state.dragging = false
      state.dragNode = -1
      canvas.style.cursor = state.hoverId ? 'pointer' : 'grab'

      // A press that barely moved is a click: open the note's preview.
      if (wasNode && moved < 4) {
        const node = nodes.find(n => n.id === state.hoverId)
        if (node) {
          setOpenState('idle')
          setOpenMessage('')
          setPreview(node)
        }
      }
    }

    const onPointerMove = event => {
      const rect = canvas.getBoundingClientRect()
      state.pointer.x = event.clientX - rect.left
      state.pointer.y = event.clientY - rect.top
      state.pointer.inside = true

      if (!state.dragging) return

      const dx = event.clientX - state.lastX
      const dy = event.clientY - state.lastY
      state.lastX = event.clientX
      state.lastY = event.clientY
      state.dragMoved += Math.abs(dx) + Math.abs(dy)

      if (state.dragNode >= 0) {
        const point = state.positions[state.dragNode]
        const projected = screenView[state.dragNode]
        if (point && projected) {
          const f = Math.min(wrap.clientWidth, wrap.clientHeight) * 0.9
          const scale = projected.depth / f
          const { right, up } = basis()
          // Canvas Y grows downward and the projection adds +y2*f/z2 to the
          // centre, so a downward drag is a POSITIVE step along `up`.
          point.x += (right.x * dx + up.x * dy) * scale
          point.y += (right.y * dx + up.y * dy) * scale
          point.z += (right.z * dx + up.z * dy) * scale
        }
        return
      }

      state.yaw += dx * 0.006
      state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch + dy * 0.005))
    }
    const onPointerLeave = () => {
      state.pointer.inside = false
      state.dragging = false
      state.dragNode = -1
    }
    const onWheel = event => {
      event.preventDefault()
      state.target = Math.max(16, Math.min(150, state.target + event.deltaY * 0.05))
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [nodes, links, adjacency])

  useEffect(() => {
    if (!preview) return undefined
    const onKey = event => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const stamp = scannedAt ? new Date(scannedAt).toLocaleTimeString() : 'snapshot'

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col bg-(--ui-bg-primary)">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--ui-stroke-secondary) px-3 py-1.5 text-xs">
        <span className="flex items-center gap-2 font-medium text-(--ui-text-secondary)">
          Memory Galaxy
          <span className="rounded bg-(--chrome-action-hover) px-1.5 py-0.5 font-normal">
            {hover ? hover.label : basename(FALLBACK_GRAPH.vault) || 'vault'}
          </span>
        </span>
        <span className="flex items-center gap-3 text-(--ui-text-tertiary)">
          <span>
            {nodes.length} notes · {links.length} links
          </span>
          <span>scan {stamp}</span>
          <button
            type="button"
            onClick={reload}
            style={{
              border: 0,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 11,
              textDecoration: 'underline'
            }}
          >
            rescan
          </button>
        </span>
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0" />

        <div className="pointer-events-none absolute bottom-2 left-3 flex flex-col gap-1 text-[11px] text-(--ui-text-tertiary)">
          {Object.keys(FOLDER_COLORS).map(folder => (
            <span key={folder} className="flex items-center gap-1.5">
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 9999,
                  background: 'rgb(' + colorOf(folder).join(',') + ')'
                }}
              />
              {folder}
            </span>
          ))}
          <span className="mt-1 opacity-70">
            {status === 'ready'
              ? 'click a star → preview · the button opens it in Obsidian'
              : 'scanning…'}
          </span>
        </div>

        {error ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#8fa3bd',
              fontSize: 12,
              padding: 24,
              textAlign: 'center'
            }}
          >
            {error}
          </div>
        ) : null}

        {preview ? (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(520px, 86%)',
              maxHeight: '72%',
              overflowY: 'auto',
              background: 'rgba(8,10,18,0.96)',
              border: '1px solid rgba(120,150,190,0.35)',
              borderRadius: 10,
              padding: 18,
              color: '#dbe4f0',
              zIndex: 30
            }}
          >
            <div className="mb-1 flex items-start justify-between gap-3">
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{preview.label}</div>
                <div style={{ fontSize: 11, color: '#8fa3bd', marginTop: 2 }}>
                  {preview.folder} · {preview.linkCount} links
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: '#8fa3bd',
                  cursor: 'pointer',
                  fontSize: 18,
                  lineHeight: 1
                }}
              >
                ×
              </button>
            </div>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11.5,
                lineHeight: 1.55,
                margin: 0,
                color: '#c8d4e4'
              }}
            >
              {preview.content || '(no text captured)'}
            </pre>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => openInObsidian(preview)}
                disabled={openState === 'opening'}
                style={{
                  border: '1px solid rgba(120,150,190,0.4)',
                  background: openState === 'opened' ? 'rgba(56,140,95,0.25)' : 'transparent',
                  color: '#dbe4f0',
                  cursor: openState === 'opening' ? 'progress' : 'pointer',
                  padding: '4px 10px',
                  borderRadius: 6,
                  fontSize: 12
                }}
              >
                {openState === 'opening'
                  ? 'Opening…'
                  : openState === 'opened'
                    ? 'Opened in Obsidian ✓'
                    : 'Open in Obsidian ↗'}
              </button>
              <button
                type="button"
                onClick={() => copyDeepLink(preview)}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: '#8fa3bd',
                  cursor: 'pointer',
                  padding: '4px 2px',
                  fontSize: 11,
                  textDecoration: 'underline'
                }}
              >
                copy link
              </button>
              {openState === 'failed' ? (
                <span style={{ fontSize: 11, color: '#e8a0a0' }}>
                  {openMessage || 'could not open Obsidian'}
                </span>
              ) : null}
              {openState === 'opened' && openMessage ? (
                <span style={{ fontSize: 11, color: '#8fd6a8' }}>{openMessage}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default {
  id: ID,
  name: 'Memory Galaxy',
  description: 'Live force-directed star map of the Obsidian vault: notes as stars, wikilinks as lines.',
  register(ctx) {
    pluginCtx = ctx

    ctx.register({
      id: 'route',
      area: ROUTES_AREA,
      data: { path: ROUTE },
      render: () => <MemoryGalaxyPage />
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: ROUTE, label: 'Memory Galaxy', codicon: 'star' }
    })
  }
}
