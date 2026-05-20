import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { FilterButton } from '@/components/FilterButton'
import { PeriodPicker } from '@/components/PeriodPicker'
import { readUser } from '@/lib/auth'
import {
  adaptiveSize,
  formatCredit,
  formatNumber,
} from '@/lib/format'
import { fetchLogs, parseOther, type UsageLog } from '@/lib/logs'
import {
  buildPeriod,
  type CustomRange,
  type PeriodKey,
} from '@/lib/period'

const ROLE_ADMIN = 10
const PAGE_SIZE = 20

interface PageState {
  items: UsageLog[]
  total: number
  loading: boolean
  error: string | null
}

function formatLocalTime(ts: number): string {
  const d = new Date(ts * 1000)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const HH = String(d.getHours()).padStart(2, '0')
  const MM = String(d.getMinutes()).padStart(2, '0')
  const SS = String(d.getSeconds()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd} ${HH}:${MM}:${SS}`
}

function formatUseTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

export function LogsPage() {
  // Independent time-window state — does not touch the Overview filter.
  const [periodKey, setPeriodKey] = useState<PeriodKey>('7d')
  const [customRange, setCustomRange] = useState<CustomRange | null>(null)
  const period = useMemo(
    () => buildPeriod(periodKey, customRange),
    [periodKey, customRange]
  )

  const [page, setPage] = useState(1)
  const [state, setState] = useState<PageState>({
    items: [],
    total: 0,
    loading: true,
    error: null,
  })

  // Reset page whenever the window changes — a fresh window starts at page 1.
  useEffect(() => {
    setPage(1)
  }, [period.start, period.end])

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))

    const user = readUser()
    const scope: 'self' | 'admin' =
      user && (user.role ?? 0) >= ROLE_ADMIN ? 'admin' : 'self'

    fetchLogs({
      startTimestamp: period.start,
      endTimestamp: period.end,
      page,
      pageSize: PAGE_SIZE,
      type: 2,
      scope,
    })
      .then((res) => {
        if (cancelled) return
        if (!res.success || !res.data) {
          setState({
            items: [],
            total: 0,
            loading: false,
            error: res.message ?? 'failed to load logs',
          })
          return
        }
        setState({
          items: res.data.items ?? [],
          total: res.data.total ?? 0,
          loading: false,
          error: null,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({
          items: [],
          total: 0,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    return () => {
      cancelled = true
    }
  }, [period.start, period.end, page])

  const handleCustomApply = (range: CustomRange) => {
    setCustomRange(range)
    setPeriodKey('custom')
  }

  const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE))
  const startIndex = (page - 1) * PAGE_SIZE
  const endIndex = Math.min(startIndex + state.items.length, state.total)

  return (
    <>
      <section className='lifetime-row glass logs-header'>
        <div className='lifetime-head'>
          <span className='lifetime-label'>Request logs</span>
          <span className='lifetime-sub'>
            {state.loading
              ? 'fetching…'
              : state.error
                ? state.error
                : `${formatNumber(state.total)} consume logs · within ${period.label}`}
          </span>
        </div>
        <div className='lifetime-controls'>
          <PeriodPicker
            value={periodKey}
            customRange={customRange}
            onChange={setPeriodKey}
          />
          <FilterButton
            customRange={customRange}
            active={periodKey === 'custom'}
            onApply={handleCustomApply}
          />
        </div>
      </section>

      <section className='panel glass panel-pad logs-table-panel'>
        <div className='logs-table-wrap'>
          <table className='logs-table'>
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th>Provider</th>
                <th className='num'>Input</th>
                <th className='num'>Output</th>
                <th className='num'>Cached</th>
                <th className='num'>Cost</th>
                <th className='num'>Use</th>
                <th>Source app</th>
              </tr>
            </thead>
            <tbody>
              {state.loading ? (
                <tr>
                  <td colSpan={9} className='logs-status'>loading…</td>
                </tr>
              ) : state.items.length === 0 ? (
                <tr>
                  <td colSpan={9} className='logs-status'>
                    {state.error ?? 'No logs in this window'}
                  </td>
                </tr>
              ) : (
                state.items.map((log, i) => {
                  const other = parseOther(log.other)
                  const cached =
                    Number(other.cached_input_tokens) ||
                    Number(other.cache_tokens) ||
                    0
                  return (
                    <motion.tr
                      key={log.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.18,
                        delay: Math.min(i, 12) * 0.012,
                        ease: 'easeOut',
                      }}
                    >
                      <td className='mono'>{formatLocalTime(log.created_at)}</td>
                      <td>
                        <span className='logs-cell-truncate' title={log.model_name}>
                          {log.model_name || 'unknown'}
                        </span>
                      </td>
                      <td>
                        <span className='logs-cell-truncate' title={other.provider}>
                          {other.provider || '—'}
                        </span>
                      </td>
                      <td className='num mono'>{formatNumber(log.prompt_tokens || 0)}</td>
                      <td className='num mono'>{formatNumber(log.completion_tokens || 0)}</td>
                      <td className='num mono'>{cached > 0 ? formatNumber(cached) : '—'}</td>
                      <td className='num mono'>{formatCredit(log.quota || 0)}</td>
                      <td className='num mono'>{formatUseTime(log.use_time || 0)}</td>
                      <td>
                        <span className='logs-cell-truncate' title={other.source_app}>
                          {other.source_app || '—'}
                        </span>
                      </td>
                    </motion.tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className='logs-footer'>
          <span className='logs-range'>
            {state.total === 0
              ? '0 of 0'
              : `${formatNumber(startIndex + 1)}–${formatNumber(endIndex)} of ${formatNumber(state.total)}`}
          </span>
          <div className='logs-pagination'>
            <button
              type='button'
              className='logs-page-btn'
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </button>
            <span
              className='logs-page-num'
              style={{ fontSize: adaptiveSize(`${page} / ${totalPages}`, 13) }}
            >
              {page} / {totalPages}
            </span>
            <button
              type='button'
              className='logs-page-btn'
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next →
            </button>
          </div>
        </div>
      </section>
    </>
  )
}
