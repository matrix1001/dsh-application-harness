/**
 * Remembering where a scrolling area was left, for the areas an application
 * owns (its board, its list, its detail pane). The position lives in module
 * memory — this browser page, this bundle — exactly like `props.ui`: leaving
 * the application and coming back lands where the human was, and a reload is
 * nobody's business but the application's own storage.
 *
 * The rules, in the order they matter:
 *
 * - **recorded on scroll**, never at unmount only: content that shrinks before
 *   the cleanup runs would have its position clamped to 0 first, and the
 *   honest position would be gone;
 * - **restored once the content is ready**, and retried while it grows (a
 *   ResizeObserver, never a fixed delay): a list that arrives two frames late
 *   still gets its position back, a list that stays short is clamped to what
 *   exists;
 * - **the human wins**: a scroll that is not ours ends the automatic restore,
 *   so a slow page never drags the reader back to an old offset;
 * - **ownership is by key**: the area's identity (the application's view, the
 *   pane) changes with the key, and each key keeps its own position.
 *
 * A copy of this logic lives in the applications framework for the business
 * surface it owns (`packages/client/applications/src/client/surface-scroll.ts`):
 * a client bundle INLINES this library, so module memory is per bundle and the
 * framework cannot read this map. The two copies stay in step by test, not by
 * import.
 * @module
 */

import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Where each area was left, by key. Per browser page, like the view state it belongs beside. */
const positions = new Map<string, number>()

/**
 * Where an area's positions live. The default is this module's own map (per
 * browser page, per bundle); a caller whose memory must die with an instance —
 * the management dialog's, which is cleared when an application unregisters —
 * passes its own.
 */
export interface ScrollMemory {
  /** The remembered position under one key, or `undefined` when there is none. */
  get(key: string): number | undefined
  /** Remember one position. */
  set(key: string, value: number): void
}

/** The module's own memory (the default), as the injectable face. */
const ownMemory: ScrollMemory = {
  get: (key) => positions.get(key),
  set: (key, value) => { positions.set(key, value) },
}

/** What one area is, and whether its content is ready to be restored into. */
export interface ScrollMemoryOptions {
  /**
   * The area's identity — the application's current view and pane (`tab:notes`,
   * `commit:<sha>`). `undefined` disables the memory for this render (a page
   * that has no view yet).
   */
  readonly key: string | undefined
  /**
   * Whether the content under this key has settled: its data read back and its
   * layout committed. A not-ready area keeps its remembered position (and the
   * one the last visit left) untouched until it is.
   */
  readonly ready: boolean
  /**
   * Where to keep the position; this module's own memory when omitted. A
   * caller-owned memory must outlive the component (the position is read on
   * the next mount) and is the caller's to clear.
   */
  readonly memory?: ScrollMemory | undefined
}

/** One area's live bookkeeping. */
interface Area {
  key: string
  /** The position still being restored into, absent once reached or abandoned. */
  target: number | undefined
  /** The newest position this area was seen at (the value a leave records). */
  last: number
}

/**
 * Bind one scrolling element to the memory. The element must be the element
 * that actually scrolls (the one with `overflow: auto`), not its wrapper.
 * @param ref - the scrolling element.
 * @param options - the area's key and its readiness.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, options: ScrollMemoryOptions): void {
  const { key, ready } = options
  const memory = options.memory ?? ownMemory
  const area = useRef<Area | undefined>(undefined)

  // Layout timing on purpose: entering a key reads its remembered position in
  // the same commit the content changed in, before the browser can dispatch a
  // scroll event caused by the PREVIOUS content's height leaving.
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || key === undefined) {
      area.current = undefined
      return
    }
    const entered = area.current?.key !== key
    const state: Area = entered
      ? { key, target: memory.get(key), last: memory.get(key) ?? element.scrollTop }
      : area.current!
    area.current = state

    const clamp = (top: number): number => Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight))
    const restore = (): void => {
      const target = state.target
      if (target === undefined) return
      element.scrollTop = clamp(target)
      // Reached (or the content simply is not taller than that): done. A short
      // content keeps the target pending, so growth gets another try.
      if (clamp(target) >= target) state.target = undefined
    }

    const onScroll = (): void => {
      const at = element.scrollTop
      // Our own restoring write (or its clamp) is not the human moving.
      if (state.target !== undefined && Math.abs(at - clamp(state.target)) <= 1) return
      state.target = undefined
      state.last = at
      memory.set(state.key, at)
    }
    element.addEventListener('scroll', onScroll, { passive: true })

    // Entering an area puts the element at THAT area's position (0 for one
    // never visited): leaving the previous area's offset on screen would show
    // the new one halfway down. A re-run for the SAME area (its readiness
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
 * Call back whenever this element or its direct children change size, and when
 * children are added or replaced — the two ways a scroller's content height
 * moves without a scroll. Returns the teardown.
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

/** Forget every remembered position (the framework's own tests, and a page that is truly gone). */
export function clearScrollMemory(): void {
  positions.clear()
}
