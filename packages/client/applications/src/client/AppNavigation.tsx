/**
 * The application navigation: every application that draws a page, the entry
 * to the management surface, and the fold control. On a wide area it is a
 * column the human folds or unfolds (the preference outlives the render); on a
 * narrow one it is a temporary drawer that closes on selection.
 *
 * Applications WITHOUT a page are deliberately absent here — they are reached
 * through 应用管理, which lists everything the host runs. Losing the page half
 * (a package unloaded) is not losing the application.
 *
 * Nothing here reports call activity: an ordinary read is not news, and a row
 * that flashed "running" for one never told the human anything they could act
 * on (`F1`). Real progress and cancellation live where the work was started.
 *
 * The narrow drawer is a real modal LAYER (the platform's own `useModalLayer`):
 * focus enters it, Tab stays inside it, Escape closes it, and focus goes back
 * to whatever opened it — the same ownership the platform's dialogs have, so
 * two surfaces can never fight over Escape or the tab order.
 * @module @matrix1001/dsh-application-harness-client-applications/client/AppNavigation
 */
import {
  useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  IconCloseOutlineRegular, IconPanelLeftOutlineRegular, useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView } from './contract.ts'
import { displayName, moveApplicationBy, moveIdBefore } from './model.ts'
import { AppIcon } from './AppIcon.tsx'
import { StatusBadge } from './StatusBadge.tsx'
import css from './ApplicationsArea.module.css'

/** What the navigation renders from and the two ways it can be folded away. */
export interface AppNavigationProps {
  /** Every application the host runs, in host order. */
  readonly apps: readonly AppInfo[]
  /** The registrations, for the display names and the page half. */
  readonly views: ReadonlyMap<string, ApplicationView>
  /** The application whose page the area shows. */
  readonly activeId: string | undefined
  /** Whether the application list itself is still being read. */
  readonly loading: boolean
  /** Confirmations waiting for an answer — the management entry's badge. */
  readonly pending: number
  /** Whether the wide column is expanded (the persisted desktop preference). */
  readonly expanded: boolean
  /** Whether the area is narrow (the drawer mode). */
  readonly narrow: boolean
  /** Whether the drawer is open (narrow only). */
  readonly drawerOpen: boolean
  readonly onSelect: (appId: string) => void
  /** Fold or unfold the wide column (the persisted preference). */
  readonly onToggle: () => void
  /** Open the management surface at its list. */
  readonly onManage: () => void
  readonly onCloseDrawer: () => void
  /** Persist the human's own order (page application ids, complete list). */
  readonly onReorder: (ids: readonly string[]) => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the application navigation.
 * @param props - the rows, the selection, the fold state and the actions.
 * @returns the navigation column (or drawer) element.
 */
export function AppNavigation(props: AppNavigationProps): ReactNode {
  const { apps, views, activeId, loading, pending, expanded, narrow, drawerOpen, onSelect, onToggle, onManage, onCloseDrawer, onReorder, t } = props
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'available' | 'attention'>('all')
  const [announcement, setAnnouncement] = useState('')
  const [dragging, setDragging] = useState<string>()
  const [dropIndex, setDropIndex] = useState<number>()
  const dragRef = useRef<{ id: string; pointerId: number; startY: number; moved: boolean } | undefined>(undefined)
  const listRef = useRef<HTMLUListElement>(null)
  const rows = useMemo(() => {
    const pageRows = apps.filter(app => views.get(app.id)?.Component !== undefined)
    const normalized = query.trim().toLocaleLowerCase()
    return pageRows.filter((app) => {
      if (filter === 'available' && app.status !== 'available') return false
      if (filter === 'attention' && app.status === 'available') return false
      if (normalized === '') return true
      return displayName(app, views.get(app.id)).toLocaleLowerCase().includes(normalized) || app.id.toLocaleLowerCase().includes(normalized)
    })
  }, [apps, views, query, filter])
  // Reordering only makes sense on the complete list: a filtered subset has no
  // unambiguous position for a hidden row.
  const sortable = query.trim() === '' && filter === 'all'
  const drawer = narrow && drawerOpen
  const panel = useRef<HTMLElement>(null)

  /** The rendered ids, in order. */
  const currentIds = (): string[] => rows.map(row => row.id)

  /** Move one row with the keyboard (the drag's accessible alternative). */
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, appId: string): void => {
    if (!sortable || !event.altKey) return
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (delta === 0) return
    event.preventDefault()
    const ids = currentIds()
    const next = moveApplicationBy(ids, appId, delta)
    if (next.join('\u0000') === ids.join('\u0000')) return
    onReorder(next)
    setAnnouncement(t('nav.reordered', { position: next.indexOf(appId) + 1, total: next.length }))
  }

  const startDrag = (event: ReactPointerEvent<HTMLSpanElement>, appId: string): void => {
    if (!sortable || event.button !== 0) return
    event.preventDefault()
    if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { id: appId, pointerId: event.pointerId, startY: event.clientY, moved: false }
  }

