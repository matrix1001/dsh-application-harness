/**
 * Pure derivations of the application area: how a row's lifecycle state is
 * named, which half of the permission vocabulary a declared need belongs to,
 * who a caller is in words, and which grants and history records belong to one
 * application. No React and no wire calls — every function here is exercised
 * as plain data in tests, and the components render what these return.
 * @module @matrix1001/dsh-application-harness-client-applications/client/model
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AppInfo, AppStatus, Caller, CapabilityGrant, HistoryRecord, PendingConfirmation,
} from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationView } from './contract.ts'
import type { ApplicationsState } from './shell.ts'
import type { ApplicationsKey } from './locales.ts'

/** Lifecycle status to its localized caption. */
export const RUNTIME_KEYS: Record<import('@matrix1001/dsh-application-harness-host-bridge/client').RuntimeState, ApplicationsKey> = {
  stopped: 'runtime.stopped',
  starting: 'runtime.starting',
  ready: 'runtime.ready',
  stopping: 'runtime.stopping',
}

/** Derive the legacy lifecycle caption from the public runtime/activation/reason axis. */
export function statusOf(app: Pick<AppInfo, 'runtime' | 'activation' | 'health' | 'reason'>): AppStatus {
  if (app.reason === 'platform.stop-incomplete') return 'stop-incomplete'
  if (app.reason === 'platform.start-failed' || app.reason === 'platform.health-failed') return 'failed'
  if (app.activation === 'disabled') return 'stopped'
  if (app.runtime === 'ready') return 'available'
  if (app.runtime === 'starting') return 'starting'
  if (app.runtime === 'stopping') return 'stopping'
  return 'stopped'
}

export const STATUS_KEYS: Record<AppStatus, ApplicationsKey> = {
  starting: 'status.starting',
  available: 'status.available',
  stopping: 'status.stopping',
  stopped: 'status.stopped',
  'stop-incomplete': 'status.stop-incomplete',
  failed: 'status.failed',
}

/** Whether one registration draws a business page (settings alone is not a page). */
export function hasPage(view: ApplicationView | undefined): boolean {
  return view?.Component !== undefined
}

/**
 * Whether the first-run permission prompt is still owed for one application:
 * the page is available, both reads answered, at least one declared platform
 * capability is missing, and this exact capability set was never answered. The
 * prompt and the shell's permission status share this predicate so the status
 * never repeats the card over it.
 * @param app - the application on screen.
 * @param state - the shell's live state.
 * @returns true when the first-run prompt should render.
 */
export function onboardingPending(app: AppInfo | undefined, state: ApplicationsState): boolean {
  if (app === undefined || statusOf(app) !== 'available') return false
  if (!state.grantsLoaded || !state.onboardingLoaded) return false
  const capabilities = capabilityNeeds(app)
  if (capabilities.length === 0) return false
  const caller = { kind: 'app', appId: app.id } as const
  if (capabilities.every(need => grantedTo(state.grants, caller, need))) return false
  const process = app.process
  const fingerprint = [
    ...[...capabilities].sort(),
    ...(process === undefined ? [] : [`process:${process.map(entry => `${entry.executable}:${[...entry.commands].sort().join(',')}:${entry.purpose}`).join(';')}`]),
  ].join('|')
  return state.onboarding?.apps[app.id]?.fingerprint !== fingerprint
}

/**
 * Whether any application-area conversation is waiting for a human answer.
 *
 * Session status is owned by the platform conversation UI; this projection is
 * the shell's fallback when the dock is closed and its tab badge is not on
 * screen. Normal Sessions outside the application area are intentionally not
 * included.
 * @param targets - the application-area conversation targets.
 * @param statuses - the Session-status snapshot keyed by Session id.
 * @returns true when one of those Sessions has a pending interaction.
 */
export function dockNeedsAnswer(
  targets: readonly { readonly sessionId: string }[],
  statuses: ReadonlyMap<string, { readonly pendingInteraction?: unknown }>,
): boolean {
  return targets.some(target => statuses.get(target.sessionId)?.pendingInteraction !== undefined)
}

/** The dock dot tone, in the order the platform's Session facts take precedence. */
export type DockStatusTone = 'attention' | 'running' | 'failed' | 'unread'

