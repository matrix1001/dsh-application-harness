/** The application chrome's own button: no platform UI package dependency. */
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import css from './ui.module.css'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'ghost' | 'outline'
  readonly size?: 'sm'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size, className, type = 'button', ...rest }, ref,
) {
  return <button {...rest} ref={ref} type={type} className={[
    css.button,
    size === 'sm' ? css.buttonSm : '',
    variant === 'primary' ? css.buttonPrimary : variant === 'ghost' ? css.buttonGhost : css.buttonOutline,
    className ?? '',
  ].filter(Boolean).join(' ')} />
})
