// @vitest-environment jsdom
/**
 * The floating notice stack and busy bar: an empty stack renders nothing, a
 * notice keeps its tone/live-region role, actions and the close control run,
 * and the stack caps itself at two with an exact remainder count. These are
 * the branches the coverage gate requires from the shared component.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BusyBar, NoticeLayer } from '../src/notices.tsx'

afterEach(cleanup)

describe('NoticeLayer', () => {
  it('renders nothing for an empty stack', () => {
    const view = render(<NoticeLayer items={[]} label="notices" />)
    expect(view.container.querySelector('[data-notice-layer]')).toBeNull()
  })

  it('renders an info notice with an action, a close control and anchors', () => {
    const act = vi.fn()
    const close = vi.fn()
    const view = render(
      <NoticeLayer
        label="notices"
        items={[{
          id: 'one', tone: 'info', text: 'a note',
          anchor: { 'data-test-notice': 'one' },
          actions: [{ label: 'Retry', anchor: { 'data-test-action': 'retry' }, onClick: act }],
          onDismiss: close, dismissLabel: 'Dismiss',
        }]}
      />,
    )
    const notice = view.container.querySelector('[data-test-notice="one"]')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('a note')
    fireEvent.click(view.container.querySelector('[data-test-action="retry"]')!)
    expect(act).toHaveBeenCalledTimes(1)
    fireEvent.click(view.container.querySelector('[aria-label="Dismiss"]')!)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('marks an error notice as an alert', () => {
    const view = render(<NoticeLayer label="notices" items={[{ id: 'bad', tone: 'error', text: 'broke' }]} />)
    expect(view.container.querySelector('[data-notice="bad"]')!.getAttribute('role')).toBe('alert')
  })

  it('shows the two newest and the exact remainder', () => {
    const view = render(
      <NoticeLayer
        label="notices"
        items={[
          { id: 'a', text: 'a' },
          { id: 'b', text: 'b' },
          { id: 'c', text: 'c' },
        ]}
      />,
    )
    expect(view.container.querySelector('[data-notice="a"]')).not.toBeNull()
    expect(view.container.querySelector('[data-notice="b"]')).not.toBeNull()
    expect(view.container.querySelector('[data-notice="c"]')).toBeNull()
    expect(view.container.querySelector('[data-notice-layer]')!.textContent).toContain('+1')
  })
})

describe('BusyBar', () => {
  it('exposes an indeterminate progress bar with its accessible name', () => {
    const view = render(<BusyBar label="Reading" />)
    const bar = view.container.querySelector('[data-busy-bar]')!
    expect(bar.getAttribute('role')).toBe('progressbar')
    expect(bar.getAttribute('aria-label')).toBe('Reading')
  })
})
