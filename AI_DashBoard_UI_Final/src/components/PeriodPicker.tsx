import { motion } from 'motion/react'
import { PERIOD_PRESETS, type CustomRange, type PeriodKey } from '@/lib/period'

interface PeriodPickerProps {
  value: PeriodKey
  customRange: CustomRange | null
  onChange: (next: PeriodKey) => void
}

function formatShortRange(range: CustomRange): string {
  const fmt = (s: number) => {
    const d = new Date(s * 1000)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return `${fmt(range.start)} → ${fmt(range.end)}`
}

// Pill-style segmented control. Five fixed presets plus a synthetic
// "custom" pill that only appears once the user has applied a date range
// through the funnel filter; clicking it reactivates that range.
export function PeriodPicker(props: PeriodPickerProps) {
  const showCustomChip =
    props.value === 'custom' && props.customRange !== null
  return (
    <div className='period-picker'>
      {PERIOD_PRESETS.map((preset) => {
        const active = props.value === preset.key
        return (
          <button
            key={preset.key}
            type='button'
            className={`period-option${active ? ' active' : ''}`}
            onClick={() => props.onChange(preset.key)}
          >
            {active && (
              <motion.span
                className='period-active-bg'
                layoutId='period-active'
                transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              />
            )}
            <span className='period-label'>{preset.label}</span>
          </button>
        )
      })}
      {showCustomChip && (
        <button
          type='button'
          className='period-option period-custom active'
          onClick={() => props.onChange('custom')}
        >
          <motion.span
            className='period-active-bg'
            layoutId='period-active'
            transition={{ type: 'spring', stiffness: 360, damping: 32 }}
          />
          <span className='period-label'>
            {formatShortRange(props.customRange!)}
          </span>
        </button>
      )}
    </div>
  )
}
