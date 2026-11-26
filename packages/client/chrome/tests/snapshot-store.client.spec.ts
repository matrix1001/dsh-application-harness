// @vitest-environment jsdom
/** The chrome's local observable store, including its localStorage mirror. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '../src/snapshot-store.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('createSnapshotStore', () => {
  it('keeps a stable snapshot and notifies subscribers until disposed', () => {
    const store = createSnapshotStore({ n: 1 })
    const listener = vi.fn()
    const off = store.subscribe(listener)
    expect(store.getSnapshot()).toEqual({ n: 1 })
    store.set({ n: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    store.set({ n: 3 })
    expect(listener).toHaveBeenCalledTimes(1)
  })
  it('persists and restores a named value, falling back on corrupt storage', () => {
    const store = createSnapshotStore({ n: 1 }, { persist: { name: 'app-store-test' } })
    store.set({ n: 7 })
    expect(createSnapshotStore({ n: 1 }, { persist: { name: 'app-store-test' } }).getSnapshot()).toEqual({ n: 7 })
    localStorage.setItem('app-store-test', '{bad')
    expect(createSnapshotStore({ n: 1 }, { persist: { name: 'app-store-test' } }).getSnapshot()).toEqual({ n: 1 })
  })
})
