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
 * - it binds the panel: a keyed `main` entry (the application area: navigation,
 *   header, the selected application's page and the management dialog) and the
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
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Side-effect: the shared scale is defined at `:root` (see tokens.module.css).
// Imported here — not in an application view — because the area, the management
// dialog and the sidebar all read it, and the dialog is portalled outside the area.
import './tokens.module.css'
import applicationsRemote from '@matrix1001/dsh-application-harness-host-bridge/remote'
import { APPLICATION_PANEL_KEY } from './panel-key.ts'
import { createApplicationViews, type ApplicationViews } from './views.ts'
import { createPreferences } from './preferences.ts'
import { createEntry, type ApplicationEntryService } from './entry.ts'
import { createViewport, type ViewportService } from './viewport.ts'
import { createManageService, type ManageService } from './manage.ts'
import { ApplicationsShell, type ApplicationsRemote } from './shell.ts'
import { ApplicationsArea, type ApplicationsAreaInjected } from './ApplicationsArea.tsx'
import { ApplicationsIcon } from './ApplicationsIcon.tsx'
import { createPageContext } from './page-context.ts'
import { createAppNavigation } from './navigation.ts'
import type { AppNavigation } from './navigation.ts'
import { createPageSource } from './page-source.ts'
import { createApplicationSource } from './application-source.ts'
import { ConversationPanel } from './ApplicationsConversation.tsx'
import { createAppConversation, type AppConversationSessions, type AppConversationService, type AppConversationWorkspaces } from './app-conversation.ts'
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
export type { ApplicationEntryService, EntryRequest } from './entry.ts'
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
    /**
     * The applications entry: how another surface (the sidebar's own row, the
     * window-chrome controls) tells this framework that a human activated the
     * applications panel. Read OPTIONALLY (`ctx.get`) by whoever wants it — a
     * surface that calls it must not wait for this plugin to be mounted.
     */
    applicationsEntry: ApplicationEntryService
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
export const inject = ['remote', 'slots', 'locale', 'layout']

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
function bindPanel(
  ctx: Context,
  shell: ApplicationsShell,
  views: ApplicationViews,
  preferences: ReturnType<typeof createPreferences>,
  pageContext: PageContextService,
  viewport: ViewportService,
  navigation: AppNavigation,
  entry: ApplicationEntryService,
  manage: ManageService,
  openAppConversation: () => Promise<ConversationSession | undefined>,
  setupAppConversation: (path: string) => Promise<ConversationSession>,
  createDevelopmentSession: (appId: string, path: string) => Promise<string>,
  pickAppConversationFolder: () => Promise<string | undefined>,
  setAppConversationContextEnabled: (enabled: boolean) => Promise<void>,
  appConversationSessionId: () => string | undefined,
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
  ctx.effect(() => shell.onPageCommand(async (command) => {
    if (appConversationSessionId() !== command.sessionId) return undefined
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
      navigation.open({
        appId: command.appId,
        ...(command.view === undefined ? {} : { view: command.view }),
        ...(command.record === undefined ? {} : { record: { kind: command.record.kind, id: command.record.id } }),
      })
      return true
    } catch {
      /* v8 ignore next -- navigation.open is synchronous; the catch keeps a bad command from escaping */
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
    children: { 'applications.conversation': { kind: 'single', scope: 'session' } },
    inject: (): ApplicationsAreaInjected => ({
      hooks: {
        applications: shell.state,
        views,
        preferences,
        viewport,
        entry,
        manage,
        pageContext: { getSnapshot: () => pageContext.current(), subscribe: pageContext.subscribe },
      },
      navigation,
      manageScroll: manage.scroll,
      openAppConversation,
      setupAppConversation,
      createDevelopmentSession,
      openSession: (sessionId) => {
        const workspace = ctx.get('uiWorkspace') as { openSession?: (id: string) => void } | undefined
        workspace?.openSession?.(sessionId)
      },
      pickAppConversationFolder,
      setAppConversationContextEnabled,
      loadTasks: () => { void shell.loadTasks() },
      openManage: (request) => { manage.open(request) },
      closeManage: () => { manage.close() },
      consumeEntry: () => entry.consume(),
      select: (appId) => { if (appId !== undefined) void navigation.select(appId) },
      refresh: () => { void shell.refresh() },
      setNavExpanded: (expanded) => { preferences.set({ ...preferences.getSnapshot(), navExpanded: expanded }) },
      setNavOrder: (order) => { preferences.set({ ...preferences.getSnapshot(), navOrder: [...order] }) },
      close: () => { ctx.layout.selectPanel(null) },
      releaseClaims: (appId) => { shell.releaseClaims(appId) },
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
      restoreData: (appId, backupPath, previewFingerprint, planId, requestId) => shell.restoreData(appId, backupPath, previewFingerprint, planId, requestId),
      exportData: (appId) => shell.dataExport(appId),
      previewDataImport: (appId, json) => shell.previewDataImport(appId, json),
      importData: (appId, json, planId, requestId) => shell.importData(appId, json, planId, requestId),
      reloadImportedData: (appId) => shell.dataReload(appId),
      pruneBackups: (keep) => shell.pruneBackups(keep),
      loadGrants: () => { void shell.loadGrants() },
      loadPolicies: () => { void shell.loadPolicies() },
      setPolicy: (appId, op, policy) => shell.setPolicy(appId, op, policy),
      setActivation: (appId, activation) => shell.setActivation(appId, activation),
      setAppModel: (appId, selection) => shell.setAppModel(appId, selection),
      loadModelCatalog: () => shell.modelCatalog(),
      loadModelUsage: (appId) => shell.modelUsage(appId),
      loadModelLimits: (appId) => shell.modelLimits(appId),
      loadCredentials: (appId) => shell.credentials(appId),
      setCredential: (appId, name, value) => shell.setCredential(appId, name, value),
      deleteCredential: (appId, name) => shell.deleteCredential(appId, name),
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
): void {
  ctx.inject(['inputTriggers'], (scope) => {
    const t = ctx.locale.bind(NS)
    const page = createPageSource(pageContext, t)
    const application = createApplicationSource(shell.state, views, pageContext, t)
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
  // The entry another surface (the sidebar, the window chrome) activates: it
  // owns the panel id and the one-shot request, so a second activation of the
  // SAME entry still means something (`entry.ts` says why).
  const entry = createEntry(APPLICATION_PANEL_KEY, {
    activePanelId: () => ctx.layout.panelInfo.getSnapshot().activePanelId,
    selectPanel: (id) => { ctx.layout.selectPanel(id as Parameters<typeof ctx.layout.selectPanel>[0]) },
  })
  ctx.provide('applicationsEntry', entry)
  // What the management dialog shows: the framework instance owns it, so the
  // callbacks bound to an application's pages stay valid across the area
  // unmounting and remounting (`manage.ts` says why).
  const manage = createManageService()
  // A registration that goes away takes its scroll positions with it: the
  // memory belongs to this instance and holds nothing for an application the
  // registry no longer has.
  ctx.effect(() => views.subscribe(() => { manage.scroll.retain(new Set(views.views().keys())) }),
    'applications: management scroll memory')

  const opened = await openApplications(ctx)
  const shell = new ApplicationsShell(opened.remote, { initialAppId: preferences.getSnapshot().lastAppId })
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
  let createDevelopment: ((appId: string, path: string) => Promise<string>) | undefined
  const reportPage = (): void => {
    const page = pageContext.current()
    void appConversation?.setPage(page === undefined ? undefined : {
      appId: page.appId,
      label: page.label,
      ...(page.record === undefined ? {} : { record: page.record }),
    })
  }
  ctx.inject(['sessions', 'workspaces'], (scope) => {
    const sessions = scope.get('sessions') as unknown as AppConversationSessions
    const workspaces = scope.get('workspaces') as unknown as AppConversationWorkspaces
    appConversation = createAppConversation({
      sessions,
      workspaces,
      remote: opened.remote,
      preferences,
    })
    createDevelopment = async (appId, path) => await createDevelopmentSession({ sessions, workspaces, remote: opened.remote }, appId, path)
    reportPage()
    return () => { appConversation = undefined; createDevelopment = undefined }
  })
  // The application area's dedicated conversation follows the page on screen:
  // the browser reports the same pointer the pane's chip shows, and the host
  // context reader verifies it at send time. Leaving the area clears it.
  ctx.effect(() => {
    const stop = pageContext.subscribe(reportPage)
    reportPage()
    return stop
  }, 'applications: application conversation page context')
  ctx.slots.inject('applications.conversation', () => ctx.slots.register({
    name: 'applications.conversation',
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
  bindPanel(ctx, shell, views, preferences, pageContext, viewport, navigation, entry, manage,
    async () => await appConversation?.open(),
    async path => await appConversation!.setup(path),
    async (appId, path) => {
      /* v8 ignore next -- the inject face exists only after the Session/Workspace services are ready */
      if (createDevelopment === undefined) throw new Error('development sessions are unavailable')
      return await createDevelopment(appId, path)
    },
    pickAppConversationFolder,
    async enabled => await appConversation?.setContextEnabled(enabled),
    () => appConversation?.target()?.sessionId,
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
  bindRailEntry(ctx)
  bindReferenceSources(ctx, shell, views, pageContext)

  shell.start()
  return async () => { await opened.dispose?.() }
}

export * from './navigation.ts'