/** The locale key naming one dock dot tone. */
export type DockStatusLabelKey =
  | 'dock.statusAttention'
  | 'dock.statusRunning'
  | 'dock.statusFailed'
  | 'dock.statusUnread'

/** The Session facts the dock dot reads (the platform status shape it needs). */
export interface DockSessionStatus {
  readonly running?: boolean | undefined
  readonly pendingInteraction?: unknown
  readonly completionUnread?: boolean
  readonly completionFailed?: boolean
}

/**
 * Resolve the one dot a dock tab shows, or none.
 *
 * Precedence follows the platform status semantics: a pending interaction needs
 * the human, a running turn is progress, a failed unread turn must not read as
 * an ordinary new result, and only then does an unread completion show. The
 * failed state is a separate field because `completionUnread` alone cannot say
 * whether the turn succeeded.
 * @param status - the platform status for one Session, when known.
 * @returns the tone and its locale key, or undefined for an idle Session.
 */
export function dockStatusOf(status: DockSessionStatus | undefined): {
  readonly tone: DockStatusTone
  readonly labelKey: DockStatusLabelKey
} | undefined {
  if (status === undefined) return undefined
  if (status.pendingInteraction !== undefined) return { tone: 'attention', labelKey: 'dock.statusAttention' }
  if (status.running === true) return { tone: 'running', labelKey: 'dock.statusRunning' }
  if (status.completionFailed === true) return { tone: 'failed', labelKey: 'dock.statusFailed' }
  if (status.completionUnread === true) return { tone: 'unread', labelKey: 'dock.statusUnread' }
  return undefined
}

/** The composer guidance this plugin contributes for one Session, by locale key. */
export type ComposerPlaceholderKey = 'conversation.placeholderApp' | 'conversation.placeholderDevelopment'

/** One composer guidance hint: the key and, for a development Session, its application name. */
export interface ComposerPlaceholderHint {
  readonly key: ComposerPlaceholderKey
  readonly app?: string
}

/**
 * Select the composer guidance for one Session.
 *
 * The application-area conversation and the development conversation are the
 * two owner Sessions whose input means something different from an ordinary
 * chat; every other Session returns undefined and keeps the platform prompt.
 * @param sessionId - the Session the editor shows.
 * @param appSessionIds - the remembered application-area Sessions.
 * @param developmentSessions - the remembered development Session bindings.
 * @param appName - resolves one application's display name.
 * @returns the hint, or undefined for an ordinary Session.
 */
export function composerPlaceholder(
  sessionId: string,
  appSessionIds: readonly string[],
  developmentSessions: readonly { readonly sessionId: string; readonly appId: string }[],
  appName: (appId: string) => string,
): ComposerPlaceholderHint | undefined {
  if (appSessionIds.includes(sessionId)) return { key: 'conversation.placeholderApp' }
  const development = developmentSessions.find(entry => entry.sessionId === sessionId)
  return development === undefined
    ? undefined
    : { key: 'conversation.placeholderDevelopment', app: appName(development.appId) }
}

/** How one application's lifecycle and health read in a compact tab or menu row. */
export interface AppStatusView {
  /** The localized status; absent when the application is ready and healthy. */
  readonly label: string | undefined
  /** The dot tone the compact surfaces paint. */
  readonly tone: 'ok' | 'warn' | 'error' | 'idle'
}

/**
 * Derive the compact status presentation for one application.
 * @param app - the application row.
 * @param t - the applications dictionary.
 * @returns the optional label and the dot tone.
 */
export function statusView(app: Pick<AppInfo, 'runtime' | 'activation' | 'health' | 'reason'>, t: TranslateNS<'applications'>, pendingApproval = false): AppStatusView {
  // Before the human has answered the first-run capability card, "degraded"
  // describes the not-yet-approved state in engineering terms and reads like a
  // fault. The tab says "needs approval" until that decision is made.
  if (pendingApproval && statusOf(app) === 'available') return { label: t('status.pending').trim(), tone: 'warn' }
  const status = statusOf(app)
  if (status === 'available') {
    if (app.health === 'degraded') return { label: t('status.degraded').trim(), tone: 'warn' }
    return { label: undefined, tone: 'ok' }
  }
  const tone = status === 'failed' || status === 'stop-incomplete'
    ? 'error'
    : status === 'stopped'
      ? 'idle'
      : 'warn'
  return { label: t(STATUS_KEYS[status]).trim(), tone }
}

