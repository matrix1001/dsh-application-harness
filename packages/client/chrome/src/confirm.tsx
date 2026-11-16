/**
 * The shared promise-based confirmation layer for destructive actions and
 * unsaved-work leave guards. It is rendered by the page that owns the decision,
 * so it stays inside the application surface without a portal.
 * @module
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './confirm.module.css'
import { useModalFocus } from './modal-focus.ts'

/** One confirmation question. All visible strings are supplied by the caller. */
export interface ConfirmOptions {
  readonly title: string
  readonly body?: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  /** Use the danger treatment for destructive confirms. */
  readonly danger?: boolean
}

/** The imperative half and the element half of one confirmation layer. */
export interface ConfirmController {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  dialog: ReactNode
}

/**
 * Own one confirmation layer. A second request settles the first as `false`, so
 * two decisions can never share one answer.
 * @returns the `confirm` promise and the dialog element to render in the page.
 */
export function useConfirm(): ConfirmController {
  const [request, setRequest] = useState<ConfirmOptions>()
  const resolver = useRef<((value: boolean) => void) | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value)
    resolver.current = undefined
    setRequest(undefined)
  }, [])

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => new Promise<boolean>((resolve) => {
    resolver.current?.(false)
    resolver.current = resolve
    setRequest(options)
  }), [])

  useEffect(() => () => { resolver.current?.(false) }, [])
  useModalFocus(request !== undefined, panelRef, () => { settle(false) }, cancelRef)

  const dialog = request === undefined ? null : (
    <div
      className={css.backdrop}
      data-confirm-backdrop
      onMouseDown={(event) => { if (event.target === event.currentTarget) settle(false) }}
    >
      <div
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        tabIndex={-1}
        ref={panelRef}
        data-confirm-dialog
      >
        <h2 className={css.title}>{request.title}</h2>
        {request.body === undefined ? null : <p className={css.body}>{request.body}</p>}
        <div className={css.actions}>
          <button type="button" className={css.button} ref={cancelRef} onClick={() => { settle(false) }} data-confirm-cancel>
            {request.cancelLabel}
          </button>
          <button
            type="button"
            className={`${css.button} ${request.danger === true ? css.danger : css.primary}`}
            onClick={() => { settle(true) }}
            data-confirm-accept
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )

  return { confirm, dialog }
}
