// @vitest-environment jsdom
/**
 * The view-state binding every application page reads its remembered fields
 * through: a field's value comes from the framework's per-application store
 * (falling back when the store holds nothing this build understands), and
 * writing goes back into the same store as a merge.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationUiPatch, ApplicationUiState } from '@matrix1001/dsh-application-harness-client-applications/client'
import { useUiChoice, useUiField, useUiState } from '../src/view-state.ts'

afterEach(() => { cleanup() })

/** One store double shaped like the framework's, recording every write. */
function makeStore(initial: ApplicationUiState = {}): {
  readonly store: Parameters<typeof useUiState>[0]
  readonly writes: ApplicationUiPatch[]
  readonly current: () => ApplicationUiState
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const writes: ApplicationUiPatch[] = []
  return {
    store: {
      getSnapshot: () => snapshot,
      set: (patch) => {
        writes.push(patch)
        // The framework's own semantics: a field written as `undefined` drops.
        const next: Record<string, unknown> = { ...snapshot }
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete next[key]
          else next[key] = value
        }
        snapshot = next as ApplicationUiState
        for (const listener of [...listeners]) listener()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    writes,
    current: () => snapshot,
  }
}

describe('the view-state bindings', () => {
  it('reads a stored field and falls back when the store holds nothing', () => {
    const { store } = makeStore({ tab: 'tasks' })
    const view = renderHook(() => [
      useUiField(store, 'tab', 'home'),
      useUiField(store, 'missing', 'fallback'),
    ])
    expect(view.result.current[0]![0]).toBe('tasks')
    expect(view.result.current[1]![0]).toBe('fallback')
  })

  it('writes a field back as a merge (other fields survive)', () => {
    const { store, writes, current } = makeStore({ tab: 'tasks', scope: 'p1' })
    const view = renderHook(() => useUiField(store, 'tab', 'home'))
    act(() => { view.result.current[1]('notes') })
    expect(writes).toEqual([{ tab: 'notes' }])
    expect(current()).toEqual({ tab: 'notes', scope: 'p1' })
    // The binding repaints from the store's own notification.
    expect(view.result.current[0]).toBe('notes')
  })

  it('rejects a stored value the guard does not accept', () => {
    const { store } = makeStore({ tab: 42 })
    const view = renderHook(() => useUiField<string>(store, 'tab', 'home', (value): value is string => typeof value === 'string'))
    expect(view.result.current[0]).toBe('home')
  })

  it('accepts a stored value the guard understands', () => {
    const { store } = makeStore({ tab: 'notes' })
    const view = renderHook(() => useUiField<string>(store, 'tab', 'home', (value): value is string => typeof value === 'string'))
    expect(view.result.current[0]).toBe('notes')
  })

  it('binds an enumerated field, falling back on an unknown member', () => {
    const known = makeStore({ size: 'board' })
    const view = renderHook(() => useUiChoice(known.store, 'size', ['board', 'list'] as const, 'board'))
    expect(view.result.current[0]).toBe('board')

    const foreign = makeStore({ size: 'tree' })
    const other = renderHook(() => useUiChoice(foreign.store, 'size', ['board', 'list'] as const, 'board'))
    expect(other.result.current[0]).toBe('board')
  })

  it('keeps a local field when the shell supplied no store', () => {
    const view = renderHook(() => {
      const [value, set] = useUiField<string | undefined>(undefined, 'tab', 'home')
      const snapshot = useUiState(undefined)
      return { value, set, snapshot }
    })
    act(() => { view.result.current.set('notes') })
    expect(view.result.current.value).toBe('notes')
    act(() => { view.result.current.set(undefined) })
    expect(view.result.current.value).toBe('home')
    expect(Object.keys(view.result.current.snapshot)).toEqual([])
  })

  it('treats an incomplete store double as no store', () => {
    const partial = { getSnapshot: () => ({ tab: 'tasks' }), subscribe: () => () => undefined } as unknown as Parameters<typeof useUiState>[0]
    const view = renderHook(() => useUiField(partial, 'tab', 'home'))
    expect(view.result.current[0]).toBe('home')
    act(() => { view.result.current[1]('notes') })
    expect(view.result.current[0]).toBe('notes')
  })

  it('exposes the whole snapshot for pages that read several fields at once', () => {
    const { store, current } = makeStore({ tab: 'tasks', search: 'a' })
    const view = renderHook(() => useUiState(store))
    expect(view.result.current).toEqual({ tab: 'tasks', search: 'a' })
    act(() => { store!.set({ search: 'b' }) })
    expect(view.result.current).toEqual(current())
  })
})
