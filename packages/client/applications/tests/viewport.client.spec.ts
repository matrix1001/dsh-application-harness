/**
 * The viewport store: which view the page on screen draws and whether it has
 * settled. Same lifecycle rules as the page context — owner-stamped, newest
 * wins, exact cleanup — plus the one the surface needs: an UNCHANGED report
 * keeps its object identity, so a page that re-reports the same view cannot
 * repaint the area it is drawn in (the reference-compared subscription would
 * otherwise loop).
 */
import { describe, expect, it, vi } from 'vitest'
import { createViewport } from '../src/client/viewport.ts'

describe('the viewport store', () => {
  it('holds what the newest report said, stamped with the application that made it', () => {
    const viewport = createViewport()
    expect(viewport.current()).toBeUndefined()
    viewport.report('workbook', { key: 'tab:tasks', ready: false })
    expect(viewport.current()).toEqual({ appId: 'workbook', key: 'tab:tasks', ready: false })
    viewport.report('workbook', { key: 'tab:tasks', ready: true })
    expect(viewport.current()).toEqual({ appId: 'workbook', key: 'tab:tasks', ready: true })
  })

  it('keeps the same object when the report does not change', () => {
    const viewport = createViewport()
    const listener = vi.fn()
    viewport.subscribe(listener)
    viewport.report('workbook', { key: 'tab:tasks', ready: true })
    const first = viewport.getSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)
    viewport.report('workbook', { key: 'tab:tasks', ready: true })
    expect(viewport.getSnapshot()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)
    viewport.report('workbook', { key: 'tab:notes', ready: true })
    expect(viewport.getSnapshot()).not.toBe(first)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('clears only the report a disposer owns (a stale cleanup cannot blank a newer view)', () => {
    const viewport = createViewport()
    const disposeTasks = viewport.report('workbook', { key: 'tab:tasks', ready: true })
    const disposeNotes = viewport.report('workbook', { key: 'tab:notes', ready: true })
    disposeTasks()
    expect(viewport.current()?.key).toBe('tab:notes')
    disposeNotes()
    expect(viewport.current()).toBeUndefined()
    // A second dispose (React may run a cleanup twice) is a no-op.
    disposeNotes()
    expect(viewport.current()).toBeUndefined()
  })
})
