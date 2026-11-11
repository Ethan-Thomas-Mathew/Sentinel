/**
 * The live video, its overlays, and the zone editor drawn on top of it.
 *
 * THE DESIGN DECISION WORTH DEFENDING
 *   There is no "circle zone" or "rectangle zone" anywhere in the backend.
 *   Every tool here produces the same thing — an ordered list of points —
 *   because a camera flattens 3D space by perspective projection, so a
 *   rectangular patch of floor appears on screen as a trapezoid. A polygon is
 *   the only shape that can follow real ground. Circle, rectangle and square
 *   are drawing conveniences, converted to polygons before they are saved,
 *   and a circle is stored as a 32-sided one. The rules engine therefore only
 *   ever deals with one kind of geometry.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { Tool, Zone, ZoneStat } from '../types'

const CIRCLE_POINTS = 32

interface Props {
  editing: boolean
  tool: Tool
  zones: Zone[]
  zoneStats: ZoneStat[]
  selected: number
  paused: boolean
  onSelect: (index: number) => void
  onZonesChange: (zones: Zone[]) => void
  onShapeDrawn: (points: [number, number][]) => void
  onEditDetails: () => void
  onDeleteSelected: () => void
  onFrameSize: (size: { width: number; height: number }) => void
}

export function VideoStage({
  editing, tool, zones, zoneStats, selected, paused,
  onSelect, onZonesChange, onShapeDrawn, onEditDetails, onDeleteSelected, onFrameSize,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Draft state lives in refs: it changes on every mouse move, and routing
  // that through React state would re-render the whole dashboard per pixel.
  const draft = useRef<[number, number][]>([])
  const dragStart = useRef<[number, number] | null>(null)
  const dragNow = useRef<[number, number] | null>(null)
  const dragVertex = useRef<{ zone: number; index: number } | null>(null)

  /* --- coordinate conversion ------------------------------------------
     You click on a picture the browser has scaled to fit the window, but
     zones are stored in the frame's own pixels, or they would move whenever
     the window was resized. */
  const frameScale = useCallback(() => {
    const img = imgRef.current
    if (!img?.naturalWidth || !img.clientWidth) return 1
    return img.naturalWidth / img.clientWidth
  }, [])

  const toFrame = useCallback((x: number, y: number): [number, number] => {
    const s = frameScale()
    const img = imgRef.current
    const fx = Math.round(x * s)
    const fy = Math.round(y * s)
    if (!img?.naturalWidth) return [fx, fy]
    // Clamp to the picture. The canvas can be laid out slightly larger than
    // the image inside it, and a point outside the frame is nonsense anyway:
    // nobody is ever detected there, so the zone would silently under-count,
    // and on the site map it draws outside the scene outline and looks broken.
    const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi)
    return [clamp(fx, img.naturalWidth), clamp(fy, img.naturalHeight)]
  }, [frameScale])

  const toCanvas = useCallback((x: number, y: number): [number, number] => {
    const s = frameScale()
    return [x / s, y / s]
  }, [frameScale])

  /* --- drawing --------------------------------------------------------- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !editing) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, img.clientWidth * ratio)
    canvas.height = Math.max(1, img.clientHeight * ratio)
    canvas.style.width = `${img.clientWidth}px`
    canvas.style.height = `${img.clientHeight}px`
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, img.clientWidth, img.clientHeight)

    const polygon = (points: [number, number][], stroke: string, fill: string, handles: boolean) => {
      if (points.length < 2) return
      ctx.beginPath()
      points.forEach(([x, y], i) => {
        const [cx, cy] = toCanvas(x, y)
        i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy)
      })
      ctx.closePath()
      ctx.fillStyle = fill; ctx.fill()
      ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke()
      if (handles) {
        points.forEach(([x, y]) => {
          const [cx, cy] = toCanvas(x, y)
          ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2)
          ctx.fillStyle = '#000'; ctx.fill()
          ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke()
        })
      }
    }

    zones.forEach((zone, i) => {
      const isSelected = i === selected
      const colour = zone.restricted ? '#ff4d4d' : isSelected ? '#00ff66' : '#1fbf5f'
      polygon(zone.points, colour,
        zone.restricted ? 'rgba(255,77,77,0.14)'
          : isSelected ? 'rgba(0,255,102,0.16)' : 'rgba(0,255,102,0.08)',
        isSelected)

      const [lx, ly] = toCanvas(zone.points[0][0], zone.points[0][1])
      ctx.font = '600 13px ui-monospace, monospace'
      const label = zone.restricted ? `${zone.name} // RESTRICTED` : `${zone.name} // max ${zone.capacity}`
      const width = ctx.measureText(label).width
      ctx.fillStyle = '#000'; ctx.fillRect(lx, ly - 20, width + 10, 18)
      ctx.fillStyle = colour; ctx.fillText(label, lx + 5, ly - 7)
    })

    if (tool === 'polygon' && draft.current.length) {
      polygon(draft.current, '#ffd43b', 'rgba(255,212,59,0.12)', true)
    }
    if (dragStart.current && dragNow.current) {
      const points = tool === 'circle'
        ? circlePoints(dragStart.current, dragNow.current)
        : rectanglePoints(dragStart.current, dragNow.current, tool === 'square')
      polygon(points, '#ffd43b', 'rgba(255,212,59,0.12)', false)
    }
  }, [editing, zones, selected, tool, toCanvas])

  useEffect(() => { draw() }, [draw])

  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  const reportSize = useCallback(() => {
    const img = imgRef.current
    if (img?.naturalWidth) {
      onFrameSize({ width: img.naturalWidth, height: img.naturalHeight })
    }
    draw()
  }, [onFrameSize, draw])

  // The MJPEG stream never fires a normal 'load', so poll until the browser
  // reports the frame's real dimensions.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (imgRef.current?.naturalWidth) { reportSize(); window.clearInterval(timer) }
    }, 400)
    return () => window.clearInterval(timer)
  }, [reportSize])

  /* --- hit testing ----------------------------------------------------- */
  const vertexAt = (point: [number, number]) => {
    const tolerance = 9 * frameScale()
    for (let z = 0; z < zones.length; z++) {
      const points = zones[z].points
      for (let p = 0; p < points.length; p++) {
        if (Math.hypot(points[p][0] - point[0], points[p][1] - point[1]) < tolerance) {
          return { zone: z, index: p }
        }
      }
    }
    return null
  }

  const zoneAt = (point: [number, number]) => {
    // Ray casting — the same idea as OpenCV's pointPolygonTest, which
    // zones.py uses on the backend.
    for (let z = zones.length - 1; z >= 0; z--) {
      const points = zones[z].points
      let inside = false
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i]
        const [xj, yj] = points[j]
        if ((yi > point[1]) !== (yj > point[1]) &&
            point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-9) + xi) {
          inside = !inside
        }
      }
      if (inside) return z
    }
    return -1
  }

  const localPoint = (event: React.PointerEvent | React.MouseEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return toFrame(event.clientX - rect.left, event.clientY - rect.top)
  }

  /* --- interaction ----------------------------------------------------- */
  const onPointerDown = (event: React.PointerEvent) => {
    if (!editing) return
    const point = localPoint(event)

    const hit = vertexAt(point)
    if (hit) {
      dragVertex.current = hit
      onSelect(hit.zone)
      canvasRef.current?.setPointerCapture(event.pointerId)
      return
    }

    if (tool === 'polygon') {
      if (!draft.current.length) {
        const existing = zoneAt(point)
        if (existing !== -1) { onSelect(existing); return }
      }
      draft.current.push(point)
      draw()
    } else {
      dragStart.current = point
      dragNow.current = point
      canvasRef.current?.setPointerCapture(event.pointerId)
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!editing) return
    const point = localPoint(event)
    if (dragVertex.current) {
      const next = zones.map((zone, z) =>
        z === dragVertex.current!.zone
          ? { ...zone, points: zone.points.map((p, i) => (i === dragVertex.current!.index ? point : p)) }
          : zone)
      onZonesChange(next)
    } else if (dragStart.current) {
      dragNow.current = point
      draw()
    }
  }

  const onPointerUp = (event: React.PointerEvent) => {
    if (!editing) return
    try { canvasRef.current?.releasePointerCapture(event.pointerId) } catch { /* already released */ }

    if (dragVertex.current) { dragVertex.current = null; return }

    if (dragStart.current && dragNow.current) {
      const a = dragStart.current
      const b = dragNow.current
      const far = Math.hypot(b[0] - a[0], b[1] - a[1]) > 12
      dragStart.current = null
      dragNow.current = null
      if (far) {
        onShapeDrawn(tool === 'circle' ? circlePoints(a, b) : rectanglePoints(a, b, tool === 'square'))
      }
      draw()
    }
  }

  const onDoubleClick = (event: React.MouseEvent) => {
    if (!editing) return
    if (!draft.current.length) {
      const hit = zoneAt(localPoint(event))
      if (hit !== -1) { onSelect(hit); onEditDetails(); return }
    }
    closeDraft()
  }

  const closeDraft = () => {
    if (draft.current.length >= 3) onShapeDrawn([...draft.current])
    draft.current = []
    draw()
  }

  // Enter closes the shape being drawn; Escape abandons it; Delete removes
  // the selected zone, which is what anyone who has used a drawing tool
  // reaches for before they look for a button.
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'Enter') closeDraft()
      if (e.key === 'Escape') { draft.current = []; draw() }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0 && !draft.current.length) {
        e.preventDefault()
        onDeleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const breached = zoneStats.filter((z) => z.over_capacity)
  const worst = breached.length
    ? breached.reduce((a, b) => (b.count - b.capacity > a.count - a.capacity ? b : a))
    : null

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-transparent">
      {paused && (
        <div className="pointer-events-none absolute left-2.5 top-2.5 z-6 rounded-sm border border-warn
                        bg-black/70 px-2.5 py-1 tracking-[0.1em] text-warn" style={{ fontSize: '11.5px' }}>
          ❚❚ PAUSED — PRESS PLAY
        </div>
      )}

      <div className="relative inline-block h-full max-w-full">
        <img ref={imgRef} src="/video.mjpg" alt="Live annotated camera feed"
             onLoad={reportSize}
             className="block h-auto max-h-full w-auto max-w-full" />
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          className={`absolute inset-0 h-full w-full ${editing ? 'block cursor-crosshair' : 'hidden'}`}
        />
      </div>

      {/* Breach banner. It sits along the BOTTOM because the video carries a
          burned-in telemetry strip across its top edge, and a banner there
          would cover the very numbers you want on camera. */}
      <div
        role="alert"
        aria-live="assertive"
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-5 flex items-center gap-3 bg-crit
                    px-4.5 py-2.5 font-bold tracking-[0.04em] text-[#190000] transition-transform duration-300
                    ${worst ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ fontSize: '15px' }}
      >
        {worst && (
          <>
            <span className="rounded-sm bg-black/25 px-2">
              {worst.restricted ? worst.count : `${worst.count}/${worst.capacity}`}
            </span>
            <span>
              {worst.restricted ? `INTRUSION — ${worst.name}`
                : breached.length === 1 ? `${worst.name} OVER CAPACITY`
                : `${breached.length} ZONES BREACHED — WORST ${worst.name}`}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

/* --- shape builders ---------------------------------------------------- */

function rectanglePoints(a: [number, number], b: [number, number], square: boolean): [number, number][] {
  let [x1, y1] = a
  let [x2, y2] = b
  if (square) {
    const side = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))
    x2 = x1 + Math.sign(x2 - x1 || 1) * side
    y2 = y1 + Math.sign(y2 - y1 || 1) * side
  }
  return ([[x1, y1], [x2, y1], [x2, y2], [x1, y2]] as [number, number][])
    .map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number])
}

function circlePoints(centre: [number, number], edge: [number, number]): [number, number][] {
  const [cx, cy] = centre
  const radius = Math.hypot(edge[0] - cx, edge[1] - cy)
  return Array.from({ length: CIRCLE_POINTS }, (_, i) => {
    const angle = (i / CIRCLE_POINTS) * Math.PI * 2
    return [Math.round(cx + radius * Math.cos(angle)), Math.round(cy + radius * Math.sin(angle))] as [number, number]
  })
}
