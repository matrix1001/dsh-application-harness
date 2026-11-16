/**
 * One application status, shown the same way everywhere: a colored dot for
 * scanning plus the localized word (color is never the only signal).
 * @module @matrix1001/dsh-application-harness-client-applications/client/StatusBadge
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Activation, AppStatus, RuntimeState } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { RUNTIME_KEYS } from './model.ts'
import css from './ApplicationsArea.module.css'

/** One status badge. */
export function StatusBadge({ runtime, status, health, activation, t }: { readonly runtime: RuntimeState; readonly status: AppStatus; readonly health?: 'ok' | 'degraded'; readonly activation?: Activation; readonly t: TranslateNS<'applications'> }): ReactNode {
  return (
    <span className={css.statusBadge} data-app-status-badge data-status={status} data-runtime={runtime}>
      <span className={css.statusDot} aria-hidden="true" />
      {activation === 'disabled' && `${t('activation.disabled')} · `}{status === 'failed' ? t('status.failed') : status === 'stop-incomplete' ? t('status.stop-incomplete') : t(RUNTIME_KEYS[runtime])}
      {health === 'degraded' && status === 'available' && <span className={css.statusDegraded} data-health="degraded">{t('status.degraded')}</span>}
    </span>
  )
}
