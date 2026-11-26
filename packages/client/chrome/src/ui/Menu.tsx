/** The chrome's own anchored menu: portal, outside dismissal and a keyboard walk. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './ui.module.css'

export interface MenuItemEntry {
  readonly id: string
  readonly label: ReactNode
  readonly disabled?: boolean
  readonly icon?: ReactNode
  readonly danger?: boolean
}
export interface MenuSeparatorEntry { readonly type: 'separator'; readonly id: string }
export interface MenuLabelEntry { readonly type: 'label'; readonly id: string; readonly text: string }
export type MenuEntry = MenuItemEntry | MenuSeparatorEntry | MenuLabelEntry

export interface MenuProps {
  readonly open: boolean
  readonly anchor: ReactNode
  readonly items?: readonly MenuEntry[]
  readonly onSelect?: (id: string) => void
  readonly onClose: () => void
  readonly align?: 'start' | 'end'
  readonly autoFocus?: boolean
  readonly portal?: boolean
  readonly listClassName?: string | undefined
  readonly children?: ReactNode
}

/** One component-rendered menu row. */
export function MenuItemButton({ children, icon, danger = false, disabled = false, onSelect }: {
  readonly children: ReactNode
  readonly icon?: ReactNode
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} className={`${css.menuItem} ${danger ? css.menuItemDanger : ''}`} onClick={onSelect}>
      {icon === undefined ? null : <span className={css.menuItemIcon}>{icon}</span>}
      <span className={css.menuItemLabel}>{children}</span>
    </button>
  )
}

export function Menu({ open, anchor, items, onSelect, onClose, align = 'start', autoFocus = false, portal = false, listClassName, children }: MenuProps) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; minWidth: number }>()
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    setPosition({
      left: align === 'end' ? Math.max(8, rect.right - 180) : Math.min(rect.left, window.innerWidth - 188),
      top: Math.min(rect.bottom + 6, window.innerHeight - 48),
      minWidth: Math.max(180, rect.width),
    })
  }, [open, align, anchor])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return
      onClose()
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open, onClose])
  useEffect(() => {
    if (!open || !autoFocus) return
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
    first?.focus()
  }, [open, autoFocus, position])
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    if (rows.length === 0) return
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown') { event.preventDefault(); rows[(at + 1) % rows.length]!.focus() }
    else if (event.key === 'ArrowUp') { event.preventDefault(); rows[(at - 1 + rows.length) % rows.length]!.focus() }
    else if (event.key === 'Home') { event.preventDefault(); rows[0]!.focus() }
    else if (event.key === 'End') { event.preventDefault(); rows.at(-1)!.focus() }
  }
  return (
    <>
      <span ref={anchorRef} className={css.menuAnchor}>{anchor}</span>
      {open && position !== undefined && (() => {
        const panel = (
          <div
            ref={menuRef} role="menu" className={[css.menu, listClassName ?? ''].filter(Boolean).join(' ')}
            style={{ left: position.left, top: position.top, minWidth: position.minWidth }}
            onKeyDown={onKeyDown}
          >
            {items?.map((entry) => {
            if ('type' in entry) {
              if (entry.type === 'separator') return <div key={entry.id} role="separator" className={css.menuSeparator} />
              return <div key={entry.id} className={css.menuLabel}>{entry.text}</div>
            }
            return (
              <button
                key={entry.id} type="button" role="menuitem" disabled={entry.disabled === true}
                className={`${css.menuItem} ${entry.danger === true ? css.menuItemDanger : ''}`}
                onClick={() => { onSelect?.(entry.id) }}
              >
                {entry.icon === undefined ? null : <span className={css.menuItemIcon}>{entry.icon}</span>}
                <span className={css.menuItemLabel}>{entry.label}</span>
              </button>
            )
          })}
            {children}
          </div>
        )
        return portal ? createPortal(panel, document.body) : panel
      })()}
    </>
  )
}
