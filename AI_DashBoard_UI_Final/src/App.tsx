import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { ApiHealthPill } from '@/components/ApiHealthPill'
import { AnimatedValue } from '@/components/AnimatedValue'
import { FilterButton } from '@/components/FilterButton'
import { PeriodPicker } from '@/components/PeriodPicker'
import { LogsPage } from '@/features/logs/LogsPage'
import { useLifetimeTotals } from '@/hooks/useLifetimeTotals'
import { TrendChart } from '@/features/trend/TrendChart'
import { bucketLogs, buildSparkPath } from '@/features/trend/bucketing'
import {
  useKpiData,
  type ModelStats,
  type ProviderStats,
} from '@/hooks/useKpiData'
import { clearUser, readUser } from '@/lib/auth'
import {
  adaptiveSize,
  formatCredit,
  formatCreditDelta,
  formatNumber,
  formatPercent,
  formatPercentDelta,
} from '@/lib/format'
import {
  buildPeriod,
  type CustomRange,
  type Period,
  type PeriodKey,
} from '@/lib/period'

const MODEL_PALETTE = [
  '#4773ff',
  '#67aefc',
  '#6ac69b',
  '#9e7cff',
  '#ffad65',
  '#ff7a9e',
  '#5fdbd0',
  '#c1b8ee',
]

// First-pass App: a 1:1 React port of the Vyra HTML design.
// Static numbers from the design mockup are left in place; real data wiring
// happens in subsequent steps (KPI -> Trend -> Donuts -> Agent -> ...).
// Only the top-left ApiHealthPill is live — it confirms the Vite dev proxy
// and the NewAPI backend session are reachable.
export function App() {
  return (
    <>
      <ApiHealthPill />
      <div className='shell'>
        <Sidebar />
        <Main />
      </div>
    </>
  )
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function Sidebar() {
  return (
    <aside className='sidebar'>
      <div className='logo'>
        <div className='logo-mark' />
        <div className='logo-text'>Vyra</div>
      </div>
      <nav className='nav'>
        <NavItem active label='Overview' icon={<IconHome />} />
        <NavItem label='Models' icon={<IconCube />} />
        <NavItem label='Agents' icon={<IconAgents />} />
        <NavItem label='Cost Analysis' icon={<IconCost />} />
        <NavItem label='Infrastructure' icon={<IconInfra />} />
        <NavItem label='Alerts' icon={<IconBell />} />
        <NavItem label='Reports' icon={<IconReport />} />
        <NavItem label='Settings' icon={<IconSettings />} />
      </nav>
      <div className='side-bottom'>
        <div className='plan'>
          <div className='small'>Current Plan</div>
          <div className='name'>Pro Plan</div>
          <div className='small flex justify-between'>
            <span>Usage this month</span>
            <span>78%</span>
          </div>
          <div className='bar'>
            <span />
          </div>
          <div className='upgrade'>
            Upgrade Plan <span>→</span>
          </div>
        </div>
        <UserCard />
      </div>
    </aside>
  )
}

// Reads the cached AuthUser and renders the bottom-left user card. Clicking
// it logs out (clears the cached id and refreshes the gate).
function UserCard() {
  const user = readUser()
  const handleLogout = () => {
    if (!confirm('Sign out of Vyra?')) return
    clearUser()
    window.location.reload()
  }
  const displayName = user?.display_name || user?.username || 'Account'
  const subline = user?.group ? `group: ${user.group}` : 'click to sign out'
  const initial = (displayName[0] || '?').toUpperCase()
  return (
    <div className='user' onClick={handleLogout} title='Sign out'>
      <div className='avatar'>{initial}</div>
      <div>
        <div className='name'>{displayName}</div>
        <div className='mail'>{subline}</div>
      </div>
      <div style={{ marginLeft: 'auto', color: 'rgba(255,255,255,.75)' }}>⌄</div>
    </div>
  )
}

function NavItem(props: { label: string; icon: React.ReactNode; active?: boolean }) {
  return (
    <div className={`nav-item${props.active ? ' active' : ''}`}>
      {props.icon}
      {props.label}
    </div>
  )
}

// ─── Main ───────────────────────────────────────────────────────────────────

type SectionKey = 'overview' | 'logs' | 'agents' | 'cost' | 'infrastructure'

const SECTION_TABS: { key: SectionKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'logs', label: 'Logs' },
  { key: 'agents', label: 'Agents' },
  { key: 'cost', label: 'Cost' },
  { key: 'infrastructure', label: 'Infrastructure' },
]

