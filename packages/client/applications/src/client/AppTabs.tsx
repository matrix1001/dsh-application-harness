/**
 * The application tabs: every fixed page application as one compact tab in the
 * header. The tabs are the fast switch and the application identity at once;
 * the footerless list never owns a second navigation column.
 *
 * The active tab is a roving tab stop; Left/Right walk the ring and Home/End
 * jump to the ends (selection follows focus, like the platform's own tabs).
 * The active tab scrolls into view when the human switches, so a narrow strip
 * never hides where they are.
 *
 * The strip is also the direct-manipulation surface: a whole tab can be dragged
 * to reorder the fixed list, and a tab's native context menu pins/unpins it and
 * moves it one slot. That is the Chrome extensions model — no separate edit
 * mode. There is deliberately no custom keyboard shortcut for reorder; the
 * context-menu moves keep the operation keyboard reachable without claiming a
 * global chord.
 * @module @matrix1001/dsh-application-harness-client-applications/client/AppTabs
 */
import {
  useEffect, useRef, useState,
  type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react'
import { Menu, type MenuEntry } from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView } from './contract.ts'
import { AppIcon } from './AppIcon.tsx'
import { displayName, dropIndexAt, moveApplicationBy, moveIdBefore, statusView } from './model.ts'
import css from './ApplicationsArea.module.css'

/** The open tab context menu: which tab, and where the pointer opened it. */
interface TabMenu {
  readonly id: string
  readonly x: number
  readonly y: number
}

