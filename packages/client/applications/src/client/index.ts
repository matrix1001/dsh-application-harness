/**
 * The applications shell, browser half: the one browser-side owner of the
 * host's `applications` surface.
 *
 * It does three things and nothing else:
 *
 * - it provides `ctx.applicationViews`, the registry a client package
 *   registers its own application page and settings into (cross-plugin
 *   collaboration is a Cordis service + `import type`, never a value import);
 * - it runs ONE shell (`shell.ts`) over the Remote namespace: the list and its
 *   readiness, calls with cancellation, progress, the change fan, the
 *   reconnect re-read, history, grants and the out-of-session confirmations —
 *   everything a browser user needs and no projection machinery;
 * - it binds the panel: a keyed `main` entry (the application area: header,
 *   application tabs and all-applications menu, the selected page and management) and the
 *   sidebar rail entry that selects it. The area's own layout preferences and
 *   each application's view state are persisted here, apart from business data.
 *
 * No Session is involved anywhere: the panel is a global surface, so it works
 * the same with no conversation open.
 * @module @matrix1001/dsh-application-harness-client-applications/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge (the generated `applications` namespace).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the generated `applications` namespace merge (the host
// bridge's `/remote` contribution) into this compilation face.
import type {} from '@matrix1001/dsh-application-harness-host-bridge/remote'
// Type-only: the client root services this face reaches (ctx.slots) and the
// `layout` face (`selectPanel`), the keyed `main` slot, the sidebar's
// panellist row, and the locale seat.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the platform Session row's leading marker slot this plugin fills.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Side-effect: the shared scale is defined at `:root` (see tokens.module.css).
// Imported here — not in an application view — because the area, the management
// dialog and the sidebar all read it, and the dialog is portalled outside the area.
import './tokens.module.css'
import applicationsRemote from '@matrix1001/dsh-application-harness-host-bridge/remote'
import { APPLICATION_PANEL_KEY } from './panel-key.ts'
import { createApplicationViews, type ApplicationViews } from './views.ts'
import { createPreferences } from './preferences.ts'
import { createViewport, type ViewportService } from './viewport.ts'
import { createManageService, type ManageService } from './manage.ts'
import { createDock, type DockService } from './dock.ts'
import { OpenInAreaAction, type HeaderActionProps } from './OpenInAreaAction.tsx'
import { createDelegation, type DelegationService } from './delegation.ts'
import { ApplicationsShell, type ApplicationsRemote } from './shell.ts'
import { ApplicationsArea, type ApplicationsAreaInjected } from './ApplicationsArea.tsx'
import { APP_HTTP_NAMESPACE, type NetworkProxySection } from './NetworkSettings.tsx'
import { ApplicationsIcon } from './ApplicationsIcon.tsx'
import { ApplicationsRailBadge } from './rail.tsx'
import { SessionRowMarker } from './session-marker.tsx'
import { TurnScopeControl } from './turn-scope.tsx'
import { ApplicationsPlaceholder } from './placeholder.tsx'
import { composerPlaceholder } from './model.ts'
import { createPageContext } from './page-context.ts'
import { createAppNavigation } from './navigation.ts'
import type { AppNavigation } from './navigation.ts'
import { createPageSource } from './page-source.ts'
import { createApplicationSource } from './application-source.ts'
import { ConversationPanel, type ApplicationsConversationInjected } from './ApplicationsConversation.tsx'
import { createAppConversation, type AppConversationPage, type AppConversationSessions, type AppConversationService, type AppConversationWorkspaces } from './app-conversation.ts'
import { createDevelopmentSession } from './development.ts'
import type { ConversationSession } from './conversation-session.ts'
import { en, NS, zh, type ApplicationsKey } from './locales.ts'
import type { ApplicationViewProps, ApplicationViewportFace, ApplicationViewRegistry, PageContextInput, PageContextService } from './contract.ts'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'

// The shared contract of this package's browser API: the shapes another
// client package names through `import type` (the registry it registers into,
// the props its page and settings render with, and the page context a page
// reports). The implementation values stay internal — a view reports through
// the face its props carry, never by reaching a service.
export type {
  ApplicationSettingsProps, ApplicationUiPatch, ApplicationUiState, ApplicationUiStore, ApplicationView,
  ApplicationViewData, ApplicationViewportFace, ApplicationViewProps, ApplicationViewRegistry,
  AppNavigationFace, LeaveGuard, ManageRequest, ManageTab, PageContext, PageContextFace, PageContextInput, PageContextService,
  PageRecordKind, PageRecordRef, RouteIntent, ViewportInput,
} from './contract.ts'
export type { ManageService } from './manage.ts'
export type { ApplicationsState } from './shell.ts'
export type { ViewportReport, ViewportService } from './viewport.ts'
export { APPLICATION_PANEL_KEY } from './panel-key.ts'
export type { ApplicationPreferences } from './preferences.ts'
export type { ApplicationsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The applications area and rail entry copy. */
    applications: ApplicationsKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The application page registry: one registration per appId (page and/or
     * settings), declared by the package that owns the application
     * (`ctx.applicationViews.register`).
     */
    applicationViews: ApplicationViewRegistry
  }
}

/**
 * Required services: the typed Client Remote (the namespace this plugin
 * mounts itself — see {@link openApplications}, so `remote.applications` is
 * deliberately NOT an inject), the slot registry and layout frame the panel
 * binds into, and the dictionaries.
 *
 * The trigger registry is deliberately NOT here: the panel works with no chat
 * surface mounted at all, so the page reference source registers through
 * `ctx.inject(['inputTriggers'])` — present, it joins the `@` menu; absent, the
 * shell is exactly what it was.
 */
