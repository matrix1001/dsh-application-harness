/**
 * The ordinary conversation's turn-scope control: the applications the user
 * referenced in this turn, with one action that revokes the temporary scope.
 * The scope lives in the host; this control only reads it and asks for the
 * revocation, so no client state can widen it.
 * @module @matrix1001/dsh-application-harness-client-applications/client/turn-scope
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ApplicationsArea.module.css'

/** The two host commands this control uses. */
export interface TurnScopeRemote {
  readonly appScope?: (sessionId: string) => Promise<
    { readonly ok: true; readonly value: { readonly apps: readonly string[] } } | { readonly ok: false }
  >
  readonly cancelAppScope?: (sessionId: string) => Promise<
    { readonly ok: true; readonly value: boolean } | { readonly ok: false }
  >
}

/** Props of the header control. */
export interface TurnScopeControlProps {
  readonly sessionId: string
  readonly remote: TurnScopeRemote
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the current turn's application scope, or nothing when the turn has
 * no referenced applications.
 * @param props - the Session, the host commands and the dictionary.
 * @returns the inline control.
 */
export function TurnScopeControl({ sessionId, remote, t }: TurnScopeControlProps): ReactNode {
  const [apps, setApps] = useState<readonly string[]>()
  useEffect(() => {
    let live = true
    if (typeof remote.appScope !== 'function') return undefined
    void remote.appScope(sessionId).then((result) => {
      if (live && result.ok) setApps(result.value.apps)
    }).catch(() => { /* the control stays hidden when the host cannot answer */ })
    return () => { live = false }
  }, [sessionId, remote])
  if (apps === undefined || apps.length === 0) return null
  return (
    <span className={css.scopeControl} data-app-turn-scope data-apps={apps.join(',')}>
      <span className={css.scopeLabel} title={apps.join('、')}>
        {t('scope.label', { apps: apps.join('、') })}
      </span>
      <button
        type="button"
        className={css.contextBarAction}
        data-app-turn-scope-cancel
        onClick={() => {
          void remote.cancelAppScope?.(sessionId).then((result) => {
            if (result.ok && result.value) setApps([])
          }).catch(() => { /* an unanswered cancel leaves the scope in place */ })
        }}
      >{t('scope.cancel')}</button>
    </span>
  )
}
