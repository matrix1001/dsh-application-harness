/**
 * The shared browser contract of the applications shell: what a client package
 * registers into `ctx.applicationViews`, what the shell hands back to the
 * registered view, and the page-context vocabulary a view reports itself
 * through (the shell's own store is `page-context.ts`, and the reference chip
 * that reads it is `page-source.ts`). Types only — the behaviour lives in the
 * registry (`views.ts`) and the shell (`shell.ts`); a consumer names this
 * module through the package's `./client` outlet (cross-plugin collaboration
 * is `import type` + a Cordis service, never a value import).
 *
 * The view vocabulary is written in the host bridge's own browser face
 * (`CallOutcome`, `JsonValue`): the shell is a view OF that surface, so the
 * types a view renders are the same declarations the wire carries.
 * @module @matrix1001/dsh-application-harness-client-applications/client
 */

import type { CallOutcome, JsonValue, ObjectRef, ObjectResolution } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ReactNode } from 'react'

/**
 * The record families a page can cite. The vocabulary is the wire's own: the
 * page reference chip serializes a citation into the prompt, and the host half
 * (`@matrix1001/dsh-application-harness-context`) reads exactly these kinds back.
 */
export type PageRecordKind = string

/** One record inside one application, as a page cites it. */
export interface PageRecordRef {
  /**
   * The application that owns the record. Optional for legacy reports, where
   * the kind names exactly one application; new pages set it explicitly so a
   * record can be opened or cited across applications.
   */
  readonly appId?: string
  /** Which family the record belongs to. */
  readonly kind: PageRecordKind
  /** The record's id inside that family. */
  readonly id: string
  /** A display label the citing page knew; never a substitute for reading the record. */
  readonly label?: string
}

/**
 * What one page reports about itself. Necessary references only: the page
 * names the application's record it is showing and says what it calls itself —
 * never the record's content, never the DOM, never a draft. The host reads the
 * record's own facts from the application at send time, so nothing here can
 * go stale in the message.
 */
export interface PageContextInput {
  /** The record the page is showing, when it is showing one. */
  readonly record?: PageRecordRef
  /** Other records the page has selected, when the surface is a multi-selection. */
  readonly selection?: readonly PageRecordRef[]
  /** The view key the page is drawing (its tab/list/reader). */
  readonly view?: string
  /** The page-defined draft id, when the page is editing one. */
  readonly draftId?: string
  /**
   * The date range currently visible, when the page has one. ISO dates only;
   * the context says what is visible, never what the records contain.
   */
  readonly visibleRange?: { readonly from?: string; readonly to?: string }
  /** Bounded filter values the page is applying; no bodies, drafts or result sets. */
  readonly filters?: Readonly<Record<string, string | number | boolean | null>>
  /** Whether the page has unsaved input; the input itself is never shared. */
  readonly dirty?: boolean
  /**
   * A short page-authored line about the selection itself (which surface the
   * user is on, what they picked) — shown on the reference row, never sent.
   */
  readonly selectionNote?: string
  /** What this page calls the selection, as the reference row and chip show it. */
  readonly label: string
}

/** One page's reported context: the input stamped with the application the shell rendered. */
export interface PageContext extends PageContextInput {
  /** The application whose page reported it. */
  readonly appId: string
}

/**
 * The face a view reports through. One method, returning its own undo: React
 * views report from an effect (`useEffect(() => page.report({…}))`), so an
 * unchanged page keeps the context alive, a changed selection replaces it in
 * the same step, and unmounting clears it — the three rules the page context
 * has, expressed as the one thing a view is already doing.
 */
export interface PageContextFace {
  /**
   * Report (or refresh) this page's context.
   * @param input - what the page is showing right now.
   * @returns the disposer that clears this report (a no-op once a newer report replaced it).
   */
  report(input: PageContextInput): () => void
}

/**
 * The page-context registry the plugin owns: the one place the current page's
 * context lives. Reporting is owner-stamped (the shell knows which application
 * it rendered), so a view can only ever speak for its own page.
 */
