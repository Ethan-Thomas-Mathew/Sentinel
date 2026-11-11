/**
 * Shared shapes for everything the backend sends.
 *
 * Writing these down once is the point of using TypeScript here: if the
 * Python side ever renames a field, every component that reads it fails to
 * compile instead of quietly rendering "undefined" in front of a panel.
 */

export interface ZoneStat {
  name: string
  count: number
  capacity: number
  restricted: boolean
  occupancy_pct: number
  over_capacity: boolean
  longest_dwell: number
  centroid: [number, number]
}

export interface Stats {
  timestamp: number
  total_people: number
  zones: ZoneStat[]
  fps: number
  processing_ms: number
  heatmap_on: boolean
  flow_on: boolean
}

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO'
export type IncidentStatus = 'NEW' | 'ACKNOWLEDGED' | 'DISPATCHED' | 'RESOLVED'

export interface Incident {
  id: number
  timestamp: number
  zone: string
  type: 'CONGESTION' | 'INTRUSION' | 'DWELL' | 'CLEARED'
  severity: Severity
  message: string
  count: number
  snapshot: string | null
  status: IncidentStatus
  assigned_unit: string | null
  dispatched_at?: number | null
}

export interface Playback {
  is_camera: boolean
  paused: boolean
  position: number
  total_frames: number
  source_fps: number
  source_name: string
  autozone: 'idle' | 'running' | 'done' | 'failed'
}

export interface Summary {
  alerts_last_hour: number
  critical_last_hour: number
  peak_headcount: number
  open_incidents: number
}

/** A zone as it is stored and edited — points are frame pixels. */
export interface Zone {
  name: string
  capacity: number
  restricted: boolean
  points: [number, number][]
}

export interface Unit {
  name: string
  position: [number, number]
  available: boolean
}

export interface LivePayload {
  stats: Stats | Record<string, never>
  alerts: Incident[]
  playback: Playback
}

export type Tool = 'polygon' | 'rectangle' | 'square' | 'circle'
