/**
 * The application header: the compact strip above the business surface. It
 * carries only what a user needs WHILE working — which application this is
 * (and a fast switch to another), and the way into this
 * application's management. Identity details (id, version, lifecycle, ops) are
 * not repeated here: they live in the management dialog, where they are read
 * on purpose instead of occupying every business page.
 * @module @matrix1001/dsh-application-harness-client-applications/client/AppHeader
 */
import { useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconEllipsisOutlineRegular, IconPanelLeftOutlineRegular,
  IconNewChatOutlineRegular, Menu, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView, ManageTab } from './contract.ts'
import { AppIcon } from './AppIcon.tsx'
import { displayName, hasSettings } from './model.ts'
import css from './ApplicationsArea.module.css'

/** What the header renders from and the actions it offers. */
export interface AppHeaderProps {
  /** The application whose page is showing; absent while nothing is selected. */
  readonly app: AppInfo | undefined
  /** Its registration (the display name and the settings half). */
  readonly view: ApplicationView | undefined
  /** The applications the quick switcher offers (those with a page). */
  readonly switchable: readonly AppInfo[]
  /** The registrations, for the switcher's display names. */
  readonly views: ReadonlyMap<string, ApplicationView>
  /** Whether the area is narrow (the drawer opener takes the first slot). */
  readonly narrow: boolean
  /** Whether the wide navigation column is expanded (its own fold control lives in the column, so a FOLDED column needs this way back). */
  readonly navExpanded: boolean
  /** Confirmations waiting — shown on the management entry. */
  readonly pending: number
  /** Open the narrow navigation drawer. */
  readonly onOpenDrawer: () => void
  /** Fold or unfold the wide navigation column. */
  readonly onToggleNav: () => void
  readonly onSwitch: (appId: string) => void
  /** Open the management dialog for one application at one tab. */
  readonly onManage: (appId: string, tab: ManageTab) => void
  /** Open the right-Sidebar conversation without leaving the application page. */
  readonly onChat?: () => void
  /** Open the development-session creation dialog. */
  readonly onDevelop?: (appId: string) => void
  /** Whether a cross-application origin is on the stack. */
  readonly canRecordBack?: boolean
  /** Return to the cross-application origin, when one exists. */
  readonly onRecordBack?: () => void
  /** Leave the application area for the conversation. */
  readonly onBack: () => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the application header.
 * @param props - the current application, the switchable rows and the actions.
 * @returns the header element.
 */
export function AppHeader(props: AppHeaderProps): ReactNode {
  const { app, view, switchable, views, narrow, navExpanded, pending, onOpenDrawer, onToggleNav, onSwitch, onManage, onChat, onDevelop, onBack, canRecordBack, onRecordBack, t } = props
  const [switchOpen, setSwitchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const switchItems: readonly MenuEntry[] = switchable.map(candidate => ({
    id: candidate.id,
    label: displayName(candidate, views.get(candidate.id)),
    // The same glyph the navigation shows: one application, one face.
    icon: <AppIcon view={views.get(candidate.id)} size={16} />,
  }))

  const manageItems: readonly MenuEntry[] = app === undefined ? [] : [
    ...(hasSettings(view) ? [{ id: 'settings', label: t('menu.settings') }] : []),
    { id: 'permissions', label: t('menu.permissions') },
    { id: 'history', label: t('menu.history') },
    { id: 'info', label: t('menu.info') },
    ...(onDevelop === undefined ? [] : [{ id: 'develop', label: t('menu.develop') }]),
    { type: 'separator', id: 'sep' },
    { id: 'debug', label: t('menu.debug') },
  ]

  const name = app === undefined ? t('panel') : displayName(app, view)

  return (
    <header className={css.header} data-app-header>
      {/* One way into the navigation: the drawer's opener while narrow, and —
          because the folded COLUMN hides its own control with itself — the
          unfold control while a wide column is folded. */}
      {(narrow || !navExpanded) && (
        <button
          type="button"
          className={css.headerIconButton}
          data-app-drawer-open
          data-nav-open={narrow ? 'drawer' : 'column'}
          aria-label={t('nav.expand')}
          onClick={narrow ? onOpenDrawer : onToggleNav}
        >
          <IconPanelLeftOutlineRegular size={16} />
        </button>
      )}
      {canRecordBack === true && (
        <button
          type="button"
          className={css.headerIconButton}
          data-app-record-back
          aria-label={t('nav.backRecord')}
          title={t('nav.backRecord')}
          onClick={onRecordBack}
        >
          ←
        </button>
      )}
      {narrow
        ? (
          <Tooltip label={t('menu.back')} delayMs={500}>
            <button
              type="button"
              className={css.headerIconButton}
              data-app-back
              aria-label={t('menu.back')}
              onClick={onBack}
            >
              <IconChevronLeftOutlineRegular size={16} />
            </button>
          </Tooltip>
        )
        : <Button size="sm" variant="ghost" data-app-back onClick={onBack}>{t('menu.back')}</Button>}
      <Menu
        open={switchOpen}
        anchor={(
          <button
            type="button"
            className={css.switcher}
            data-app-switcher
            aria-haspopup="menu"
            aria-expanded={switchOpen}
            onClick={() => { setSwitchOpen(open => !open) }}
          >
            {app !== undefined && <AppIcon view={view} size={16} />}
            <span className={css.switcherName}>{name}</span>
            <IconChevronDownOutlineRegular size={14} />
          </button>
        )}
        items={switchItems}
        selectedId={app?.id}
        onSelect={(id) => { setSwitchOpen(false); onSwitch(id) }}
        onClose={() => { setSwitchOpen(false) }}
        autoFocus
      />
      <div className={css.headerSpacer} />
      {/* Citing the page in the conversation is the header's one text action on
          a wide strip; on a narrow one it becomes the same action as an icon
          button with its accessible name — a labelled button whose label
          cannot fit is what pushed the header out of its column. */}
      {app !== undefined && view?.Component !== undefined && onChat !== undefined && (
        narrow
          ? (
            <Tooltip label={t('header.chat')} delayMs={500}>
              <button
                type="button"
                className={css.headerIconButton}
                data-app-chat
                aria-label={t('header.chat')}
                onClick={onChat}
              >
                <IconNewChatOutlineRegular size={16} />
              </button>
            </Tooltip>
          )
          : <Button size="sm" data-app-chat onClick={onChat}>{t('header.chat')}</Button>
      )}
      {app !== undefined && (
        <Menu
          open={menuOpen}
          anchor={(
            <button
              type="button"
              className={css.headerIconButton}
              data-app-menu
              aria-label={pending > 0 ? `${t('header.manage')} (${String(pending)})` : t('header.manage')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(open => !open) }}
            >
              <IconEllipsisOutlineRegular size={16} />
              {pending > 0 && <span className={css.headerCount} data-app-pending-count>{pending}</span>}
            </button>
          )}
          items={manageItems}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'develop') { onDevelop?.(app!.id); return }
            // The menu only exists beside a selected application (the JSX
            // above), so this handler always has one to manage.
            onManage(app!.id, id === 'debug' ? 'developer' : id as ManageTab)
          }}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          autoFocus
        />
      )}
    </header>
  )
}
