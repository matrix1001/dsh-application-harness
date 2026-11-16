/**
 * Cross-application record navigation: a small shell-owned stack, not a router.
 *
 * A page opens another application's record; the shell remembers where the
 * human came from, selects the target, and hands the target page a one-shot
 * route intent. Back returns to the origin page and record. Direct navigation
 * through the application switcher clears the stack, so the header never offers
 * a surprising "back" after an ordinary application switch.
 *
 * The stack is in memory only. No URL or browser history is involved.
 * @module @matrix1001/dsh-application-harness-client-applications/client/navigation
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { LeaveGuard, PageRecordRef, RouteIntent } from './contract.ts'

/** One remembered page location. */
export interface NavigationLocation {
  readonly appId: string
  readonly record?: PageRecordRef
  readonly view?: string
}

/** The observable navigation state the shell renders. */
export interface AppNavigationSnapshot {
  /** The one-shot destination the active page should consume. */
  readonly route?: RouteIntent
  /** The application that will be returned to, when the stack is non-empty. */
  readonly backAppId?: string
  readonly canBack: boolean
}

/** What a page can ask the shell to do. */
export interface AppNavigation {
  readonly state: HostObservable<AppNavigationSnapshot>
  open(input: { appId: string; record?: PageRecordRef; view?: string }): void
  back(): void
  /** Switch to another application, guarding the current page first. */
  select(appId: string): Promise<boolean>
  clear(): void
  registerGuard(appId: string, guard: LeaveGuard): () => void
}

/** The callbacks the service needs from the shell. */
export interface NavigationHost {
  currentAppId(): string | undefined
  currentLocation(): NavigationLocation | undefined
  select(appId: string): void
}

/** How many cross-application origins are remembered. */
const MAX_DEPTH = 20

/**
 * Create one navigation stack.
 * @param host - the shell's current app and selection callbacks.
 * @returns the navigation face and its observable state.
 */
export function createAppNavigation(host: NavigationHost): AppNavigation {
  let snapshot: AppNavigationSnapshot = { canBack: false }
  let nonce = 0
  const stack: NavigationLocation[] = []
  const guards = new Map<string, LeaveGuard>()
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  const setSnapshot = (next: AppNavigationSnapshot): void => {
    snapshot = next
    emit()
  }
  const canLeave = async (appId: string | undefined): Promise<boolean> => {
    if (appId === undefined) return true
    const guard = guards.get(appId)
    if (guard === undefined) return true
    try {
      return await guard()
    } catch {
      // A guard that cannot answer must not be treated as "safe to leave".
      return false
    }
  }
  const remember = (location: NavigationLocation): void => {
    stack.push(location)
    while (stack.length > MAX_DEPTH) stack.shift()
  }
  return {
    state: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    open(input) {
      void (async () => {
        const current = host.currentLocation()
        const appId = host.currentAppId()
        if (!await canLeave(appId)) return
        if (current !== undefined) remember(current)
        nonce += 1
        setSnapshot({ route: { ...input, nonce: String(nonce) }, canBack: stack.length > 0, ...(stack.length > 0 ? { backAppId: stack[stack.length - 1]!.appId } : {}) })
        host.select(input.appId)
      })()
    },
    back() {
      void (async () => {
        const origin = stack[stack.length - 1]
        if (origin === undefined) return
        if (!await canLeave(host.currentAppId())) return
        stack.pop()
        nonce += 1
        setSnapshot({ route: { ...origin, nonce: String(nonce) }, canBack: stack.length > 0, ...(stack.length > 0 ? { backAppId: stack[stack.length - 1]!.appId } : {}) })
        host.select(origin.appId)
      })()
    },
    async select(appId) {
      if (appId === host.currentAppId()) return true
      const current = host.currentAppId()
      if (current !== undefined && guards.has(current)) {
        if (!await canLeave(current)) return false
      }
      this.clear()
      host.select(appId)
      return true
    },
    clear() {
      stack.length = 0
      setSnapshot({ canBack: false })
    },
    registerGuard(appId, guard) {
      guards.set(appId, guard)
      return () => {
        if (guards.get(appId) === guard) guards.delete(appId)
      }
    },
  }
}
