/** A small hover/focus tooltip; no platform primitive import. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import css from './ui.module.css'

export interface TooltipProps {
  readonly label: ReactNode
  readonly side?: 'top' | 'bottom'
  readonly delayMs?: number
  readonly children: ReactNode
}

export function Tooltip({ label, side = 'top', delayMs = 0, children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = (): void => {
    clearTimeout(timer.current)
    if (delayMs === 0) { setOpen(true); return }
    timer.current = setTimeout(() => { setOpen(true) }, delayMs)
  }
  const hide = (): void => { clearTimeout(timer.current); setOpen(false) }
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  return (
    <span className={css.tooltipWrap} onMouseEnter={show} onMouseLeave={hide} onFocusCapture={show} onBlurCapture={hide}>
      {children}
      {open && <span role="tooltip" className={`${css.tooltip} ${side === 'bottom' ? css.tooltipBottom : css.tooltipTop}`}>{label}</span>}
    </span>
  )
}
