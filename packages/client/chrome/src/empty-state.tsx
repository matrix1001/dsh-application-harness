/**
 * The shared empty state: the one block a page shows when a read succeeded and
 * there is nothing to list, or when the current filters match nothing. It is
 * deliberately presentational: the caller owns the words, the optional glyph
 * and the recovery action, so an "empty because nothing was read yet" state
 * and an "empty because the filter is too narrow" state never share a
 * sentence.
 *
 * `compact` is the in-panel variant (a board column, a list section): it keeps
 * the same structure without the page-level padding and centring, so a column
 * does not grow into a second empty page.
 * @module @matrix1001/dsh-application-harness-client-chrome/empty-state
 */
import type { ReactNode } from 'react'
import css from './shell.module.css'

/** Props of one empty state. */
export interface EmptyStateProps {
  /** The one sentence naming the state (localized by the caller). */
  readonly title: string
  /** Optional second line explaining why it is empty or what to do. */
  readonly body?: string
  /** Optional leading glyph; hidden from assistive technology. */
  readonly icon?: ReactNode
  /** Optional recovery action, laid out under (or beside, when compact) the text. */
  readonly action?: ReactNode
  /** The in-panel/board-column variant: no page-level padding or centring. */
  readonly compact?: boolean
  /** Extra class merged onto the root. */
  readonly className?: string | undefined
  /** Arbitrary `data-*` attributes forwarded to the root (locator anchors). */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * Render one empty state.
 * @param props - the title, optional body/glyph/action, and the compact flag.
 * @returns the empty-state block.
 */
export function EmptyState({ title, body, icon, action, compact = false, className, ...rest }: EmptyStateProps): ReactNode {
  return (
    <div
      className={[css.emptyState, compact ? css.emptyStateCompact : undefined, className].filter(Boolean).join(' ')}
      data-empty-state
      {...rest}
    >
      {icon !== undefined && <span className={css.emptyStateIcon} aria-hidden="true">{icon}</span>}
      <div className={css.emptyStateText}>
        <p className={css.emptyStateTitle}>{title}</p>
        {body !== undefined && <p className={css.emptyStateBody}>{body}</p>}
      </div>
      {action !== undefined && <div className={css.emptyStateAction}>{action}</div>}
    </div>
  )
}
