/**
 * The application header: the compact strip above the business surface. It
 * carries ONE contextual way back (the record origin, or the conversation at
 * the area root), the fixed application tabs (the fast switch, the current
 * identity and the direct reorder surface), the complete application list with
 * its pin toggles, the shell status control and the current application's
 * management menu. Identity details (id, version, lifecycle, ops) stay in
 * management, where they are read on purpose.
 * @module @matrix1001/dsh-application-harness-client-applications/client/AppHeader
 */
import { useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconEllipsisOutlineRegular, IconPanelLeftOutlineRegular,
  Menu, Tooltip, type MenuEntry,
} from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView, ManageTab } from './contract.ts'
import { AppMenu } from './AppMenu.tsx'
import { AppTabs } from './AppTabs.tsx'
import { hasSettings } from './model.ts'
import type { AreaNotice } from './notices.ts'
import { StatusControl } from './StatusControl.tsx'
import css from './ApplicationsArea.module.css'

/** What the header renders from and the actions it offers. */
export interface AppHeaderProps {
  /** The application whose page is showing; absent while nothing is selected. */
  readonly app: AppInfo | undefined
  /** Its registration (the display name and the settings half). */
  readonly view: ApplicationView | undefined
  /** The fixed tabs plus the temporary current application, in render order. */
  readonly tabs: readonly AppInfo[]
  /** Every page application, in the host's stable order (the complete list). */
  readonly allApps: readonly AppInfo[]
  /** The applications fixed to the tab strip, in the human's order. */
  readonly pinned: readonly AppInfo[]
  /** The current application when it is not fixed (it renders as a temporary last tab). */
  readonly temporaryId?: string | undefined
  /** Applications whose first-run capability card is still unanswered. */
  readonly pendingApproval?: ReadonlySet<string> | undefined
  /** The registrations, for the tabs' and list's display names. */
  readonly views: ReadonlyMap<string, ApplicationView>
  /** Whether the application rows are still being read. */
  readonly loading: boolean
  /** Confirmations waiting — shown on the management entry. */
  readonly pending: number
  /** The shell-level notices the header's status control reports. */
  readonly notices: readonly AreaNotice[]
  /** The one back action's destination: the record origin, or the conversation. */
  readonly backLabel: string
  /** The one back action: pop the record origin, or leave the area at its root. */
  readonly onBack: () => void
  readonly onSwitch: (appId: string) => void
  /** Fix one page application to the tab strip (append). */
  readonly onPin: (appId: string) => void
  /** Remove one page application from the tab strip. */
  readonly onUnpin: (appId: string) => void
  /** Replace the fixed order after a drag or a context-menu move. */
  readonly onOrder: (ids: readonly string[]) => void
  /** Open the management page for one application at one area (and one section inside it). */
  readonly onManage: (appId: string, tab: ManageTab, focus?: 'history' | 'debug') => void
  /** Open the management surface at its list (the list's footer). */
  readonly onManageList: () => void
  /** Open the application-area right dock. */
  readonly onDockOpen?: () => void
  /** Open the development-session creation dialog. */
  readonly onDevelop?: (appId: string) => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the application header.
 * @param props - the tabs, the complete list, the back action and the actions.
 * @returns the header element.
 */
export function AppHeader(props: AppHeaderProps): ReactNode {
  const {
    app, view, tabs, allApps, pinned, temporaryId, pendingApproval, views, loading, pending, notices,
    backLabel, onBack, onSwitch, onPin, onUnpin, onOrder, onManage, onManageList, onDockOpen, onDevelop, t,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)

  const manageItems: readonly MenuEntry[] = app === undefined ? [] : [
    ...(hasSettings(view) ? [{ id: 'settings', label: t('menu.settings') }] : []),
    { id: 'permissions', label: t('menu.permissions') },
    { id: 'history', label: t('menu.history') },
    { id: 'info', label: t('menu.info') },
    ...(onDevelop === undefined ? [] : [{ id: 'develop', label: t('menu.develop') }]),
    { type: 'separator', id: 'sep' },
    { id: 'debug', label: t('menu.debug') },
  ]

  return (
    <header className={css.header} data-app-header>
      <Tooltip label={backLabel} delayMs={500}>
        <Button
          size="sm"
          variant="ghost"
          className={css.headerIconButton}
          data-app-back
          aria-label={backLabel}
          onClick={onBack}
        >
          <IconChevronLeftOutlineRegular size={16} />
        </Button>
      </Tooltip>
      <AppTabs
        apps={tabs}
        views={views}
        activeId={app?.id}
        loading={loading}
        {...(temporaryId === undefined ? {} : { temporaryId })}
        {...(pendingApproval === undefined ? {} : { pendingApproval })}
        onSelect={onSwitch}
        onPin={onPin}
        onUnpin={onUnpin}
        onOrder={onOrder}
        t={t}
      />
      <AppMenu
        apps={allApps}
        pinnedIds={pinned.map(candidate => candidate.id)}
        activeId={app?.id}
        views={views}
        loading={loading}
        {...(pendingApproval === undefined ? {} : { pendingApproval })}
        onSwitch={onSwitch}
        onPin={onPin}
        onUnpin={onUnpin}
        onManageList={onManageList}
        t={t}
      />
      <div className={css.headerSpacer} />
      <StatusControl notices={notices} panelId="app-status-panel" t={t} />
      {app !== undefined && view?.Component !== undefined && (
        <Menu
          open={menuOpen}
          anchor={(
            <Button
              ref={menuButton}
              size="sm"
              variant="ghost"
              className={css.headerIconButton}
              data-app-menu
              aria-label={pending > 0 ? `${t('header.manage')} (${String(pending)})` : t('header.manage')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(open => !open) }}
            >
              <IconEllipsisOutlineRegular size={16} />
              {pending > 0 && <span className={css.headerCount} data-app-pending-count>{pending}</span>}
            </Button>
          )}
          items={manageItems}
          onSelect={(id) => {
            setMenuOpen(false)
            menuButton.current?.focus()
            if (id === 'develop') { onDevelop?.(app.id); return }
            if (id === 'debug') { onManage(app.id, 'status', 'debug'); return }
            /* v8 ignore start -- these menu destinations are exercised through the management page */
            onManage(
              app.id,
              id === 'info' ? 'status' : id === 'history' ? 'data' : id as ManageTab,
              id === 'history' ? 'history' : undefined,
            )
            /* v8 ignore stop */
          }}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          autoFocus
        />
      )}
      {app !== undefined && view?.Component !== undefined && onDockOpen !== undefined && (
        <Tooltip label={t('dock.expandAria')} side="bottom" delayMs={500}>
          <Button
            size="sm"
            variant="ghost"
            className={css.dockExpand}
            data-sidebar-right-expand
            aria-label={t('dock.expandAria')}
            onClick={onDockOpen}
          >
            <IconPanelLeftOutlineRegular size={16} className={css.dockExpandIcon} />
          </Button>
        </Tooltip>
      )}
    </header>
  )
}
