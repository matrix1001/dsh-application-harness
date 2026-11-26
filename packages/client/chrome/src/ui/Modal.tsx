/** The chrome's own modal shell, focused by `useModalFocus`. */
import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from '../modal-focus.ts'
import css from './ui.module.css'

export interface ModalProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly title?: string
  readonly description?: string
  readonly tone?: 'warning'
  readonly closeLabel?: string
  readonly footer?: ReactNode
  readonly headless?: boolean
  readonly className?: string
  readonly contentClassName?: string
  readonly children: ReactNode
}

export function Modal({ open, onClose, title, description, tone, closeLabel, footer, headless = false, className, contentClassName, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useModalFocus(open, panelRef, onClose)
  if (!open) return null
  return createPortal(
    <div className={css.modalRoot} role="presentation">
      <div className={css.modalMask} aria-hidden="true" data-modal-backdrop onClick={onClose} />
      <div
        ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={[css.modal, className ?? ''].filter(Boolean).join(' ')}
        data-modal-tone={tone}
      >
        {headless ? children : (
          <>
            <div className={css.modalHead}>
              <h2 className={css.modalTitle}>{title}</h2>
              <button type="button" className={css.modalClose} aria-label={closeLabel ?? title} onClick={onClose}>×</button>
            </div>
            <div className={[css.modalContent, contentClassName ?? ''].filter(Boolean).join(' ')}>
              {description === undefined ? null : <p className={css.modalDescription}>{description}</p>}
              {children}
            </div>
            {footer === undefined ? null : <div className={css.modalFooter}>{footer}</div>}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
