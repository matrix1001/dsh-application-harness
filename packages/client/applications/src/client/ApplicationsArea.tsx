/**
 * The application area: the whole center column while the applications panel
 * is selected. Three pieces, and nothing else — the navigation (which
 * application), the header (which application is this, and the actions that
 * belong to the work), the business surface (the application's own page), and
 * the management dialog when it is open.
 *
 * The area renders; the shell (`shell.ts`) owns the wire and the state
 * machine. Everything here arrives through the injected `hooks` compartment
 * and every action is a callback from the inject face, so this component can
 * be exercised with plain observables and no Remote.
 * @module @matrix1001/dsh-application-harness-client-applications/client/ApplicationsArea
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { Caller, ConfirmationDecision, OperationPolicy } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type {
  ApplicationSettingsProps, ApplicationView, ApplicationViewProps, ManageRequest, PageContext,
} from './contract.ts'
import type { AppNavigation as AppNavigationService } from './navigation.ts'
import type { ApplicationsState } from './shell.ts'
import type { ApplicationPreferences } from './preferences.ts'
import type { EntryRequest } from './entry.ts'
import type { ViewportReport } from './viewport.ts'
import { AppHeader } from './AppHeader.tsx'
import { AppNavigation } from './AppNavigation.tsx'
import { displayName, onboardingPending, orderApplications } from './model.ts'
import { AppSurface } from './AppSurface.tsx'
import { DevelopmentDialog } from './DevelopmentDialog.tsx'
import { ManagementDialog, defaultTab } from './ManagementDialog.tsx'
import type { ManageScrollMemory } from './manage.ts'
import type { ConversationSession } from './conversation-session.ts'
import { useNarrow } from './narrow.ts'
import css from './ApplicationsArea.module.css'


/** One floating shell status (never a row in the page). */
interface ShellNotice {
  readonly id: string
  readonly tone: 'error' | 'warning' | 'info'
  readonly text: string
  readonly actions?: readonly {
    readonly label: string
    readonly onClick: () => void
    readonly anchor?: Readonly<Record<string, string>> | undefined
  }[]
  readonly anchor?: Readonly<Record<string, string>> | undefined
}

