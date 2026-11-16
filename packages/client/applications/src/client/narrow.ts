/**
 * How narrow the application AREA is — measured on the area's own box, never
 * on the browser window: the platform's sidebar, the right panel and the
 * conversation column all take width the area never gets, so the same window
 * is wide for one user and narrow for the next. Below the threshold the
 * navigation becomes a temporary drawer and the header keeps its controls
 * compact.
 * @module @matrix1001/dsh-application-harness-client-applications/client/narrow
 */

import { useEffect, useState, type RefObject } from 'react'

/** The area width under which the navigation turns into a drawer (the prototype's own breakpoint). */
export const NARROW_MAX_PX = 900

/** What one measured box says: whether it is narrow, and whether it has been measured at all. */
export interface NarrowBox {
  /** Whether the element is narrower than the threshold right now. */
  readonly narrow: boolean
  /**
   * Whether the width has been observed yet. A caller that must ACT on the
   * narrowness (an entry request that opens the drawer on a phone, the column
   * on a desktop) waits for this: before the first measurement every box reads
   * as "not narrow", which is the desktop default rather than an answer.
   */
  readonly measured: boolean
}

/**
 * Track whether one element is narrower than the threshold.
 * @param ref - the element to observe (the area root).
 * @param max - the threshold in CSS pixels.
 * @returns whether the element is currently narrow, and whether that is known yet.
 */
export function useNarrow(ref: RefObject<HTMLElement | null>, max = NARROW_MAX_PX): NarrowBox {
  const [box, setBox] = useState<NarrowBox>({ narrow: false, measured: false })
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    // jsdom (and any host without the observer) reports a zero-width box; a box
    // that was never laid out is "not narrow", so the desktop layout — the one
    // the components' own default renders — stays the testable baseline.
    if (typeof ResizeObserver === 'undefined') {
      setBox({ narrow: element.clientWidth > 0 && element.clientWidth < max, measured: true })
      return
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth
      setBox({ narrow: width > 0 && width < max, measured: true })
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref, max])
  return box
}
