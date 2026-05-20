// Time-range presets used by the dashboard. All timestamps are unix seconds —
// the format NewAPI's /api/log and /api/data endpoints expect.

export type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom'

export interface CustomRange {
  start: number // unix seconds, inclusive
  end: number // unix seconds, inclusive
}

export interface Period {
  key: PeriodKey
  label: string
  // window for the current data series
  start: number
  end: number
  // matching previous-of-same-length window for delta comparison
  prevStart: number
  prevEnd: number
}

const SECOND = 1
const HOUR = 60 * 60
const DAY = 24 * HOUR

function startOfTodaySec(now: number = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

// "All time" is treated as last 365 days. NewAPI does not expose a real
// "since user creation" rollup that's cheap to compute, and 365 days is
// always covered by quota_data's hourly aggregation.
const ALL_TIME_DAYS = 365

function formatRangeLabel(startSec: number, endSec: number): string {
  const fmt = (s: number) => {
    const d = new Date(s * 1000)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return `${fmt(startSec)} → ${fmt(endSec)}`
}

export function buildPeriod(
  key: PeriodKey,
  customRange?: CustomRange | null,
  now: number = Date.now()
): Period {
  const nowSec = Math.floor(now / 1000)
  switch (key) {
    case 'today': {
      const start = startOfTodaySec(now)
      const end = nowSec
      const len = end - start || 1
      return {
        key,
        label: 'Today',
        start,
        end,
        prevStart: start - DAY,
        prevEnd: start - SECOND + len,
      }
    }
    case 'yesterday': {
      const todayStart = startOfTodaySec(now)
      const start = todayStart - DAY
      const end = todayStart - SECOND
      return {
        key,
        label: 'Yesterday',
        start,
        end,
        prevStart: start - DAY,
        prevEnd: end - DAY,
      }
    }
    case '7d': {
      const end = nowSec
      const start = end - 7 * DAY
      return {
        key,
        label: 'Last 7 days',
        start,
        end,
        prevStart: start - 7 * DAY,
        prevEnd: start - SECOND,
      }
    }
    case '30d': {
      const end = nowSec
      const start = end - 30 * DAY
      return {
        key,
        label: 'Last 30 days',
        start,
        end,
        prevStart: start - 30 * DAY,
        prevEnd: start - SECOND,
      }
    }
    case 'custom': {
      // Fall back to today if the picker hasn't received a range yet, so the
      // tab is at least usable on first click.
      if (!customRange) return buildPeriod('today', null, now)
      const start = customRange.start
      const end = customRange.end
      const len = Math.max(1, end - start)
      return {
        key: 'custom',
        label: formatRangeLabel(start, end),
        start,
        end,
        prevStart: start - len,
        prevEnd: start - SECOND,
      }
    }
    case 'all':
    default: {
      const end = nowSec
      const start = end - ALL_TIME_DAYS * DAY
      return {
        key: 'all',
        label: 'All time',
        start,
        end,
        // No meaningful previous window for "all time".
        prevStart: 0,
        prevEnd: 0,
      }
    }
  }
}

export const PERIOD_PRESETS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
]
