/**
 * The management dialog's record lists: what one application declares it needs
 * (each needing the user's approval), who may reach it (its own operations,
 * granted to other callers), the calls it received, and the confirmations
 * waiting for an answer.
 *
 * A need is shown the way a human decides on it: what it is in words, why the
 * application asks, and the switch that gives or takes it away. The RAW
 * identifier is always available (a viewable detail), and it is the only thing a
 * grant is ever written with — display text never drives a permission. Wire
 * records (callers, codes, messages, timestamps, an operation's own description)
 * travel verbatim; only the captions and the actions are this package's copy.
 *
 * Each row owns the outcome of ITS write: while one is in flight the switch is
 * disabled and says so, and a refusal is reported on the row that asked instead
 * of on a shared line that cannot say which row finished.
 * @module @matrix1001/dsh-application-harness-client-applications/client/Lists
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  Caller, CapabilityGrant, ConfirmationDecision, HistoryRecord, PendingConfirmation,
} from '@matrix1001/dsh-application-harness-host-bridge/client'
import { callerLabel, grantedTo, type NeedDescription } from './model.ts'
import css from './ApplicationsLists.module.css'

/** How one write ended, as its own row reports it. */
type WriteState = 'idle' | 'pending' | 'failed'

/** The read facts a list needs before its empty state is truthful. */
export interface ReadStateProps {
  /** Whether the read has answered; absent means the caller supplied data already. */
  readonly loaded?: boolean
  /** Whether a read is in flight while older data (or nothing) is shown. */
  readonly reading?: boolean
  /** Whether the last read failed; older data may be stale. */
  readonly failed?: boolean
  /** Re-run the read from this list's own retry action. */
  readonly onRetry?: () => void
}

/** What every need row renders from and the actions it can run. */
export interface NeedListProps extends ReadStateProps {
  readonly title: string
  readonly empty: string
  readonly caller: Caller
  readonly needs: readonly string[]
  readonly grants: readonly CapabilityGrant[]
  /** The need in words (the label, why, and the wire selector the write uses). */
  readonly describe: (need: string) => NeedDescription
  /** Approve one or more exact capabilities; resolves with whether it took effect. */
  readonly grant: (caller: Caller, capabilities: readonly string[]) => Promise<boolean>
  /** Revoke with an exact selector; resolves with whether it took effect. */
  readonly revoke: (caller: Caller, selector?: string) => Promise<boolean>
  readonly t: TranslateNS<'applications'>
}

/**
 * One application's declared needs — platform capabilities, or the peer
 * operations it asks to call — each approved or revoked by its own switch. A
 * need is a statement; only the user's approval makes it effective, and only
 * the exact capability set approved is covered (a later declaration never
 * extends it).
 * @param props - the section captions, the caller the needs belong to, the need list, every grant in effect, the descriptions and the two commands.
 * @returns the need list, or the "nothing declared" hint.
 */
export function NeedsList({ title, empty, caller, needs, grants, describe, grant, revoke, t, loaded = true, reading = false, failed = false, onRetry }: NeedListProps): ReactNode {
  if (needs.length === 0) return <p className={css.hint}>{empty}</p>
  const disabled = !loaded || reading || failed
  return (
    <div className={css.section}>
      <p className={css.sectionTitle}>{title}</p>
      {reading && <p className={css.hint} data-needs-reading>{t('reads.loading')}</p>}
      {failed && (
        <p className={css.needError} role="alert" data-needs-failed>
          {t('reads.failed')}
          {onRetry !== undefined && <Button size="sm" variant="ghost" onClick={onRetry} data-needs-retry>{t('reads.retry')}</Button>}
        </p>
      )}
      <ul className={css.records}>
        {needs.map(need => (
          <NeedRow
            key={need}
            need={need}
            caller={caller}
            allowed={grantedTo(grants, caller, need)}
            describe={describe}
            grant={grant}
            revoke={revoke}
            disabled={disabled}
            t={t}
          />
        ))}
      </ul>
    </div>
  )
}

