/**
 * The application chrome's own tiny observable store: one immutable snapshot,
 * a listener set, and optional localStorage persistence for the area's
 * preferences. It replaces the platform client store value import; no platform
 * Client package is loaded by application code.
 * @module
 */

/** A selector hook over one snapshot source. */
export type SnapshotSelectorHook<T> = <S>(selector: (value: T) => S) => S

/** A synchronous observable value. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

/** One store's optional persistence. */
export interface SnapshotStoreOptions {
  readonly persist?: { readonly name: string }
}

/** Read a persisted value, or the fallback when storage is absent/corrupt. */
function readPersisted<T>(name: string, fallback: T): T {
  try {
    const text = globalThis.localStorage?.getItem(name)
    return text === null || text === undefined ? fallback : JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * Create one store, optionally persisted to localStorage.
 * @param initial - the value before any write.
 * @param options - the optional persistence key.
 * @returns the observable store.
 */
export function createSnapshotStore<T>(initial: T, options: SnapshotStoreOptions = {}): SnapshotStore<T> {
  const name = options.persist?.name
  let value = name === undefined ? initial : readPersisted(name, initial)
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      value = next
      if (name !== undefined) {
        try { globalThis.localStorage?.setItem(name, JSON.stringify(next)) } catch { /* quota/private mode: memory only */ }
      }
      for (const listener of [...listeners]) listener()
    },
  }
}
