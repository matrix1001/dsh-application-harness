// @vitest-environment jsdom
/**
 * How narrow the application AREA is: the hook measures the element it is given
 * — never the window — falls back to that element's own clientWidth where no
 * ResizeObserver exists (jsdom, and any host without one), and treats a box that
 * was never laid out as the wide desktop layout, which is what the components
 * render by default. Where an observer exists it is the measurement, and it is
 * disconnected when the element goes.
 *
 * Besides the answer it reports whether the box HAS been measured: a caller
 * that must act on the narrowness (the entry request that opens the drawer on a
 * phone and the column on a desktop) waits for that flag, because before the
 * first measurement every box reads as the wide default.
 */
import { act, cleanup, render, type RenderResult } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NARROW_MAX_PX, useNarrow } from '../src/client/narrow.ts'

/** One probe element: the hook measures the div it is handed. */
function Probe(): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const { narrow, measured } = useNarrow(ref)
  return <div ref={ref} data-testid="probe" data-narrow={narrow ? 'true' : 'false'} data-measured={measured ? 'true' : 'false'} />
}

/** The hook's answer, as the probe reports it. */
function answer(view: RenderResult): string | null {
  return view.getByTestId('probe').getAttribute('data-narrow')
}

/**
 * Render one probe whose box reports a laid-out width, and read the hook's
 * answer (jsdom computes no layout, so the width is stubbed on the prototype
 * for the case's duration).
 */
function answerAt(width: number): string | null {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  try {
    const view = render(<Probe />)
    const answer = view.getByTestId('probe').getAttribute('data-narrow')
    view.unmount()
    return answer
  } finally {
    if (original === undefined) delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth
    else Object.defineProperty(HTMLElement.prototype, 'clientWidth', original)
  }
}

/** A probe whose ref is never attached to an element (nothing to measure). */
function Unattached(): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const { narrow } = useNarrow(ref)
  return <p data-testid="probe" data-narrow={narrow ? 'true' : 'false'} />
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
  it('falls back to the box’s own width, and calls a box that was never laid out wide', () => {
    expect(typeof ResizeObserver).toBe('undefined')
    // jsdom's own clientWidth is 0: nothing was laid out, so the wide desktop
    // layout — the one the components render by default — stays the baseline.
    const view = render(<Probe />)
    expect(answer(view)).toBe('false')
    // The synchronous fallback HAS measured: a caller that acts on narrowness
    // can act as soon as this render's effects have run.
    expect(view.getByTestId('probe').getAttribute('data-measured')).toBe('true')
    cleanup()
    expect(answerAt(NARROW_MAX_PX - 1)).toBe('true')
    // The threshold itself belongs to the wide side.
    expect(answerAt(NARROW_MAX_PX)).toBe('false')
    expect(answerAt(NARROW_MAX_PX + 400)).toBe('false')
    expect(answerAt(0)).toBe('false')
  })

  it('answers wide when there is no element to measure', () => {
    expect(answer(render(<Unattached />))).toBe('false')
  })

  it('follows the observer where the host has one, and stops observing on unmount', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const view = render(<Probe />)
    const observer = FakeResizeObserver.latest
    expect(observer).toBeDefined()
    expect(observer?.observed).toHaveLength(1)
    // Until the observer answers, nothing has been measured: the wide default
    // is a placeholder, not a fact.
    expect(view.getByTestId('probe').getAttribute('data-measured')).toBe('false')
    observer?.measure(NARROW_MAX_PX - 1)
    expect(answer(view)).toBe('true')
    observer?.measure(NARROW_MAX_PX + 400)
    expect(answer(view)).toBe('false')
    // A zero-width measurement is a box that was never laid out: wide, again.
    observer?.measure(0)
    expect(answer(view)).toBe('false')
    // An observer answering without an entry falls back to the box itself.
    observer?.measureNothing()
    expect(answer(view)).toBe('false')
    view.unmount()
    expect(observer?.disconnected).toBe(true)
  })
})
