/**
 * The shared face of a cross-application object reference. Application views
 * inline this library instead of importing another plugin bundle: it shows
 * only the reference, title and summary the owning application resolved, and
 * either opens the object in the current application or switches to the owner.
 * @module @matrix1001/dsh-application-harness-client-object-reference
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import css from './object-reference.module.css'

/** The structural reference shape; the owning application resolves the content. */
export interface ObjectReferenceValue {
  readonly appId: string
  readonly type: string
  readonly id: string
}

/** The resolved display facts, structurally matching the runtime's ObjectResolution. */
export interface ObjectReferenceResolution {
  readonly ref: ObjectReferenceValue
  readonly title: string
  readonly summary?: string
}

/** The resolver shape a page passes from its `resolveObject` seat. */
export type ObjectReferenceResolver = (object: ObjectReferenceValue) => Promise<
  | { readonly ok: true; readonly value: ObjectReferenceResolution }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
>

/** What one object reference renders from. */
export interface ObjectReferenceProps {
  readonly object: ObjectReferenceValue
  /** Display title; when omitted and a resolver is supplied, the component resolves it. */
  readonly title?: string
  /**
   * Resolve the reference before rendering its title/summary. A title passed
   * explicitly wins and skips the call; a failed resolution keeps the ref.
   */
  readonly resolve?: ObjectReferenceResolver
  /** A localized type label; the raw type is the fallback. */
  readonly typeLabel?: string
  readonly summary?: string
  /** Open the object in the current application. */
  readonly onOpen?: (object: ObjectReferenceValue) => void
  /** Switch to the owning application when there is no local opener. */
  readonly onSwitch?: (appId: string) => void
  /** Render as static text (for deleted or unavailable objects). */
  readonly unavailable?: boolean
  /** Stable data attributes for the owning page's tests/automation. */
  readonly attrs?: Readonly<Record<`data-${string}`, string>>
}

/**
 * Render one object reference.
 * @param props - the reference, resolved title/summary and the action.
 * @returns the chip.
 */
export function ObjectReference({ object, title, resolve, typeLabel, summary, onOpen, onSwitch, unavailable = false, attrs = {} }: ObjectReferenceProps): ReactElement {
  const [resolution, setResolution] = useState<
    | { readonly status: 'idle' | 'loading' }
    | { readonly status: 'ok'; readonly title: string; readonly summary?: string }
    | { readonly status: 'failed'; readonly code: string }
  >({ status: 'idle' })
  // The resolver is read through a ref so an inline callback does not restart
  // the effect after the resolved state renders. Identity keys stay in deps.
  const resolver = useRef(resolve)
  resolver.current = resolve
  const shouldResolve = title === undefined && resolve !== undefined
  useEffect(() => {
    if (!shouldResolve) return
    let live = true
    setResolution({ status: 'loading' })
    void (async () => {
      try {
        const result = await resolver.current!(object)
        if (!live) return
        if (!result.ok) {
          setResolution({ status: 'failed', code: result.error.code })
          return
        }
        const value = result.value
        if (value.ref.appId !== object.appId || value.ref.type !== object.type || value.ref.id !== object.id) {
          setResolution({ status: 'failed', code: 'platform.object-mismatch' })
          return
        }
        setResolution({ status: 'ok', title: value.title, ...(value.summary === undefined ? {} : { summary: value.summary }) })
      } catch {
        if (live) setResolution({ status: 'failed', code: 'platform.object-unavailable' })
      }
    })()
    return () => { live = false }
  }, [object.appId, object.type, object.id, shouldResolve])
  const resolved = shouldResolve && resolution.status === 'ok' ? resolution : undefined
  const failed = shouldResolve && resolution.status === 'failed' ? resolution : undefined
  const displayTitle = title ?? resolved?.title ?? object.id
  const displaySummary = summary ?? resolved?.summary
  const resolving = shouldResolve && resolution.status !== 'ok' && resolution.status !== 'failed'
  const isUnavailable = unavailable || failed?.code === 'app.not-found'
  const action = onOpen === undefined ? (onSwitch === undefined ? undefined : () => { onSwitch(object.appId) }) : () => { onOpen(object) }
  const fullRef = `${object.appId}/${object.type}/${object.id}`
  const body = (
    <>
      <span className={css.kind}>{typeLabel ?? object.type}</span>
      <span className={css.title}>{displayTitle}</span>
      {displaySummary !== undefined && <span className={css.summary}>{displaySummary}</span>}
    </>
  )
  const stateAttributes = {
    'data-resolving': resolving ? 'true' : undefined,
    'data-resolution-error': failed?.code,
  }
  if (isUnavailable || action === undefined) {
    return <span className={css.objectRef} data-object-ref data-unavailable={isUnavailable ? 'true' : undefined} title={fullRef} {...stateAttributes} {...attrs}>{body}</span>
  }
  return (
    <button
      type="button"
      className={css.objectRef}
      data-object-ref
      data-app-id={object.appId}
      data-object-type={object.type}
      data-object-id={object.id}
      title={fullRef}
      {...stateAttributes}
      {...attrs}
      onClick={action}
    >
      {body}
    </button>
  )
}
