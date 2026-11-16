// @vitest-environment jsdom
/**
 * The shared modal focus lifecycle (`useModalFocus`): the contract the panel's
 * settings modal and the info-hub settings dialog both rely on — focus enters
 * the dialog, the Tab ring skips disabled/hidden controls and wraps in BOTH
 * directions from the dialog's own initial focus, and closing hands focus back
 * to a trigger that still exists (frontend review F10).
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, type ReactNode } from 'react'
import { focusablesOf, useModalFocus } from '../src/modal-focus.ts'

afterEach(cleanup)

/** A minimal dialog harness: the overlay + panel the hook is written for. */
function Harness({ open, children, onRequestClose = () => {} }: { open: boolean; children: ReactNode; onRequestClose?: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  useModalFocus(open, panelRef, onRequestClose)
  if (!open) return null
  return <div role="dialog" tabIndex={-1} ref={panelRef}>{children}</div>
}

/** A dialog whose form field is the explicit initial focus. */
function InitialFocusHarness({ open }: { open: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  useModalFocus(open, panelRef, () => {}, fieldRef)
  if (!open) return null
  return (
    <div role="dialog" tabIndex={-1} ref={panelRef}>
      <button>before</button>
      <input ref={fieldRef} aria-label="name" />
    </div>
  )
}

function dialog(): HTMLElement {
  return document.querySelector('[role="dialog"]') as HTMLElement
}

describe('useModalFocus', () => {
  it('moves focus into the dialog on open and restores it on close', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const { rerender } = render(<Harness open><button>a</button></Harness>)
    expect(document.activeElement).toBe(dialog())
    rerender(<Harness open={false}><button>a</button></Harness>)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('puts initial focus on the named control instead of the container', () => {
    render(<InitialFocusHarness open />)
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="name"]'))
  })

  it('wraps Shift+Tab from the container\'s own initial focus to the LAST control', () => {
    render(<Harness open><button>first</button><button>last</button></Harness>)
    expect(document.activeElement).toBe(dialog())
    // The review's finding: from the container the reverse direction escaped
    // behind the dialog instead of cycling.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement!.textContent).toBe('last')
  })

  it('wraps Tab from the container to the first control, and from last back to first', () => {
    render(<Harness open><button>first</button><button>last</button></Harness>)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement!.textContent).toBe('first')
    ;(document.activeElement as HTMLElement).blur()
    ;(document.querySelectorAll('button')[1] as HTMLElement).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement!.textContent).toBe('first')
  })

  it('wraps from the first control back to the last, and leaves middle focus alone', () => {
    render(<Harness open><button>first</button><button>middle</button><button>last</button></Harness>)
    ;(document.querySelectorAll('button')[0] as HTMLElement).focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement!.textContent).toBe('last')
    ;(document.querySelectorAll('button')[1] as HTMLElement).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // A middle control is the browser's own business — the hook does not move it.
    expect(document.activeElement!.textContent).toBe('middle')
    // …in BOTH directions: the reverse wrap only fires from the edges.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement!.textContent).toBe('middle')
  })

  it('pulls focus back in when it sits outside the dialog', () => {
    const outsider = document.createElement('button')
    document.body.appendChild(outsider)
    render(<Harness open><button>inside</button></Harness>)
    outsider.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement!.textContent).toBe('inside')
    outsider.remove()
  })

  it('pulls focus back in from outside in the reverse direction too', () => {
    const outsider = document.createElement('button')
    document.body.appendChild(outsider)
    render(<Harness open><button>first</button><button>last</button></Harness>)
    // Focus outside the panel with Shift+Tab is the same "wrap from the edge"
    // case as the forward one: the ring must close on the LAST control.
    outsider.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement!.textContent).toBe('last')
    outsider.remove()
  })

  it('reports Escape to the caller (which decides whether that closes)', () => {
    const onRequestClose = vi.fn()
    render(<Harness open onRequestClose={onRequestClose}><button>a</button></Harness>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRequestClose).toHaveBeenCalledTimes(1)
    // Any other key is ignored.
    fireEvent.keyDown(document, { key: 'a' })
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('never leaves focus on a detached trigger', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const { rerender } = render(<Harness open><button>a</button></Harness>)
    trigger.remove()
    rerender(<Harness open={false}><button>a</button></Harness>)
    // The trigger is gone: focus is not sent to a node outside the document.
    expect(document.activeElement).not.toBe(trigger)
  })

  it('does nothing while closed', () => {
    render(<Harness open={false}><button>a</button></Harness>)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('scans only the focusables a user can actually reach', () => {
    render(
      <Harness open>
        <button>ok</button>
        <button disabled>disabled</button>
        <input aria-hidden="true" />
        <div hidden><button>hidden</button></div>
        <a href="#x">link</a>
        <div tabIndex={-1}>not tabbable</div>
      </Harness>,
    )
    expect(focusablesOf(dialog()).map((el) => el.textContent ?? el.tagName)).toEqual(['ok', 'link'])
  })

  it('keeps focus inside a dialog with no focusable control at all', () => {
    render(<Harness open><span>nothing to focus</span></Harness>)
    fireEvent.keyDown(document, { key: 'Tab' })
    // The event is swallowed so the browser cannot walk out of the dialog.
    expect(document.activeElement).toBe(dialog())
  })
})
