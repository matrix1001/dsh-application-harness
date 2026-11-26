/**
 * The application area's Session dock, following the DSH right-Sidebar model:
 * the right column has NO header of its own. Its tab strip lives in the shared
 * 48px top row, to the right of a vertical divider; the content column starts
 * below that row. The tab chip, add control, panel controls and tab order copy
 * the platform's right-Sidebar strip.
 *
 * The area owns which Session is active and the Session references. This file
 * only renders the strip segment and the content column.
 * @module @matrix1001/dsh-application-harness-client-applications/client/ApplicationsDock
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular,
  IconNewChatOutlineRegular, IconPanelLeftOutlineRegular, IconPlusOutlineRegular, IconRightUpOutlineRegular,
  Menu, Tooltip, type MenuEntry,
} from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ApplicationsArea.module.css'

/** The status dot one Session tab shows. */
export interface DockTabStatus {
  readonly tone: 'running' | 'attention' | 'failed' | 'unread'
  readonly label: string
}

/** One Session tab the dock strip draws. */
export interface DockTabView {
  readonly id: string
  readonly kind: 'app-conversation' | 'development' | 'normal'
  readonly title: string
  readonly appName?: string
  readonly status?: DockTabStatus
}

/** The props of the strip segment that sits in the shared top row. */
export interface ApplicationsDockHeaderProps {
  readonly tabs: readonly DockTabView[]
  /** Development tabs whose Session belongs to another application; folded. */
  readonly otherTabs: readonly DockTabView[]
  readonly activeId: string
  /** Sessions that were closed and can be reopened from the add menu. */
  readonly openableTabs: readonly DockTabView[]
  readonly onOpenTab: (id: string) => void
  readonly otherOpen: boolean
  readonly normalChoices: readonly { readonly sessionId: string; readonly title?: string }[]
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onCloseOthers: (keepId: string) => void
  readonly onCloseRight: (fromId: string) => void
  readonly onToggleOther: () => void
  readonly onCollapse: () => void
  readonly onNewConversation: () => void
  readonly onNewDevelopment: () => void
  readonly onOpenNormal: (sessionId: string) => void
  readonly onOpenInSession: (id: string) => void
  readonly narrow: boolean
  readonly onBack: () => void
  readonly t: TranslateNS<'applications'>
}

/** The icon marking a Session kind. */
function TabIcon({ kind }: { readonly kind: DockTabView['kind'] }): ReactNode {
  return kind === 'development'
    ? <IconCodeOutlineRegular size={14} />
    : <IconNewChatOutlineRegular size={14} />
}

/**
 * Render the dock's strip segment (the right part of the shared top row).
 * @param props - the tabs, the active Session, the controls and the locale seat.
 * @returns the strip.
 */