function Main() {
  const [section, setSection] = useState<SectionKey>('overview')
  return (
    <main>
      <Topbar value={section} onChange={setSection} />
      {section === 'overview' && <OverviewPage />}
      {section === 'logs' && <LogsPage />}
      {(section === 'agents' || section === 'cost' || section === 'infrastructure') && (
        <ComingSoonPage label={SECTION_TABS.find((t) => t.key === section)!.label} />
      )}
    </main>
  )
}

function Topbar(props: {
  value: SectionKey
  onChange: (next: SectionKey) => void
}) {
  return (
    <div className='topbar'>
      <div className='tabs'>
        {SECTION_TABS.map((tab) => (
          <div
            key={tab.key}
            className={`tab${props.value === tab.key ? ' active' : ''}`}
            onClick={() => props.onChange(tab.key)}
            role='button'
          >
            {tab.label}
          </div>
        ))}
      </div>
    </div>
  )
}

function ComingSoonPage(props: { label: string }) {
  return (
    <div className='coming-soon panel glass'>
      <div className='coming-soon-label'>{props.label}</div>
      <div className='coming-soon-text'>Coming soon</div>
    </div>
  )
}

function OverviewPage() {
  const [periodKey, setPeriodKey] = useState<PeriodKey>('today')
  const [customRange, setCustomRange] = useState<CustomRange | null>(null)
  const period = useMemo(
    () => buildPeriod(periodKey, customRange),
    [periodKey, customRange]
  )
  // Single useKpiData call shared by KPIs + donuts; without this the same
  // /api/log query would fire twice per period change.
  const kpi = useKpiData(period)

  const handleCustomApply = (range: CustomRange) => {
    setCustomRange(range)
    setPeriodKey('custom')
  }

  return (
    <>
      <LifetimeRow
        periodKey={periodKey}
        customRange={customRange}
        onPeriodChange={setPeriodKey}
        onCustomApply={handleCustomApply}
      />
      <KpisRow kpi={kpi} period={period} />
      <MidGrid kpi={kpi} period={period} />
      <CacheEfficiencyPanel kpi={kpi} />
      <ProviderPanel kpi={kpi} />
    </>
  )
}

// ─── Lifetime totals (full history) ────────────────────────────────────────

function LifetimeRow(props: {
  periodKey: PeriodKey
  customRange: CustomRange | null
  onPeriodChange: (next: PeriodKey) => void
  onCustomApply: (range: CustomRange) => void
}) {
  // Historical totals: always the full database aggregate, independent of the
  // PeriodPicker selection. Admin scope uses /api/data with no time cap;
  // non-admin scope falls back to the largest window NewAPI's user endpoint
  // accepts (~30 days) and the sub-label flags that approximation.
  const { data, loading, error } = useLifetimeTotals()

  const sub = loading
    ? 'aggregating…'
    : error
      ? error
      : data?.scope === 'admin'
        ? 'Every consume log in the database · independent of the filter on the right'
        : 'Approx · last 30 days only (sign in as admin for the full lifetime)'

  return (
    <section className='lifetime-row glass'>
      <div className='lifetime-head'>
        <span className='lifetime-label'>Historical totals</span>
        <span className='lifetime-sub'>{sub}</span>
      </div>
      <div className='lifetime-grid'>
        <LifetimeCell
          label='Total Tokens'
          value={loading ? '…' : formatNumber(data?.tokens ?? 0)}
        />
        <LifetimeCell
          label='Total Requests'
          value={loading ? '…' : formatNumber(data?.requests ?? 0)}
        />
        <LifetimeCell
          label='Total Cost'
          value={loading ? '…' : formatCredit(data?.cost ?? 0)}
        />
      </div>
      <div className='lifetime-controls'>
        <PeriodPicker
          value={props.periodKey}
          customRange={props.customRange}
          onChange={props.onPeriodChange}
        />
        <FilterButton
          customRange={props.customRange}
          active={props.periodKey === 'custom'}
          onApply={props.onCustomApply}
        />
      </div>
    </section>
  )
}