/** The area's injected business face; its `hooks` compartment becomes the `use<Name>` seats. */
export interface ApplicationsAreaInjected {
  /** The shell's live state, the view registry, the layout preferences, the viewport reports and the entry requests. */
  readonly hooks: {
    readonly applications: HostObservable<ApplicationsState>
    readonly views: HostObservable<ReadonlyMap<string, ApplicationView>>
    readonly preferences: HostObservable<ApplicationPreferences>
    readonly viewport: HostObservable<ViewportReport | undefined>
    readonly entry: HostObservable<EntryRequest | undefined>
    /** What the current application page reports (the pane's current-page chip). */
    readonly pageContext: HostObservable<PageContext | undefined>
    /** What the management dialog shows right now (the framework instance owns it). */
    readonly manage: HostObservable<ManageRequest | undefined>
  }
  /** Cross-application record navigation, when the shell mounted it. */
  readonly navigation?: AppNavigationService
  /** Where the dialog remembers its scroll positions (the framework instance owns it). */
  readonly manageScroll: ManageScrollMemory
  /** Show the management dialog (the list, or one application's detail at a tab). */
  readonly openManage: (request: ManageRequest) => void
  /**
   * Close it. The area calls this with itself when it leaves: coming back to
   * the applications panel starts at the business page, and the remembered
   * positions serve the next EXPLICIT open.
   */
  readonly closeManage: () => void
  /**
   * Take the pending entry request (one-shot): the human activated the
   * applications entry and the navigation has to answer for it.
   */
  readonly consumeEntry: () => EntryRequest | undefined
  /** Select the application whose page the area shows (undefined clears the selection). */
  readonly select: (appId: string | undefined) => void
  /** Re-read the application rows. */
  readonly refresh: () => void
  /** Remember the wide navigation's folded state. */
  readonly setNavExpanded: (expanded: boolean) => void
  /** Remember the human's own order of the page applications. */
  readonly setNavOrder: (order: readonly string[]) => void
  /** Leave the area: the center column returns to the conversation. */
  readonly close: () => void
  /**
   * Cite the application page the area is showing in the conversation: the
   * reference is captured now and the center column returns to the conversation,
   * where the composer offers it as the `@page` chip.
   */
  /** Open (or first-use set up) the application area's dedicated conversation. */
  readonly openAppConversation: () => Promise<ConversationSession | undefined>
  /** Create the dedicated Workspace and its first conversation at the chosen path. */
  readonly setupAppConversation: (path: string) => Promise<ConversationSession>
  /** Create a development Session over a source workspace and bind it to the app. */
  readonly createDevelopmentSession: (appId: string, path: string) => Promise<string>
  /** Show a Session in the platform's main area, when that face exists. */
  readonly openSession: (sessionId: string) => void
  /** Open the platform directory picker for the dedicated Workspace folder. */
  readonly pickAppConversationFolder?: (() => Promise<string | undefined>) | undefined
  /** Attach or detach the current page pointer from the application conversation. */
  readonly setAppConversationContextEnabled: (enabled: boolean) => Promise<void>
  readonly loadTasks: () => void
  /** The props the shell hands one application's registered page (the call pair included). */
  readonly viewProps: (appId: string) => ApplicationViewProps
  /**
   * The page of one application is gone (the human left it, or a re-read
   * re-keyed it): drop that application's progress take-overs, so the ordinary
   * rows come back for the calls still running.
   */
  readonly releaseClaims: (appId: string) => void
  /** The props one application's settings page is rendered with. */
  readonly settingsProps: (appId: string) => ApplicationSettingsProps
  /** Read the call records; with an application, the ones TARGETING it. */
  readonly loadHistory: (appId?: string) => void
  /** Read one application's unified-store facts for the info tab's data section. */
  readonly loadDataInfo: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataInfo>
  readonly restorePreview: (appId: string, backupPath: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataRestorePreview>
  readonly restoreData: (appId: string, backupPath: string, previewFingerprint?: string, planId?: string, requestId?: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataRestoreResult>
  /** Export one application's unified-store namespace (JSON). */
  readonly exportData: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataExport>
  /** Validate one application JSON import before any write. */
  readonly previewDataImport: (appId: string, json: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataImportPreview>
  /** Import one application JSON after a pre-import backup. */
  readonly importData: (appId: string, json: string, planId?: string, requestId?: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataImportResult>
  /** Retry the reload an import could not complete. */
  readonly reloadImportedData?: (appId: string) => Promise<void>
  /** Delete old pre-import snapshots beyond the newest keep (explicit action). */
  readonly pruneBackups?: (keep: number) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataPruneResult>
  /** Read the grants in effect. */
  readonly loadGrants: () => void
  /** Read the user's operation policies. */
  readonly loadPolicies: () => void
  /** Set one operation's user policy. */
  readonly setPolicy: (appId: string, op: string, policy: OperationPolicy) => Promise<boolean>
  /** Enable or disable one application. */
  readonly setActivation: (appId: string, activation: 'enabled' | 'disabled') => Promise<boolean>
  /** Set or clear one application's fixed model route. */
  readonly setAppModel: (appId: string, selection: { provider: string; model: string } | null) => Promise<boolean>
  /** Read the provider/model catalog for the model selector. */
  readonly loadModelCatalog: () => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelCatalog>
  /** Read one application's aggregated model usage. */
  readonly loadModelUsage: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelUsageSummary>
  /** Read the declared credentials' set status. */
  readonly loadCredentials: (appId: string) => Promise<readonly import('@matrix1001/dsh-application-harness-host-bridge/client').AppCredentialStatus[]>
  /** Set one declared credential. */
  readonly setCredential: (appId: string, name: string, value: string) => Promise<boolean>
  /** Delete one declared credential. */
  readonly deleteCredential: (appId: string, name: string) => Promise<boolean>
  /** Read one application's model limits. */
  readonly loadModelLimits: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelLimits>
  /** Set one application's model limits. */
  readonly setModelLimits: (appId: string, limits: import('@matrix1001/dsh-application-harness-host-bridge/client').ModelLimits) => Promise<boolean>
  /** Read the confirmations waiting for an answer. */
  readonly loadConfirmations: () => void
  /**
   * Approve capabilities for a caller (the needs lists' own action). Resolves
   * with whether the write really took effect: the row that asked owns its own
   * pending/error state, and the framework's error line is not a substitute for
   * knowing which row finished.
   */
  readonly grant: (caller: Caller, capabilities: readonly string[]) => Promise<boolean>
  /** Revoke a caller's capabilities (all of them, or one selector); resolves with the outcome. */
  readonly revoke: (caller: Caller, selector?: string) => Promise<boolean>
  /** Record that the first-run card was answered or postponed for one application. */
  readonly markOnboardingSeen: (appId: string, fingerprint: string) => Promise<boolean>
  /** Answer one pending confirmation; resolves with whether it was recorded. */
  readonly answer: (id: string, decision: ConfirmationDecision) => Promise<boolean>
  /** Withdraw a pending confirmation. */
  readonly cancelConfirmation: (id: string) => Promise<boolean>
}

/** The area's composed props: the keyed `main` runtime share, the inject face and the locale seat. */
export type ApplicationsAreaProps =
  PropsRuntime<'main'> & InjectFace<ApplicationsAreaInjected> & PropsLocale<'applications'>
  & PropsRenderSlots<'applications.conversation'>

/**
 * Render the application area.
 * @param props - the shell's state and actions (injected) plus the locale seat.
 * @returns the navigation, the header, the surface and (when open) the management dialog.
 */
export function ApplicationsArea(props: ApplicationsAreaProps): ReactNode {
  const { useApplications, useViews, usePreferences, useViewport: useViewportReport, useEntry, useManage, usePageContext, t } = props
  const state = useApplications(snapshot => snapshot)
  const views = useViews(snapshot => snapshot)
  const preferences = usePreferences(snapshot => snapshot)
  const viewport = useViewportReport(snapshot => snapshot)
  const entry = useEntry(snapshot => snapshot)
  const manage = useManage(snapshot => snapshot)
  const page = usePageContext(snapshot => snapshot)
  const [canRecordBack, setCanRecordBack] = useState(false)
  useEffect(() => {
    const navigation = props.navigation
    /* v8 ignore next -- the shell can render without navigation in isolated tests */
    if (navigation === undefined) return undefined
    setCanRecordBack(navigation.state.getSnapshot().canBack)
    return navigation.state.subscribe(() => { setCanRecordBack(navigation.state.getSnapshot().canBack) })
  }, [props.navigation])
  const root = useRef<HTMLDivElement>(null)
  const { narrow, measured } = useNarrow(root)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const selectApplication = (appId: string): void => {
    setDrawerOpen(false)
    props.select(appId)
  }
  // The page's re-read generation: the refusal notice's own retry bumps it and
  // the page mounts again, which is that page's ordinary read path.
  const [readEpoch, setReadEpoch] = useState(0)
  // The application area's dedicated conversation pane. It is closed until the
  // header is clicked; opening it remembers (or first-use creates) the area's
  // own Session, bound below through the standard SessionProvider seat.
  const [conversationOpen, setConversationOpen] = useState(false)
  const [developOpen, setDevelopOpen] = useState(false)
  const [conversation, setConversation] = useState<ConversationSession>()
  const conversationRef = useRef<ConversationSession>()
  const conversationPaneRef = useRef<HTMLElement>(null)
  // First-use setup: the pane has no target until a dedicated Workspace exists.
  // The dialog is explicit, and the pane stays closed until the human commits.
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupPath, setSetupPath] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState<string>()
  // The current page is attached by default; the chip is the visible switch.
  const [contextOn, setContextOn] = useState(true)
  useEffect(() => () => {
    conversationRef.current?.release()
    conversationRef.current = undefined
  }, [])

  // Leaving the area closes the dialog with it (the request lives in the
  // framework instance, which outlives this component): the human comes back
  // to the page they left, not to a modal they did not ask for again.
  const closeManage = props.closeManage
  useEffect(() => () => { closeManage() }, [closeManage])

  const apps = state.apps
  const active = apps?.find(app => app.id === state.activeAppId)
  const view = active === undefined ? undefined : views.get(active.id)
  const switchable = (apps ?? []).filter(app => views.get(app.id)?.Component !== undefined)
  // The order is the human's, not the click's: selecting an application never
  // moves it. The saved order is applied to the page applications only; new
  // ones land at the end and removed ids disappear.
  const ordered = useMemo(
    () => orderApplications(switchable, preferences.navOrder ?? []),
    [switchable, preferences.navOrder],
  )
  const anyPage = switchable.length > 0

  // The selection survives the rows and the registrations moving, and only a
  // row that is GONE costs it: an application whose page package has not
  // loaded yet keeps the human's place (its surface says so meanwhile), and a
  // removed application hands the area to the first one that still draws a page.
  useEffect(() => {
    if (apps === undefined) return
    if (apps.some(app => app.id === state.activeAppId)) return
    props.select(apps.find(app => views.get(app.id)?.Component !== undefined)?.id)
  }, [apps, views, state.activeAppId, props])

  // A drawer only exists while the area is narrow; turning wide closes it (and
  // never touches the wide column's own expanded preference).
  useEffect(() => { if (!narrow) setDrawerOpen(false) }, [narrow])

  // The human activated the applications entry (the sidebar's own row, the
  // window-chrome control): the area answers for it exactly once, as soon as
  // the width is known. Only a REPEAT activation toggles the navigation — a
  // first entry leaves it folded, because the sidebar already lists the
  // applications and an auto-expanded column duplicated that list (decision S1:
  // navigation folded by default, one click to unfold). Everything else (a
  // restored preference, a programmatic selection) leaves no request behind.
  useEffect(() => {
    if (!measured) return
    const request = props.consumeEntry()
    if (request === undefined || !request.toggle) return
    if (narrow) setDrawerOpen(!drawerOpen)
    else props.setNavExpanded(!preferences.navExpanded)
  }, [entry, measured, narrow, drawerOpen, preferences.navExpanded, props])

  // Closing the drawer: the modal layer restores focus to whoever opened it.
  // When that control is GONE (the window widened and took the drawer's button
  // with it), focus must land on something the human can still use — never the
  // document body (a dead end for keyboard and screen readers).
  const wasDrawerOpen = useRef(false)
  useEffect(() => {
    if (wasDrawerOpen.current && !drawerOpen) {
      const active = document.activeElement
      if (active === null || active === document.body || !(active as HTMLElement).isConnected) {
        root.current?.querySelector<HTMLElement>('[data-app-drawer-open], [data-app-switcher], [data-app-menu], [data-app-nav-toggle]')?.focus()
      }
    }
    wasDrawerOpen.current = drawerOpen
  }, [drawerOpen])

  const closeDrawer = (): void => { setDrawerOpen(false) }

  const closeConversation = (): void => {
    setConversationOpen(false)
    conversationRef.current?.release()
    conversationRef.current = undefined
    setConversation(undefined)
  }

  useModalLayer(conversationPaneRef, narrow && conversationOpen, closeConversation)

  const toggleConversation = async (): Promise<void> => {
    if (conversationOpen) {
      closeConversation()
      return
    }
    const next = await props.openAppConversation()
    if (next === undefined) {
      setSetupError(undefined)
      setSetupOpen(true)
      return
    }
    conversationRef.current = next
    setConversation(next)
    setConversationOpen(true)
  }

  const setupConversation = async (): Promise<void> => {
    if (setupBusy) return
    setSetupBusy(true)
    setSetupError(undefined)
    try {
      const next = await props.setupAppConversation(setupPath)
      conversationRef.current = next
      setConversation(next)
      setConversationOpen(true)
      setSetupOpen(false)
      setSetupPath('')
    } catch (cause) {
      setSetupError(t('conversation.setup.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setSetupBusy(false)
    }
  }

  // The pane passes its retained SessionReference through the standard
  // SessionProvider seat; the structural face is exactly what that seat uses.
  const SessionProvider = props.SessionProvider as unknown as (input: {
    readonly session?: ConversationSession | undefined
    readonly empty?: (() => ReactNode) | undefined
    readonly children: ReactNode
  }) => ReactNode

  // The drawer leaves in this same commit (its layer restores focus to the
  // opener first), so the management dialog opens onto a settled focus point
  // instead of racing the drawer's own cleanup.
  const openManage = (request: ManageRequest): void => {
    setDrawerOpen(false)
    props.openManage(request)
  }

  // The shell's statuses, floating over the content (never a row above it).
  const shellNotices: ShellNotice[] = []
  if (!state.watching) {
    shellNotices.push({
      id: 'connection', tone: 'error', text: t('conn.down'),
      anchor: { 'data-app-connection': '', 'data-app-connection-error': state.connectionError ?? '' },
      actions: [{ label: t('conn.retry'), onClick: () => { props.refresh() } }],
    })
  }
  if (state.error !== undefined) {
    shellNotices.push({
      id: 'error', tone: 'error', text: `${t('error.title')}: ${state.error}`,
      anchor: { 'data-app-error': '' },
    })
  }
  const refusal = active === undefined ? undefined : state.refusals.get(active.id)
  // While the first-run prompt is open it already explains this refusal and
  // offers the same actions; repeating it underneath would be the duplicate the
  // review found. An undeclared capability is not a grant anyone can write, so
  // that one stays visible.
  const onboardingOpen = active !== undefined && onboardingPending(active, state)
  if (refusal !== undefined && active !== undefined && !(onboardingOpen && refusal === 'capability-not-approved')) {
    shellNotices.push({
      id: 'refusal',
      tone: 'warning',
      text: t(refusal === 'capability-undeclared' ? 'refused.undeclared' : 'refused.notApproved'),
      anchor: { 'data-app-refusal': refusal },
      actions: [
        ...(refusal === 'capability-not-approved'
          ? [{
            label: t('refused.manage'),
            anchor: { 'data-app-refusal-manage': '' },
            onClick: () => { openManage({ appId: active.id, tab: 'permissions' }) },
          }]
          : []),
        {
          label: t('refused.retry'),
          anchor: { 'data-app-refusal-retry': '' },
          onClick: () => { setReadEpoch(epoch => epoch + 1) },
        },
      ],
    })
  }
  const claimed = active === undefined ? undefined : state.claims.get(active.id)
  const progress = active === undefined
    ? []
    : state.progress.filter(notice => notice.appId === active.id && claimed?.has(notice.callId) !== true)
  if (progress.length > 0) {
    shellNotices.push({
      id: 'progress', tone: 'info',
      text: progress.map(notice => `${notice.op}: ${notice.message}`).join(' · '),
      anchor: { 'data-app-progress': '' },
    })
  }

  return (
    <div className={css.area} ref={root} data-applications-area data-narrow={narrow ? 'true' : undefined}>
      {shellNotices.length > 0 && (
        <div className={css.shellNotices} data-shell-notices role="region" aria-label={t('notices.label')}>
          {shellNotices.slice(0, 2).map(notice => (
            <div
              key={notice.id}
              className={css.shellNotice}
              data-tone={notice.tone}
              role={notice.tone === 'error' ? 'alert' : 'status'}
              {...notice.anchor}
            >
              <span className={css.shellNoticeText}>{notice.text}</span>
              {(notice.actions ?? []).map(action => (
                <button
                  key={action.label}
                  type="button"
                  className={css.shellNoticeAction}
                  {...action.anchor}
                  onClick={action.onClick}
                >{action.label}</button>
              ))}
            </div>
          ))}
          {shellNotices.length > 2 && <p className={css.shellNoticeMore}>+{shellNotices.length - 2}</p>}
        </div>
      )}
      <AppNavigation
        apps={ordered}
        views={views}
        activeId={active?.id}
        loading={apps === undefined}
        pending={state.confirmations.length}
        expanded={preferences.navExpanded}
        narrow={narrow}
        drawerOpen={drawerOpen}
        onSelect={selectApplication}
        onReorder={order => { props.setNavOrder(order) }}
        onToggle={() => { props.setNavExpanded(!preferences.navExpanded) }}
        onManage={() => { openManage({ tab: defaultTab(undefined) }) }}
        onCloseDrawer={closeDrawer}
        t={t}
      />
      <div className={css.frame} data-app-frame data-app-id={active?.id} data-status={active?.status}>
        <AppHeader
          app={active}
          view={view}
          switchable={ordered}
          views={views}
          narrow={narrow}
          navExpanded={preferences.navExpanded}
          pending={state.confirmations.length}
          onOpenDrawer={() => { setDrawerOpen(true) }}
          onToggleNav={() => { props.setNavExpanded(!preferences.navExpanded) }}
          onSwitch={(appId) => { props.select(appId) }}
          onManage={(appId, tab) => { openManage({ appId, tab }) }}
          onChat={toggleConversation}
          onDevelop={(appId) => { props.select(appId); setDevelopOpen(true) }}
          canRecordBack={canRecordBack}
          /* v8 ignore next -- only rendered when canRecordBack is true */
          onRecordBack={() => { props.navigation?.back() }}
          onBack={() => { props.close() }}
          t={t}
        />
        <div className={css.frameBody}>
          <AppSurface
          state={state}
          app={active}
          view={view}
          viewport={viewport}
          anyPage={anyPage}
          readEpoch={readEpoch}
          viewProps={props.viewProps}
          onRetry={() => { props.refresh() }}
          onRetryRead={() => { setReadEpoch(epoch => epoch + 1) }}
          onManage={() => { openManage({ tab: defaultTab(undefined) }) }}
          onManagePermissions={(appId) => { openManage({ appId, tab: 'permissions' }) }}
          onAllowOnboarding={async (appId, capabilities, fingerprint) => {
            // The card's "全部允许" grants only the missing platform capabilities;
            // the peer needs stay for the permission page, and the onboarding
            // record is written only after the grants really took effect.
            if (!await props.grant({ kind: 'app', appId }, capabilities)) return false
            return await props.markOnboardingSeen(appId, fingerprint)
          }}
          onLaterOnboarding={(appId, fingerprint) => props.markOnboardingSeen(appId, fingerprint)}
          onDebug={(appId) => { openManage({ appId, tab: 'info' }) }}
            onReleaseClaims={props.releaseClaims}
            t={t}
          />
          {conversationOpen && (
            <aside
              ref={conversationPaneRef}
              className={narrow ? `${css.conversationPane} ${css.conversationPaneNarrow}` : css.conversationPane}
              data-app-conversation-pane
              {...(narrow ? { role: 'dialog', 'aria-modal': true, 'aria-label': t('conversation.title') } : {})}
            >
              <div className={css.conversationPaneHeader}>
                <span className={css.conversationPaneTitle}>{t('conversation.title')}</span>
                <button
                  type="button"
                  className={css.conversationPaneContext}
                  data-app-conversation-app={active?.id}
                  data-app-conversation-context={contextOn ? 'on' : 'off'}
                  aria-pressed={contextOn}
                  title={contextOn
                    ? t('conversation.contextOnTitle', { label: page?.label ?? t('conversation.noPage') })
                    : t('conversation.contextOffTitle')}
                  onClick={() => {
                    const next = !contextOn
                    setContextOn(next)
                    void props.setAppConversationContextEnabled(next)
                  }}
                >
                  {contextOn
                    ? (page?.label ?? (active === undefined ? t('conversation.noPage') : displayName(active, view)))
                    : t('conversation.contextOff')}
                </button>
                <button
                  type="button"
                  className={css.headerIconButton}
                  data-app-conversation-close
                  aria-label={t('conversation.close')}
                  onClick={closeConversation}
                >
                  ×
                </button>
              </div>
              <SessionProvider session={conversation}>
                {props.renderSlot('applications.conversation', {})}
              </SessionProvider>
            </aside>
          )}
        </div>
      </div>
      {setupOpen && (
        <Modal
          open
          headless
          onClose={() => { if (!setupBusy) setSetupOpen(false) }}
          title={t('conversation.setup.title')}
          className={css.dialog as string}
        >
          <form
            className={css.conversationSetup}
            data-app-conversation-setup
            onSubmit={event => { event.preventDefault(); void setupConversation() }}
          >
            <h2 className={css.conversationSetupTitle}>{t('conversation.setup.title')}</h2>
            <p className={css.conversationSetupBody}>{t('conversation.setup.body')}</p>
            <label className={css.conversationSetupField}>
              <span>{t('conversation.setup.path')}</span>
              <div className={css.conversationSetupPathRow}>
                <input
                  value={setupPath}
                  placeholder={t('conversation.setup.placeholder')}
                  autoFocus
                  onChange={event => { setSetupPath(event.target.value) }}
                  data-app-conversation-setup-path
                />
                {props.pickAppConversationFolder !== undefined && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={setupBusy}
                    data-app-conversation-setup-pick
                    onClick={() => {
                      void props.pickAppConversationFolder?.().then((path) => {
                        if (path !== undefined) setSetupPath(path)
                      })
                    }}
                  >
                    {t('conversation.setup.browse')}
                  </Button>
                )}
              </div>
            </label>
            <p className={css.conversationSetupHint}>{t('conversation.setup.hint')}</p>
            {setupError !== undefined && (
              <p className={css.conversationSetupError} role="alert" data-app-conversation-setup-error>{setupError}</p>
            )}
            <div className={css.conversationSetupActions}>
              <Button type="button" size="sm" variant="ghost" disabled={setupBusy} data-app-conversation-setup-cancel onClick={() => { setSetupOpen(false) }}>
                {t('conversation.setup.cancel')}
              </Button>
              <Button type="submit" size="sm" variant="primary" disabled={setupBusy || setupPath.trim() === ''}>
                {setupBusy ? t('conversation.setup.busy') : t('conversation.setup.create')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {developOpen && active !== undefined && (
        <DevelopmentDialog
          appId={active.id}
          appName={displayName(active, view)}
          onClose={() => { setDevelopOpen(false) }}
          create={props.createDevelopmentSession}
          openSession={props.openSession}
          t={t}
        />
      )}
      {manage !== undefined && (
        <ManagementDialog
          state={state}
          views={views}
          request={manage}
          scroll={props.manageScroll}
          onNavigate={props.openManage}
          onClose={props.closeManage}
          settingsProps={props.settingsProps}
          viewProps={props.viewProps}
          loadHistory={props.loadHistory}
          loadTasks={props.loadTasks}
          loadDataInfo={props.loadDataInfo}
          restorePreview={props.restorePreview}
          restoreData={props.restoreData}
          exportData={props.exportData}
          previewDataImport={props.previewDataImport}
          importData={props.importData}
          {...(props.reloadImportedData === undefined ? {} : { reloadImportedData: props.reloadImportedData })}
          {...(props.pruneBackups === undefined ? {} : { pruneBackups: props.pruneBackups })}
          loadGrants={props.loadGrants}
          loadPolicies={props.loadPolicies}
          setPolicy={props.setPolicy}
          setActivation={props.setActivation}
          setAppModel={props.setAppModel}
          loadModelCatalog={props.loadModelCatalog}
          loadModelUsage={props.loadModelUsage}
          loadModelLimits={props.loadModelLimits}
          loadCredentials={props.loadCredentials}
          setCredential={props.setCredential}
          deleteCredential={props.deleteCredential}
          setModelLimits={props.setModelLimits}
          loadConfirmations={props.loadConfirmations}
          grant={props.grant}
          revoke={props.revoke}
          answer={props.answer}
          cancelConfirmation={props.cancelConfirmation}
          t={t}
        />
      )}
    </div>
  )
}
