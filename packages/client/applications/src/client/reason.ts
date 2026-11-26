/**
 * The human word for one application reason code. The management page and the
 * status badge share it, so the same reason never reads differently in two
 * places; the raw code stays available for the diagnostic disclosure.
 * @module @matrix1001/dsh-application-harness-client-applications/client/reason
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppReason } from '@matrix1001/dsh-application-harness-host-bridge/client'

/**
 * Localize one reason code.
 * @param reason - the host's closed reason vocabulary (unknown codes fall back).
 * @param t - the applications dictionary.
 * @returns the human label; the caller keeps the raw code for diagnostics.
 */
export function reasonLabel(reason: AppReason, t: TranslateNS<'applications'>): string {
  switch (reason) {
    case 'platform.updating': return t('status.reason.updating')
    case 'platform.start-failed': return t('status.reason.start-failed')
    case 'platform.health-failed': return t('status.reason.health-failed')
    case 'platform.unavailable': return t('status.reason.unavailable')
    case 'platform.stop-incomplete': return t('status.reason.stop-incomplete')
    default: return t('status.reason.unknown')
  }
}