/** One need's row: the words, the purpose, the switch, and the failed-write line. */
function NeedRow({ need, caller, allowed, describe, grant, revoke, disabled, t }: {
  readonly need: string
  readonly caller: Caller
  readonly allowed: boolean
  readonly describe: (need: string) => NeedDescription
  readonly grant: NeedListProps['grant']
  readonly revoke: NeedListProps['revoke']
  readonly disabled: boolean
  readonly t: TranslateNS<'applications'>
}): ReactNode {
  const [write, setWrite] = useState<WriteState>('idle')
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const description = describe(need)

  /**
   * Flip this need and adopt the real outcome. The switch is disabled while the
   * write is in flight; on answer, the row either follows the read-back state
   * (the grant list the shell re-read) or says the change did not take effect —
   * it never shows a state the host did not confirm.
   */
  const toggle = async (next: boolean): Promise<void> => {
    setWrite('pending')
    const ok = next ? await grant(caller, [need]) : await revoke(caller, need)
    if (!live.current) return
    setWrite(ok ? 'idle' : 'failed')
  }

  return (
    <li className={css.need} data-app-need={need} data-need-state={allowed ? 'allowed' : 'denied'}>
      <div className={css.needHead}>
        <span className={css.needName}>{description.label}</span>
        <Switch
          checked={allowed}
          disabled={disabled || write === 'pending'}
          label={t('needs.toggle', { need: description.label })}
          onChange={(next) => { void toggle(next) }}
        />
      </div>
      {description.purpose !== undefined && <p className={css.needPurpose}>{description.purpose}</p>}
      {write === 'pending' && <p className={css.needPending} data-need-pending={need}>{t('needs.pending')}</p>}
      {write === 'failed' && <p className={css.needError} role="alert" data-need-error={need}>{t('needs.failed')}</p>}
      {/* The wire id, when the row does not already read as it (an unexplained
          need keeps its identifier as its name, and repeats no second line). */}
      {description.label !== description.selector && (
        <details className={css.needDetails} data-need-details={need}>
          <summary>{t('perm.details')}</summary>
          <code>{description.selector}</code>
        </details>
      )}
    </li>
  )
}

/**
 * The other callers' access INTO one application: only the capabilities that
 * name this application, grouped by caller. Revoking here takes away exactly
 * what is shown — never the caller's unrelated grants.
 * @param props - the captions, the grouped entries, the descriptions, the revoke command and the translate seat.
 * @returns the grouped list, or the "nobody" hint.
 */