export const inject = ['remote', 'slots', 'locale', 'layout', 'uiSession', 'uiSession.sessionStatus']

/**
 * Open the typed `applications` namespace: the composition's own mount when it
 * has one (a host-provided Client assembly), this plugin's mount otherwise.
 *
 * The namespace is read through the STORE (`ctx.get`), not the declared face:
 * this plugin MOUNTS the namespace for the ordinary profile (the platform's
 * Client assembly selects its own platform namespaces and knows nothing about
 * this harness's `/remote` contribution), and cordis's `ctx.remote.<ns>`
 * property access refuses without an `inject` declaration — while declaring
 * `inject: ['remote.applications']` would deadlock, since the plugin would
 * wait for a service only its own apply provides. The read stays typed by the
 * generated declaration; no hand-written cast pretends it is not there.
 * @param ctx - the client root context.
 * @returns the namespace and, when this call mounted it, the unmount disposer.
 */
async function openApplications(ctx: Context): Promise<{ remote: ApplicationsRemote; dispose?: () => Promise<void> }> {
  const installed = ctx.get('remote.applications') as ApplicationsRemote | undefined
  if (installed !== undefined) return { remote: installed }
  const dispose = await ctx.remote.$mount(applicationsRemote)
  return {
    remote: ctx.get('remote.applications') as ApplicationsRemote,
    dispose: async () => { await dispose() },
  }
}

/**
 * Bind the center column: one keyed `main` entry for this area's whole life
 * (the platform mounts and unmounts it as the selection moves), with the
 * shell's state, the registrations and the layout preferences as its inject
 * face. Each page's props are the shell's own data surface plus that
 * application's own faces, so reporting is always stamped with the application
 * the area rendered and a page can only ever write its OWN view state.
 * @param ctx - the client root context.
 * @param shell - the running shell.
 * @param views - the registry the area resolves the selected page through.
 * @param preferences - the area's persisted layout preferences.
 * @param pageContext - the page-context store every page reports through.
 * @param viewport - the viewport store the business surface scrolls by.
 */
/** The platform session-list rows this client can read, reduced to the fields the dock needs. */
function sessionRows(sessions: AppConversationSessions): {
  readonly byId: Readonly<Record<string, { readonly sessionId: string; readonly title?: string }>>
  readonly archivedSessionIds?: readonly string[]
} | undefined {
  const list = (sessions as unknown as {
    readonly list?: { getSnapshot(): { readonly byId: Readonly<Record<string, { readonly sessionId: string; readonly title?: string }>>; readonly archivedSessionIds?: readonly string[] } }
  }).list
  return list?.getSnapshot()
}