/**
 * The navigation's order: the human's saved order first (ids that no longer
 * exist are ignored), then the host's own order for everything the saved list
 * does not name. A new application therefore lands at the END, and removing one
 * never shifts the others.
 * @param apps - the applications that have a page, in host order.
 * @param saved - the human's saved id order (empty = host order).
 * @returns the rows in the order the navigation renders them.
 */


/**
 * Split the page applications into the fixed tab strip and the unpinned menu.
 * With no explicit list every page application is fixed; with one, only the
 * named rows are fixed and the current application is kept as a temporary tab
 * when it is not in that list.
 * @param apps - page applications in host order.
 * @param pinned - the human's fixed list, or undefined for "all fixed".
 * @param activeId - the application whose page is showing.
 * @returns the fixed rows, the unpinned rows and the tabs (fixed + temporary).
 */
export function splitPinnedTabs(
  apps: readonly AppInfo[],
  pinned: readonly string[] | undefined,
  activeId: string | undefined,
): { readonly pinned: readonly AppInfo[]; readonly unpinned: readonly AppInfo[]; readonly tabs: readonly AppInfo[]; readonly temporary: AppInfo | undefined } {
  if (pinned === undefined) {
    return { pinned: [...apps], unpinned: [], tabs: [...apps], temporary: undefined }
  }
  const fixed: AppInfo[] = []
  const seen = new Set<string>()
  const byId = new Map(apps.map(app => [app.id, app]))
  for (const id of pinned) {
    if (seen.has(id)) continue
    const app = byId.get(id)
    if (app === undefined) continue
    seen.add(id)
    fixed.push(app)
  }
  const unpinned = apps.filter(app => !seen.has(app.id))
  const temporary = activeId === undefined ? undefined : unpinned.find(app => app.id === activeId)
  return { pinned: fixed, unpinned, temporary, tabs: temporary === undefined ? fixed : [...fixed, temporary] }
}

/**
 * One drag's reorder: move `id` before the row currently at `beforeIndex`
 * (0..length; the original list's index, not the post-removal one).
 * @param ids - the current order.
 * @param id - the dragged id.
 * @param beforeIndex - the row it should land before.
 * @returns the new order (unchanged when the id is absent or already there).
 */
export function moveIdBefore(ids: readonly string[], id: string, beforeIndex: number): string[] {
  const from = ids.indexOf(id)
  if (from === -1) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  const at = from < beforeIndex ? beforeIndex - 1 : beforeIndex
  next.splice(Math.max(0, Math.min(at, next.length)), 0, id)
  return next
}

/**
 * One keyboard step: move `id` one slot up or down.
 * @param ids - the current order.
 * @param id - the row's id.
 * @param delta - -1 (up) or 1 (down).
 * @returns the new order (unchanged at the ends).
 */
export function moveApplicationBy(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= ids.length) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/**
 * The insertion slot under one pointer position: the first row whose midpoint
 * is to the right of the pointer, or the end when every row is to its left.
 * Rectangles are in viewport coordinates, exactly as a pointer event reports
 * them; the caller owns the scroll container.
 * @param rects - the visible rows, in render order.
 * @param clientX - the pointer's viewport x.
 * @returns the insertion index in `0..rects.length`.
 */
export function dropIndexAt(rects: readonly { readonly left: number; readonly width: number }[], clientX: number): number {
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index]!
    if (clientX < rect.left + rect.width / 2) return index
  }
  return rects.length
}

/** Whether one registration draws a settings page. */
export function hasSettings(view: ApplicationView | undefined): boolean {
  return view?.Settings !== undefined
}

/**
 * The name a row is shown under: the client view's own name, else the host's.
 * A registered name may be a getter — the registration happens once, a language
 * switch happens later, and the human reads the name the getter returns NOW.
 */
export function displayName(app: Pick<AppInfo, 'id' | 'name'>, view: ApplicationView | undefined): string {
  const declared = view?.name
  const named = typeof declared === 'function' ? declared() : declared
  return named ?? app.name
}

