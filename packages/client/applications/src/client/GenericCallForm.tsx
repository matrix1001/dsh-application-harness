/**
 * The debug face of an application that registers no view: pick an operation,
 * write its JSON arguments, call it. It is a development surface (the shell's
 * own generic way in), never a generated business UI — its result display and
 * error handling follow the same rules every view gets: the settled outcome is
 * the runtime's own, and a failure that produced no outcome is shown as the
 * Remote error it is.
 * @module @matrix1001/dsh-application-harness-client-applications/client/GenericCallForm
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo, CallOutcome, JsonValue, OpParamSchema } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { describeError } from './shell.ts'
import { CallOutcomeView } from './CallOutcomeView.tsx'
import css from './ApplicationsLists.module.css'

/** What the generic form needs: the row it renders and the shell's call pair. */
export interface GenericCallFormProps {
  /** The application whose operations the form calls. */
  readonly app: AppInfo
  /** Call one operation through the shell (in-flight state, cancellation and history are the shell's). */
  readonly call: (op: string, args: JsonValue, requestId?: string) => Promise<CallOutcome>
  /** Ask the host to cancel the call this form started. */
  readonly cancel: (requestId: string) => void
  /** The panel's translate seat. */
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the operation picker, the JSON argument box and the call controls.
 *
 * The form owns the whole lifetime of ITS call: the request id it minted, the
 * running marker, and the outcome or error that came back. It never reads the
 * application's "last settled outcome" — a background read landing during the
 * call would overwrite that, and the debug surface would show an answer to a
 * question nobody asked. The render site keys the form by application, so the
 * form, its arguments and its result never carry over to another target.
 * @param props - the application, the shell's call pair and the translate seat.
 * @returns the form.
 */
export function GenericCallForm({ app, call, cancel, t }: GenericCallFormProps): ReactNode {
  const [op, setOp] = useState(app.ops[0]?.name ?? '')
  const [args, setArgs] = useState('{}')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [outcome, setOutcome] = useState<CallOutcome | undefined>(undefined)
  // The id of the call THIS form started, so its cancel button names exactly
  // that call (another view may have its own call in flight at the same time).
  const [requestId, setRequestId] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<'json' | 'form'>('json')
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const selected = app.ops.find(candidate => candidate.name === op)
  useEffect(() => {
    setDrafts(Object.fromEntries(Object.entries(selected?.params ?? {}).map(([name, schema]) => [name, initialDraft(schema)])))
    setFieldErrors({})
  }, [op])

  const run = (parsed: JsonValue): void => {
    const id = crypto.randomUUID()
    setFailure(undefined)
    setOutcome(undefined)
    setRequestId(id)
    void call(op, parsed, id)
      .then((answer) => { setOutcome(answer) })
      // No outcome arrived: the Remote error is shown as itself, never as a
      // failure or a cancellation it is not.
      .catch((reason: unknown) => { setFailure(describeError(reason)) })
      .finally(() => { setRequestId(undefined) })
  }

  const submitJson = (): void => {
    let parsed: JsonValue
    try {
      parsed = JSON.parse(args) as JsonValue
    } catch {
      setFailure(t('call.invalidJson'))
      return
    }
    run(parsed)
  }

  const submitForm = (): void => {
    const argsObject: Record<string, JsonValue> = {}
    const errors: Record<string, string> = {}
    for (const [name, schema] of Object.entries(selected?.params ?? {})) {
      const parsed = parseDraft(schema, drafts[name])
      if (!parsed.ok) {
        errors[name] = parsed.required ? t('call.fieldRequired') : t('call.fieldInvalid')
        continue
      }
      if (parsed.value !== undefined) argsObject[name] = parsed.value
    }
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setFailure(t('call.formInvalid'))
      return
    }
    run(argsObject)
  }

