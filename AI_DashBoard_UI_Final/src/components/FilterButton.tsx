import { useEffect, useRef, useState } from 'react'
import type { CustomRange } from '@/lib/period'

interface FilterButtonProps {
  customRange: CustomRange | null
  // Whether the dashboard is currently using a custom range (vs a preset).
  active: boolean
  onApply: (range: CustomRange) => void
}

function toIsoDate(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function dateInputToEpoch(value: string, endOfDay: boolean): number {
  const [y, m, d] = value.split('-').map((n) => parseInt(n, 10))
  if (!y || !m || !d) return 0
  const dt = new Date(
    y,
    m - 1,
    d,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0
  )
  return Math.floor(dt.getTime() / 1000)
}

// Funnel button + date-range popover. Replaces the inline "Custom" preset;
// when the user applies a range the parent flips period.key to 'custom'.
export function FilterButton(props: FilterButtonProps) {
  const [open, setOpen] = useState(false)
  const [fromStr, setFromStr] = useState('')
  const [toStr, setToStr] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    if (props.customRange) {
      setFromStr(toIsoDate(props.customRange.start))
      setToStr(toIsoDate(props.customRange.end))
      return
    }
    const nowSec = Math.floor(Date.now() / 1000)
    setFromStr(toIsoDate(nowSec - 7 * 24 * 60 * 60))
    setToStr(toIsoDate(nowSec))
  }, [open, props.customRange])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const apply = () => {
    if (!fromStr || !toStr) return
    const start = dateInputToEpoch(fromStr, false)
    const end = dateInputToEpoch(toStr, true)
    if (start === 0 || end === 0 || end < start) return
    props.onApply({ start, end })
    setOpen(false)
  }

  return (
    <div className='filter-wrapper' ref={wrapperRef}>
      <button
        type='button'
        className={`round filter-trigger${props.active ? ' active' : ''}${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label='Filter date range'
        title='Filter by date range'
      >
        <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
          <path d='M3 5h18l-7 8v6l-4 2v-8z' />
        </svg>
        {props.active && <span className='filter-dot' aria-hidden='true' />}
      </button>
      {open && (
        <div className='period-popover filter-popover'>
          <div className='filter-popover-title'>Filter by date range</div>
          <label className='period-popover-field'>
            <span>From</span>
            <input
              type='date'
              value={fromStr}
              onChange={(e) => setFromStr(e.target.value)}
              max={toStr || undefined}
            />
          </label>
          <label className='period-popover-field'>
            <span>To</span>
            <input
              type='date'
              value={toStr}
              onChange={(e) => setToStr(e.target.value)}
              min={fromStr || undefined}
            />
          </label>
          <button
            type='button'
            className='period-popover-apply'
            onClick={apply}
            disabled={!fromStr || !toStr}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  )
}
