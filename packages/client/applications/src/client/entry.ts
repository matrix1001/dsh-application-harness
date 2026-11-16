/**
 * The applications ENTRY: the one typed way another surface (the sidebar's own
 * row, the window-chrome controls) tells this framework that a human activated
 * the applications panel.
 *
 * Why a service and not a slot button: the platform's rail row can only call
 * `layout.selectPanel(id)`, and selecting the panel the user is already on
 * changes nothing — the second click on the entry would do nothing at all.
 * The framework owns the panel id, the navigation preference and the one-shot
 * request this store hands to the area, so the entry's behaviour (restore the
 * last application and open the navigation; toggle it when already there)
 * lives with the navigation it moves, not with the button that was clicked.
 *
 * The request survives until the area CONSUMES it — including across the
 * area's first mount, which is exactly the from-conversation case (`activate`
 * runs, the platform mounts the panel, the area takes the request as it
 * mounts). Programmatic selection never creates one, so a refresh or a
 * restored preference never looks like a user activation.
 * @module @matrix1001/dsh-application-harness-client-applications/client/entry
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One activation the area has not consumed yet. */
export interface EntryRequest {
  /**
   * Whether the area was ALREADY on screen when the entry was activated: a
   * toggle (the human clicked the entry they are on) rather than an entry.
   */
  readonly toggle: boolean
}

/**
 * The entry service, as the client Context exposes it (the sidebar reaches it
 * through `ctx.get('applicationsEntry')` — optionally, so a composition
 * without this framework simply has no such service).
 */
export interface ApplicationEntryService extends HostObservable<EntryRequest | undefined> {
  /** The main panel key the area is mounted under. */
  readonly panelId: string
  /**
   * Activate the applications entry: remember whether this is a toggle, select
   * the panel, and leave the area exactly one request to consume.
   */
  activate(): void
  /**
   * The area's own half: take the pending request, if there is one.
   * @returns the request, or undefined when there is nothing to do.
   */
  consume(): EntryRequest | undefined
}

/** What the service needs from the layout it moves: the current panel, and the way to select one. */
export interface EntryLayout {
  /** The panel selected right now (the platform's own layout face). */
  activePanelId(): string | null
  /** Select one panel (the platform's own layout face). */
  selectPanel(id: string): void
}

/**
 * Create the entry service for one panel.
 * @param panelId - the main panel key the applications area is registered under.
 * @param layout - the layout face the selection rides on.
 * @returns the service; the plugin owns it for its own fiber's lifetime.
 */
export function createEntry(panelId: string, layout: EntryLayout): ApplicationEntryService {
  let pending: EntryRequest | undefined
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const listener of [...listeners]) listener() }
  return {
    panelId,
    getSnapshot: () => pending,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    activate() {
      // Read the selection BEFORE moving it: that answer is the difference
      // between "open the navigation" and "the human clicked the entry again".
      pending = { toggle: layout.activePanelId() === panelId }
      publish()
      layout.selectPanel(panelId)
    },
    consume() {
      const request = pending
      pending = undefined
      return request
    },
  }
}
