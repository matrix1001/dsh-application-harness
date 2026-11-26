/**
 * The applications rail entry's trailing content: how many confirmations are
 * waiting for the human while the applications panel is not on screen.
 *
 * The sidebar owns the navigation row and its button; this entry contributes
 * inline text only, so it holds no interactive element (the platform contract
 * for `sidebar.panellist.trailing`). The live count arrives through the global
 * `applicationsRail` hook this plugin provides, because the slot declaration
 * carries no business inject face of its own.
 * @module @matrix1001/dsh-application-harness-client-applications/client/rail
 */
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@matrix1001/dsh-application-harness-client-chrome'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar's trailing SlotMap row (the owner share).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ApplicationsState } from './shell.ts'
import css from './ApplicationsArea.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Live applications state contributed by this plugin; absent when it is not mounted. */
    readonly useApplicationsRail?: SnapshotSelectorHook<ApplicationsState>
  }
}

/**
 * Render the pending-confirmation count for the applications rail entry.
 * @param props - the sidebar's trailing share plus this plugin's live state hook.
 * @returns the badge text, or nothing while no confirmation is waiting.
 */
export function ApplicationsRailBadge({
  useApplicationsRail, t,
}: PropsRuntime<'sidebar.panellist.trailing'> & PropsLocale<'applications'>): ReactNode {
  const pending = useApplicationsRail?.(state => state.confirmations.length) ?? 0
  if (pending === 0) return null
  return (
    <span className={css.railBadge} data-app-rail-badge>
      <span aria-hidden="true">{pending}</span>
      <span className={css.srOnly}>{t('rail.pending', { count: pending })}</span>
    </span>
  )
}
