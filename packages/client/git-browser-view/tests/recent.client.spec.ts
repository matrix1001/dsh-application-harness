// @vitest-environment jsdom
/**
 * The recent-repository list: client-only convenience state, best-effort under
 * a broken/corrupt/refusing storage. The specs inject the storage surface so
 * every branch is deterministic; one spec also drives the real jsdom
 * localStorage and one scripts a getter that throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECENT_LIMIT, readRecentRepos, rememberRepo, type RecentStorage } from '../src/client/recent.ts'

/** One in-memory storage with controllable failures. */
function fakeStorage(initial: string | null = null): RecentStorage & { value: string | null; failGet: boolean; failSet: boolean } {
  const store = {
    value: initial,
    failGet: false,
    failSet: false,
    getItem: (key: string): string | null => {
      expect(key).toBe('dsh.git-browser.recent-repos.v1')
      if (store.failGet) throw new Error('read refused')
      return store.value
    },
    setItem: (key: string, value: string): void => {
      expect(key).toBe('dsh.git-browser.recent-repos.v1')
      if (store.failSet) throw new Error('write refused')
      store.value = value
    },
  }
  return store
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('readRecentRepos', () => {
  it('reads a clean list and filters malformed entries, duplicates and the excess', () => {
    expect(readRecentRepos(fakeStorage(null))).toEqual([])
    expect(readRecentRepos(fakeStorage('not json'))).toEqual([])
    expect(readRecentRepos(fakeStorage(JSON.stringify({ not: 'an array' })))).toEqual([])
    const list = ['/a', 7, '', '/a', '/b', '/c', '/d', '/e', '/f', '/g']
    expect(readRecentRepos(fakeStorage(JSON.stringify(list)))).toEqual(['/a', '/b', '/c', '/d', '/e'])
    expect(RECENT_LIMIT).toBe(5)
  })

  it('reads as empty when the storage refuses or is absent', () => {
    expect(readRecentRepos(fakeStorage('[]'))).toEqual([])
    const refused = fakeStorage(JSON.stringify(['/a']))
    refused.failGet = true
    expect(readRecentRepos(refused)).toEqual([])
    expect(readRecentRepos({ getItem: () => { throw new Error('x') }, setItem: () => undefined })).toEqual([])
    expect(readRecentRepos({ getItem: () => undefined as unknown as string | null, setItem: () => undefined })).toEqual([])
  })

  it('reads the real localStorage by default', () => {
    expect(readRecentRepos()).toEqual([])
    localStorage.setItem('dsh.git-browser.recent-repos.v1', JSON.stringify(['/srv/repo']))
    expect(readRecentRepos()).toEqual(['/srv/repo'])
  })

  it('reads as empty when reading the localStorage property throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    try {
      expect(readRecentRepos()).toEqual([])
    } finally {
      if (descriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
      else Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })
})

describe('rememberRepo', () => {
  it('puts the newest root first, deduplicates and caps the list', () => {
    const storage = fakeStorage(JSON.stringify(['/a', '/b', '/c', '/d', '/e']))
    expect(rememberRepo('/b', storage)).toEqual(['/b', '/a', '/c', '/d', '/e'])
    expect(JSON.parse(storage.value!)).toEqual(['/b', '/a', '/c', '/d', '/e'])
    expect(rememberRepo('/new', storage)).toEqual(['/new', '/b', '/a', '/c', '/d'])
  })

  it('keeps the returned list when the write is refused, and works without a storage', () => {
    const storage = fakeStorage(JSON.stringify(['/a']))
    storage.failSet = true
    expect(rememberRepo('/b', storage)).toEqual(['/b', '/a'])
    expect(storage.value).toBe(JSON.stringify(['/a']))

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    try {
      expect(rememberRepo('/srv/repo')).toEqual(['/srv/repo'])
    } finally {
      if (descriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
      else Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('writes the real localStorage by default', () => {
    expect(rememberRepo('/srv/repo')).toEqual(['/srv/repo'])
    expect(rememberRepo('/other')).toEqual(['/other', '/srv/repo'])
    expect(readRecentRepos()).toEqual(['/other', '/srv/repo'])
  })
})
