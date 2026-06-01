import { parseOther, type UsageLog } from '@/lib/logs'
import type { QuotaDataItem } from '@/lib/quota-data'
import type { UsageCostItem } from '@/lib/cost-data'
import type { Period, PeriodKey } from '@/lib/period'

const MINUTE = 60
const HOUR = 3600
const DAY = 24 * HOUR

// Hard cap so an over-fine granularity (e.g. 1-minute over a long range) can't
// generate a runaway number of buckets / DOM nodes.
const MAX_BUCKETS = 1500

export type TrendMetric = 'total' | 'input' | 'output' | 'cached'

export interface BucketSpec {
  count: number
  sizeSec: number
  labels: string[]
}

export interface Granularity {
  sec: number
  label: string
}

const GRANULARITY_OPTIONS: Granularity[] = [
  { sec: MINUTE, label: '1m' },
  { sec: 5 * MINUTE, label: '5m' },
  { sec: HOUR, label: '1h' },
  { sec: DAY, label: '1d' },
]

// Granularities that yield a sensible bucket count for the given window. Used
// to populate the trend chart's granularity selector (alongside an "Auto"
// default that defers to pickBuckets' per-preset choice).
export function availableGranularities(period: Period): Granularity[] {
  const span = Math.max(1, period.end - period.start)
  return GRANULARITY_OPTIONS.filter((g) => {
    const count = span / g.sec
    return count >= 4 && count <= MAX_BUCKETS
  })
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Build a spec for an explicit bucket size (the granularity-selector path).
// Labels adapt to the size: minute → HH:MM, hour → HH:00 (prefixed with the
// date when the window spans multiple days), day+ → M/D.
function specFromSize(period: Period, sizeSec: number): BucketSpec {
  const start = period.start
  const span = Math.max(1, period.end - period.start)
  const count = Math.max(1, Math.min(Math.ceil(span / sizeSec), MAX_BUCKETS))
  const multiDay = span > 2 * DAY
  const labels: string[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date((start + i * sizeSec) * 1000)
    if (sizeSec < HOUR) {
      labels.push(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
    } else if (sizeSec < DAY) {
      labels.push(
        multiDay
          ? `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}h`
          : `${pad2(d.getHours())}:00`
      )
    } else {
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`)
    }
  }
  return { count, sizeSec, labels }
}

// Pick a bucket granularity that gives a reasonable number of points for each
// preset. The labels are tuned for the x-axis density. Passing sizeSecOverride
// (from the granularity selector) bypasses the per-preset defaults.
export function pickBuckets(period: Period, sizeSecOverride?: number): BucketSpec {
  if (sizeSecOverride && sizeSecOverride > 0) {
    return specFromSize(period, sizeSecOverride)
  }
  const start = period.start
  const labels: string[] = []
  let count: number
  let sizeSec: number

  switch (period.key as PeriodKey) {
    case 'today':
    case 'yesterday':
      count = 24
      sizeSec = HOUR
      for (let i = 0; i < count; i++) {
        const d = new Date((start + i * sizeSec) * 1000)
        labels.push(`${String(d.getHours()).padStart(2, '0')}:00`)
      }
      break
    case '7d':
      count = 7
      sizeSec = DAY
      for (let i = 0; i < count; i++) {
        const d = new Date((start + i * sizeSec) * 1000)
        labels.push(`${d.getMonth() + 1}/${d.getDate()}`)
      }
      break
    case '30d':
      count = 30
      sizeSec = DAY
      for (let i = 0; i < count; i++) {
        const d = new Date((start + i * sizeSec) * 1000)
        labels.push(`${d.getMonth() + 1}/${d.getDate()}`)
      }
      break
    case 'all':
    default: {
      // Roughly monthly buckets across ~365 days.
      count = 12
      sizeSec = Math.floor((period.end - period.start) / count)
      for (let i = 0; i < count; i++) {
        const d = new Date((start + i * sizeSec) * 1000)
        labels.push(`${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`)
      }
      break
    }
  }
  return { count, sizeSec, labels }
}

export interface MetricBucket {
  total: number
  input: number
  output: number
  cached: number
  cost: number
  requests: number // log count in this bucket
}

function emptyBucket(): MetricBucket {
  return { total: 0, input: 0, output: 0, cached: 0, cost: 0, requests: 0 }
}

function bucketIndex(
  ts: number,
  start: number,
  sizeSec: number,
  count: number
): number {
  if (ts < start) return -1
  const idx = Math.floor((ts - start) / sizeSec)
  if (idx < 0 || idx >= count) return -1
  return idx
}

function addLog(target: MetricBucket, log: UsageLog): void {
  const input = Number(log.prompt_tokens) || 0
  const output = Number(log.completion_tokens) || 0
  target.input += input
  target.output += output
  target.total += input + output
  target.requests += 1
  const other = parseOther(log.other)
  const cached =
    Number(other.cached_input_tokens) || Number(other.cache_tokens) || 0
  target.cached += cached
}

function addQuota(target: MetricBucket, row: QuotaDataItem): void {
  target.total += Number(row.token_used) || 0
  target.requests += Number(row.count) || 0
}

function addCost(target: MetricBucket, row: UsageCostItem): void {
  target.cost += Number(row.cost_usd) || 0
}

// Aggregate-mode bucketing: one series for the whole dataset.
export function bucketLogs(
  logs: UsageLog[],
  period: Period,
  granularitySec?: number
): { spec: BucketSpec; buckets: MetricBucket[] } {
  const spec = pickBuckets(period, granularitySec)
  const buckets = Array.from({ length: spec.count }, emptyBucket)
  for (const log of logs) {
    const idx = bucketIndex(log.created_at, period.start, spec.sizeSec, spec.count)
    if (idx < 0) continue
    addLog(buckets[idx], log)
  }
  return { spec, buckets }
}

export function bucketQuotaData(
  rows: QuotaDataItem[],
  period: Period,
  granularitySec?: number
): { spec: BucketSpec; buckets: MetricBucket[] } {
  const spec = pickBuckets(period, granularitySec)
  const buckets = Array.from({ length: spec.count }, emptyBucket)
  for (const row of rows) {
    const idx = bucketIndex(row.created_at, period.start, spec.sizeSec, spec.count)
    if (idx < 0) continue
    addQuota(buckets[idx], row)
  }
  return { spec, buckets }
}

export function applyCostDataToBuckets(
  buckets: MetricBucket[],
  rows: UsageCostItem[],
  period: Period,
  spec: BucketSpec
): void {
  for (const row of rows) {
    const idx = bucketIndex(row.created_at, period.start, spec.sizeSec, spec.count)
    if (idx < 0) continue
    addCost(buckets[idx], row)
  }
}

export interface ModelSeries {
  model: string
  color: string
  buckets: MetricBucket[]
  // sum across the whole window for sorting / legend
  totalTokens: number
}

// Per-model bucketing for the "By model" view. Keeps the top-N models by
// total tokens and lumps the rest into an "Others" series so the chart
// stays legible.
export function bucketLogsByModel(
  logs: UsageLog[],
  period: Period,
  palette: string[],
  topN = 4,
  granularitySec?: number
): { spec: BucketSpec; series: ModelSeries[] } {
  const spec = pickBuckets(period, granularitySec)

  // First pass: tally per-model totals to pick the top N.
  const tally = new Map<string, number>()
  for (const log of logs) {
    const model = log.model_name || 'unknown'
    const input = Number(log.prompt_tokens) || 0
    const output = Number(log.completion_tokens) || 0
    tally.set(model, (tally.get(model) ?? 0) + input + output)
  }
  const ranked = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])
  const topModels = new Set(ranked.slice(0, topN).map((e) => e[0]))
  const hasOthers = ranked.length > topN

  // Allocate buckets per kept model + Others.
  const series: ModelSeries[] = []
  const seriesByKey = new Map<string, ModelSeries>()
  ranked.slice(0, topN).forEach(([model, total], i) => {
    const entry: ModelSeries = {
      model,
      color: palette[i % palette.length],
      buckets: Array.from({ length: spec.count }, emptyBucket),
      totalTokens: total,
    }
    series.push(entry)
    seriesByKey.set(model, entry)
  })
  let othersEntry: ModelSeries | null = null
  if (hasOthers) {
    othersEntry = {
      model: `Others (${ranked.length - topN})`,
      color: '#AEAEB2',
      buckets: Array.from({ length: spec.count }, emptyBucket),
      totalTokens: ranked.slice(topN).reduce((s, [, v]) => s + v, 0),
    }
    series.push(othersEntry)
  }

  // Second pass: fill buckets.
  for (const log of logs) {
    const idx = bucketIndex(log.created_at, period.start, spec.sizeSec, spec.count)
    if (idx < 0) continue
    const model = log.model_name || 'unknown'
    const target = topModels.has(model)
      ? seriesByKey.get(model)!
      : othersEntry
    if (!target) continue
    addLog(target.buckets[idx], log)
  }

  return { spec, series }
}

export function bucketQuotaDataByModel(
  rows: QuotaDataItem[],
  period: Period,
  palette: string[],
  topN = 4,
  granularitySec?: number
): { spec: BucketSpec; series: ModelSeries[] } {
  const spec = pickBuckets(period, granularitySec)

  const tally = new Map<string, number>()
  for (const row of rows) {
    const model = row.model_name || 'unknown'
    tally.set(model, (tally.get(model) ?? 0) + (Number(row.token_used) || 0))
  }
  const ranked = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])
  const topModels = new Set(ranked.slice(0, topN).map((e) => e[0]))
  const hasOthers = ranked.length > topN

  const series: ModelSeries[] = []
  const seriesByKey = new Map<string, ModelSeries>()
  ranked.slice(0, topN).forEach(([model, total], i) => {
    const entry: ModelSeries = {
      model,
      color: palette[i % palette.length],
      buckets: Array.from({ length: spec.count }, emptyBucket),
      totalTokens: total,
    }
    series.push(entry)
    seriesByKey.set(model, entry)
  })
  let othersEntry: ModelSeries | null = null
  if (hasOthers) {
    othersEntry = {
      model: `Others (${ranked.length - topN})`,
      color: '#AEAEB2',
      buckets: Array.from({ length: spec.count }, emptyBucket),
      totalTokens: ranked.slice(topN).reduce((s, [, v]) => s + v, 0),
    }
    series.push(othersEntry)
  }

  for (const row of rows) {
    const idx = bucketIndex(row.created_at, period.start, spec.sizeSec, spec.count)
    if (idx < 0) continue
    const model = row.model_name || 'unknown'
    const target = topModels.has(model)
      ? seriesByKey.get(model)!
      : othersEntry
    if (!target) continue
    addQuota(target.buckets[idx], row)
  }

  return { spec, series }
}

export function pickMetric(b: MetricBucket, metric: TrendMetric): number {
  switch (metric) {
    case 'input': return b.input
    case 'output': return b.output
    case 'cached': return b.cached
    case 'total':
    default: return b.total
  }
}

// Generate an SVG path for a small sparkline (KPI card mini-chart).
// Output viewBox is 160×42, with a 2px vertical inset so the line never
// touches the top/bottom edge.
export function buildSparkPath(values: number[]): string {
  if (values.length === 0) return ''
  const W = 160
  const H = 42
  const TOP_PAD = 4
  const BOT_PAD = 4
  const max = Math.max(...values, 1)
  const stepX = values.length > 1 ? W / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const x = values.length > 1 ? i * stepX : W / 2
      const y = H - BOT_PAD - (v / max) * (H - TOP_PAD - BOT_PAD)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}
