/**
 * The applications entry: how another surface activates the panel. One
 * activation reads the selection BEFORE moving it (that answer is what makes a
 * second click a toggle), selects the panel, and leaves exactly one request for
 * the area — which consumes it once, so a re-render of the same request does
 * nothing twice.
 */
import { describe, expect, it, vi } from 'vitest'
import { createEntry } from '../src/client/entry.ts'

/** One entry over a controllable layout face. */
function makeEntry(active: string | null = null): {
  readonly entry: ReturnType<typeof createEntry>
  readonly selectPanel: ReturnType<typeof vi.fn>
} {
  const selectPanel = vi.fn()
  const entry = createEntry('application-harness-applications', {
    activePanelId: () => active,
    selectPanel,
  })
  return { entry, selectPanel }
}

describe('the applications entry', () => {
  it('selects the panel and leaves one entry request when the human was elsewhere', () => {
    const { entry, selectPanel } = makeEntry('session-panel')
    const listener = vi.fn()
    entry.subscribe(listener)
    expect(entry.panelId).toBe('application-harness-applications')
    expect(entry.getSnapshot()).toBeUndefined()
    entry.activate()
    expect(selectPanel).toHaveBeenCalledWith('application-harness-applications')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(entry.getSnapshot()).toEqual({ toggle: false })
  })

  it('marks an activation of the panel the human is already on as a toggle', () => {
    const { entry } = makeEntry('application-harness-applications')
    entry.activate()
    // The selection was read before the platform moved it: the request knows
    // this was the second click, and the area toggles instead of re-opening.
    expect(entry.getSnapshot()).toEqual({ toggle: true })
  })

  it('stops notifying a listener that unsubscribed', () => {
    const { entry } = makeEntry()
    const listener = vi.fn()
    const off = entry.subscribe(listener)
    entry.activate()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    entry.activate()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('hands the request over exactly once', () => {
    const { entry } = makeEntry()
    entry.activate()
    expect(entry.consume()).toEqual({ toggle: false })
    expect(entry.consume()).toBeUndefined()
    expect(entry.getSnapshot()).toBeUndefined()
    // A later activation is a new request, not the old one replayed.
    entry.activate()
    expect(entry.consume()).toEqual({ toggle: false })
    expect(entry.consume()).toBeUndefined()
  })
})