/**
 * The one line a row is shown under its name: the registration's own short
 * description (localized through its getter, exactly like the name), else the
 * host's `description` — the application's statement about itself, kept as the
 * fallback so an application with no client half still gets a real row rather
 * than an invented one.
 */
export function displayDescription(app: Pick<AppInfo, 'description'>, view: ApplicationView | undefined): string {
  const declared = view?.description
  return (typeof declared === 'function' ? declared() : declared) ?? app.description
}

/** Whether one declared need names a platform capability. */
export function isCapabilityNeed(need: string): boolean {
  return need.startsWith('capability:')
}

/** The platform capabilities one application declares (the `capability:` half of its needs). */
export function capabilityNeeds(app: Pick<AppInfo, 'needs'>): readonly string[] {
  return app.needs.filter(isCapabilityNeed)
}

/** Whether one grant covers one capability name. */
export function covers(grant: CapabilityGrant, capability: string): boolean {
  return grant.capabilities.includes(capability)
}

/** Whether two callers are the same subject (the wire's caller records are structural). */
export function sameCaller(left: Caller, right: Caller): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'app' || left.kind === 'background') {
    return right.kind === left.kind && right.appId === left.appId
  }
  if (left.kind === 'ai') {
    // A grant belongs to one AI session. An anonymous call has no durable
    // principal, so it never matches (and the runtime refuses to record one).
    return left.sessionId !== undefined && right.kind === 'ai' && right.sessionId === left.sessionId
  }
  return true
}

/** A caller in words (application ids travel verbatim; they are identities, not copy). */
export function callerLabel(caller: Caller): string {
  switch (caller.kind) {
    case 'human': return 'human'
    case 'ai': return caller.sessionId === undefined ? 'ai' : `ai · ${caller.sessionId}`
    case 'app': return `app · ${caller.appId}`
    case 'background': return `background · ${caller.appId}`
  }
}

/**
 * The caller as the human reads it: a role, and the application's display name
 * when the caller is an application (never a raw `app · id` in a consent
 * sentence). The raw caller stays available for technical details.
 * @param caller - the wire caller.
 * @param apps - the registered applications (for a display name).
 * @param views - the client registrations (localized names).
 * @param t - the applications dictionary.
 * @returns the localized caller phrase.
 */
export function callerText(
  caller: Caller,
  apps: readonly AppInfo[],
  views: ReadonlyMap<string, ApplicationView>,
  t: TranslateNS<'applications'>,
): string {
  const nameOf = (appId: string): string => {
    const app = apps.find(candidate => candidate.id === appId)
    return app === undefined ? appId : displayName(app, views.get(appId))
  }
  switch (caller.kind) {
    case 'human': return t('caller.human')
    case 'ai': return caller.sessionId === undefined ? t('caller.ai') : t('caller.aiSession', { session: caller.sessionId })
    case 'app': return t('caller.app', { name: nameOf(caller.appId) })
    case 'background': return t('caller.background', { name: nameOf(caller.appId) })
  }
}

/**
 * One confirmation as a localized sentence. The structured fields (caller,
 * target application, operation or capability) form the sentence; the host's
 * raw `reason` is technical detail, not the primary copy.
 * @param request - the pending confirmation.
 * @param apps - the registered applications.
 * @param views - the client registrations.
 * @param t - the applications dictionary.
 * @returns the sentence a human can decide on.
 */
export function confirmationSentence(
  request: PendingConfirmation,
  apps: readonly AppInfo[],
  views: ReadonlyMap<string, ApplicationView>,
  t: TranslateNS<'applications'>,
): string {
  const caller = callerText(request.caller, apps, views, t)
  if (request.capability.includes('#')) {
    return t('confirm.callOp', { caller, need: describeNeed(request.capability, apps, views, t).label })
  }
  if (isCapabilityNeed(request.capability)) {
    return t('confirm.useCapability', { caller, need: describeNeed(request.capability, apps, views, t).label })
  }
  return t('confirm.generic', { caller, capability: request.capability })
}

/**
 * Whether two callers are the same PRINCIPAL: an application and its own
 * background work are one (the runtime's own `samePrincipal` rule, so a grant
 * either of them holds counts for both), and anything else compares as itself.
 */