/** What the tab strip renders from and the actions it offers. */
export interface AppTabsProps {
  /** The page applications, in the human's saved order (then the temporary one). */
  readonly apps: readonly AppInfo[]
  /** The registrations, for display names and icons. */
  readonly views: ReadonlyMap<string, ApplicationView>
  /** The application whose page the area shows. */
  readonly activeId: string | undefined
  /** Whether the application rows are still being read. */
  readonly loading: boolean
  /** The current application when it is not fixed: a temporary last tab. */
  readonly temporaryId?: string | undefined
  /** Applications whose first-run capability card is still unanswered. */
  readonly pendingApproval?: ReadonlySet<string> | undefined
  readonly onSelect: (appId: string) => void
  /** Fix one application to the tab strip. */
  readonly onPin: (appId: string) => void
  /** Remove one application from the tab strip. */
  readonly onUnpin: (appId: string) => void
  /** Replace the fixed order after a drag or a context-menu move. */
  readonly onOrder: (ids: readonly string[]) => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the application tab strip.
 * @param props - the rows, the selection, the loading state and the actions.
 * @returns the tab list element (or its loading/empty placeholder).
 */
export function AppTabs({
  apps, views, activeId, loading, temporaryId, pendingApproval, onSelect, onPin, onUnpin, onOrder, t,
}: AppTabsProps): ReactNode {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const draggingRef = useRef(false)
  const menuActionRef = useRef(false)
  const [dragId, setDragId] = useState<string>()
  const [dropIndex, setDropIndex] = useState<number>()
  const [dropLeft, setDropLeft] = useState<number>()
  const [tabMenu, setTabMenu] = useState<TabMenu>()

  const pinnedApps = apps.filter(app => app.id !== temporaryId)
  const pinnedIds = pinnedApps.map(app => app.id)

  useEffect(() => {
    const node = activeRef.current
    const list = listRef.current
    if (node === null || typeof node.scrollIntoView !== 'function') return undefined
    const reveal = (): void => { node.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
    reveal()
    // A window resize or a sidebar/dock width change narrows the strip without
    // changing activeId; without this the current tab could end up half under
    // the applications button until the human switched applications again.
    /* v8 ignore next -- jsdom has no layout; the browser smoke covers reveal-on-resize */
    if (list === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    return () => { observer.disconnect() }
  }, [activeId, apps.length])

  const focusTab = (appId: string): void => {
    /* v8 ignore next -- jsdom has no layout; focus moves are covered when the node exists */
    const node = tabRefs.current.get(appId)
    if (node !== undefined) { node.focus(); return }
    const fallback = listRef.current?.querySelector<HTMLElement>('[data-app-tab-active]')
      ?? listRef.current?.querySelector<HTMLElement>('[data-app-tab]')
    /* v8 ignore next -- the no-fallback path needs a real layout-less tab list */
    if (fallback !== null && fallback !== undefined) { fallback.focus(); return }
    document.querySelector<HTMLElement>('[data-app-all]')?.focus()
  }

  const insertionIndex = (clientX: number): number => {
    const rects: Array<{ left: number; width: number }> = []
    for (const app of pinnedApps) {
      const node = tabRefs.current.get(app.id)
      if (node === undefined) continue
      const rect = node.getBoundingClientRect()
      rects.push({ left: rect.left, width: rect.width })
    }
    return dropIndexAt(rects, clientX)
  }

  const insertionLeft = (index: number): number => {
    const node = pinnedApps[index] === undefined ? pinnedApps.at(-1) : pinnedApps[index]
    if (node === undefined) return 0
    const element = tabRefs.current.get(node.id)
    if (element === undefined) return 0
    return index < pinnedApps.length ? element.offsetLeft : element.offsetLeft + element.offsetWidth
  }

  const clearDrag = (): void => {
    setDragId(undefined)
    setDropIndex(undefined)
    setDropLeft(undefined)
  }

  const finishDrag = (): void => {
    clearDrag()
    // The click that a browser may synthesize after a drag must not switch the
    // page: keep the guard through the current task.
    window.setTimeout(() => { draggingRef.current = false }, 0)
  }

  const startDrag = (event: ReactDragEvent<HTMLButtonElement>, app: AppInfo): void => {
    if (app.id === temporaryId) { event.preventDefault(); return }
    const transfer = event.dataTransfer as DataTransfer | null
    setDragId(app.id)
    setDropIndex(undefined)
    setDropLeft(undefined)
    draggingRef.current = true
    if (transfer == null) return
    transfer.effectAllowed = 'move'
    transfer.setData('text/plain', app.id)
    if (typeof transfer.setDragImage === 'function') {
      transfer.setDragImage(event.currentTarget, 16, 14)
    }
  }

  const dragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (dragId === undefined) return
    event.preventDefault()
    const transfer = event.dataTransfer as DataTransfer | null
    if (transfer != null) transfer.dropEffect = 'move'
    const list = listRef.current
    if (list === null) return
    const index = insertionIndex(event.clientX)
    const from = pinnedIds.indexOf(dragId)
    const noop = index === from || index === from + 1
    setDropIndex(noop ? undefined : index)
    setDropLeft(noop ? undefined : insertionLeft(index))
    // Keep the insertion point reachable while the strip overflows.
    const box = list.getBoundingClientRect()
    if (event.clientX < box.left + 24) list.scrollLeft -= 10
    else if (event.clientX > box.right - 24) list.scrollLeft += 10
  }

  const drop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (dragId === undefined) return
    event.preventDefault()
    const index = dropIndex ?? insertionIndex(event.clientX)
    const dragged = dragId
    const next = moveIdBefore(pinnedIds, dragged, index)
    finishDrag()
    if (!sameOrder(pinnedIds, next)) onOrder(next)
    requestAnimationFrame(() => { focusTab(dragged) })
  }

  const dragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDropIndex(undefined)
    setDropLeft(undefined)
  }

  const pin = (appId: string): void => {
    onPin(appId)
    requestAnimationFrame(() => { focusTab(appId) })
  }

  const unpin = (appId: string): void => {
    /* v8 ignore next -- jsdom has no layout; the browser smoke covers focus after unpin */
    const index = apps.findIndex(app => app.id === appId)
    /* v8 ignore next -- focus after unpin needs a rendered layout */
    const neighbour = apps[index + 1] ?? apps[index - 1]
    onUnpin(appId)
    requestAnimationFrame(() => {
      // The current application stays as the temporary tab; any other row is
      // gone, so focus must move to its neighbour rather than fall to body.
      if (appId === activeId) focusTab(appId)
      else if (neighbour !== undefined) focusTab(neighbour.id)
      else focusTab(appId)
    })
  }

  const move = (appId: string, delta: number): void => {
    onOrder(moveApplicationBy(pinnedIds, appId, delta))
    requestAnimationFrame(() => { focusTab(appId) })
  }

  const menuItems = (appId: string): readonly MenuEntry[] => {
    const temporary = appId === temporaryId
    if (temporary) return [{ id: 'pin', label: t('nav.pin') }]
    const index = pinnedIds.indexOf(appId)
    return [
      { id: 'unpin', label: t('nav.unpin') },
      { type: 'separator', id: 'sep-move' },
      { id: 'left', label: t('nav.moveLeft'), disabled: index <= 0 },
      { id: 'right', label: t('nav.moveRight'), disabled: index === -1 || index >= pinnedIds.length - 1 },
    ]
  }

