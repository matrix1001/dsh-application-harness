// @vitest-environment jsdom
/** The shared object-reference chip: open locally, switch applications, or stay static. */
import { cleanup, fireEvent, render } from '@testing-library/react'
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
    expect(chip.textContent).toContain('notes/note/n1')
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledWith(ref)
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

  it('renders a static span without an action', () => {
    const view = render(<ObjectReference object={ref} title="Reference" />)
    const chip = view.getByText('Reference').closest('[data-object-ref]') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
  })
})
