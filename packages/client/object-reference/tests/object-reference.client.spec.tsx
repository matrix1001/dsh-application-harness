// @vitest-environment jsdom
/** The shared object-reference chip: open locally, switch applications, or stay static. */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObjectReference } from '../src/index.tsx'

afterEach(cleanup)

const ref = { appId: 'notes', type: 'note', id: 'n1' }

describe('ObjectReference', () => {
  it('opens locally and renders the resolved title/summary', () => {
    const onOpen = vi.fn()
    const view = render(<ObjectReference object={ref} title="Note one" summary="first" onOpen={onOpen} attrs={{ 'data-note-open': 'n1' }} />)
    const chip = view.getByText('Note one').closest('[data-object-ref]') as HTMLElement
    expect(chip.dataset.objectId).toBe('n1')
    expect(chip.dataset.noteOpen).toBe('n1')
    expect(chip.textContent).toContain('note')
    expect(chip.title).toBe('notes/note/n1')
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledWith(ref)
  })

  it('shows a localized type label and keeps the full reference in the title', () => {
    const view = render(<ObjectReference object={ref} title="Note one" typeLabel="笔记" />)
    const chip = view.getByText('Note one').closest('[data-object-ref]') as HTMLElement
    expect(chip.textContent).toContain('笔记')
    expect(chip.title).toBe('notes/note/n1')
  })

  it('falls back to switching applications and can stay unavailable', () => {
    const onSwitch = vi.fn()
    const view = render(<ObjectReference object={ref} title="Note one" onSwitch={onSwitch} />)
    fireEvent.click(view.getByText('Note one').closest('[data-object-ref]') as HTMLElement)
    expect(onSwitch).toHaveBeenCalledWith('notes')
    cleanup()
    const staticView = render(<ObjectReference object={ref} title="Gone" unavailable />)
    const chip = staticView.getByText('Gone').closest('[data-object-ref]') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(chip.dataset.unavailable).toBe('true')
  })

  it('resolves the title and summary itself when none is passed', async () => {
    const resolve = vi.fn(async () => ({
      ok: true as const,
      value: { ref, title: 'Resolved note', summary: 'first line' },
    }))
    const view = render(<ObjectReference object={ref} resolve={resolve} onOpen={vi.fn()} />)
    const chip = await waitFor(() => view.getByText('Resolved note').closest('[data-object-ref]') as HTMLElement)
    expect(resolve).toHaveBeenCalledWith(ref)
    expect(chip.textContent).toContain('first line')
    expect(chip.dataset.resolving).toBeUndefined()
  })

  it('skips the resolver when the caller already passed a title', () => {
    const resolve = vi.fn(async () => ({ ok: true as const, value: { ref, title: 'Resolved' } }))
    const view = render(<ObjectReference object={ref} title="Known" resolve={resolve} />)
    expect(view.getByText('Known')).toBeDefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('keeps a deleted reference unavailable and surfaces other resolution errors', async () => {
    const missing = render(<ObjectReference object={ref} resolve={async () => ({
      ok: false as const, error: { code: 'app.not-found', message: 'gone' },
    })} />)
    const gone = await waitFor(() => missing.container.querySelector('[data-object-ref]') as HTMLElement)
    await waitFor(() => { expect(gone.dataset.unavailable).toBe('true') })
    expect(gone.textContent).toContain('n1')
    cleanup()

    const failed = render(<ObjectReference object={ref} resolve={async () => ({
      ok: false as const, error: { code: 'platform.object-timeout', message: 'slow' },
    })} />)
    const chip = await waitFor(() => failed.container.querySelector('[data-object-ref]') as HTMLElement)
    await waitFor(() => { expect(chip.dataset.resolutionError).toBe('platform.object-timeout') })
    expect(chip.dataset.unavailable).toBeUndefined()
    expect(chip.textContent).toContain('n1')
    cleanup()

    const mismatched = render(<ObjectReference object={ref} resolve={async () => ({
      ok: true as const, value: { ref: { ...ref, id: 'other' }, title: 'Wrong' },
    })} />)
    const wrong = await waitFor(() => mismatched.container.querySelector('[data-object-ref]') as HTMLElement)
    await waitFor(() => { expect(wrong.dataset.resolutionError).toBe('platform.object-mismatch') })
    cleanup()

    const thrown = render(<ObjectReference object={ref} resolve={async () => { throw new Error('offline') }} />)
    const offline = await waitFor(() => thrown.container.querySelector('[data-object-ref]') as HTMLElement)
    await waitFor(() => { expect(offline.dataset.resolutionError).toBe('platform.object-unavailable') })
  })

  it('falls back to the id without a title or resolver', () => {
    const view = render(<ObjectReference object={ref} />)
    const chip = view.getByText('n1').closest('[data-object-ref]') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(chip.dataset.resolving).toBeUndefined()
  })

  it('renders a static span without an action', () => {
    const view = render(<ObjectReference object={ref} title="Reference" />)
    const chip = view.getByText('Reference').closest('[data-object-ref]') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
  })
})
