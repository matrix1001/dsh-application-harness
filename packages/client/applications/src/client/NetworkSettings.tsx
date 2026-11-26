/**
 * The application network proxy: the one application-area setting that belongs
 * to no application. It edits the `app-http` host row's volatile `proxy` field
 * through the platform's settings form, so the value persists like every other
 * plugin setting and the next application request picks it up without a
 * restart. The page itself is a management-page detail, not a setting of the
 * platform's settings center: the egress policy is the application harness's own.
 *
 * The UI is the application chrome's own control surface. It consumes only the
 * settings form's sync data/write methods, never a platform Client component.
 * @module @matrix1001/dsh-application-harness-client-applications/client/NetworkSettings
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ApplicationsArea.module.css'

/** The settings namespace the app-http host row registers. */
export const APP_HTTP_NAMESPACE = 'app-http'

/** The proxy control's DOM id, so the management page can move focus into it. */
export const NETWORK_PROXY_INPUT_ID = 'app-network-proxy'

/** The app-http row's editable section: the application egress proxy. */
export interface NetworkProxySection {
  /** The proxy URL; absent keeps the platform policy (direct unless the platform proxy is configured). */
  readonly proxy?: string
}

/** The slice of the platform settings form this page consumes (structurally typed). */
export interface NetworkForm {
  getSnapshot(): {
    readonly status: 'loading' | 'ready' | 'unavailable'
    readonly value: NetworkProxySection | undefined
    readonly base: unknown
    readonly user: unknown
    readonly revision: number | undefined
    readonly writable: boolean
  }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ({ readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown } | { readonly op: 'unset'; readonly path: readonly string[] })[], expectedRevision?: number): Promise<boolean>
}

/**
 * The client-side mirror of the host's proxy rule: an http(s) URL without
 * credentials. The host validates again at use and fails closed; this mirror
 * only refuses a value the host could never route.
 * @param text - the staged draft.
 * @returns the write the draft stages, or undefined for an unusable value.
 */
function proxyValue(text: string): { kind: 'set'; value: string } | { kind: 'clear' } | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'clear' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  return { kind: 'set', value: trimmed }
}

/** Whether the stored user layer overrides the field. */
function isOverridden(user: unknown): boolean {
  return typeof user === 'object' && user !== null && !Array.isArray(user) && Object.prototype.hasOwnProperty.call(user, 'proxy')
}

/** What the page needs from the area. */
export interface NetworkSettingsProps {
  /** The app-http form when the platform serves it; undefined when the settings client is not mounted. */
  readonly form: NetworkForm | undefined
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the application network proxy page.
 * @param props - the shared form and the area's copy.
 * @returns the form, or the deployment's unavailable line.
 */
export function NetworkSettings({ form, t }: NetworkSettingsProps): ReactNode {
  if (form === undefined) return <p className={css.manageEmpty} data-app-network-unavailable>{t('network.unavailable')}</p>
  return <NetworkProxyForm form={form} t={t} />
}

/** The form itself; a child so its hooks only run while a served namespace exists. */
function NetworkProxyForm({ form, t }: { readonly form: NetworkForm; readonly t: TranslateNS<'applications'> }): ReactNode {
  const snapshot = useSyncExternalStore(form.subscribe, form.getSnapshot)
  const [draft, setDraft] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const stored = typeof snapshot.value?.proxy === 'string' ? snapshot.value.proxy : ''
  const text = draft ?? stored
  const parsed = proxyValue(text)
  const invalid = parsed === undefined
  const dirty = draft !== undefined && draft !== stored
  const overridden = isOverridden(snapshot.user)
  const disabled = !snapshot.writable || saving
  const overriddenLabel = dirty ? t('network.pending') : t('network.overridden')
  const active = typeof snapshot.value?.proxy === 'string' && snapshot.value.proxy.trim() !== '' ? snapshot.value.proxy : undefined

  const save = async (): Promise<void> => {
    if (parsed === undefined) return
    setSaving(true)
    setError(undefined)
    try {
      const ok = await form.mutate(
        [parsed.kind === 'clear' ? { op: 'unset', path: ['proxy'] } : { op: 'set', path: ['proxy'], value: parsed.value }],
        snapshot.revision,
      )
      if (!ok) setError(t('network.saveFailed'))
      else setDraft(undefined)
    } catch {
      setError(t('network.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  const reset = (): void => {
    setDraft('')
    setError(undefined)
  }

  return (
    <div className={css.networkPage} data-app-network-proxy>
      <div className={css.networkSection}>
        <div className={css.networkField}>
          <label htmlFor={NETWORK_PROXY_INPUT_ID}>{t('network.proxyLabel')}</label>
          <input
            id={NETWORK_PROXY_INPUT_ID}
            value={text}
            placeholder={t('network.proxyPlaceholder')}
            disabled={disabled}
            aria-invalid={invalid ? true : undefined}
            onChange={(event) => { setDraft(event.target.value); setError(undefined) }}
          />
          <p className={css.networkHint}>{t('network.proxyHint')}</p>
          {invalid && <p id={`${NETWORK_PROXY_INPUT_ID}-message`} className={css.networkError} role="alert">{t('network.invalid')}</p>}
          {overridden && <p className={css.networkHint} data-app-network-overridden>{overriddenLabel}</p>}
          {error !== undefined && <p className={css.networkError} role="alert" data-app-network-error>{error}</p>}
        </div>
        <div className={css.networkActions}>
          <Button size="sm" variant="ghost" disabled={disabled || !overridden} onClick={reset}>{t('network.reset')}</Button>
          <Button size="sm" variant="primary" disabled={disabled || !dirty || invalid} onClick={() => { void save() }}>{saving ? t('network.saving') : t('network.save')}</Button>
        </div>
        <p
          className={css.networkState}
          data-app-network-state={active === undefined ? 'direct' : 'proxied'}
          data-app-network-dirty={dirty ? 'true' : undefined}
        >
          {active === undefined
            ? t('network.stateDirect')
            : t('network.stateProxied', { proxy: active })}
          {dirty ? ` · ${t('network.stateDirty')}` : ''}
        </p>
        <section className={css.networkScope} data-app-network-scope aria-label={t('network.scopeTitle')}>
          <h3 className={css.networkScopeTitle}>{t('network.scopeTitle')}</h3>
          <dl className={css.networkScopeList}>
            <div><dt>{t('network.scopeProxy')}</dt><dd>{t('network.scopeProxyValue')}</dd></div>
            <div><dt>{t('network.scopeNot')}</dt><dd>{t('network.scopeNotValue')}</dd></div>
            <div><dt>{t('network.scopeFailed')}</dt><dd>{t('network.scopeFailedValue')}</dd></div>
            <div><dt>{t('network.scopeLive')}</dt><dd>{t('network.scopeLiveValue')}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  )
}
