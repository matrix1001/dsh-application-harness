/**
 * The shared modal focus lifecycle: the one implementation of "focus enters the
 * dialog, Tab cannot leave it, and closing hands focus back to the trigger".
 *
 * It lives in chrome because two independent dialogs need exactly this contract
 * (the panel's 应用设置 shell and the info-hub view's app-settings dialog), and
 * the frontend review found both had the same gap: focus could start on the
 * container itself (so the very first Shift+Tab escaped behind the dialog) and
 * the focusable scan included disabled/invisible controls (frontend review F10).
 * @module
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** The focusable candidates inside a dialog panel. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * The focusable controls a dialog actually manages, in document order:
 * disabled ones, `aria-hidden` ones, and anything inside a `[hidden]` subtree
 * are skipped, so the Tab ring never lands on a control a user cannot use.
 * @param panel - the dialog element.
 * @returns the focusable elements, in order.
 */
export function focusablesOf(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.hasAttribute('disabled')) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    if (element.closest('[hidden]') !== null) return false
    return true
  })
}

/**
 * Trap focus in an open dialog and restore it on close.
 *
 * The effect depends only on `open`: the close callback and the panel are read
 * through refs, so a parent re-render (or a projection update) never re-runs the
 * lifecycle and never steals the caret back from the field the user is typing
 * in.
 * @param open - whether the dialog is showing.
 * @param panelRef - the dialog element (the fallback for initial focus).
 * @param onRequestClose - called for Escape; the caller decides whether that closes.
 * @param initialFocusRef - the control that takes initial focus when it exists
 *   inside the panel (a form's first field). Omitted, the panel itself focuses.
 */
export function useModalFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onRequestClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  // The element focused before the dialog opened, restored on close.
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const requestCloseRef = useRef(onRequestClose)
  requestCloseRef.current = onRequestClose

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    // A form dialog starts in its first field; a custom target outside the panel
    // is not this dialog's to focus, so it falls back to the container.
    const initial = initialFocusRef?.current
    if (panel !== null && initial !== null && initial !== undefined && panel.contains(initial)) initial.focus()
    else panel?.focus()

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        requestCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      /* v8 ignore next -- the keydown effect only runs while open, so the panel ref is always set */
      if (panel === null) return
      const focusables = focusablesOf(panel)
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      // The container itself holds focus right after opening (and focus can be
      // outside the panel if the page moved it): both directions wrap from
      // there, so the FIRST Shift+Tab already cycles to the last control.
      const active = document.activeElement
      const outside = active === null || !panel.contains(active)
      if (event.shiftKey) {
        if (active === first || active === panel || outside) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || active === panel || outside) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Restore focus to the trigger — but only while it is still in the
      // document: closing a dialog whose opener has been unmounted must not
      // leave focus on a detached node.
      const trigger = restoreFocusRef.current
      if (trigger !== null && trigger.isConnected) trigger.focus()
    }
  }, [open, panelRef, initialFocusRef])
}
