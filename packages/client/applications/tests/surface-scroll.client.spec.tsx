// @vitest-environment jsdom
/**
 * The business surface's scroll memory (framework side): the position the
 * reader left a view at comes back when they return to that view, and only
 * then — a view whose content is not ready yet waits, a view they scrolled away
 * from themselves is not dragged back, and two views never share one position.
 *
 * jsdom computes no layout (every scrollHeight/clientHeight is 0) and
 * implements no ResizeObserver; the hook guards the missing observer itself, so
 * its restore-on-ready path runs here as it does in a browser, against heights
 * this suite stubs on the test plane only.
 */
import { cleanup, render } from '@testing-library/react'
import { act, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSurfaceScroll, useSurfaceScroll } from '../src/client/surface-scroll.ts'

beforeEach(() => { clearSurfaceScroll() })
afterEach(() => { cleanup(); clearSurfaceScroll(); vi.unstubAllGlobals() })

/** One surface: a scroller driven by the hook's key/ready options. */
function Surface({ viewKey, ready }: { readonly viewKey: string | undefined; readonly ready: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useSurfaceScroll(ref, { key: viewKey, ready })
  // The content child is what the growth watcher observes beside the element.
  return <div data-surface ref={ref} style={{ overflow: 'auto' }}><div data-content /></div>
}

/** A controllable ResizeObserver stand-in (jsdom has none). */
class FakeResizeObserver {
  static latest: FakeResizeObserver | undefined
  readonly observed: Element[] = []
  disconnected = false
  private readonly callback: () => void

  constructor(callback: () => void) {
    this.callback = callback
    FakeResizeObserver.latest = this
  }

  observe(target: Element): void { this.observed.push(target) }
  disconnect(): void { this.disconnected = true }

  /** Deliver one observation (the content changed size). */
  fire(): void {
    act(() => { this.callback() })
  }
}

/** jsdom computes no layout: the heights the hook clamps against are stubbed for one test. */
function stubMetrics(scrollHeight = 1000, clientHeight = 200): () => void {
  const proto = HTMLElement.prototype as unknown as { scrollHeight?: unknown; clientHeight?: unknown }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight })
  return () => {
    delete proto.scrollHeight
    delete proto.clientHeight
  }
}

/** The scroller inside the rendered surface. */
function scroller(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-surface]') as HTMLElement
}

