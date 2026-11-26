/**
 * The platform Session row's leading marker: application-area and development
 * Sessions are the only rows whose identity is not visible from the platform's
 * own data, so this plugin contributes a small glyph there and carries the
 * full meaning in its accessible name.
 *
 * The marker sits in the row's 16px leading cell, which the platform replaces
 * with a status dot while that row has a higher-priority state; the row's
 * hover card and the dock tab remain the durable ways to see the same facts.
 * @module @matrix1001/dsh-application-harness-client-applications/client/session-marker
 */

import type { ReactNode } from 'react'
import { IconCodeOutlineRegular, IconNewChatOutlineRegular } from '@matrix1001/dsh-application-harness-client-chrome'
import type { SnapshotSelectorHook } from '@matrix1001/dsh-application-harness-client-chrome'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the workspace row slot this marker registers into.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ApplicationPreferences } from './preferences.ts'
import css from './ApplicationsArea.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** The area layout preferences, contributed by the applications plugin root. */
    readonly useApplicationsPreferences?: SnapshotSelectorHook<ApplicationPreferences>
  }
}

/**
 * Render the Session type marker, or nothing for an ordinary Session.
 * @param props - the row's Session id, the root preference/state hooks and the dictionary.
 * @returns the marker element.
 */
export function SessionRowMarker({
  sessionId, t, useApplicationsPreferences, useApplicationsRail,
}: PropsRuntime<'sidebar.session.row.leading'> & PropsLocale<'applications'>): ReactNode {
  const preferences = useApplicationsPreferences?.(snapshot => snapshot)
  const state = useApplicationsRail?.(snapshot => snapshot)
  if (preferences === undefined) return null
  const appSessions = preferences.appConversations
    ?? (preferences.appConversation === undefined ? [] : [preferences.appConversation])
  const application = appSessions.some(target => target.sessionId === sessionId)
  const development = (preferences.developmentSessions ?? []).find(entry => entry.sessionId === sessionId)
  if (!application && development === undefined) return null
  const appName = development === undefined
    ? undefined
    : state?.apps?.find(app => app.id === development.appId)?.name ?? development.appId
  const label = development === undefined
    ? t('marker.application')
    : t('marker.development', { app: appName ?? '' })
  return (
    <span
      className={css.sessionMarker}
      data-session-marker={development === undefined ? 'application' : 'development'}
      role="img"
      aria-label={label}
      title={label}
    >
      {development === undefined ? <IconNewChatOutlineRegular size={12} /> : <IconCodeOutlineRegular size={12} />}
    </span>
  )
}