function bindPanel(
  ctx: Context,
  applicationsConversationInjected: ApplicationsConversationInjected,
  shell: ApplicationsShell,
  views: ApplicationViews,
  preferences: ReturnType<typeof createPreferences>,
  pageContext: PageContextService,
  viewport: ViewportService,
  navigation: AppNavigation,
  manage: ManageService,
  dock: DockService,
  delegation: DelegationService,
  openAppConversation: () => Promise<ConversationSession | undefined>,
  appConversationTargets: () => readonly { readonly workspaceId: string; readonly sessionId: string }[],
  createAppConversation: () => Promise<ConversationSession>,
  selectAppConversation: (sessionId: string) => Promise<ConversationSession | undefined>,
  setupAppConversation: (path: string) => Promise<ConversationSession>,
  createDevelopmentSession: (appId: string, path: string) => Promise<string>,
  developmentTargets: (appId: string) => readonly { readonly appId: string; readonly sessionId: string }[],
  selectDevelopmentSession: (sessionId: string) => Promise<string | undefined>,
  retainDevelopmentSession: (sessionId: string) => Promise<ConversationSession | undefined>,
  retainNormalSession: (sessionId: string) => Promise<ConversationSession | undefined>,
  sessionTitle: (sessionId: string) => string | undefined,
  normalSessions: () => readonly { readonly sessionId: string; readonly title?: string }[],
  suggestedAppConversationPath: () => Promise<string | undefined>,
  pickAppConversationFolder: () => Promise<string | undefined>,
  setAppConversationContextEnabled: (enabled: boolean, sessionId?: string) => Promise<void>,
  setPageContextSession: (sessionId: string | undefined) => void,
  pageSessionIds: () => readonly string[],
  subscribeChanges: (appId: string, listener: () => void) => () => void,
  shareDraft: (draftId: string, fields?: readonly string[]) => Promise<boolean>,
  revokeDraft: (draftId: string) => Promise<boolean>,
): void {
  // One reporting face per application, stable for the panel's life: a page
  // keys an effect on it (report once per view, not once per repaint).
  const viewportFaces = new Map<string, ApplicationViewportFace>()
  const viewportFace = (appId: string): ApplicationViewportFace => {
    const existing = viewportFaces.get(appId)
    if (existing !== undefined) return existing
    const face: ApplicationViewportFace = { report: (input) => viewport.report(appId, input) }
    viewportFaces.set(appId, face)
    return face
  }
  // Page controllers register fixed-action handlers here; the command listener
  // below routes set-filters/select to the currently mounted application page.
  const pageActionHandlers = new Map<string, Set<(action: 'set-filters' | 'select', input: JsonValue) => boolean | void | Promise<boolean | void>>>()
  const pageActionFaces = new Map<string, import('./contract.ts').PageActionFace>()
  const pageActionFace = (appId: string): import('./contract.ts').PageActionFace => {
    const existing = pageActionFaces.get(appId)
    if (existing !== undefined) return existing
    const face = {
      onAction(handler: (action: 'set-filters' | 'select', input: JsonValue) => boolean | void | Promise<boolean | void>) {
        const handlers = pageActionHandlers.get(appId) ?? new Set()
        handlers.add(handler)
        pageActionHandlers.set(appId, handlers)
        return () => { handlers.delete(handler) }
      },
    }
    pageActionFaces.set(appId, face)
    return face
  }
  // Host page commands are executed only by the client that owns the app
  // conversation Session; another client leaves the command unanswered.
  /* v8 ignore next 3 -- the close notification only drops transient page action handlers */
  ctx.effect(() => shell.onPageClosed(notice => {
    if (pageSessionIds().includes(notice.sessionId)) pageActionHandlers.clear()
  }), 'applications: page close')
  ctx.effect(() => shell.onPageCommand(async (command) => {
    if (!pageSessionIds().includes(command.sessionId)) return undefined
    if (command.action === 'draft-read') {
      const handler = draftReadHandlers.get(command.appId)?.values().next().value
      if (handler === undefined) return false
      const input = (command.input ?? {}) as unknown as { draftId: string; fields?: readonly string[] }
      const result = await handler(input)
      return { accepted: true, result: result as unknown as JsonValue }
    }
    if (command.action === 'draft-update') {
      const handler = draftUpdateHandlers.get(command.appId)?.values().next().value
      if (handler === undefined) return false
      const input = (command.input ?? {}) as unknown as { draftId: string; revision: string; values: JsonValue }
      const result = await handler(input)
      return { accepted: true, result: result as unknown as JsonValue }
    }
    if (command.action === 'set-filters' || command.action === 'select') {
      const handlers = pageActionHandlers.get(command.appId)
      if (handlers === undefined) return false
      for (const handler of handlers) {
        const accepted = await handler(command.action, (command.input ?? {}) as JsonValue)
        if (accepted !== false) return true
      }
      return false
    }
    try {
      return await navigation.openAndWait({
        appId: command.appId,
        ...(command.view === undefined ? {} : { view: command.view }),
        ...(command.record === undefined ? {} : { record: { appId: command.appId, kind: command.record.kind, id: command.record.id } }),
      })
    } catch {
      /* v8 ignore next -- a malformed page command must not escape the listener */
      return false
    }
  }), 'applications: owner-session page commands')
  const draftReadHandlers = new Map<string, Set<(input: { readonly draftId: string; readonly fields?: readonly string[] }) => import('./contract.ts').PageDraftResult | Promise<import('./contract.ts').PageDraftResult>>>()
  const draftUpdateHandlers = new Map<string, Set<(input: { readonly draftId: string; readonly revision: string; readonly values: JsonValue }) => import('./contract.ts').PageDraftResult | { readonly conflict: true } | Promise<import('./contract.ts').PageDraftResult | { readonly conflict: true }>>>()
  const draftFaces = new Map<string, import('./contract.ts').PageDraftsFace>()
  const draftFace = (appId: string): import('./contract.ts').PageDraftsFace => {
    const existing = draftFaces.get(appId)
    if (existing !== undefined) return existing
    const face = {
      share: async (input: { readonly draftId: string; readonly fields?: readonly string[] }) => await shareDraft(input.draftId, input.fields),
      revoke: async (input: { readonly draftId: string }) => await revokeDraft(input.draftId),
      onRead(handler: (input: { readonly draftId: string; readonly fields?: readonly string[] }) => import('./contract.ts').PageDraftResult | Promise<import('./contract.ts').PageDraftResult>) {
        const handlers = draftReadHandlers.get(appId) ?? new Set()
        handlers.add(handler)
        draftReadHandlers.set(appId, handlers)
        return () => { handlers.delete(handler) }
      },
      onUpdate(handler: (input: { readonly draftId: string; readonly revision: string; readonly values: JsonValue }) => import('./contract.ts').PageDraftResult | { readonly conflict: true } | Promise<import('./contract.ts').PageDraftResult | { readonly conflict: true }>) {
        const handlers = draftUpdateHandlers.get(appId) ?? new Set()
        handlers.add(handler)
        draftUpdateHandlers.set(appId, handlers)
        return () => { handlers.delete(handler) }
      },
    }
    draftFaces.set(appId, face)
    return face
  }
  // The page-context face is stable for the same reason: a page keys its
  // report effect on it. Rebuilding it on every panel render would re-run that
  // effect, report again, notify this panel, and loop (React "maximum update
  // depth") — the visible app page would crash the main slot.
  const pageContextFaces = new Map<string, ApplicationViewProps['pageContext']>()
  const pageContextFace = (appId: string): ApplicationViewProps['pageContext'] => {
    const existing = pageContextFaces.get(appId)
    if (existing !== undefined) return existing
    const face = { report: (input: PageContextInput) => pageContext.report(appId, input) }
    pageContextFaces.set(appId, face)
    return face
  }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: APPLICATION_PANEL_KEY,
    locale: NS,
    children: { 'applications.conversation': { kind: 'single', scope: 'session', inject: applicationsConversationInjected } },
    inject: (): ApplicationsAreaInjected => ({
      hooks: {
        applications: shell.state,
        views,
        preferences,
        viewport,
        manage,
        dock,
        delegation: delegation.state,
        pageContext: { getSnapshot: () => pageContext.current(), subscribe: pageContext.subscribe },
      },
      navigation,
      updatePreferences: (patch) => { preferences.set({ ...preferences.getSnapshot(), ...patch }) },
      manageScroll: manage.scroll,
      // Optional platform service: the app-http row's settings form exists only
      // when the settings client is mounted, so the management page hides the
      // area-level setting in deployments that carry no settings surface.
      networkProxy: () => ctx.get('configForms')?.get<NetworkProxySection>(APP_HTTP_NAMESPACE),
      openAppConversation,
      appConversationTargets,
      createAppConversation,
      selectAppConversation,
      setupAppConversation,
      createDevelopmentSession,
      developmentTargets,
      selectDevelopmentSession,
      retainDevelopmentSession,
      retainNormalSession,
      consumeDock: () => { dock.consume() },
      sessionTitle,
      normalSessions,
      openSession: (sessionId) => {
        const workspace = ctx.get('uiWorkspace') as { openSession?: (id: string) => void } | undefined
        workspace?.openSession?.(sessionId)
      },
      suggestedAppConversationPath,
      pickAppConversationFolder,
      setAppConversationContextEnabled,
      setPageContextSession,
      subscribeChanges,
      loadTasks: () => { void shell.loadTasks() },
      openManage: (request) => { manage.open(request) },
      closeManage: () => { manage.close() },
      /* v8 ignore next -- UI responder for a pending delegation send */
      answerDelegation: result => { delegation.answer(result) },
      /* v8 ignore next 2 -- the management delegation list is exercised through the dialog */
      delegations: async appId => await shell.delegations(appId),
      /* v8 ignore next 2 -- the send dialog delegates to the shell */
      sendDelegation: async (id, sessionId, supplement, appId) => { await shell.sendDelegation(id, sessionId, supplement, appId) },
      /* v8 ignore next 2 -- the management cancel action delegates to the shell */
      cancelDelegation: async (id, appId) => await shell.cancelDelegation(id, appId),
      /* v8 ignore next 2 -- the open-execution action delegates to the shell */
      openDelegation: async (id, appId) => await shell.openDelegation(id, appId),
      select: (appId) => { if (appId !== undefined) void navigation.select(appId) },
      refresh: () => { void shell.refresh() },
      close: () => { ctx.layout.selectPanel(null) },
      viewProps: (appId) => {
        const route = navigation.state.getSnapshot().route
        return {
        ...shell.viewProps(appId),
        pageContext: pageContextFace(appId),
        pageActions: pageActionFace(appId),
        drafts: draftFace(appId),
        /* v8 ignore next -- route is one-shot and covered by the navigation suites */
        ...(route?.appId === appId ? { route } : {}),
        /* v8 ignore next 6 -- the face delegates to the navigation service */
        navigation: {
          open: (input) => navigation.open(input),
          back: () => navigation.back(),
          canBack: () => navigation.state.getSnapshot().canBack,
        },
        /* v8 ignore next -- the leave-guard registration is exercised through the views */
        registerLeaveGuard: (guard) => navigation.registerGuard(appId, guard),
        viewport: viewportFace(appId),
        // The application's own way into its management page — the permission
        // tab it may open is where the human decides, and the callback cannot
        // name another application (it is bound here).
        openManagement: manage.opener(appId),
        ui: views.state(appId),
        }
      },
      settingsProps: (appId) => ({
        ...shell.viewProps(appId),
        appId,
        openManagement: manage.opener(appId),
        ui: views.state(appId),
      }),
      loadHistory: (appId) => { void shell.loadHistory(appId) },
      loadDataInfo: (appId) => shell.dataInfo(appId),
      restorePreview: (appId, backupPath) => shell.restorePreview(appId, backupPath),
      restoreData: (appId, planId, requestId) => shell.restoreData(appId, planId, requestId),
      exportData: (appId) => shell.dataExport(appId),
      previewDataImport: (appId, json) => shell.previewDataImport(appId, json),
      importData: (appId, planId, requestId) => shell.importData(appId, planId, requestId),
      reloadImportedData: (appId) => shell.dataReload(appId),
      pruneBackups: (keep) => shell.pruneBackups(keep),
      loadGrants: () => { void shell.loadGrants() },
      loadPolicies: () => { void shell.loadPolicies() },
      setPolicy: (appId, op, policy) => shell.setPolicy(appId, op, policy),
      setActivation: (appId, activation) => shell.setActivation(appId, activation),
      checkHealth: (appId) => shell.checkHealth(appId),
      setAppModel: (appId, selection) => shell.setAppModel(appId, selection),
      loadModelCatalog: () => shell.modelCatalog(),
      loadModelUsage: (appId) => shell.modelUsage(appId),
      loadModelLimits: (appId) => shell.modelLimits(appId),
      setModelLimits: (appId, limits) => shell.setModelLimits(appId, limits),
      loadConfirmations: () => { void shell.loadConfirmations() },
      grant: (caller, capabilities) => shell.grant(caller, capabilities),
      revoke: (caller, selector) => shell.revoke(caller, selector),
      markOnboardingSeen: (appId, fingerprint) => shell.markOnboardingSeen(appId, fingerprint),
      answer: (id, decision) => shell.answer(id, decision),
      cancelConfirmation: (id) => shell.cancelConfirmation(id),
    }),
  }, ApplicationsArea))
}

