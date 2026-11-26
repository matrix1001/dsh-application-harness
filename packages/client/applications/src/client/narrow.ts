/**
 * How much width the application AREA really has — measured on the area's own
 * box, never on the browser window: the platform's sidebar, the right panel and
 * the conversation column all take width the area never gets, so the same
 * window is wide for one user and narrow for the next.
 *
 * There are exactly two thresholds:
 *
 * - `NARROW_MAX_PX` (720) — below it the area is COMPACT: header actions become
 *   icons, the tab strip keeps its compact geometry and the conversation pane
 *   becomes an overlay;
 * - `WIDE_MIN_PX` (1040) — at or above it the area is WIDE: the management page
 *   may put its list and detail side by side and the conversation pane sits
 *   beside the page.
 *
 * Between them the area is REGULAR. A box that was never laid out is the wide
 * desktop default, which is also what the components render on their first
 * pass.
 * @module @matrix1001/dsh-application-harness-client-applications/client/narrow
 */

import { useEffect, useState, type RefObject } from 'react'

/** The area width under which the shell becomes compact. */
export const NARROW_MAX_PX = 720

/** The area width at or above which content may split into two columns. */
export const WIDE_MIN_PX = 1040

/** What one measured box says: its compact/wide answers, and whether they are measured. */
export interface NarrowBox {
  /** Whether the area is compact (below {@link NARROW_MAX_PX}). */
  readonly compact: boolean
  /** Whether the area is wide (at or above {@link WIDE_MIN_PX}). */
  readonly wide: boolean
  /**
   * Whether the width has been observed yet. Before the first measurement the
   * box reads as the wide desktop default; a caller that must ACT on the
   * compact layout waits for this flag rather than treating the default as a
   * measurement.
   */
  readonly measured: boolean
  /** The measured content width in px (0 before the first observation). */
  readonly width: number
}

/** The answer one measured width gives (zero means "never laid out": wide default). */
function answer(width: number): { readonly compact: boolean; readonly wide: boolean } {
  if (width <= 0) return { compact: false, wide: true }
  return { compact: width < NARROW_MAX_PX, wide: width >= WIDE_MIN_PX }
}

/**
 * Track the area's compact/wide layout from its own box.
 * @param ref - the element to observe (the area root).
 * @returns the compact/wide answers and whether they are measured yet.
 */
export function useNarrow(ref: RefObject<HTMLElement | null>): NarrowBox {
  const [box, setBox] = useState<NarrowBox>({ compact: false, wide: true, measured: false, width: 0 })
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    // jsdom (and any host without the observer) reports a zero-width box; a box
    // that was never laid out is the wide desktop default, so the components'
    // own default stays the testable baseline.
    if (typeof ResizeObserver === 'undefined') {
      const found = answer(element.clientWidth)
      setBox({ ...found, measured: true, width: element.clientWidth })
      return
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth
      const found = answer(width)
      setBox({ ...found, measured: true, width })
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref])
  return box
}
