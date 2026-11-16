/**
 * The sidebar rail's applications glyph; the sidebar owns the button, the
 * label and the selected state around it.
 * @module @matrix1001/dsh-application-harness-client-applications/client/ApplicationsIcon
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar's panellist SlotMap row (the icon owner share).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the applications glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function ApplicationsIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.6" y="1.6" width="5.2" height="5.2" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9.2" y="1.6" width="5.2" height="5.2" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.6" y="9.2" width="5.2" height="5.2" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9.2" y="9.2" width="5.2" height="5.2" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