  return (
    <div className={css.form}>
      <p className={css.formTitle}>{t('generic.title')}</p>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('call.op')}</span>
        <select
          className={css.select}
          value={op}
          onChange={(event) => { setOp(event.target.value); setArgs('{}'); setFailure(undefined); setOutcome(undefined) }}
        >
          {app.ops.map(candidate => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
        </select>
      </label>
      {selected !== undefined && <p className={css.fieldHint}>{selected.description}</p>}
      <div className={css.actions} data-call-mode>
        <Button size="sm" variant={mode === 'json' ? 'primary' : 'ghost'} data-call-mode-json onClick={() => { setMode('json') }}>{t('call.jsonMode')}</Button>
        <Button size="sm" variant={mode === 'form' ? 'primary' : 'ghost'} data-call-mode-form onClick={() => { setMode('form') }}>{t('call.formMode')}</Button>
      </div>
      {mode === 'json' ? (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('call.args')}</span>
          <textarea
            className={css.textarea}
            value={args}
            spellCheck={false}
            onChange={(event) => { setArgs(event.target.value) }}
          />
        </label>
      ) : (
        <div data-call-form-fields>
          {Object.entries(selected?.params ?? {}).map(([name, schema]) => (
            <label key={name} className={css.field} data-call-field={name}>
              <span className={css.fieldLabel}>{schema.title ?? name}{schema.required === true ? '' : ` (${t('call.optional')})`}</span>
              {renderField(name, schema, drafts[name], setDrafts)}
              {schema.description !== undefined && <span className={css.fieldHint}>{schema.description}</span>}
              {fieldErrors[name] !== undefined && <span className={css.formError} role="alert" data-call-field-error={name}>{fieldErrors[name]}</span>}
            </label>
          ))}
          {Object.keys(selected?.params ?? {}).length === 0 && <p className={css.hint}>{t('call.noParams')}</p>}
        </div>
      )}
      <div className={css.actions}>
        <Button variant="primary" size="sm" disabled={requestId !== undefined} onClick={() => { if (mode === 'form') submitForm(); else submitJson() }}>{t('call.run')}</Button>
        {requestId !== undefined && (
          <Button size="sm" onClick={() => { cancel(requestId) }}>{t('call.cancel')}</Button>
        )}
        {requestId !== undefined && <span className={css.running}>{t('call.running')}</span>}
      </div>
      {failure !== undefined && <p className={css.formError} role="alert" data-call-error>{failure}</p>}
      {outcome !== undefined && (
        <details className={css.resultDetails} open data-call-result-details>
          <summary>{t('call.result')}</summary>
          <Button size="sm" variant="ghost" data-call-copy onClick={() => { void copyOutcome(outcome) }}>{t('call.copy')}</Button>
          <div data-call-result>
            <CallOutcomeView outcome={outcome} t={t} />
          </div>
        </details>
      )}
    </div>
  )
}


/** The empty draft for one declared parameter. */
function initialDraft(schema: OpParamSchema): string | boolean {
  const kind = schemaKind(schema)
  if (kind === 'boolean') return false
  // A null parameter is always `null`; there is no input to type into.
  if (kind === 'null') return 'null'
  return ''
}

/** The schema's discriminator; a oneOf branch has no `type` field. */
function schemaKind(schema: OpParamSchema): string {
  return 'oneOf' in schema ? 'oneOf' : schema.type
}

/** Parse one form draft against its declared schema. */
function parseDraft(schema: OpParamSchema, draft: string | boolean | undefined): { ok: true; value: JsonValue | undefined } | { ok: false; required: boolean } {
  const required = schema.required === true
  const kind = schemaKind(schema)
  if (kind === 'boolean') return { ok: true, value: draft === true }
  const text = String(draft ?? '').trim()
  if (text === '') {
    if (required) return { ok: false, required }
    return { ok: true, value: undefined }
  }
  if (kind === 'string') return { ok: true, value: text }
  if (kind === 'number' || kind === 'integer') {
    const value = Number(text)
    if (!Number.isFinite(value) || (kind === 'integer' && !Number.isInteger(value))) return { ok: false, required: false }
    return { ok: true, value }
  }
  if (kind === 'null') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue }
  } catch {
    return { ok: false, required: false }
  }
}

/** Render one input for a simple schema; complex values stay JSON in the form. */
function renderField(name: string, schema: OpParamSchema, draft: string | boolean | undefined, setDrafts: (update: (current: Record<string, string | boolean>) => Record<string, string | boolean>) => void): ReactNode {
  const set = (value: string | boolean): void => { setDrafts(current => ({ ...current, [name]: value })) }
  const kind = schemaKind(schema)
  if (kind === 'boolean') {
    return <input type="checkbox" checked={draft === true} onChange={(event) => { set(event.target.checked) }} data-call-input={name} />
  }
  if (kind === 'string' && 'enum' in schema && schema.enum !== undefined) {
    return (
      <select className={css.select} value={String(draft ?? '')} onChange={(event) => { set(event.target.value) }} data-call-input={name}>
        {schema.required !== true && <option value="">—</option>}
        {schema.enum.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
      </select>
    )
  }
  if (kind === 'null') {
    return <span className={css.fieldHint}>null</span>
  }
  if (kind === 'array' || kind === 'object' || kind === 'json' || kind === 'oneOf') {
    return <textarea className={css.textarea} value={String(draft ?? '')} spellCheck={false} onChange={(event) => { set(event.target.value) }} data-call-input={name} placeholder={kind} />
  }
  return <input className={css.input} type={kind === 'number' || kind === 'integer' ? 'number' : 'text'} value={String(draft ?? '')} onChange={(event) => { set(event.target.value) }} data-call-input={name} />
}


/** Copy the settled outcome's JSON value where the browser allows it. */
async function copyOutcome(outcome: CallOutcome): Promise<void> {
  const text = JSON.stringify('value' in outcome ? outcome.value : outcome)
  try { await navigator.clipboard?.writeText(text) } catch { /* clipboard is best effort */ }
}
