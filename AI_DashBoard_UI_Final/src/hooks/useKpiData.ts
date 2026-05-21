import { useEffect, useState } from 'react'
import { readUser } from '@/lib/auth'
import { fetchLogs, parseOther, type UsageLog } from '@/lib/logs'
import { fetchQuotaData, type QuotaDataItem } from '@/lib/quota-data'
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
  // NewAPI's /api/data aggregate rows. These are the authoritative source for
  // total tokens, request counts, cost, model distribution, and token trend so
  // this dashboard matches web-synthex /dashboard/models.
  currentQuotaItems: QuotaDataItem[]
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

function accumulateLogDetails(bucket: KpiPeriodTotals, log: UsageLog): void {
  const input = Number(log.prompt_tokens) || 0
  const output = Number(log.completion_tokens) || 0
  bucket.input += input
  bucket.output += output

  const other = parseOther(log.other)
  // Prefer ConnectMulti ingest field; fall back to NewAPI native cache_tokens
  // so Claude / Gemini logs (which go through NewAPI's own relay) still count.
  const cached =
    Number(other.cached_input_tokens) || Number(other.cache_tokens) || 0
  bucket.cached += cached
  if (cached > 0) bucket.cachedRequests += 1
}

function accumulateQuota(bucket: KpiPeriodTotals, row: QuotaDataItem): void {
  bucket.total += Number(row.token_used) || 0
  bucket.cost += Number(row.quota) || 0
  bucket.requests += Number(row.count) || 0
}

function finalize(bucket: KpiPeriodTotals): void {
  bucket.cacheHitRate = bucket.input > 0 ? bucket.cached / bucket.input : 0
}

function rollupQuotaByModel(rows: QuotaDataItem[]): ModelStats[] {
  const map = new Map<string, ModelStats>()
  for (const row of rows) {
    const model = row.model_name || 'unknown'
    const entry = map.get(model) ?? { model, calls: 0, tokens: 0 }
    entry.calls += Number(row.count) || 0
    entry.tokens += Number(row.token_used) || 0
    map.set(model, entry)
  }
  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens)
}

function rollupByProvider(
  logs: UsageLog[],
  authoritativeTotals?: KpiPeriodTotals
): ProviderStats[] {
  const map = new Map<string, ProviderStats>()
  for (const log of logs) {
    const other = parseOther(log.other)
    // Provider is only persisted in logs.other. quota_data does not carry this
    // dimension, so provider attribution is log-derived and then reconciled
    // against the authoritative /api/data totals below.
    if (!other.provider) continue
    const provider = other.provider
    const input = Number(log.prompt_tokens) || 0
    const output = Number(log.completion_tokens) || 0
    const total = Number(other.total_tokens) || input + output
    const cached =
      Number(other.cached_input_tokens) || Number(other.cache_tokens) || 0
    const entry =
      map.get(provider) ??
      { provider, calls: 0, tokens: 0, input: 0, output: 0, cached: 0, cost: 0 }
    entry.calls += 1
    entry.input += input
    entry.output += output
    entry.tokens += total
    entry.cached += cached
    entry.cost += Number(log.quota) || 0
    map.set(provider, entry)
  }

  const rows = Array.from(map.values())
  if (authoritativeTotals) {
    const attributed = rows.reduce(
      (acc, row) => ({
        calls: acc.calls + row.calls,
        tokens: acc.tokens + row.tokens,
        input: acc.input + row.input,
        output: acc.output + row.output,
        cached: acc.cached + row.cached,
        cost: acc.cost + row.cost,
      }),
      { calls: 0, tokens: 0, input: 0, output: 0, cached: 0, cost: 0 }
    )
    const unattributed: ProviderStats = {
      provider: 'Unattributed / non-.cc',
      calls: Math.max(0, authoritativeTotals.requests - attributed.calls),
      tokens: Math.max(0, authoritativeTotals.total - attributed.tokens),
      input: Math.max(0, authoritativeTotals.input - attributed.input),
      output: Math.max(0, authoritativeTotals.output - attributed.output),
      cached: Math.max(0, authoritativeTotals.cached - attributed.cached),
      cost: Math.max(0, authoritativeTotals.cost - attributed.cost),
    }
    if (unattributed.tokens > 0 || unattributed.calls > 0 || unattributed.cost > 0) {
      rows.push(unattributed)
    }
  }

  return rows.sort((a, b) => b.tokens - a.tokens)
}

async function fetchLogWindow(args: {
  startTimestamp: number
  endTimestamp: number
  scope: 'self' | 'admin'
}): Promise<{ items: UsageLog[]; total: number; truncated: boolean }> {
  const pageSize = 1000
  const maxPages = 50
  const items: UsageLog[] = []
  let total = 0

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchLogs({
      startTimestamp: args.startTimestamp,
      endTimestamp: args.endTimestamp,
      pageSize,
      page,
      type: 2,
      scope: args.scope,
    })
    if (!res.success || !res.data) {
      return { items, total: items.length, truncated: items.length > 0 }
    }
    const pageItems = res.data.items ?? []
    total = res.data.total ?? total
    items.push(...pageItems)
    if (items.length >= total || pageItems.length < pageSize) break
  }

  return { items, total: total || items.length, truncated: items.length < total }
}

// Uses /api/data for authoritative aggregate totals (matching web-synthex
// /dashboard/models) and /api/log only for fields that quota_data does not
// expose: input/output/cache/provider breakdown.
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

    const currentQuotaReq = fetchQuotaData({
      startTimestamp: period.start,
      endTimestamp: period.end,
      scope,
      defaultTime: 'hour',
    })
    const prevQuotaReq = hasPrev
      ? fetchQuotaData({
          startTimestamp: period.prevStart,
          endTimestamp: period.prevEnd,
          scope,
          defaultTime: 'hour',
        })
      : Promise.resolve({ success: true, data: [] })
    const currentLogsReq = fetchLogWindow({
      startTimestamp: period.start,
      endTimestamp: period.end,
      scope,
    })
    const prevLogsReq = hasPrev
      ? fetchLogWindow({
          startTimestamp: period.prevStart,
          endTimestamp: period.prevEnd,
          scope,
        })
      : Promise.resolve({ items: [], total: 0, truncated: false })

    Promise.all([currentQuotaReq, prevQuotaReq, currentLogsReq, prevLogsReq])
      .then(([currQuota, prevQuota, currLogs, prevLogs]) => {
        if (cancelled) return
        if (!currQuota.success || !currQuota.data) {
          setError(currQuota.message ?? 'failed to load quota data')
          setLoading(false)
          return
        }
        const currentQuotaItems = currQuota.data ?? []
        const previousQuotaItems =
          prevQuota.success && prevQuota.data ? prevQuota.data ?? [] : []
        const currentItems = currLogs.items
        const previousItems = prevLogs.items

        const current = emptyTotals()
        const previous = emptyTotals()
        for (const row of currentQuotaItems) accumulateQuota(current, row)
        for (const row of previousQuotaItems) accumulateQuota(previous, row)
        for (const log of currentItems) accumulateLogDetails(current, log)
        for (const log of previousItems) accumulateLogDetails(previous, log)
        finalize(current)
        finalize(previous)

        setData({
          current,
          previous,
          byModel: rollupQuotaByModel(currentQuotaItems),
          byProvider: rollupByProvider(currentItems, current),
          currentItems,
          currentQuotaItems,
          windowStart: period.start,
          windowEnd: period.end,
          pageTotal: currLogs.total,
          sampleSize: currentItems.length,
          truncated: currLogs.truncated,
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