/**
 * Join the `@` menu as the `page` source, once a trigger registry is up. The
 * registration is an effect of the injected scope: the registry appearing later
 * still gets the source, and the source leaves with the shell.
 * @param ctx - the client root context.
 * @param pageContext - the page-context store the source offers as a chip.
 */
function bindReferenceSources(
  ctx: Context,
  shell: ApplicationsShell,
  views: ApplicationViewRegistry,
  pageContext: PageContextService,
  pageSessions: {
    readonly isOwner: (sessionId: string) => boolean
    readonly boundApp: (sessionId: string) => string | undefined
  },
): void {
  ctx.inject(['inputTriggers'], (scope) => {
    const t = ctx.locale.bind(NS)
    const page = createPageSource(pageContext, t, pageSessions)
    const application = createApplicationSource(shell.state, views, pageContext, pageSessions, t)
    scope.effect(() => scope.inputTriggers.registerSource(page), 'applications: page reference source')
    scope.effect(() => scope.inputTriggers.registerSource(application), 'applications: application reference source')
  })
}

/**
 * Bind the sidebar rail entry: the list id IS the main panel key, so the
 * platform's own rail button selects this panel and resolves its label from
 * here.
 * @param ctx - the client root context.
 */
function bindRailEntry(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: APPLICATION_PANEL_KEY,
    order: 0,
    locale: NS,
    label: () => t('panel'),
  }, ApplicationsIcon))
  ctx.slots.inject('sidebar.panellist.trailing', () => ctx.slots.register({
    name: 'sidebar.panellist.trailing',
    id: APPLICATION_PANEL_KEY,
    order: 0,
    locale: NS,
  }, ApplicationsRailBadge))
}

