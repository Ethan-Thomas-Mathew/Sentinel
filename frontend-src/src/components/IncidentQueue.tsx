/**
 * Track B's priority incident queue and dispatch workflow.
 *
 * Each incident carries the exact annotated frame that triggered it — not a
 * reconstruction, the real one — and moves through NEW → ACKNOWLEDGED →
 * DISPATCHED → RESOLVED. INFO events are notifications rather than incidents,
 * so they get no workflow controls: only something that needs a response gets
 * a way to respond.
 */

import { useState } from 'react'
import { api } from '../api'
import type { Incident, Severity } from '../types'

type Filter = 'ALL' | Severity | 'OPEN'
const FILTERS: Filter[] = ['ALL', 'CRITICAL', 'WARNING', 'INFO', 'OPEN']

const BORDER: Record<Severity, string> = {
  CRITICAL: 'border-l-crit',
  WARNING: 'border-l-warn',
  INFO: 'border-l-info',
}

const CHIP: Record<string, string> = {
  NEW: 'text-crit border-crit/50',
  ACKNOWLEDGED: 'text-warn border-warn/50',
  DISPATCHED: 'text-info border-info/50',
  RESOLVED: 'text-sig border-sig/50',
}

interface Props {
  incidents: Incident[]
  onUpdate: (incident: Incident) => void
  onViewEvidence: (src: string) => void
}

export function IncidentQueue({ incidents, onUpdate, onViewEvidence }: Props) {
  const [filter, setFilter] = useState<Filter>('ALL')

  const visible = incidents.filter((incident) => {
    if (filter === 'ALL') return true
    if (filter === 'OPEN') return incident.status === 'NEW' || incident.status === 'ACKNOWLEDGED'
    return incident.severity === filter
  })

  return (
    <>
      <div className="mb-2.5 flex flex-wrap gap-1">
        {FILTERS.map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            aria-pressed={filter === option}
            className={`rounded-sm border px-2.5 py-[3px] transition-colors focus-visible:outline-2
                        focus-visible:outline-offset-2 focus-visible:outline-sig
                        ${filter === option ? 'border-sig text-sig' : 'border-line text-muted hover:text-body'}`}
            style={{ fontSize: '11.5px' }}
          >
            {option === 'OPEN' ? 'OPEN ONLY' : option}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-px">
        {visible.length === 0 && (
          <p className="py-1.5 text-muted" style={{ fontSize: '11.5px' }}>
            {incidents.length ? 'Nothing matches this filter.' : 'No incidents. All zones within limits.'}
          </p>
        )}
        {visible.map((incident) => (
          <IncidentRow
            key={incident.id}
            incident={incident}
            onUpdate={onUpdate}
            onViewEvidence={onViewEvidence}
          />
        ))}
      </div>
    </>
  )
}

function IncidentRow({ incident, onUpdate, onViewEvidence }: {
  incident: Incident
  onUpdate: (incident: Incident) => void
  onViewEvidence: (src: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const act = async (run: () => Promise<Incident>) => {
    setBusy(true)
    try {
      onUpdate(await run())
    } finally {
      setBusy(false)
    }
  }

  const dispatch = async () => {
    // Ask which unit is nearest before sending, so the operator sees a
    // reasoned choice rather than a name appearing from nowhere.
    try {
      const suggestion = await api.suggestUnit(incident.id)
      if (suggestion?.name) setNote(`${suggestion.distance_px}px away`)
    } catch { /* fall through to the backend's own choice */ }
    await act(() => api.dispatch(incident.id))
  }

  const time = new Date(incident.timestamp * 1000).toLocaleTimeString([], { hour12: false })

  return (
    <div className={`land grid grid-cols-[auto_1fr] gap-2.5 border-l-2 bg-black/45 px-2.5 py-2.5
                     ${BORDER[incident.severity]}`}>
      <time className="pt-px tabular-nums text-muted" style={{ fontSize: '11.5px' }}>{time}</time>

      <p className="m-0 leading-snug" style={{ fontSize: '11.5px' }}>
        {incident.message}
        <span className="mt-0.5 block text-muted" style={{ fontSize: '10.5px' }}>
          {incident.zone} // {incident.type}
        </span>
      </p>

      {incident.snapshot && (
        <img
          src={`/snapshots/${incident.snapshot}`}
          alt={`Frame captured when ${incident.zone} raised ${incident.type}`}
          loading="lazy"
          onClick={() => onViewEvidence(`/snapshots/${incident.snapshot}`)}
          className="col-span-2 mt-1.5 block w-full cursor-zoom-in rounded-sm border border-line"
        />
      )}

      {incident.severity !== 'INFO' && (
        <div className="col-span-2 mt-2 flex flex-wrap items-center gap-1.5">
          <span className={`rounded-sm border px-1.5 tracking-[0.06em] ${CHIP[incident.status] ?? 'border-line text-muted'}`}
                style={{ fontSize: '11.5px' }}>
            {incident.status}
          </span>

          {incident.assigned_unit && (
            <span className="text-info" style={{ fontSize: '11.5px' }}>→ {incident.assigned_unit}</span>
          )}

          {incident.status === 'NEW' && (
            <WorkflowButton busy={busy} onClick={() => act(() => api.setStatus(incident.id, 'ACKNOWLEDGED'))}>
              ACK
            </WorkflowButton>
          )}
          {(incident.status === 'NEW' || incident.status === 'ACKNOWLEDGED') && (
            <WorkflowButton busy={busy} onClick={dispatch}>DISPATCH</WorkflowButton>
          )}
          {incident.status === 'DISPATCHED' && (
            <WorkflowButton busy={busy} onClick={() => act(() => api.setStatus(incident.id, 'RESOLVED'))}>
              RESOLVE
            </WorkflowButton>
          )}
          {note && <span className="text-muted" style={{ fontSize: '10.5px' }}>{note}</span>}
        </div>
      )}
    </div>
  )
}

function WorkflowButton({ children, onClick, busy }: {
  children: React.ReactNode; onClick: () => void; busy: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="rounded-sm border border-line px-2.5 py-[3px] transition-colors hover:border-sig hover:text-sig
                 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sig"
      style={{ fontSize: '11.5px' }}
    >
      {children}
    </button>
  )
}