function LifetimeCell(props: { label: string; value: string }) {
  const fontSize = adaptiveSize(props.value, 19)
  return (
    <div className='lifetime-cell'>
      <div className='lifetime-cell-label'>{props.label}</div>
      <div className='lifetime-cell-value' style={{ fontSize: `${fontSize}px` }}>
        <AnimatedValue value={props.value} />
      </div>
    </div>
  )
}

// ─── KPI row (6 cards) ─────────────────────────────────────────────────────

type KpiQuery = ReturnType<typeof useKpiData>

function KpisRow(props: { kpi: KpiQuery; period: Period }) {
  const { data, loading, error } = props.kpi
  const curr = data?.current
  const prev = data?.previous

  // Bucket the current-window logs once and feed each card its own slice for
  // a real sparkline. When data is loading we leave the path empty and fall
  // back to the static design path so the card layout stays the same.
  const buckets = useMemo(
    () =>
      data?.currentItems ? bucketLogs(data.currentItems, props.period) : null,
    [data?.currentItems, props.period]
  )
  const totalPath = useMemo(
    () => (buckets ? buildSparkPath(buckets.buckets.map((b) => b.total)) : ''),
    [buckets]
  )
  const inputPath = useMemo(
    () => (buckets ? buildSparkPath(buckets.buckets.map((b) => b.input)) : ''),
    [buckets]
  )
  const outputPath = useMemo(
    () => (buckets ? buildSparkPath(buckets.buckets.map((b) => b.output)) : ''),
    [buckets]
  )
  const cachedPath = useMemo(
    () => (buckets ? buildSparkPath(buckets.buckets.map((b) => b.cached)) : ''),
    [buckets]
  )
  const hitRatePath = useMemo(
    () =>
      buckets
        ? buildSparkPath(
            buckets.buckets.map((b) => (b.input > 0 ? b.cached / b.input : 0))
          )
        : '',
    [buckets]
  )
  const costPath = useMemo(
    () => (buckets ? buildSparkPath(buckets.buckets.map((b) => b.cost)) : ''),
    [buckets]
  )

  const totalDelta = formatPercentDelta(curr?.total ?? 0, prev?.total ?? 0)
  const inputDelta = formatPercentDelta(curr?.input ?? 0, prev?.input ?? 0)
  const outputDelta = formatPercentDelta(curr?.output ?? 0, prev?.output ?? 0)
  const cachedDelta = formatPercentDelta(curr?.cached ?? 0, prev?.cached ?? 0)
  const hitRateDelta = formatPercentDelta(
    curr?.cacheHitRate ?? 0,
    prev?.cacheHitRate ?? 0
  )
  const costDelta = formatCreditDelta(curr?.cost ?? 0, prev?.cost ?? 0)

  // Loading/error placeholders. Static sparkline silhouettes are kept so the
  // layout doesn't jump while data arrives; they'll become data-driven once
  // the Trend step lands.
  return (
    <section className='kpis'>
      <KpiCard
        iconTone='blue'
        icon={<IconLayers />}
        label='Total Tokens'
        value={loading ? '…' : error ? '—' : formatNumber(curr?.total ?? 0)}
        delta={loading ? 'loading…' : error ? error : totalDelta.text}
        deltaPositive={totalDelta.positive}
        sparkColor='#5d8cff'
        sparkPath={totalPath}
      />
      <KpiCard
        iconTone='cyan'
        icon={<IconArrowDown />}
        label='Input Tokens'
        value={loading ? '…' : error ? '—' : formatNumber(curr?.input ?? 0)}
        delta={loading ? 'loading…' : error ? '—' : inputDelta.text}
        deltaPositive={inputDelta.positive}
        sparkColor='#6fb7ff'
        sparkPath={inputPath}
      />
      <KpiCard
        iconTone='green'
        icon={<IconArrowUp />}
        label='Output Tokens'
        value={loading ? '…' : error ? '—' : formatNumber(curr?.output ?? 0)}
        delta={loading ? 'loading…' : error ? '—' : outputDelta.text}
        deltaPositive={outputDelta.positive}
        sparkColor='#62d7b1'
        sparkPath={outputPath}
      />
      <KpiCard
        iconTone='purple'
        icon={<IconLayers />}
        label='Cached Tokens'
        value={loading ? '…' : error ? '—' : formatNumber(curr?.cached ?? 0)}
        delta={loading ? 'loading…' : error ? '—' : cachedDelta.text}
        deltaPositive={cachedDelta.positive}
        sparkColor='#b27aff'
        sparkPath={cachedPath}
      />
      <KpiCard
        iconTone='purple'
        icon={<IconBullseye />}
        label='Cache Hit Rate'
        value={loading ? '…' : error ? '—' : formatPercent(curr?.cacheHitRate ?? 0)}
        delta={loading ? 'loading…' : error ? '—' : hitRateDelta.text}
        deltaPositive={hitRateDelta.positive}
        sparkColor='#b27aff'
        sparkPath={hitRatePath}
      />
      <KpiCard
        iconTone='orange'
        icon={<IconDollar />}
        label='Est. Cost'
        value={loading ? '…' : error ? '—' : formatCredit(curr?.cost ?? 0)}
        delta={loading ? 'loading…' : error ? '—' : costDelta.text}
        // For cost, "up" is bad — flip the color semantic.
        deltaPositive={!costDelta.positive}
        sparkColor='#ffad65'
        sparkPath={costPath}
      />
    </section>
  )
}

