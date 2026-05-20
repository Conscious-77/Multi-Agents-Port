import { useEffect, useState } from 'react'
import { readUser } from '@/lib/auth'
import { fetchLogs, parseOther, type UsageLog } from '@/lib/logs'
import type { Period } from '@/lib/period'

const ROLE_ADMIN = 10

export interface KpiPeriodTotals {
  total: number
  input: number
  output: number
  cached: number
  cacheHitRate: number // cached / input, range [0, 1]; 0 if input is 0
  cost: number // sum of quota
  requests: number
  cachedRequests: number // logs whose response contained any cached tokens
}

export interface ModelStats {
  model: string
  calls: number
  tokens: number
}

export interface ProviderStats {
  provider: string
  calls: number
  tokens: number
  input: number
  output: number
  cached: number
  cost: number
}

export interface KpiData {
  current: KpiPeriodTotals
  previous: KpiPeriodTotals
  // per-model rollup of the current window, sorted desc by tokens
  byModel: ModelStats[]
  // per-provider rollup; provider comes from .cc ingest's other.provider —
  // only ingest-tagged logs contribute, which is exactly what we want.
  byProvider: ProviderStats[]
  // raw current-window logs so the trend chart can bucket them locally;
  // surfaced here to avoid issuing a second /api/log request for the chart.
  currentItems: UsageLog[]
  // window meta — useful for UI hints ("Sampled from N of M logs")
  windowStart: number
  windowEnd: number
  pageTotal: number
  sampleSize: number
  truncated: boolean
}

export interface UseKpiDataResult {
  data: KpiData | null
  loading: boolean
  error: string | null
}

function emptyTotals(): KpiPeriodTotals {
  return {
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    cacheHitRate: 0,
    cost: 0,
    requests: 0,
    cachedRequests: 0,
  }
}

function accumulate(bucket: KpiPeriodTotals, log: UsageLog): void {
  const input = Number(log.prompt_tokens) || 0
  const output = Number(log.completion_tokens) || 0
  bucket.input += input
  bucket.output += output
  bucket.total += input + output
  bucket.cost += Number(log.quota) || 0
  bucket.requests += 1

  const other = parseOther(log.other)
  // Prefer ConnectMulti ingest field; fall back to NewAPI native cache_tokens
  // so Claude / Gemini logs (which go through NewAPI's own relay) still count.
  const cached =
    Number(other.cached_input_tokens) || Number(other.cache_tokens) || 0
  bucket.cached += cached
  if (cached > 0) bucket.cachedRequests += 1
}

function finalize(bucket: KpiPeriodTotals): void {
  bucket.cacheHitRate = bucket.input > 0 ? bucket.cached / bucket.input : 0
}

function rollupByModel(logs: UsageLog[]): ModelStats[] {
  const map = new Map<string, ModelStats>()
  for (const log of logs) {
    const model = log.model_name || 'unknown'
    const input = Number(log.prompt_tokens) || 0
    const output = Number(log.completion_tokens) || 0
    const entry = map.get(model) ?? { model, calls: 0, tokens: 0 }
    entry.calls += 1
    entry.tokens += input + output
    map.set(model, entry)
  }
  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens)
}

function rollupByProvider(logs: UsageLog[]): ProviderStats[] {
  const map = new Map<string, ProviderStats>()
  for (const log of logs) {
    const other = parseOther(log.other)
    // Skip logs not written through the .cc ingest path; we only want the
    // proxy's view of providers, not whatever NewAPI relayed natively.
    if (!other.provider) continue
    const provider = other.provider
    const input = Number(log.prompt_tokens) || 0
    const output = Number(log.completion_tokens) || 0
    const cached =
      Number(other.cached_input_tokens) || Number(other.cache_tokens) || 0
    const entry =
      map.get(provider) ??
      { provider, calls: 0, tokens: 0, input: 0, output: 0, cached: 0, cost: 0 }
    entry.calls += 1
    entry.input += input
    entry.output += output
    entry.tokens += input + output
    entry.cached += cached
    entry.cost += Number(log.quota) || 0
    map.set(provider, entry)
  }
  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens)
}

// Pulls consume logs for the selected period AND a same-length previous
// window in two requests, then aggregates each into a KpiPeriodTotals so the
// cards can render value + delta.
//
// Single-window endpoints would force us to fetch one combined range and
// split client-side, which is fragile when the API caps at page_size=1000
// rows; two scoped requests keeps each query targeting roughly half the
// data.
export function useKpiData(period: Period): UseKpiDataResult {
  const [data, setData] = useState<KpiData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const user = readUser()
    const scope: 'self' | 'admin' =
      user && (user.role ?? 0) >= ROLE_ADMIN ? 'admin' : 'self'

    const hasPrev = period.prevEnd > 0 && period.prevStart > 0

    const currentReq = fetchLogs({
      startTimestamp: period.start,
      endTimestamp: period.end,
      pageSize: 1000,
      type: 2,
      scope,
    })
    const prevReq = hasPrev
      ? fetchLogs({
          startTimestamp: period.prevStart,
          endTimestamp: period.prevEnd,
          pageSize: 1000,
          type: 2,
          scope,
        })
      : Promise.resolve({ success: true, data: { items: [], total: 0, page: 1, page_size: 0 } })

    Promise.all([currentReq, prevReq])
      .then(([curr, prev]) => {
        if (cancelled) return
        if (!curr.success || !curr.data) {
          setError(curr.message ?? 'failed to load logs')
          setLoading(false)
          return
        }
        const currentItems = curr.data.items ?? []
        const previousItems = prev.success && prev.data ? prev.data.items ?? [] : []

        const current = emptyTotals()
        const previous = emptyTotals()
        for (const log of currentItems) accumulate(current, log)
        for (const log of previousItems) accumulate(previous, log)
        finalize(current)
        finalize(previous)

        setData({
          current,
          previous,
          byModel: rollupByModel(currentItems),
          byProvider: rollupByProvider(currentItems),
          currentItems,
          windowStart: period.start,
          windowEnd: period.end,
          pageTotal: curr.data.total ?? currentItems.length,
          sampleSize: currentItems.length,
          truncated: (curr.data.total ?? 0) > currentItems.length,
        })
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [period.start, period.end, period.prevStart, period.prevEnd])

  return { data, loading, error }
}
