/**
 * The shared read-failure block: what a page shows when its first read could
 * not answer. The caller supplies the localized title/body and the recovery
 * controls; this module owns the structure, the diagnostic disclosure and the
 * stable anchor. The failure KIND decides which recovery a page offers, never
 * the host's English message.
 * @module @matrix1001/dsh-application-harness-client-chrome/read-failure
 */
import type { ReactNode } from 'react'
import type { FailureDetail, FailureKind } from './failure.ts'
import css from './read-failure.module.css'

/** Props of one read-failure block. */
export interface ReadFailureProps extends FailureDetail {
  /** How the read failed (the page chooses its words and actions from this). */
  readonly kind: FailureKind
  /** The localized headline. */
  readonly title: string
  /** An optional localized explanation. */
  readonly body?: string | undefined
  /** The primary recovery control (for example the permission-page entry). */
  readonly action?: ReactNode | undefined
  /** The re-read control. */
  readonly retry?: ReactNode | undefined
  /** The localized label of the diagnostic disclosure. */
  readonly detailLabel: string
  /** Extra class merged onto the root. */
  readonly className?: string | undefined
  /** Arbitrary `data-*` attributes forwarded to the root (locator anchors). */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * Render one read-failure block.
 * @param props - the kind, the localized copy, the recovery controls and the wire detail.
 * @returns the failure block with its optional diagnostic disclosure.
 */
export function ReadFailure({ kind, title, body, action, retry, detailLabel, code, message, className, ...rest }: ReadFailureProps): ReactNode {
  const hasDetail = code !== undefined || message !== undefined
  return (
    <div
      className={[css.failure, className].filter(Boolean).join(' ')}
      data-read-failure={kind}
      role="alert"
      {...rest}
    >
      <p className={css.title}>{title}</p>
      {body !== undefined && <p className={css.body}>{body}</p>}
      {(action !== undefined || retry !== undefined) && (
        <div className={css.actions}>
          {action}
          {retry}
        </div>
      )}
      {hasDetail && (
        <details className={css.diagnostic}>
          <summary>{detailLabel}</summary>
          {code !== undefined && <code data-read-failure-code>{code}</code>}
          {message !== undefined && <p data-read-failure-message>{message}</p>}
        </details>
      )}
    </div>
  )
}