interface KpiCardProps {
  iconTone: 'blue' | 'cyan' | 'green' | 'purple' | 'orange'
  icon: React.ReactNode
  label: string
  value: string
  delta: string
  // Whether delta should render as "good" (green) or "bad" (red). Cost cards
  // flip this so an upward arrow reads as bad.
  deltaPositive?: boolean
  sparkColor?: string
  sparkPath?: string
  decorator?: React.ReactNode
}

function KpiCard(props: KpiCardProps) {
  const deltaColor =
    props.deltaPositive === undefined
      ? undefined
      : props.deltaPositive
        ? '#82e4b1'
        : '#ff846c'
  const fontSize = adaptiveSize(props.value, 26)
  return (
    <div className='kpi glass'>
      <div className='kpi-head'>
        <div className={`icon ${props.iconTone}`}>{props.icon}</div>
        <div className='kpi-label'>{props.label}</div>
      </div>
      <div className='kpi-main'>
        <span className='kpi-value' style={{ fontSize: `${fontSize}px` }}>
          <AnimatedValue value={props.value} />
        </span>
        <span
          className='delta'
          style={deltaColor ? { color: deltaColor } : undefined}
        >
          <AnimatedValue value={props.delta} />
        </span>
      </div>
      {props.sparkPath && (
        <div className='mini'>
          <svg className='spark' viewBox='0 0 160 42'>
            <path stroke={props.sparkColor} d={props.sparkPath} />
          </svg>
        </div>
      )}
      {props.decorator}
    </div>
  )
}

// ─── Mid grid (Trend + 2 donuts) ───────────────────────────────────────────

function MidGrid(props: { kpi: KpiQuery; period: Period }) {
  const byModel = props.kpi.data?.byModel ?? []
  const totalCalls = byModel.reduce((s, m) => s + m.calls, 0)
  const totalTokens = byModel.reduce((s, m) => s + m.tokens, 0)

  const callsModel = buildDonut(byModel, 'calls', totalCalls)
  const tokensModel = buildDonut(byModel, 'tokens', totalTokens)

  return (
    <section className='grid-main'>
      <TrendChart
        logs={props.kpi.data?.currentItems ?? []}
        period={props.period}
        loading={props.kpi.loading}
        palette={MODEL_PALETTE}
      />

      <DonutPanel
        title='Calls by Model'
        sub='(Count)'
        centerNum={formatNumber(totalCalls)}
        centerText='Total Calls'
        rows={callsModel.rows}
        slices={callsModel.slices}
        loading={props.kpi.loading}
      />
      <DonutPanel
        title='Tokens by Model'
        sub='(Count)'
        centerNum={formatNumber(totalTokens)}
        centerText='Total Tokens'
        rows={tokensModel.rows}
        slices={tokensModel.slices}
        loading={props.kpi.loading}
      />
    </section>
  )
}

interface DonutRow { color: string; name: string; value: string; pct: string }
interface DonutSlice { color: string; from: number; to: number }