function samePrincipal(granted: Caller, caller: Caller): boolean {
  const appOf = (subject: Caller): string | undefined =>
    subject.kind === 'app' || subject.kind === 'background' ? subject.appId : undefined
  const left = appOf(granted)
  const right = appOf(caller)
  if (left !== undefined && right !== undefined) return left === right
  return sameCaller(granted, caller)
}

/** Whether one capability name is covered by ANY grant of one caller (or of its own background work). */
export function grantedTo(grants: readonly CapabilityGrant[], caller: Caller, capability: string): boolean {
  return grants.some(grant => samePrincipal(grant.caller, caller) && covers(grant, capability))
}

/** The records of one call history whose TARGET is one application, newest first. */
export function historyInto(records: readonly HistoryRecord[], appId: string): readonly HistoryRecord[] {
  return records.filter(record => record.target === appId)
}

/** The platform capabilities this build can explain in words (anything else shows its raw identifier). */
const CAPABILITY_KEYS: Readonly<Record<string, ApplicationsKey>> = {
  storage: 'cap.storage',
  network: 'cap.network',
  model: 'cap.model',
  process: 'cap.process',
  delegate: 'cap.delegate',
}

/** The purpose line of one explained capability. */
const CAPABILITY_PURPOSE_KEYS: Readonly<Record<string, ApplicationsKey>> = {
  storage: 'cap.storagePurpose',
  network: 'cap.networkPurpose',
  model: 'cap.modelPurpose',
  process: 'cap.processPurpose',
  delegate: 'cap.delegatePurpose',
}

/** One declared need, in words a human can decide on. */
export interface NeedDescription {
  /** The need's short name (`应用数据存储`, `<app> · write`). */
  readonly label: string
  /** Why the application asks for it (the host's own words for a peer operation, the framework's for a capability). */
  readonly purpose: string | undefined
  /** The exact wire identifier the grant is written with — data, never translated. */
  readonly selector: string
}

/**
 * Explain one declared need. The grant itself is always written with the
 * SELECTOR this returns beside the words — display text never drives a grant.
 * @param need - the declared need (`capability:<name>` or `<appId>#<op>`).
 * @param apps - the host's rows, for a peer operation's target and description.
 * @param views - the registrations, for a target's display name.
 * @param t - the framework's dictionary.
 * @returns the description.
 */
export function describeNeed(
  need: string,
  apps: readonly AppInfo[],
  views: ReadonlyMap<string, ApplicationView>,
  t: TranslateNS<'applications'>,
): NeedDescription {
  if (isCapabilityNeed(need)) {
    const name = need.slice('capability:'.length)
    const key = CAPABILITY_KEYS[name]
    const purpose = CAPABILITY_PURPOSE_KEYS[name]
    return {
      label: key === undefined ? need : t(key),
      purpose: purpose === undefined ? t('cap.unknownPurpose') : t(purpose),
      selector: need,
    }
  }
  if (need.startsWith('event:')) {
    const [appId, type] = splitPeerNeed(need.slice('event:'.length))
    const target = apps.find(candidate => candidate.id === appId)
    const label = target === undefined
      ? need
      : `${displayName(target, views.get(target.id))} · ${type}`
    return {
      label,
      purpose: target?.events?.find(candidate => candidate.type === type)?.description,
      selector: need,
    }
  }
  const [appId, opName] = splitPeerNeed(need)
  const target = apps.find(candidate => candidate.id === appId)
  const label = target === undefined
    ? need
    : `${displayName(target, views.get(target.id))} · ${opName}`
  return {
    label,
    // The operation's own description is the host's text: shown verbatim, never
    // translated (it is the application's statement about itself).
    purpose: target?.ops.find(candidate => candidate.name === opName)?.description,
    selector: need,
  }
}

/**
 * The two halves of a peer need. A need without a `#` (not this vocabulary)
 * comes back whole, so the caller can still show and revoke it verbatim.
 */
function splitPeerNeed(need: string): [string, string] {
  const at = need.indexOf('#')
  return at < 0 ? [need, ''] : [need.slice(0, at), need.slice(at + 1)]
}