export function GrantsIntoList({ title, empty, entries, describe, revoke, t, loaded = true, reading = false, failed = false, onRetry }: {
  readonly title: string
  readonly empty: string
  readonly entries: readonly { readonly caller: Caller; readonly capabilities: readonly string[] }[]
  readonly describe: (need: string) => NeedDescription
  readonly revoke: (caller: Caller, selector?: string) => Promise<boolean>
  readonly t: TranslateNS<'applications'>
} & ReadStateProps): ReactNode {
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [rowError, setRowError] = useState<string | undefined>(undefined)
  if (entries.length === 0) return <p className={css.hint}>{empty}</p>
  const disabled = !loaded || reading || failed
  const revokeOne = async (key: string, caller: Caller, capability: string): Promise<void> => {
    setPending(key)
    setRowError(undefined)
    const ok = await revoke(caller, capability)
    if (!ok) setRowError(key)
    setPending(undefined)
  }
  return (
    <div className={css.section}>
      <p className={css.sectionTitle}>{title}</p>
      {reading && <p className={css.hint} data-into-reading>{t('reads.loading')}</p>}
      {failed && (
        <p className={css.needError} role="alert" data-into-failed>
          {t('reads.failed')}
          {onRetry !== undefined && <Button size="sm" variant="ghost" onClick={onRetry} data-into-retry>{t('reads.retry')}</Button>}
        </p>
      )}
      <ul className={css.records}>
        {entries.map(entry => (
          <li key={callerLabel(entry.caller)} className={css.record}>
            <div className={css.recordHead}>
              <span>{callerLabel(entry.caller)}</span>
            </div>
            <ul className={css.capabilities}>
              {entry.capabilities.map(capability => {
                const description = describe(capability)
                const key = `${callerLabel(entry.caller)}\u0000${capability}`
                return (
                  <li key={capability} className={css.capability}>
                    <span className={css.capabilityText}>
                      <span>{description.label}</span>
                      {/* The exact operation and the exact caller: revoking here
                          takes away what is shown, and the wire id says which. */}
                      <code className={css.code}>{capability}</code>
                    </span>
                    <Button
                      size="sm"
                      disabled={disabled || pending === key}
                      data-grant-revoke={capability}
                      onClick={() => { void revokeOne(key, entry.caller, capability) }}
                    >
                      {pending === key ? t('grants.pending') : t('grants.revoke')}
                    </Button>
                    {rowError === key && <p className={css.needError} role="alert" data-grant-error={capability}>{t('grants.failed')}</p>}
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Render the calls received by one application, newest first.
 * @param props - the records and the translate seat.
 * @returns the history list, or the empty hint.
 */
export function HistoryList({ records, t, loaded = true, reading = false, failed = false, onRetry }: {
  readonly records: readonly HistoryRecord[]
  readonly t: TranslateNS<'applications'>
} & ReadStateProps): ReactNode {
  if (!loaded) {
    return failed
      ? (
        <p className={css.needError} role="alert" data-history-failed>
          {t('reads.failed')}
          {onRetry !== undefined && <Button size="sm" variant="ghost" onClick={onRetry} data-history-retry>{t('reads.retry')}</Button>}
        </p>
      )
      : <p className={css.hint} data-history-reading>{t('reads.loading')}</p>
  }
  return (
    <>
      {reading && <p className={css.hint} data-history-stale>{t('reads.loading')}</p>}
      {failed && (
        <p className={css.needError} role="alert" data-history-failed>
          {t('reads.failed')}
          {onRetry !== undefined && <Button size="sm" variant="ghost" onClick={onRetry} data-history-retry>{t('reads.retry')}</Button>}
        </p>
      )}
      {records.length === 0
        ? <p className={css.hint}>{t('history.empty')}</p>
        : (
          <ul className={css.records}>
            {records.map(record => (
              <li key={record.callId} className={css.record}>
                <div className={css.recordHead}>
                  <code className={css.code}>{record.op}</code>
                  <code className={css.code}>{record.status}</code>
                  {record.code !== undefined && <code className={css.code}>{record.code}</code>}
                </div>
                <div className={css.recordMeta}>
                  <span>{t('history.caller')}: {callerLabel(record.caller)}</span>
                  <span>{record.startedAt} → {record.endedAt}</span>
                </div>
                {record.message !== undefined && <p className={css.recordMessage}>{record.message}</p>}
              </li>
            ))}
          </ul>
        )}
    </>
  )
}

/**
 * Render the confirmations waiting for a human answer. The waiting call only
 * proceeds after an answer: allowing runs this one call, denying refuses it,
 * and "allow and remember" writes the durable grant the question names.
 * @param props - the pending confirmations, the answer command and the translate seat.
 * @returns the confirmation list, or the empty hint.
 */
export function ConfirmationsList({ confirmations, answer, cancelConfirmation, sentence, t, loaded = true, reading = false, failed = false, onRetry }: {
  readonly confirmations: readonly PendingConfirmation[]
  readonly answer: (id: string, decision: ConfirmationDecision) => Promise<boolean>
  /** End a waiting question without running the call. */
  readonly cancelConfirmation: (id: string) => Promise<boolean>
  /** The localized sentence built from the request's structured fields. */
  readonly sentence: (request: PendingConfirmation) => string
  readonly t: TranslateNS<'applications'>
} & ReadStateProps): ReactNode {
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [rowError, setRowError] = useState<string | undefined>(undefined)
  const now = Date.now()

  if (!loaded) {
    return failed
      ? (
        <p className={css.needError} role="alert" data-confirm-failed>
          {t('confirm.loadFailed')}
          {onRetry !== undefined && <Button size="sm" variant="ghost" onClick={onRetry} data-confirm-retry>{t('reads.retry')}</Button>}
        </p>
      )
      : <p className={css.hint} data-confirm-reading>{t('confirm.loading')}</p>
  }

  const decide = async (id: string, decision: ConfirmationDecision): Promise<void> => {
    setPending(id)
    setRowError(undefined)
    const ok = await answer(id, decision)
    if (!ok) setRowError(id)
    setPending(undefined)
  }
  const withdraw = async (id: string): Promise<void> => {
    setPending(id)
    setRowError(undefined)
    const ok = await cancelConfirmation(id)
    if (!ok) setRowError(id)
    setPending(undefined)
  }

  return (
    <>
      {reading && <p className={css.hint} data-confirm-stale>{t('reads.loading')}</p>}
      {failed && (
        <p className={css.needError} role="alert" data-confirm-failed>
          {t('confirm.loadFailed')}
          {onRetry !== undefined && <Button size="sm" variant="ghost" onClick={onRetry} data-confirm-retry>{t('reads.retry')}</Button>}
        </p>
      )}
      {confirmations.length === 0
        ? <p className={css.hint}>{t('confirm.empty')}</p>
        : (
          <ul className={css.records}>
            {confirmations.map(request => {
              const busy = pending === request.id
              // "Allow and remember" needs a session to belong to; an anonymous
              // AI call can only be allowed once.
              return (
                <li key={request.id} className={css.record} data-confirmation={request.id}>
                  <p className={css.recordMessage} data-confirm-sentence>{sentence(request)}</p>
                  <p className={css.hint} data-confirm-waiting>{t('confirm.waitingFor', { minutes: String(waitingMinutes(now, request.at)) })}</p>
                  {busy && <p className={css.needPending} data-confirm-pending>{t('confirm.pending')}</p>}
                  {rowError === request.id && <p className={css.needError} role="alert" data-confirm-row-error>{t('confirm.failed')}</p>}
                  <div className={css.actions}>
                    <Button variant="primary" size="sm" disabled={busy} data-confirm-allow-once onClick={() => { void decide(request.id, 'allowed-once') }}>
                      {t('confirm.allowOnce')}
                    </Button>
                    <Button size="sm" disabled={busy} data-confirm-deny onClick={() => { void decide(request.id, 'denied') }}>{t('confirm.deny')}</Button>
                    <Button size="sm" disabled={busy} data-confirm-withdraw onClick={() => { void withdraw(request.id) }}>{t('confirm.withdraw')}</Button>
                  </div>
                  <details className={css.needDetails} data-confirm-details>
                    <summary>{t('confirm.technical')}</summary>
                    <code>{request.capability}</code>
                    <code>{callerLabel(request.caller)}</code>
                    <p>{request.reason}</p>
                    <time dateTime={request.at} title={request.at}>{localStamp(request.at)}</time>
                  </details>
                </li>
              )
            })}
          </ul>
        )}
    </>
  )
}

/** Whole minutes a question has been waiting (never negative). */
function waitingMinutes(now: number, iso: string): number {
  const asked = Date.parse(iso)
  return Number.isNaN(asked) ? 0 : Math.max(0, Math.floor((now - asked) / 60_000))
}

/** A wire timestamp in the browser's local zone; the raw ISO stays in the tooltip. */
function localStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date)
}

/** One application's external-operation policies, one selector per open operation. */
export function PoliciesList({ app, policies, setPolicy, t, loaded = true, reading = false, failed = false, onRetry }: ReadStateProps & {
  readonly app: Pick<import('@matrix1001/dsh-application-harness-host-bridge/client').AppInfo, 'id' | 'ops'>
  readonly policies: readonly import('@matrix1001/dsh-application-harness-host-bridge/client').OperationPolicyEntry[]
  readonly setPolicy: (appId: string, op: string, policy: import('@matrix1001/dsh-application-harness-host-bridge/client').OperationPolicy) => Promise<boolean>
  readonly t: TranslateNS<'applications'>
}): ReactNode {
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const ops = app.ops.filter((op) =>
    (op.exposure.ai ?? 'closed') !== 'closed' || (op.exposure.peers ?? 'closed') !== 'closed')
  if (ops.length === 0) return <p className={css.hint}>{t('policy.empty')}</p>
  const policyOf = (op: string): import('@matrix1001/dsh-application-harness-host-bridge/client').OperationPolicy =>
    policies.find(entry => entry.appId === app.id && entry.operation === op)?.policy ?? 'default'
  return (
    <section>
      <h3 className={css.needTitle}>{t('policy.title')}</h3>
      {reading && <p className={css.hint} data-policies-reading>{t('reads.loading')}</p>}
      {failed && (
        <p className={css.needError} role="alert" data-policies-failed>
          {t('reads.failed')}
          {onRetry !== undefined && <Button size="sm" variant="ghost" onClick={onRetry} data-policies-retry>{t('reads.retry')}</Button>}
        </p>
      )}
      {writeError !== undefined && <p className={css.needError} role="alert" data-policy-error>{writeError}</p>}
      {loaded && (
        <ul className={css.needList}>
          {ops.map((op) => {
            const current = policyOf(op.name)
            const exposure = op.exposure
            return (
              <li className={css.need} data-app-policy={op.name} data-policy-state={current} key={op.name}>
                <div className={css.needHead}>
                  <span className={css.needName}>{op.name}</span>
                  <select
                    aria-label={t('policy.for', { op: op.name })}
                    value={current}
                    disabled={pending !== undefined}
                    onChange={(event) => {
                      const next = event.target.value as import('@matrix1001/dsh-application-harness-host-bridge/client').OperationPolicy
                      setPending(op.name)
                      setWriteError(undefined)
                      void setPolicy(app.id, op.name, next).then((ok) => {
                        setPending(undefined)
                        if (!ok) setWriteError(t('policy.saveFailed'))
                      })
                    }}
                  >
                    <option value="default">{t('policy.default')}</option>
                    <option value="allow">{t('policy.allow')}</option>
                    <option value="confirm">{t('policy.confirm')}</option>
                    <option value="forbid">{t('policy.forbid')}</option>
                  </select>
                </div>
                <p className={css.needPurpose}>
                  {t('policy.authorDefaults', {
                    ai: exposure.ai ?? 'closed',
                    peers: exposure.peers ?? 'closed',
                  })}
                </p>
                {pending === op.name && <p className={css.needPending} data-policy-pending>{t('policy.pending')}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
