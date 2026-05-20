import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { UsageLog } from '@/lib/logs'
import { formatNumber } from '@/lib/format'
import type { Period } from '@/lib/period'
import {
  bucketLogs,
  bucketLogsByModel,
  pickMetric,
  type MetricBucket,
  type ModelSeries,
  type TrendMetric,
} from './bucketing'

type ChartType = 'line' | 'bar'

interface TrendChartProps {
  logs: UsageLog[]
  period: Period
  loading?: boolean
  palette: string[]
}

const METRIC_COLOR: Record<TrendMetric, string> = {
  total: '#6fa6ff',
  input: '#66d0ad',
  output: '#b078ff',
  cached: '#ffad65',
}

const METRIC_LABEL: Record<TrendMetric, string> = {
  total: 'Total',
  input: 'Input',
  output: 'Output',
  cached: 'Cached',
}

function labelStride(count: number): number {
  if (count <= 8) return 1
  if (count <= 14) return 2
  if (count <= 24) return 3
  return Math.ceil(count / 8)
}

export function TrendChart(props: TrendChartProps) {
  const [metric, setMetric] = useState<TrendMetric>('total')
  const [chartType, setChartType] = useState<ChartType>('line')
  const [byModel, setByModel] = useState<boolean>(false)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const aggregate = useMemo(
    () => bucketLogs(props.logs, props.period),
    [props.logs, props.period]
  )
  const grouped = useMemo(
    () =>
      byModel
        ? bucketLogsByModel(props.logs, props.period, props.palette)
        : null,
    [byModel, props.logs, props.period, props.palette]
  )

  const series: ModelSeries[] = useMemo(() => {
    if (byModel && grouped) return grouped.series
    return [
      {
        model: METRIC_LABEL[metric] + ' Tokens',
        color: METRIC_COLOR[metric],
        buckets: aggregate.buckets,
        totalTokens: aggregate.buckets.reduce((s, b) => s + pickMetric(b, metric), 0),
      },
    ]
  }, [byModel, grouped, aggregate, metric])

  const spec = byModel && grouped ? grouped.spec : aggregate.spec
  const hasData = series.some((s) => s.buckets.some((b) => pickMetric(b, metric) > 0))

  // Hoisted so SVG and Y-axis labels share the same scale; the *1.12 headroom
  // keeps lines / bars from kissing the top of the panel.
  const chartMax = useMemo(() => {
    let m = 0
    for (const s of series) {
      for (const b of s.buckets) {
        const v = pickMetric(b, metric)
        if (v > m) m = v
      }
    }
    return m > 0 ? m * 1.12 : 1
  }, [series, metric])

  // Clear stale hover when the chart shape changes; the old index no longer
  // points at the same bucket / series.
  useEffect(() => {
    setHoverIdx(null)
  }, [metric, chartType, byModel, props.period.key])

  // Composite key used by AnimatePresence to cross-fade between chart layouts.
  const chartKey = `${chartType}-${metric}-${byModel ? 'm' : 'a'}-${props.period.key}`

  return (
    <div className='panel glass panel-pad trend-panel'>
      <div className='panel-title'>
        Token Usage Trend
        <span className='panel-sub'>· {props.period.label}</span>
      </div>

      <div className='chart-controls'>
        {(['total', 'input', 'output', 'cached'] as TrendMetric[]).map((m) => (
          <span
            key={m}
            className={m === metric ? 'on' : ''}
            onClick={() => setMetric(m)}
            role='button'
          >
            {METRIC_LABEL[m]}
          </span>
        ))}
      </div>

      <div
        className='filter'
        onClick={() => setChartType(chartType === 'line' ? 'bar' : 'line')}
        role='button'
        title='Toggle chart type'
      >
        {chartType === 'line' ? <LineIcon /> : <BarIcon />}
      </div>

      <div className='trend-toolbar'>
        <div className='legend trend-legend'>
          {series.map((s) => (
            <span key={s.model}>
              <i style={{ background: s.color }} />
              {s.model}
            </span>
          ))}
        </div>
        <button
          type='button'
          className={`trend-toggle${byModel ? ' on' : ''}`}
          onClick={() => setByModel((v) => !v)}
        >
          {byModel ? 'By model' : 'Aggregated'}
        </button>
      </div>

      <div className='trend-wrap'>
        {props.loading ? (
          <div className='trend-status'>loading…</div>
        ) : !hasData ? (
          <div className='trend-status'>no data in this window</div>
        ) : (
          <>
            <TrendYAxisLabels max={chartMax} />
            <div className='trend-chart-area'>
              <AnimatePresence mode='popLayout' initial={false}>
                <motion.div
                  key={chartKey}
                  className='trend-chart-layer'
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  {chartType === 'line' ? (
                    <LineChartSvg
                      series={series}
                      metric={metric}
                      spec={spec}
                      max={chartMax}
                      hoverIdx={hoverIdx}
                      onHoverChange={setHoverIdx}
                    />
                  ) : (
                    <BarChartSvg
                      series={series}
                      metric={metric}
                      spec={spec}
                      max={chartMax}
                      hoverIdx={hoverIdx}
                      onHoverChange={setHoverIdx}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
              <TrendAxisLabels spec={spec} />
              {/* DOM-level guide line so its horizontal position can be CSS-
                  transitioned smoothly as the cursor moves between columns. */}
              <div
                className={`trend-vline${hoverIdx !== null ? ' active' : ''}`}
                style={{ left: `${(xAt(hoverIdx ?? 0, spec.count) / W) * 100}%` }}
              />
              {hoverIdx !== null && (
                <TrendTooltip
                  idx={hoverIdx}
                  series={series}
                  metric={metric}
                  spec={spec}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── SVG primitives ────────────────────────────────────────────────────────

const W = 640
const H = 220
const PAD_LEFT = 4
const PAD_RIGHT = 8
const PAD_TOP = 8
const PAD_BOTTOM = 26

interface ChartSvgProps {
  series: ModelSeries[]
  metric: TrendMetric
  spec: { count: number; labels: string[] }
  max: number
  hoverIdx: number | null
  onHoverChange: (idx: number | null) => void
}

function xAt(idx: number, count: number): number {
  const inner = W - PAD_LEFT - PAD_RIGHT
  if (count <= 1) return PAD_LEFT + inner / 2
  return PAD_LEFT + (idx / (count - 1)) * inner
}

function yAt(value: number, max: number): number {
  const inner = H - PAD_TOP - PAD_BOTTOM
  return PAD_TOP + inner - (value / max) * inner
}

function GridLines() {
  const inner = H - PAD_TOP - PAD_BOTTOM
  const lines = [0.25, 0.5, 0.75, 1].map((t) => PAD_TOP + inner * (1 - t))
  return (
    <>
      {lines.map((y) => (
        <line
          key={y}
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={y}
          y2={y}
          stroke='rgba(40,55,100,.10)'
          strokeWidth='1'
        />
      ))}
    </>
  )
}

// X-axis labels are rendered as DOM nodes overlaid on the SVG so they don't
// get horizontally stretched by `preserveAspectRatio='none'`. This component
// is exported and rendered once in TrendChart, outside of the SVG.
export function TrendAxisLabels(props: { spec: ChartSvgProps['spec'] }) {
  const stride = labelStride(props.spec.count)
  return (
    <div className='trend-axis-labels'>
      {props.spec.labels.map((label, i) => {
        if (i % stride !== 0 && i !== props.spec.count - 1) return null
        const xPct = (xAt(i, props.spec.count) / W) * 100
        const transform =
          i === 0
            ? 'translateX(0)'
            : i === props.spec.count - 1
              ? 'translateX(-100%)'
              : 'translateX(-50%)'
        return (
          <span
            key={i}
            className='trend-axis-label'
            style={{ left: `${xPct}%`, transform }}
          >
            {label}
          </span>
        )
      })}
    </div>
  )
}

// Wide invisible columns make hovering near the line "snap" to a bucket so the
// tooltip is comfortable to land on.
function HoverColumns(props: Pick<ChartSvgProps, 'spec' | 'onHoverChange' | 'hoverIdx'>) {
  const inner = W - PAD_LEFT - PAD_RIGHT
  const colWidth = inner / Math.max(1, props.spec.count)
  return (
    <g onMouseLeave={() => props.onHoverChange(null)}>
      {props.spec.labels.map((_, i) => (
        <rect
          key={i}
          x={PAD_LEFT + i * colWidth - colWidth / 2}
          y={0}
          width={colWidth}
          height={H}
          fill='transparent'
          onMouseEnter={() => props.onHoverChange(i)}
        />
      ))}
    </g>
  )
}

function LineChartSvg(props: ChartSvgProps) {
  const max = props.max
  const baseY = yAt(0, max)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' style={{ width: '100%', height: '100%' }}>
      <GridLines />

      {/* Area fills first so lines and dots sit on top. */}
      {props.series.map((s, sIdx) => {
        const pts = s.buckets.map((b, i) => ({
          x: xAt(i, props.spec.count),
          y: yAt(pickMetric(b, props.metric), max),
        }))
        const areaD =
          pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
          ` L ${pts[pts.length - 1]!.x.toFixed(1)} ${baseY.toFixed(1)} L ${pts[0]!.x.toFixed(1)} ${baseY.toFixed(1)} Z`
        const opacity = props.series.length === 1 ? 0.22 : 0.08
        return (
          <motion.path
            key={`area-${s.model}-${sIdx}`}
            d={areaD}
            fill={s.color}
            initial={{ opacity: 0 }}
            animate={{ opacity }}
            transition={{ duration: 0.45, ease: 'easeOut', delay: 0.25 + sIdx * 0.05 }}
          />
        )
      })}

      {/* Lines — drawn with a path-length sweep */}
      {props.series.map((s, sIdx) => {
        const path = s.buckets
          .map((b, i) => {
            const x = xAt(i, props.spec.count)
            const y = yAt(pickMetric(b, props.metric), max)
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
          })
          .join(' ')
        return (
          <motion.path
            key={`line-${s.model}-${sIdx}`}
            d={path}
            fill='none'
            stroke={s.color}
            strokeWidth='2.2'
            strokeLinecap='round'
            strokeLinejoin='round'
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{
              pathLength: { duration: 0.65, ease: 'easeOut', delay: sIdx * 0.05 },
              opacity: { duration: 0.18, delay: sIdx * 0.05 },
            }}
          />
        )
      })}

      {/* Dots at each data point */}
      {props.series.map((s, sIdx) =>
        s.buckets.map((b, i) => {
          const v = pickMetric(b, props.metric)
          if (v <= 0) return null
          const isHover = props.hoverIdx === i
          // r/strokeWidth are plain attributes so CSS transition on .trend-dot
          // can smooth them; mount-time entry stays under motion's control.
          return (
            <motion.circle
              key={`dot-${sIdx}-${i}`}
              className='trend-dot'
              cx={xAt(i, props.spec.count)}
              cy={yAt(v, max)}
              r={isHover ? 4.2 : 2.4}
              fill='#0d2654'
              stroke={s.color}
              strokeWidth={isHover ? 2 : 1.6}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: 0.25,
                delay: 0.45 + sIdx * 0.05 + Math.min(i, 24) * 0.008,
                ease: 'easeOut',
              }}
            />
          )
        })
      )}

      <HoverColumns spec={props.spec} onHoverChange={props.onHoverChange} hoverIdx={props.hoverIdx} />
    </svg>
  )
}

function BarChartSvg(props: ChartSvgProps) {
  const max = props.max
  const inner = W - PAD_LEFT - PAD_RIGHT
  const groupWidth = inner / props.spec.count
  const seriesCount = Math.max(1, props.series.length)
  const barWidth = Math.min(10, (groupWidth * 0.7) / seriesCount)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' style={{ width: '100%', height: '100%' }}>
      <GridLines />

      {props.spec.labels.map((_, i) => {
        const groupCenter = PAD_LEFT + (i + 0.5) * groupWidth
        const groupStart = groupCenter - (barWidth * seriesCount) / 2
        const baselineY = H - PAD_BOTTOM
        return props.series.map((s, sIdx) => {
          const v = pickMetric(s.buckets[i] ?? emptyBucket(), props.metric)
          const y = yAt(v, max)
          const x = groupStart + sIdx * barWidth
          const height = baselineY - y
          if (height <= 0) return null
          const dimmed = props.hoverIdx !== null && props.hoverIdx !== i
          // y/height mount under motion (grow-from-baseline). opacity is
          // hover-driven and handled via the className transition so changing
          // hoverIdx doesn't replay the grow animation.
          return (
            <motion.rect
              key={`bar-${i}-${s.model}-${sIdx}`}
              className={`trend-bar${dimmed ? ' dimmed' : ''}`}
              x={x}
              width={Math.max(1, barWidth - 1)}
              fill={s.color}
              rx={1.5}
              initial={{ y: baselineY, height: 0 }}
              animate={{ y, height }}
              transition={{
                duration: 0.42,
                delay: i * 0.012 + sIdx * 0.04,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          )
        })
      })}

      <HoverColumns spec={props.spec} onHoverChange={props.onHoverChange} hoverIdx={props.hoverIdx} />
    </svg>
  )
}

function emptyBucket(): MetricBucket {
  return { total: 0, input: 0, output: 0, cached: 0, cost: 0, requests: 0 }
}

// ─── Tooltip ───────────────────────────────────────────────────────────────

interface TrendTooltipProps {
  idx: number
  series: ModelSeries[]
  metric: TrendMetric
  spec: { count: number; labels: string[] }
}

function TrendTooltip(props: TrendTooltipProps) {
  // Anchor to the left edge by percentage and shift via transform; this lets
  // CSS smoothly transition `left` as the hovered bucket changes, while a
  // separate transform offsets the tip outward from the guide line. When
  // we're close to the right edge we flip the offset so the tip stays on-
  // screen — the flip itself is rare enough that a hard switch is fine.
  const xPct = (xAt(props.idx, props.spec.count) / W) * 100
  const flipLeft = xPct > 70
  const style: React.CSSProperties = {
    left: `${xPct}%`,
    top: 8,
    transform: flipLeft
      ? 'translateX(calc(-100% - 10px))'
      : 'translateX(10px)',
  }

  const rows = props.series
    .map((s) => ({
      color: s.color,
      label: s.model,
      value: pickMetric(s.buckets[props.idx] ?? emptyBucket(), props.metric),
    }))
    .sort((a, b) => b.value - a.value)

  const subtotal = rows.reduce((s, r) => s + r.value, 0)

  return (
    <div className='trend-tip' style={style}>
      <div className='trend-tip-time'>{props.spec.labels[props.idx]}</div>
      {rows.map((row) => (
        <div key={row.label} className='trend-tip-row'>
          <span className='trend-tip-key'>
            <i style={{ background: row.color }} />
            {row.label}
          </span>
          <b>{formatNumber(row.value)}</b>
        </div>
      ))}
      {rows.length > 1 && (
        <div className='trend-tip-row trend-tip-total'>
          <span className='trend-tip-key'>Subtotal</span>
          <b>{formatNumber(subtotal)}</b>
        </div>
      )}
    </div>
  )
}

// ─── Small icons ───────────────────────────────────────────────────────────

function LineIcon() {
  return (
    <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M3 17l5-7 4 4 7-9' />
      <circle cx='3' cy='17' r='1.2' />
      <circle cx='19' cy='5' r='1.2' />
    </svg>
  )
}

function BarIcon() {
  return (
    <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
      <rect x='4' y='12' width='3.6' height='8' rx='1' />
      <rect x='10.2' y='7' width='3.6' height='13' rx='1' />
      <rect x='16.4' y='4' width='3.6' height='16' rx='1' />
    </svg>
  )
}

// Compact tick label: 1.2K / 3.4M / 5.6B. Y-axis only — the rest of the
// dashboard still uses full-grouped numbers. K/M/B are unavoidable here
// because a 38px column can't fit "1,234,567".
function formatYTick(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}K`
  return Math.round(v).toString()
}

// Y axis as DOM labels, positioned by percentage so they align with the SVG
// grid lines (which sit at PAD_TOP + (1-ratio)*INNER inside the viewBox).
export function TrendYAxisLabels(props: { max: number }) {
  const PAD_TOP_PCT = (PAD_TOP / H) * 100
  const INNER_PCT = ((H - PAD_TOP - PAD_BOTTOM) / H) * 100
  const ratios = [1, 0.75, 0.5, 0.25, 0]
  return (
    <div className='trend-y-labels'>
      {ratios.map((ratio) => {
        const topPct = PAD_TOP_PCT + (1 - ratio) * INNER_PCT
        return (
          <span
            key={ratio}
            className='trend-y-label'
            style={{ top: `${topPct}%` }}
          >
            {formatYTick(props.max * ratio)}
          </span>
        )
      })}
    </div>
  )
}