  /** Track the pointer and paint the insertion line; the order commits on drop. */
  const moveDrag = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const current = dragRef.current
    if (current === undefined || current.pointerId !== event.pointerId) return
    if (!current.moved && Math.abs(event.clientY - current.startY) < 4) return
    current.moved = true
    setDragging(current.id)
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-app-nav-item]') ?? [])
    let target = items.length
    for (const [index, item] of items.entries()) {
      const box = item.getBoundingClientRect()
      if (event.clientY < box.top + box.height / 2) { target = index; break }
    }
    setDropIndex(target)
  }

  const endDrag = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const current = dragRef.current
    if (current === undefined || current.pointerId !== event.pointerId) return
    dragRef.current = undefined
    const target = dropIndex
    setDragging(undefined)
    setDropIndex(undefined)
    if (!current.moved || target === undefined) return
    const ids = currentIds()
    const next = moveIdBefore(ids, current.id, target)
    if (next.join('\u0000') === ids.join('\u0000')) return
    onReorder(next)
    setAnnouncement(t('nav.reordered', { position: next.indexOf(current.id) + 1, total: next.length }))
  }

  // The drawer is a modal layer while it is open: it takes the initial focus
  // (the active application's row, or the first control), owns Tab and Escape,
  // and gives focus back to its opener on the way out — the platform's layer
  // remembers what was focused before it. The backdrop is the second way out,
  // for a touch user with no Escape key.
  useModalLayer(panel, drawer, onCloseDrawer)

  // Narrow and closed: the drawer is not in the layout at all (a hidden
  // 204px column would still take the width it was given).
  if (narrow && !drawerOpen) return null

  return (
    <>
      {drawer && <div className={css.drawerBackdrop} data-app-drawer-backdrop aria-hidden="true" onClick={onCloseDrawer} />}
      <nav
        ref={panel}
        className={drawer ? `${css.nav} ${css.navDrawer}` : css.nav}
        aria-label={t('nav.label')}
        {...(drawer ? { role: 'dialog', 'aria-modal': true } : {})}
        data-app-nav-root
        data-nav-state={narrow ? 'drawer' : expanded ? 'expanded' : 'collapsed'}
      >
        <div className={css.navHead}>
          <span className={css.navTitle}>{t('panel')}</span>
          {narrow
            ? (
              <button
                type="button"
                className={css.navIconButton}
                data-app-nav-close
                aria-label={t('nav.close')}
                onClick={onCloseDrawer}
              >
                <IconCloseOutlineRegular size={16} />
              </button>
            )
            : (
              <button
                type="button"
                className={css.navIconButton}
                data-app-nav-toggle
                aria-expanded={expanded}
                aria-label={t(expanded ? 'nav.collapse' : 'nav.expand')}
                onClick={onToggle}
              >
                <IconPanelLeftOutlineRegular size={16} />
              </button>
            )}
        </div>
        <div className={css.navTools}>
          <input
            type="search"
            className={css.navSearch}
            value={query}
            placeholder={t('nav.search')}
            aria-label={t('nav.search')}
            data-app-nav-search
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <select
            className={css.navFilter}
            value={filter}
            aria-label={t('nav.filter')}
            data-app-nav-filter
            onChange={(event) => { setFilter(event.target.value as 'all' | 'available' | 'attention') }}
          >
            <option value="all">{t('nav.filterAll')}</option>
            <option value="available">{t('nav.filterAvailable')}</option>
            <option value="attention">{t('nav.filterAttention')}</option>
          </select>
        </div>
        <ul className={css.navList} ref={listRef} data-drop-end={dropIndex === rows.length ? 'true' : undefined}>
          {rows.map((app, index) => {
            const showStatus = app.status !== 'available' || app.health === 'degraded'
            return (
              <li
                key={app.id}
                className={css.navItem}
                data-app-nav-item={app.id}
                data-drop-before={dropIndex === index ? 'true' : undefined}
                data-dragging={dragging === app.id ? 'true' : undefined}
              >
                <button
                  type="button"
                  className={css.navRow}
                  data-app-nav={app.id}
                  data-status={app.status}
                  {...(drawer && app.id === activeId ? { 'data-modal-autofocus': true } : {})}
                  aria-current={app.id === activeId ? 'page' : undefined}
                  {...(sortable ? { 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' } : {})}
                  onClick={() => { onSelect(app.id) }}
                  onKeyDown={(event) => { onRowKeyDown(event, app.id) }}
                >
                  <AppIcon view={views.get(app.id)} size={16} />
                  <span className={css.navName}>{displayName(app, views.get(app.id))}</span>
                  {showStatus && <StatusBadge runtime={app.runtime} status={app.status} health={app.health} activation={app.activation} t={t} />}
                </button>
                {sortable && (
                  <span
                    className={css.dragHandle}
                    data-app-nav-handle={app.id}
                    aria-hidden="true"
                    title={t('nav.reorder')}
                    onPointerDown={(event) => { startDrag(event, app.id) }}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >⋮⋮</span>
                )}
              </li>
            )
          })}
        </ul>
        <p className={css.srOnly} role="status" aria-live="polite" data-app-nav-announcement>{announcement}</p>
        {rows.length === 0 && (
          <p className={css.navHint} data-app-nav-empty>
            {loading ? t('loading') : apps.some(app => views.get(app.id)?.Component !== undefined) ? t('nav.noMatches') : t('nav.noApps')}
          </p>
        )}
        <div className={css.navFoot}>
          <button
            type="button"
            className={css.navManage}
            data-app-manage
            {...(drawer && rows.length === 0 ? { 'data-modal-autofocus': true } : {})}
            onClick={onManage}
          >
            <span>{t('nav.manage')}</span>
            {pending > 0 && <span className={css.navCount} data-app-pending-count>{pending}</span>}
          </button>
        </div>
      </nav>
    </>
  )
}
