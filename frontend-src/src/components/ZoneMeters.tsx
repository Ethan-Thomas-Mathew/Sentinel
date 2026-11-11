/**
 * Zone capacity meters.
 *
 * The one deliberately bold element on this dashboard. Capacity is shown as
 * discrete lit segments, like the LED bar meter on physical broadcast gear,
 * with a notch marking the configured limit. "How close are we to the limit"
 * is then readable at a glance from across a control room, which is this
 * screen's entire job — a number alone makes you read and compare, a bar
 * with a redline you simply see.
 */

import type { ZoneStat } from '../types'

const SEGMENTS = 20
const REDLINE_AT = 0.75   // the limit sits 75% along, leaving overflow headroom

export function ZoneMeters({ zones }: { zones: ZoneStat[] }) {
  if (!zones.length) {
    return (
      <p className="py-1.5 text-muted" style={{ fontSize: '11.5px' }}>
        No zones yet. Click EDIT ZONES to draw one, or AUTO to let SENTINEL propose one.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {zones.map((zone) => (
        <ZoneMeter key={zone.name} zone={zone} />
      ))}
    </div>
  )
}

function ZoneMeter({ zone }: { zone: ZoneStat }) {
  const breached = zone.over_capacity

  // A restricted zone has no capacity to fill, so its meter reads as "any
  // occupancy at all is a breach" rather than a proportion of a limit.
  const fullScale = zone.restricted ? 4 : zone.capacity / REDLINE_AT
  const lit = Math.min(SEGMENTS, Math.round((zone.count / (fullScale || 1)) * SEGMENTS))

  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className={`font-bold tracking-[0.04em] scale-text ${breached ? 'text-crit' : ''}`}>
          {zone.name}
        </span>
        {zone.restricted && (
          <span className="rounded-sm border border-crit/50 px-1.5 text-crit" style={{ fontSize: '11.5px' }}>
            RESTRICTED
          </span>
        )}
        <span className={`ml-auto tabular-nums scale-text ${breached ? 'text-crit' : 'text-sig'}`}
              style={{ fontSize: '15px' }}>
          {zone.count}
          <span className="text-muted" style={{ fontSize: '11.5px' }}>
            {zone.restricted ? ' / 0' : ` / ${zone.capacity}`}
          </span>
        </span>
      </div>

      <div className="relative flex h-[22px] gap-[2px]">
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const on = i < lit
          const position = (i + 1) / SEGMENTS
          const colour = !on
            ? 'bg-[#07240f]'
            : zone.restricted || position > REDLINE_AT
              ? 'bg-crit'
              : position > REDLINE_AT * 0.8
                ? 'bg-warn'
                : 'bg-sig'
          return <i key={i} className={`flex-1 rounded-[1px] transition-colors duration-150 ${colour}`} />
        })}
        <span
          className="absolute -top-[3px] -bottom-[3px] w-px bg-muted opacity-80"
          style={{ left: `calc(${REDLINE_AT * 100}% - 1px)` }}
        />
      </div>

      <div className="mt-1.5 flex items-baseline gap-2 text-muted" style={{ fontSize: '11.5px' }}>
        LONGEST STAY <b className="font-normal text-body">{zone.longest_dwell}s</b>
      </div>
    </div>
  )
}
