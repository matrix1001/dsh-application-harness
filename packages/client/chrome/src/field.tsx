/**
 * The shared form field: a label, the caller's control, and the two lines that
 * belong to that control — its hint and its error. The control stays the
 * application's own (a native input, a select, a platform component): this
 * component owns only the stacking and the label/error association, never the
 * value, validation or write.
 *
 * The label is wired with `htmlFor`, so pass the control's `id`. A field whose
 * control cannot carry an id can still render, but then the label is not a
 * programmatic name — callers should prefer a real id.
 * @module @matrix1001/dsh-application-harness-client-chrome/field
 */
import type { ReactNode } from 'react'
import css from './shell.module.css'

/** Props of one form field. */
export interface FieldProps {
  /** The visible label text (already localized). */
  readonly label: ReactNode
  /** The id of the control this label names. */
  readonly htmlFor?: string | undefined
  /** A quiet explanation under the control. */
  readonly hint?: ReactNode
  /** The field's own error; rendered as an alert under the control. */
  readonly error?: ReactNode
  /** Mark the label as required (visual only; set the control's `required` too). */
  readonly required?: boolean
  /** Extra class merged onto the field root. */
  readonly className?: string | undefined
  /** The application's control. */
  readonly children: ReactNode
  /** Arbitrary `data-*` attributes forwarded to the field root. */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * Render one form field.
 * @param props - the label, the control, the optional hint/error and the id.
 * @returns the field block.
 */
export function Field({ label, htmlFor, hint, error, required = false, className, children, ...rest }: FieldProps): ReactNode {
  return (
    <div className={[css.field, className].filter(Boolean).join(' ')} data-field {...rest}>
      <label className={css.fieldLabel} htmlFor={htmlFor}>
        {label}
        {required && <span className={css.fieldRequired} aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint !== undefined && <span className={css.fieldHint}>{hint}</span>}
      {error !== undefined && <span className={css.fieldError} role="alert">{error}</span>}
    </div>
  )
}