/**
 * Client plugin body: dictionaries, the view registry, the layout preferences,
 * the shell (with its reconnect and teardown), and the panel bindings.
 * @param ctx - the client root context.
 * @returns the disposer unwinding the namespace mount (the Cordis fiber owns
 *   the registrations, effects and the provided service).
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'applications: dictionaries')
  const t = ctx.locale.bind(NS)

  const views = createApplicationViews()
  // Fiber-owned: unregistered with the plugin, woken dependents included.
  ctx.provide('applicationViews', views)

  // The area's own layout preferences (which application, folded or not) —
  // kept apart from business data, drafts and grants, and scoped to this
  // deployment's own storage entry.
  const preferences = createPreferences()

  // The page context the panel's views report into, and the `@page` chip that
  // offers it. Nothing about it survives the mount: both the store and the
  // source die with the fiber (the store's value is only ever as fresh as the
  // view that reported it).
  const pageContext = createPageContext()
  const viewport = createViewport()
  // What the management page shows: the framework instance owns it, so the
  // callbacks bound to an application's pages stay valid across the area
  // unmounting and remounting (`manage.ts` says why).
  const manage = createManageService()
  const dock = createDock()
  const delegation = createDelegation()
  // A registration that goes away takes its scroll positions with it: the
  // memory belongs to this instance and holds nothing for an application the
  // registry no longer has.
  ctx.effect(() => views.subscribe(() => { manage.scroll.retain(new Set(views.views().keys())) }),
    'applications: management scroll memory')

  const opened = await openApplications(ctx)
  const openSession = (sessionId: string): void => {
    const workspace = ctx.get('uiWorkspace') as { openSession?: (id: string) => void } | undefined
    workspace?.openSession?.(sessionId)
  }
  const shell = new ApplicationsShell(opened.remote, {
    initialAppId: preferences.getSnapshot().lastAppId,
    /* v8 ignore next -- the send dialog is exercised through the panel */
    delegationRequest: async record => await delegation.request(record),
    openSession,
  })
  const navigation = createAppNavigation({
    currentAppId: () => shell.state.getSnapshot().activeAppId,
    /* v8 ignore next 11 -- the shell-level navigation location is exercised through UI tests */
    currentLocation: () => {
      const appId = shell.state.getSnapshot().activeAppId
      if (appId === undefined) return undefined
      const page = pageContext.current()
      return {
        appId,
        ...(page?.record === undefined ? {} : { record: page.record }),
        ...(page?.view === undefined ? {} : { view: page.view }),
      }
    },
    select: (appId) => { shell.select(appId) },
  })
  ctx.effect(() => () => { shell.dispose() }, 'applications: shell')
  // Remember where the human was, so a reload comes back to it (a removed
  // application falls back in the area, never silently in storage).
  ctx.effect(() => shell.state.subscribe(() => {
    const { activeAppId } = shell.state.getSnapshot()
    if (activeAppId === undefined || activeAppId === preferences.getSnapshot().lastAppId) return
    preferences.set({ ...preferences.getSnapshot(), lastAppId: activeAppId })
  }), 'applications: last application')
  // The platform's connection owns reconnect; the shell only converges the
  // browser side on the new generation (rows re-read, views re-read, watch
  // stream reopened) — the shell's own doc says why.
  ctx.effect(() => ctx.on('connection/reset', () => { shell.reconnect() }), 'applications: reconnect')

  // The application area's conversation has its own dedicated Session, not the
  // main Session borrowed while the panel is open. The target service creates
  // that Session in a dedicated Workspace on first use and remembers the ids;
  // the pane binds the retained reference exactly as the platform's Session
  // seat expects. The host marks the Session so its scoped tool bridge attaches
  // the application operations to this Agent only.
  let appConversation: AppConversationService | undefined
  const appConversationTargets = (): readonly { readonly workspaceId: string; readonly sessionId: string }[] => appConversation?.targets() ?? []
  let createDevelopment: ((appId: string, path: string) => Promise<string>) | undefined
  let selectDevelopment: ((sessionId: string) => Promise<string | undefined>) | undefined
  let retainDevelopment: ((sessionId: string) => Promise<ConversationSession | undefined>) | undefined
  let retainNormal: ((sessionId: string) => Promise<ConversationSession | undefined>) | undefined
  let titleOf: ((sessionId: string) => string | undefined) | undefined
  let normalChoices: (() => readonly { readonly sessionId: string; readonly title?: string }[]) | undefined
  let archivedSessionIds: () => readonly string[] = () => []
  let developmentSessionId: string | undefined
  /** The dock's displayed Session: only it carries page context. */
  let pageContextSessionId: string | undefined
  /** The development Session whose page context this client last reported. */
  let shownDevelopmentSessionId: string | undefined
  /** Sessions whose page-context attachment the human turned off. */
  const pageContextDisabled = new Set<string>()
  const pagePointer = (): AppConversationPage | undefined => {
    const page = pageContext.current()
    if (page === undefined) return undefined
    return {
      appId: page.appId,
      label: page.label,
      ...(page.record === undefined ? {} : { record: page.record }),
      ...(page.view === undefined ? {} : { view: page.view }),
      ...(page.draftId === undefined ? {} : { draftId: page.draftId }),
      ...(page.selection === undefined ? {} : { selection: page.selection }),
      ...(page.filters === undefined ? {} : { filters: page.filters }),
      ...(page.visibleRange === undefined ? {} : { visibleRange: page.visibleRange }),
      ...(page.dirty === undefined ? {} : { hasUnsavedChanges: page.dirty }),
    }
  }
  const reportPage = (): void => {
    const page = pagePointer()
    const appTarget = appConversation?.target()
    const appVisible = appTarget !== undefined && pageContextSessionId === appTarget.sessionId
    void appConversation?.setPage(appVisible ? page : undefined)
    if (developmentSessionId !== undefined) {
      // A development Session is bound to ONE application. Never feed it a
      // page from another one, and only report while it is the displayed
      // Session with the attachment switched on.
      const boundApp = preferences.getSnapshot().developmentSessions?.find(entry => entry.sessionId === developmentSessionId)?.appId
      const visible = pageContextSessionId === developmentSessionId && !pageContextDisabled.has(developmentSessionId)
      const developmentPage = visible && page !== undefined && page.appId === boundApp ? page : undefined
      /* v8 ignore next -- a page-context transport failure is best effort; the next report retries */
      void opened.remote.setAppConversationContext(developmentSessionId, developmentPage as JsonValue | undefined ?? null).catch(() => {})
    }
  }
  /** Clear one development Session's host page pointer (best effort). */
  const clearDevelopmentContext = (sessionId: string): void => {
    /* v8 ignore next -- a page-context transport failure is best effort; the next report retries */
    void opened.remote.setAppConversationContext(sessionId, null).catch(() => {})
  }
  /** Display one development Session and drop the previous development pointer. */
  const displayDevelopmentSession = (sessionId: string): void => {
    if (shownDevelopmentSessionId !== undefined && shownDevelopmentSessionId !== sessionId) clearDevelopmentContext(shownDevelopmentSessionId)
    shownDevelopmentSessionId = sessionId
    pageContextSessionId = sessionId
    reportPage()
  }
  /** Display one Session and drop a previous development pointer when it changes. */
  const displayContextSession = (sessionId: string | undefined): void => {
    const development = sessionId !== undefined && (sessionId === developmentSessionId
      || (preferences.getSnapshot().developmentSessions ?? []).some(entry => entry.sessionId === sessionId))
    if (shownDevelopmentSessionId !== undefined && shownDevelopmentSessionId !== sessionId) clearDevelopmentContext(shownDevelopmentSessionId)
    shownDevelopmentSessionId = development ? sessionId : undefined
    pageContextSessionId = sessionId
    reportPage()
  }
  ctx.inject(['sessions', 'workspaces'], (scope) => {
    const sessions = scope.get('sessions') as unknown as AppConversationSessions
    const workspaces = scope.get('workspaces') as unknown as AppConversationWorkspaces
    archivedSessionIds = () => sessionRows(sessions)?.archivedSessionIds ?? []
    appConversation = createAppConversation({
      sessions,
      workspaces,
      remote: opened.remote,
      preferences,
    })
    createDevelopment = async (appId, path) => {
      const sessionId = await createDevelopmentSession({ sessions, workspaces, remote: opened.remote }, appId, path)
      const snapshot = preferences.getSnapshot()
      /* v8 ignore next 4 -- the panel's create flow persists this mapping */
      preferences.set({
        ...snapshot,
        developmentSessions: [...(snapshot.developmentSessions ?? []).filter(entry => entry.sessionId !== sessionId), { appId, sessionId }],
      })
      developmentSessionId = sessionId
      displayDevelopmentSession(sessionId)
      return sessionId
    }
    selectDevelopment = async (sessionId) => {
      // Selection only moves the page-context pointer; the pane's single
      // reference comes from retainDevelopment below. Retaining here too would
      // leak one reference (and its event window) per selection.
      developmentSessionId = sessionId
      displayDevelopmentSession(sessionId)
      return sessionId
    }
    retainDevelopment = async (sessionId) => {
      const reference = sessions.retain(sessionId, { source: 'applicationHarnessDock', facets: { conversation: true } })
      developmentSessionId = sessionId
      displayDevelopmentSession(sessionId)
      return reference
    }
    retainNormal = async (sessionId) => sessions.retain(sessionId, { source: 'applicationHarnessDock', facets: { conversation: true } })
    titleOf = (sessionId) => sessionRows(sessions)?.byId[sessionId]?.title
    normalChoices = () => {
      const rows = sessionRows(sessions)?.byId ?? {}
      const appIds = new Set(appConversationTargets().map(target => target.sessionId))
      const devIds = new Set((preferences.getSnapshot().developmentSessions ?? []).map(entry => entry.sessionId))
      const archived = new Set(sessionRows(sessions)?.archivedSessionIds ?? [])
      return Object.entries(rows)
        .filter(([sessionId]) => !appIds.has(sessionId) && !devIds.has(sessionId) && !archived.has(sessionId))
        .map(([sessionId, row]) => ({ sessionId, ...(row.title === undefined ? {} : { title: row.title }) }))
    }
    /** Merge the host's authoritative development bindings into the browser mapping. */
    const reconcileDevelopment = async (): Promise<void> => {
      /* v8 ignore next -- a deployment without the host bridge has no list to merge */
      const result = opened.remote.developmentBindings === undefined
        ? undefined
        : await opened.remote.developmentBindings().catch(() => ({ ok: false as const }))
      if (result !== undefined && !result.ok) return
      /* v8 ignore next -- the failure path above already returned; a missing list is the only absent case */
      const host = result?.ok === true ? result.value : []
      const rows = sessionRows(sessions)
      const live = rows === undefined ? undefined : new Set(Object.keys(rows.byId))
      const archived = new Set(rows?.archivedSessionIds ?? [])
      const current = preferences.getSnapshot().developmentSessions ?? []
      const merged = host.filter(entry => live === undefined || live.has(entry.sessionId))
      for (const entry of current) {
        if (merged.some(candidate => candidate.sessionId === entry.sessionId)) continue
        merged.push(entry)
      }
      preferences.set({ ...preferences.getSnapshot(), developmentSessions: merged })
      if (live === undefined) return
      for (const entry of host) {
        /* v8 ignore next -- only a host binding whose Session is gone needs cleaning */
        if (live.has(entry.sessionId) || archived.has(entry.sessionId) || typeof opened.remote.clearDevelopmentSession !== 'function') continue
        /* v8 ignore next -- cleanup is best effort; the next mount retries */
        try { await opened.remote.clearDevelopmentSession(entry.sessionId) } catch { /* best effort */ }
      }
    }
    void appConversation?.reconcile().catch(() => {})
    void reconcileDevelopment().catch(() => {})
    reportPage()
    return () => { appConversation = undefined; createDevelopment = undefined; selectDevelopment = undefined; retainDevelopment = undefined; retainNormal = undefined; titleOf = undefined; normalChoices = undefined; archivedSessionIds = () => [] }
  })
  // The application area's dedicated conversation follows the page on screen:
  // the browser reports the same pointer the pane's chip shows, and the host
  // context reader verifies it at send time. Leaving the area clears it.
  ctx.effect(() => {
    const stop = pageContext.subscribe(reportPage)
    reportPage()
    return stop
  }, 'applications: application conversation page context')
  // The embedded hero reuses the platform's Workspace navigation, exactly as
  // the main occurrence's `openWorkspace` does. The parent's child declaration
  // and the child's registration share one face.
  const applicationsConversationInjected: ApplicationsConversationInjected = {
    openWorkspace: async (workspaceId, adopt) => {
      const navigation = ctx.get('uiWorkspace') as {
        openWorkspace?: ApplicationsConversationInjected['openWorkspace']
      } | undefined
      if (typeof navigation?.openWorkspace !== 'function') {
        throw new Error('applications: the Workspace UI is not mounted')
      }
      await navigation.openWorkspace(workspaceId, adopt)
    },
  }
  ctx.slots.inject('applications.conversation', () => ctx.slots.register({
    name: 'applications.conversation',
    inject: () => applicationsConversationInjected,
  }, ConversationPanel))
  const pickAppConversationFolder = async (): Promise<string | undefined> => {
    const picker = ctx.get('remote.directoryPicker') as {
      pick(): Promise<{ readonly ok: true; readonly value: string | null } | { readonly ok: false }>
    } | undefined
    if (picker === undefined) return undefined
    try {
      const result = await picker.pick()
      return result.ok && typeof result.value === 'string' ? result.value : undefined
    } catch {
      return undefined
    }
  }
  bindPanel(ctx, applicationsConversationInjected, shell, views, preferences, pageContext, viewport, navigation, manage, dock, delegation,
    async () => await appConversation?.open(),
    appConversationTargets,
    /* v8 ignore next -- panel-only creation action */
    async () => await appConversation!.create(),
    /* v8 ignore next -- panel-only selection action */
    async sessionId => await appConversation?.select(sessionId),
    async path => await appConversation!.setup(path),
    async (appId, path) => {
      /* v8 ignore next -- the inject face exists only after the Session/Workspace services are ready */
      if (createDevelopment === undefined) throw new Error('development sessions are unavailable')
      return await createDevelopment(appId, path)
    },
    appId => {
      const archived = new Set(archivedSessionIds())
      return (preferences.getSnapshot().developmentSessions ?? []).filter(entry => entry.appId === appId && !archived.has(entry.sessionId))
    },
    async sessionId => await selectDevelopment?.(sessionId),
    async sessionId => await retainDevelopment?.(sessionId),
    async sessionId => await retainNormal?.(sessionId),
    sessionId => titleOf?.(sessionId),
    () => normalChoices?.() ?? [],
    async () => {
      const result = await opened.remote.suggestedAppConversationPath()
      /* v8 ignore next -- the generated host method answers with a string; a failed transport rejects, not returns false */
      return result.ok ? result.value : undefined
    },
    pickAppConversationFolder,
    async (enabled, sessionId) => {
      /* v8 ignore next -- the chip always names its Session; the fallback is for older callers */
      const target = sessionId ?? appConversation?.target()?.sessionId
      if (target === undefined) return
      /* v8 ignore next -- a development Session is handled by the disabled-set path below */
      if (appConversation?.target()?.sessionId === target) {
        await appConversation.setContextEnabled(enabled, target)
        return
      }
      /* v8 ignore next -- development attachment is switched by the dock chip */
      if (enabled) pageContextDisabled.delete(target)
      else pageContextDisabled.add(target)
      reportPage()
    },
    (sessionId) => displayContextSession(sessionId),
    () => [appConversation?.target()?.sessionId, developmentSessionId].filter((id): id is string => id !== undefined),
    (appId, listener) => shell.onChanged(appId, listener),
    async (draftId, fields) => {
      const sessionId = appConversation?.target()?.sessionId
      if (sessionId === undefined || typeof opened.remote.shareDraft !== 'function') return false
      const result = await opened.remote.shareDraft(sessionId, draftId, fields)
      return result.ok && result.value
    },
    async (draftId) => {
      const sessionId = appConversation?.target()?.sessionId
      if (sessionId === undefined || typeof opened.remote.revokeDraftShare !== 'function') return false
      const result = await opened.remote.revokeDraftShare(sessionId, draftId)
      return result.ok && result.value
    })
  // The trailing badge needs live state, and the platform's trailing slot
  // declaration carries no business inject face: contribute one root hook.
  ctx.slots.provideRoot({ hooks: { applicationsRail: shell.state, applicationsPreferences: preferences } })
  bindRailEntry(ctx)
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading',
    id: 'applications.session-marker',
    order: 0,
    locale: NS,
  }, SessionRowMarker))
  // The built-in editor's guidance follows the Session's ownership: the
  // application-area conversation and a development conversation mean
  // something different from an ordinary chat.
  ctx.slots.inject('conversation.input.placeholder', () => ctx.slots.register({
    name: 'conversation.input.placeholder',
    priority: 10,
    select: ({ sessionId }) => {
      const hint = composerPlaceholder(
        sessionId,
        appConversationTargets().map(target => target.sessionId),
        preferences.getSnapshot().developmentSessions ?? [],
        (appId) => {
          const view = views.views().get(appId)
          const named = typeof view?.name === 'function' ? view.name() : view?.name
          return named ?? appId
        },
      )
      if (hint === undefined) return null
      const t = ctx.locale.bind(NS)
      return { text: hint.app === undefined ? t('conversation.placeholderApp') : t('conversation.placeholderDevelopment', { app: hint.app }) }
    },
  }, ApplicationsPlaceholder))
  bindReferenceSources(ctx, shell, views, pageContext, {
    isOwner: sessionId => appConversationTargets().some(target => target.sessionId === sessionId)
      || (preferences.getSnapshot().developmentSessions ?? []).some(entry => entry.sessionId === sessionId),
    boundApp: sessionId => (preferences.getSnapshot().developmentSessions ?? []).find(entry => entry.sessionId === sessionId)?.appId,
  })
  // The DSH conversation header offers the same Session to the app-area dock.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'applications.open-in-area',
    order: 10,
  }, (slotProps: HeaderActionProps) => {
    const sessionId = slotProps.sessionId
    const appConversation = appConversationTargets().some(target => target.sessionId === sessionId)
    const development = (preferences.getSnapshot().developmentSessions ?? []).find(entry => entry.sessionId === sessionId)
    const kind: import('./dock.ts').DockTabKind = appConversation ? 'app-conversation' : development !== undefined ? 'development' : 'normal'
    // A normal Session does not belong to the app area; it can still be opened
    // from the dock's add menu. Only the app's own conversations and
    // development Sessions get the header bridge.
    if (kind === 'normal') return null
    return OpenInAreaAction({
      sessionId,
      kind,
      ...(development === undefined ? {} : { appId: development.appId }),
      dock,
      selectPanel: () => { ctx.layout.selectPanel(APPLICATION_PANEL_KEY) },
      label: t('dock.openInArea'),
    })
  }))
  // The ordinary conversation's temporary @ scope: show it and let the human
  // revoke it while the turn is still running.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'applications.turn-scope',
    order: 20,
  }, (slotProps: HeaderActionProps) => {
    const sessionId = slotProps.sessionId
    const owned = appConversationTargets().some(target => target.sessionId === sessionId)
      || (preferences.getSnapshot().developmentSessions ?? []).some(entry => entry.sessionId === sessionId)
    if (owned) return null
    return TurnScopeControl({ sessionId, remote: opened.remote, t })
  }))

  shell.start()
  return async () => { await opened.dispose?.() }
}

export * from './navigation.ts'
