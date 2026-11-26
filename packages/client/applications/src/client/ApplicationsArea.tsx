/**
 * The application area: the whole center column while the applications panel
 * is selected. Two pieces, and nothing else — the header (the way back to the
 * conversation, the application tabs and the all-applications menu, and the
 * actions that belong to the work) and the business surface (the
 * application's own page); the management page sits above when it is open.
 *
 * The area renders; the shell (`shell.ts`) owns the wire and the state
 * machine. Everything here arrives through the injected `hooks` compartment
 * and every action is a callback from the inject face, so this component can
 * be exercised with plain observables and no Remote.
 * @module @matrix1001/dsh-application-harness-client-applications/client/ApplicationsArea
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Button, Modal } from '@matrix1001/dsh-application-harness-client-chrome'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { Caller, ConfirmationDecision, DelegationInfo, OperationPolicy } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type {
  ApplicationSettingsProps, ApplicationView, ApplicationViewProps, ManageRequest, PageContext,
} from './contract.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: loads the platform `GlobalStandardProps.useSessionStatus` declaration
// the plugin's `uiSession.sessionStatus` inject supplies at runtime. Erased at build time.
import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AppNavigation as AppNavigationService } from './navigation.ts'
import type { ApplicationsState } from './shell.ts'
import type { ApplicationPreferences } from './preferences.ts'
import type { DockRequest, DockTabKind } from './dock.ts'
import { ApplicationsDockBody, ApplicationsDockHeader, DockContextBar, type DockTabView } from './ApplicationsDock.tsx'
import type { ViewportReport } from './viewport.ts'
import { AppHeader } from './AppHeader.tsx'
import type { AreaNotice } from './notices.ts'
import {
  displayName, dockNeedsAnswer, dockStatusOf as dockStatusFor, onboardingPending, splitPinnedTabs, statusOf,
} from './model.ts'
import { AppSurface } from './AppSurface.tsx'
import { describeError } from './shell.ts'
import type { DelegationSendResult } from './delegation.ts'
import { DevelopmentDialog } from './DevelopmentDialog.tsx'
import { ManagementPage, defaultTab } from './ManagementPage.tsx'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ManageScrollMemory } from './manage.ts'
import type { NetworkProxySection } from './NetworkSettings.tsx'
import type { ConversationSession } from './conversation-session.ts'
import { useNarrow } from './narrow.ts'
import css from './ApplicationsArea.module.css'



/** The area's injected business face; its `hooks` compartment becomes the `use<Name>` seats. */
export interface ApplicationsAreaInjected {
  /** The shell's live state, the view registry, the layout preferences and the viewport reports. */
  readonly hooks: {
    readonly applications: HostObservable<ApplicationsState>
    readonly views: HostObservable<ReadonlyMap<string, ApplicationView>>
    readonly preferences: HostObservable<ApplicationPreferences>
    readonly viewport: HostObservable<ViewportReport | undefined>
    /** What the current application page reports (the pane's current-page chip). */
    readonly pageContext: HostObservable<PageContext | undefined>
    /** A one-shot request from the conversation header to show one Session here. */
    readonly dock: HostObservable<DockRequest | undefined>
    /** What the management page shows right now (the framework instance owns it). */
    readonly manage: HostObservable<ManageRequest | undefined>
    /** The pending delegation send request the human has to review. */
    readonly delegation: HostObservable<import('./delegation.ts').DelegationSendRequest | undefined>
  }
  /** Cross-application record navigation, when the shell mounted it. */
  readonly navigation?: AppNavigationService
  /** Where the management page remembers its scroll positions (the framework instance owns it). */
  readonly manageScroll: ManageScrollMemory
  /** Write one layout preference patch (pinned tabs and their order). */
  readonly updatePreferences?: (patch: Partial<ApplicationPreferences>) => void
  /** Show the management page (the list, or one application's detail at a tab). */
  readonly openManage: (request: ManageRequest) => void
  /**
   * Close it. The area calls this with itself when it leaves: coming back to
   * the applications panel starts at the business page, and the remembered
   * positions serve the next EXPLICIT open.
   */
  readonly closeManage: () => void
  /** Resolve the pending delegation send request. */
  readonly answerDelegation: (result: DelegationSendResult) => void
  /** Subscribe to one application's change notices. */
  readonly subscribeChanges: (appId: string, listener: () => void) => () => void
  /** Read the host's delegation records (the management list). */
  readonly delegations: (appId?: string) => Promise<readonly DelegationInfo[]>
  /** Send one pending delegation to an application-area Session (the human's action). */
  readonly sendDelegation: (id: string, sessionId: string, supplement?: string, appId?: string) => Promise<void>
  /** End one delegation on the human's request. */
  readonly cancelDelegation: (id: string, appId?: string) => Promise<DelegationInfo>
  /** Show the Session that executes one delegation. */
  readonly openDelegation: (id: string, appId?: string) => Promise<boolean>
  /** Select the application whose page the area shows (undefined clears the selection). */
  readonly select: (appId: string | undefined) => void
  /** Re-read the application rows. */
  readonly refresh: () => void
  /** Leave the area: the center column returns to the conversation. */
  readonly close: () => void
  /**
   * Cite the application page the area is showing in the conversation: the
   * reference is captured now and the center column returns to the conversation,
   * where the composer offers it as the `@page` chip.
   */
  /** Every remembered application-area conversation, for the pane switcher. */
  readonly appConversationTargets: () => readonly { readonly workspaceId: string; readonly sessionId: string }[]
  /** Create another conversation in the current area workspace. */
  readonly createAppConversation: () => Promise<ConversationSession>
  /** Select one remembered application-area conversation. */
  readonly selectAppConversation: (sessionId: string) => Promise<ConversationSession | undefined>
  /** Open (or first-use set up) the application area's dedicated conversation. */
  readonly openAppConversation: () => Promise<ConversationSession | undefined>
  /** Create the dedicated Workspace and its first conversation at the chosen path. */
  readonly setupAppConversation: (path: string) => Promise<ConversationSession>
  /** Create a development Session over a source workspace and bind it to the app. */
  readonly createDevelopmentSession: (appId: string, path: string) => Promise<string>
  /** Remembered development Sessions for one application. */
  readonly developmentTargets: (appId: string) => readonly { readonly appId: string; readonly sessionId: string }[]
  /** Select one development Session and bind the current page to it. */
  readonly selectDevelopmentSession: (sessionId: string) => Promise<string | undefined>
  /** Retain one development Session for a dock tab (and point the page context at it). */
  readonly retainDevelopmentSession: (sessionId: string) => Promise<ConversationSession | undefined>
  /** Retain one normal Session for a dock tab; no application page context. */
  readonly retainNormalSession: (sessionId: string) => Promise<ConversationSession | undefined>
  /** Consume the one-shot request from the conversation header. */
  readonly consumeDock: () => void
  /** A platform Session's title, when the session list has it. */
  readonly sessionTitle: (sessionId: string) => string | undefined
  /** Normal Sessions that can be opened as dock tabs (not app conversations or development). */
  readonly normalSessions: () => readonly { readonly sessionId: string; readonly title?: string }[]
  /** Show a Session in the platform's main area, when that face exists. */
  readonly openSession: (sessionId: string) => void
  /** The host's absolute suggested path for first-use Workspace setup. */
  readonly suggestedAppConversationPath: () => Promise<string | undefined>
  /** Open the platform directory picker for the dedicated Workspace folder. */
  readonly pickAppConversationFolder?: (() => Promise<string | undefined>) | undefined
  /** Attach or detach the current page pointer from the application conversation. */
  readonly setAppConversationContextEnabled: (enabled: boolean, sessionId?: string) => Promise<void>
  /** Tell the host which Session the dock currently displays (only it carries page context). */
  readonly setPageContextSession: (sessionId: string | undefined) => void
  readonly loadTasks: () => void
  /** The props the shell hands one application's registered page (the call pair included). */
  readonly viewProps: (appId: string) => ApplicationViewProps
  /** The application network proxy form; undefined when the platform settings client is not mounted. */
  readonly networkProxy: () => ConfigForm<NetworkProxySection> | undefined
  /** The props one application's settings page is rendered with. */
  readonly settingsProps: (appId: string) => ApplicationSettingsProps
  /** Read the call records; with an application, the ones TARGETING it. */
  readonly loadHistory: (appId?: string) => void
  /** Read one application's unified-store facts for the info tab's data section. */
  readonly loadDataInfo: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataInfo>
  readonly restorePreview: (appId: string, backupPath: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataRestorePreview>
  readonly restoreData: (appId: string, planId: string, requestId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataRestoreResult>
  /** Export one application's unified-store namespace (JSON). */
  readonly exportData: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataExport>
  /** Validate one application JSON import before any write. */
  readonly previewDataImport: (appId: string, json: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataImportPreview>
  /** Import one application JSON after a pre-import backup. */
  readonly importData: (appId: string, planId: string, requestId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').AppDataImportResult>
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
  /** Run one application's declared health check now (the management page's check action). */
  readonly checkHealth: (appId: string) => Promise<boolean>
  /** Set or clear one application's fixed model route. */
  readonly setAppModel: (appId: string, selection: { provider: string; model: string } | null) => Promise<boolean>
  /** Read the provider/model catalog for the model selector. */
  readonly loadModelCatalog: () => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelCatalog>
  /** Read one application's aggregated model usage. */
  readonly loadModelUsage: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelUsageSummary>
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
 * @returns the header, the surface and (when open) the management page.
 */
export function setupErrorMessage(cause: unknown, t: TranslateNS<'applications'>): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/must already exist|already exist/u.test(message)) return t('conversation.setup.missing')
  if (/symlink|real directory|not a file/u.test(message)) return t('conversation.setup.notDirectory')
  if (/absolute/u.test(message)) return t('conversation.setup.absolute')
  return t('conversation.setup.failed', { message })
}

const DELEGATE_SUPPLEMENT_MAX = 4000

export function ApplicationsArea(props: ApplicationsAreaProps): ReactNode {
  const { useApplications, useViews, usePreferences, useViewport: useViewportReport, useManage, useDelegation, useDock, useSessionStatus, usePageContext, t } = props
  const state = useApplications(snapshot => snapshot)
  const views = useViews(snapshot => snapshot)
  const preferences = usePreferences(snapshot => snapshot)
  const viewport = useViewportReport(snapshot => snapshot)
  const manage = useManage(snapshot => snapshot)
  const delegation = useDelegation(snapshot => snapshot)
  const currentPage = usePageContext(snapshot => snapshot)
  const [delegateTarget, setDelegateTarget] = useState('')
  const [delegateSupplement, setDelegateSupplement] = useState('')
  const [delegateBusy, setDelegateBusy] = useState(false)
  const [delegateError, setDelegateError] = useState<string>()
  useEffect(() => {
    if (delegation === undefined) return
    setDelegateTarget(props.appConversationTargets()[0]?.sessionId ?? 'new')
    setDelegateSupplement('')
    setDelegateBusy(false)
    setDelegateError(undefined)
  }, [delegation?.id, delegation === undefined])
  const [navBack, setNavBack] = useState<{ readonly canBack: boolean; readonly backAppId?: string }>({ canBack: false })
  useEffect(() => {
    const navigation = props.navigation
    /* v8 ignore next -- the shell can render without navigation in isolated tests */
    if (navigation === undefined) return undefined
    const read = (): void => {
      const snapshot = navigation.state.getSnapshot()
      setNavBack({ canBack: snapshot.canBack, ...(snapshot.backAppId === undefined ? {} : { backAppId: snapshot.backAppId }) })
    }
    read()
    return navigation.state.subscribe(read)
  }, [props.navigation])
  const root = useRef<HTMLDivElement>(null)
  const { compact, wide, width: areaWidth } = useNarrow(root)
  // The page's re-read generation: the refusal notice's own retry bumps it and
  // the page mounts again, which is that page's ordinary read path.
  const [readEpoch, setReadEpoch] = useState(0)
  // The application area's dedicated conversation pane. It is closed until the
  // header is clicked; opening it remembers (or first-use creates) the area's
  // own Session, bound below through the standard SessionProvider seat.
  const [conversationOpen, setConversationOpen] = useState(() => preferences.dockExpanded === true)
  const [developOpen, setDevelopOpen] = useState(false)
  const [conversation, setConversation] = useState<ConversationSession>()
  const [conversationTargets, setConversationTargets] = useState<readonly { readonly workspaceId: string; readonly sessionId: string }[]>([])
  const sessionStatusById = useSessionStatus(snapshot => snapshot)
  const [activeDock, setActiveDock] = useState<{ readonly id: string; readonly kind: DockTabKind; readonly appId?: string }>()
  const displayedContextSession = conversationOpen ? activeDock?.id : undefined
  useEffect(() => { props.setPageContextSession(displayedContextSession) }, [displayedContextSession])
  const [dockWidth, setDockWidth] = useState(preferences.dockWidth ?? 0)
  const [dockDragging, setDockDragging] = useState(false)
  const [dockClosing, setDockClosing] = useState(false)
  const dockCloseTimer = useRef<ReturnType<typeof setTimeout>>()
  const [dockOtherOpen, setDockOtherOpen] = useState(preferences.dockOtherDevOpen === true)
  const [normalTabs, setNormalTabs] = useState<readonly string[]>(preferences.dockNormalTabs ?? [])
  const [hiddenTabs, setHiddenTabs] = useState<readonly string[]>(preferences.dockHidden ?? [])
  const conversationRef = useRef<ConversationSession>()
  // First-use setup: the pane has no target until a dedicated Workspace exists.
  // The dialog is explicit, and the pane stays closed until the human commits.
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupPath, setSetupPath] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState<string>()
  // The current page is attached by default; the chip is the visible switch.
  const [contextOff, setContextOff] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => () => {
    conversationRef.current?.release()
    conversationRef.current = undefined
  }, [])

  // Leaving the area closes the management page with it (the request lives in
  // the framework instance, which outlives this component): the human comes
  // back to the page they left, not to a page they did not ask for again.
  const closeManage = props.closeManage
  useEffect(() => () => { closeManage() }, [closeManage])

  const managing = manage !== undefined
  const closeManagement = (): void => {
    props.closeManage()
    // The page covers the application frame, so give focus back to the
    // application's own tab after the page has cleared; the trigger may be
    // inside the hidden frame and is not a stable target then.
    setTimeout(() => {
      const fallback = root.current?.querySelector<HTMLElement>('[data-app-tab-active]')
      fallback?.focus()
    }, 0)
  }
  // A direct application switch (a tab, the more menu, or the management
  // page's "open") clears the cross-application record stack through the
  // navigation service, so the header never offers a back that belongs to an
  // earlier flow.
  const selectApp = (appId: string): void => {
    // A development tab belongs to one application: switching the application
    // folds it into the other-development group instead of leaving a tab that
    // no longer matches the page on screen.
    if (activeDock?.kind === 'development' && activeDock.appId !== appId) {
      const target = conversationTargets.at(-1)
      if (target !== undefined) void chooseConversation(target.sessionId)
      else { setConversation(undefined); conversationRef.current?.release(); conversationRef.current = undefined }
      setActiveDock(target === undefined ? undefined : { id: target.sessionId, kind: 'app-conversation' })
    }
    if (props.navigation !== undefined) void props.navigation.select(appId)
    else props.select(appId)
  }
  // Opening an application from the management page is a real switch: the
  // explicit user action leaves the page and selects the application.
  const openManagedApp = (appId: string): void => {
    props.closeManage()
    selectApp(appId)
    setTimeout(() => { root.current?.querySelector<HTMLElement>('[data-app-tab-active]')?.focus() }, 0)
  }

  const apps = state.apps
  const active = apps?.find(app => app.id === state.activeAppId)
  const view = active === undefined ? undefined : views.get(active.id)
  const switchable = (apps ?? []).filter(app => views.get(app.id)?.Component !== undefined)
  const pendingApprovalIds = new Set(switchable.filter(app => onboardingPending(app, state)).map(app => app.id))
  // The tab strip is the human's fixed list; the more menu holds the rest.
  // With no saved list every page application is fixed, so a fresh deployment
  // is fully pinned. Selecting an application never changes the order; tab
  // drag/context-menu actions write it.
  const split = useMemo(
    () => splitPinnedTabs(switchable, preferences.pinned, state.activeAppId),
    [switchable, preferences.pinned, state.activeAppId],
  )
  const anyPage = switchable.length > 0
  const updatePinned = (ids: readonly string[]): void => {
    props.updatePreferences?.({ pinned: [...ids] })
  }
  const pinApp = (appId: string): void => {
    const ids = split.pinned.map(app => app.id)
    if (!ids.includes(appId)) ids.push(appId)
    updatePinned(ids)
  }
  const unpinApp = (appId: string): void => {
    updatePinned(split.pinned.map(app => app.id).filter(id => id !== appId))
  }
  const orderPinned = (ids: readonly string[]): void => {
    // Keep only page applications that exist and preserve the complete set: a
    // stale or duplicated id must not drop a tab from the strip.
    const current = new Set(split.pinned.map(app => app.id))
    const next = ids.filter((id, index) => ids.indexOf(id) === index && current.has(id))
    for (const id of split.pinned.map(app => app.id)) {
      if (!next.includes(id)) next.push(id)
    }
    if (next.length > 0) updatePinned(next)
  }
  const backApp = navBack.backAppId === undefined ? undefined : switchable.find(app => app.id === navBack.backAppId)
  const backLabel = navBack.canBack
    ? (backApp === undefined ? t('nav.backRecord') : t('nav.backApp', { name: displayName(backApp, views.get(backApp.id)) }))
    : t('menu.back')
  const onAreaBack = (): void => {
    if (navBack.canBack) props.navigation?.back()
    else props.close()
  }

  // The selection survives the rows and the registrations moving, and only a
  // row that is GONE costs it: an application whose page package has not
  // loaded yet keeps the human's place (its surface says so meanwhile), and a
  // removed application hands the area to the first one that still draws a page.
  useEffect(() => {
    if (apps === undefined) return
    if (apps.some(app => app.id === state.activeAppId)) return
    props.select(apps.find(app => views.get(app.id)?.Component !== undefined)?.id)
  }, [apps, views, state.activeAppId, props])

  const finishCloseConversation = (): void => {
    const released = conversationRef.current
    conversationRef.current = undefined
    setConversation(undefined)
    setDockClosing(false)
    // Return keyboard focus to the stable trigger instead of leaving it on the
    // unmounted collapse button (body).
    requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>('[data-sidebar-right-expand]')
      if (trigger !== null && trigger.isConnected) trigger.focus()
    })
    // Release after the provider has rendered without the Session, so the
    // platform never sees a mounted consumer holding a released reference.
    if (released !== undefined) setTimeout(() => { released.release() }, 0)
  }

  const closeConversation = (): void => {
    setConversationOpen(false)
    props.updatePreferences?.({ dockExpanded: false })
    if (!wide) { finishCloseConversation(); return }
    setDockClosing(true)
    clearTimeout(dockCloseTimer.current)
    dockCloseTimer.current = setTimeout(finishCloseConversation, 240)
  }

  useEffect(() => {
    if (!conversationOpen) return
    clearTimeout(dockCloseTimer.current)
    setDockClosing(false)
  }, [conversationOpen])

  useEffect(() => () => { clearTimeout(dockCloseTimer.current) }, [])

  /* v8 ignore start -- browser-only conversation switcher actions */
  const refreshTargets = (): void => { setConversationTargets(props.appConversationTargets()) }
  /** The platform exposes ids here; the short label keeps two sessions distinct. */
  const sessionLabel = (sessionId: string): string => {
    const base = props.sessionTitle(sessionId) ?? t('conversation.sessionShort', { id: sessionId.slice(-6) })
    const status = sessionStatusById.get(sessionId as SessionId)
    if (status?.pendingInteraction !== undefined) return `${base} · ${t('dock.statusAttention')}`
    if (status?.running === true) return `${base} · ${t('dock.statusRunning')}`
    return base
  }

  const chooseConversation = async (sessionId: string): Promise<void> => {
    const next = await props.selectAppConversation(sessionId)
    if (next === undefined) return
    conversationRef.current?.release()
    conversationRef.current = next
    setConversation(next)
    setActiveDock({ id: sessionId, kind: 'app-conversation' })
    props.updatePreferences?.({ dockExpanded: true, dockActive: sessionId })
    setConversationOpen(true)
    refreshTargets()
  }

  const newConversation = async (): Promise<void> => {
    /* v8 ignore start -- the add-menu first-use branch reuses the header-chat setup, covered through that path */
    if (props.appConversationTargets().length === 0) {
      setSetupError(undefined)
      setSetupPath(await props.suggestedAppConversationPath() ?? '')
      setSetupOpen(true)
      return
    }
    /* v8 ignore stop */
    const next = await props.createAppConversation()
    conversationRef.current?.release()
    conversationRef.current = next
    setConversation(next)
    if (next.sessionId !== undefined) {
      setActiveDock({ id: next.sessionId, kind: 'app-conversation' })
      props.updatePreferences?.({ dockExpanded: true, dockActive: next.sessionId })
    }
    setConversationOpen(true)
    refreshTargets()
  }

  /* v8 ignore stop */
  const toggleConversation = async (): Promise<void> => {
    if (conversationOpen) {
      closeConversation()
      return
    }
    const next = await props.openAppConversation()
    if (next === undefined) {
      setSetupError(undefined)
      setSetupPath(await props.suggestedAppConversationPath() ?? '')
      setSetupOpen(true)
      return
    }
    conversationRef.current = next
    setConversation(next)
    const active = props.appConversationTargets().at(-1) ?? (next.sessionId === undefined ? undefined : { sessionId: next.sessionId })
    if (active !== undefined) setActiveDock({ id: active.sessionId, kind: 'app-conversation' })
    props.updatePreferences?.({ dockExpanded: true, ...(active === undefined ? {} : { dockActive: active.sessionId }) })
    setConversationOpen(true)
    refreshTargets()
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
      const active = props.appConversationTargets().at(-1) ?? (next.sessionId === undefined ? undefined : { sessionId: next.sessionId })
        if (active !== undefined) setActiveDock({ id: active.sessionId, kind: 'app-conversation' })
      props.updatePreferences?.({ dockExpanded: true, ...(active === undefined ? {} : { dockActive: active.sessionId }) })
      refreshTargets()
    } catch (cause) {
      setSetupError(setupErrorMessage(cause, t))
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

  const openManage = (request: ManageRequest): void => {
    props.openManage(request)
  }

  // The shell's statuses, floating over the content (never a row above it).
  const shellNotices: AreaNotice[] = []
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
  if (state.apps?.some(row => row.activationUnavailable === true) === true) {
    shellNotices.push({
      id: 'activation', tone: 'warning', text: t('activation.unavailable'),
      anchor: { 'data-app-activation-unavailable': '' },
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
  // The active application's health is shell-level: the page itself must not
  // spend a row on it. A permission refusal already explains this cause, so it
  // is not repeated as a second notice.
  if (refusal === undefined && !onboardingOpen && active !== undefined && statusOf(active) === 'available' && active.health === 'degraded') {
    shellNotices.push({
      id: 'health', tone: 'warning', text: t('status.degraded'),
      ...(active.detail === undefined ? {} : { detail: active.detail }),
      anchor: { 'data-app-health-degraded': '' },
    })
  }
  // An in-session write confirmation is rendered by the Session conversation;
  // when the dock is closed that card is out of sight. Surface the waiting
  // answer in the header status control and let the button reopen the dock.
  if (!conversationOpen && dockNeedsAnswer(conversationTargets, sessionStatusById)) {
    shellNotices.push({
      id: 'dock-pending',
      tone: 'warning',
      text: t('dock.pendingAttention'),
      anchor: { 'data-dock-attention': '' },
      actions: [{
        label: t('dock.openPending'),
        anchor: { 'data-dock-open-pending': '' },
        onClick: () => { void toggleConversation() },
      }],
    })
  }
  const progress = active === undefined ? [] : state.progress.filter(notice => notice.appId === active.id)
  if (progress.length > 0) {
    shellNotices.push({
      id: 'progress', tone: 'info',
      text: progress.map(notice => `${notice.op}: ${notice.message}`).join(' · '),
      anchor: { 'data-app-progress': '' },
    })
  }

  // ── The Session dock ─────────────────────────────────────────────────
  const dockRequest = useDock(snapshot => snapshot)
  const dockStatusOf = (sessionId: string): DockTabView['status'] => {
    const status = dockStatusFor(sessionStatusById.get(sessionId as SessionId))
    return status === undefined ? undefined : { tone: status.tone, label: t(status.labelKey) }
  }
  const withDockStatus = (tab: DockTabView, sessionId: string): DockTabView => {
    const status = dockStatusOf(sessionId)
    return status === undefined ? tab : { ...tab, status }
  }
  useEffect(() => { setConversationTargets(props.appConversationTargets()) }, [props.appConversationTargets])
  const titleOf = (sessionId: string): string | undefined => props.sessionTitle(sessionId)
  const appNameOf = (appId: string): string => {
    const app = switchable.find(candidate => candidate.id === appId)
    return app === undefined ? appId : displayName(app, views.get(app.id))
  }
  const devTab = (target: { readonly appId: string; readonly sessionId: string }, withApp: boolean): DockTabView => ({
    id: target.sessionId,
    kind: 'development',
    title: titleOf(target.sessionId) ?? t('dock.developmentTitle'),
    ...(withApp ? { appName: appNameOf(target.appId) } : {}),
  })
  const devView = (target: { readonly appId: string; readonly sessionId: string }, withApp: boolean): DockTabView => withDockStatus(devTab(target, withApp), target.sessionId)
  const currentDevTabs: readonly DockTabView[] = active === undefined ? [] : props.developmentTargets(active.id).map(target => devView(target, false))
  const otherDevTabs: readonly DockTabView[] = switchable
    .filter(candidate => candidate.id !== active?.id)
    .flatMap(candidate => props.developmentTargets(candidate.id).map(target => devView(target, true)))
  const appTabs: readonly DockTabView[] = conversationTargets.map(target => withDockStatus({
    id: target.sessionId,
    kind: 'app-conversation',
    title: titleOf(target.sessionId) ?? t('conversation.title'),
  }, target.sessionId))
  const normalViews: readonly DockTabView[] = normalTabs.map(sessionId => withDockStatus({
    id: sessionId,
    kind: 'normal',
    title: titleOf(sessionId) ?? t('dock.normalSession'),
  }, sessionId))
  const mainDockTabs: readonly DockTabView[] = [...appTabs, ...currentDevTabs, ...normalViews]
  const allDockTabs: readonly DockTabView[] = [...mainDockTabs, ...otherDevTabs]
  const dockTabs: readonly DockTabView[] = mainDockTabs.filter(tab => !hiddenTabs.includes(tab.id))
  const visibleOtherDevTabs: readonly DockTabView[] = otherDevTabs.filter(tab => !hiddenTabs.includes(tab.id))
  const openableTabs: readonly DockTabView[] = allDockTabs.filter(tab => hiddenTabs.includes(tab.id))
  const normalChoices = props.normalSessions()
  const activeDockId = activeDock?.id ?? ''
  // The dock follows the right panel's frame geometry: first open at 45% of
  // the area, min 300, max min(70% of the area, area - 400 for the page).
  const areaWidthForDock = areaWidth > 0 ? areaWidth : 1160
  const dockMaxWidth = Math.max(300, Math.min(Math.round(areaWidthForDock * 0.7), areaWidthForDock - 400))
  const effectiveDockWidth = Math.min(dockMaxWidth, Math.max(300, dockWidth === 0 ? Math.round(areaWidthForDock * 0.45) : dockWidth))

  const setDockPreferences = (patch: Partial<{ dockExpanded: boolean; dockWidth: number; dockActive: string; dockOtherDevOpen: boolean; dockNormalTabs: readonly string[]; dockHidden: readonly string[] }>): void => {
    props.updatePreferences?.(patch)
  }

  const openDevelopmentTab = async (sessionId: string, appId: string | undefined): Promise<void> => {
    const selected = await props.selectDevelopmentSession(sessionId)
    if (selected === undefined) return
    const next = await props.retainDevelopmentSession(sessionId)
    if (next === undefined) return
    if (appId !== undefined) {
      if (props.navigation !== undefined) void props.navigation.select(appId)
      else props.select(appId)
    }
    conversationRef.current?.release()
    conversationRef.current = next
    setConversation(next)
    setActiveDock({ id: sessionId, kind: 'development', ...(appId === undefined ? {} : { appId }) })
    setConversationOpen(true)
    setDockPreferences({ dockExpanded: true, dockActive: sessionId })
  }

  const openNormalTab = async (sessionId: string): Promise<void> => {
    const next = await props.retainNormalSession(sessionId)
    if (next === undefined) return
    conversationRef.current?.release()
    conversationRef.current = next
    setConversation(next)
    setActiveDock({ id: sessionId, kind: 'normal' })
    setConversationOpen(true)
    const nextTabs = normalTabs.includes(sessionId) ? normalTabs : [...normalTabs, sessionId]
    setNormalTabs(nextTabs)
    setDockPreferences({ dockExpanded: true, dockActive: sessionId, dockNormalTabs: nextTabs })
  }

  const closeDockTab = (sessionId: string): void => {
    const isNormal = normalTabs.includes(sessionId)
    const nextNormal = isNormal ? normalTabs.filter(id => id !== sessionId) : normalTabs
    if (isNormal) setNormalTabs(nextNormal)
    const nextHidden = isNormal || hiddenTabs.includes(sessionId) ? hiddenTabs : [...hiddenTabs, sessionId]
    if (!isNormal) setHiddenTabs(nextHidden)
    setDockPreferences({ ...(isNormal ? { dockNormalTabs: nextNormal } : { dockHidden: nextHidden }) })
    if (activeDock?.id !== sessionId) return
    const remaining = allDockTabs.find(tab => tab.id !== sessionId && !nextHidden.includes(tab.id))
    if (remaining === undefined) {
      conversationRef.current?.release()
      conversationRef.current = undefined
      setConversation(undefined)
      setActiveDock(undefined)
      return
    }
    void selectDockTab(remaining.id)
  }

  const togglePageContext = (sessionId: string): void => {
    const next = contextOff.has(sessionId)
    const updated = new Set(contextOff)
    if (next) updated.delete(sessionId)
    else updated.add(sessionId)
    setContextOff(updated)
    void props.setAppConversationContextEnabled(next, sessionId)
  }

  const closeDockTabsBatch = (ids: readonly string[], keepId: string): void => {
    if (ids.length === 0) return
    const closed = new Set(ids)
    const nextNormal = normalTabs.filter(id => !closed.has(id))
    const nextHidden = [...new Set([...hiddenTabs, ...ids.filter(id => !normalTabs.includes(id))])]
    setNormalTabs(nextNormal)
    setHiddenTabs(nextHidden)
    setDockPreferences({ dockNormalTabs: nextNormal, dockHidden: nextHidden })
    if (activeDock === undefined || !closed.has(activeDock.id)) return
    void selectDockTab(keepId)
  }

  const closeOtherDockTabs = (keepId: string): void => {
    closeDockTabsBatch(allDockTabs.filter(tab => tab.id !== keepId).map(tab => tab.id), keepId)
  }

  const closeDockTabsToRight = (fromId: string): void => {
    const visible = allDockTabs.filter(tab => !hiddenTabs.includes(tab.id))
    const index = visible.findIndex(tab => tab.id === fromId)
    if (index < 0) return
    closeDockTabsBatch(visible.slice(index + 1).map(tab => tab.id), fromId)
  }

  const selectDockTab = async (sessionId: string): Promise<void> => {
    if (hiddenTabs.includes(sessionId)) {
      const next = hiddenTabs.filter(id => id !== sessionId)
      setHiddenTabs(next)
      setDockPreferences({ dockHidden: next })
    }
    if (conversationTargets.some(target => target.sessionId === sessionId)) { await chooseConversation(sessionId); return }
    const dev = [...currentDevTabs, ...otherDevTabs].find(tab => tab.id === sessionId)
    if (dev !== undefined) {
      const target = [...props.developmentTargets(active?.id ?? ''), ...switchable.flatMap(candidate => candidate.id === active?.id ? [] : props.developmentTargets(candidate.id))]
        .find(entry => entry.sessionId === sessionId)
      await openDevelopmentTab(sessionId, target?.appId)
      return
    }
    if (normalTabs.includes(sessionId)) await openNormalTab(sessionId)
  }

  // Restore the remembered tab when the dock opens; a fresh dock starts on the
  // remembered application conversation.
  useEffect(() => {
    if (!conversationOpen || activeDock !== undefined) return
    const remembered = preferences.dockActive
    const visible = conversationTargets.filter(candidate => !hiddenTabs.includes(candidate.sessionId))
    const target = visible.find(candidate => candidate.sessionId === remembered) ?? visible.at(-1)
    if (target !== undefined) { void chooseConversation(target.sessionId); return }
    if (remembered !== undefined && normalTabs.includes(remembered) && !hiddenTabs.includes(remembered)) void openNormalTab(remembered)
    // A remembered development tab is restored by the area's own tabs once the
    // session list and page-context owner are ready; the app conversation is
    // the safe fallback.
  }, [conversationOpen, activeDock, conversationTargets, preferences.dockActive, hiddenTabs, normalTabs])


  // One-shot request from the DSH conversation header.
  useEffect(() => {
    if (dockRequest === undefined) return
    if (dockRequest.kind === 'app-conversation') {
      // Read the LIVE target list, not the state that the mount effect has
      // only just queued: on the area's first mount this effect used to see an
      // empty state, consume the request and drop the Session.
      const targets = props.appConversationTargets()
      if (!targets.some(target => target.sessionId === dockRequest.sessionId)) return
      props.consumeDock()
      void chooseConversation(dockRequest.sessionId)
      return
    }
    props.consumeDock()
    if (dockRequest.kind === 'development') { void openDevelopmentTab(dockRequest.sessionId, dockRequest.appId); return }
    void openNormalTab(dockRequest.sessionId)
  }, [dockRequest, conversationTargets])

  const startDockResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = effectiveDockWidth
    const min = 300
    const max = dockMaxWidth
    let latest = startWidth
    let frame: number | null = null
    handle.setPointerCapture(pointerId)
    setDockDragging(true)
    const apply = (): void => { frame = null; setDockWidth(latest) }
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return
      latest = Math.min(max, Math.max(min, Math.round(startWidth + (startX - move.clientX))))
      frame ??= requestAnimationFrame(apply)
    }
    const finish = (): void => {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null }
      setDockWidth(latest)
      setDockDragging(false)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', finish)
      handle.removeEventListener('lostpointercapture', finish)
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      setDockPreferences({ dockWidth: latest })
    }
    const onUp = (): void => { finish() }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', finish)
    handle.addEventListener('lostpointercapture', finish)
  }

  return (
    <div className={css.area} ref={root} data-applications-area data-narrow={compact ? 'true' : undefined}>
      <div className={css.stage} data-managing={managing ? 'true' : undefined}>
      <div className={css.frame} data-app-frame data-wide={wide ? 'true' : undefined} data-app-id={active?.id} data-status={active === undefined ? undefined : statusOf(active)} data-dragging={dockDragging ? 'true' : undefined}>
        <div className={css.topRow} data-app-top-row>
          <div
            className={css.appHeaderSlot}
            style={!wide ? (conversationOpen ? { display: 'none' } : undefined) : { width: conversationOpen ? `calc(100% - ${effectiveDockWidth}px)` : '100%' }}
          >
            <AppHeader
              app={active}
              view={view}
              tabs={split.tabs}
              allApps={switchable}
              pinned={split.pinned}
              {...(split.temporary === undefined ? {} : { temporaryId: split.temporary.id })}
              views={views}
              loading={apps === undefined}
              pendingApproval={pendingApprovalIds}
              pending={state.confirmations.length}
              notices={shellNotices}
              backLabel={backLabel}
              onBack={onAreaBack}
              onSwitch={selectApp}
              onPin={pinApp}
              onUnpin={unpinApp}
              onOrder={orderPinned}
              onManage={(appId, tab, focus) => { openManage(focus === undefined ? { appId, tab } : { appId, tab, focus }) }}
              onManageList={() => { openManage({ tab: defaultTab() }) }}
              {...(conversationOpen || dockClosing ? {} : { onDockOpen: () => { void toggleConversation() } })}
              onDevelop={(appId) => { selectApp(appId); setDevelopOpen(true) }}
              t={t}
            />
          </div>
          {(conversationOpen || dockClosing) && (
            <div className={css.dockHeaderSlot} style={{ width: conversationOpen ? (wide ? `${effectiveDockWidth}px` : '100%') : 0 }}>
              <ApplicationsDockHeader
                tabs={dockTabs}
                otherTabs={visibleOtherDevTabs}
                activeId={activeDockId}
                openableTabs={openableTabs}
                onOpenTab={(id) => { void selectDockTab(id) }}
                otherOpen={dockOtherOpen}
                normalChoices={normalChoices}
                onSelect={(id) => { void selectDockTab(id) }}
                onClose={closeDockTab}
                onCloseOthers={closeOtherDockTabs}
                onCloseRight={closeDockTabsToRight}
                onToggleOther={() => {
                  const next = !dockOtherOpen
                  setDockOtherOpen(next)
                  setDockPreferences({ dockOtherDevOpen: next })
                }}
                onCollapse={closeConversation}
                onNewConversation={() => { void newConversation() }}
                onNewDevelopment={() => { setDevelopOpen(true) }}
                onOpenNormal={(sessionId) => { void openNormalTab(sessionId) }}
                onOpenInSession={(sessionId) => { props.openSession(sessionId) }}
                narrow={!wide}
                onBack={closeConversation}
                t={t}
              />
            </div>
          )}
        </div>
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
          onManage={() => { openManage({ tab: defaultTab() }) }}
          onManagePermissions={(appId) => { openManage({ appId, tab: 'permissions' }) }}
          onAllowOnboarding={async (appId, capabilities, fingerprint) => {
            // The card's "全部允许" grants only the missing platform capabilities;
            // the peer needs stay for the permission page, and the onboarding
            // record is written only after the grants really took effect.
            if (!await props.grant({ kind: 'app', appId }, capabilities)) return false
            return await props.markOnboardingSeen(appId, fingerprint)
          }}
          onLaterOnboarding={(appId, fingerprint) => props.markOnboardingSeen(appId, fingerprint)}
          onboardingSuppressed={managing}
          onDebug={(appId) => { openManage({ appId, tab: 'status' }) }}
            t={t}
          />
          {(conversationOpen || dockClosing) && (
            <ApplicationsDockBody width={conversationOpen ? effectiveDockWidth : 0} narrow={!wide} t={t}>
              {activeDock !== undefined && (activeDock.kind === 'app-conversation' || activeDock.kind === 'development') && (
                <DockContextBar
                  enabled={!contextOff.has(activeDock.id)}
                  page={currentPage}
                  onToggle={() => { togglePageContext(activeDock.id) }}
                  t={t}
                />
              )}
              {conversation === undefined
                ? (
                  <div className={css.dockEmpty} data-app-dock-empty>
                    <p>{t('dock.empty')}</p>
                    <Button size="sm" variant="outline" data-app-dock-empty-new onClick={() => { void newConversation() }}>{t('dock.newAppConversation')}</Button>
                  </div>
                )
                : (
                  <SessionProvider session={conversation}>
                    {props.renderSlot('applications.conversation', {})}
                  </SessionProvider>
                )}
            </ApplicationsDockBody>
          )}
        </div>
        {conversationOpen && wide && (
          <div
            className={css.dockResize}
            data-app-dock-resize
            data-dragging={dockDragging ? 'true' : undefined}
            style={{ left: `calc(100% - ${effectiveDockWidth}px)` }}
            onPointerDown={startDockResize}
          />
        )}
      </div>
      {manage !== undefined && (
        <ManagementPage
          state={state}
          views={views}
          request={manage}
          narrow={!wide}
          currentApp={active}
          currentView={view}
          scroll={props.manageScroll}
          onNavigate={props.openManage}
          onReturn={closeManagement}
          notices={shellNotices}
          onOpenApp={openManagedApp}
          networkProxy={props.networkProxy}
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
          checkHealth={props.checkHealth}
          setAppModel={props.setAppModel}
          loadModelCatalog={props.loadModelCatalog}
          loadModelUsage={props.loadModelUsage}
          loadModelLimits={props.loadModelLimits}
          setModelLimits={props.setModelLimits}
          loadConfirmations={props.loadConfirmations}
          grant={props.grant}
          revoke={props.revoke}
          answer={props.answer}
          cancelConfirmation={props.cancelConfirmation}
          subscribeChanges={props.subscribeChanges}
          delegations={props.delegations}
          cancelDelegation={props.cancelDelegation}
          openDelegation={props.openDelegation}
          t={t}
        />
      )}
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
            <p className={css.conversationSetupHint} data-app-conversation-setup-hint>{t('conversation.setup.hint')}</p>
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
      {delegation !== undefined && (
        <Modal
          open
          headless
          onClose={() => { if (!delegateBusy) props.answerDelegation('cancelled') }}
          title={delegation.delegation.title}
          className={css.dialog as string}
        >
          <div className={css.develop} data-delegate-dialog data-delegation-id={delegation.delegation.id}>
            <div className={css.developHead}>
              <strong>{delegation.delegation.title}</strong>
              <button
                type="button"
                className={css.headerIconButton}
                aria-label={t('develop.close')}
                disabled={delegateBusy}
                onClick={() => { props.answerDelegation('cancelled') }}
              >
                ×
              </button>
            </div>
            <p className={css.developHint}>{t('delegation.sendHint', { app: delegation.delegation.appId })}</p>
            <pre className={css.delegateInstructions} data-delegate-instructions>{delegation.delegation.instructions}</pre>
            <label className={css.developField}>
              <span>{t('delegation.target')}</span>
              <select data-delegate-target value={delegateTarget} onChange={(event) => { setDelegateTarget(event.target.value) }}>
                {props.appConversationTargets().map(target => <option key={target.sessionId} value={target.sessionId} title={target.sessionId}>{sessionLabel(target.sessionId)}</option>)}
                <option value="new">{t('conversation.new')}</option>
              </select>
            </label>
            {props.appConversationTargets().length === 0 ? (
              <div className={css.developActions} data-delegate-no-target>
                <p className={css.conversationSetupHint}>{t('delegation.setupFirst')}</p>
                <Button
                  data-delegate-setup
                  onClick={() => {
                    props.answerDelegation('cancelled')
                    void newConversation()
                  }}
                >{t('conversation.setup.title')}</Button>
              </div>
            ) : null}
            <label className={css.developField}>
              <span>{t('delegation.supplement')}</span>
              <textarea
                className={css.developField}
                data-delegate-supplement
                value={delegateSupplement}
                onChange={(event) => { setDelegateSupplement(event.target.value) }}
                placeholder={t('delegation.supplementHint')}
                rows={4}
                maxLength={DELEGATE_SUPPLEMENT_MAX}
              />
              <span className={css.developHint} data-delegate-supplement-count>
                {delegateSupplement.length}/{DELEGATE_SUPPLEMENT_MAX}
              </span>
            </label>
            {delegateError === undefined ? null : <p className={css.conversationSetupError} role="alert" data-delegate-error>{delegateError}</p>}
            <div className={css.developActions}>
              <Button data-delegate-cancel disabled={delegateBusy} onClick={() => { props.answerDelegation('cancelled') }}>{t('conversation.setup.cancel')}</Button>
              <Button
                variant="primary"
                data-delegate-send
                disabled={delegateBusy || delegateTarget === '' || (delegateTarget === 'new' && props.appConversationTargets().length === 0)}
                onClick={() => {
                  setDelegateBusy(true)
                  setDelegateError(undefined)
                  void (async () => {
                    try {
                      let sessionId = delegateTarget
                      if (delegateTarget === 'new') {
                        const created = await props.createAppConversation()
                        const createdId = (created as { readonly sessionId?: string }).sessionId
                        ;(created as { readonly release?: () => void }).release?.()
                        if (createdId === undefined) throw new Error(t('delegation.newSessionUnavailable'))
                        sessionId = createdId
                      }
                      await props.sendDelegation(delegation.delegation.id, sessionId, delegateSupplement, delegation.delegation.appId)
                      props.answerDelegation('sent')
                      await chooseConversation(sessionId)
                    } catch (error) {
                      setDelegateBusy(false)
                      const message = error instanceof Error ? error.message : String(error)
                      setDelegateError(
                        /not running|not pending|already executing|not an application-area/u.test(message)
                          ? t('delegation.targetUnavailable')
                          : describeError(error),
                      )
                    }
                  })()
                }}
              >
                {delegateBusy ? t('delegation.sending') : t('delegation.send')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {developOpen && active !== undefined && (
        <DevelopmentDialog
          appId={active.id}
          appName={displayName(active, view)}
          onClose={() => { setDevelopOpen(false) }}
          create={props.createDevelopmentSession}
          sessions={props.developmentTargets(active.id)}
          openSession={(sessionId) => { void openDevelopmentTab(sessionId, active.id) }}
          t={t}
        />
      )}
    </div>
  )
}
