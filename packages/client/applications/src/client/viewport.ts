/**
 * The viewport store: which view the page on screen is drawing, and whether it
 * has settled. The framework reads it to give the reader their scroll position
 * back when they return to a view it remembers.
 *
 * The same three rules as the page-context store, for the same reasons:
 * owner-stamped (a view speaks only for the application the shell rendered),
 * newest wins (a tab switch replaces the report in one step), and cleanup is
 * exact (a disposer that lost the race clears nothing). It is additionally
 * observable: the area re-renders when a report lands, because the surface it
 * scrolls is the framework's own element.
 * @module @matrix1001/dsh-application-harness-client-applications/client/viewport
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ViewportInput } from './contract.ts'

/** One page's viewport report, stamped with the application whose page made it. */
export interface ViewportReport extends ViewportInput {
  /** The application whose page reported it. */
  readonly appId: string
}

/** The store's face: the current report, plus the subscription the area renders through. */
export interface ViewportService extends HostObservable<ViewportReport | undefined> {
  /** What the page on screen reports, or undefined when no page is reporting. */
  current(): ViewportReport | undefined
  /**
   * Record one application page's viewport.
   * @param appId - the application the reporting view draws.
   * @param input - the view's key and readiness.
   * @returns the disposer that clears this report (a no-op once a newer report replaced it, or once it did).
   */
  report(appId: string, input: ViewportInput): () => void
}

/**
 * Create one store.
 * @returns the service face; the plugin owns the instance for its own fiber's lifetime.
 */
export function createViewport(): ViewportService {
  let current: ViewportReport | undefined
  let reportSeq = 0
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const listener of [...listeners]) listener() }
  return {
    current: () => current,
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    report(appId, input: ViewportInput) {
      reportSeq += 1
      const generation = reportSeq
      const known = current
      // An unchanged report keeps the same object: every reader compares by
      // reference, and a page that re-reports the same view must not repaint
      // the area it is drawn in.
      if (known === undefined || known.appId !== appId || known.key !== input.key || known.ready !== input.ready) {
        current = { appId, key: input.key, ready: input.ready }
        publish()
      }
      return () => {
        if (generation !== reportSeq) return
        current = undefined
        publish()
      }
    },
  }
}