describe('the business surface’s scroll memory', () => {
  it('gives the position back when the reader returns to the same view', () => {
    const restore = stubMetrics()
    try {
      const first = render(<Surface viewKey="workbook:tab:tasks" ready />)
      const element = scroller(first.container)
      element.scrollTop = 420
      act(() => { element.dispatchEvent(new Event('scroll')) })
      first.unmount()

      const second = render(<Surface viewKey="workbook:tab:tasks" ready />)
      expect(scroller(second.container).scrollTop).toBe(420)
    } finally {
      restore()
    }
  })

  it('keeps each view’s position under its own key', () => {
    const restore = stubMetrics()
    try {
      const tasks = render(<Surface viewKey="workbook:tab:tasks" ready />)
      const element = scroller(tasks.container)
      element.scrollTop = 300
      act(() => { element.dispatchEvent(new Event('scroll')) })
      // Another view in the same element: it starts where IT was left (nowhere),
      // never at the previous view's offset.
      tasks.rerender(<Surface viewKey="workbook:tab:notes" ready />)
      expect(scroller(tasks.container).scrollTop).toBe(0)
      const notes = scroller(tasks.container)
      notes.scrollTop = 60
      act(() => { notes.dispatchEvent(new Event('scroll')) })
      tasks.rerender(<Surface viewKey="workbook:tab:tasks" ready />)
      expect(scroller(tasks.container).scrollTop).toBe(300)
      tasks.rerender(<Surface viewKey="workbook:tab:notes" ready />)
      expect(scroller(tasks.container).scrollTop).toBe(60)
    } finally {
      restore()
    }
  })

  it('waits for the view to be ready before restoring', () => {
    const restore = stubMetrics()
    try {
      const first = render(<Surface viewKey="workbook:tab:tasks" ready />)
      const element = scroller(first.container)
      element.scrollTop = 500
      act(() => { element.dispatchEvent(new Event('scroll')) })
      first.unmount()

      // The page is up but its data is not: the remembered position is held.
      const second = render(<Surface viewKey="workbook:tab:tasks" ready={false} />)
      expect(scroller(second.container).scrollTop).toBe(0)
      second.rerender(<Surface viewKey="workbook:tab:tasks" ready />)
      expect(scroller(second.container).scrollTop).toBe(500)
    } finally {
      restore()
    }
  })

  it('stops restoring when the reader scrolls away from the target themselves', () => {
    const restore = stubMetrics()
    try {
      const first = render(<Surface viewKey="workbook:tab:tasks" ready />)
      const element = scroller(first.container)
      element.scrollTop = 500
      act(() => { element.dispatchEvent(new Event('scroll')) })
      first.unmount()

      const second = render(<Surface viewKey="workbook:tab:tasks" ready={false} />)
      const again = scroller(second.container)
      // The human scrolls before the data lands: their position is the truth now.
      again.scrollTop = 20
      act(() => { again.dispatchEvent(new Event('scroll')) })
      second.rerender(<Surface viewKey="workbook:tab:tasks" ready />)
      expect(scroller(second.container).scrollTop).toBe(20)
    } finally {
      restore()
    }
  })

  it('clamps to the content that exists, and retries when it grows', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const restore = stubMetrics(250, 200)
    try {
      const first = render(<Surface viewKey="workbook:tab:tasks" ready />)
      const element = scroller(first.container)
      element.scrollTop = 80
      act(() => { element.dispatchEvent(new Event('scroll')) })
      first.unmount()

      const second = render(<Surface viewKey="workbook:tab:tasks" ready />)
      // 80 does not fit in 50: the position is clamped, the target stays pending.
      expect(scroller(second.container).scrollTop).toBe(50)
      // A scroll event landing exactly on the clamped target is OUR write, not
      // the human moving: the pending target must survive it.
      act(() => { scroller(second.container).dispatchEvent(new Event('scroll')) })
      const observer = FakeResizeObserver.latest
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 900 })
      observer?.fire()
      // The content grew: the remembered position is applied after all.
      expect(scroller(second.container).scrollTop).toBe(80)
      // A child arriving is a content change too: the watcher re-observes it.
      await act(async () => {
        scroller(second.container).appendChild(document.createElement('p'))
        await Promise.resolve()
      })
      expect(observer?.observed.length).toBeGreaterThan(1)
      second.unmount()
      expect(observer?.disconnected).toBe(true)
    } finally {
      restore()
    }
  })

  it('watches growth with the size observer alone where there is no mutation observer', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    // A host without a mutation observer: the size observer is the whole watch.
    vi.stubGlobal('MutationObserver', undefined)
    const restore = stubMetrics()
    try {
      const view = render(<Surface viewKey="workbook:tab:tasks" ready />)
      const observer = FakeResizeObserver.latest
      expect(observer?.observed).toContain(scroller(view.container))
      view.unmount()
      // The teardown still has something to do: it disconnects the observer.
      expect(observer?.disconnected).toBe(true)
    } finally {
      restore()
    }
  })

  it('neither consumes nor overwrites a position while no view is reported', () => {
    const restore = stubMetrics()
    try {
      const first = render(<Surface viewKey="workbook:tab:tasks" ready />)
      const element = scroller(first.container)
      element.scrollTop = 200
      act(() => { element.dispatchEvent(new Event('scroll')) })
      // No page reports (an application without a page is selected): the memory
      // is not consulted at all…
      first.rerender(<Surface viewKey={undefined} ready={false} />)
      // …and the view's position is still there when it comes back.
      first.rerender(<Surface viewKey="workbook:tab:tasks" ready />)
      expect(scroller(first.container).scrollTop).toBe(200)
    } finally {
      restore()
    }
  })
})
