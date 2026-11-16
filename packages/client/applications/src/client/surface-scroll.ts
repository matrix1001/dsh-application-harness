/**
 * The business surface's scroll memory: where the reader was in the view the
 * page reported, restored when they come back to it.
 *
 * This is the framework's own copy of the rule set the shared chrome library
 * applies to the areas an APPLICATION owns (`chrome/src/scroll-memory.ts`).
 * The copy is not laziness: a client bundle inlines the chrome library, so its
 * module memory belongs to that bundle alone, and the framework cannot reach
 * it. Both copies keep the same four promises — recorded on scroll (never at
 * unmount only, when a shrinking page has already clamped the position to 0),
 * restored once the view says it is ready, retried while the content grows (a
 * ResizeObserver, never a delay), and ended by the human's own first scroll.
 * @module @matrix1001/dsh-application-harness-client-applications/client/surface-scroll
 */

import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Where each view was left, by `application:view` key. Per browser page, like the view state beside it. */
const positions = new Map<string, number>()

/**
 * Where one area's positions live. The default is this module's own map (the
 * business surface, which belongs to the browser page); a caller whose memory
 * belongs to an INSTANCE — the management dialog's, cleared when an application
 * unregisters — passes its own (`manage.ts`).
 */
export interface SurfaceMemory {
  /** The remembered position under one key, or `undefined` when there is none. */
  get(key: string): number | undefined
  /** Remember one position. */
  set(key: string, value: number): void
}

/** The module's own memory (the business surface's), as the injectable face. */
const ownMemory: SurfaceMemory = {
  get: (key) => positions.get(key),
  set: (key, value) => { positions.set(key, value) },
}

/** What the surface is scrolling, and whether that content can be restored into yet. */
export interface SurfaceScrollOptions {
  /** The view on screen (`<appId>:<page key>`); `undefined` disables the memory for this render. */
  readonly key: string | undefined
  /** Whether the page reported the view settled. */
  readonly ready: boolean
  /** Where to keep the position; this module's own memory when omitted. */
  readonly memory?: SurfaceMemory | undefined
}

/** One view's live bookkeeping. */
interface Surface {
  key: string
  /** The position still being restored into, absent once reached or abandoned. */
  target: number | undefined
  /** The newest position this view was seen at (the value a leave records). */
  last: number
}

/**
 * Bind the business surface's scrolling element to the memory.
 * @param ref - the element that actually scrolls (`.surface`), not its wrapper.
 * @param options - the reported view's key and readiness.
 */
export function useSurfaceScroll(ref: RefObject<HTMLElement | null>, options: SurfaceScrollOptions): void {
  const { key, ready } = options
  const memory = options.memory ?? ownMemory
  const surface = useRef<Surface | undefined>(undefined)

  // Layout timing: entering a key reads its remembered position in the same
  // commit the content changed in, before a scroll event caused by the
  // previous view's content leaving could be taken for this view's own.
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || key === undefined) {
      surface.current = undefined
      return
    }
    const entered = surface.current?.key !== key
    const state: Surface = entered
      ? { key, target: memory.get(key), last: memory.get(key) ?? element.scrollTop }
      : surface.current!
    surface.current = state

    const clamp = (top: number): number => Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight))
    const restore = (): void => {
      const target = state.target
      if (target === undefined) return
      element.scrollTop = clamp(target)
      if (clamp(target) >= target) state.target = undefined
    }

    const onScroll = (): void => {
      const at = element.scrollTop
      if (state.target !== undefined && Math.abs(at - clamp(state.target)) <= 1) return
      state.target = undefined
      state.last = at
      memory.set(state.key, at)
    }
    element.addEventListener('scroll', onScroll, { passive: true })

    // Entering a view puts the element at THAT view's position (0 for a view
    // never visited): leaving the previous view's offset on screen would show
    // the new one halfway down. A re-run for the SAME view (its readiness
    // changed) is not an entry and must not move anything.
    if (entered && state.target === undefined) element.scrollTop = 0

    const watching = ready ? watchGrowth(element, () => { if (state.target !== undefined) restore() }) : undefined
    if (ready) restore()

    return () => {
      element.removeEventListener('scroll', onScroll)
      watching?.()
      memory.set(state.key, state.last)
    }
  }, [ref, key, ready, memory])
}

/**
 * Call back when this element or its children change size, or when children
 * are added or replaced — the ways a scroller's content height moves without a
 * scroll. Returns the teardown.
 */
function watchGrowth(element: HTMLElement, onChange: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  const observer = new ResizeObserver(() => { onChange() })
  const observe = (): void => {
    observer.disconnect()
    observer.observe(element)
    for (const child of Array.from(element.children)) observer.observe(child)
  }
  observe()
  const mutations = typeof MutationObserver === 'undefined'
    ? undefined
    : new MutationObserver(() => { observe(); onChange() })
  mutations?.observe(element, { childList: true })
  return () => {
    observer.disconnect()
    mutations?.disconnect()
  }
}

/** Forget every remembered position (the framework's own tests). */
export function clearSurfaceScroll(): void {
  positions.clear()
}
