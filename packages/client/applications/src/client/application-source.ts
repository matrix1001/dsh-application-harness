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
import type { ApplicationViewRegistry, PageContextService } from './contract.ts'
import { displayDescription, displayName } from './model.ts'
import { appToken } from './page-token.ts'

/** The source's stable registration identity and chip owner id. */
export const APPLICATION_SOURCE_NAME = 'application'

/**
 * Build the application reference source.
 * @param state - the shell's application rows.
 * @param views - the view registry, for localized names/descriptions.
 * @param pageContext - the current page, whose application is already covered by
 *   the page row and must not be offered twice.
 * @param t - the applications dictionary.
 * @returns the trigger source (register it through `ctx.inputTriggers`).
 */
export function createApplicationSource(
  state: { getSnapshot(): ApplicationsState },
  views: ApplicationViewRegistry,
  pageContext: PageContextService,
  t: TranslateNS<'applications'>,
): InputTriggerSource {
  return {
    trigger: '@',
    name: APPLICATION_SOURCE_NAME,
    order: -5,
    showGroupTitle: false,
    candidates: () => {
      const apps = state.getSnapshot().apps
      if (apps === undefined) return Promise.resolve([])
      const represented = pageContext.current()?.appId
      const map = views.views()
      const rows: InputTriggerCandidate[] = []
      for (const app of apps) {
        if (app.status !== 'available' || app.id === represented) continue
        const view = map.get(app.id)
        rows.push({
          name: app.id,
          label: displayName(app, view),
          description: displayDescription(app, view),
          value: appToken(app.id),
          section: t('reference.applications'),
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