export interface PageContextService {
  /** What the page on screen reports, or undefined when no page is showing. */
  current(): PageContext | undefined
  /**
   * Record one application page's context.
   * @param appId - the application the reporting view draws.
   * @param input - what that page is showing.
   * @returns the disposer that clears this report (a no-op once a newer report replaced it).
   */
  report(appId: string, input: PageContextInput): () => void
  /**
   * Observe changes to the current page context. The application area uses it
   * to keep the dedicated conversation's current-page pointer in step.
   * @param listener - called after a report or a cleanup changed the current page.
   * @returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void
}

/**
 * What one page reports about its viewport: which view it is drawing and
 * whether that view has settled. The FRAMEWORK owns the business surface's
 * outer scroll, so it is the framework that remembers where the reader was per
 * view — the page only says which view this is and when its content is ready
 * to be scrolled into. Pure view plumbing: no business data, no page
 * reference, nothing that could go stale in a message.
 */
export interface ViewportInput {
  /**
   * A stable name for the view on screen — the page's own vocabulary (its tab,
   * its mode, the record it opened). Two different views must never share one
   * key, and the same view must keep its key across repaints.
   */
  readonly key: string
  /**
   * Whether the data this view draws has settled and its layout is committed.
   * The framework restores the remembered position when this turns true, and
   * waits while it is false.
   */
  readonly ready: boolean
}

/**
 * The face a page reports its viewport through. Same lifecycle rules as the
 * page context: report from an effect, the newest report wins, and the
 * returned disposer clears only its own report.
 */
export interface ApplicationViewportFace {
  /**
   * Report (or refresh) the view this page is drawing.
   * @param input - the view's key and whether it is ready.
   * @returns the disposer that clears this report (a no-op once a newer report replaced it).
   */
  report(input: ViewportInput): () => void
}

/**
 * The shell's own half of a view's props. Every call a view makes rides the
 * shell's single path, so in-flight state, cancellation, the recorded outcome
 * and the change fan are the shell's to keep — a view never talks to the
 * Remote face itself.
 */
/** One fixed page action delivered to a page controller. */
export interface PageAction {
  readonly action: 'set-filters' | 'select'
  readonly input: JsonValue
}

/** One explicitly shared draft read by the owner page controller. */
export interface PageDraftResult {
  readonly revision: string
  readonly values: JsonValue
}

/** The page's draft-share and controller face. */
export interface PageDraftsFace {
  /** Record the user's explicit share; values stay in the page. */
  share(input: { readonly draftId: string; readonly fields?: readonly string[] }): Promise<boolean>
  /** Withdraw one draft share. */
  revoke(input: { readonly draftId: string }): Promise<boolean>
  /** Register the read handler for shared drafts. */
  onRead(handler: (input: { readonly draftId: string; readonly fields?: readonly string[] }) => PageDraftResult | Promise<PageDraftResult>): () => void
  /**
   * Register the update handler. It must compare the supplied revision and
   * return `{ conflict: true }` when the editor moved on.
   */
  onUpdate(handler: (input: { readonly draftId: string; readonly revision: string; readonly values: JsonValue }) => PageDraftResult | { readonly conflict: true } | Promise<PageDraftResult | { readonly conflict: true }>): () => void
}

/** The page controller's fixed-action registration face. */
export interface PageActionFace {
  /**
   * Register the handler for set-filters/select. Returning false refuses the
   * action; returning undefined/true accepts it. The disposer unregisters.
   */
  onAction(handler: (action: PageAction['action'], input: JsonValue) => boolean | void | Promise<boolean | void>): () => void
}

export interface ApplicationViewData {
  /**
   * Call one operation of THIS application. `args` is the operation's JSON
   * arguments; when `requestId` is omitted the shell mints one. The outcome is
   * the runtime's own four-way result (ok / rejected / failed / cancelled);
   * an outcome that never arrived (a broken carrier, an unloaded method)
   * rejects with the Remote error instead of being faked as one of the four.
   */
  call: (op: string, args: JsonValue, requestId?: string) => Promise<CallOutcome>
  /** Cancel one in-flight call by the `requestId` it was started with. */
  cancel: (requestId: string) => void
  /** Register this page's fixed-action controller (set-filters/select). */
  pageActions?: PageActionFace
  /** Register this page's explicit draft sharing/read face. */
  drafts?: PageDraftsFace
  /**
   * Resolve one object reference through its owning application's declared
   * resolver. It is optional for embedded/test pages; production views get it.
   */
  resolveObject?: (ref: ObjectRef) => Promise<ObjectResolution>
  /** Ask the host to cancel one background task; the watch frame reports the state. */
  cancelTask?: (taskId: string) => void
  /**
   * Take over the display of ONE call's ordinary progress rows: from here on
   * the framework's surface stops drawing them for this application — the shell
   * still records the notices, so the take-over only changes what the human
   * sees, never what the shell knows — because the page draws that call's
   * feedback itself. Only the ordinary progress list is ever filtered: the
   * connection, error and permission notices are not a page's to hide.
   *
   * The claim is the APPLICATION's (it hides the rows of this application's
   * call, never another application's) and it ends with the call it named: it
   * is dropped when the call settles, when the returned function is called, and
   * when this application's page unmounts. A release arriving after any of
   * those is a no-op — in particular it can never touch a newer call that
   * reuses the id.
   * @param requestId - the id this application called (or is about to call) the operation with.
   * @returns the function that hands the display back (idempotent).
   */
  claimProgress: (requestId: string) => () => void
  /**
   * Subscribe to this application's data changes (the shell filters the watch
   * stream's `changed` frames to this appId, and fires on reconnect so a view
   * re-reads). Returns the unsubscribe.
   */
  onChanged: (listener: () => void) => () => void
  /** Whether a call of this application is in flight right now (disable interactions while true). */
  running: boolean
}

/**
 * One application's own view state, as the framework keeps it: an open map of
 * JSON fields the application defines and owns (which tab it is on, which
 * record it selected, what the human has typed into a form and not applied
 * yet). The framework stores and scopes the map, never interprets it.
 *
 * The scope is exactly one browser page: the store lives beside the
 * registration, outlives any one React mount (switching application unmounts
 * the page; coming back must not forget what the human chose) and dies with
 * the registration — it is never written to browser storage, a page reference,
 * the call history or a log. Surviving a RELOAD is the application's own
 * business: its drafts, its repository list, its remembered tab belong to its
 * own storage, and this framework copy would come back pointing at records the
 * page has to re-validate anyway.
 *
 * What may be stored is JSON DATA the application defines and namespaces: a
 * form draft (credentials included — nothing here is persisted or echoed
 * anywhere), a filter, a selection. What may NOT is anything alive: a
 * component, a service, a DOM node, a Promise, a subscription handle. A field
 * only has meaning for the registration that wrote it.
 */
export interface ApplicationUiStore {
  /** The current fields, as one immutable snapshot. */
  getSnapshot(): ApplicationUiState
  /**
   * Merge fields into the state. Fields not named keep their value, so a page
   * writes only what it changed; a field set to `undefined` is removed (the
   * explicit way to clear one — the map never holds an `undefined` value).
   * @param patch - the fields to merge, or to drop.
   */
  set(patch: ApplicationUiPatch): void
  /** Subscribe to state changes. @returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

/** The fields of one application's view state (see {@link ApplicationUiStore}). */
export type ApplicationUiState = Readonly<Record<string, JsonValue>>

/** One write into the view state: the named fields, with `undefined` dropping a field. */
export type ApplicationUiPatch = Readonly<Record<string, JsonValue | undefined>>

/** One cross-application record destination. */
export interface RouteIntent {
  /** The application whose page should open. */
  readonly appId: string
  /** The record to open, when the destination names one. */
  readonly record?: PageRecordRef
  /** A destination-owned view key (tab/list/reader). */
  readonly view?: string
  /** Changes on every navigation so a page can consume the same target again. */
  readonly nonce: string
}

/** What a page may ask the shell to do with another application's record. */
export interface AppNavigationFace {
  /** Open a registered application page at a record. User-initiated only. */
  open(input: { appId: string; record?: PageRecordRef; view?: string }): void
  /** Return to the page this one was opened from, when there is one. */
  back(): void
  /** Whether a cross-application return destination exists. */
  canBack(): boolean
}

/** A page's own guard against leaving with unsaved input. */
export type LeaveGuard = () => boolean | Promise<boolean>

/**
 * The complete props a registered page is rendered with: the shell's data
 * surface, the page-context face the plugin that owns the context composes on
 * top (the shell itself knows only the application's data), and this
 * application's own view state.
 */
export interface ApplicationViewProps extends ApplicationViewData {
  /**
   * Report what this page is showing, so the human can attach the page — or the
   * record on it — to a message. The report lives exactly as long as the
   * mounted view: reporting from an effect updates it in place and its cleanup
   * clears it, so a page switch or an unmount cannot leave a stale page behind.
   */
  readonly pageContext: PageContextFace
  /**
   * Open this application's own management page (the same modal the header's
   * menu opens), already bound to THIS application: the callback is a typed
   * way into a permission or settings page, never a way to manage another
   * application or to switch the page underneath. It grants nothing — the
   * permission tab it may open is where the human decides.
   */
  readonly openManagement: (tab: ManageTab) => void
  /**
   * Report which view this page draws and when it is ready, so the framework
   * can give the reader their scroll position back when they return to it
   * (see {@link ApplicationViewportFace}).
   */
  readonly viewport: ApplicationViewportFace
  /** This application's own view state (see {@link ApplicationUiStore}). */
  readonly ui: ApplicationUiStore
  /** The one-shot record destination when this page was opened from another application. */
  readonly route?: RouteIntent
  /** Cross-application navigation, when the shell provides it. */
  readonly navigation?: AppNavigationFace
  /**
   * Register the page's own leave guard. The shell consults it before a
   * cross-application open, back, or direct application switch. Returns the
   * disposer that unregisters this guard.
   */
  readonly registerLeaveGuard?: (guard: LeaveGuard) => () => void
}

/**
 * What one application's settings page is rendered with. Settings are the
 * application's own business surface (the managed application is named, so a
 * settings page can never mistake the panel's current page for its subject),
 * and deliberately carry NO page context: managing an application is not
 * showing one of its records, so it must not become the conversation's
 * reference.
 */
export interface ApplicationSettingsProps extends ApplicationViewData {
  /** The application these settings belong to. */
  readonly appId: string
  /** That application's own view state (see {@link ApplicationUiStore}). */
  readonly ui: ApplicationUiStore
  /**
   * Open this application's management page at one tab — the settings page's
   * own way to a permission the host refused, bound to this application (see
   * {@link ApplicationViewProps.openManagement}).
   */
  readonly openManagement: (tab: ManageTab) => void
}

/**
 * One tab of the management detail. Declared here, in the client contract,
 * rather than beside the dialog that renders it: a page names a tab through the
 * callback it was handed, and a public prop must not depend on a React
 * component module.
 */
export type ManageTab = 'settings' | 'permissions' | 'history' | 'info' | 'data' | 'developer' | 'tasks'

/** What the management dialog is showing: the list (no appId) or one application's detail. */
export interface ManageRequest {
  /** The application being managed; absent shows the list. */
  readonly appId?: string | undefined
  /** The detail tab; ignored for the list. */
  readonly tab: ManageTab
}

/**
 * The semantic tones a registration may paint its icon in. Deliberately a
 * SHORT list, mapped to the theme's own state variables: a registration picks a
 * meaning, never a colour (the same tone must read on a light and a dark
 * theme, and only the theme knows how).
 */
export type ApplicationTone = 'neutral' | 'business' | 'success' | 'warn' | 'error'

/**
 * One application's icon: a presentational glyph the framework renders at the
 * size the place needs (the navigation row, the switcher, the management list).
 * The platform's own icon set, never a second library — and a registration that
 * declares none gets the framework's neutral fallback.
 */
export type ApplicationIcon = (props: { readonly size: number }) => ReactNode

/**
 * One application's contribution to the framework, as the package that owns
 * the application declares it. Both halves are optional — an application may
 * provide a page, a settings page, or both — and at least one must be present:
 * a registration that draws nothing would only take the application's id.
 * Technical identity (id, version, status, declared needs) is NOT declared
 * here: it comes from the host's application row, so a client copy cannot
 * drift from the truth. What IS declared here is presentation the host has no
 * opinion about: the name the human reads, the icon, the tone.
 */
export interface ApplicationView {
  /**
   * Display name for the navigation and the management list; the application's
   * own declared name when absent. A GETTER is how a localized name stays
   * localized: the registration runs once, the getter runs per render.
   */
  name?: string | (() => string)
  /**
   * One short line about what the application is FOR, shown under the name in
   * the management list and the detail header. The application's own words about
   * its user-facing purpose — deliberately separate from the host's `description`
   * (the row the application declared to the host, which stays the truth in the
   * info tab). Absent: the row simply shows no second line. A getter keeps it
   * localized exactly like {@link ApplicationView.name}.
   */
  description?: string | (() => string)
  /** The glyph this application shows wherever the framework names it. */
  icon?: ApplicationIcon
  /** The tone the glyph is painted in (the default is neutral). */
  tone?: ApplicationTone
  /**
   * How the page divides up the height the area gives it.
   *
   * - `flow` (the default, and every registration that declares nothing): the
   *   page is an ordinary block, the outer `.surface` scrolls it, and the
   *   framework gives the reader their position back per reported view key;
   * - `fill`: the framework hands the page the height really left beside the
   *   notices, and the application's own list/body scrolls inside it. The outer
   *   element keeps no business position for this page — the application keeps
   *   its own. The page's own root container must claim that height itself
   *   (`flex: 1 1 auto` with `min-height: 0`): nothing grows a plain block root,
   *   and a page that does not claim it falls back to the outer scroller while
   *   the outer position memory stays off.
   *
   * Resolved at render time (`AppSurface`); the registry stores the field as
   * declared.
   */
  contentLayout?: 'flow' | 'fill'
  /** The application's page; the framework renders it as the business surface. */
  Component?: (props: ApplicationViewProps) => ReactNode
  /**
   * The application's settings content, rendered inside the management dialog's
   * settings tab (the tab is hidden when the application provides none). The
   * application reads, validates, saves and applies its own settings through
   * the same call face as its page.
   */
  Settings?: (props: ApplicationSettingsProps) => ReactNode
}

/** The `ctx.applicationViews` surface: the one registry client packages register their pages into. */
export interface ApplicationViewRegistry {
  /**
   * Register one application's contribution. One registration per appId:
   * registering a second throws (a silent override would hide a package
   * conflict), and a declaration with neither a page nor settings throws (it
   * would take the id and draw nothing).
   * @param appId - the application the registration draws.
   * @param view - the page and/or settings declaration.
   * @returns the unregister function (idempotent; it also drops the application's view state).
   */
  register(appId: string, view: ApplicationView): () => void
  /** The current registry, as a read-only snapshot. */
  views(): ReadonlyMap<string, ApplicationView>
  /**
   * One application's view state, created on first use and kept for the
   * registration's life (see {@link ApplicationUiStore}).
   * @param appId - the application whose state to read.
   * @returns the store; distinct applications never share one.
   */
  state(appId: string): ApplicationUiStore
}
