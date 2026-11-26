/**
 * The application reference source: the `@` row that names an application
 * itself, as opposed to a page or record inside it.
 *
 * The token is `@app:<appId>`. The host uses it for identity and read scope;
 * the data is read later by the unified `applications` tool, never pre-fetched by
 * the menu.
 * @module @matrix1001/dsh-application-harness-client-applications/client/application-source
 */

import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApplicationsState } from './shell.ts'
import type { ApplicationView, ApplicationViewRegistry, PageContextService } from './contract.ts'
import { displayDescription, displayName, statusView } from './model.ts'
import { appToken } from './page-token.ts'
import type { PageSourceSessions } from './page-source.ts'

/** The source's stable registration identity and chip owner id. */
export const APPLICATION_SOURCE_NAME = 'application'

/** The registered glyph as a candidate icon, when the application has one. */
function iconOf(view: ApplicationView | undefined): InputTriggerCandidate['icon'] | undefined {
  const icon = view?.icon
  if (icon === undefined) return undefined
  return ((props: { readonly size?: number }) => icon({ size: props.size ?? 16 })) as InputTriggerCandidate['icon']
}

/**
 * Build the application reference source.
 * @param state - the shell's application rows.
 * @param views - the view registry, for localized names/descriptions.
 * @param pageContext - the current page, whose application is already covered by
 *   the page row when this Session can attach page context.
 * @param pageSessions - the Session ownership test the page source uses.
 * @param t - the applications dictionary.
 * @returns the trigger source (register it through `ctx.inputTriggers`).
 */
export function createApplicationSource(
  state: { getSnapshot(): ApplicationsState },
  views: ApplicationViewRegistry,
  pageContext: PageContextService,
  pageSessions: PageSourceSessions | undefined,
  t: TranslateNS<'applications'>,
): InputTriggerSource {
  return {
    trigger: '@',
    name: APPLICATION_SOURCE_NAME,
    order: -5,
    showGroupTitle: false,
    candidates: (session) => {
      const apps = state.getSnapshot().apps
      if (apps === undefined) return Promise.resolve([])
      const current = pageContext.current()
      const boundApp = pageSessions?.boundApp(session.sessionId)
      // Only skip the current application when the page source will actually
      // offer it; an ordinary Session has no page row and must keep the app.
      const represented = current !== undefined && pageSessions?.isOwner(session.sessionId) === true
        && (boundApp === undefined || boundApp === current.appId)
        ? current.appId
        : undefined
      const map = views.views()
      const rows: InputTriggerCandidate[] = []
      for (const app of apps) {
        if (app.id === represented) continue
        const view = map.get(app.id)
        const hint = statusView(app, t).label
        const icon = iconOf(view)
        rows.push({
          name: app.id,
          label: displayName(app, view),
          description: displayDescription(app, view),
          value: appToken(app.id),
          section: t('reference.applications'),
          ...(hint === undefined ? {} : { hint }),
          ...(icon === undefined ? {} : { icon }),
        })
      }
      return Promise.resolve(rows)
    },
    onPick: ({ candidate }) => {
      const ref = candidate.value
      if (ref === undefined) throw new Error('application: the picked row carried no reference')
      return {
        insert: {
          source: APPLICATION_SOURCE_NAME,
          ref,
          label: candidate.label ?? candidate.name,
          clipboardText: ref,
        },
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
}
