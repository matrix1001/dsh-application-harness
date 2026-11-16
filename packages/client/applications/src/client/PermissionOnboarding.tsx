/**
 * The first-run permission card: the ONE place the platform asks for an
 * application's platform capabilities before the page can use them.
 *
 * It is a notification, not an authorization: the card never writes a grant by
 * itself — "全部允许" hands the exact missing `capability:*` names to the
 * caller's own grant face, "逐项设置" opens the permission page (where the human
 * decides item by item), and "稍后" records only that this fingerprint was
 * answered. The component is non-blocking: the page below keeps rendering, and
 * a guard prevents any action from starting while the previous answer is in
 * flight.
 * @module @matrix1001/dsh-application-harness-client-applications/client/PermissionOnboarding
 */

import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView } from './contract.ts'
import { capabilityNeeds, describeNeed, displayName, grantedTo } from './model.ts'
import type { ApplicationsState } from './shell.ts'
import css from './ApplicationsArea.module.css'

/** What the card renders from and the actions it may take. */
export interface PermissionOnboardingProps {
  /** The application whose page is showing. */
  readonly app: AppInfo
  /** The client view that can carry the localized name (the host name is the fallback). */
  readonly view?: Pick<ApplicationView, 'name'> | undefined
  /** The shell's live state (grants, onboarding, loaded flags). */
  readonly state: ApplicationsState
  /**
   * Approve the exact missing platform capabilities, then record the
   * fingerprint. Resolves false when either write did not take effect.
   */
  readonly onAllow: (appId: string, capabilities: readonly string[], fingerprint: string) => Promise<boolean>
  /** Record the fingerprint without granting (the "稍后" answer). */
  readonly onLater: (appId: string, fingerprint: string) => Promise<boolean>
  /** Open the application's permission page (逐项设置). */
  readonly onManage: (appId: string) => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the first-run card, or nothing when it does not apply.
 * @param props - the application, the state and the three actions.
 * @returns the card or null.
 */
export function PermissionOnboarding({ app, view, state, onAllow, onLater, onManage, t }: PermissionOnboardingProps): ReactNode {
  const [busy, setBusy] = useState<'allow' | 'later' | undefined>(undefined)
  const [failed, setFailed] = useState<string | undefined>(undefined)

  // The card is only meaningful once BOTH reads answered: "not yet known" is
  // never shown as "not granted" (and never as "already seen").
  if (app.status !== 'available' || !state.grantsLoaded || !state.onboardingLoaded) return null
  const capabilities = capabilityNeeds(app)
  if (capabilities.length === 0) return null
  const caller = { kind: 'app', appId: app.id } as const
  const missing = capabilities.filter(need => !grantedTo(state.grants, caller, need))
  if (missing.length === 0) return null
  const fingerprint = [...capabilities].sort().join('|')
  if (state.onboarding?.apps[app.id]?.fingerprint === fingerprint) return null

  const pending = busy !== undefined

  const allow = async (): Promise<void> => {
    setBusy('allow')
    setFailed(undefined)
    const granted = await onAllow(app.id, missing, fingerprint)
    if (!granted) setFailed(t('onboarding.failed'))
    setBusy(undefined)
  }
  const later = async (): Promise<void> => {
    setBusy('later')
    setFailed(undefined)
    const marked = await onLater(app.id, fingerprint)
    if (!marked) setFailed(t('onboarding.laterFailed'))
    setBusy(undefined)
  }

  return (
    <Modal
      open
      title={t('onboarding.title', { name: displayName(app, view) })}
      closeLabel={t('onboarding.later')}
      onClose={() => { if (!pending) void later() }}
      contentClassName={css.onboardingContent ?? ''}
      footer={(
        <div className={css.onboardingActions}>
          <Button size="sm" variant="primary" disabled={pending} onClick={() => { void allow() }} data-onboarding-action="allow-all">
            {busy === 'allow' ? t('onboarding.pending') : t('onboarding.allowAllCount', { count: missing.length })}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => { onManage(app.id) }} data-onboarding-action="adjust">
            {t('onboarding.adjust')}
          </Button>
          <Button size="sm" disabled={pending} onClick={() => { void later() }} data-onboarding-action="later" data-modal-autofocus>
            {busy === 'later' ? t('onboarding.pending') : t('onboarding.later')}
          </Button>
        </div>
      )}
    >
      <div data-onboarding-app={app.id}>
        <ul className={css.onboardingNeeds}>
          {missing.map(need => {
            const description = describeNeed(need, state.apps ?? [], new Map<string, ApplicationView>(), t)
            return (
              <li key={need}>
                <strong>{description.label}</strong>
                {/* v8 ignore next -- a capability need always has a purpose; only peer needs lack one, and they are not in this list */}
                {description.purpose === undefined ? null : <span className={css.onboardingPurpose}> — {description.purpose}</span>}
              </li>
            )
          })}
        </ul>
        {failed !== undefined && <p className={css.onboardingFailure} role="alert" data-onboarding-failure>{failed}</p>}
      </div>
    </Modal>
  )
}
