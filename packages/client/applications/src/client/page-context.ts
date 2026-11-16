/**
 * The page-context store: what the page currently on screen is showing, in the
 * page's own words, for the reference source (`page-source.ts`) to offer as a
 * chip.
 *
 * Deliberately a plain object, not a Cordis service: the shell's panel renders
 * views with the face this store mints, no other plugin reads it, and a
 * Context-free store is what lets the rules below be exercised as a plain
 * object in tests.
 *
 * The three rules the store enforces:
 *
 * - **owner-stamped** — a report names the application whose page made it, so a
 *   view can only ever speak for the page the shell rendered for it;
 * - **newest wins** — a page that reports again (a selection moved) replaces
 *   its previous context in one step rather than accumulating;
 * - **cleanup is exact** — the disposer a report returns clears only that
 *   report: a disposer that lost the race (the page reported again, another
 *   page took over) is a no-op, so React's cleanup-after-update ordering can
 *   never blank a newer context.
 * @module @matrix1001/dsh-application-harness-client-applications/client/page-context
 */

import type { PageContext, PageContextInput, PageContextService } from './contract.ts'

/**
 * Create one store.
 * @returns the service face; the plugin owns the instance for its own fiber's lifetime.
 */
export function createPageContext(): PageContextService {
  let current: PageContext | undefined
  let reportSeq = 0
  const listeners = new Set<() => void>()
  const changed = (): void => { for (const listener of listeners) listener() }
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    report(appId, input: PageContextInput) {
      reportSeq += 1
      const generation = reportSeq
      current = { appId, ...input }
      changed()
      return () => {
        if (generation === reportSeq) {
          current = undefined
          changed()
        }
      }
    },
  }
}
