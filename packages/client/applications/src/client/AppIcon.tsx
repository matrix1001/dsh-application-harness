/**
 * The one place the framework draws an application's glyph: the navigation row,
 * the quick switcher, the header and the management list all render this, so
 * the same application never appears with two different faces. A registration
 * that declares no icon gets the platform's neutral plugin glyph — the
 * framework owns the fallback so a missing icon can never render as nothing.
 * @module @matrix1001/dsh-application-harness-client-applications/client/AppIcon
 */
import type { ReactNode } from 'react'
import { IconCordisPluginOutlineRegular } from '@matrix1001/dsh-application-harness-client-chrome'
import type { ApplicationView } from './contract.ts'
import css from './ApplicationsArea.module.css'

/** What the glyph renders from. */
export interface AppIconProps {
  /** The registration the icon belongs to. */
  readonly view: ApplicationView | undefined
  /** The pixel size the place needs. */
  readonly size: number
}

/** The tone class of one registration (neutral for anything undeclared). */
export function toneClass(view: ApplicationView | undefined): string {
  // The CSS-module map types every class as possibly absent; the classes are
  // compiled in, and the empty string keeps the join safe either way.
  const tone = ((): string | undefined => {
    switch (view?.tone) {
      case 'business': return css.toneBusiness
      case 'success': return css.toneSuccess
      case 'warn': return css.toneWarn
      case 'error': return css.toneError
      default: return css.toneNeutral
    }
  })()
  return tone ?? ''
}

/**
 * Render one application's glyph.
 * @param props - the registration and the size.
 * @returns the icon element.
 */
export function AppIcon({ view, size }: AppIconProps): ReactNode {
  const icon = view?.icon
  return (
    <span className={`${css.appIcon ?? ''} ${toneClass(view)}`} aria-hidden="true" data-app-icon>
      {icon === undefined ? <IconCordisPluginOutlineRegular size={size} /> : icon({ size })}
    </span>
  )
}
