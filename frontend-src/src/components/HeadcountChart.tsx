/**
 * Headcount over time, with a marker wherever an incident fired.
 *
 * The markers are the point of this panel. Without them the chart and the
 * incident queue are two unrelated boxes; with them a reader watches the
 * count climb, sees the marker where the threshold broke, and finds that same
 * incident in the queue beside it. One story instead of three.
 */

import {
  CategoryScale, Chart as ChartJS, Filler, Legend, LinearScale,
  LineElement, PointElement, Tooltip, type Plugin,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend)

interface Props {
  history: { time: number; total: number }[]
  marks: { index: number; severity: string }[]
  current: number
}

const MARK_COLOUR: Record<string, string> = {
  CRITICAL: '#ff4d4d',
  WARNING: '#ffd43b',
  INFO: '#3ad6ff',
}

export function HeadcountChart({ history, marks, current }: Props) {
  const labels = history.map((p) => new Date(p.time).toLocaleTimeString([], { hour12: false }))

  // Drawn after the dataset so the markers sit on top of the line.
  const markerPlugin: Plugin<'line'> = {
    id: 'incidentMarkers',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart
      if (!chartArea) return
      for (const mark of marks) {
        if (mark.index < 0 || mark.index >= labels.length) continue
        const x = scales.x.getPixelForValue(mark.index)
        if (x < chartArea.left || x > chartArea.right) continue
        ctx.save()
        ctx.strokeStyle = MARK_COLOUR[mark.severity] ?? '#4f9168'
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(x, chartArea.top)
        ctx.lineTo(x, chartArea.bottom)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = ctx.strokeStyle
        ctx.fillRect(x - 2, chartArea.top, 4, 4)
        ctx.restore()
      }
    },
  }

  return (
    <div className="flex h-full flex-col">
      <header className="mb-1.5 flex items-baseline gap-3">
        <h2 className="m-0 font-bold tracking-[0.1em] scale-text">HEADCOUNT</h2>
        <span className="text-muted" style={{ fontSize: '11.5px' }}>last 10 minutes</span>
        <span className="ml-auto leading-none tabular-nums text-sig scale-text" style={{ fontSize: '19px' }}>
          {current}
          <small className="ml-1.5 text-muted" style={{ fontSize: '11.5px' }}>IN VIEW</small>
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        <Line
          plugins={[markerPlugin]}
          data={{
            labels,
            datasets: [{
              data: history.map((p) => p.total),
              borderColor: '#00ff66',
              borderWidth: 1.75,
              fill: true,
              backgroundColor: (context) => {
                const { chart } = context
                if (!chart.chartArea) return 'rgba(0,255,102,0.10)'
                const gradient = chart.ctx.createLinearGradient(
                  0, chart.chartArea.top, 0, chart.chartArea.bottom)
                gradient.addColorStop(0, 'rgba(0,255,102,0.26)')
                gradient.addColorStop(1, 'rgba(0,255,102,0)')
                return gradient
              },
              tension: 0.32,
              pointRadius: 0,
              pointHoverRadius: 4,
            }],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 200 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: '#03120a', borderColor: '#0d3b20', borderWidth: 1,
                titleColor: '#4f9168', bodyColor: '#b9ffcf', displayColors: false, padding: 9,
                titleFont: { family: 'monospace' }, bodyFont: { family: 'monospace' },
                callbacks: { label: (item) => `${item.parsed.y} people` },
              },
            },
            scales: {
              x: {
                grid: { display: false },
                border: { color: '#0d3b20' },
                ticks: { color: '#4f9168', maxTicksLimit: 6, font: { size: 10, family: 'monospace' } },
              },
              y: {
                beginAtZero: true,
                grid: { color: '#07240f' },
                border: { display: false },
                ticks: { color: '#4f9168', precision: 0, font: { size: 10, family: 'monospace' } },
              },
            },
          }}
        />
      </div>
    </div>
  )
}
