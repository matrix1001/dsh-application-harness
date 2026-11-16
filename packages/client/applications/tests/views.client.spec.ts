/**
 * The application view registry: one registration per appId — a page, settings,
 * or both, and never neither (a duplicate is a package conflict, not a silent
 * override) — the read-only snapshot keeps its identity until the table moves,
 * every registration and unregistration publishes in the same step, and each
 * application's own view state is created on first use and dropped with the
 * registration.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createApplicationViews } from '../src/client/views.ts'
import type { ApplicationView, ApplicationViewProps } from '../src/client/contract.ts'

/** A view probe: the props it was rendered with are irrelevant here. */
function view(name?: string): ApplicationView {
  return {
    ...(name === undefined ? {} : { name }),
    Component: (props: ApplicationViewProps): ReactNode => props.running ? name ?? 'running' : name ?? 'idle',
  }
}

describe('application view registry', () => {
  it('registers a view and hands it back through the snapshot', () => {
    const views = createApplicationViews()
    expect(views.views().size).toBe(0)
    const registered = view('Workbook')
    const dispose = views.register('workbook', registered)
    expect(views.views().get('workbook')).toBe(registered)
    expect(views.getSnapshot()).toBe(views.views())
    dispose()
    expect(views.views().size).toBe(0)
  })

  it('accepts a settings-only registration (an application may draw no page)', () => {
    const views = createApplicationViews()
    const settings: ApplicationView = { name: 'Notebook', Settings: () => null }
    const dispose = views.register('workbook', settings)
    expect(views.views().get('workbook')).toBe(settings)
    expect(views.views().get('workbook')?.Component).toBeUndefined()
    dispose()
    expect(views.views().size).toBe(0)
  })

  it('refuses a registration that draws neither a page nor settings', () => {
    const views = createApplicationViews()
    expect(() => views.register('workbook', { name: 'Notebook' })).toThrow(/neither a page nor settings/)
    // The id is not taken by the refused declaration: the real one still fits.
    expect(views.views().size).toBe(0)
    expect(() => views.register('workbook', view())).not.toThrow()
  })

  it('refuses a second view for the same appId, keeping the first', () => {
    const views = createApplicationViews()
    const first = view('Workbook')
    views.register('workbook', first)
    expect(() => views.register('workbook', view('Other'))).toThrow(/already has a registered view/)
    expect(views.views().get('workbook')).toBe(first)
  })

  it('unregisters once (a second dispose is a no-op)', () => {
    const views = createApplicationViews()
    const dispose = views.register('workbook', view())
    dispose()
    const listener = vi.fn()
    views.subscribe(listener)
    dispose()
    expect(listener).not.toHaveBeenCalled()
  })

  it('publishes a new snapshot per change and keeps it stable between changes', () => {
    const views = createApplicationViews()
    const before = views.getSnapshot()
    const listener = vi.fn()
    const off = views.subscribe(listener)
    const dispose = views.register('workbook', view())
    expect(listener).toHaveBeenCalledTimes(1)
    expect(views.getSnapshot()).not.toBe(before)
    const after = views.getSnapshot()
    expect(views.getSnapshot()).toBe(after)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    views.register('disk-analysis', view())
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('per-application view state', () => {

  it('hands each application its own store, created on first use', () => {
    const views = createApplicationViews()
    const workbook = views.state('workbook')
    expect(views.state('workbook')).toBe(workbook)
    workbook.set({ tab: 'calendar' })
    expect(workbook.getSnapshot()).toEqual({ tab: 'calendar' })
    // Distinct applications never share one store: what one page chose is not
    // what the next application starts from.
    expect(views.state('disk-analysis')).not.toBe(workbook)
    expect(views.state('disk-analysis').getSnapshot()).toEqual({})
  })

  it('merges a patch into the fields already there, so a page writes only what it changed', () => {
    const views = createApplicationViews()
    const state = views.state('workbook')
    state.set({ tab: 'calendar' })
    state.set({ selected: 'n1' })
    expect(state.getSnapshot()).toEqual({ tab: 'calendar', selected: 'n1' })
    state.set({ selected: 'n2' })
    expect(state.getSnapshot()).toEqual({ tab: 'calendar', selected: 'n2' })
  })

  it('clears a field written as undefined, and never stores the value itself', () => {
    const views = createApplicationViews()
    const state = views.state('info-hub')
    state.set({ selected: 'entry-1', tab: 'home' })
    expect(state.getSnapshot()).toEqual({ selected: 'entry-1', tab: 'home' })
    // `undefined` is the explicit clear: the key leaves the map (a reader falls
    // back to its own default), and `Object.keys` keeps saying the truth.
    state.set({ selected: undefined })
    expect(state.getSnapshot()).toEqual({ tab: 'home' })
    expect(Object.keys(state.getSnapshot())).toEqual(['tab'])
  })

  it('keeps a dropped registration\'s writes away from the one that registers again', () => {
    const views = createApplicationViews()
    const stale = views.state('workbook')
    const dispose = views.register('workbook', view())
    dispose()
    views.register('workbook', view())
    const fresh = views.state('workbook')
    expect(fresh).not.toBe(stale)
    // A late answer from the unmounted page writes its old store; the new
    // registration's page never sees it.
    stale.set({ selected: 'gone' })
    expect(fresh.getSnapshot()).toEqual({})
  })

  it('notifies its subscribers, and drops the live store with the registration', () => {
    const views = createApplicationViews()
    const before = views.state('workbook')
    const listener = vi.fn()
    const off = before.subscribe(listener)
    const dispose = views.register('workbook', view())
    before.set({ tab: 'calendar' })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    dispose()
    // The live store (and its listeners) went with the registration; the next
    // reader gets a fresh one — the fields a browser persists are a different
    // question, answered by storage, not by this table.
    const after = views.state('workbook')
    expect(after).not.toBe(before)
    expect(after.getSnapshot()).toEqual({})
  })
})
