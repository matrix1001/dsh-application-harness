/**
 * One call's outcome, as the panel shows it: the runtime's own four-way result,
 * with its business code and message verbatim (a rejection means the operation
 * never ran, a failure means it ran and its effects may stand — the two must
 * stay visibly different). An outcome that never arrived is NOT rendered here:
 * it arrives as a rejected promise and the calling component shows the Remote
 * error instead.
 * @module @matrix1001/dsh-application-harness-client-applications/client/CallOutcomeView
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CallOutcome } from '@matrix1001/dsh-application-harness-host-bridge/client'
import css from './ApplicationsLists.module.css'

/** The label key of one settled outcome's caption. */
const CAPTION = {
  success: 'call.result',
  rejected: 'call.rejected',
  failed: 'call.failed',
  cancelled: 'call.cancelled',
  unknown: 'call.unknown',
} as const

/**
 * Render one outcome: its status and code, its message, and the value on
 * success (pretty-printed JSON).
 * @param props - the outcome and the panel's translate seat.
 * @returns the outcome block.
 */
export function CallOutcomeView({ outcome, t }: {
  readonly outcome: CallOutcome
  readonly t: TranslateNS<'applications'>
}): ReactNode {
  const code = outcome.status === 'rejected' || outcome.status === 'failed' || outcome.status === 'unknown' ? outcome.error?.code : undefined
  const message = outcome.status === 'rejected' || outcome.status === 'failed' || outcome.status === 'unknown' ? outcome.error?.message : undefined
  return (
    <div className={css.outcome} data-status={outcome.status}>
      <div className={css.outcomeHead}>
        <span className={css.outcomeCaption}>{t(CAPTION[outcome.status])}</span>
        <code className={css.code}>{outcome.status}</code>
        {code !== undefined && <code className={css.code}>{code}</code>}
      </div>
      {message !== undefined && <p className={css.outcomeMessage}>{message}</p>}
      {outcome.status === 'success' && <pre className={css.value}>{JSON.stringify(outcome.result ?? outcome.result, null, 2)}</pre>}
    </div>
  )
}
