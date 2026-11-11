/**
 * Every call to the backend lives here.
 *
 * Components never build a URL themselves. That keeps the API surface
 * visible in one file, and means a change to an endpoint is a change in one
 * place rather than a search through the whole app.
 */

import type { Incident, Summary, Unit, Zone } from './types'

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

const post = (url: string, init?: RequestInit) =>
  fetch(url, { method: 'POST', ...init })

export const api = {
  // --- history -------------------------------------------------------
  history: () =>
    fetch('/api/history?minutes=10').then(json<{ timestamp: number; total: number }[]>),
  incidents: (limit = 30) =>
    fetch(`/api/alerts?limit=${limit}`).then(json<Incident[]>),
  summary: () => fetch('/api/summary').then(json<Summary>),

  // --- zones ---------------------------------------------------------
  zones: () => fetch('/api/zones').then(json<Zone[]>),
  saveZones: (zones: Zone[]) =>
    post('/api/zones', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(zones),
    }),
  autoZone: (replace = false) =>
    post(`/api/zones/auto?replace=${replace}`).then(json<{ started: boolean }>),

  // --- playback ------------------------------------------------------
  pause: (paused: boolean) => post(`/api/playback/pause?paused=${paused}`),
  restart: () => post('/api/playback/restart'),
  seek: (frame: number) => post(`/api/playback/seek?frame=${frame}`),

  // --- overlays ------------------------------------------------------
  heatmap: (enabled: boolean) => post(`/api/heatmap?enabled=${enabled}`),
  flow: (enabled: boolean) => post(`/api/flow?enabled=${enabled}`),

  // --- Track B: response units and dispatch ---------------------------
  units: () => fetch('/api/units').then(json<Unit[]>),
  saveUnits: (units: Unit[]) =>
    post('/api/units', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(units),
    }),
  suggestUnit: (id: number) =>
    fetch(`/api/alerts/${id}/suggest`).then(json<{ name?: string; distance_px?: number }>),
  setStatus: (id: number, status: string) =>
    post(`/api/alerts/${id}/status?status=${status}`).then(json<Incident>),
  dispatch: (id: number, unit = '') =>
    post(`/api/alerts/${id}/dispatch?unit=${encodeURIComponent(unit)}`).then(json<Incident>),

  // --- video sources --------------------------------------------------
  videos: () =>
    fetch('/api/videos').then(
      json<{ current: string; videos: { name: string; size_mb: number }[] }>,
    ),
  selectVideo: (name: string) =>
    post(`/api/videos/select?name=${encodeURIComponent(name)}`),
  uploadVideo: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return post('/api/videos/upload', { body: form })
  },
}
