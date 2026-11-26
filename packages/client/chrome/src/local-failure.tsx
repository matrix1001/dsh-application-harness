/**
 * A compact local-operation failure: one line with a localized title, the
 * optional recovery control, and the raw wire detail behind a disclosure. It is
 * for action errors that belong beside the thing that failed (a save, a source
 * refresh, a settings read), not for a page's first read — that one uses
 * {@link ReadFailure}. The host's English message is never the headline.
 * @module @matrix1001/dsh-application-harness-client-chrome/local-failure
 */
import type { ReactNode } from 'react'
import css from './local-failure.module.css'

/** Props of one compact local failure. */
export interface LocalFailureProps {
  /** The localized headline, chosen by the surface's context. */
  readonly title: string
  /** The raw diagnostic message from the host (shown only in the disclosure). */
  readonly message?: string | undefined
  /** An optional stable raw code shown with the message. */
  readonly code?: string | undefined
  /** The localized label of the diagnostic disclosure. */
  readonly detailLabel: string
  /** An optional recovery control next to the headline. */
  readonly action?: ReactNode | undefined
  /** Extra class merged onto the root. */
  readonly className?: string | undefined
  /** Arbitrary `data-*` attributes forwarded to the root (locator anchors). */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * Render one compact local failure.
 * @param props - the localized headline, the recovery control and the raw detail.
 * @returns the failure line with its optional diagnostic disclosure.
 */
export function LocalFailure({ title, message, code, detailLabel, action, className, ...rest }: LocalFailureProps): ReactNode {
  // A localized fallback is often the same sentence as the title; do not
  // repeat it as a separate diagnostic line.
  const hasDetail = code !== undefined || (message !== undefined && message !== title)
  return (
    <div className={[css.failure, className].filter(Boolean).join(' ')} role="alert" data-local-failure {...rest}>
      <span className={css.title}>{title}</span>
      {action !== undefined && <span className={css.action}>{action}</span>}
      {hasDetail && (
        <details className={css.diagnostic}>
          <summary>{detailLabel}</summary>
          {code !== undefined && <code data-local-failure-code>{code}</code>}
          {message !== undefined && <span data-local-failure-message>{message}</span>}
        </details>
      )}
    </div>
  )
}
