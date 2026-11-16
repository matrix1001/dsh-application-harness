/**
 * The shared keyboard model for an exclusive choice: a `tablist` of `tab`s or a
 * `radiogroup` of `radio`s.
 *
 * The role is not decoration. A row of buttons that only paints the current
 * choice with a CSS class cannot be read, and a declared role without the keys
 * its pattern promises is worse than no role at all (the UI review found both:
 * the info-hub's radio group and the disk view's tablist accepted a role but
 * ignored the arrow keys). This hook owns the whole contract once — roles,
 * selected/checked state, the single Tab stop, arrow/Home/End movement, focus
 * following the selection, and bringing the focused item into view — while each
 * view keeps its own markup, class names and data anchors.
 *
 * Selection follows focus for both patterns (the WAI-ARIA automatic-activation
 * model the existing TabBar already used): one Tab stop lands on the current
 * item, and the arrows both move the focus and choose the new item.
 * @module @matrix1001/dsh-application-harness-client-chrome/roving
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

/** The ARIA pattern this group implements. */
export type RovingRole = 'tab' | 'radio'

/** One group's inputs. */
export interface RovingGroupOptions {
  /** Every item id, in visual order (they must be rendered in this order). */
  readonly ids: readonly string[]
  /** The selected/checked item id. */
  readonly active: string
  /** Choose one item (the click and the arrows both call it). */
  readonly onSelect: (id: string) => void
  /** The pattern: `tab` marks `aria-selected`, `radio` marks `aria-checked`. */
  readonly role: RovingRole
  /** The direction the arrow keys move in (default horizontal). */
  readonly orientation?: 'horizontal' | 'vertical'
}

/** The props one item spreads onto its element. */
export interface RovingItemProps {
  role: 'tab' | 'radio'
  tabIndex: 0 | -1
  'aria-selected'?: boolean
  'aria-checked'?: boolean
  onClick: () => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

/** One group's returned face. */
export interface RovingGroup {
  /** The container's role and orientation. */
  readonly groupProps: {
    role: 'tablist' | 'radiogroup'
    'aria-orientation'?: 'horizontal' | 'vertical'
  }
  /** The props of one item (role, state, roving tab stop, click and keys). */
  itemProps: (id: string) => RovingItemProps
  /** The ref to attach to one item (arrow moves focus through it). */
  itemRef: (id: string) => (element: HTMLElement | null) => void
}

/**
 * Bind one exclusive group to the keyboard and ARIA contract.
 * @param options - the ids, the active id, the select callback and the role.
 * @returns the group, item and ref props.
 */
export function useRovingGroup(options: RovingGroupOptions): RovingGroup {
  const { ids, active, onSelect, role, orientation = 'horizontal' } = options
  const items = useRef(new Map<string, HTMLElement>())
  // A caller whose active id is not in the list still needs one Tab stop; the
  // first item takes it, and the arrows/click then move the selection normally.
  const tabStop = ids.includes(active) ? active : ids[0]

  const itemRef = (id: string) => (element: HTMLElement | null): void => {
    if (element === null) items.current.delete(id)
    else items.current.set(id, element)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>, id: string): void => {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    const current = ids.indexOf(id)
    if (current === -1) return
    let next: number | undefined
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = ids.length - 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // Both axes are accepted: the orientation only says which way is
      // "forward", and a horizontal group's Up/Down are harmless synonyms.
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      next = (current + (forward ? 1 : -1) + ids.length) % ids.length
    }
    if (next === undefined) return
    event.preventDefault()
    // `current` was found in this same `ids`, so the list is non-empty and every
    // index produced above (Home, End, a wrapped arrow) addresses an item.
    const targetId = ids[next]!
    onSelect(targetId)
    const target = items.current.get(targetId)
    target?.focus()
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  return {
    groupProps: role === 'tab'
      ? { role: 'tablist', 'aria-orientation': orientation }
      : { role: 'radiogroup', 'aria-orientation': orientation },
    itemProps: (id: string): RovingItemProps => ({
      role: role === 'tab' ? 'tab' : 'radio',
      tabIndex: id === tabStop ? 0 : -1,
      ...(role === 'tab' ? { 'aria-selected': id === active } : { 'aria-checked': id === active }),
      onClick: () => { onSelect(id) },
      onKeyDown: (event) => { onKeyDown(event, id) },
    }),
    itemRef,
  }
}
