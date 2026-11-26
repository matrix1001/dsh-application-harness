/**
 * The business surface: the application's own page, and around it only the
 * states a user must be told about — the connection is down, the list is still
 * being read, no application runs, this one has no page, it is not available
 * right now, and a failure the transport itself reported. Status is never
 * invented here: every line comes from the shell's own state (the runtime's
 * rows, the transport's failures), and a state that has an action (retry,
 * manage, debug) offers the real one.
 *
 * What deliberately does NOT live here any more: the settled outcome of calls
 * and the raw JSON that came with it. A business page reports its own results
 * where the human acted (the workbook's form, the info-hub's failure line), and
 * a successful read is not an announcement. The outcome renderer stays for the
 * explicit debug surface (the management page's developer area), which is the
 * one place whose whole purpose is looking at raw answers.
 * @module @matrix1001/dsh-application-harness-client-applications/client/AppSurface
 */
import { useRef, type ReactNode } from 'react'
import { Button } from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView, ApplicationViewProps } from './contract.ts'
import type { ApplicationsState } from './shell.ts'
import type { ViewportReport } from './viewport.ts'
import { useSurfaceScroll } from './surface-scroll.ts'
import { STATUS_KEYS, statusOf } from './model.ts'
import { PermissionOnboarding } from './PermissionOnboarding.tsx'
import css from './ApplicationsArea.module.css'

/** What the surface renders from. */
export interface AppSurfaceProps {
  /** The shell's live state (rows, outcomes, errors, watch health). */
  readonly state: ApplicationsState
  /**
   * Re-read the page: the framework re-mounts the application on a fresh key,
   * so the page's own mount read runs again — the safe, read-only path. Never
   * a replay of a failed write.
   */
  readonly onRetryRead: () => void
  /** Open one application's permission page (the way out of a refusal). */
  readonly onManagePermissions: (appId: string) => void
  /** Approve the first-run card's missing platform capabilities and record it. */
  readonly onAllowOnboarding: (appId: string, capabilities: readonly string[], fingerprint: string) => Promise<boolean>
  /** Record the first-run card's "later" answer. */
  readonly onLaterOnboarding: (appId: string, fingerprint: string) => Promise<boolean>
  /** The management page is showing above the surface; do not also trap focus in the onboarding Modal. */
  readonly onboardingSuppressed?: boolean
  /** The application whose page is showing. */
  readonly app: AppInfo | undefined
  /** Its registration. */
  readonly view: ApplicationView | undefined
  /** What the page on screen reported about its own view (its key and readiness). */
  readonly viewport: ViewportReport | undefined
  /** Whether there is any application with a page to select (drives the hint, not the state). */
  readonly anyPage: boolean
  /**
   * The re-read generation: bumping it re-mounts the page, which re-runs that
   * page's own mount read (and only that — a failed write is never replayed).
   */
  readonly readEpoch: number
  /** The shell's props composer for one application's page. */
  readonly viewProps: (appId: string) => ApplicationViewProps
  /** Re-read the rows (the retry action of every read failure here). */
  readonly onRetry: () => void
  /** Open the management surface (list). */
  readonly onManage: () => void
  /** Open the debug call surface of the CURRENT application. */
  readonly onDebug: (appId: string) => void
    readonly t: TranslateNS<'applications'>
}

/**
 * Render the business surface.
 * @param props - the state, the selected application and the actions.
 * @returns the surface element.
 */
