/**
 * The applications shell: the browser's state machine over the host bridge's
 * `applications` Remote namespace. It is deliberately Context-free (it takes
 * the namespace and nothing else), so every rule it implements — the list and
 * its readiness, in-flight calls and cancellation, progress with the pages'
 * own take-overs of it, the watch fan, reconnect, history/grants/confirmations —
 * is exercised as a plain object in tests, and the plugin body only decides WHEN
 * it starts, reconnects and dies.
 *
 * The wire vocabulary is the host bridge's browser face, unchanged: the shell
 * maps nothing, invents no outcome, and hands the runtime's four-way
 * `CallOutcome` straight back to the caller. A failure that never produced an
 * outcome (a carrier failure, an unmounted method) is the caller's to express:
 * it rejects with the Remote error rather than being faked as one of the four
 * (`CallOutcome`'s own declaration says so).
 * @module @matrix1001/dsh-application-harness-client-applications/client/shell
 */

import type { TypertRemoteNamespaceMap, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AppCredentialStatus,
  AppDataExport, AppDataImportPreview, AppDataImportResult, AppDataInfo, AppDataPruneResult, AppInfo, CallOutcome, Caller, CapabilityGrant, ConfirmationDecision, HistoryRecord, JsonValue,
  AppDataRestorePreview, AppDataRestoreResult, ModelCatalog, ModelLimits, ModelUsageSummary, ObjectRef, ObjectResolution, OnboardingState, PageCommand, OperationPolicy, OperationPolicyEntry, PendingConfirmation, ProgressNotice, TaskSnapshot, WatchEvent,
} from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ApplicationViewData } from './contract.ts'

/** What a page-command listener answers: boolean, or a result-bearing answer. */
type PageCommandAnswer = boolean | undefined | { readonly accepted: boolean; readonly error?: string; readonly result?: import('@deepseek-ai/dsh-util-values').JsonValue }

/** The generated `applications` namespace, named through its own declaration merge. */
export type ApplicationsRemote = TypertRemoteNamespaceMap['applications']

/** How many progress notices the shell retains (newest first) for the panel to show. */
export const PROGRESS_LIMIT = 20

/** How many history records `history()` asks for. */
export const HISTORY_LIMIT = 50

/** One in-flight call as the management task view sees it. */
export interface RunningCall {
  /** The request id the call can be cancelled with. */
  readonly requestId: string
  readonly appId: string
  readonly op: string
  /** ISO timestamp of the accepted call. */
  readonly startedAt: string
}

/** Everything the panel renders, as one immutable snapshot. */
export interface ApplicationsState {
  /** The host's application rows; `undefined` until the first read answers. */
  readonly apps: readonly AppInfo[] | undefined
  /** The application the panel shows; `undefined` until one is selected. */
  readonly activeAppId: string | undefined
  /** In-flight calls per application (the count), so a view can disable interactions. */
  readonly running: ReadonlyMap<string, number>
  /** In-flight calls in start order, the task view's own rows. */
  readonly runningCalls: readonly RunningCall[]
  /** The last settled outcome per application, for the panel's status line. */
  readonly outcomes: ReadonlyMap<string, CallOutcome>
  /**
   * The permission refusal the runtime last answered one application with, by
   * appId: `capability-not-approved` (the human can grant it) or
   * `capability-undeclared` (a declaration problem no approval can fix).
   *
   * Read off the calls the FRAMEWORK dispatched — the same outcomes the pages
   * see — so a page never has to interpret an English sentence to find out
   * that its first read was refused. A successful retry clears only that
   * operation's refusal; other operations may still need permission.
   */
  readonly refusals: ReadonlyMap<string, RefusalCode>
  /** Progress notices, newest first, bounded to {@link PROGRESS_LIMIT}. */
  readonly progress: readonly ProgressNotice[]
  /**
   * The ordinary progress rows one application has taken over, by appId: the
   * call ids whose notices that application's page draws itself
   * (`ApplicationViewData.claimProgress`). The raw notices stay in
   * {@link ApplicationsState.progress} — the surface is what stops drawing the
   * claimed ones, and only that list is ever filtered.
   */
  readonly claims: ReadonlyMap<string, ReadonlySet<string>>
  /** Recent call records, newest first; empty until read. */
  readonly history: readonly HistoryRecord[]
  /** Whether the history read has answered for {@link historyTarget}. */
  readonly historyLoaded: boolean
  /** Whether a history read is in flight (the list says so instead of looking empty). */
  readonly historyReading: boolean
  /** Whether the last history read for the current target failed. */
  readonly historyFailed: boolean
  /** The application the history list belongs to; undefined = the global window. */
  readonly historyTarget: string | undefined
  /** Background-task projections, newest first; live frames update this too. */
  readonly tasks: readonly TaskSnapshot[]
  /** Whether the task read has answered at least once. */
  readonly tasksLoaded: boolean
  /** Whether a task read is in flight. */
  readonly tasksReading: boolean
  /** Whether the last task read failed (the task center says so and offers a retry). */
  readonly tasksFailed: boolean
  /** The user's operation-policy overrides; empty until read. */
  readonly policies: readonly OperationPolicyEntry[]
  /** Whether a policies read is in flight. */
  readonly policiesReading: boolean
  /** Whether the last policies read failed. */
  readonly policiesFailed: boolean
  /** Whether a policies read has answered. */
  readonly policiesLoaded: boolean
  /** The grants currently in effect; empty until read. */
  readonly grants: readonly CapabilityGrant[]
  /** Whether a grants read is in flight. */
  readonly grantsReading: boolean
  /** Whether the last grants read failed (the switches stay disabled). */
  readonly grantsFailed: boolean
  /** The host-side "already answered" record for the first-run cards; undefined until read. */
  readonly onboarding: OnboardingState | undefined
  /** Whether the grants read has answered (the card must not treat "not yet known" as "not granted"). */
  readonly grantsLoaded: boolean
  /** Whether the onboarding read has answered (the card must not treat "not yet known" as "never seen"). */
  readonly onboardingLoaded: boolean
  /** Confirmations waiting for an answer, in ask order. */
  readonly confirmations: readonly PendingConfirmation[]
  /** Whether the confirmations read has answered. */
  readonly confirmationsLoaded: boolean
  /** Whether a confirmations read is in flight. */
  readonly confirmationsReading: boolean
  /** Whether the last confirmations read failed. */
  readonly confirmationsFailed: boolean
  /** Whether a watch stream is open (false = only manual refresh sees host changes). */
  readonly watching: boolean
  /**
   * The last watch-stream carrier failure. This is a connection fact, not an
   * action result: a new connection generation clears it, and it is never
   * rendered as the business-error line.
   */
  readonly connectionError: string | undefined
  /**
   * The last business/action/read failure, as `code: message`. Only a command
   * that really succeeded clears it (see {@link ApplicationsShell.grant}): a
   * failure the user has to see — an approval that was not saved — is not
   * wiped by a later successful READ, which would present it as done.
   */
  readonly error: string | undefined
}

