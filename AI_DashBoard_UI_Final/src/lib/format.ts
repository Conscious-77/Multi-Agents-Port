// Number / percent / delta formatters tuned for the dashboard.

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('en-US')
}

const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

// 1,234,567 → 1.23M. Used for KPI / Lifetime / Cache / Donut hero numbers
// where exact digit-by-digit values aren't important and would overflow.
export function formatNumberCompact(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return compactFmt.format(Math.round(n))
}

// Adaptive font size for hero numbers — keeps the layout from breaking when a
// digit string grows past what its cell can hold. `base` is the px size you'd
// use for short strings; longer strings step down in roughly equal ratios.
export function adaptiveSize(value: string, base: number): number {
  const len = value.length
  if (len > 16) return Math.round(base * 0.6)
  if (len > 13) return Math.round(base * 0.74)
  if (len > 10) return Math.round(base * 0.85)
  return base
}

export function formatPercent(rate: number, digits = 2): string {
  if (!Number.isFinite(rate)) return '0%'
  return `${(rate * 100).toFixed(digits)}%`
}

// NewAPI internal credit unit. We render as "$X,XXX.YY" because the Vyra
// design shows a USD-styled cost; semantically it is still NewAPI quota.
// Real USD conversion (via system QuotaPerUnit) lands in a later step.
export function formatCredit(quota: number): string {
  if (!Number.isFinite(quota)) return '$0.00'
  return `$${quota.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}


export interface DeltaResult {
  text: string
  positive: boolean
  zero: boolean
}

// Arrow + magnitude only. The "vs prev" framing is implied by the dashboard
// header — repeating it on every card chewed up horizontal space.
export function formatPercentDelta(curr: number, prev: number): DeltaResult {
  if (prev === 0) {
    if (curr === 0) return { text: '—', positive: false, zero: true }
    return { text: '↗ new', positive: true, zero: false }
  }
  const change = (curr - prev) / prev
  const positive = change >= 0
  const arrow = positive ? '↗' : '↘'
  return {
    text: `${arrow} ${Math.abs(change * 100).toFixed(2)}%`,
    positive,
    zero: change === 0,
  }
}

export function formatCreditDelta(curr: number, prev: number): DeltaResult {
  const diff = curr - prev
  const positive = diff >= 0
  const arrow = positive ? '↗' : '↘'
  return {
    text: `${arrow} ${formatCredit(Math.abs(diff))}`,
    positive,
    zero: diff === 0,
  }
}