export function ApplicationsDockHeader(props: ApplicationsDockHeaderProps): ReactNode {
  const {
    tabs, otherTabs, activeId, openableTabs, onOpenTab, otherOpen, normalChoices,
    onSelect, onClose, onCloseOthers, onCloseRight, onToggleOther, onCollapse,
    onNewConversation, onNewDevelopment, onOpenNormal, onOpenInSession, narrow, onBack, t,
  } = props
  const [newOpen, setNewOpen] = useState(false)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [tabMenu, setTabMenu] = useState<{ readonly id: string; readonly x: number; readonly y: number }>()
  const newButton = useRef<HTMLButtonElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const active = tabsRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs])

  useEffect(() => {
    if (!newOpen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setNewOpen(false)
      newButton.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [newOpen])

  const newItems: readonly MenuEntry[] = [
    { id: 'new-app', label: t('dock.newAppConversation') },
    { id: 'new-dev', label: t('dock.newDevelopment') },
    ...(openableTabs.length === 0 ? [] : [{ type: 'separator' as const, id: 'sep-open' }]),
    ...openableTabs.map(tab => ({ id: `open:${tab.id}`, label: `${t('dock.openSession')}: ${tab.title}` })),
    ...(normalChoices.length === 0 ? [] : [{ type: 'separator' as const, id: 'sep' }]),
    ...normalChoices.map(choice => ({
      id: `normal:${choice.sessionId}`,
      label: choice.title ?? t('dock.normalSession'),
    })),
  ]

  return (
    <div className={css.dockStrip} data-app-dock-strip>
      {narrow && (
        <Tooltip label={t('dock.back')} delayMs={500}>
          <button
            type="button"
            className={css.dockBack}
            data-app-dock-back
            aria-label={t('dock.back')}
            onClick={onBack}
          >
            <IconChevronLeftOutlineRegular size={16} />
          </button>
        </Tooltip>
      )}
      <div className={css.dockTabs} role="tablist" aria-label={t('dock.tabs')} ref={tabsRef}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const move = (event: React.KeyboardEvent, next: number): void => {
            /* v8 ignore next -- a tab exists for this handler to fire */
            if (tabs.length === 0) return
            event.preventDefault()
            const target = tabs[(next + tabs.length) % tabs.length]!
            onSelect(target.id)
            requestAnimationFrame(() => { tabRefs.current.get(target.id)?.focus() })
          }
          return (
            <div key={tab.id} className={css.dockTabWrap} data-active={active ? 'true' : undefined} data-kind={tab.kind}>
              <button
                type="button"
                role="tab"
                className={css.dockTab}
                data-app-dock-tab={tab.id}
                data-kind={tab.kind}
                data-active={active ? 'true' : undefined}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={[tab.appName, tab.title].filter(Boolean).join(' · ')}
                ref={(node) => { if (node === null) tabRefs.current.delete(tab.id); else tabRefs.current.set(tab.id, node) }}
                onClick={() => { onSelect(tab.id) }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') move(event, index + 1)
                  else if (event.key === 'ArrowLeft') move(event, index - 1)
                  else if (event.key === 'Home') move(event, 0)
                  else if (event.key === 'End') move(event, tabs.length - 1)
                  else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onClose(tab.id) }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setTabMenu({ id: tab.id, x: event.clientX, y: event.clientY })
                }}
              >
                <span className={css.dockTabIcon}>
                  <TabIcon kind={tab.kind} />
                  {tab.status === undefined ? null : (
                    <span
                      className={css.dockStatus}
                      data-tone={tab.status.tone}
                      role="img"
                      aria-label={tab.status.label}
                      title={tab.status.label}
                    />
                  )}
                </span>
                <span className={css.dockTabTitle}>{(tab.appName === undefined ? '' : `${tab.appName} · `)}{tab.title}</span>
              </button>
              <button
                type="button"
                className={css.dockTabClose}
                data-app-dock-close={tab.id}
                aria-label={t('dock.closeTab', { name: tab.title })}
                tabIndex={-1}
                onClick={() => { onClose(tab.id) }}
              >×</button>
            </div>
          )
        })}
        {otherTabs.length > 0 && (
          <div className={css.dockOther} data-app-dock-other-group>
            <button
              type="button"
              className={css.dockOtherButton}
              data-app-dock-other-toggle
              aria-expanded={otherOpen}
              onClick={onToggleOther}
            >
              {otherOpen ? <IconChevronDownOutlineRegular size={13} /> : <IconChevronRightOutlineRegular size={13} />}
              <span>{t('dock.otherDev', { count: String(otherTabs.length) })}</span>
            </button>
            {otherOpen && (
              <div className={css.dockOtherTabs}>
                {otherTabs.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    className={css.dockOtherTab}
                    data-app-dock-tab={tab.id}
                    data-kind={tab.kind}
                    aria-selected={tab.id === activeId}
                    title={[tab.appName, tab.title].filter(Boolean).join(' · ')}
                    onClick={() => { onSelect(tab.id) }}
                  >
                    <TabIcon kind={tab.kind} />
                    <span>{tab.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className={css.dockNew}>
        <Menu
          open={newOpen}
          anchor={(
            <Tooltip label={t('dock.new')} delayMs={500}>
              <button
                ref={newButton}
                type="button"
                className={css.dockControl}
                data-app-dock-new
                aria-label={t('dock.new')}
                aria-haspopup="menu"
                aria-expanded={newOpen}
                onClick={() => { setNewOpen(open => !open) }}
              >
                <IconPlusOutlineRegular size={15} />
              </button>
            </Tooltip>
          )}
          items={newItems}
          onSelect={(id) => {
            setNewOpen(false)
            newButton.current?.focus()
            if (id === 'new-app') { onNewConversation(); return }
            if (id === 'new-dev') { onNewDevelopment(); return }
            if (id.startsWith('open:')) { onOpenTab(id.slice('open:'.length)); return }
            if (id.startsWith('normal:')) onOpenNormal(id.slice('normal:'.length))
          }}
          onClose={() => { setNewOpen(false) }}
          align="end"
          autoFocus
        />
      </div>
      {tabMenu === undefined ? null : (
        <>
          <Menu
            open
            anchor={<span style={{ position: 'fixed', left: tabMenu.x, top: tabMenu.y, width: 1, height: 1 }} />}
            items={[
              { id: 'open-session', label: t('dock.openInSession') },
              { id: 'close-tab', label: t('dock.closeTab', { name: tabs.find(tab => tab.id === tabMenu.id)?.title ?? '' }) },
              { type: 'separator', id: 'sep-tabs' },
              { id: 'close-others', label: t('dock.closeOthers') },
              { id: 'close-right', label: t('dock.closeRight') },
            ]}
            onSelect={(id) => {
              const target = tabMenu.id
              setTabMenu(undefined)
              if (id === 'open-session') { onOpenInSession(target); return }
              if (id === 'close-others') { onCloseOthers(target); return }
              if (id === 'close-right') { onCloseRight(target); return }
              onClose(target)
            }}
            onClose={() => { setTabMenu(undefined) }}
            align="start"
            autoFocus
          />
        </>
      )}
      <div className={css.dockControls}>
        <Tooltip label={t('dock.openInSession')} delayMs={500}>
          <button
            type="button"
            className={css.dockControl}
            data-app-dock-open-session
            aria-label={t('dock.openInSession')}
            disabled={activeId === ''}
            onClick={() => { onOpenInSession(activeId) }}
          >
            <IconRightUpOutlineRegular size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t('dock.collapseAria')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.dockControl}
            data-app-dock-collapse
            data-app-conversation-close
            data-sidebar-right-toggle
            aria-label={t('dock.collapseAria')}
            onClick={onCollapse}
          >
            <IconPanelLeftOutlineRegular size={16} className={css.dockCollapseIcon} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

/** Props of the dock's page-context bar. */
export interface DockContextBarProps {
  /** The page the dock's application page is showing, when one is open. */
  readonly page: { readonly label: string } | undefined
  /** Whether the shown Session attaches that page to its next message. */
  readonly enabled: boolean
  /** Switch the attachment for the shown Session. */
  readonly onToggle: () => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the dock's page-context bar: what the next message will carry, and
 * the one control that removes or restores it.
 * @param props - the current page, the switch and the dictionary.
 * @returns the bar.
 */
export function DockContextBar({ page, enabled, onToggle, t }: DockContextBarProps): ReactNode {
  const text = !enabled
    ? t('conversation.contextOff')
    : page === undefined ? t('conversation.noPage') : t('conversation.contextChip', { label: page.label })
  return (
    <div className={css.contextBar} data-app-context-bar data-enabled={enabled ? 'true' : 'false'}>
      <span className={css.contextBarLabel}>{text}</span>
      {enabled && page !== undefined && (
        <button
          type="button"
          className={css.contextBarAction}
          data-app-context-remove
          aria-label={t('conversation.contextOnTitle', { label: page.label })}
          onClick={onToggle}
        >×</button>
      )}
      {!enabled && (
        <button type="button" className={css.contextBarAction} data-app-context-restore onClick={onToggle}>
          {t('conversation.contextRestore')}
        </button>
      )}
    </div>
  )
}

/** The props of the content column below the shared row. */
export interface ApplicationsDockBodyProps {
  readonly width: number
  readonly narrow: boolean
  readonly t: TranslateNS<'applications'>
  readonly children: ReactNode
}

/**
 * Render the dock's content column. No strip, no title row: the strip is in the
 * shared top row.
 * @param props - presentation state and the active Session content.
 * @returns the content column.
 */
export function ApplicationsDockBody({ width, narrow, t, children }: ApplicationsDockBodyProps): ReactNode {
  return (
    <aside
      className={`${css.dockBodyColumn}${narrow ? ` ${css.dockBodyNarrow}` : ''}`}
      style={narrow ? undefined : { width: `${width}px` }}
      data-app-dock-body
      data-app-conversation-pane
      aria-label={t('conversation.title')}
    >
      {children}
    </aside>
  )
}
