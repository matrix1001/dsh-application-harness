/**
 * The recently opened repositories — **client state**, deliberately: a
 * repository is the user's own choice and never something the application
 * stores. This module owns the small localStorage list (newest first,
 * deduplicated, capped), and a storage-less browser simply offers none.
 * @module @matrix1001/dsh-application-harness-git-browser-view/recent
 */

/** The localStorage key for the recent-root list (a UI convenience, not a business record). */
const KEY = 'dsh.git-browser.recent-repos.v1'

/** How many recent repositories the page remembers. */
export const RECENT_LIMIT = 5

/** The storage surface this module uses (a subset, injectable for tests). */
export type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Read the remembered repositories (best-effort: a missing or corrupt entry
 * reads as none — a convenience must never break the page).
 * @param storage - the storage to read (defaults to localStorage).
 * @returns the remembered roots, newest first.
 */
export function readRecentRepos(storage?: RecentStorage): string[] {
  const store = storage ?? safeLocalStorage()
  try {
    const raw = store?.getItem(KEY)
    if (raw === null || raw === undefined) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const repos: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item === '' || repos.includes(item)) continue
      repos.push(item)
    }
    return repos.slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/**
 * Remember one opened repository: newest first, no duplicates, capped.
 * @param root - the resolved repository root that was just opened.
 * @param storage - the storage to write (defaults to localStorage).
 * @returns the updated list (also returned when the write itself is refused).
 */
export function rememberRepo(root: string, storage?: RecentStorage): string[] {
  const store = storage ?? safeLocalStorage()
  const next = [root, ...readRecentRepos(store).filter((item) => item !== root)].slice(0, RECENT_LIMIT)
  try {
    store?.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: the list stays session-local, the page keeps working.
  }
  return next
}

/**
 * The environment's localStorage, or undefined when merely READING the property
 * throws (a privacy policy, an embedded context): the getter itself is outside
 * any caller's try, so it is guarded here.
 * @returns the storage, or undefined when the environment refuses access.
 */
function safeLocalStorage(): RecentStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
