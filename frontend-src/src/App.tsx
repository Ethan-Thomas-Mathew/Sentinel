/**
 * SENTINEL — the operator console.
 *
 * Track A (crowd density and bottlenecks) and Track B (incident triage and
 * dispatch) in one platform. They merge cleanly because they need the same
 * geometry: congestion asks whether occupancy is above capacity, intrusion
 * asks whether it is above zero. Same point-in-polygon test, one flag on the
 * zone. What B adds is the operator workflow.
 *
 * This file is composition and state only. Anything with real logic in it
 * lives in its own component or hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { useLiveData } from './hooks/useLiveData'
import { BootScreen } from './components/BootScreen'
import { MatrixRain } from './components/MatrixRain'
import { VideoStage } from './components/VideoStage'
import { ZoneMeters } from './components/ZoneMeters'
import { IncidentQueue } from './components/IncidentQueue'
import { HeadcountChart } from './components/HeadcountChart'
import { SiteMap } from './components/SiteMap'
import { Btn, EditorBar, PlaybackBar, SourcePicker, UnitBar, ZoneForm } from './components/Controls'
import type { Playback, Tool, Unit, Zone } from './types'

type Draft = Pick<Zone, 'name' | 'capacity' | 'restricted'>

export default function App() {
  const [booted, setBooted] = useState(false)
  const live = useLiveData(booted)

  const [units, setUnits] = useState<Unit[]>([])
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const [evidence, setEvidence] = useState<string | null>(null)

  const [present, setPresent] = useState(false)
  const [focus, setFocus] = useState(false)
  const [heatOn, setHeatOn] = useState(true)
  const [flowOn, setFlowOn] = useState(true)

  // --- zone editing ---------------------------------------------------
  const [editing, setEditing] = useState(false)
  const [tool, setTool] = useState<Tool>('polygon')
  const [editZones, setEditZones] = useState<Zone[]>([])
  const [savedZones, setSavedZones] = useState<Zone[]>([])
  const [selected, setSelected] = useState(-1)
  const [unsaved, setUnsaved] = useState(false)
  const [hint, setHint] = useState('Click corners to draw. Double-click or Enter closes the shape.')
  const [draft, setDraft] = useState<Draft | null>(null)
  const pendingPoints = useRef<[number, number][] | null>(null)
  const pausedByEditor = useRef(false)
  const [playbackOverride, setPlaybackOverride] = useState<Playback | null>(null)

  // --- response unit editing (the site map) ---------------------------
  const [unitEditing, setUnitEditing] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState(-1)
  const [unitsUnsaved, setUnitsUnsaved] = useState(false)
  const [unitHint, setUnitHint] = useState('')

  const playback = playbackOverride && live.playback &&
    playbackOverride.position === live.playback.position
    ? playbackOverride
    : live.playback

  const autoBusy = live.playback?.autozone === 'running'

  useEffect(() => { api.units().then(setUnits).catch(() => {}) }, [])

  // Zones for the map come from the backend, refreshed whenever the live
  // zone list changes shape.
  const refreshZones = useCallback(() => {
    api.zones().then(setSavedZones).catch(() => {})
  }, [])
  useEffect(() => { if (booted) refreshZones() }, [booted, refreshZones])
  useEffect(() => { refreshZones() }, [live.stats?.zones.length, live.playback?.autozone, refreshZones])

  useEffect(() => {
    document.body.classList.toggle('present', present)
  }, [present])

  // Space toggles playback, unless you are typing in the zone form.
  useEffect(() => {
    if (!booted) return
    const onKey = async (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT'
      if (e.code === 'Space' && !typing) {
        e.preventDefault()
        const response = await api.pause(!(playback?.paused ?? false))
        setPlaybackOverride(await response.json())
      }
      if (e.key === 'Escape') {
        setEvidence(null)
        if (focus) setFocus(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [booted, playback?.paused, focus])

  /* --- zone editing actions ------------------------------------------ */

  const openEditor = async () => {
    pausedByEditor.current = !(playback?.paused ?? false)
    if (pausedByEditor.current) setPlaybackOverride(await (await api.pause(true)).json())
    setEditZones(await api.zones())
    setSelected(-1)
    setUnsaved(false)
    setDraft(null)
    setEditing(true)
  }

  const closeEditor = async () => {
    if (unsaved && !confirm('You have unsaved zone changes. Leave the editor anyway?')) return
    setEditing(false)
    setDraft(null)
    // Put playback back the way we found it. Leaving it paused made a saved
    // zone look as though it had done nothing at all.
    if (pausedByEditor.current) {
      pausedByEditor.current = false
      setPlaybackOverride(await (await api.pause(false)).json())
    }
  }

  const onShapeDrawn = (points: [number, number][]) => {
    pendingPoints.current = points
    setDraft({ name: `Zone ${editZones.length + 1}`, capacity: 3, restricted: false })
  }

  const confirmDraft = () => {
    if (!draft) return
    const capacity = draft.restricted ? 0 : Math.max(1, draft.capacity || 3)
    if (pendingPoints.current) {
      setEditZones([...editZones, { ...draft, capacity, points: pendingPoints.current }])
      setSelected(editZones.length)
    } else if (selected >= 0) {
      setEditZones(editZones.map((z, i) => (i === selected ? { ...z, ...draft, capacity } : z)))
    }
    pendingPoints.current = null
    setDraft(null)
    markUnsaved()
  }

  const markUnsaved = () => {
    setUnsaved(true)
    setHint('Unsaved — press SAVE ZONES to apply this to the rules engine.')
  }

  // Deleting lives here rather than inline in the toolbar, because the Delete
  // key on the video and the DELETE button have to do exactly the same thing.
  const deleteSelectedZone = () => {
    if (selected < 0) return
    setEditZones(editZones.filter((_, i) => i !== selected))
    setSelected(-1)
    markUnsaved()
  }

  const saveZones = async () => {
    const response = await api.saveZones(editZones)
    if (response.ok) {
      setUnsaved(false)
      setHint(`Saved ${editZones.length} zone(s). Live now — no restart.`)
      refreshZones()
    } else {
      setHint('Save failed. Check the terminal running run.py.')
    }
  }

  /* --- response unit actions ------------------------------------------ */

  const saveUnits = async () => {
    const response = await api.saveUnits(units)
    if (response.ok) {
      setUnitsUnsaved(false)
      setUnitHint(`Saved ${units.length} unit(s). Dispatch uses the new positions immediately.`)
    } else {
      setUnitHint('Save failed. Check the terminal running run.py.')
    }
  }

  const closeUnitEditor = async () => {
    if (unitsUnsaved && !confirm('You have unsaved unit changes. Discard them?')) return
    setUnitEditing(false)
    setSelectedUnit(-1)
    setUnitHint('')
    // Discard: reload whatever is actually on the server, so what you see is
    // what the dispatcher will use.
    if (unitsUnsaved) {
      setUnitsUnsaved(false)
      api.units().then(setUnits).catch(() => {})
    }
  }

  const runAutoZone = async () => {
    setHint('Analysing the footage for busy areas…')
    await api.autoZone(false)
    // The job runs on a background thread; poll until it finishes.
    const timer = window.setInterval(async () => {
      const zones = await api.zones()
      if (zones.length !== editZones.length) {
        setEditZones(zones)
        setSavedZones(zones)
        setHint(`Proposed a zone from the footage. Adjust it and press SAVE ZONES.`)
        window.clearInterval(timer)
      }
    }, 1500)
    window.setTimeout(() => window.clearInterval(timer), 60000)
  }

  if (!booted) return (<><MatrixRain detectorFps={8} /><BootScreen onEnter={() => setBooted(true)} /></>)

  const stats = live.stats
  const zoneStats = stats?.zones ?? []
  const portrait = frame.height > frame.width && frame.width > 0

  return (
    <>
      <MatrixRain detectorFps={stats?.fps ?? 8} />

      {!focus && (
        <header className="relative z-1 flex h-14 items-center gap-4 border-b border-line bg-panel px-4.5">
          <div className="flex items-baseline gap-3">
            <b className="font-bold tracking-[0.2em] text-sig scale-text" style={{ fontSize: '16.5px' }}>SENTINEL</b>
            <span className="text-muted" style={{ fontSize: '11.5px' }}>
              TRACK A + B // DENSITY &amp; INCIDENT RESPONSE
            </span>
          </div>
          <div className="flex-1" />
          <div className="hidden items-center gap-5 lg:flex">
            <Telemetry label="THROUGHPUT" value={stats ? `${stats.fps.toFixed(1)} FPS` : '—'} />
            <Telemetry label="FRAME" value={stats ? `${stats.processing_ms.toFixed(0)} MS` : '—'} />
            <Clock />
          </div>
          <Btn pressed={focus} onClick={() => setFocus(true)} title="Hide the panels and fill the screen">FOCUS</Btn>
          <Btn pressed={present} onClick={() => setPresent(!present)} title="Larger type for screen sharing">PRESENT</Btn>
          <div className="flex items-center gap-2 text-muted" style={{ fontSize: '11.5px' }}>
            <span className={`h-2 w-2 rounded-full ${live.connected ? 'bg-sig pulse-ring' : 'bg-crit'}`} />
            {live.connected ? 'LIVE' : 'RECONNECTING'}
          </div>
        </header>
      )}

      <div className={`relative z-1 grid gap-px bg-line ${focus ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px]'}`}
           style={{ height: focus ? '100vh' : 'calc(100vh - 56px)' }}>

        <section className={`flex min-w-0 overflow-hidden ${portrait && !focus ? 'flex-row' : 'flex-col'}`}>
          <div className={`flex min-h-0 min-w-0 flex-col ${portrait && !focus ? 'max-w-[64%] flex-[0_1_auto]' : 'flex-1'}`}>
            <VideoStage
              editing={editing} tool={tool} zones={editZones} zoneStats={zoneStats}
              selected={selected} paused={playback?.paused ?? false}
              onSelect={setSelected}
              onZonesChange={(z) => { setEditZones(z); markUnsaved() }}
              onShapeDrawn={onShapeDrawn}
              onEditDetails={() => {
                if (selected < 0) return
                const zone = editZones[selected]
                pendingPoints.current = null
                setDraft({ name: zone.name, capacity: zone.capacity, restricted: zone.restricted })
              }}
              onDeleteSelected={deleteSelectedZone}
              onFrameSize={setFrame}
            />

            <PlaybackBar playback={playback} onChanged={setPlaybackOverride}>
              <div className="flex-1" />
              <Btn pressed={heatOn} title="Where people have recently been standing"
                   onClick={() => { api.heatmap(!heatOn); setHeatOn(!heatOn) }}>HEATMAP</Btn>
              <Btn pressed={flowOn} title="Which way the crowd is moving"
                   onClick={() => { api.flow(!flowOn); setFlowOn(!flowOn) }}>FLOW</Btn>
              <Btn pressed={editing} onClick={() => (editing ? closeEditor() : openEditor())}>EDIT ZONES</Btn>
              {focus && <Btn onClick={() => setFocus(false)}>EXIT FOCUS</Btn>}
            </PlaybackBar>

            {editing && (
              <EditorBar
                tool={tool} setTool={setTool} zones={editZones}
                selected={selected} unsaved={unsaved} hint={hint}
                autoBusy={autoBusy}
                onUndo={() => {
                  if (selected >= 0 && editZones[selected].points.length > 3) {
                    setEditZones(editZones.map((z, i) =>
                      i === selected ? { ...z, points: z.points.slice(0, -1) } : z))
                    markUnsaved()
                  }
                }}
                onDetails={() => {
                  const zone = editZones[selected]
                  if (!zone) return
                  pendingPoints.current = null
                  setDraft({ name: zone.name, capacity: zone.capacity, restricted: zone.restricted })
                }}
                onDelete={deleteSelectedZone}
                onClear={() => {
                  if (!confirm(`Remove all ${editZones.length} zone(s)?`)) return
                  setEditZones([])
                  setSelected(-1)
                  markUnsaved()
                }}
                onSave={saveZones}
                onAuto={runAutoZone}
              />
            )}

            {editing && draft && (
              <ZoneForm
                draft={draft} onChange={setDraft} onConfirm={confirmDraft}
                isNew={pendingPoints.current !== null}
                onCancel={() => { pendingPoints.current = null; setDraft(null) }}
              />
            )}

            {!editing && !focus && (
              <div className="flex flex-wrap items-center gap-2.5 border-t border-line bg-panel px-3.5 py-2.5">
                <span className="text-muted" style={{ fontSize: '11.5px' }}>SOURCE</span>
                <SourcePicker
                  current={playback?.source_name ?? ''}
                  onSwitched={() => { refreshZones(); setFrame({ width: 0, height: 0 }) }}
                />
                {autoBusy && (
                  <span className="text-warn" style={{ fontSize: '11.5px' }}>ANALYSING FOOTAGE…</span>
                )}
              </div>
            )}
          </div>

          {!focus && (
            <div className={`border-line bg-panel px-4 py-3 ${portrait ? 'min-w-0 flex-1 border-l' : 'h-[200px] flex-none border-t'}`}>
              <HeadcountChart history={live.history} marks={live.marks} current={stats?.total_people ?? 0} />
            </div>
          )}
        </section>

        {!focus && (
          <aside className="overflow-y-auto bg-transparent">
            <Block title="ZONE CAPACITY">
              <ZoneMeters zones={zoneStats} />
            </Block>

            <Block title="SITE MAP" extra={
              <Btn pressed={unitEditing} className="ml-auto"
                   title="Drag the response units to where they actually stand"
                   onClick={() => (unitEditing ? closeUnitEditor() : setUnitEditing(true))}>
                {unitEditing ? 'EDITING' : 'EDIT UNITS'}
              </Btn>
            }>
              <SiteMap zones={savedZones} zoneStats={zoneStats} units={units}
                       incidents={live.incidents} frame={frame}
                       editing={unitEditing} selectedUnit={selectedUnit}
                       onSelectUnit={setSelectedUnit}
                       onUnitsChange={(next) => {
                         setUnits(next)
                         setUnitsUnsaved(true)
                         setUnitHint('Unsaved — press SAVE UNITS to apply.')
                       }} />
              {unitEditing && (
                <UnitBar
                  units={units} selected={selectedUnit} unsaved={unitsUnsaved} hint={unitHint}
                  onChange={(next) => {
                    setUnits(next)
                    setUnitsUnsaved(true)
                    setUnitHint('Unsaved — press SAVE UNITS to apply.')
                  }}
                  onDelete={() => {
                    setUnits(units.filter((_, i) => i !== selectedUnit))
                    setSelectedUnit(-1)
                    setUnitsUnsaved(true)
                    setUnitHint('Unsaved — press SAVE UNITS to apply.')
                  }}
                  onSave={saveUnits}
                  onCancel={closeUnitEditor}
                />
              )}
            </Block>

            <div className="border-b border-line bg-panel pb-0 pt-3.5">
              <h2 className="m-0 mb-3 px-4 font-bold tracking-[0.12em] scale-text">LAST HOUR</h2>
              <div className="grid grid-cols-4 gap-px bg-line">
                <Kpi value={live.summary?.peak_headcount ?? 0} label="PEAK" />
                <Kpi value={live.summary?.alerts_last_hour ?? 0} label="EVENTS" />
                <Kpi value={live.summary?.critical_last_hour ?? 0} label="CRITICAL" tone="text-crit" />
                <Kpi value={live.summary?.open_incidents ?? 0} label="OPEN" tone="text-warn" />
              </div>
            </div>

            <Block title="INCIDENT QUEUE" extra={
              <a href="/api/export.csv" download
                 className="ml-auto rounded-sm border border-line bg-sig/5 px-3 py-[5px] text-body
                            no-underline transition-colors hover:border-linehot hover:text-sig">CSV</a>
            }>
              <IncidentQueue incidents={live.incidents} onUpdate={live.updateIncident}
                             onViewEvidence={setEvidence} />
            </Block>
          </aside>
        )}
      </div>

      {evidence && (
        <div onClick={() => setEvidence(null)}
             className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/93 p-7">
          <img src={evidence} alt="Incident evidence frame" className="max-h-full max-w-full border border-sig" />
        </div>
      )}
    </>
  )
}

/* --- small presentational pieces --------------------------------------- */

function Block({ title, children, extra }: { title: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="border-b border-line bg-panel px-4 pb-4.5 pt-3.5">
      <h2 className="m-0 mb-3 flex items-center gap-2 font-bold tracking-[0.12em] scale-text">
        {title}{extra}
      </h2>
      {children}
    </div>
  )
}

function Kpi({ value, label, tone = 'text-sig' }: { value: number; label: string; tone?: string }) {
  return (
    <div className="bg-panel px-2.5 py-2.5">
      <div className={`leading-tight tabular-nums scale-text ${tone}`} style={{ fontSize: '19px' }}>{value}</div>
      <div className="mt-0.5 text-muted" style={{ fontSize: '11.5px' }}>{label}</div>
    </div>
  )
}

function Telemetry({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted" style={{ fontSize: '11.5px' }}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date().toLocaleTimeString([], { hour12: false }))
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toLocaleTimeString([], { hour12: false })), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <Telemetry label="TIME" value={now} />
}
