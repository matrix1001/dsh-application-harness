// @vitest-environment jsdom
/**
 * The area's layout preferences: the defaults a fresh deployment starts from,
 * what a reload comes back to (the human's own choice, per origin), and the
 * storage failure that must cost a preference and never the page. The store
 * itself is the platform's; what this suite pins is the entry this package
 * persists through it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PREFERENCES_KEY, PREFERENCE_DEFAULTS, createPreferences } from '../src/client/preferences.ts'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the area preferences', () => {
  it('starts expanded, remembers what the human chose, and comes back to it on a reload', () => {
    const store = createPreferences()
    expect(store.getSnapshot()).toEqual(PREFERENCE_DEFAULTS)
    store.set({ ...store.getSnapshot(), navExpanded: false, lastAppId: 'workbook' })
    expect(store.getSnapshot()).toEqual({ navExpanded: false, lastAppId: 'workbook', navOrder: [] })
    // A reload is a fresh store over the same origin's storage.
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) as string)).toEqual({
      navExpanded: false,
      lastAppId: 'workbook',
      navOrder: [],
    })
    const reloaded = createPreferences()
    expect(reloaded.getSnapshot()).toEqual({ navExpanded: false, lastAppId: 'workbook', navOrder: [] })
    // The human's own navigation order rides the same record.
    store.set({ ...store.getSnapshot(), navOrder: ['info-hub', 'workbook'] })
    expect(createPreferences().getSnapshot().navOrder).toEqual(['info-hub', 'workbook'])
  })

  it('keeps the navigation toggle in memory when the browser refuses to store, and persists nothing', () => {
    // Quota, private mode: the write throws, the page still works.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const store = createPreferences()
    expect(() => { store.set({ navExpanded: false, navOrder: [] }) }).not.toThrow()
    expect(store.getSnapshot().navExpanded).toBe(false)
    // Nothing was persisted, so the next load falls back to the defaults rather
    // than half-applying a preference the storage never held.
    expect(createPreferences().getSnapshot()).toEqual(PREFERENCE_DEFAULTS)
  })

  it('falls back to the defaults when the stored entry is unreadable', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem(PREFERENCES_KEY, 'not json')
    expect(() => createPreferences()).not.toThrow()
    expect(createPreferences().getSnapshot()).toEqual(PREFERENCE_DEFAULTS)
  })
})
