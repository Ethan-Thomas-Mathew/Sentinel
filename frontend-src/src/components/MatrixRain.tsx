/**
 * Digital rain, behind everything and never on top of data.
 *
 * Two things keep it cheap enough to run next to a CPU detector:
 *
 *   1. It paints at about 24fps rather than the display refresh rate.
 *      Matrix rain is meant to step, so a lower paint rate looks *more*
 *      right, not less — and it costs a fraction as much.
 *   2. The number of columns scales with the detector's measured frame rate.
 *      When YOLO is struggling, the rain quietly thins out and hands the CPU
 *      back. That is a resource-contention decision, not a visual one.
 */

import { useEffect, useRef } from 'react'

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=<>/\\|'
const FONT_SIZE = 16
const PAINT_INTERVAL = 1000 / 24

export function MatrixRain({ detectorFps }: { detectorFps: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Held in a ref, not state: the animation loop reads it every frame and
  // re-rendering React 24 times a second to change a number would be absurd.
  const fpsRef = useRef(detectorFps)
  fpsRef.current = detectorFps

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let columns = 0
    let drops: number[] = []
    let quality = 1
    let lastPaint = 0
    let frame = 0

    const resize = () => {
      // Cap the pixel ratio: a 4K screen at 3x would be drawing nine times
      // the pixels for an effect nobody inspects closely.
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.floor(window.innerWidth * ratio)
      canvas.height = Math.floor(window.innerHeight * ratio)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight)
      columns = Math.ceil(window.innerWidth / FONT_SIZE)
      drops = new Array(columns).fill(0).map(() => Math.random() * -60)
    }
    resize()
    window.addEventListener('resize', resize)

    const paint = () => {
      const width = window.innerWidth
      const height = window.innerHeight

      // A translucent black wash over everything: this is what leaves a
      // fading trail behind each glyph instead of a solid line.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.085)'
      ctx.fillRect(0, 0, width, height)
      ctx.font = `${FONT_SIZE}px ui-monospace, monospace`

      const fps = fpsRef.current
      const target = fps >= 7 ? 1 : fps >= 5 ? 0.75 : fps >= 3 ? 0.5 : 0.3
      quality += (target - quality) * 0.25      // ease, so it never snaps

      const active = Math.max(8, Math.floor(columns * quality))
      const step = columns / active

      for (let n = 0; n < active; n++) {
        const i = Math.floor(n * step)
        const y = drops[i] * FONT_SIZE
        if (y > 0) {
          const glyph = GLYPHS[(Math.random() * GLYPHS.length) | 0]
          // The leading glyph is bright; the trail behind it is dim.
          ctx.fillStyle = Math.random() < 0.09 ? '#e8fff1' : 'rgba(0, 255, 102, 0.85)'
          ctx.fillText(glyph, i * FONT_SIZE, y)
        }
        if (y > height && Math.random() > 0.975) drops[i] = 0
        drops[i]++
      }
    }

    const loop = (now: number) => {
      if (!document.hidden && !reduced && now - lastPaint >= PAINT_INTERVAL) {
        lastPaint = now
        paint()
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden className="fixed inset-0 z-0 block pointer-events-none" />
}
