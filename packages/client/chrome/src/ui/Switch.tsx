/** Accessible switch built from the chrome's own button surface. */
import css from './ui.module.css'

export interface SwitchProps {
  readonly checked: boolean
  readonly disabled?: boolean
  readonly label: string
  readonly onChange: (checked: boolean) => void
}

export function Switch({ checked, disabled = false, label, onChange }: SwitchProps) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={css.switch} onClick={() => { onChange(!checked) }}
    >
      <span className={css.switchThumb} aria-hidden="true" />
    </button>
  )
}
