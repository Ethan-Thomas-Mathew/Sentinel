/**
 * The one WebSocket connection, and everything that arrives on it.
 *
 * WHY A HOOK
 *   Several panels need the same live data — counts, zones, incidents,
 *   playback position. Opening a socket per panel would mean four connections
 *   showing four slightly different moments. One hook, one socket, one shared
 *   snapshot that every panel renders from.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Incident, LivePayload, Playback, Stats, Summary } from '../types'

export interface LiveData {
  connected: boolean
  stats: Stats | null
  playback: Playback | null
  incidents: Incident[]
  summary: Summary | null
  history: { time: number; total: number }[]
  /** Replace one incident after the operator changes its status. */
  updateIncident: (incident: Incident) => void
  refreshSummary: () => void
  /** Chart indices where an incident fired, for the markers on the graph. */
  marks: { index: number; severity: string }[]
}

const MAX_POINTS = 300
const MAX_INCIDENTS = 60

export function useLiveData(enabled: boolean): LiveData {
  const [connected, setConnected] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)
  const [playback, setPlayback] = useState<Playback | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [history, setHistory] = useState<{ time: number; total: number }[]>([])
  const [marks, setMarks] = useState<{ index: number; severity: string }[]>([])

  const seenIds = useRef<Set<number>>(new Set())
  const historyLoaded = useRef(false)

  const refreshSummary = useCallback(() => {
    api.summary().then(setSummary).catch(() => {})
  }, [])

  const updateIncident = useCallback((incident: Incident) => {
    setIncidents((current) =>
      current.map((i) => (i.id === incident.id ? { ...i, ...incident } : i)),
    )
    refreshSummary()
  }, [refreshSummary])

  // Load the past once, before the live feed starts. If both run at the same
  // time, live points can land on the chart ahead of older history and the
  // time axis ends up out of order.
  useEffect(() => {
    if (!enabled || historyLoaded.current) return
    historyLoaded.current = true

    let cancelled = false
    ;(async () => {
      try {
        const points = await api.history()
        if (!cancelled) {
          setHistory(points.map((p) => ({ time: p.timestamp * 1000, total: p.total })))
        }
        const past = await api.incidents(30)
        if (!cancelled) {
          past.forEach((i) => seenIds.current.add(i.id))
          setIncidents(past)
        }
        refreshSummary()
      } catch {
        /* backend still starting; the socket below will catch up */
      }
    })()
    return () => { cancelled = true }
  }, [enabled, refreshSummary])

  useEffect(() => {
    if (!enabled) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false

    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${protocol}://${location.host}/ws`)

      socket.onopen = () => setConnected(true)

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as LivePayload
        setPlayback(data.playback)

        const incoming = data.stats as Stats
        if (incoming && Array.isArray(incoming.zones)) {
          setStats(incoming)
          if (!data.playback?.paused) {
            setHistory((current) => {
              const next = [...current, { time: incoming.timestamp * 1000, total: incoming.total_people }]
              const overflow = next.length - MAX_POINTS
              if (overflow > 0) {
                // Markers point at positions in this array, so when the oldest
                // points fall off the front every marker slides left with them.
                setMarks((m) =>
                  m.map((mark) => ({ ...mark, index: mark.index - overflow }))
                   .filter((mark) => mark.index >= 0),
                )
                return next.slice(overflow)
              }
              return next
            })
          }
        }

        if (data.alerts?.length) {
          const fresh = data.alerts.filter((a) => !seenIds.current.has(a.id))
          if (fresh.length) {
            fresh.forEach((a) => seenIds.current.add(a.id))
            setIncidents((current) => [...fresh.reverse(), ...current].slice(0, MAX_INCIDENTS))
            setMarks((current) => {
              const next = [...current]
              setHistory((h) => {
                fresh.forEach((a) => next.push({ index: h.length - 1, severity: a.severity }))
                return h
              })
              return next.slice(-60)
            })
            refreshSummary()
          }
        }
      }

      socket.onclose = () => {
        setConnected(false)
        if (!closed) retry = window.setTimeout(connect, 1500)
      }
    }

    connect()
    const summaryTimer = window.setInterval(refreshSummary, 15000)

    return () => {
      closed = true
      window.clearTimeout(retry)
      window.clearInterval(summaryTimer)
      socket?.close()
    }
  }, [enabled, refreshSummary])

  return { connected, stats, playback, incidents, summary, history, updateIncident, refreshSummary, marks }
}
