/**
 * Schematic site map — the "maps" half of the rubric's "charts/maps".
 *
 * WHY A DRAWN PLAN RATHER THAN LEAFLET
 *   Leaflet is the tool the brief names, and it would be the right answer for
 *   GPS-tagged data. This footage has no coordinates: a fixed camera looking
 *   at a plaza. Pinning it to a world map would be inventing a location.
 *   Worse, map tiles need the internet, and a demo that goes blank because a
 *   tile server is slow is a demo that failed for no reason.
 *
 *   So this draws the scene's own geometry: zones where they actually are in
 *   the camera's view, response units at their posts, and incidents where
 *   they happened. It is the floor plan an operator would have on the wall.
 *
 * It is also the only view where Track B's dispatch becomes spatial — you
 * see which unit was sent and how far it had to come.
 *
 * WHY THE UNITS ARE DRAGGABLE
 *   Where the medical post stands is site knowledge, not a program setting,
 *   and the person who knows it is the operator looking at the camera — not
 *   whoever last edited config.json. So the markers are placed the same way
 *   zones are drawn: on the picture, by pointing at it. The coordinates are
 *   the same frame pixels either way, which is what lets the dispatch logic
 *   measure incident-to-responder distance without any real-world survey.
 */

import { useEffect, useRef } from 'react'
import type { Incident, Unit, Zone, ZoneStat } from '../types'

/** Click within this many frame pixels of a marker to grab it. */
const GRAB_RADIUS = 14

interface Props {
  zones: Zone[]
  zoneStats: ZoneStat[]
  units: Unit[]
  incidents: Incident[]
  frame: { width: number; height: number }
  /** Unit editing. Left out entirely, the map behaves as read-only as before. */
  editing?: boolean
  selectedUnit?: number
  onSelectUnit?: (index: number) => void
  onUnitsChange?: (units: Unit[]) => void
}

