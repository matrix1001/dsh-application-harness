// @vitest-environment jsdom
/**
 * The shared scroll memory (`scroll-memory.ts`): the position a scrolling area
 * was left at comes back when the same key is shown again, and only then — an
 * area whose content is not ready waits, an area the human scrolled themselves
 * is not dragged back, content that arrives late gets another try (through the
 * observer, never a delay), and content that is simply shorter is clamped to
 * what exists.
 *
 * jsdom computes no layout (every scrollHeight/clientHeight is 0) and has no
 * ResizeObserver; the metrics are stubbed per test and the observer is a
 * controllable stand-in, so every branch of the restore path runs here.
 */
import { cleanup, render } from '@testing-library/react'
import { act, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearScrollMemory, useScrollMemory, type ScrollMemory } from '../src/scroll-memory.ts'

beforeEach(() => { clearScrollMemory() })
afterEach(() => {
  cleanup()
  clearScrollMemory()
  vi.unstubAllGlobals()
})

/** One area: a scroller driven by the hook's options, plus a way to detach the ref. */
function Area({ areaKey, ready, attached = true, memory }: { readonly areaKey: string | undefined; readonly ready: boolean; readonly attached?: boolean; readonly memory?: ScrollMemory }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useScrollMemory(ref, { key: areaKey, ready, memory })
  // The content child is what the growth watcher observes beside the element.
  return <div {...(attached ? { ref, 'data-area': areaKey ?? 'none' } : { 'data-area': 'detached' })} style={{ overflow: 'auto' }}><div data-content /></div>
}

/** The scroller inside one rendered area. */
function scroller(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-area]') as HTMLElement
}

/** Stub the two heights the hook clamps against (jsdom has no layout). */
function stubMetrics(scrollHeight = 1000, clientHeight = 200): () => void {
  const proto = HTMLElement.prototype as unknown as { scrollHeight?: unknown; clientHeight?: unknown }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight })
  return () => {
    delete proto.scrollHeight
    delete proto.clientHeight
  }
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

/** One scroll event on an element. */
function scroll(element: HTMLElement, top: number): void {
  element.scrollTop = top
  act(() => { element.dispatchEvent(new Event('scroll')) })
}

describe('useScrollMemory', () => {
  it('gives a position back when the same key comes back, and never mixes keys', () => {
    const restore = stubMetrics()
    try {
      const first = render(<Area areaKey="tab:notes" ready />)
      scroll(scroller(first.container), 350)
      first.unmount()
      // Another key in the same element starts at its own position (nowhere).
      const other = render(<Area areaKey="tab:tasks" ready />)
      expect(scroller(other.container).scrollTop).toBe(0)
      other.unmount()
      const again = render(<Area areaKey="tab:notes" ready />)
      expect(scroller(again.container).scrollTop).toBe(350)
    } finally {
      restore()
    }
  })

  it('waits for the area to be ready, then restores', () => {
    const restore = stubMetrics()
    try {
      const first = render(<Area areaKey="list" ready />)
      scroll(scroller(first.container), 120)
      first.unmount()

      const waiting = render(<Area areaKey="list" ready={false} />)
      expect(scroller(waiting.container).scrollTop).toBe(0)
      waiting.rerender(<Area areaKey="list" ready />)
      expect(scroller(waiting.container).scrollTop).toBe(120)
    } finally {
      restore()
    }
  })

  it('ends the restore when the human scrolls the area themselves', () => {
    const restore = stubMetrics()
    try {
      const first = render(<Area areaKey="list" ready />)
      scroll(scroller(first.container), 400)
      first.unmount()

      const second = render(<Area areaKey="list" ready={false} />)
      const element = scroller(second.container)
      scroll(element, 30)
      second.rerender(<Area areaKey="list" ready />)
      expect(scroller(second.container).scrollTop).toBe(30)
    } finally {
      restore()
    }
  })

  it('clamps to the content that exists, and retries when it grows (the observer)', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const restore = stubMetrics(250, 200)
    try {
      const first = render(<Area areaKey="day:2026-01-01" ready />)
      scroll(scroller(first.container), 80)
      first.unmount()

      const second = render(<Area areaKey="day:2026-01-01" ready />)
      const element = scroller(second.container)
      // The remembered 80 does not fit yet: the position is clamped to what the
      // short content allows (50), and the target stays pending.
      expect(element.scrollTop).toBe(50)
      // A scroll event landing exactly on the clamped target is OUR write, not
      // the human moving: the pending target must survive it.
      act(() => { element.dispatchEvent(new Event('scroll')) })
      // The observer watching THIS area (the first render's went with it) also
      // watches its content child.
      const observer = FakeResizeObserver.latest
      expect(observer?.observed).toContain(element)
      expect(observer?.observed).toContain(element.firstElementChild)

      // The content grows: the observer fires and the position is applied.
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 900 })
      observer?.fire()
      expect(scroller(second.container).scrollTop).toBe(80)
      // A child arriving is a content change too: the watcher re-observes it.
      await act(async () => {
        element.appendChild(document.createElement('p'))
        await Promise.resolve()
      })
      expect(observer?.observed.some(node => node.tagName === 'P')).toBe(true)
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
      const view = render(<Area areaKey="tab:notes" ready />)
      const observer = FakeResizeObserver.latest
      expect(observer?.observed).toContain(scroller(view.container))
      view.unmount()
      // The teardown still has something to do: it disconnects the observer.
      expect(observer?.disconnected).toBe(true)
    } finally {
      restore()
    }
  })

  it('keeps positions in a caller-owned memory, leaving the module’s own alone', () => {
    const restore = stubMetrics()
    const owned = new Map<string, number>()
    try {
      const memory: ScrollMemory = {
        get: (key) => owned.get(key),
        set: (key, value) => { owned.set(key, value) },
      }
      const first = render(<Area areaKey="settings" ready memory={memory} />)
      scroll(scroller(first.container), 240)
      first.unmount()
      // The caller's own store has it; the module's map (which a page without a
      // memory uses) was never touched by this area.
      expect(owned.get('settings')).toBe(240)
      const again = render(<Area areaKey="settings" ready memory={memory} />)
      expect(scroller(again.container).scrollTop).toBe(240)
      again.unmount()
      const elsewhere = render(<Area areaKey="settings" ready />)
      expect(scroller(elsewhere.container).scrollTop).toBe(0)
    } finally {
      restore()
    }
  })

  it('does nothing without a key or without an element, and forgets on request', () => {
    const restore = stubMetrics()
    try {
      // No key: the memory is not consulted, and nothing throws.
      const keyless = render(<Area areaKey={undefined} ready />)
      scroll(scroller(keyless.container), 90)
      keyless.rerender(<Area areaKey="tab:notes" ready />)
      // The key it gains has no remembered position, so the element starts at
      // the top rather than keeping the previous view's offset.
      expect(scroller(keyless.container).scrollTop).toBe(0)
      keyless.unmount()

      // A ref that was never attached: the hook installs nothing.
      const detached = render(<Area areaKey="tab:notes" ready={false} attached={false} />)
      detached.rerender(<Area areaKey="tab:notes" ready attached={false} />)
      expect(scroller(detached.container).scrollTop).toBe(0)
      detached.unmount()

      const stored = render(<Area areaKey="tab:notes" ready />)
      scroll(scroller(stored.container), 75)
      stored.unmount()
      clearScrollMemory()
      const after = render(<Area areaKey="tab:notes" ready />)
      expect(scroller(after.container).scrollTop).toBe(0)
    } finally {
      restore()
    }
  })
})