  if (loading || apps.length === 0) {
    return (
      <div className={css.headerTabs} data-app-tabs>
        <span className={css.appTabsEmpty} data-app-tabs-empty>{loading ? t('loading') : t('nav.noApps')}</span>
      </div>
    )
  }

  const moveSelection = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % apps.length; break
      case 'ArrowLeft': next = (index + apps.length - 1) % apps.length; break
      case 'Home': next = 0; break
      case 'End': next = apps.length - 1; break
      default: return
    }
    event.preventDefault()
    const target = apps[next]
    if (target === undefined) return
    onSelect(target.id)
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <>
      <div
        className={css.headerTabs}
        data-app-tabs
        role="tablist"
        aria-label={t('nav.label')}
        ref={listRef}
        onDragOver={dragOver}
        onDrop={drop}
        onDragLeave={dragLeave}
      >
        {apps.map((app, index) => {
          const name = displayName(app, views.get(app.id))
          const status = statusView(app, t, pendingApproval?.has(app.id) === true)
          const temporary = app.id === temporaryId
          const statusLabel = status.label === undefined ? undefined : status.label
          const label = [name, statusLabel, temporary ? t('nav.temporary') : undefined].filter((part): part is string => part !== undefined).join(' — ')
          const selected = app.id === activeId
          return (
            <button
              key={app.id}
              ref={(node) => {
                if (node === null) tabRefs.current.delete(app.id)
                else {
                  tabRefs.current.set(app.id, node)
                  if (selected) activeRef.current = node
                }
              }}
              type="button"
              role="tab"
              className={css.appTab}
              aria-selected={selected}
              aria-label={label}
              title={label}
              tabIndex={selected || (activeId === undefined && index === 0) ? 0 : -1}
              data-app-tab={app.id}
              data-app-tab-active={selected ? 'true' : undefined}
              data-app-tab-temporary={temporary ? 'true' : undefined}
              data-app-tab-dragging={dragId === app.id ? 'true' : undefined}
              draggable={!temporary}
              onClick={() => {
                if (draggingRef.current) { draggingRef.current = false; return }
                onSelect(app.id)
              }}
              onKeyDown={(event) => { moveSelection(event, index) }}
              onContextMenu={(event) => {
                event.preventDefault()
                menuActionRef.current = false
                setTabMenu({ id: app.id, x: event.clientX, y: event.clientY })
              }}
              onDragStart={(event) => { startDrag(event, app) }}
              onDragEnd={finishDrag}
            >
              <AppIcon view={views.get(app.id)} size={16} />
              <span className={css.appTabName}>{name}</span>
              {status.label !== undefined && <span className={css.appDot} data-tone={status.tone} aria-hidden="true" />}
            </button>
          )
        })}
        {dropLeft !== undefined && (
          <span
            className={css.tabDropLine}
            data-app-drop-line
            aria-hidden="true"
            style={{ left: `${String(dropLeft)}px` }}
          />
        )}
      </div>
      {tabMenu !== undefined && (
        <Menu
          open
          anchor={<span style={{ position: 'fixed', left: tabMenu.x, top: tabMenu.y, width: 1, height: 1 }} />}
          items={menuItems(tabMenu.id)}
          onSelect={(id) => {
            const appId = tabMenu.id
            menuActionRef.current = true
            setTabMenu(undefined)
            if (id === 'pin') { pin(appId); return }
            if (id === 'unpin') { unpin(appId); return }
            if (id === 'left') { move(appId, -1); return }
            if (id === 'right') move(appId, 1)
          }}
          onClose={() => {
            const appId = tabMenu.id
            setTabMenu(undefined)
            // An action schedules its own focus target (the moved tab, the
            // surviving neighbour, the now-temporary tab). Only a dismissal
            // (Escape/outside) needs this fallback, or it would race the action.
            if (menuActionRef.current) { menuActionRef.current = false; return }
            requestAnimationFrame(() => { focusTab(appId) })
          }}
          align="start"
          autoFocus
        />
      )}
    </>
  )
}

/** Whether two orders are the same (a no-op drop must not write preferences). */
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}