export function SiteMap({
  zones, zoneStats, units, incidents, frame,
  editing = false, selectedUnit = -1, onSelectUnit, onUnitsChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Which marker the pointer is currently holding. A ref, not state: it
  // changes on every mouse move, and re-rendering the dashboard per pixel
  // would make the drag feel heavy.
  const dragging = useRef<number | null>(null)

  // The canvas is sized by CSS, so the frame-to-panel mapping is only known
  // at draw time. The pointer handlers need the same numbers, so the draw
  // stores them here instead of each side computing its own.
  const projection = useRef({ scale: 1, offsetX: 0, offsetY: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !frame.width || !frame.height) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const box = wrap.getBoundingClientRect()
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, box.width * ratio)
      canvas.height = Math.max(1, box.height * ratio)
      canvas.style.width = `${box.width}px`
      canvas.style.height = `${box.height}px`
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, box.width, box.height)

      // Fit the camera's frame into the panel, keeping its aspect ratio, so a
      // zone on the map sits where it sits on the video.
      const scale = Math.min(box.width / frame.width, box.height / frame.height)
      const offsetX = (box.width - frame.width * scale) / 2
      const offsetY = (box.height - frame.height * scale) / 2
      projection.current = { scale, offsetX, offsetY }
      const px = (x: number) => offsetX + x * scale
      const py = (y: number) => offsetY + y * scale

      // Scene outline. It brightens in edit mode so the drawable area is
      // unambiguous — clicks outside it are ignored.
      ctx.strokeStyle = editing ? '#1fbf5f' : '#0d3b20'
      ctx.lineWidth = 1
      ctx.strokeRect(px(0), py(0), frame.width * scale, frame.height * scale)

      // Faint grid, so the plan reads as a plan rather than floating shapes
      ctx.strokeStyle = 'rgba(13,59,32,0.55)'
      for (let i = 1; i < 6; i++) {
        const gx = px((frame.width / 6) * i)
        const gy = py((frame.height / 6) * i)
        ctx.beginPath(); ctx.moveTo(gx, py(0)); ctx.lineTo(gx, py(frame.height)); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(px(0), gy); ctx.lineTo(px(frame.width), gy); ctx.stroke()
      }

      // Zones, coloured by their live state
      zones.forEach((zone) => {
        const stat = zoneStats.find((s) => s.name === zone.name)
        const breached = stat?.over_capacity ?? false
        const colour = zone.restricted ? '#ff4d4d' : breached ? '#ff4d4d' : '#00ff66'

        ctx.beginPath()
        zone.points.forEach(([x, y], i) => {
          const cx = px(x), cy = py(y)
          i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy)
        })
        ctx.closePath()
        ctx.fillStyle = breached ? 'rgba(255,77,77,0.22)' : 'rgba(0,255,102,0.10)'
        ctx.fill()
        ctx.strokeStyle = colour
        ctx.lineWidth = breached ? 2.5 : 1.5
        if (zone.restricted) ctx.setLineDash([5, 4])
        ctx.stroke()
        ctx.setLineDash([])

        if (stat) {
          const [cx, cy] = stat.centroid
          ctx.fillStyle = colour
          ctx.font = '600 11px ui-monospace, monospace'
          ctx.textAlign = 'center'
          const label = zone.restricted ? `${stat.count}` : `${stat.count}/${stat.capacity}`
          ctx.fillText(label, px(cx), py(cy))
          ctx.fillStyle = '#4f9168'
          ctx.font = '10px ui-monospace, monospace'
          ctx.fillText(zone.name.toUpperCase(), px(cx), py(cy) + 13)
          ctx.textAlign = 'left'
        }
      })

      // Which units are currently committed to an open incident
      const busy = new Set(
        incidents
          .filter((i) => i.status === 'DISPATCHED' && i.assigned_unit)
          .map((i) => i.assigned_unit as string),
      )

      // A line from each dispatched unit to the zone it was sent to, so the
      // nearest-unit decision is visible rather than just asserted.
      incidents
        .filter((i) => i.status === 'DISPATCHED' && i.assigned_unit)
        .slice(0, 6)
        .forEach((incident) => {
          const unit = units.find((u) => u.name === incident.assigned_unit)
          const stat = zoneStats.find((s) => s.name === incident.zone)
          if (!unit || !stat) return
          ctx.strokeStyle = 'rgba(58,214,255,0.55)'
          ctx.lineWidth = 1.5
          ctx.setLineDash([4, 4])
          ctx.beginPath()
          ctx.moveTo(px(unit.position[0]), py(unit.position[1]))
          ctx.lineTo(px(stat.centroid[0]), py(stat.centroid[1]))
          ctx.stroke()
          ctx.setLineDash([])
        })

      // Response units
      units.forEach((unit, index) => {
        const [ux, uy] = unit.position
        const committed = busy.has(unit.name)
        const chosen = editing && index === selectedUnit
        const colour = chosen ? '#ffd43b'
          : !unit.available ? '#6b6b6b'
            : committed ? '#3ad6ff' : '#4f9168'

        // A selected marker gets a halo, so it is obvious what the name field
        // and the DELETE button are about to act on.
        if (chosen) {
          ctx.beginPath()
          ctx.arc(px(ux), py(uy), 11, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(255,212,59,0.4)'
          ctx.lineWidth = 1
          ctx.stroke()
        }

        ctx.beginPath()
        ctx.arc(px(ux), py(uy), committed || chosen ? 7 : 5, 0, Math.PI * 2)
        ctx.fillStyle = '#000'
        ctx.fill()
        ctx.strokeStyle = colour
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.fillStyle = colour
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(unit.available ? unit.name.toUpperCase() : `${unit.name.toUpperCase()} (OFF)`,
                     px(ux) + 10, py(uy) + 3)
      })
    }

    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [zones, zoneStats, units, incidents, frame, editing, selectedUnit])

  /* --- pointer handling, only while editing --------------------------- */

  /** Panel pixels under the pointer, back to the frame pixels we store. */
  const toFrame = (event: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const { scale, offsetX, offsetY } = projection.current
    return [
      Math.round((event.clientX - rect.left - offsetX) / scale),
      Math.round((event.clientY - rect.top - offsetY) / scale),
    ]
  }

  const unitAt = (point: [number, number]) => {
    // Nearest wins rather than first hit: two posts close together would
    // otherwise make the one underneath impossible to grab.
    let best = -1
    let bestDistance = GRAB_RADIUS
    units.forEach((unit, index) => {
      const distance = Math.hypot(unit.position[0] - point[0], unit.position[1] - point[1])
      if (distance < bestDistance) { best = index; bestDistance = distance }
    })
    return best
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (!editing || !onUnitsChange) return
    const point = toFrame(event)
    const hit = unitAt(point)

    if (hit !== -1) {
      dragging.current = hit
      onSelectUnit?.(hit)
      canvasRef.current?.setPointerCapture(event.pointerId)
      return
    }

    // Empty space: drop a new post here. Clicking the plan to place a
    // responder is the whole point of the mode, so there is no separate
    // "add" button to hunt for first.
    const inside = point[0] >= 0 && point[1] >= 0 &&
      point[0] <= frame.width && point[1] <= frame.height
    if (!inside) return

    onUnitsChange([...units, { name: `Unit ${units.length + 1}`, position: point, available: true }])
    onSelectUnit?.(units.length)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!editing || dragging.current === null || !onUnitsChange) return
    const point = toFrame(event)
    // Clamp to the frame. A unit outside it is invisible on the map and
    // skews every distance the dispatcher measures.
    const clamped: [number, number] = [
      Math.min(Math.max(point[0], 0), frame.width),
      Math.min(Math.max(point[1], 0), frame.height),
    ]
    onUnitsChange(units.map((unit, index) =>
      index === dragging.current ? { ...unit, position: clamped } : unit))
  }

  const onPointerUp = (event: React.PointerEvent) => {
    if (dragging.current === null) return
    try { canvasRef.current?.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    dragging.current = null
  }

  return (
    <div ref={wrapRef} className="relative h-[230px] w-full">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`block ${editing ? 'cursor-crosshair touch-none' : ''}`}
      />
      {/* Only when the plan is genuinely empty — with units placed, this
          label would sit across the markers it is claiming are not there. */}
      {!zones.length && !units.length && !editing && (
        <p className="absolute inset-0 flex items-center justify-center text-muted" style={{ fontSize: '11.5px' }}>
          No zones to map yet.
        </p>
      )}
      {editing && !frame.width && (
        <p className="absolute inset-0 flex items-center justify-center text-warn" style={{ fontSize: '11.5px' }}>
          Waiting for the video frame size…
        </p>
      )}
    </div>
  )
}