/** One error as the panel shows it: `code: message` when it carries a stable code, the message alone otherwise. */
export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    const text = typeof message === 'string' ? message : String(error)
    return typeof code === 'string' ? `${code}: ${text}` : text
  }
  return String(error)
}

/** One open watch generation: the handle to dispose, and this generation's own cancellation. */
interface WatchGeneration {
  readonly abort: AbortController
  readonly handle: AsyncIterable<WatchEvent> & { dispose(): void }
}

/**
 * The function identities one application's view binds (see
 * {@link ApplicationsShell.viewProps}): stable for the shell's life, so an
 * effect keyed on them runs once per mount instead of once per repaint.
 */
interface ViewBindings {
  readonly call: ApplicationViewData['call']
  readonly cancel: ApplicationViewData['cancel']
  readonly onChanged: ApplicationViewData['onChanged']
  readonly claimProgress: ApplicationViewData['claimProgress']
  readonly cancelTask: (taskId: string) => void
  readonly resolveObject: NonNullable<ApplicationViewData['resolveObject']>
}

const INITIAL: ApplicationsState = {
  apps: undefined,
  activeAppId: undefined,
  running: new Map(),
  runningCalls: [],
  outcomes: new Map(),
  refusals: new Map(),
  progress: [],
  claims: new Map(),
  history: [],
  historyLoaded: false,
  historyReading: false,
  historyFailed: false,
  historyTarget: undefined,
  tasks: [],
  tasksLoaded: false,
  tasksReading: false,
  tasksFailed: false,
  policies: [],
  policiesReading: false,
  policiesFailed: false,
  policiesLoaded: false,
  grants: [],
  grantsReading: false,
  grantsFailed: false,
  onboarding: undefined,
  grantsLoaded: false,
  onboardingLoaded: false,
  confirmations: [],
  confirmationsLoaded: false,
  confirmationsReading: false,
  confirmationsFailed: false,
  watching: false,
  connectionError: undefined,
  error: undefined,
}

/**
 * The two codes that mean "this call was refused over a permission". The
 * runtime's own vocabulary (the same strings the host's `AppError`s carry);
 * every other non-success code is the page's business, not the framework's.
 */
export type RefusalCode = 'capability-not-approved' | 'capability-undeclared'

/** Read the refusal one settled outcome carries, if it carries one. */
function refusalOf(outcome: CallOutcome): RefusalCode | undefined {
  if (outcome.status !== 'rejected' && outcome.status !== 'failed') return undefined
  // The runtime prefixes every business failure with `app.` (the capability
  // door raises `AppError`s); accept the bare code too so an older host or a
  // fixture at the same seam still classifies. Strip the known prefixes once
  // instead of matching each spelling in every caller.
  const actual = outcome.error?.code
  const code = actual?.startsWith('app.') === true
    ? actual.slice('app.'.length)
    : actual?.startsWith('platform.') === true
      ? actual.slice('platform.'.length)
      : actual
  switch (code) {
    case 'capability-not-approved': return 'capability-not-approved'
    case 'capability-undeclared': return 'capability-undeclared'
    default: return undefined
  }
}

/** One pending call's task-view facts (the request id is the map key). */
interface PendingCall {
  readonly appId: string
  readonly op: string
  readonly startedAt: string
}

/** In-flight counts per application, derived from the pending-call table. */
function runningOf(pending: ReadonlyMap<string, PendingCall>): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const call of pending.values()) counts.set(call.appId, (counts.get(call.appId) ?? 0) + 1)
  return counts
}

/** In-flight task rows in start order. */
function runningCallsOf(pending: ReadonlyMap<string, PendingCall>): readonly RunningCall[] {
  return [...pending.entries()].map(([requestId, call]) => ({ requestId, ...call }))
}

/**
 * The shell. One instance per plugin mount; `start()` after every service the
 * plugin needs is in place, `dispose()` with the fiber.
 */
