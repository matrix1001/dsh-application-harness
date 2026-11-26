/**
 * The application-area dock request: one Session another surface (the DSH
 * conversation header) wants shown in the area's Session tabs.
 *
 * The request lives on the framework instance so it survives the area being
 * mounted after the conversation header action selects the applications panel.
 * The area consumes it when it mounts; programmatic selection never creates
 * one.
 * @module @matrix1001/dsh-application-harness-client-applications/client/dock
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** What kind of Session a dock tab shows. */
export type DockTabKind = 'app-conversation' | 'development' | 'normal'

/** One Session the application-area dock should show. */
export interface DockRequest {
  readonly sessionId: string
  readonly kind: DockTabKind
  /** The application a development Session is bound to. */
  readonly appId?: string
}

/** The dock request the area consumes. */
export interface DockService extends HostObservable<DockRequest | undefined> {
  /** Ask the application area to show one Session and select the panel. */
  open(request: DockRequest): void
  /** The area has taken the request. */
  consume(): void
}

/**
 * Create the one-shot dock request store.
 * @returns the observable service.
 */
export function createDock(): DockService {
  let value: DockRequest | undefined
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open(request) {
      value = request
      emit()
    },
    consume() {
      if (value === undefined) return
      value = undefined
      emit()
    },
  }
}
