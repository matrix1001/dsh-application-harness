/**
 * One application status, shown the same way everywhere: a colored dot for
 * scanning plus the localized word (color is never the only signal).
 * @module @matrix1001/dsh-application-harness-client-applications/client/StatusBadge
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Activation, AppReason, AppStatus, RuntimeState } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { RUNTIME_KEYS } from './model.ts'
import { reasonLabel } from './reason.ts'
import css from './ApplicationsArea.module.css'

/** One status badge. */
export function StatusBadge({ runtime, status, health, activation, reason, compact = false, t }: { readonly runtime: RuntimeState; readonly status: AppStatus; readonly health?: 'ok' | 'degraded'; readonly activation?: Activation; readonly reason?: AppReason; readonly compact?: boolean; readonly t: TranslateNS<'applications'> }): ReactNode {
  if (compact && status === 'available' && health !== 'degraded' && activation !== 'disabled' && runtime === 'ready') {
    // A normal ready row keeps its status in the accessible name but not as a
    // second visible word next to the name and the description.
    return (
      <span className={css.statusBadge} data-app-status-badge data-status={status} data-runtime={runtime} data-compact="true">
        <span className={css.statusDot} aria-hidden="true" />
        <span className={css.srOnly}>{RUNTIME_KEYS[runtime]}</span>
      </span>
    )
  }
  return (
    <span className={css.statusBadge} data-app-status-badge data-status={status} data-runtime={runtime}>
      <span className={css.statusDot} aria-hidden="true" />
      {activation === 'disabled' && `${t('activation.disabled')} · `}{status === 'failed' ? (reason === undefined ? t('status.failed') : reasonLabel(reason, t)) : status === 'stop-incomplete' ? t('status.stop-incomplete') : t(RUNTIME_KEYS[runtime])}
      {health === 'degraded' && status === 'available' && <span className={css.statusDegraded} data-health="degraded">{t('status.degraded')}</span>}
    </span>
  )
}
