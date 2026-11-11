/**
 * The small shared controls: buttons, the playback bar, the zone toolbar and
 * the video source picker.
 *
 * Keeping them here rather than inline in App means every button on the
 * dashboard behaves and looks the same way without that being a coincidence.
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Playback, Tool, Unit, Zone } from '../types'

/* --- a single styled button -------------------------------------------- */
export function Btn({ children, onClick, pressed, disabled, primary, danger, title, className = '' }: {
  children: React.ReactNode
  onClick?: () => void
  pressed?: boolean
  disabled?: boolean
  primary?: boolean
  danger?: boolean
  title?: string
  className?: string
}) {
  const base = `rounded-sm border px-3 py-[5px] font-mono transition-colors
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sig
                disabled:cursor-not-allowed disabled:opacity-35`
  const look = primary
    ? 'border-sig bg-sig font-bold text-[#001a08]'
    : danger
      ? 'border-crit/45 bg-sig/5 text-crit hover:border-crit'
      : pressed
        ? 'border-sig bg-sig/10 text-sig'
        : 'border-line bg-sig/5 text-body hover:border-linehot hover:text-sig'
  return (
    <button title={title} onClick={onClick} disabled={disabled}
            aria-pressed={pressed} className={`${base} ${look} ${className}`}>
      {children}
    </button>
  )
}

/* --- playback bar ------------------------------------------------------- */
export function PlaybackBar({ playback, onChanged, children }: {
  playback: Playback | null
  onChanged: (pb: Playback) => void
  children?: React.ReactNode
}) {
  const [scrubbing, setScrubbing] = useState(false)
  const [localValue, setLocalValue] = useState(0)

  const paused = playback?.paused ?? false
  const isCamera = playback?.is_camera ?? false
  const total = playback?.total_frames ?? 1
  const fps = playback?.source_fps || 25
  const position = scrubbing ? localValue : playback?.position ?? 0

  const format = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-line bg-panel px-3.5 py-2.5">
      <Btn title="Space bar" onClick={async () => onChanged(await (await api.pause(!paused)).json())}>
        {paused ? 'PLAY' : 'PAUSE'}
      </Btn>
      <Btn disabled={isCamera} onClick={async () => onChanged(await (await api.restart()).json())}>
        RESTART
      </Btn>

      <div className="flex min-w-[200px] flex-1 items-center gap-2.5">
        <input
          type="range" min={0} max={Math.max(1, total - 1)} value={position}
          disabled={isCamera}
          aria-label="Video position"
          onChange={(e) => { setScrubbing(true); setLocalValue(Number(e.target.value)) }}
          onMouseUp={async (e) => {
            const frame = Number((e.target as HTMLInputElement).value)
            onChanged(await (await api.seek(frame)).json())
            setScrubbing(false)
          }}
          className="flex-1"
        />
        <span className="whitespace-nowrap tabular-nums text-muted" style={{ fontSize: '11.5px' }}>
          {isCamera ? 'LIVE CAMERA' : `${format(position / fps)} / ${format(total / fps)}`}
        </span>
      </div>

      {children}
    </div>
  )
}

/* --- zone editor toolbar ------------------------------------------------ */
const TOOLS: { id: Tool; label: string }[] = [
  { id: 'polygon', label: 'POLYGON' },
  { id: 'rectangle', label: 'RECT' },
  { id: 'square', label: 'SQUARE' },
  { id: 'circle', label: 'CIRCLE' },
]