// Reduces a byModel rollup into the top-N rows + an "Others" bucket so the
// donut stays readable. The slice array is the cumulative degree pairs that
// feed `conic-gradient`.
function buildDonut(
  rows: ModelStats[],
  field: 'calls' | 'tokens',
  total: number
): { rows: DonutRow[]; slices: DonutSlice[] } {
  if (total <= 0) {
    return {
      rows: [{ color: 'rgba(255,255,255,.28)', name: 'No data', value: '0', pct: '(0%)' }],
      slices: [{ color: 'rgba(255,255,255,.28)', from: 0, to: 360 }],
    }
  }

  const TOP = 4
  const sorted = [...rows].sort((a, b) => b[field] - a[field])
  const top = sorted.slice(0, TOP)
  const rest = sorted.slice(TOP)
  const restSum = rest.reduce((s, m) => s + m[field], 0)

  const display: { name: string; value: number; color: string }[] = top.map((m, i) => ({
    name: m.model,
    value: m[field],
    color: MODEL_PALETTE[i % MODEL_PALETTE.length],
  }))
  if (rest.length > 0 && restSum > 0) {
    display.push({
      name: `Others (${rest.length})`,
      value: restSum,
      color: '#c1b8ee',
    })
  }

  const slices: DonutSlice[] = []
  let cursor = 0
  for (const entry of display) {
    const span = (entry.value / total) * 360
    slices.push({ color: entry.color, from: cursor, to: cursor + span })
    cursor += span
  }
  const drows: DonutRow[] = display.map((entry) => ({
    color: entry.color,
    name: entry.name,
    value: formatNumber(entry.value),
    pct: `(${((entry.value / total) * 100).toFixed(1)}%)`,
  }))
  return { rows: drows, slices }
}

