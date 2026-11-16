/**
 * The shared face of a cross-application object reference. Application views
 * inline this library instead of importing another plugin bundle: it shows
 * only the reference, title and summary the owning application resolved, and
 * either opens the object in the current application or switches to the owner.
 * @module @matrix1001/dsh-application-harness-client-object-reference
 */
import type { ReactElement } from 'react'
import css from './object-reference.module.css'

/** The structural reference shape; the owning application resolves the content. */
export interface ObjectReferenceValue {
  readonly appId: string
  readonly type: string
  readonly id: string
}

/** What one object reference renders from. */
export interface ObjectReferenceProps {
  readonly object: ObjectReferenceValue
  readonly title: string
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
export function ObjectReference({ object, title, summary, onOpen, onSwitch, unavailable = false, attrs = {} }: ObjectReferenceProps): ReactElement {
  const action = onOpen === undefined ? (onSwitch === undefined ? undefined : () => { onSwitch(object.appId) }) : () => { onOpen(object) }
  const body = (
    <>
      <span className={css.title}>{title}</span>
      {summary !== undefined && <span className={css.summary}>{summary}</span>}
      <span className={css.id}>{`${object.appId}/${object.type}/${object.id}`}</span>
    </>
  )
  if (unavailable || action === undefined) {
    return <span className={css.objectRef} data-object-ref data-unavailable={unavailable ? 'true' : undefined} {...attrs}>{body}</span>
  }
  return (
    <button
      type="button"
      className={css.objectRef}
      data-object-ref
      data-app-id={object.appId}
      data-object-type={object.type}
      data-object-id={object.id}
      {...attrs}
      onClick={action}
    >
      {body}
    </button>
  )
}
