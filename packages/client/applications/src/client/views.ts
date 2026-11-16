/**
 * The `applicationViews` registry: which package draws which application's
 * page and settings, and what view state each application keeps. A plain
 * observable source (getSnapshot + subscribe) rather than a store, because it
 * is the shell's own fact — the panel binds it through its inject hooks
 * compartment and every reader compares by reference.
 *
 * The view state lives here, beside the registration it belongs to: one store
 * per application, created on first use, dropped when the application
 * unregisters (the fields die with it — a registration that comes back starts
 * clean, and nothing of it is written anywhere the framework owns).
 * @module @matrix1001/dsh-application-harness-client-applications/client/views
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type {
  ApplicationUiPatch, ApplicationUiState, ApplicationView, ApplicationViewRegistry,
} from './contract.ts'

/** The registry plus the observable face the panel renders through. */
export interface ApplicationViews
  extends ApplicationViewRegistry, HostObservable<ReadonlyMap<string, ApplicationView>> {}

/**
 * One application's view state: the platform's own snapshot store, narrowed to
 * the contract's face. The store replaces wholesale, so the merge the contract
 * promises — dropping every field whose patch value is `undefined` — is done
 * here, once, for every writer.
 *
 * Deliberately NOT persisted: this store's job is to outlive the page COMPONENT
 * (switching application and coming back), which is a fact of the browser page.
 * Surviving a reload is the application's own business — its drafts, its
 * remembered tab, its last repository are its own storage — and a framework
 * copy of a SELECTION would come back pointing at a record the page has to
 * re-validate anyway (the workbook's own create-draft recovery, for one, reads
 * "no selection" as its cue). The area's layout preferences are the one thing
 * the framework does persist (`preferences.ts`), because §6.3 asks for exactly
 * that.
 * @returns the store a view binds and writes.
 */
function createUiStore(): SnapshotStore<ApplicationUiState> {
  const store = createSnapshotStore<ApplicationUiState>({})
  const set = store.set
  return {
    ...store,
    set: (patch: ApplicationUiPatch) => {
      const next: Record<string, JsonValue> = { ...store.getSnapshot() }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      set(next)
    },
  }
}

/**
 * Create one registry. A factory, never a module-level handle: the plugin owns
 * the instance for its own fiber's lifetime (registration discipline), and two
 * mounts (a test runtime, another profile) never share a table.
 * @returns the registry, its snapshot invalidated in the same step a view registers or unregisters.
 */
export function createApplicationViews(): ApplicationViews {
  const entries = new Map<string, ApplicationView>()
  const stores = new Map<string, SnapshotStore<ApplicationUiState>>()
  const listeners = new Set<() => void>()
  let snapshot: ReadonlyMap<string, ApplicationView> = new Map()
  const publish = (): void => {
    snapshot = new Map(entries)
    for (const listener of [...listeners]) listener()
  }
  return {
    register(appId, view) {
      if (entries.has(appId)) {
        throw new Error(`applicationViews: the application "${appId}" already has a registered view`)
      }
      if (view.Component === undefined && view.Settings === undefined) {
        throw new Error(`applicationViews: the application "${appId}" registers neither a page nor settings`)
      }
      entries.set(appId, view)
      publish()
      let live = true
      return () => {
        if (!live) return
        live = false
        entries.delete(appId)
        // The fields die with the registration: a page that registers again
        // starts clean, and nothing an old mount writes can reach the new one.
        stores.delete(appId)
        publish()
      }
    },
    views: () => snapshot,
    state(appId) {
      const existing = stores.get(appId)
      if (existing !== undefined) return existing
      const created = createUiStore()
      stores.set(appId, created)
      return created
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