function DonutPanel(props: {
  title: string
  sub: string
  centerNum: string
  centerText: string
  rows: DonutRow[]
  slices: DonutSlice[]
  loading?: boolean
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const dataKey = props.slices.map((s) => `${s.color}:${s.to.toFixed(1)}`).join('|')
  const hoveredRow = hovered ? props.rows.find((r) => r.name === hovered) ?? null : null

  return (
    <div className='panel glass panel-pad donut-panel'>
      <div className='panel-title'>
        {props.title} <span className='panel-sub'>{props.sub}</span>
      </div>
      <div className='donut-box'>
        <motion.div
          key={dataKey}
          className='donut-frame'
          initial={{ opacity: 0, scale: 0.92, rotate: -6 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <DonutSvg
            slices={props.slices}
            labels={props.rows.map((r) => r.name)}
            hoveredKey={hovered}
            onHoverChange={setHovered}
          />
          <div className='donut-center'>
            <DonutCenterNum
              value={
                props.loading
                  ? '…'
                  : hoveredRow
                    ? hoveredRow.value
                    : props.centerNum
              }
            />
            <div className='donut-text'>
              {hoveredRow ? hoveredRow.name : props.centerText}
            </div>
          </div>
        </motion.div>
      </div>
      <div className='donut-list'>
        {props.rows.map((row, i) => (
          <motion.div
            key={row.name + i}
            className={`r${hovered === row.name ? ' hovered' : ''}${
              hovered && hovered !== row.name ? ' dimmed' : ''
            }`}
            onMouseEnter={() => setHovered(row.name)}
            onMouseLeave={() => setHovered(null)}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, delay: i * 0.04, ease: 'easeOut' }}
          >
            <span className='donut-row-name' title={row.name}>
              <i style={{ background: row.color }} />
              <span className='donut-row-name-text'>{row.name}</span>
            </span>
            <span>{row.value}</span>
            <span>{row.pct}</span>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function DonutCenterNum(props: { value: string }) {
  // The inner hole is ~86px wide; adaptiveSize keeps long numbers from
  // bleeding outside the ring without forcing compact notation.
  const fontSize = adaptiveSize(props.value, 22)
  return (
    <div className='donut-num' style={{ fontSize: `${fontSize}px` }}>
      <AnimatedValue value={props.value} />
    </div>
  )
}

// ─── Donut SVG (hover-aware) ──────────────────────────────────────────────

const DONUT_CX = 67
const DONUT_CY = 67
const DONUT_R_OUTER = 67
const DONUT_R_INNER = 43
const DONUT_R_HOVER_OUTER = 71

// SVG arc paths start at 3-o'clock by default. We offset by -90° so the first
// slice anchors at 12-o'clock, matching the prior conic-gradient layout.
function arcPath(
  fromDeg: number,
  toDeg: number,
  rOuter: number,
  rInner: number
): string {
  const a1 = ((fromDeg - 90) * Math.PI) / 180
  const a2 = ((toDeg - 90) * Math.PI) / 180
  const large = toDeg - fromDeg > 180 ? 1 : 0
  const xo1 = DONUT_CX + rOuter * Math.cos(a1)
  const yo1 = DONUT_CY + rOuter * Math.sin(a1)
  const xo2 = DONUT_CX + rOuter * Math.cos(a2)
  const yo2 = DONUT_CY + rOuter * Math.sin(a2)
  const xi2 = DONUT_CX + rInner * Math.cos(a2)
  const yi2 = DONUT_CY + rInner * Math.sin(a2)
  const xi1 = DONUT_CX + rInner * Math.cos(a1)
  const yi1 = DONUT_CY + rInner * Math.sin(a1)
  return [
    `M ${xo1.toFixed(2)} ${yo1.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${xo2.toFixed(2)} ${yo2.toFixed(2)}`,
    `L ${xi2.toFixed(2)} ${yi2.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${xi1.toFixed(2)} ${yi1.toFixed(2)}`,
    'Z',
  ].join(' ')
}

function DonutSvg(props: {
  slices: DonutSlice[]
  labels: string[]
  hoveredKey: string | null
  onHoverChange: (key: string | null) => void
}) {
  // 0.6° gap between slices visually separates them and matches the original
  // conic-gradient's nearly-imperceptible seam between colors.
  const PAD = 0.6
  return (
    <svg
      viewBox='0 0 134 134'
      width={134}
      height={134}
      style={{ overflow: 'visible' }}
      onMouseLeave={() => props.onHoverChange(null)}
    >
      {props.slices.map((s, i) => {
        const label = props.labels[i] ?? `slice-${i}`
        const span = s.to - s.from
        if (span <= PAD * 2) return null
        const start = s.from + PAD
        const end = s.to - PAD
        const isHover = props.hoveredKey === label
        const dim =
          props.hoveredKey !== null && props.hoveredKey !== label
        const d = arcPath(
          start,
          end,
          isHover ? DONUT_R_HOVER_OUTER : DONUT_R_OUTER,
          DONUT_R_INNER
        )
        return (
          <path
            key={label}
            className={`donut-slice${dim ? ' dimmed' : ''}${isHover ? ' active' : ''}`}
            d={d}
            fill={s.color}
            onMouseEnter={() => props.onHoverChange(label)}
            style={{ '--slice-color': s.color } as React.CSSProperties}
          />
        )
      })}
    </svg>
  )
}


// ─── Cache Efficiency (real data) ──────────────────────────────────────────

function CacheEfficiencyPanel(props: { kpi: KpiQuery }) {
  const curr = props.kpi.data?.current
  const prev = props.kpi.data?.previous
  const loading = props.kpi.loading

  const hitRate = curr?.cacheHitRate ?? 0
  const prevHitRate = prev?.cacheHitRate ?? 0
  const hitDelta = formatPercentDelta(hitRate, prevHitRate)

  const savedTokens = curr?.cached ?? 0
  const prevSavedTokens = prev?.cached ?? 0
  const savedDelta = formatPercentDelta(savedTokens, prevSavedTokens)

  // Rough credit-savings approximation: a cached input slot bills at ~10% of
  // a fresh input, so the "saved" portion is 0.9 of the input ratio. We use
  // the seed convention (cost ≈ total / 10) to keep units consistent with
  // the rest of the dashboard's "$X" cost display.
  const savedCost = savedTokens * 0.09
  const prevSavedCost = prevSavedTokens * 0.09
  const costDelta = formatCreditDelta(savedCost, prevSavedCost)

  const reused = curr?.cachedRequests ?? 0
  const prevReused = prev?.cachedRequests ?? 0
  const reusedDelta = formatPercentDelta(reused, prevReused)

  return (
    <section className='panel glass panel-pad cache-section'>
      <div className='panel-title'>
        Cache Efficiency <span className='panel-sub'>· current period</span>
      </div>
      <div className='cache-grid'>
        <CacheCard
          label='Cache Hit Rate'
          value={loading ? '…' : formatPercent(hitRate)}
          delta={loading ? '' : hitDelta.text}
          positive={hitDelta.positive}
        />
        <CacheCard
          label='Saved Tokens'
          value={loading ? '…' : formatNumber(savedTokens)}
          delta={loading ? '' : savedDelta.text}
          positive={savedDelta.positive}
        />
        <CacheCard
          label='Saved Cost'
          value={loading ? '…' : formatCredit(savedCost)}
          delta={loading ? '' : costDelta.text}
          positive={costDelta.positive}
        />
        <CacheCard
          label='Reused Contexts'
          value={loading ? '…' : formatNumber(reused)}
          delta={loading ? '' : reusedDelta.text}
          positive={reusedDelta.positive}
        />
      </div>
    </section>
  )
}

// ─── By Provider (.cc proxy fan-out) ───────────────────────────────────────

const PROVIDER_TOP_N = 6

function ProviderPanel(props: { kpi: KpiQuery }) {
  const fullList = props.kpi.data?.byProvider ?? []
  const loading = props.kpi.loading
  // Cap visible rows so a sudden surge in provider variety doesn't blow up
  // the panel height; the rest are folded into a single "Others" row that
  // still contributes to the totals.
  const list = useMemo<ProviderStats[]>(() => {
    if (fullList.length <= PROVIDER_TOP_N) return fullList
    const top = fullList.slice(0, PROVIDER_TOP_N)
    const rest = fullList.slice(PROVIDER_TOP_N)
    const others = rest.reduce<ProviderStats>(
      (acc, p) => ({
        provider: `Others (${rest.length})`,
        calls: acc.calls + p.calls,
        tokens: acc.tokens + p.tokens,
        input: acc.input + p.input,
        output: acc.output + p.output,
        cached: acc.cached + p.cached,
        cost: acc.cost + p.cost,
      }),
      { provider: '', calls: 0, tokens: 0, input: 0, output: 0, cached: 0, cost: 0 }
    )
    return [...top, others]
  }, [fullList])
  const totalTokens = list.reduce((s, p) => s + p.tokens, 0)

  return (
    <section className='panel glass panel-pad provider-panel'>
      <div className='panel-title'>
        By Provider <span className='panel-sub'>· .cc proxy fan-out</span>
      </div>
      {loading ? (
        <div className='provider-empty'>loading…</div>
      ) : list.length === 0 ? (
        <div className='provider-empty'>No .cc ingest data in this window</div>
      ) : (
        <div className='provider-list'>
          <div className='provider-row provider-head'>
            <span>Provider</span>
            <span>Tokens</span>
            <span>Share</span>
            <span>Calls</span>
            <span>Cache hit</span>
            <span>Cost</span>
          </div>
          {list.map((p, i) => (
            <ProviderRow
              key={p.provider}
              entry={p}
              color={MODEL_PALETTE[i % MODEL_PALETTE.length]!}
              totalTokens={totalTokens}
              index={i}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ProviderRow(props: {
  entry: ProviderStats
  color: string
  totalTokens: number
  index: number
}) {
  const p = props.entry
  const sharePct =
    props.totalTokens > 0 ? (p.tokens / props.totalTokens) * 100 : 0
  const hitPct = p.input > 0 ? p.cached / p.input : null
  return (
    <motion.div
      className='provider-row'
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28, delay: props.index * 0.05, ease: 'easeOut' }}
    >
      <span className='provider-name' title={p.provider}>
        <i style={{ background: props.color }} />
        <span className='provider-name-text'>{p.provider}</span>
      </span>
      <span className='provider-num'>{formatNumber(p.tokens)}</span>
      <span className='provider-bar-cell'>
        <span className='provider-bar-track'>
          <span
            className='provider-bar-fill'
            style={{ width: `${sharePct}%`, background: props.color }}
          />
        </span>
        <span className='provider-pct'>{sharePct.toFixed(1)}%</span>
      </span>
      <span className='provider-num'>{formatNumber(p.calls)}</span>
      <span className='provider-num'>
        {hitPct !== null ? formatPercent(hitPct) : '—'}
      </span>
      <span className='provider-num'>{formatCredit(p.cost)}</span>
    </motion.div>
  )
}

function CacheCard(props: {
  label: string
  value: string
  delta: string
  positive?: boolean
}) {
  const color =
    props.positive === undefined
      ? undefined
      : props.positive
        ? '#80e0ac'
        : '#ff846c'
  // base aligned with the new compact inline cache card (18px)
  const fontSize = adaptiveSize(props.value, 18)
  return (
    <div className='cache-card'>
      <div className='l'>{props.label}</div>
      <div className='v' style={{ fontSize: `${fontSize}px` }}>
        <AnimatedValue value={props.value} />
      </div>
      <div className='d' style={color ? { color } : undefined}>
        <AnimatedValue value={props.delta} />
      </div>
    </div>
  )
}

// ─── Sidebar icons (inline SVG, lifted from the Vyra HTML) ─────────────────

function IconHome() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <path d='M3 10.8 12 3l9 7.8v9.4a.8.8 0 0 1-.8.8h-5.4v-6.2H9.2V21H3.8a.8.8 0 0 1-.8-.8z' />
    </svg>
  )
}
function IconCube() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <path d='M12 3 20 7.5v9L12 21l-8-4.5v-9z' />
      <path d='M12 8v8M8 10.4l4 2.3 4-2.3' />
    </svg>
  )
}
function IconAgents() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <circle cx='12' cy='9' r='3.2' />
      <path d='M5 20c.8-3.7 3.1-5.5 7-5.5s6.2 1.8 7 5.5' />
      <circle cx='6.5' cy='12' r='2' />
      <circle cx='17.5' cy='12' r='2' />
    </svg>
  )
}
function IconCost() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <path d='m4 20 16-16M7 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm16 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z' />
    </svg>
  )
}
function IconInfra() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <rect x='4' y='4' width='16' height='16' rx='3' />
      <path d='M8 8h3v8H8zM13 11h3v5h-3z' />
    </svg>
  )
}
function IconBell() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <path d='M18 8a6 6 0 1 0-12 0c0 7-3 6-3 9h18c0-3-3-2-3-9z' />
      <path d='M10 21h4' />
    </svg>
  )
}
function IconReport() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <rect x='5' y='4' width='14' height='16' rx='1.5' />
      <path d='M9 8h6M9 12h6M9 16h3' />
    </svg>
  )
}
function IconSettings() {
  return (
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor'>
      <circle cx='12' cy='12' r='3' />
      <path d='M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-2 3.4-.2-.1a1.6 1.6 0 0 0-1.8.3 1.6 1.6 0 0 0-.5 1.7H8.7a1.6 1.6 0 0 0-.5-1.7 1.6 1.6 0 0 0-1.8-.3l-.2.1-2-3.4.1-.1A1.6 1.6 0 0 0 4.6 15 1.6 1.6 0 0 0 3 13.8V10.2A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1 2-3.4.2.1a1.6 1.6 0 0 0 1.8-.3A1.6 1.6 0 0 0 8.7 2h6.6a1.6 1.6 0 0 0 .5 1.5 1.6 1.6 0 0 0 1.8.3l.2-.1 2 3.4-.1.1A1.6 1.6 0 0 0 19.4 9a1.6 1.6 0 0 0 1.6 1.2v3.6a1.6 1.6 0 0 0-1.6 1.2Z' />
    </svg>
  )
}

// ─── KPI icons ─────────────────────────────────────────────────────────────

function IconLayers() {
  return (
    <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white'>
      <path d='M12 3 4 7l8 4 8-4-8-4Z' />
      <path d='m4 12 8 4 8-4M4 17l8 4 8-4' />
    </svg>
  )
}
function IconArrowDown() {
  return (
    <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white'>
      <path d='M12 4v14M6 12l6 6 6-6' />
    </svg>
  )
}
function IconArrowUp() {
  return (
    <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white'>
      <path d='M12 20V6M6 12l6-6 6 6' />
    </svg>
  )
}
function IconDollar() {
  return (
    <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white'>
      <path d='M12 2v20M17 6.5c-1.5-1-7-1.6-7 1.5 0 3.4 8 1.8 8 5.8 0 3.5-5.4 3.3-8 2' />
    </svg>
  )
}
function IconBullseye() {
  // Reads as "hit / target" — works as the Cache Hit Rate icon.
  return (
    <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white' strokeWidth='1.8'>
      <circle cx='12' cy='12' r='9' />
      <circle cx='12' cy='12' r='5' />
      <circle cx='12' cy='12' r='1.7' fill='white' stroke='none' />
    </svg>
  )
}