export function EditorBar({
  tool, setTool, zones, selected, unsaved, hint,
  onUndo, onDetails, onDelete, onClear, onSave, onAuto, autoBusy,
}: {
  tool: Tool
  setTool: (t: Tool) => void
  zones: Zone[]
  selected: number
  unsaved: boolean
  hint: string
  onUndo: () => void
  onDetails: () => void
  onDelete: () => void
  onClear: () => void
  onSave: () => void
  onAuto: () => void
  autoBusy: boolean
}) {
  const chosen = zones[selected]

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panelhi px-3.5 py-2.5">
      <div className="flex gap-1">
        {TOOLS.map((t) => (
          <Btn key={t.id} pressed={tool === t.id} onClick={() => setTool(t.id)}>{t.label}</Btn>
        ))}
      </div>
      <Btn onClick={onUndo}>UNDO POINT</Btn>
      <Btn disabled={!chosen} onClick={onDetails}>EDIT DETAILS</Btn>
      <Btn danger disabled={!chosen} onClick={onDelete}
           title={chosen ? `Delete ${chosen.name} (Delete key)` : 'Click a zone on the video first'}>
        DELETE
      </Btn>
      <Btn danger disabled={!zones.length} onClick={onClear}
           title="Remove every zone at once">CLEAR ALL</Btn>
      <Btn onClick={onAuto} disabled={autoBusy} title="Analyse the footage and propose a zone over the busy area">
        {autoBusy ? 'ANALYSING…' : 'AUTO'}
      </Btn>
      <Btn primary onClick={onSave} className={unsaved ? 'nudge' : ''}>
        {unsaved ? '● SAVE ZONES' : 'SAVE ZONES'}
      </Btn>

      {/* Which zone the DELETE and EDIT DETAILS buttons will act on. Without
          this they just look broken: both are disabled until something is
          selected, and nothing on screen said so. */}
      <span className="basis-full text-muted" style={{ fontSize: '11.5px' }}>
        {chosen
          ? <><b className="text-sig">{chosen.name}</b> selected — EDIT DETAILS, or DELETE / Delete key removes it. </>
          : zones.length
            ? <>Click inside a zone to select it, then DELETE to remove it. </>
            : null}
        {hint}
      </span>
    </div>
  )
}

/* --- zone details form --------------------------------------------------
   This replaces the browser's own prompt() dialogs. A native dialog steals
   focus, cannot be styled, and on a screen share looks like an error. */
export function ZoneForm({ draft, onChange, onConfirm, onCancel, isNew }: {
  draft: Pick<Zone, 'name' | 'capacity' | 'restricted'>
  onChange: (next: Pick<Zone, 'name' | 'capacity' | 'restricted'>) => void
  onConfirm: () => void
  onCancel: () => void
  isNew: boolean
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select() }, [])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onConfirm() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
  }

  const field = `rounded-sm border border-line bg-black px-2.5 py-[5px] font-mono text-body
                 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sig`

  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-line bg-panelhi px-3.5 py-2.5">
      <label className="flex items-center gap-2 text-muted" style={{ fontSize: '11.5px' }}>
        NAME
        <input ref={nameRef} type="text" value={draft.name} onKeyDown={onKey}
               onChange={(e) => onChange({ ...draft, name: e.target.value })} className={field} />
      </label>

      <label className="flex items-center gap-2 text-muted" style={{ fontSize: '11.5px' }}>
        CAPACITY
        <input type="number" min={0} value={draft.capacity} onKeyDown={onKey}
               disabled={draft.restricted}
               onChange={(e) => onChange({ ...draft, capacity: Number(e.target.value) })}
               className={`${field} w-[72px] disabled:opacity-40`} />
      </label>

      <label className="flex items-center gap-2 text-muted" style={{ fontSize: '11.5px' }}
             title="Any person inside a restricted zone raises an intrusion incident">
        <input type="checkbox" checked={draft.restricted} className="h-[15px] w-[15px] accent-[#ff4d4d]"
               onChange={(e) => onChange({ ...draft, restricted: e.target.checked })} />
        RESTRICTED (INTRUSION)
      </label>

      <Btn primary onClick={onConfirm}>{isNew ? 'ADD ZONE' : 'UPDATE'}</Btn>
      <Btn onClick={onCancel}>CANCEL</Btn>
      <span className="text-muted" style={{ fontSize: '11.5px' }}>
        Low capacity (2 or 3) so an alert actually fires during a demo.
      </span>
    </div>
  )
}

