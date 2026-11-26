/**
 * The application list: every page application in one popover, with a pin
 * toggle per row. The tab strip is the human's working set; this list is the
 * complete switchboard and the only place that adds a tab. Pinning does not
 * close the panel, so several applications can be fixed in one visit (the
 * Chrome extensions model), and the pinned order stays the tab strip's drag
 * order — this list keeps a stable host order instead of jumping rows.
 * @module @matrix1001/dsh-application-harness-client-applications/client/AppMenu
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconAppsAddOutlineRegular, IconCheckOutlineRegular, IconPinFillRegular, IconPinOutlineRegular,
  IconSettingsOutlineRegular, Tooltip,
} from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView } from './contract.ts'
import { AppIcon } from './AppIcon.tsx'
import { displayName, statusView } from './model.ts'
import css from './ApplicationsArea.module.css'

/** The panel's stable DOM id (the trigger's aria-controls). */
export const APP_MENU_PANEL_ID = 'app-nav-apps-panel'

/** What the application list renders from and the actions it offers. */
export interface AppMenuProps {
  /** Every page application, in the host's order (stable across pin changes). */
  readonly apps: readonly AppInfo[]
  /** The applications fixed to the tab strip. */
  readonly pinnedIds: readonly string[]
  /** The application whose page the area shows. */
  readonly activeId: string | undefined
  /** The registrations, for display names and icons. */
  readonly views: ReadonlyMap<string, ApplicationView>
  /** Applications whose first-run capability card is still unanswered. */
  readonly pendingApproval?: ReadonlySet<string> | undefined
  /** Whether the application rows are still being read. */
  readonly loading: boolean
  /** Switch the page to one application (the panel closes). */
  readonly onSwitch: (appId: string) => void
  /** Fix one application to the tab strip (append). */
  readonly onPin: (appId: string) => void
  /** Remove one application from the tab strip. */
  readonly onUnpin: (appId: string) => void
  /** Open the management surface at its list. */
  readonly onManageList: () => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the application trigger and its complete application list.
 * @param props - the rows, the pin state and the actions.
 * @returns the trigger plus the panel while it is open.
 */
export function AppMenu(props: AppMenuProps): ReactNode {
  const { apps, pinnedIds, activeId, views, pendingApproval, loading, onSwitch, onPin, onUnpin, onManageList, t } = props
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const firstRow = useRef<HTMLButtonElement>(null)
  const pinned = new Set(pinnedIds)

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    // Focus before the switch/management navigation starts: a management page
    // owns its own initial focus, and a later focus call here would steal it.
    if (returnFocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (wrap.current?.contains(event.target as Node) === true) return
      close(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // A list is opened for a purpose: put the keyboard on its first action.
    // With no page application the panel itself is the only focus target.
    if (firstRow.current !== null) firstRow.current.focus()
    else panel.current?.focus()
  }, [open, apps.length])

  return (
    <div className={css.appsWrap} ref={wrap}>
      <Tooltip label={t('nav.apps')} delayMs={500}>
        <Button
          ref={trigger}
          size="sm"
          variant="ghost"
          className={css.headerIconButton}
          data-app-all
          aria-label={t('nav.apps')}
          aria-haspopup="dialog"
          aria-controls={APP_MENU_PANEL_ID}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconAppsAddOutlineRegular size={16} />
        </Button>
      </Tooltip>
      {open && (
        <div
          id={APP_MENU_PANEL_ID}
          className={css.appsPanel}
          data-app-apps-panel
          role="dialog"
          aria-labelledby={`${APP_MENU_PANEL_ID}-title`}
          tabIndex={-1}
          ref={panel}
        >
          <p className={css.appsPanelTitle} id={`${APP_MENU_PANEL_ID}-title`}>{t('nav.apps')}</p>
          {loading
            ? <p className={css.appsEmpty} data-app-apps-empty>{t('loading')}</p>
            : apps.length === 0
              ? <p className={css.appsEmpty} data-app-apps-empty>{t('nav.noApps')}</p>
              : (
                <ul className={css.appsList}>
                  {apps.map((candidate, index) => {
                    const name = displayName(candidate, views.get(candidate.id))
                    const status = statusView(candidate, t, pendingApproval?.has(candidate.id) === true)
                    const isPinned = pinned.has(candidate.id)
                    const current = candidate.id === activeId
                    return (
                      <li key={candidate.id} className={css.appsRow} data-current={current ? 'true' : undefined}>
                        <button
                          type="button"
                          className={css.appsMain}
                          data-app-apps-row={candidate.id}
                          aria-current={current ? 'page' : undefined}
                          ref={index === 0 ? firstRow : undefined}
                          onClick={() => {
                            close(true)
                            if (!current) onSwitch(candidate.id)
                          }}
                        >
                          <AppIcon view={views.get(candidate.id)} size={16} />
                          <span className={css.appsName}>{name}</span>
                          {status.label !== undefined && (
                            <>
                              <span className={css.appDot} data-tone={status.tone} aria-hidden="true" />
                              <span className={css.srOnly}>{status.label}</span>
                            </>
                          )}
                          {current && <IconCheckOutlineRegular size={14} className={css.appsCheck} />}
                        </button>
                        <button
                          type="button"
                          className={css.appsPin}
                          data-app-pin-toggle={candidate.id}
                          data-app-pinned={isPinned ? 'true' : 'false'}
                          aria-label={t('nav.pinToggle', { name })}
                          aria-pressed={isPinned}
                          title={isPinned ? t('nav.unpinName', { name }) : t('nav.pinName', { name })}
                          onClick={() => { if (isPinned) onUnpin(candidate.id); else onPin(candidate.id) }}
                        >
                          {isPinned
                            ? <IconPinFillRegular size={14} />
                            : <IconPinOutlineRegular size={14} />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          <div className={css.appsFooter}>
            <button
              type="button"
              className={css.appsManage}
              data-app-manage-list
              onClick={() => { close(true); onManageList() }}
            >
              <IconSettingsOutlineRegular size={14} />
              <span>{t('nav.manage')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
