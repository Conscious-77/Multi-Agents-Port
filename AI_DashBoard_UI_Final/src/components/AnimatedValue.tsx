import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

// Crossfades + nudges in a fresh value whenever the `value` prop changes.
// `popLayout` lets the outgoing copy slide out while the incoming one is
// already laid out, so values don't visibly jump.
export function AnimatedValue(props: {
  value: ReactNode
  className?: string
  // Use a stable key when ReactNode isn't a plain string (e.g. composed
  // elements) so AnimatePresence can detect changes.
  trigger?: string
}) {
  const k =
    props.trigger ??
    (typeof props.value === 'string' || typeof props.value === 'number'
      ? String(props.value)
      : Math.random().toString())
  return (
    <AnimatePresence mode='popLayout' initial={false}>
      <motion.span
        key={k}
        className={props.className}
        initial={{ y: -4, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 4, opacity: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        style={{ display: 'inline-block' }}
      >
        {props.value}
      </motion.span>
    </AnimatePresence>
  )
}
