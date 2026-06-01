import { useEffect, useState } from 'react'
import { readUser } from '@/lib/auth'
import { fetchUsageCost } from '@/lib/cost-data'
import { fetchQuotaData } from '@/lib/quota-data'

const ROLE_ADMIN = 10
const DAY = 24 * 60 * 60
// NewAPI's admin endpoint (/api/data/) has no time cap, so we can ask for
// everything since epoch. The user endpoint (/api/data/self) rejects spans
// > 30 days, so we approximate with the largest window it accepts.
const SINCE_EPOCH = 0
const SELF_FALLBACK_DAYS = 30

export interface LifetimeTotals {
  tokens: number
  cost: number
  requests: number
  // 'admin' = true lifetime aggregate; 'self' = approx last 30 days because
  // the user endpoint caps the span.
  scope: 'admin' | 'self'
}

export interface UseLifetimeTotalsResult {
  data: LifetimeTotals | null
  loading: boolean
  error: string | null
}

export function useLifetimeTotals(): UseLifetimeTotalsResult {
  const [data, setData] = useState<LifetimeTotals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const user = readUser()
    const scope: 'self' | 'admin' =
      user && (user.role ?? 0) >= ROLE_ADMIN ? 'admin' : 'self'

    const endSec = Math.floor(Date.now() / 1000)
    const startSec =
      scope === 'admin' ? SINCE_EPOCH : endSec - SELF_FALLBACK_DAYS * DAY

    const quotaReq = fetchQuotaData({
      startTimestamp: startSec,
      endTimestamp: endSec,
      defaultTime: 'hour',
      scope,
    })
    const costReq = fetchUsageCost({
      startTimestamp: startSec,
      endTimestamp: endSec,
      granularity: 86400,
      scope,
    })

    Promise.all([quotaReq, costReq])
      .then(([quotaRes, costRes]) => {
        if (cancelled) return
        if (!quotaRes.success || !quotaRes.data) {
          setError(quotaRes.message ?? 'failed to load quota data')
          setLoading(false)
          return
        }
        if (!costRes.success || !costRes.data) {
          setError(costRes.message ?? 'failed to load cost data')
          setLoading(false)
          return
        }
        let tokens = 0
        let cost = 0
        let requests = 0
        for (const row of quotaRes.data) {
          tokens += Number(row.token_used) || 0
          requests += Number(row.count) || 0
        }
        for (const row of costRes.data.items ?? []) {
          cost += Number(row.cost_usd) || 0
        }
        setData({ tokens, cost, requests, scope })
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
  }, [])

  return { data, loading, error }
}
