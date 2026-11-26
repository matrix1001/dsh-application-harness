/**
 * The `page` reference source: the `@page` menu row that attaches the page the
 * human is looking at to the draft.
 *
 * One row, offered for the page on screen: the row's name is the page's own
 * label for what it is showing, and its value — the reference the chip carries —
 * is the canonical token (`page-token.ts`). There is no pending/citation mode:
 * page references are composed where the page is actually visible.
 * Picking it inserts a normal reference chip whose model form IS that token, so
 * what enters the message text is decided at pick time and never re-derived from
 * whatever page happens to be open when the message is finally sent.
 * @module @matrix1001/dsh-application-harness-client-applications/client/page-source
 */

import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PageContext, PageContextService } from './contract.ts'
import { pageToken } from './page-token.ts'

/** The name this source registers under: the chip's owner id and its menu group key. */
export const PAGE_SOURCE_NAME = 'page'

/** Which Sessions receive page context, and which application a development Session is bound to. */
export interface PageSourceSessions {
  /** Whether the Session may attach page context (application-area or development). */
  readonly isOwner: (sessionId: string) => boolean
  /** The application a development Session is bound to, if it is one. */
  readonly boundApp: (sessionId: string) => string | undefined
}

/**
 * Build the source one plugin mount owns.
 * @param pageContext - the store the mounted page reports into.
 * @param t - the applications dictionary.
 * @param sessions - the Session ownership test; absent keeps the row offered everywhere.
 * @returns the trigger source (register it through `ctx.inputTriggers`).
 */
export function createPageSource(
  pageContext: PageContextService,
  t?: TranslateNS<'applications'>,
  sessions?: PageSourceSessions,
): InputTriggerSource {
  return {
    trigger: '@',
    name: PAGE_SOURCE_NAME,
    // The single row names the page itself; a group title would only repeat it.
    showGroupTitle: false,
    order: -10,
    candidates: (session) => {
      const context = pageContext.current()
      if (context === undefined) return Promise.resolve([])
      if (sessions !== undefined && !sessions.isOwner(session.sessionId)) return Promise.resolve([])
      const boundApp = sessions?.boundApp(session.sessionId)
      if (boundApp !== undefined && context.appId !== boundApp) return Promise.resolve([])
      return Promise.resolve([candidateOf(context, t?.('reference.currentPage') ?? 'Current page')])
    },
    onPick: ({ candidate }) => {
      const ref = candidate.value
      // The row is the source's own: one that reached a pick without its value
      // is a registration bug, and inserting a made-up reference would send the
      // message with a citation the human never chose.
      if (ref === undefined) throw new Error('page: the picked row carried no reference')
      return { insert: { source: PAGE_SOURCE_NAME, ref, label: candidate.name, clipboardText: ref } }
    },
    codec: {
      // Copying a chip keeps the token: it is what the message will carry.
      clipboardText: ref => ref,
      // The model form IS the token — the host parses exactly these strings.
      serialize: ref => Promise.resolve(ref),
    },
  }
}

/**
 * Project one page context as the menu row.
 * @param context - the reported context.
 * @returns the row: the page's label, what the page says about the selection (or the token it will attach), and the token as the pick payload.
 */
function candidateOf(context: PageContext, section: string): InputTriggerCandidate {
  const ref = pageToken(context.appId, context.record)
  return {
    name: context.label,
    description: context.selectionNote ?? ref,
    value: ref,
    section,
  }
}