/* --- response unit editor ----------------------------------------------
   The counterpart to the zone editor, for Track B's responders. Same idea:
   place things by pointing at the plan, name them in a field, apply with one
   button. Nothing about a site's layout should require editing a JSON file. */
export function UnitBar({ units, selected, unsaved, hint, onChange, onDelete, onSave, onCancel }: {
  units: Unit[]
  selected: number
  unsaved: boolean
  hint: string
  onChange: (next: Unit[]) => void
  onDelete: () => void
  onSave: () => void
  onCancel: () => void
}) {
  const unit = units[selected]

  const field = `rounded-sm border border-line bg-black px-2.5 py-[5px] font-mono text-body
                 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sig`

  const patch = (changes: Partial<Unit>) =>
    onChange(units.map((u, i) => (i === selected ? { ...u, ...changes } : u)))

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
      {unit ? (
        <>
          <label className="flex items-center gap-2 text-muted" style={{ fontSize: '11.5px' }}>
            NAME
            <input type="text" value={unit.name} className={`${field} w-[132px]`}
                   onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-muted" style={{ fontSize: '11.5px' }}
                 title="An unavailable unit is never suggested for dispatch">
            <input type="checkbox" checked={unit.available} className="h-[15px] w-[15px] accent-[#00ff66]"
                   onChange={(e) => patch({ available: e.target.checked })} />
            ON DUTY
          </label>
          <span className="tabular-nums text-muted" style={{ fontSize: '11.5px' }}>
            {unit.position[0]}, {unit.position[1]}
          </span>
          <Btn danger onClick={onDelete}>DELETE</Btn>
        </>
      ) : (
        <span className="text-muted" style={{ fontSize: '11.5px' }}>
          Click the plan to add a post. Click a marker to select it.
        </span>
      )}

      <div className="flex-1" />
      <Btn primary onClick={onSave} className={unsaved ? 'nudge' : ''}>
        {unsaved ? '● SAVE UNITS' : 'SAVE UNITS'}
      </Btn>
      <Btn onClick={onCancel}>DONE</Btn>
      {hint && <span className="basis-full text-muted" style={{ fontSize: '11.5px' }}>{hint}</span>}
    </div>
  )
}

/* --- video source picker ------------------------------------------------ */
export function SourcePicker({ current, onSwitched }: {
  current: string
  onSwitched: () => void
}) {
  const [videos, setVideos] = useState<{ name: string; size_mb: number }[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = () => api.videos().then((d) => setVideos(d.videos)).catch(() => {})
  useEffect(() => { refresh() }, [current])

  const upload = async (file: File) => {
    setBusy(true)
    setMessage(`Uploading ${file.name}…`)
    try {
      const response = await api.uploadVideo(file)
      const body = await response.json()
      setMessage(body.error ? body.error : `Loaded ${body.saved}`)
      if (!body.error) { await refresh(); onSwitched() }
    } catch {
      setMessage('Upload failed.')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={current}
        disabled={busy}
        onChange={async (e) => { await api.selectVideo(e.target.value); onSwitched() }}
        className="rounded-sm border border-line bg-black px-2 py-[5px] font-mono text-body
                   focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sig"
        style={{ fontSize: '11.5px' }}
        aria-label="Video source"
      >
        {videos.length === 0 && <option>{current}</option>}
        {videos.map((v) => (
          <option key={v.name} value={v.name}>{v.name} ({v.size_mb} MB)</option>
        ))}
      </select>

      <Btn disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? 'UPLOADING…' : 'UPLOAD VIDEO'}
      </Btn>
      <input ref={fileRef} type="file" accept="video/*" hidden
             onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />

      {message && <span className="text-muted" style={{ fontSize: '11.5px' }}>{message}</span>}
    </div>
  )
}