export function AppSurface(props: AppSurfaceProps): ReactNode {
  const { state, app, view, viewport, anyPage, readEpoch, viewProps, onRetry, onRetryRead, onManage, onManagePermissions, onAllowOnboarding, onLaterOnboarding, onDebug, onboardingSuppressed = false, t } = props
  const apps = state.apps
  // The refusal still has ONE job here: the onboarding card's own approval path
  // re-runs the page's read when it clears a capability refusal. The notice
  // itself lives in the header now (the shell status), never as a row here.
  const refusal = app === undefined ? undefined : state.refusals.get(app.id)

  // How the page divides up the height the area gives it (contract.ts,
  // `contentLayout`): a `flow` page — the default, whether the field is absent
  // or spelled out — leaves the outer `.surface` the scroller, while a `fill`
  // page is handed the height left beside the notices and scrolls itself.
  const layout = view?.contentLayout ?? 'flow'

  // The outer scroll is the FRAMEWORK's for a `flow` page: the reader gets
  // their position back per application and per view, and a page only says
  // which view it draws and when that view is ready for it (see
  // `surface-scroll.ts`). A `fill` page keeps its own position, so the outer
  // memory is not consulted for it at all — the key's absence IS the switch.
  const surface = useRef<HTMLDivElement>(null)
  useSurfaceScroll(surface, {
    key: layout === 'fill' || app === undefined || viewport === undefined
      ? undefined
      : `${app.id}:${viewport.key}`,
    ready: viewport?.ready === true,
  })

  return (
    <div className={css.surface} ref={surface} data-app-surface>
      {/* The column the page is handed: a `fill` page gets the surface's height,
          a `flow` page stays an ordinary block the outer surface scrolls. */}
      <div
        className={layout === 'fill' ? `${css.content} ${css.contentFill ?? ''}` : css.content}
        data-app-content
      >
        {apps === undefined
          ? <p className={css.hint} data-app-loading>{t('loading')}</p>
          : apps.length === 0
            ? (
              <div className={css.state} data-app-state="empty">
                <p>{t('state.empty')}</p>
                <Button size="sm" onClick={onManage}>{t('nav.manage')}</Button>
              </div>
            )
            : app === undefined
              ? (
                <div className={css.state} data-app-state={anyPage ? 'none-selected' : 'no-page'}>
                  <p>{anyPage ? t('state.select') : t('state.anyPage')}</p>
                  {!anyPage && <Button size="sm" onClick={onManage}>{t('nav.manage')}</Button>}
                </div>
              )
              : (
                <>
                  {statusOf(app) !== 'available' && (
                    <div className={css.state} data-app-state={statusOf(app)} data-status={statusOf(app)}>
                      <p>{app.reason === 'platform.health-failed' ? t('status.health-failed') : t(STATUS_KEYS[statusOf(app)])}</p>
                      {app.detail !== undefined && <p className={css.stateReason} role="alert">{app.detail}</p>}
                      <Button size="sm" onClick={onRetry}>{t('state.retry')}</Button>
                    </div>
                  )}
                  {view?.Component !== undefined
                    ? (
                      <>
                        {!onboardingSuppressed && (
                        <PermissionOnboarding
                          app={app}
                          view={view}
                          state={state}
                          onAllow={async (appId, capabilities, fingerprint) => {
                            const allowed = await onAllowOnboarding(appId, capabilities, fingerprint)
                            // The card's approval is the one write that clears a
                            // capability refusal; re-run the page's READ, never a
                            // failed write.
                            if (allowed && refusal === 'capability-not-approved') onRetryRead()
                            return allowed
                          }}
                          onLater={onLaterOnboarding}
                          onManage={onManagePermissions}
                          t={t}
                        />
                        )}
                        <div className={css.viewHost} data-app-view-host data-readonly={statusOf(app) !== 'available' ? 'true' : undefined} aria-disabled={statusOf(app) !== 'available'}>
                          <view.Component key={`${app.id}:${readEpoch}`} {...viewProps(app.id)} />
                        </div>
                      </>
                    )
                    : (
                      <div className={css.state} data-app-state="no-view">
                        <p>{t('state.noView')}</p>
                        <span className={css.stateActions}>
                          <Button size="sm" onClick={() => { onDebug(app.id) }}>{t('menu.debug')}</Button>
                          <Button size="sm" onClick={onManage}>{t('nav.manage')}</Button>
                        </span>
                      </div>
                    )}
                </>
              )}
      </div>
    </div>
  )
}
