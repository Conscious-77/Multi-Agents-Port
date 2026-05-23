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
  cost: number
  input: number
  cached: number
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
  // per-provider rollup. Tokens/calls/cost come from the SAME quota_data
  // aggregate that byModel + the KPIs use (so the panel reconciles with the
  // models page), regrouped by provider via a model→provider map learned from
  // the logs. input/output/cached are enriched from the logs for the cache
  // column.
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

// Per-model rollup aligned with the models page (/dashboard/models): tokens,
// calls and cost come from the quota_data aggregate (the authoritative source),
// input/cached are enriched from the logs for the cache-hit column only.
function rollupByModel(
  quotaRows: QuotaDataItem[],
  logs: UsageLog[]
): ModelStats[] {
  const map = new Map<string, ModelStats>()
  const ensure = (model: string): ModelStats => {
    let e = map.get(model)
    if (!e) {
      e = { model, calls: 0, tokens: 0, cost: 0, input: 0, cached: 0 }
      map.set(model, e)
    }
    return e
  }
  for (const row of quotaRows) {
    const e = ensure(row.model_name || 'unknown')
    e.calls += Number(row.count) || 0
    e.tokens += Number(row.token_used) || 0
    e.cost += Number(row.quota) || 0
  }
  // Enrich input/cached from logs; only touch models quota_data established so
  // the model set + totals stay reconciled with the models page.
  for (const log of logs) {
    const e = map.get(log.model_name || 'unknown')
    if (!e) continue
    const other = parseOther(log.other)
    e.input += Number(log.prompt_tokens) || 0
    e.cached +=
      Number(other.cached_input_tokens) || Number(other.cache_tokens) || 0
  }
  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens)
}

function inferProviderFromModel(modelName: string): string | null {
  const model = (modelName || '').toLowerCase()
  if (!model || model === 'unknown') return null
  if (model.includes('gemini')) return 'gemini'
  if (model.includes('doubao') || model.startsWith('ep-')) return 'doubao'
  if (model.includes('deepseek')) return 'deepseek'
  if (model.includes('claude-code-micu')) return 'claude-code-micu'
  if (model.includes('claude')) return 'micuapi'
  if (model.includes('gpt-micu')) return 'gpt-micu'
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'micuapi'
  return null
}

// Learn a model_name → provider mapping from the raw logs. The .cc ingest path
// records the real upstream provider in other.provider; for models seen under
// several providers we keep the most frequent. This lets us attach an accurate
// provider to the quota_data aggregate, which carries no provider field.
function buildModelProviderMap(logs: UsageLog[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>()
  for (const log of logs) {
    const model = log.model_name || 'unknown'
    const provider =
      parseOther(log.other).provider || inferProviderFromModel(model)
    if (!provider) continue
    let inner = counts.get(model)
    if (!inner) {
      inner = new Map()
      counts.set(model, inner)
    }
    inner.set(provider, (inner.get(provider) ?? 0) + 1)
  }
  const map = new Map<string, string>()
  for (const [model, inner] of counts) {
    let best = ''
    let bestN = -1
    for (const [prov, n] of inner) {
      if (n > bestN) {
        best = prov
        bestN = n
      }
    }
    if (best) map.set(model, best)
  }
  return map
}

// Provider rollup aligned with the models page. Tokens / calls / cost are
// summed from the quota_data aggregate (the authoritative source the model
// donut + KPIs use), just regrouped by provider — so the provider totals
// reconcile exactly with the model totals. Every quota_data row is counted;
// models with no learnable provider fall into an "other" bucket rather than
// being dropped. input / output / cached are enriched from the logs (for the
// cache-hit column only) and never introduce a provider absent from quota_data.
function rollupByProvider(
  quotaRows: QuotaDataItem[],
  logs: UsageLog[]
): ProviderStats[] {
  const modelProvider = buildModelProviderMap(logs)
  const providerOf = (model: string): string =>
    modelProvider.get(model) || inferProviderFromModel(model) || 'other'

  const map = new Map<string, ProviderStats>()
  const ensure = (provider: string): ProviderStats => {
    let e = map.get(provider)
    if (!e) {
      e = { provider, calls: 0, tokens: 0, input: 0, output: 0, cached: 0, cost: 0 }
      map.set(provider, e)
    }
    return e
  }

  // Headline numbers from quota_data (authoritative, matches the models page).
  for (const row of quotaRows) {
    const entry = ensure(providerOf(row.model_name || 'unknown'))
    entry.calls += Number(row.count) || 0
    entry.tokens += Number(row.token_used) || 0
    entry.cost += Number(row.quota) || 0
  }

  // Enrich input/output/cached from the logs. Only touch providers quota_data
  // already established so the provider set (and totals) stay reconciled.
  for (const log of logs) {
    const entry = map.get(providerOf(log.model_name || 'unknown'))
    if (!entry) continue
    const other = parseOther(log.other)
    entry.input += Number(log.prompt_tokens) || 0
    entry.output += Number(log.completion_tokens) || 0
    entry.cached +=
      Number(other.cached_input_tokens) || Number(other.cache_tokens) || 0
  }

  return Array.from(map.values()).sort((a, b) => b.tokens - a.tokens)
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
          byModel: rollupByModel(currentQuotaItems, currentItems),
          byProvider: rollupByProvider(currentQuotaItems, currentItems),
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
