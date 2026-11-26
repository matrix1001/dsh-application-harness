// @vitest-environment jsdom
/**
 * How much width the application AREA has: the hook measures the element it is
 * given — never the window — and answers two thresholds: COMPACT below 720 and
 * WIDE at or above 1040. Between them the area is regular; a box that was never
 * laid out is the wide desktop default, which is what the components render on
 * their first pass.
 *
 * Besides the answers it reports whether the box HAS been measured: a caller
 * that must act on the layout waits for that flag, because before the first
 * measurement the wide default is a placeholder, not a fact.
 */
import { act, cleanup, render, type RenderResult } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NARROW_MAX_PX, WIDE_MIN_PX, useNarrow } from '../src/client/narrow.ts'

/** One probe element: the hook measures the div it is handed. */
function Probe(): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const { compact, wide, measured } = useNarrow(ref)
  return <div ref={ref} data-testid="probe" data-compact={compact ? 'true' : 'false'} data-wide={wide ? 'true' : 'false'} data-measured={measured ? 'true' : 'false'} />
}

/** One answer, as the probe reports it. */
function attr(view: RenderResult, name: string): string | null {
  return view.getByTestId('probe').getAttribute(name)
}

/**
 * Render one probe whose box reports a laid-out width, and read both answers
 * (jsdom computes no layout, so the width is stubbed on the prototype for the
 * case's duration).
 */
function answerAt(width: number): { readonly compact: string | null; readonly wide: string | null } {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  try {
    const view = render(<Probe />)
    return { compact: attr(view, 'data-compact'), wide: attr(view, 'data-wide') }
  } finally {
    cleanup()
    if (original === undefined) delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth
    else Object.defineProperty(HTMLElement.prototype, 'clientWidth', original)
  }
}

/** A probe whose ref is never attached to an element (nothing to measure). */
function Unattached(): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const { compact, wide } = useNarrow(ref)
  return <p data-testid="probe" data-compact={compact ? 'true' : 'false'} data-wide={wide ? 'true' : 'false'} />
}

/** A controllable stand-in for the browser's observer (jsdom has none). */
class FakeResizeObserver {
  static latest: FakeResizeObserver | undefined
  readonly observed: Element[] = []
  disconnected = false
  private readonly callback: (
    entries: readonly { readonly contentRect: { readonly width: number } }[],
    observer: unknown,
  ) => void

  constructor(callback: FakeResizeObserver['callback']) {
    this.callback = callback
    FakeResizeObserver.latest = this
  }

  observe(target: Element): void { this.observed.push(target) }
  unobserve(): void {}
  disconnect(): void { this.disconnected = true }

  /** Deliver one measured width, the way the browser would. */
  measure(width: number): void {
    act(() => { this.callback([{ contentRect: { width } }], this) })
  }

  /** Deliver a callback without an entry (the element it measured is gone). */
  measureNothing(): void {
    act(() => { this.callback([], this) })
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useNarrow', () => {
  it('falls back to the box’s own width and treats an unlaid-out box as wide', () => {
    expect(typeof ResizeObserver).toBe('undefined')
    // jsdom's own clientWidth is 0: the wide desktop default stays the baseline.
    const view = render(<Probe />)
    expect(attr(view, 'data-compact')).toBe('false')
    expect(attr(view, 'data-wide')).toBe('true')
    expect(attr(view, 'data-measured')).toBe('true')
    cleanup()
    expect(answerAt(NARROW_MAX_PX - 1)).toEqual({ compact: 'true', wide: 'false' })
    // The compact threshold itself belongs to the regular side.
    expect(answerAt(NARROW_MAX_PX)).toEqual({ compact: 'false', wide: 'false' })
    expect(answerAt(WIDE_MIN_PX - 1)).toEqual({ compact: 'false', wide: 'false' })
    // The wide threshold itself belongs to the wide side.
    expect(answerAt(WIDE_MIN_PX)).toEqual({ compact: 'false', wide: 'true' })
    expect(answerAt(WIDE_MIN_PX + 400)).toEqual({ compact: 'false', wide: 'true' })
    expect(answerAt(0)).toEqual({ compact: 'false', wide: 'true' })
  })

  it('answers the wide default when there is no element to measure', () => {
    const view = render(<Unattached />)
    expect(attr(view, 'data-compact')).toBe('false')
    expect(attr(view, 'data-wide')).toBe('true')
  })

  it('follows the observer where the host has one, and stops observing on unmount', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const view = render(<Probe />)
    const observer = FakeResizeObserver.latest
    expect(observer).toBeDefined()
    expect(observer?.observed).toHaveLength(1)
    // Until the observer answers, nothing has been measured: the wide default
    // is a placeholder, not a fact.
    expect(attr(view, 'data-measured')).toBe('false')
    observer?.measure(NARROW_MAX_PX - 1)
    expect(attr(view, 'data-compact')).toBe('true')
    expect(attr(view, 'data-wide')).toBe('false')
    observer?.measure(900)
    expect(attr(view, 'data-compact')).toBe('false')
    expect(attr(view, 'data-wide')).toBe('false')
    observer?.measure(WIDE_MIN_PX)
    expect(attr(view, 'data-compact')).toBe('false')
    expect(attr(view, 'data-wide')).toBe('true')
    // A zero-width measurement is a box that was never laid out: wide, again.
    observer?.measure(0)
    expect(attr(view, 'data-wide')).toBe('true')
    // An observer answering without an entry falls back to the box itself.
    observer?.measureNothing()
    expect(attr(view, 'data-wide')).toBe('true')
    view.unmount()
    expect(observer?.disconnected).toBe(true)
  })
})