export class ApplicationsShell {
  /** The snapshot source the panel's `useApplications()` binds. */
  readonly state: HostObservable<ApplicationsState> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.stateListeners.add(listener)
      return () => { this.stateListeners.delete(listener) }
    },
  }

  private snapshot: ApplicationsState = INITIAL
  /** Change listeners per application (registered views), fanned by `changed` frames and reconnect. */
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pageCommandListeners = new Set<(command: PageCommand) => PageCommandAnswer | Promise<PageCommandAnswer>>()
  private readonly stateListeners = new Set<() => void>()
  /** In-flight calls by requestId → the application they belong to. */
  private readonly pending = new Map<string, PendingCall>()
  /**
   * The progress take-overs behind {@link ApplicationsState.claims}: appId →
   * requestId → the token that identifies that one claim. The token is what a
   * release matches, so a claim that is already gone (the call settled, the
   * page unmounted) leaves a late release without a match — it cannot reach a
   * newer claim that reuses the id.
   */
  private readonly claims = new Map<string, Map<string, object>>()
  /** Per-application function bindings, so a view's effects keep their identity. */
  private readonly bindings = new Map<string, ViewBindings>()
  private readonly refusedOperations = new Map<string, Map<string, RefusalCode>>()
  private stream: WatchGeneration | undefined
  private disposed = false
  /** A streamed row snapshot supersedes list requests already in flight. */
  private rowsEpoch = 0
  /** History reads are per target: a late answer for an older target is dropped. */
  private historyEpoch = 0
  private tasksEpoch = 0

  /**
   * @param remote - the mounted `applications` Remote namespace; the shell makes no other call.
   * @param options - the application the last visit ended on (the caller's
   *   persisted preference); the area keeps it while its row exists, so a
   *   reload lands where the human left off.
   */
  constructor(
    private readonly remote: ApplicationsRemote,
    options: { readonly initialAppId?: string | undefined } = {},
  ) {
    this.snapshot = { ...INITIAL, activeAppId: options.initialAppId }
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * First read, the confirmations already waiting, and the watch stream. The
   * pending confirmations are read here (not only when the panel's section is
   * opened) because a waiting question parks a caller: the panel must be able
   * to say so the moment it is shown.
   */
  start(): void {
    void this.refresh()
    void this.loadGrants()
    void this.loadPolicies()
    void this.loadOnboarding()
    void this.loadConfirmations()
    this.open()
  }

  /**
   * A connection generation was established: the old watch handle died with its
   * carrier, so this opens a fresh one, re-reads the rows and the pending
   * confirmations, and lets every registered view re-read (the shell forwards a
   * change for every appId that has listeners). The platform owns the reconnect
   * itself; this is only the browser-side convergence on top of it.
   */
  reconnect(): void {
    if (this.disposed) return
    // A new generation invalidates the old carrier failure; action failures are
    // deliberately untouched until a command really succeeds.
    this.patch({ connectionError: undefined })
    this.close()
    this.open()
    void this.refresh()
    void this.loadGrants()
    void this.loadPolicies()
    void this.loadOnboarding()
    void this.loadConfirmations()
    this.notifyAll()
  }

  /** Release the watch stream and mark the shell dead (Cordis owns the timing). */
  dispose(): void {
    this.disposed = true
    this.close()
    this.listeners.clear()
    this.stateListeners.clear()
    this.pending.clear()
    this.claims.clear()
    this.bindings.clear()
    this.refusedOperations.clear()
  }

  // ---- reads ----------------------------------------------------------------

  /** Re-read the application rows (one `list()`), reporting a failure instead of throwing. */
  refresh(): Promise<void> {
    return this.readAction(() => this.list())
  }

  /**
   * Read the recent call records — one application's, when named. The filter
   * rides the WIRE (`history(limit, target)`), never a client-side pass over a
   * global window: a busy application would otherwise crowd the one being
   * looked at out of its own history.
   * @param appId - the application whose calls to read; absent = every target.
   */
  /** Read one application's unified-store data facts for the management page. */
  async dataInfo(appId: string): Promise<AppDataInfo> {
    return await this.remoteValue(() => this.remote.dataInfo(appId))
  }

  /** Preview restoring one application from a whole-database backup. */
  async restorePreview(appId: string, backupPath: string): Promise<AppDataRestorePreview> {
    return await this.remoteValue(() => this.remote.dataRestorePreview(appId, backupPath))
  }

  /** Restore one application from a backup after a preview fingerprint check. */
  async restoreData(appId: string, backupPath: string, previewFingerprint?: string, planId?: string, requestId?: string): Promise<AppDataRestoreResult> {
    return await this.remoteValue(() => this.remote.dataRestore(appId, backupPath, previewFingerprint, planId, requestId))
  }

  /** Export one application's unified-store namespace as JSON. */
  async dataExport(appId: string): Promise<AppDataExport> {
    return await this.remoteValue(() => this.remote.dataExport(appId))
  }

  /** Validate one application JSON import in memory. */
  async previewDataImport(appId: string, json: string): Promise<AppDataImportPreview> {
    return await this.remoteValue(() => this.remote.dataImportPreview(appId, json))
  }

  /** Import one application's JSON after a pre-import backup. */
  async importData(appId: string, json: string, planId?: string, requestId?: string): Promise<AppDataImportResult> {
    return await this.remoteValue(() => this.remote.dataImport(appId, json, planId, requestId))
  }

  /** Retry the reload an import could not complete, and release the app. */
  async dataReload(appId: string): Promise<void> {
    await this.remoteValue(() => this.remote.dataReload(appId))
  }

  /** Delete the oldest pre-import snapshots beyond the newest `keep`. */
  async pruneBackups(keep = 5): Promise<AppDataPruneResult> {
    return await this.remoteValue(() => this.remote.dataPruneBackups(keep))
  }

  async loadHistory(appId?: string): Promise<void> {
    const epoch = ++this.historyEpoch
    this.patch({ historyTarget: appId, historyLoaded: false, historyReading: true, historyFailed: false })
    try {
      const result = await this.remote.history(HISTORY_LIMIT, appId)
      // A response for the target the dialog already left must not paint under
      // the new one (the same rule the shell uses for application reads).
      if (epoch !== this.historyEpoch) return
      if (!result.ok) throw result.error
      this.patch({ history: result.value, historyLoaded: true, historyReading: false, historyFailed: false })
    } catch (error) {
      if (epoch !== this.historyEpoch) return
      this.patch({ historyReading: false, historyFailed: true })
      this.fail(error)
    }
  }

  /**
   * Read the host's task projections, including tasks restored as
   * `interrupted`. A live watch frame that arrives during the read invalidates
   * it, so a slower answer can never paint over newer state.
   */
  async loadTasks(): Promise<void> {
    const epoch = ++this.tasksEpoch
    this.patch({ tasksReading: true, tasksFailed: false })
    try {
      const result = await this.remote.tasks(undefined)
      if (epoch !== this.tasksEpoch) return
      if (!result.ok) throw result.error
      this.patch({ tasks: result.value, tasksLoaded: true, tasksReading: false, tasksFailed: false })
    } catch (error) {
      if (epoch !== this.tasksEpoch) return
      this.patch({ tasksReading: false, tasksFailed: true })
      this.fail(error)
    }
  }

  /**
   * Ask the host to cancel one task. The watch frame is the state update; this
   * only sends the request and reports a transport failure.
   * @param appId - the task's owner.
   * @param taskId - the task to cancel.
   */
  cancelTask(appId: string, taskId: string): void {
    this.run(async () => {
      const result = await this.remote.cancelTask(appId, taskId)
      if (!result.ok) throw result.error
    })
  }

  /** Read the grants currently in effect. */
  async loadGrants(): Promise<void> {
    this.patch({ grantsReading: true, grantsFailed: false })
    const read = await this.read(
      () => this.remote.grants(),
      (grants) => ({ grants, grantsLoaded: true, grantsReading: false, grantsFailed: false }),
    )
    if (!read) this.patch({ grantsReading: false, grantsFailed: true })
  }

  /** Read the user's operation-policy overrides. */
  async loadPolicies(): Promise<void> {
    this.patch({ policiesReading: true, policiesFailed: false })
    const read = await this.read(
      () => this.remote.policies(),
      (policies) => ({ policies, policiesLoaded: true, policiesReading: false, policiesFailed: false }),
    )
    if (!read) this.patch({ policiesReading: false, policiesFailed: true })
  }

  /** Read the host-side first-run record. */
  async loadOnboarding(): Promise<void> {
    await this.read(() => this.remote.onboarding(), (onboarding) => ({ onboarding, onboardingLoaded: true }))
  }

  /** Read the confirmations waiting for an answer. */
  async loadConfirmations(): Promise<void> {
    this.patch({ confirmationsReading: true, confirmationsFailed: false })
    const read = await this.read(
      () => this.remote.pendingConfirmations(),
      (confirmations) => ({ confirmations, confirmationsLoaded: true, confirmationsReading: false, confirmationsFailed: false }),
    )
    if (!read) this.patch({ confirmationsReading: false, confirmationsFailed: true })
  }

  /** Select the application the area shows (undefined clears the selection). */
  select(appId: string | undefined): void {
    this.patch({ activeAppId: appId })
  }

  // ---- calls ----------------------------------------------------------------

  /**
   * Call one operation as the human. The application is confirmed through a
   * fresh `list()` first — an application that is gone, stopped or still
   * starting is refused HERE, with the code the runtime would have answered
   * (`unknown-app` / `stopping` / `unavailable`) and a message saying the call
   * never left the browser.
   * @param appId - the application to call.
   * @param op - the operation name.
   * @param args - the JSON arguments.
   * @param requestId - the caller's id; minted when absent. It is the name
   *   `cancel` uses while the call runs, not a rewrite of the arguments: an
   *   operation that wants idempotency declares `requestId` and the caller puts
   *   the same value in `args` explicitly.
   * @returns the runtime's outcome; rejects when no outcome was produced
   *   (a broken carrier, an unmounted method) or when the confirming `list()`
   *   itself failed.
   */
  async call(appId: string, op: string, args: JsonValue, requestId?: string): Promise<CallOutcome> {
    const callId = requestId ?? `applications-${crypto.randomUUID()}`
    try {
      const row = (await this.list()).find(candidate => candidate.id === appId)
      if (row === undefined) return this.refuse(callId, 'unknown-app', appId, 'is not registered')
      if (row.status !== 'available') {
        const code = row.status === 'stopping' ? 'stopping' : 'unavailable'
        return this.refuse(callId, code, appId, `is not available (status: ${row.status})`)
      }
      this.begin(callId, appId, op)
      const result = await this.remote.call(appId, op, args, callId)
      if (!result.ok) throw result.error
      this.settle(appId, result.value)
      this.noteRefusal(appId, op, result.value)
      return result.value
    } finally {
      // EVERY ending of this call runs `end`, the paths that never began
      // included (a refusal above, a confirming read that failed): a take-over
      // names one call, and nothing about it may outlive that call — a stale
      // claim would hide the rows of the next call that reuses the id.
      this.end(callId, appId)
    }
  }

  /**
   * Keep the panel's refusal record in step with one settled outcome: a
   * permission refusal stays until that operation succeeds. Parallel reads of
   * unrelated data cannot dismiss an unresolved permission problem.
   */
  private noteRefusal(appId: string, op: string, outcome: CallOutcome): void {
    const code = refusalOf(outcome)
    let operations = this.refusedOperations.get(appId)
    if (code !== undefined) {
      if (operations === undefined) {
        operations = new Map()
        this.refusedOperations.set(appId, operations)
      }
      operations.set(op, code)
    } else {
      if (outcome.status !== 'success' || !operations?.delete(op)) return
      if (operations.size === 0) this.refusedOperations.delete(appId)
    }
    const remaining = [...operations.values()]
    const nextCode = remaining.includes('capability-not-approved') ? 'capability-not-approved' : remaining[0]
    if (this.snapshot.refusals.get(appId) === nextCode) return
    const next = new Map(this.snapshot.refusals)
    if (nextCode === undefined) next.delete(appId)
    else next.set(appId, nextCode)
    this.patch({ refusals: next })
  }

  /**
   * Cancel one in-flight call by its requestId.
   * @param requestId - the id the call was started with.
   * @returns whether the host had a call in flight under that id.
   */
  async cancel(requestId: string): Promise<boolean> {
    const result = await this.remote.cancel(requestId)
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * Ask the host to cancel one in-flight call without a caller to hand the
   * answer to: a failure to ASK is a transport fact and lands on the panel's
   * error line, like every other unattended failure.
   * @param requestId - the id the call was started with.
   */
  requestCancel(requestId: string): void {
    this.run(() => this.cancel(requestId))
  }

  /**
   * Take over the ordinary progress rows of one call an application started:
   * the surface stops drawing that call's notices for as long as the claim
   * lives (the raw notices stay in the state). The claim is stamped with the
   * application, so no claim can hide another application's rows — and it is
   * the PAGE's, so it dies with that page (see
   * {@link ApplicationsShell.releaseClaims}) and with the call it named (see
   * {@link ApplicationsShell.end}).
   * @param appId - the application whose page is claiming.
   * @param requestId - the id the call was (or is about to be) started with.
   * @returns the idempotent release; a late one cannot touch a newer claim.
   */
  claimProgress(appId: string, requestId: string): () => void {
    const claims = this.claims.get(appId) ?? new Map<string, object>()
    this.claims.set(appId, claims)
    const token = {}
    claims.set(requestId, token)
    this.publishClaims()
    return () => { this.release(appId, requestId, token) }
  }

  /**
   * Drop every take-over one application holds: its page is gone (the human
   * left it, or a re-read re-keyed it), so nothing draws those rows any more —
   * the ordinary rows come back for the calls that are still running.
   * @param appId - the application whose page left.
   */
  releaseClaims(appId: string): void {
    if (!this.claims.delete(appId)) return
    this.publishClaims()
  }

  /**
   * Hand one claim back. Only the claim that still holds `token` is dropped: a
   * second release, or one that arrives after the call settled (or after
   * {@link ApplicationsShell.releaseClaims}), is a no-op — it can never take
   * the display away from a newer claim that reuses the id.
   * @param appId - the application that made the claim.
   * @param requestId - the call the claim named.
   * @param token - the identity of that one claim.
   */
  private release(appId: string, requestId: string, token: object): void {
    const claims = this.claims.get(appId)
    if (claims?.get(requestId) !== token) return
    this.forgetClaim(appId, requestId)
    this.publishClaims()
  }

  /**
   * Forget one claimed id, whatever token holds it: the call it was made for is
   * over, so the take-over is over too.
   * @param appId - the application the claim belongs to.
   * @param requestId - the call the claim named.
   * @returns whether the id was claimed.
   */
  private forgetClaim(appId: string, requestId: string): boolean {
    const claims = this.claims.get(appId)
    if (claims === undefined || !claims.delete(requestId)) return false
    if (claims.size === 0) this.claims.delete(appId)
    return true
  }

  /** The take-over table as the state publishes it (a fresh snapshot per change). */
  private claimSnapshot(): ReadonlyMap<string, ReadonlySet<string>> {
    const claims = new Map<string, ReadonlySet<string>>()
    for (const [appId, ids] of this.claims) claims.set(appId, new Set(ids.keys()))
    return claims
  }

  /** Publish the take-over table (a claim or a release changed it). */
  private publishClaims(): void {
    this.patch({ claims: this.claimSnapshot() })
  }

  /**
   * The shell's own half of the props one application's registered view is
   * rendered with: the data surface, and nothing about the page context — that
   * face is composed by the plugin that owns the store (index.ts).
   *
   * The four FUNCTIONS are bound once per application and handed back with
   * their identity intact: a view may key an effect on them (subscribe once,
   * read on mount), and the props object around them is rebuilt per render
   * because `running` is a snapshot fact. A fresh closure per render would make
   * every such effect re-run on every repaint — the read loop this shape
   * exists to prevent.
   * @param appId - the application whose page is being rendered.
   * @returns the live data surface for that application.
   */
  viewProps(appId: string): ApplicationViewData {
    const bound = this.bindings.get(appId) ?? this.bind(appId)
    return { ...bound, running: (this.snapshot.running.get(appId) ?? 0) > 0 }
  }

  /**
   * The stable per-application function bindings (see {@link ApplicationsShell.viewProps}).
   * @param appId - the application to bind.
   * @returns the bindings, cached for the shell's life.
   */
  private bind(appId: string): ViewBindings {
    const bound: ViewBindings = {
      call: (op, args, requestId) => this.call(appId, op, args, requestId),
      resolveObject: async (ref: ObjectRef): Promise<ObjectResolution> => {
        const result = await this.remote.resolveObject(ref)
        if (!result.ok) throw result.error
        return result.value
      },
      cancel: (requestId) => { this.requestCancel(requestId) },
      onChanged: (listener) => this.onChanged(appId, listener),
      claimProgress: (requestId) => this.claimProgress(appId, requestId),
      cancelTask: (taskId) => { this.cancelTask(appId, taskId) },
    }
    this.bindings.set(appId, bound)
    return bound
  }

  /**
   * Subscribe to host page commands. A listener returns true after executing
   * the navigation, false on a refused/failed command, or undefined when the
   * command belongs to another Session/client.
   * @param listener - the command handler.
   * @returns the unsubscribe.
   */
  onPageCommand(listener: (command: PageCommand) => PageCommandAnswer | Promise<PageCommandAnswer>): () => void {
    this.pageCommandListeners.add(listener)
    return () => { this.pageCommandListeners.delete(listener) }
  }

  /**
   * Subscribe to one application's data changes.
   * @param appId - the application to watch.
   * @param listener - called on each `changed` frame and on reconnect.
   * @returns the unsubscribe.
   */
  onChanged(appId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(appId) ?? new Set<() => void>()
    this.listeners.set(appId, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  // ---- grants and confirmations ---------------------------------------------

  /**
   * Record that a caller may use a set of capabilities — the panel's own
   * approval of a declared need (the same record an "allow and remember" answer
   * writes), then re-read the grants. The WRITE's own answer is checked first:
   * a host that reported `ok: false` (or rejected) is the panel's error line,
   * and an approval that was not persisted is never shown as effective.
   * @param caller - the caller the grant belongs to.
   * @param capabilities - the exact capability names being approved.
   * @returns whether the grant was really written (the caller's own row shows it).
   */
  async grant(caller: Caller, capabilities: readonly string[]): Promise<boolean> {
    const ok = await this.command(
      () => this.remote.grant(caller, [...capabilities]),
      () => this.remote.grants(),
      (grants) => ({ grants, grantsLoaded: true }),
    )
    // The refusal was about this capability; once the user has granted it the
    // old per-operation record no longer explains the current state.
    if (ok && caller.kind === 'app') this.clearRefusal(caller.appId)
    return ok
  }

  /** Drop one application's stale capability refusal after a successful grant. */
  private clearRefusal(appId: string): void {
    this.refusedOperations.delete(appId)
    if (!this.snapshot.refusals.has(appId)) return
    const next = new Map(this.snapshot.refusals)
    next.delete(appId)
    this.patch({ refusals: next })
  }

  /**
   * Set or clear one operation's user policy, then re-read the table. The write
   * is checked before the read: a failed save is never shown as effective.
   * @param appId - the target application.
   * @param op - the operation.
   * @param policy - the override.
   * @returns whether the policy was really saved.
   */
  /**
   * Enable or disable one application, then re-read the rows. The write is
   * checked before the list: a failed activation change is not shown as done.
   * @param appId - the application.
   * @param activation - enabled or disabled.
   * @returns whether the change was really saved.
   */
  setActivation(appId: string, activation: 'enabled' | 'disabled'): Promise<boolean> {
    return this.command(
      () => this.remote.setActivation(appId, activation),
      () => this.remote.list(),
      (apps) => ({ apps }),
    )
  }

  /** Read the live provider/model catalog. */
  async modelCatalog(): Promise<ModelCatalog> {
    const result = await this.remote.modelCatalog()
    if (!result.ok) throw result.error
    return result.value as ModelCatalog
  }

  /** Read one application's aggregated model usage. */
  async modelUsage(appId: string): Promise<ModelUsageSummary> {
    const result = await this.remote.modelUsage(appId)
    if (!result.ok) throw result.error
    return result.value as ModelUsageSummary
  }

  /** Read the declared credentials' set status (values never cross). */
  async credentials(appId: string): Promise<readonly AppCredentialStatus[]> {
    const result = await this.remote.credentials(appId)
    if (!result.ok) throw result.error
    return result.value as readonly AppCredentialStatus[]
  }

  /** Set one declared credential. */
  async setCredential(appId: string, name: string, value: string): Promise<boolean> {
    try {
      const result = await this.remote.setCredential(appId, name, value)
      return result.ok && result.value
    } catch {
      return false
    }
  }

  /** Delete one declared credential. */
  async deleteCredential(appId: string, name: string): Promise<boolean> {
    try {
      const result = await this.remote.deleteCredential(appId, name)
      return result.ok && result.value
    } catch {
      return false
    }
  }

  /** Read one application's model limits. */
  async modelLimits(appId: string): Promise<ModelLimits> {
    const result = await this.remote.modelLimits(appId)
    if (!result.ok) throw result.error
    return result.value as ModelLimits
  }

  /** Set one application's model limits. */
  async setModelLimits(appId: string, limits: ModelLimits): Promise<boolean> {
    try {
      const result = await this.remote.setModelLimits(appId, limits)
      return result.ok && result.value
    } catch {
      return false
    }
  }

  /** Set or clear one application's fixed model route. */
  async setAppModel(appId: string, selection: { provider: string; model: string } | null): Promise<boolean> {
    try {
      const result = await this.remote.setAppModel(appId, selection)
      return result.ok && result.value
    } catch {
      return false
    }
  }

  setPolicy(appId: string, op: string, policy: OperationPolicy): Promise<boolean> {
    return this.command(
      () => this.remote.setPolicy(appId, op, policy),
      () => this.remote.policies(),
      (policies) => ({ policies, policiesLoaded: true }),
    )
  }

  /**
   * Revoke capabilities from one caller, then re-read the grants. Like
   * {@link ApplicationsShell.grant}, the revoke is checked before the read: a
   * revoke the host refused keeps its capabilities in effect and says so.
   * @param caller - the caller whose grants are revoked.
   * @param selector - an exact capability, an application id, or absent for everything of that caller.
   * @returns whether the revoke was really written.
   */
  revoke(caller: Caller, selector?: string): Promise<boolean> {
    return this.command(
      () => this.remote.revoke(caller, selector),
      () => this.remote.grants(),
      (grants) => ({ grants, grantsLoaded: true }),
    )
  }

  /**
   * Record that the human answered or postponed the first-run card for one
   * application at its current capability-set fingerprint. This writes the
   * notification record only; the grants stay a separate command.
   * @param appId - the application the card was about.
   * @param fingerprint - the fingerprint the card showed.
   * @returns whether the answer was really written.
   */
  markOnboardingSeen(appId: string, fingerprint: string): Promise<boolean> {
    return this.command(
      () => this.remote.markOnboardingSeen(appId, fingerprint),
      () => this.remote.onboarding(),
      (onboarding) => ({ onboarding, onboardingLoaded: true }),
    )
  }

  /**
   * Answer one pending confirmation, then re-read the pending list. The waiting
   * call only proceeds after this answer (a decision never revives a settled
   * question: the host answers `false` and the re-read shows the truth), and an
   * answer the host refused is reported instead of being read away.
   * @param id - the confirmation's id.
   * @param decision - allow this one call, or refuse it.
   * @returns whether the answer was really recorded.
   */
  answer(id: string, decision: ConfirmationDecision): Promise<boolean> {
    return this.command(
      () => this.remote.answerConfirmation(id, decision),
      () => this.remote.pendingConfirmations(),
      (confirmations) => ({ confirmations }),
    )
  }

  /** Withdraw a pending confirmation; a late withdraw never revives it. */
  cancelConfirmation(id: string): Promise<boolean> {
    return this.command(
      () => this.remote.cancelConfirmation(id),
      () => this.remote.pendingConfirmations(),
      (confirmations) => ({ confirmations }),
    )
  }

  // ---- internals ------------------------------------------------------------

  /**
   * One read: run it, patch the state on success, record the failure otherwise.
   * A read does NOT clear the error line: a later successful read must not
   * present a failed approval as if nothing had gone wrong — only a command
   * that really succeeded does that.
   */
  /** One Remote answer as a plain value (a Remote failure is thrown, not faked). */
  private async remoteValue<T>(run: () => Promise<RemoteResult<T>>): Promise<T> {
    const result = await run()
    if (!result.ok) throw result.error
    return result.value
  }

  private async read<T>(
    run: () => Promise<RemoteResult<T>>,
    apply: (value: T) => Partial<ApplicationsState>,
  ): Promise<boolean> {
    let ok = false
    await this.readAction(async () => {
      const result = await run()
      if (!result.ok) throw result.error
      this.patch(apply(result.value))
      ok = true
    })
    return ok
  }

  /**
   * One command: a WRITE whose effect is shown by a following read. The write's
   * own answer is checked first — a Remote failure may arrive as `ok: false`
   * rather than as a rejection, and either way it is the panel's error line —
   * and only the command that really succeeded clears that line.
   *
   * The answer is a plain boolean as well: the row that asked for the write
   * owns its own pending/error state (`needs.pending`), which is how a failed
   * grant is shown ON the need instead of only on the dialog's line.
   * @param write - the command itself.
   * @param read - the read that shows the command's effect.
   * @param apply - how the read's value lands in the state.
   * @returns whether the command took effect.
   */
  private async command<T>(
    write: () => Promise<RemoteResult<unknown>>,
    read: () => Promise<RemoteResult<T>>,
    apply: (value: T) => Partial<ApplicationsState>,
  ): Promise<boolean> {
    let applied = false
    await this.readAction(async () => {
      const written = await write()
      if (!written.ok) throw written.error
      const listed = await read()
      if (!listed.ok) throw listed.error
      this.patch({ ...apply(listed.value), error: undefined })
      applied = true
    })
    return applied
  }

  /** Run a state-writing action whose failure belongs on the panel's error line. */
  private async readAction<T>(run: () => Promise<T>): Promise<void> {
    try {
      await run()
    } catch (error) {
      this.fail(error)
    }
  }

  /** Fire-and-forget an action whose failure belongs on the panel (cancel, revoke from a view). */
  private run(action: () => Promise<unknown>): void {
    void action().catch((error: unknown) => { this.fail(error) })
  }

  /** Read the rows; a transport failure rejects (the caller's to express). */
  private async list(): Promise<readonly AppInfo[]> {
    const epoch = this.rowsEpoch
    const result = await this.remote.list()
    if (!result.ok) throw result.error
    if (epoch !== this.rowsEpoch) return this.snapshot.apps!
    this.patch({ apps: result.value })
    return result.value
  }

  /** Refuse one call locally, with the runtime's own rejection vocabulary. */
  private refuse(callId: string, code: 'unknown-app' | 'stopping' | 'unavailable', appId: string, because: string): CallOutcome {
    const message = `the application "${appId}" ${because} — refused by the shell, the operation was not run`
    const outcome: CallOutcome = { callId, status: 'rejected', error: { code: `platform.${code}`, message } }
    this.settle(appId, outcome)
    return outcome
  }

  /** Mark a call in flight so every reader of `running` sees it. */
  private begin(requestId: string, appId: string, op: string): void {
    this.pending.set(requestId, { appId, op, startedAt: new Date().toISOString() })
    this.patch({ running: runningOf(this.pending), runningCalls: runningCallsOf(this.pending) })
  }

  /**
   * Drop one call from the in-flight table, and its progress notices with it:
   * a settled call's last notice is history, and a list of notices that keeps
   * them would present finished work as still running. A take-over of that call
   * ends here too — a claim names one call, and nothing about it may outlive the
   * call for the next one that reuses the id. The application is named (rather
   * than read off the in-flight table) because every ending runs this, the ones
   * that never began included.
   * @param requestId - the call's id.
   * @param appId - the application the call was made as.
   */
  private end(requestId: string, appId: string): void {
    this.pending.delete(requestId)
    const claimed = this.forgetClaim(appId, requestId)
    this.patch({
      running: runningOf(this.pending),
      runningCalls: runningCallsOf(this.pending),
      progress: this.snapshot.progress.filter(notice => notice.callId !== requestId),
      ...(claimed ? { claims: this.claimSnapshot() } : {}),
    })
  }

  /** Record one settled outcome for the panel's status line. */
  private settle(appId: string, outcome: CallOutcome): void {
    const outcomes = new Map(this.snapshot.outcomes)
    outcomes.set(appId, outcome)
    this.patch({ outcomes })
  }

  /** Record a transport-level failure verbatim. */
  private fail(error: unknown): void {
    this.patch({ error: describeError(error) })
  }

  /**
   * Record a watch-carrier failure without touching the action-error line.
   * The connection notice owns this state; a new generation clears it.
   * @param error - the carrier/stream failure.
   */
  private failConnection(error: unknown): void {
    this.patch({ connectionError: describeError(error) })
  }

  /** Replace the snapshot and notify the panel. */
  private patch(next: Partial<ApplicationsState>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of [...this.stateListeners]) listener()
  }

  /** Open one watch generation and start consuming it. */
  private open(): void {
    const abort = new AbortController()
    const generation: WatchGeneration = { abort, handle: this.remote.watch(abort.signal) }
    this.stream = generation
    this.patch({ watching: true, connectionError: undefined })
    void this.consume(generation)
  }

  /** Close the current generation, if any. */
  private close(): void {
    const generation = this.stream
    this.stream = undefined
    generation?.abort.abort()
    generation?.handle.dispose()
  }

  /**
   * Drain one watch generation until it ends. A stream that ends on its own
   * (the host unloaded) or throws (the carrier dropped) is not an error the
   * shell repairs: the platform's reconnect emits `connection/reset`, which
   * opens the next generation. The failure is recorded so the panel can say
   * the stream is down instead of pretending it is live.
   */
  private async consume(generation: WatchGeneration): Promise<void> {
    try {
      for await (const event of generation.handle) {
        if (this.disposed) return
        this.handle(event)
      }
    } catch (error) {
      // A stream that was already replaced by a reconnect is old news: its late
      // abort/failure must not resurrect the connection error on the new one.
      if (this.stream !== generation) return
      this.failConnection(error)
    } finally {
      if (this.stream === generation) {
        this.stream = undefined
        this.patch({ watching: false })
      }
    }
  }

  /** Ask the first interested listener to execute one page command and answer it. */
  private async dispatchPageCommand(command: PageCommand): Promise<void> {
    for (const listener of this.pageCommandListeners) {
      let answer: PageCommandAnswer
      try {
        answer = await listener(command)
      } catch {
        answer = false
      }
      if (answer === undefined) continue
      const accepted = typeof answer === 'boolean' ? answer : answer.accepted
      const error = typeof answer === 'boolean' ? undefined : answer.error
      const result = typeof answer === 'boolean' ? undefined : answer.result
      try {
        if (error === undefined && result === undefined) await this.remote.completePageCommand?.(command.commandId, accepted)
        else await this.remote.completePageCommand?.(command.commandId, accepted, error, result)
      } catch {
        // The host has its own timeout; an unanswered command fails closed there.
      }
      return
    }
  }

  /** Route one watch frame. */
  private handle(event: WatchEvent): void {
    switch (event.kind) {
      case 'ready':
        this.rowsEpoch += 1
        this.patch({ apps: event.apps })
        break
      case 'changed':
        this.notify([event.appId])
        break
      case 'lifecycle':
        this.rowsEpoch += 1
        this.patch({ apps: event.apps })
        if (event.apps.some(app => app.id === event.appId && app.status === 'available')) this.notify([event.appId])
        break
      case 'progress':
        this.patch({ progress: [event.notice, ...this.snapshot.progress].slice(0, PROGRESS_LIMIT) })
        break
      case 'task': {
        // A live frame is newer than any in-flight read of the whole set.
        this.tasksEpoch += 1
        const tasks = new Map(this.snapshot.tasks.map(task => [task.taskId, task]))
        tasks.set(event.task.taskId, event.task)
        this.patch({ tasks: [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) })
        break
      }
      case 'page-command':
        void this.dispatchPageCommand(event.command)
        break
      case 'confirmation':
        this.patch(event.action === 'asked'
          ? { confirmations: [...this.snapshot.confirmations, event.request] }
          : { confirmations: this.snapshot.confirmations.filter(item => item.id !== event.id) })
        break
      case 'reset':
        // The host dropped a backlog this consumer was too slow to read. The
        // stream stays open; re-read every derived face and let views re-read
        // rather than presenting a partial live view.
        this.rowsEpoch += 1
        void this.refresh()
        void this.loadGrants()
        void this.loadPolicies()
        void this.loadOnboarding()
        void this.loadConfirmations()
        void this.loadTasks()
        this.notifyAll()
        break
    }
  }

  /** Fan one change to the listeners of the named applications. */
  private notify(appIds: Iterable<string>): void {
    for (const appId of appIds) {
      for (const listener of [...(this.listeners.get(appId) ?? [])]) listener()
    }
  }

  /** Fan a change to every application that has a listener (reconnect). */
  private notifyAll(): void {
    this.notify([...this.listeners.keys()])
  }
}
