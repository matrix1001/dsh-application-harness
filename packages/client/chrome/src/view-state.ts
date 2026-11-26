/**
 * Binding a view to the framework's per-application view state: the page reads
 * its remembered fields from the store the framework hands it (`props.ui`) and
 * writes them back as the human changes them. The store outlives the React
 * mount, so switching application and coming back lands where the human left —
 * within this browser page: the store is memory only, and surviving a reload is
 * whatever the application's own storage does.
 *
 * What belongs here is this page's own working state — which tab, which scope,
 * which record is open, what was typed in a filter box or left unapplied in a
 * form. What must go through the application's own storage is what has to
 * survive a reload: the workbook's drafts, the recent repository list. Nothing
 * alive (a Promise, a handle, a DOM node) belongs in either.
 * @module
 */

import { useState, useSyncExternalStore } from 'react'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'

const NOOP_SUBSCRIBE = (): (() => void) => () => {}

/** The fields of one application's view state (JSON data only). */
export type ApplicationUiState = Readonly<Record<string, JsonValue>>

/** One write into the view state: named fields, with `undefined` dropping a field. */
export type ApplicationUiPatch = Readonly<Record<string, JsonValue | undefined>>

/** The view-state store the shell hands one registered page. */
export interface ApplicationUiStore {
  getSnapshot(): ApplicationUiState
  set(patch: ApplicationUiPatch): void
  subscribe(listener: () => void): () => void
}

/** A partial test double is not a store: only a complete face may receive a write. */
function usableStore(ui: ApplicationUiStore | undefined): ApplicationUiStore | undefined {
  if (ui === undefined) return undefined
  return typeof ui.getSnapshot === 'function' && typeof ui.subscribe === 'function' && typeof ui.set === 'function'
    ? ui
    : undefined
}

/** The current fields of one application's view state, as React state.
 * When the shell did not supply a store (embedded page tests, a standalone
 * render), the hook keeps an empty local snapshot instead of throwing. */
export function useUiState(ui?: ApplicationUiStore): ApplicationUiState {
  const [local] = useState<ApplicationUiState>({})
  const store = usableStore(ui)
  return useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, store?.getSnapshot ?? (() => local))
}

/**
 * One field of the view state, as a React value plus its setter. A value the
 * store does not hold (or holds in a shape this build no longer understands)
 * reads as the fallback — a stale entry from an older version never reaches the
 * page.
 * @param ui - the application's view state store.
 * @param key - the field's name inside it.
 * @param fallback - what an absent field reads as.
 * @param accept - optional guard for the stored value (an enumerated field
 *   rejects what it does not know).
 * @returns the value and the setter that writes it back (`undefined` clears the field).
 */
export function useUiField<T>(
  ui: ApplicationUiStore | undefined,
  key: string,
  fallback: T,
  accept?: (value: unknown) => value is T,
): readonly [T, (next: T) => void] {
  const [local, setLocal] = useState<ApplicationUiState>({})
  const store = usableStore(ui)
  const snapshot = useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, store?.getSnapshot ?? (() => local))
  const raw: unknown = Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key] : undefined
  const value = accept === undefined
    ? (raw === undefined ? fallback : raw as T)
    : (accept(raw) ? raw : fallback)
  const set = (next: T): void => {
    if (store !== undefined) {
      store.set({ [key]: next as JsonValue | undefined })
      return
    }
    setLocal((previous) => {
      const copy: Record<string, JsonValue> = { ...previous }
      if (next === undefined) delete copy[key]
      else copy[key] = next as JsonValue
      return copy
    })
  }
  return [value, set]
}

/**
 * One ENUMERATED field of the view state: a string from a known set, falling
 * back when the store holds nothing (or something this build dropped).
 * @param ui - the application's view state store.
 * @param key - the field's name inside it.
 * @param allowed - the values this build understands.
 * @param fallback - what an absent or unknown value reads as.
 * @returns the value and the setter that writes it back.
 */
export function useUiChoice<T extends string>(
  ui: ApplicationUiStore | undefined,
  key: string,
  allowed: readonly T[],
  fallback: T,
): readonly [T, (next: T) => void] {
  return useUiField<T>(ui, key, fallback, (value): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value))
}
