/**
 * The management request: which application's management page is showing (or
 * the list), and on which area.
 *
 * It belongs to the FRAMEWORK INSTANCE, not to the area component, for two
 * reasons the component cannot serve: a page is handed an `openManagement`
 * callback that binds its own application, and that callback must stay valid
 * (and stable, so a page can put it in an effect's dependencies) across the
 * area unmounting and remounting as the human moves between the conversation
 * and the applications panel; and the header's menu, the list's rows and
 * the pages all open the same one page, so there is exactly one place that says
 * what it shows.
 *
 * Opening is a plain request, never an action: nothing here approves a
 * permission, changes the page underneath, or switches the managed
 * application (`M1`: managing B must not switch the business page A).
 * @module @matrix1001/dsh-application-harness-client-applications/client/manage
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManageRequest, ManageTab } from './contract.ts'
import type { SurfaceMemory } from './surface-scroll.ts'

/**
 * The dialog's remembered scroll positions, owned by the framework instance so
 * they survive the area unmounting (leaving the applications panel and coming
 * back), and pruned per application so a registration that goes away takes its
 * positions with it — never a second global map, and never a position that
 * outlives the surface it describes.
 */
export interface ManageScrollMemory extends SurfaceMemory {
  /**
   * Keep only the positions of the applications that still exist (and the
   * list's own): called whenever the registry changes.
   * @param appIds - the applications registered right now.
   */
  retain(appIds: ReadonlySet<string>): void
}

/** The management request the area renders and the pages reach in through. */
export interface ManageService extends HostObservable<ManageRequest | undefined> {
  /** Show one request: the list, or one application's detail at a tab. */
  open(request: ManageRequest): void
  /** Close the dialog (the area does this with itself when it leaves). */
  close(): void
  /**
   * The `openManagement(area)` one application's pages are handed: bound to that
   * application, and the SAME function for its whole registration — a page may
   * depend on it without re-running an effect on every repaint. The cache is the
   * service's own and dies with the plugin instance.
   * @param appId - the application the callback manages.
   * @returns the stable opener.
   */
  opener(appId: string): (tab: ManageTab) => void
  /** Where the dialog remembers its scroll positions (see {@link ManageScrollMemory}). */
  readonly scroll: ManageScrollMemory
}

/** The key one managed surface's position is kept under: the list, or one application's tab. */
export function manageScrollKey(appId: string | undefined, tab: ManageTab): string {
  return appId === undefined ? 'list' : `${appId}:${tab}`
}

/** The key the area-level settings page keeps its scroll position under. */
export const NETWORK_SETTING_SCROLL_KEY = 'setting:network'

/** The instance-owned memory: a plain map, pruned on registry changes. */
function createScrollMemory(): ManageScrollMemory {
  const positions = new Map<string, number>()
  return {
    get: (key) => positions.get(key),
    set: (key, value) => { positions.set(key, value) },
    retain: (appIds) => {
      for (const key of [...positions.keys()]) {
        const at = key.indexOf(':')
        if (at >= 0 && appIds.has(key.slice(0, at))) continue
        // The list, the fixed queues and the area-level settings pages are
        // shared surfaces; everything else — an application that is gone, or
        // any key this vocabulary does not name — is not a surface that exists.
        if (at < 0 && (key === 'list' || key.startsWith('queue:') || key.startsWith('setting:'))) continue
        positions.delete(key)
      }
    },
  }
}

/**
 * Create the management request store for one plugin instance.
 * @returns the service the plugin provides to its components and pages.
 */
export function createManageService(): ManageService {
  let current: ManageRequest | undefined
  const listeners = new Set<() => void>()
  const openers = new Map<string, (tab: ManageTab) => void>()
  const publish = (): void => { for (const listener of [...listeners]) listener() }
  return {
    scroll: createScrollMemory(),
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open(request) {
      // A fresh object every time, even for the same request: the area keys its
      // reads on it, and re-opening the tab you are already on is still one
      // explicit open (the dialog re-reads what it shows).
      current = { ...request }
      publish()
    },
    close() {
      if (current === undefined) return
      current = undefined
      publish()
    },
    opener(appId) {
      const existing = openers.get(appId)
      if (existing !== undefined) return existing
      const opener = (tab: ManageTab): void => {
        current = { appId, tab }
        publish()
      }
      openers.set(appId, opener)
      return opener
    },
  }
}
