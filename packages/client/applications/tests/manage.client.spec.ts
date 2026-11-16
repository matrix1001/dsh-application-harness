/**
 * The management request store: what the dialog shows, who can change it, and
 * the one property the pages depend on — the `openManagement` callback bound to
 * an application is the SAME function for that application's whole life, so a
 * page may put it in an effect's dependencies without re-running the effect on
 * every repaint.
 */
import { describe, expect, it, vi } from 'vitest'
import { createManageService, manageScrollKey } from '../src/client/manage.ts'

describe('the management request', () => {
  it('shows nothing until something opens, and hands out a fresh request each open', () => {
    const manage = createManageService()
    const listener = vi.fn()
    manage.subscribe(listener)
    expect(manage.getSnapshot()).toBeUndefined()

    manage.open({ tab: 'permissions' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(manage.getSnapshot()).toEqual({ tab: 'permissions' })
    const first = manage.getSnapshot()
    // Re-opening the tab that is already showing still publishes: an explicit
    // open re-reads what the dialog shows.
    manage.open({ tab: 'permissions' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(manage.getSnapshot()).not.toBe(first)
    expect(manage.getSnapshot()).toEqual({ tab: 'permissions' })
  })

  it('closes once, and a close with nothing open publishes nothing', () => {
    const manage = createManageService()
    const listener = vi.fn()
    manage.subscribe(listener)
    manage.close()
    expect(listener).not.toHaveBeenCalled()
    manage.open({ appId: 'workbook', tab: 'info' })
    manage.close()
    expect(manage.getSnapshot()).toBeUndefined()
    manage.close()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('binds an opener to one application and keeps it stable', () => {
    const manage = createManageService()
    const opener = manage.opener('workbook')
    expect(manage.opener('workbook')).toBe(opener)
    expect(manage.opener('git-read')).not.toBe(opener)

    opener('permissions')
    // Bound: the page cannot name another application through this callback.
    expect(manage.getSnapshot()).toEqual({ appId: 'workbook', tab: 'permissions' })
    manage.opener('git-read')('history')
    expect(manage.getSnapshot()).toEqual({ appId: 'git-read', tab: 'history' })
  })

  it('keys a position per surface, and drops what the registry no longer has', () => {
    const manage = createManageService()
    manage.scroll.set(manageScrollKey(undefined, 'permissions'), 40)
    manage.scroll.set(manageScrollKey('workbook', 'history'), 120)
    manage.scroll.set(manageScrollKey('git-read', 'info'), 7)
    // A key this vocabulary does not name (an old build's, a typo) has no
    // surface behind it: retaining drops it rather than letting it linger.
    manage.scroll.set('somebody-elses-key', 1)
    expect(manage.scroll.get('list')).toBe(40)

    // git-read is gone: its position goes with it, the list and the
    // applications still registered keep theirs.
    manage.scroll.retain(new Set(['workbook']))
    expect(manage.scroll.get(manageScrollKey('git-read', 'info'))).toBeUndefined()
    expect(manage.scroll.get(manageScrollKey('workbook', 'history'))).toBe(120)
    expect(manage.scroll.get(manageScrollKey(undefined, 'permissions'))).toBe(40)
    expect(manage.scroll.get('somebody-elses-key')).toBeUndefined()
  })

  it('stops notifying a listener that unsubscribed', () => {
    const manage = createManageService()
    const listener = vi.fn()
    const off = manage.subscribe(listener)
    manage.open({ tab: 'history' })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    manage.open({ tab: 'info' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
