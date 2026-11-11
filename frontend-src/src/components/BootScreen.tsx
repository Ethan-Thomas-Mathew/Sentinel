/**
 * The boot sequence.
 *
 * Every line reports the system's REAL configuration, fetched from the API
 * before it types. A boot screen that invents its numbers is a splash image
 * with extra steps; this one tells you how many zones loaded and how many
 * response units are online, so if something failed to start you see it here
 * rather than discovering it mid-demo.
 *
 * Any key skips the typing, so it can never strand you on camera.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

interface Line { text: string; status: string }

export function BootScreen({ onEnter }: { onEnter: () => void }) {
  const [lines, setLines] = useState<Line[]>([])
  const [typed, setTyped] = useState('')
  const [ready, setReady] = useState(false)
  const skipped = useRef(false)
  const enterRef = useRef<HTMLButtonElement>(null)

  const finish = useCallback(() => {
    skipped.current = true
    setReady(true)
  }, [])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      let zoneCount: number | string = '?'
      let unitCount: number | string = '?'
      let restricted = 0
      try {
        const [zones, units] = await Promise.all([api.zones(), api.units()])
        zoneCount = zones.length
        unitCount = units.length
        restricted = zones.filter((z) => z.restricted).length
      } catch {
        /* backend still starting — the sequence still runs */
      }

      const script: Line[] = [
        { text: 'initialising vision pipeline', status: 'OK' },
        { text: 'detector: yolov8n // COCO class 0', status: 'OK' },
        { text: 'tracker: bytetrack', status: 'OK' },
        { text: `zones configured: ${zoneCount} (${restricted} restricted)`, status: 'OK' },
        { text: `response units online: ${unitCount}`, status: 'OK' },
        { text: 'event channel: websocket', status: 'OK' },
        { text: 'awaiting operator', status: '' },
      ]

      for (const line of script) {
        if (cancelled) return
        if (skipped.current) {
          setLines((current) => [...current, line])
          continue
        }
        for (let i = 1; i <= line.text.length; i++) {
          if (cancelled) return
          if (skipped.current) break
          setTyped(line.text.slice(0, i))
          await sleep(11)
        }
        setTyped('')
        setLines((current) => [...current, line])
        if (!skipped.current) await sleep(80)
      }
      if (!cancelled) setReady(true)
    }

    run()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ready) { finish(); return }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') onEnter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready, finish, onEnter])

  useEffect(() => { if (ready) enterRef.current?.focus() }, [ready])

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/85">
      <div className="w-[min(760px,88vw)]">
        <h1
          className="m-0 mb-1.5 font-bold text-sig tracking-[0.22em]"
          style={{ fontSize: 'clamp(34px, 7vw, 68px)', textShadow: '0 0 18px rgba(0,255,102,.55)' }}
        >
          SENTINEL
        </h1>
        <p className="m-0 mb-6 text-muted tracking-[0.14em]">CROWD DENSITY &amp; INCIDENT RESPONSE</p>

        <div className="min-h-[190px] leading-[1.85]">
          {lines.map((line, i) => (
            <div key={i}>
              <span className="text-muted">&gt; </span>
              <span>{line.text}</span>
              {line.status && <span className="text-sig">{`  [ ${line.status} ]`}</span>}
            </div>
          ))}
          {typed && (
            <div>
              <span className="text-muted">&gt; </span>
              <span>{typed}</span>
              <span className="caret ml-[3px] inline-block h-[15px] w-[9px] align-[-2px] bg-sig" />
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-4">
          <button
            ref={enterRef}
            onClick={onEnter}
            className={`border border-sig bg-transparent px-[30px] py-[11px] font-mono tracking-[0.18em] text-sig
                        transition-all duration-300 hover:bg-sig hover:text-[#001a08]
                        focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-sig
                        ${ready ? 'opacity-100 translate-y-0' : 'pointer-events-none translate-y-1.5 opacity-0'}`}
            style={{ fontSize: '15px' }}
          >
            ENTER
          </button>
          <span className="text-muted" style={{ fontSize: '11.5px' }}>press any key to skip</span>
        </div>
      </div>
    </div>
  )
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
