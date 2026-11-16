/**
 * The shared notice surfaces: a floating stack for a page's failures and
 * warnings, and a thin busy bar for a read in flight.
 *
 * Why floating rather than a row in the page: a notice that inserts itself
 * into the document flow moves everything below it (the UI review's "the error
 * pushed out a row" report). The stack is positioned over the content's
 * bottom-right corner instead: it never participates in layout, so appearing
 * and disappearing cannot shift a control the human is aiming at, and it stays
 * clear of the app header and the page toolbars (which the old top-right
 * placement covered). It is still a real `alert`/`status` for assistive
 * technology, and its actions stay in the notice that owns them.
 *
 * The stack is deliberately small — the two newest notices, then a count — and
 * it never takes focus: reading it cannot interrupt the work that produced it.
 * @module @matrix1001/dsh-application-harness-client-chrome/notices
 */
import type { ReactNode } from 'react'
import css from './shell.module.css'

/** One action on a notice. */
export interface NoticeAction {
  /** The visible label (the caller's dictionary). */
  readonly label: string
  /** What the action does. */
  readonly onClick: () => void
  /** Optional data anchors forwarded to the action button. */
  readonly anchor?: Readonly<Record<string, string>> | undefined
}

/** One notice in the floating stack. */
export interface NoticeItem {
  /** Stable identity (two notices never share it). */
  readonly id: string
  /** Severity, which chooses the edge colour and the live-region role. */
  readonly tone?: 'error' | 'warning' | 'info'
  /** The text to read (already localized). */
  readonly text: string
  /** Optional inline actions. */
  readonly actions?: readonly NoticeAction[]
  /** When present the notice can be closed. */
  readonly onDismiss?: () => void
  /** The accessible name of the close control. */
  readonly dismissLabel?: string
  /** Optional data anchors forwarded to the notice element. */
  readonly anchor?: Readonly<Record<string, string>> | undefined
}

/**
 * Render a page's notices as a floating stack (nothing is added to the flow).
 * @param props - the notices and the stack's accessible name.
 * @returns the stack, or null when there is nothing to show.
 */
export function NoticeLayer({ items, label }: { items: readonly NoticeItem[]; label: string }): ReactNode {
  if (items.length === 0) return null
  const shown = items.slice(0, 2)
  return (
    <div className={css.noticeLayer} data-notice-layer role="region" aria-label={label}>
      {shown.map(item => (
        <div
          key={item.id}
          className={css.notice}
          data-notice={item.id}
          data-tone={item.tone ?? 'info'}
          role={item.tone === 'error' ? 'alert' : 'status'}
          {...item.anchor}
        >
          <span className={css.noticeText}>{item.text}</span>
          {item.actions?.map((action, index) => (
            <button
              key={`${action.label}-${String(index)}`} type="button" className={css.noticeAction}
              {...action.anchor} onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
          {item.onDismiss !== undefined && (
            <button
              type="button" className={css.noticeAction}
              aria-label={item.dismissLabel ?? item.text}
              onClick={item.onDismiss}
            >×</button>
          )}
        </div>
      ))}
      {items.length > shown.length && <p className={css.noticeMore}>+{items.length - shown.length}</p>}
    </div>
  )
}

/**
 * A thin indeterminate progress line for a page-level read in flight. It is
 * fixed to the viewport top rather than inserted above the content, so the
 * loading state does not push the page down either.
 * @param props.label - the accessible name of the progress bar.
 * @returns the bar.
 */
export function BusyBar({ label }: { label: string }): ReactNode {
  return <div className={css.busyBar} role="progressbar" aria-label={label} data-busy-bar><span /></div>
}
