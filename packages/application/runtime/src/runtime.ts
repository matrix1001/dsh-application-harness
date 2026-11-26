/**
 * The application runtime: one registry, one call path, one lifecycle.
 *
 * Everything a caller can do to an application goes through {@link ApplicationRuntime.call}:
 * the entry point supplies WHO is asking, the runtime decides whether the call
 * may run (availability → declaration → parameters → openness → grant or
 * confirmation), and only then executes the operation's own function. Human
 * interfaces, the AI tool face and peer applications all reach the same
 * implementation through this one door; nothing else executes an operation.
 *
 * Deliberately free of Cordis and of host I/O: the plugin face in `index.ts`
 * binds this class to a context, and the ports below are the only places the
 * outside world enters (confirmation, grants, history, clock, ids). That is
 * what lets the whole rule book be tested with fakes.
 * @module @matrix1001/dsh-application-harness-runtime
 */

import { parameterSchemaSpecToJsonSchema, validateJsonSchemaValue, valueSchemaSpecToJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { HistoryReader } from './history.ts'
import { eventCapability, opCapability, platformCapability } from './types.ts'
import type {
  Activation, AppCall, AppChangeNotice, AppContext, AppDataDeclaration, AppDeclaration, AppDelegationAccess, AppEvent, AppEventListener, AppHealth, AppHealthCheckResult, AppId, AppReason, AppStatus, CallOutcome, Caller, CapabilityAccess,
  CapabilityGrant, CapabilityVerdict, DelegationPort, ObjectRef, ObjectResolutionResult, OpName, OperationContext, OperationDeclaration, OperationEffect, OperationPolicy, OperationPolicyEntry, OutcomeError, PolicyStorePort, ProcessAccess, ProcessDescriptor, ProgressNotice, RejectionCode,
  TaskCancelResult, TaskContext, TaskDescriptor, TaskError, TaskHandle, TaskId, TaskNotice, TaskOrigin,
  TaskProgress, TaskSnapshot, TaskState, TaskWork,
} from './types.ts'

/** How long a stop waits for in-flight and background work before reporting incomplete. */
export const DEFAULT_STOP_BUDGET_MS = 3_000

/**
 * How long one application health check may run before the platform reports it
 * as degraded. Health hooks are meant to be light; a hook that outlives this is
 * a diagnostic, never a reason to block or stop the application on its own.
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000

/** How many recent history records {@link ApplicationRuntime.recentHistory} answers by default. */
export const DEFAULT_RECENT_HISTORY = 50

/** How many tasks one application may keep (terminal records are pruned first). */
export const MAX_TASK_RECORDS_PER_APP = 100

/** How many tasks one application may have running at once. */
export const MAX_RUNNING_TASKS_PER_APP = 16

/** The largest JSON snippet retained for one task's progress or result summary. */
const MAX_TASK_SUMMARY_CHARS = 8 * 1024

/** How deep one peer-call chain may nest before the runtime refuses it. */
export const MAX_CALL_DEPTH = 8

/** The permission layer's verdict for one call (before it is turned into a rejection code). */
type PermissionOutcome = 'allow' | 'deny' | 'unavailable' | 'closed'

/** One live event subscription held by an application backend. */
interface EventBinding {
  readonly subscriber: AppId
  readonly publisher: AppId
  readonly type: string
  readonly listener: AppEventListener
}

/** Build the public error body; platform codes are never given an app prefix. */
function errorBody(code: string, message: string, details?: JsonValue): OutcomeError {
  const prefixed = code.startsWith('platform.') || code.startsWith('app.') ? code : `platform.${code}`
  return { code: prefixed, message, ...(details === undefined ? {} : { details }) }
}

/** Build one pre-execution rejection with the public error body. */
function rejectedOutcome(callId: string, code: RejectionCode, message: string): CallOutcome {
  return { callId, status: 'rejected', error: errorBody(code, message) }
}

/** Build one post-execution failure with the public error body. */
function failedOutcome(callId: string, code: string, message: string, details?: JsonValue): CallOutcome {
  const errorCode = code === 'threw' ? 'platform.execution-failed' : code === 'invalid-result' ? 'platform.invalid-result' : `app.${code}`
  return { callId, status: 'failed', error: errorBody(errorCode, message, details) }
}

/** Build one cancellation with the public error body. */
function cancelledOutcome(callId: string): CallOutcome {
  return { callId, status: 'cancelled', error: errorBody('platform.cancelled', 'the call was cancelled') }
}

/**
 * The error an application throws to report a business refusal with a stable
 * code (`stale-version`, `trash-full`, ...). The call still ends as a failure —
 * the operation ran and its effects, if any, stand — but the caller receives
 * the code and can branch on it instead of parsing a message.
 */
export class AppError extends Error {
  constructor(
    /** The stable, application-defined code. */
    public readonly code: string,
    message: string,
    /** Whether the caller may safely retry (absent = the application did not say). */
    public readonly retryable?: boolean,
    /** Structured field paths or partial-effect facts; never a business body. */
    public readonly details?: JsonValue,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * One import/maintenance hold on an application (see
 * {@link ApplicationRuntime.beginMaintenance}). While the hold is active the
 * application refuses new calls; the holder imports the new data and asks the
 * application to reload. A hold survives a failed reload (the application must
 * not serve its stale cache) until {@link MaintenanceLease.release} or
 * {@link ApplicationRuntime.endMaintenance}.
 */
export interface MaintenanceLease {
  /** The application the hold belongs to. */
  readonly appId: AppId
  /**
   * Release the hold and run the application's `resume` hook. Idempotent; a
   * stale lease never clears a newer hold. A resume failure is reported as a
   * problem, not thrown: the application is callable again, and a background
   * timer it failed to re-arm is a diagnostic, not a reason to refuse calls.
   */
  release(): Promise<void>
}

/**
 * The answer to one confirmation request.
 *
 * `allowed-once` allows exactly this call. `denied` refuses, and
 * `cancelled`/`unavailable` mean the question was not answered at all — the
 * call does not run. Confirmation is never remembered; persistent policy is the
 * user's operation policy, not a per-caller grant.
 */
export type ConfirmationAnswer = 'allowed-once' | 'denied' | 'cancelled' | 'unavailable'

/** The bounded, human-checkable shape of a call asking for confirmation. */
export interface ConfirmationPreview {
  /** Whether the call would read or write. */
  readonly effect: OperationEffect
  /** Redacted, size-bounded JSON text; never the raw operation arguments. */
  readonly args: string
}

/** One confirmation the runtime cannot answer itself. */
export interface ConfirmationRequest {
  readonly caller: Caller
  /** The call's bounded, redacted preview, when the channel can show one. */
  readonly preview?: ConfirmationPreview
  /**
   * The capability the user is being asked to approve (`<appId>#<op>` for an
   * operation, `capability:<name>` for a platform capability). The approval
   * covers this call only; persistent policy is set separately.
   */
  readonly capability: string
  /** What the user is being asked to allow, in words. */
  readonly reason: string
  readonly signal: AbortSignal
}

/**
 * The confirmation channel. The runtime never invents an answer: a missing or
 * failing channel is `unavailable`, and `unavailable` means the call does not
 * run. A late answer after cancellation is dropped by the channel itself
 * (the request's signal is already aborted).
 */
export interface ConfirmationPort {
  ask(request: ConfirmationRequest): Promise<ConfirmationAnswer>
}

/**
 * Durable grants. The runtime reports a save as successful only after the port
 * resolves; a read failure is surfaced as an error, never downgraded to "no
 * grants exist" (which would widen access) nor to "allow everything".
 */
export interface GrantStorePort {
  list(): Promise<readonly CapabilityGrant[]>
  save(grants: readonly CapabilityGrant[]): Promise<void>
}

/** One basic-history record: who called what, when, and how it ended. */
export interface HistoryRecord {
  readonly callId: string
  readonly caller: Caller
  readonly target: AppId
  readonly op: OpName
  readonly startedAt: string
  readonly endedAt: string
  readonly status: CallOutcome['status']
  /** Stable rejection/failure code when the call did not succeed. */
  readonly code?: string
  /** Failure/rejection message (never full arguments or results). */
  readonly message?: string
  /** The command label of one process use; absent for operation calls. */
  readonly command?: string
}

/** Where history records go. `write` failures are reported, never thrown at callers. */
export interface HistorySink {
  write(record: HistoryRecord): void | Promise<void>
}

/** One listener of application change notices. */
export type ChangeListener = (notice: AppChangeNotice) => void

/** Registration of one application. */
export interface AppRegistration {
  readonly declaration: AppDeclaration
  /** Current lifecycle state. */
  status(): AppStatus
  /** User activation; a disabled application is visible but not callable. */
  activation(): Activation
  /** Readable diagnostic detail: start failure, stop incomplete, maintenance. */
  detail(): string | undefined
  /** Health beside the lifecycle state. */
  health(): AppHealth
  /** Stable reason for a degraded/blocked state, when one applies. */
  reason(): AppReason | undefined
}

/** What the runtime needs from outside; every port has a safe default. */
export interface RuntimeOptions {
  readonly confirm?: ConfirmationPort
  /** The host's durable delegation store (see {@link DelegationPort}). */
  readonly delegations?: DelegationPort
  readonly grants?: GrantStorePort
  readonly policies?: PolicyStorePort
  readonly history?: HistorySink
  /** Clock for timestamps and call ids (tests inject deterministic ones). */
  readonly now?: () => Date
  readonly idFactory?: () => string
  /** Task ids must survive a restart, so they default to random ids, not a counter. */
  readonly taskIdFactory?: () => string
  readonly stopBudgetMs?: number
  /** How long one platform-run health check may take (default 5000ms). */
  readonly healthTimeoutMs?: number
  /** How long one confirmation may wait for a human (default 5 minutes). */
  readonly confirmationTimeoutMs?: number
  /**
   * The activation snapshot read before this service was provided. It is the
   * host's boot gate: a disabled id (or a failed read) must never start, even
   * if the application row mounts before the host bridge's async reconciler.
   */
  readonly activation?: { readonly disabled: readonly AppId[]; readonly failure?: string }
  /** Report a non-fatal problem (history write failure, background rejection, ...). */
  readonly onProblem?: (problem: string) => void
}

/** Internal per-application record. */
interface AppRecord {
  readonly declaration: AppDeclaration
  abort: AbortController
  status: AppStatus
  activation: Activation
  detail: string | undefined
  health: AppHealth
  reason: AppReason | undefined
  /**
   * The start hook while it is in flight. It is WORK the application owns: a
   * stop waits for it (within the budget) and cancels it with everything else,
   * and its late result may never reopen an application the stop already took
   * over. Cleared when it settles (`exactOptionalPropertyTypes` keeps the
   * explicit `undefined` legal).
   */
  starting?: Promise<void> | undefined
  readonly inFlight: Set<Promise<unknown>>
  readonly background: Set<Promise<unknown>>
  /** Control-plane tasks owned by this application, newest insertion order. */
  readonly tasks: Map<TaskId, TaskEntry>
  readonly pendingConfirmations: Set<AbortController>
  /**
   * The active import hold, when the host is replacing this application's
   * application data. New calls are refused; existing calls are waited for
   * before the import begins (see {@link ApplicationRuntime.beginMaintenance}).
   */
  maintenance?: { readonly token: number } | undefined
  /** Resolves when the app reaches stopped/stop-incomplete after a stop began. */
  stopped: Promise<AppStatus> | undefined
  /** The stop hook still in flight after the budget; a re-entrant stop must not rerun it. */
  stopHook?: Promise<string | undefined> | undefined
  /** The late cleanup still in flight after an incomplete stop; a re-entrant stop joins it. */
  stopLate?: Promise<void> | undefined
  /** A health failure whose stop outlived the budget; re-applied when stopped. */
  pendingHealthFailure?: { readonly reason: string; readonly detail: string } | undefined
  /**
   * The one platform-run health check in flight for this instance, when there
   * is one. A user-triggered check joins it instead of running the hook twice;
   * it is NOT application work, so a stop never waits for it (the check
   * discards its own late result once the instance moved on).
   */
  checking?: Promise<void> | undefined
  /**
   * The identity of the newest health check this instance started. Every check
   * captures it when it begins: a check that settles after the instance
   * restarted or an import hold replaced it finds a newer value and discards
   * its stale verdict.
   */
  healthEpoch: number
  /**
   * Set by {@link ApplicationRuntime.unregister} when the application was asked
   * to unload while it still had work. The record is dropped the moment that
   * work really ends — never before, so a second load of the same id is refused
   * rather than aliasing a live instance.
   */
  unload: boolean
  /**
   * Mounted while the host's start gate was closed (activation is being read).
   * It must not run its start hook until the gate releases and its activation
   * is known to be enabled.
   */
  pendingStart: boolean
}

/** Internal mutable task record; snapshots are built at the boundary. */
interface TaskEntry {
  readonly taskId: TaskId
  readonly traceId: string
  readonly appId: AppId
  readonly kind: string
  readonly title: string
  readonly externalId?: string
  readonly requestId?: string
  readonly origin: TaskOrigin
  /** The application call chain that started this task (ancestors, current app included). */
  readonly chain: readonly AppId[]
  state: TaskState
  progress?: TaskProgress
  readonly startedAt: string
  updatedAt: string
  endedAt?: string
  error?: TaskError
  resultSummary?: JsonValue
  readonly controller: AbortController
  /** The task's work; assigned after the record exists. Never rejects. */
  done?: Promise<void>
}

/** The identity constants the runtime refuses to trust from outside. */
const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/u
const OP_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/u
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9-]*$/u

/** The app a call declaration names. */
function calledApp(call: AppCall): AppId {
  return typeof call === 'string' ? call : call.app
}

/**
 * The operations one declaration may call on one target.
 * @param declaration - the caller's declaration.
 * @param target - the target application.
 * @returns `all` for the legacy app-level form, the explicit ops, or undefined when not declared.
 */
export function declaredCallOps(declaration: AppDeclaration, target: AppId): 'all' | readonly OpName[] | undefined {
  for (const call of declaration.calls ?? []) {
    if (calledApp(call) !== target) continue
    return typeof call === 'string' ? 'all' : call.ops
  }
  return undefined
}

/** Validate the optional process declaration and its link to the capability. */
function assertProcessDeclarable(declaration: AppDeclaration): void {
  const process = declaration.process
  const declaresProcess = (declaration.capabilities ?? []).includes('process')
  if (process === undefined) {
    if (declaresProcess) throw new Error(`application ${declaration.id} declares the process capability but no process commands`)
    return
  }
  if (!declaresProcess) throw new Error(`application ${declaration.id} declares process commands but not the process capability`)
  if (process.length === 0 || process.length > 20) throw new Error(`application ${declaration.id} process declaration must list 1..20 executables`)
  const seen = new Set<string>()
  for (const entry of process) {
    if (typeof entry.executable !== 'string' || entry.executable.trim() === '' || entry.executable.length > 200) {
      throw new Error(`application ${declaration.id} process executable must be a non-empty 1..200 character string`)
    }
    if (seen.has(entry.executable)) throw new Error(`application ${declaration.id} process declares ${entry.executable} twice`)
    seen.add(entry.executable)
    if (typeof entry.purpose !== 'string' || entry.purpose.trim() === '' || entry.purpose.length > 500) {
      throw new Error(`application ${declaration.id} process purpose must be a non-empty 1..500 character string`)
    }
    if (!Array.isArray(entry.commands) || entry.commands.length === 0 || entry.commands.length > 50) {
      throw new Error(`application ${declaration.id} process ${entry.executable} must list 1..50 commands`)
    }
    const commands = new Set<string>()
    for (const command of entry.commands) {
      if (typeof command !== 'string' || command.trim() === '' || command.length > 100) {
        throw new Error(`application ${declaration.id} process ${entry.executable} command must be a non-empty 1..100 character string`)
      }
      if (commands.has(command)) throw new Error(`application ${declaration.id} process ${entry.executable} repeats command ${command}`)
      commands.add(command)
    }
  }
}

/** Validate one application's data description. */
function assertDataDeclarable(declaration: AppDeclaration, data: AppDataDeclaration): void {
  const schemaVersion = data.schemaVersion
  if (data.kind !== 'none') {
    if (schemaVersion === undefined || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new Error(`application ${declaration.id} data must carry a positive integer schemaVersion`)
    }
  }
  if (data.kind === 'none') {
    if (data.namespace !== undefined || data.path !== undefined) {
      throw new Error(`application ${declaration.id} data kind none cannot carry storage fields`)
    }
    return
  }
  if (data.namespace !== undefined && !APP_ID_PATTERN.test(data.namespace)) {
    throw new Error(`application ${declaration.id} data namespace ${JSON.stringify(data.namespace)} is malformed`)
  }
  if (data.path !== undefined) {
    if (data.path.trim() === '' || data.path.startsWith('/') || data.path.includes('\\') || data.path.split('/').includes('..')) {
      throw new Error(`application ${declaration.id} data path must be a relative path under the harness data root`)
    }
  }
  if (data.kind === 'unified') {
    if (data.namespace === undefined || data.path !== undefined) {
      throw new Error(`application ${declaration.id} unified data requires a namespace and no path`)
    }
    if (data.namespace !== declaration.id) {
      throw new Error(`application ${declaration.id} unified namespace must equal the application id`)
    }
    return
  }
  if (data.path === undefined || data.namespace !== undefined) {
    throw new Error(`application ${declaration.id} ${data.kind} data requires a path and no namespace`)
  }
}

/** Validate the declarations that share the durable-data namespace. */
function assertDataUnique(declaration: AppDeclaration, existing: Iterable<AppDeclaration>): void {
  const data = declaration.data
  if (data === undefined || data.kind === 'none') return
  /* v8 ignore next -- namespace/path are present for the matching kind */
  const key = data.kind === 'unified' ? `unified:${data.namespace ?? ''}` : `path:${data.path ?? ''}`
  for (const other of existing) {
    const otherData = other.data
    if (otherData === undefined || otherData.kind === 'none') continue
    /* v8 ignore next -- namespace/path are present for the matching kind */
    const otherKey = otherData.kind === 'unified' ? `unified:${otherData.namespace ?? ''}` : `path:${otherData.path ?? ''}`
    if (key === otherKey) throw new Error(`application ${declaration.id} data location collides with ${other.id}`)
  }
}

/**
 * Validates one declaration. Throws on a declaration the runtime cannot
 * honour — a registration that would half-work is refused whole.
 * @param declaration - the application declaration.
 * @throws when the id/op names are malformed, the operation set is empty, or a schema is not platform-supported.
 */
export function assertDeclarable(declaration: AppDeclaration): void {
  if (!APP_ID_PATTERN.test(declaration.id)) {
    throw new Error(`application id ${JSON.stringify(declaration.id)} must match ${String(APP_ID_PATTERN)}`)
  }
  if (declaration.name.trim() === '' || declaration.description.trim() === '') {
    throw new Error(`application ${declaration.id} must carry a name and a description`)
  }
  if (declaration.generation !== undefined && (!Number.isInteger(declaration.generation) || declaration.generation < 1)) {
    throw new Error(`application ${declaration.id} generation must be a positive integer`)
  }
  if (declaration.generation !== undefined && declaration.generation >= 2 && declaration.data === undefined) {
    throw new Error(`application ${declaration.id} generation ${declaration.generation} must declare data`)
  }
  if (declaration.data !== undefined) assertDataDeclarable(declaration, declaration.data)
  assertProcessDeclarable(declaration)
  if (declaration.health !== undefined && typeof declaration.health !== 'function') {
    throw new Error(`application ${declaration.id} health must be a function`)
  }
  const seenCalls = new Set<AppId>()
  for (const call of declaration.calls ?? []) {
    const target = calledApp(call)
    if (!APP_ID_PATTERN.test(target)) throw new Error(`application ${declaration.id} declares a malformed call target ${JSON.stringify(target)}`)
    if (target === declaration.id) throw new Error(`application ${declaration.id} cannot declare a call to itself`)
    if (seenCalls.has(target)) throw new Error(`application ${declaration.id} declares ${target} more than once`)
    seenCalls.add(target)
    if (typeof call !== 'string') {
      if (call.ops.length === 0) throw new Error(`application ${declaration.id} call to ${target} declares no operations`)
      if (new Set(call.ops).size !== call.ops.length) throw new Error(`application ${declaration.id} call to ${target} repeats an operation`)
      for (const op of call.ops) if (!OP_NAME_PATTERN.test(op)) throw new Error(`application ${declaration.id} call to ${target} names a malformed operation`)
    }
  }
  for (const [type, event] of Object.entries(declaration.events ?? {})) {
    if (!EVENT_TYPE_PATTERN.test(type)) throw new Error(`application ${declaration.id} event ${JSON.stringify(type)} must match ${String(EVENT_TYPE_PATTERN)}`)
    if (event.description.trim() === '') throw new Error(`application ${declaration.id} event ${type} must carry a description`)
    if (event.subscription !== undefined && event.subscription !== 'open' && event.subscription !== 'closed') {
      throw new Error(`application ${declaration.id} event ${type} has an invalid subscription setting`)
    }
  }
  const seenSubscriptions = new Set<string>()
  for (const subscription of declaration.subscriptions ?? []) {
    if (!APP_ID_PATTERN.test(subscription.appId)) throw new Error(`application ${declaration.id} declares a malformed subscription source ${JSON.stringify(subscription.appId)}`)
    if (!EVENT_TYPE_PATTERN.test(subscription.type)) throw new Error(`application ${declaration.id} declares a malformed subscription event ${JSON.stringify(subscription.type)}`)
    const key = `${subscription.appId}#${subscription.type}`
    if (seenSubscriptions.has(key)) throw new Error(`application ${declaration.id} repeats the subscription ${key}`)
    seenSubscriptions.add(key)
  }
  for (const [type, objectType] of Object.entries(declaration.objectTypes ?? {})) {
    if (!OBJECT_TYPE_PATTERN.test(type)) throw new Error(`application ${declaration.id} object type ${JSON.stringify(type)} must match ${String(OBJECT_TYPE_PATTERN)}`)
    const resolver = declaration.ops[objectType.resolveOperation]
    if (resolver === undefined) throw new Error(`application ${declaration.id} object type ${type} names the undeclared resolver ${objectType.resolveOperation}`)
    if ((resolver.effect ?? 'write') !== 'read') throw new Error(`application ${declaration.id} object type ${type} must use a read operation to resolve references`)
  }
  const opNames = Object.keys(declaration.ops)
  if (opNames.length === 0) throw new Error(`application ${declaration.id} declares no operations`)
  for (const [name, op] of Object.entries(declaration.ops)) {
    if (!OP_NAME_PATTERN.test(name)) throw new Error(`operation ${declaration.id}#${name} must match ${String(OP_NAME_PATTERN)}`)
    if ((declaration.generation ?? 1) >= 2 && op.effect === undefined) {
      throw new Error(`operation ${declaration.id}#${name} must declare effect`)
    }
    if (op.description.trim() === '') throw new Error(`operation ${declaration.id}#${name} must carry a description`)
    try {
      assertSupportedJsonSchema(parameterSchemaSpecToJsonSchema(op.params))
      assertSupportedJsonSchema(valueSchemaSpecToJsonSchema(op.result))
    } catch (error) {
      throw new Error(`operation ${declaration.id}#${name} carries an unsupported schema: ${String((error as Error).message)}`)
    }
  }
}

/**
 * The runtime. One instance per host: register applications, call them, stop
 * them, and read their state. All checks live on {@link call}; the ports carry
 * the questions the runtime cannot answer alone.
 */
export class ApplicationRuntime {
  private readonly apps = new Map<AppId, AppRecord>()
  private readonly changeListeners = new Set<ChangeListener>()
  private readonly lifecycleListeners = new Set<ChangeListener>()
  private readonly taskListeners = new Set<(notice: TaskNotice) => void>()
  private readonly eventBindings = new Set<EventBinding>()
  private confirm: ConfirmationPort | undefined
  private delegations: DelegationPort | undefined
  private grants: GrantStorePort | undefined
  private policies: PolicyStorePort | undefined
  private history: HistorySink | undefined
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly taskIdFactory: () => string
  private readonly stopBudgetMs: number
  private readonly healthTimeoutMs: number
  private readonly confirmationTimeoutMs: number
  private readonly onProblem: (problem: string) => void
  private grantsCache: CapabilityGrant[] | undefined
  private policiesCache: OperationPolicyEntry[] | undefined
  private policyChain: Promise<unknown> = Promise.resolve()
  /** The tail of the grant table's serial queue (see {@link changeGrants}). */
  private grantChain: Promise<unknown> = Promise.resolve()
  /**
   * The host's activation lookup, installed before application rows mount.
   * `undefined` means "no stored activation"; `disabled` suppresses start.
   */
  private activationResolver: ((appId: AppId) => Activation | undefined) | undefined
  /** The activation snapshot read before the runtime service was provided. */
  private readonly initialActivation: { readonly disabled: readonly AppId[]; readonly failure?: string } | undefined
  /**
   * Closed while the host reads its activation table. Application rows mount
   * with `pendingStart` instead of running their start hook, so a corrupt
   * activation file can fail closed before any application side effect.
   */
  private startGateOpen = true
  private serial = 0

  constructor(options: RuntimeOptions = {}) {
    this.confirm = options.confirm
    this.delegations = options.delegations
    this.grants = options.grants
    this.policies = options.policies
    this.history = options.history
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? (() => `call-${String(++this.serial)}`)
    this.taskIdFactory = options.taskIdFactory ?? (() => `task-${globalThis.crypto.randomUUID()}`)
    this.stopBudgetMs = options.stopBudgetMs ?? DEFAULT_STOP_BUDGET_MS
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS
    this.initialActivation = options.activation
    this.onProblem = options.onProblem ?? (() => {})
  }

  // ---- ports (wired by the host; every port has a safe absence) -----------

  /**
   * Install the confirmation channel. Without one, a call that needs
   * confirmation is rejected (`confirmation-unavailable`) — never allowed.
   * @param port - the channel.
   */
  useConfirmation(port: ConfirmationPort): void {
    this.confirm = port
  }

  /**
   * Install the host's activation lookup. It is consulted for every application
   * mounted after this call; an explicit `{ activation }` on {@link mount}
   * still wins. The bridge installs it before application rows mount.
   * @param resolver - the lookup, or undefined to remove it.
   */
  useActivationResolver(resolver: ((appId: AppId) => Activation | undefined) | undefined): void {
    this.activationResolver = resolver
  }

  /**
   * Close the start gate while the host reads its durable activation table.
   * Applications mounted now stay `stopped` with `pendingStart` set; no start
   * hook runs until {@link releaseStarts}. Compositions without a host bridge
   * never call this and keep the default-open behaviour.
   */
  holdStarts(): void {
    this.startGateOpen = false
  }

  /**
   * Open the start gate and start the applications whose activation is enabled.
   * Records that were explicitly disabled (or whose resolver says disabled)
   * stay stopped; a record that already started is never restarted.
   */
  releaseStarts(): void {
    this.startGateOpen = true
    for (const record of this.apps.values()) {
      if (!record.pendingStart || record.activation !== 'enabled') {
        record.pendingStart = false
        continue
      }
      record.pendingStart = false
      void this.startRecord(record)
    }
  }

  /**
   * Install the durable grant store. Without one, grants live in memory for
   * this process only; a failing store rejects the save (it never silently
   * reports success).
   * @param store - the store.
   */
  useGrantStore(store: GrantStorePort): void {
    this.grants = store
    this.grantsCache = undefined
  }

  /**
   * Install the host's durable delegation store. Without one, every delegation
   * port use fails with `delegation-unavailable`; it never invents a record.
   * @param port - the store.
   */
  useDelegationStore(port: DelegationPort): void {
    this.delegations = port
  }

  /**
   * Install the durable operation-policy store. Without one, policies live in
   * memory for this process only; a failing save rejects.
   * @param store - the store.
   */
  usePolicyStore(store: PolicyStorePort): void {
    this.policies = store
    this.policiesCache = undefined
  }

  /**
   * Install the history sink. Without one, no history is kept.
   * @param sink - the sink.
   */
  useHistory(sink: HistorySink): void {
    this.history = sink
  }

  // ---- registration -------------------------------------------------------

  /**
   * Mount one application and hand back its handle immediately. The
   * declaration is validated whole; a duplicate id, a malformed declaration or
   * a call target outside the declared `calls` list is refused. The start hook
   * runs as the application's OWN work: the record is `starting` until it
   * settles (a call made then is `unavailable`), a stop cancels it and waits
   * for it like any other work item, and a start failure leaves the application
   * `failed` (visible, not hidden) and not callable.
   *
   * Mounting without waiting is what lets a lifecycle owner — a Cordis row —
   * tie the application's fate to its own BEFORE the start can finish; an owner
   * that waited first could not cancel a start the unload is supposed to end.
   * @param declaration - the application declaration.
   * @returns the registration handle (status + stop), available at once.
   */
  mount(declaration: AppDeclaration, options: { readonly activation?: Activation } = {}): AppRegistration {
    assertDeclarable(declaration)
    if (this.apps.has(declaration.id)) throw new Error(`application ${declaration.id} is already registered`)
    assertDataUnique(declaration, [...this.apps.values()].map((record) => record.declaration))
    const activation = options.activation
      ?? (this.initialActivation === undefined
        ? undefined
        : this.initialActivation.failure !== undefined || this.initialActivation.disabled.includes(declaration.id)
          ? 'disabled'
          : 'enabled')
      ?? this.activationResolver?.(declaration.id)
      ?? 'enabled'
    const record: AppRecord = {
      declaration,
      abort: new AbortController(),
      status: 'stopped',
      activation,
      stopped: undefined,
      unload: false,
      pendingStart: activation === 'enabled' && !this.startGateOpen,
      health: 'ok',
      reason: undefined,
      detail: undefined,
      inFlight: new Set(),
      background: new Set(),
      tasks: new Map(),
      pendingConfirmations: new Set(),
      healthEpoch: 0,
    }
    this.apps.set(declaration.id, record)
    const registration: AppRegistration = {
      declaration,
      status: () => record.status,
      activation: () => record.activation,
      detail: () => record.detail,
      health: () => record.health,
      reason: () => record.reason,
    }
    if (record.activation === 'enabled' && this.startGateOpen) void this.startRecord(record)
    else this.notify(declaration.id, this.lifecycleListeners)
    return registration
  }

  /** Begin (or restart) one application's start hook; the caller owns waiting. */
  private startRecord(record: AppRecord): Promise<void> {
    record.abort = new AbortController()
    record.status = 'starting'
    record.stopped = undefined
    record.pendingHealthFailure = undefined
    this.clearDiagnostics(record)
    // A check still running for the PREVIOUS instance (a stop interrupted it,
    // or its hook ignores the abort) belongs to that instance: this start is a
    // fresh life and gets its own check, while the old one discards its result.
    record.checking = undefined
    record.unload = false
    const declaration = record.declaration
    const starting = (async (): Promise<void> => {
      try {
        await declaration.start?.(this.appContext(record))
        if (record.status === 'starting') this.enter(record, 'available')
      } catch (error) {
        const reason = String((error as Error)?.message ?? error)
        // A start that fails after the stop began is not the application's
        // state any more: the stop owns it, and the failure is reported, not
        // written over the lifecycle.
        if (record.status !== 'starting') {
          this.onProblem(`application ${declaration.id} start failed after its stop began: ${reason}`)
          return
        }
        record.detail = reason
        record.health = 'degraded'
        record.reason = 'platform.start-failed'
        record.activation = 'disabled'
        // A failed start is also a stop: cancel the work the hook started,
        // end its subscriptions, and keep the record until that work is gone.
        record.abort.abort()
        this.removeEventBindings(declaration.id)
        this.enter(record, 'failed')
      }
    })().finally(() => {
      // A settled start is no longer work a stop has to wait for.
      record.starting = undefined
    })
    record.starting = starting
    // The health check runs AFTER the start settles and is deliberately NOT
    // part of the start's own work: an application's stop must not wait for a
    // health hook (the health timeout bounds that hook, not the stop budget),
    // and a late result is discarded once this instance moves on.
    void starting.then(() => {
      if (record.status === 'available') void this.ensureHealthCheck(record)
    })
    this.notify(declaration.id, this.lifecycleListeners)
    return starting
  }

  /**
   * Enable or disable one application. Disabling stops its work first; enabling
   * restarts a stopped or failed application. An application the user left
   * enabled can still be DOWN: a failed health check stops the instance without
   * touching the user setting, and this explicit enable is the user's recovery
   * action. Activation is separate from health and from permissions: it does
   * not grant or revoke anything, and the platform never restarts an
   * application on its own.
   * @param id - the application.
   * @param activation - the new activation.
   */
  async setActivation(id: AppId, activation: Activation): Promise<void> {
    const record = this.apps.get(id)
    if (record === undefined) throw new Error(`application ${id} is not registered`)
    if (record.activation === activation) {
      // The setting is already what was asked for. Only an explicit enable of a
      // down instance is a real request (a health-failed stop, or a failed
      // start); every other repeat is idempotent and changes nothing.
      if (activation === 'disabled' || (record.status !== 'stopped' && record.status !== 'failed')) return
    }
    if (activation === 'disabled') {
      /* v8 ignore next -- disabling a stopped record needs no stop */
      if (record.status === 'starting' || record.status === 'available' || record.status === 'stopping') await this.stop(id)
      else if (record.status === 'stop-incomplete') {
        const status = await this.stop(id)
        if (status !== 'stopped') throw new AppError('stop-incomplete', `application ${id} is still ${status}; retry the stop`)
      } else if (record.status === 'stopped' || record.status === 'failed') this.clearDiagnostics(record)
      record.activation = 'disabled'
      this.notify(id, this.lifecycleListeners)
      return
    }
    if (record.status === 'stopping' || record.status === 'stop-incomplete') {
      throw new AppError('activation-busy', `application ${id} is ${record.status}; wait for its work to end before enabling it`)
    }
    record.activation = 'enabled'
    if (!this.startGateOpen) {
      record.pendingStart = true
      this.notify(id, this.lifecycleListeners)
      return
    }
    /* v8 ignore next 4 -- a disabled record is stopped; this guards a start/disable race */
    if (record.status === 'available' || record.status === 'starting') {
      this.notify(id, this.lifecycleListeners)
      return
    }
    await this.startRecord(record)
    // Enabling waits for the health result the start scheduled: a caller that
    // reads the row right after this returns sees the real health, not a
    // transiently-ok instance.
    await this.ensureHealthCheck(record)
  }

  /**
   * Mount one application and wait for its start to settle: {@link mount} plus
   * the wait, for callers that want the application available when they return.
   * A stop that begins while start is still running owns the status from that
   * moment: the late start result — success or failure — never reopens the
   * application and never overwrites the stop.
   * @param declaration - the application declaration.
   * @returns the registration handle, once start has settled.
   */
  async register(declaration: AppDeclaration, options: { readonly activation?: Activation } = {}): Promise<AppRegistration> {
    const registration = this.mount(declaration, options)
    const record = this.apps.get(declaration.id)
    await record?.starting
    // Wait for the health result the settled start scheduled, so the returned
    // registration already reports the application's real health.
    if (record !== undefined && record.status === 'available') await this.ensureHealthCheck(record)
    return registration
  }

  /**
   * Run one application's declared health check NOW (the management page's
   * explicit "check" action), map the result onto the public state and wait for
   * it to apply. It is not an operation: no caller identity, grant or permission
   * is involved, and it never runs per call or on a timer. The hook is the
   * application's and only the platform interprets its result; the check is
   * bounded by the runtime's health timeout.
   *
   * A check started while another one is in flight joins it instead of running
   * the hook twice. Only an available instance is checked: a stopped (or
   * health-failed) instance must be enabled again first, and an instance under
   * an import hold must wait for the hold to be released.
   * @param id - the registered application.
   * @returns when the check (if there was one to run) has applied its result.
   * @throws when the application is not registered, not available, or held.
   */
  async checkHealth(id: AppId): Promise<void> {
    const record = this.apps.get(id)
    if (record === undefined) throw new Error(`application ${id} is not registered`)
    if (record.declaration.health === undefined) return
    if (record.maintenance !== undefined) {
      throw new AppError('health-unavailable', `application ${id} is held for an import; check again when the import settles`)
    }
    if (record.status !== 'available') {
      throw new AppError('health-unavailable', `application ${id} is ${record.status}; enable it and wait until it is available before checking its health`)
    }
    await this.ensureHealthCheck(record)
  }

  /**
   * Unload one application — the row is gone, its registration should follow.
   * A registration whose work has really ended (`stopped`, or `failed` before
   * any work ran) is dropped here and now; one that is still starting, running
   * or stopping keeps its registration — and its id, so a second load of the
   * same id is refused instead of aliasing a live instance — and is dropped the
   * moment it reaches `stopped`. Deleting it eagerly would erase the only
   * evidence that work is still running.
   * @param id - the application to unload.
   * @returns whether the registration was dropped now (`false` = it will be dropped when the work ends).
   * @throws when no application is registered under that id.
   */
  unregister(id: AppId): boolean {
    const record = this.apps.get(id)
    if (record === undefined) throw new Error(`application ${id} is not registered`)
    /* v8 ignore next -- stop-incomplete keeps its failed record for inspection */
    if (record.status === 'stopped' || (record.status === 'failed' && this.pending(record).length === 0)) {
      this.apps.delete(id)
      this.notify(id, this.lifecycleListeners)
      return true
    }
    record.unload = true
    return false
  }

  /** All registered applications, in registration order. */
  list(): readonly AppRegistration[] {
    return [...this.apps.values()].map((record) => ({
      declaration: record.declaration,
      status: () => record.status,
      activation: () => record.activation,
      detail: () => record.detail,
      health: () => record.health,
      reason: () => record.reason,
    }))
  }

  /**
   * Ask one available application to re-read its durable data after an
   * external writer changed it (the host's data import). The hook does not
   * change the lifecycle: the application stays available and its calls are
   * not cancelled. An application without a hook is a no-op; an unavailable
   * one is refused, because a start/stop owns its storage then.
   * @param id - the application whose cached data should be refreshed.
   * @returns when the application's reload hook settled.
   */
  async reload(id: AppId): Promise<void> {
    const record = this.apps.get(id)
    if (record === undefined) throw new Error(`application ${id} is not registered`)
    if (record.status !== 'available') throw new Error(`application ${id} is ${record.status}, not available`)
    await record.declaration.reload?.(this.appContext(record))
  }

  /**
   * Take one available application out of service for an import: refuse new
   * calls from this moment, run the application's pause hook, then wait (all
   * inside the same stop budget, counted from the entry) for the work the
   * application already owns — in-flight calls, tracked background work and a
   * start still in flight — to settle. A pause hook that outlives the budget is
   * reported as `maintenance-busy` like the drain: the hook is never killed, but
   * the host's wait is bounded, and a late pause cannot revive the hold or undo
   * a newer one (LIFE-001). If that work outlives the
   * budget the hold is cleared and the caller receives `maintenance-busy`;
   * nothing has been imported. The returned lease keeps the hold across the
   * import and the reload; a failed reload leaves it in place so the
   * application cannot serve its stale cache until
   * {@link MaintenanceLease.release} or {@link endMaintenance} (the retry path).
   * @param id - the application whose data is being replaced.
   * @returns the held lease.
   */
  async beginMaintenance(id: AppId): Promise<MaintenanceLease> {
    const record = this.apps.get(id)
    if (record === undefined) throw new Error(`application ${id} is not registered`)
    if (record.status !== 'available') throw new Error(`application ${id} is ${record.status}, not available`)
    if (record.maintenance !== undefined) throw new AppError('maintenance', `application ${id} is already waiting for a successful reload`)
    const token = ++this.serial
    record.maintenance = { token }
    record.health = 'degraded'
    record.reason = 'platform.updating'
    record.detail = 'application data is being updated'
    this.notify(id, this.lifecycleListeners)
    const context = this.appContext(record)
    // ONE budget for the whole sequence (pause, then the drain), counted from
    // the entry: a pause hook is application code and must not hold the import
    // (or the next one behind it) unbounded (LIFE-001). The hook is not killed;
    // a late pause is settled below without touching a newer hold.
    const deadline = Date.now() + this.stopBudgetMs
    // Invoke the hook NOW (a pause is the first thing the import does), but
    // never await it unbounded: a synchronous throw is the same refusal as a
    // rejection, and both are read through `pause`.
    const started = ((): Promise<unknown> => {
      try {
        return Promise.resolve(record.declaration.pause?.(context))
      } catch (error) {
        return Promise.reject(error)
      }
    })()
    const pause = started.then(() => ({ failure: undefined as unknown }), (error: unknown) => ({ failure: error }))
    if (!(await waitWithin([pause], deadline)).ended) {
      const owned = record.maintenance?.token === token
      if (owned) {
        record.maintenance = undefined
        this.clearDiagnostics(record)
      }
      // Resume only once the late pause really finished, and only when no other
      // hold/app state owns the application by then: a timeout reports the
      // wait as unfinished instead of pretending the pause did not happen.
      void pause.then(({ failure }) => {
        if (failure !== undefined) {
          this.onProblem(`application ${id} pause hook failed after the import budget: ${String((failure as Error)?.message ?? failure)}`)
          return
        }
        // A hold released by its real owner already resumed the application;
        // resuming again here would duplicate that hook.
        if (!owned) return
        if (record.maintenance === undefined && record.status === 'available') void this.resumeAndCheck(record, context)
      })
      throw new AppError('maintenance-busy', `application ${id} did not pause within the ${String(this.stopBudgetMs)}ms import budget; retry when it is idle`, true)
    }
    const paused = await pause
    if (paused.failure !== undefined) {
      if (record.maintenance?.token === token) {
        record.maintenance = undefined
        this.clearDiagnostics(record)
      }
      throw new AppError('maintenance-pause-failed', `application ${id} could not pause for the import: ${String((paused.failure as Error)?.message ?? paused.failure)}`, true)
    }
    try {
      if (await this.quiet(record, deadline)) {
        if (record.maintenance?.token !== token) throw new Error(`application ${id} left its import hold while the work settled`)
        return {
          appId: id,
          release: async () => {
            if (record.maintenance?.token !== token) return
            record.maintenance = undefined
            this.clearDiagnostics(record)
            await this.resumeAndCheck(record, context)
          },
        }
      }
    } catch (error) {
      if (record.maintenance?.token === token) {
        record.maintenance = undefined
        this.clearDiagnostics(record)
        await this.resumeAndCheck(record, context)
      }
      throw error
    }
    if (record.maintenance?.token === token) {
      record.maintenance = undefined
      this.clearDiagnostics(record)
      await this.resumeAndCheck(record, context)
    }
    throw new AppError('maintenance-busy', `application ${id} still owns running work after the ${String(this.stopBudgetMs)}ms import budget; retry when it is idle`, true)
  }

  /**
   * Clear an import hold by id, for the retry path after a failed reload. A
   * hold that is still owned by another caller is cleared too: the host owns
   * the import lifecycle and serializes imports, so the app id is the identity
   * of the maintenance state.
   * @param id - the application to release.
   */
  async endMaintenance(id: AppId): Promise<void> {
    const record = this.apps.get(id)
    if (record === undefined || record.maintenance === undefined) return
    record.maintenance = undefined
    this.clearDiagnostics(record)
    await this.resumeAndCheck(record, this.appContext(record))
  }

  /** Run the application's resume hook; a failure is a reported problem, not a throw. */
  private async resumeRecord(record: AppRecord, context: AppContext): Promise<void> {
    try {
      await record.declaration.resume?.(context)
    } catch (error) {
      this.onProblem(`application ${record.declaration.id} resume hook failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /**
   * The recovery path every import hold ends with: re-arm the application's
   * work, then re-read its health. The check is the application's declared one
   * and only runs for a live, unheld instance; a health result that stops the
   * application is a normal outcome here, not an error of the recovery.
   */
  private async resumeAndCheck(record: AppRecord, context: AppContext): Promise<void> {
    // A check still running while the import hold was placed belongs to the
    // pre-import instance and is discarded by the hold; the recovery starts a
    // fresh one, so the stale promise must not be joined as "already running".
    record.checking = undefined
    await this.resumeRecord(record, context)
    await this.checkAfterRecovery(record)
  }

  /** Whether one application is held out of service for an import. */
  maintenance(id: AppId): boolean {
    return this.apps.get(id)?.maintenance !== undefined
  }

  /**
   * Stop one application, in this order: refuse new calls (the status becomes
   * `stopping` before anything is awaited), end the pending confirmations, ask
   * everything the application owns to cancel (in-flight operations, tracked
   * background work, a start still in flight), WAIT for that work to end, and
   * only then run the application's own stop hook, which releases its
   * resources. The whole sequence — the wait and the hook together — is bounded
   * by one stop budget: work or a hook that outlives it is reported as
   * `stop-incomplete`, never as cancelled and never as `stopped`, and the
   * application is not restarted. A hook that throws is a failed cleanup and is
   * reported the same way.
   * @param id - the application to stop.
   * @returns the status at the budget (or when the stop really finished); a re-entrant call joins the first.
   */
  async stop(id: AppId): Promise<AppStatus> {
    const record = this.apps.get(id)
    if (record === undefined) throw new Error(`application ${id} is not registered`)
    if (record.stopped !== undefined) return await record.stopped
    // A re-entrant stop joins the first one. The hook/late cleanup may still be
    // running after a stop-incomplete; rerunning them would release resources twice.
    if (record.stopHook !== undefined || record.stopLate !== undefined) return record.status
    if (record.pendingStart) {
      record.pendingStart = false
      this.enter(record, 'stopped')
      return record.status
    }
    this.enter(record, 'stopping')
    const stopped = this.runStop(record)
    record.stopped = stopped
    // A stop that could not finish is a state the user must be able to retry;
    // only a settled stop stays as the re-entrant answer. Without this, one
    // failed cleanup would pin the id for the rest of the process.
    /* v8 ignore next 6 -- runStop never rejects in the tested model; the rejection arm is defensive */
    void stopped.then((status) => {
      if (record.stopped === stopped && status === 'stop-incomplete') record.stopped = undefined
    }, () => {
      if (record.stopped === stopped) record.stopped = undefined
    })
    return await stopped
  }

  private async runStop(record: AppRecord): Promise<AppStatus> {
    // 1. End the questions nobody can answer any more, then cancel everything
    //    the application owns: one signal reaches in-flight operations,
    //    background work and a start still in flight. A stop also ends any
    //    import hold: the application is no longer serving calls either way.
    record.maintenance = undefined
    this.removeEventBindings(record.declaration.id)
    for (const controller of record.pendingConfirmations) controller.abort()
    record.abort.abort()

    // 2. Wait for that work to end, then clean up — both inside ONE budget, so
    //    a hook that hangs is as incomplete as work that never stops.
    const deadline = Date.now() + this.stopBudgetMs
    if (!await this.quiet(record, deadline)) {
      const status = this.incomplete(record, `${String(this.pending(record).length)} work item(s) still running after the ${String(this.stopBudgetMs)}ms stop budget`)
      // The hook was NOT skipped: cleanup still has to happen, so it runs once
      // the work really ends, and only then does the status reach `stopped`.
      // Nothing here reopens the application for calls.
      const late = this.lateCleanup(record)
      record.stopLate = late
      /* v8 ignore next -- the late cleanup owns the field until it settles */
      void late.finally(() => { if (record.stopLate === late) record.stopLate = undefined })
      return status
    }

    const hook = this.runStopHook(record)
    record.stopHook = hook
    /* v8 ignore next -- a newer stop cannot replace this hook; the identity check is defensive */
    void hook.finally(() => { if (record.stopHook === hook) record.stopHook = undefined })
    if (!(await waitWithin([hook], deadline)).ended) {
      const status = this.incomplete(record, `the stop hook did not finish within the ${String(this.stopBudgetMs)}ms stop budget`)
      // The hook is still running: when it really ends, the status follows what
      // its cleanup earned (only the hook's own work is left to wait for).
      void hook.then(async (failure) => {
        if (failure !== undefined) { this.reportHookFailure(record, failure); return }
        await this.lateFinalize(record)
      })
      return status
    }
    const failure = await hook
    if (failure !== undefined) return this.incomplete(record, `the stop hook failed: ${failure}`)
    return this.settleCleanup(record)
  }

  /**
   * Wait until the application owns no work at all, or until `deadline` passes.
   * The wait repeats: work that ends may have started more work (a task can
   * spawn another task, for instance).
   */
  private async quiet(record: AppRecord, deadline: number): Promise<boolean> {
    for (;;) {
      const pending = this.pending(record)
      if (pending.length === 0) return true
      if (!(await waitWithin(pending, deadline)).ended) return false
    }
  }

  /**
   * The last step of a stop: the hook has run inside the budget, and nothing it
   * owns can start now (new calls and tasks are refused while `stopping`). A
   * hook that needs its release work waited for must await it — the stop budget
   * bounds the hook itself. So the application is stopped here.
   */
  private settleCleanup(record: AppRecord): AppStatus {
    this.enter(record, 'stopped')
    return record.status
  }

  /**
   * Late path A — the WORK outlived the budget, so the hook has not run at all.
   * When the work really ends, the hook runs, and only then does the status
   * reach `stopped` (a cleanup that fails keeps it `stop-incomplete`).
   */
  private async lateCleanup(record: AppRecord): Promise<void> {
    await this.quiet(record, Number.POSITIVE_INFINITY)
    const failure = await this.runStopHook(record)
    if (failure !== undefined) { this.reportHookFailure(record, failure); return }
    await this.lateFinalize(record)
  }

  /**
   * Late path B — the hook already ran (or was still running and just ended):
   * only the work it started is left, and the status reaches `stopped` when
   * that work really ends.
   */
  private async lateFinalize(record: AppRecord): Promise<void> {
    await this.quiet(record, Number.POSITIVE_INFINITY)
    this.enter(record, 'stopped')
  }

  /** Run the application's own stop hook; its failure is returned, never thrown at the stop. */
  private async runStopHook(record: AppRecord): Promise<string | undefined> {
    try {
      await record.declaration.stop?.(this.appContext(record))
      return undefined
    } catch (error) {
      return String((error as Error)?.message ?? error)
    }
  }

  private reportHookFailure(record: AppRecord, failure: string): void {
    this.onProblem(`application ${record.declaration.id} stop hook failed after the stop budget: ${failure}`)
  }

  /** Mark one stop as not finished, and report why. */
  private incomplete(record: AppRecord, reason: string): AppStatus {
    this.onProblem(`application ${record.declaration.id} stop incomplete: ${reason}`)
    record.detail = reason
    this.enter(record, 'stop-incomplete')
    return record.status
  }

  /** Everything the application still owns: its start, its calls, its background work. */
  private pending(record: AppRecord): Promise<unknown>[] {
    return [...record.inFlight, ...record.background, ...(record.starting === undefined ? [] : [record.starting])]
  }

  /**
   * Move one application into a status, and drop a registration that was asked
   * to unload the moment its work has really ended.
   */
  private enter(record: AppRecord, status: AppStatus): void {
    record.status = status
    // A late stop (the work outlived the budget) reaches `stopped` after the
    // retry cache was cleared; without this terminal cache a second stop would
    // run the hook again and a failing hook could pin the id forever.
    if (status === 'stopped') record.stopped = Promise.resolve('stopped')
    if (status === 'available' || status === 'stopped') {
      // A normal start/stop owns the health/reason/detail fields: a stale
      // maintenance hold, a previous health failure or a failed start's reason
      // must not survive the lifecycle transition it no longer explains.
      this.clearDiagnostics(record)
      const pendingHealth = record.pendingHealthFailure
      if (status === 'stopped' && pendingHealth !== undefined) {
        record.pendingHealthFailure = undefined
        record.health = 'degraded'
        record.reason = 'platform.health-failed'
        record.detail = pendingHealth.detail
      }
    } else if (status === 'stop-incomplete') {
      record.health = 'degraded'
      record.reason = 'platform.stop-incomplete'
    }
    if (record.unload === true && (status === 'stopped' || status === 'failed')) {
      this.apps.delete(record.declaration.id)
    }
    this.notify(record.declaration.id, this.lifecycleListeners)
  }

  /** Clear the mutable diagnostics (health/reason/detail) to their healthy default. */
  private clearDiagnostics(record: AppRecord): void {
    record.health = 'ok'
    record.reason = undefined
    record.detail = undefined
  }

  // ---- health checks ---------------------------------------------------------

  /**
   * Run the declared health check after a recovery (a settled start or an
   * import hold release) when the instance is live and not held. A check never
   * runs for a stopped/starting instance, never overlaps another check of the
   * same instance, and never runs per call or on a timer.
   */
  private async checkAfterRecovery(record: AppRecord): Promise<void> {
    if (record.declaration.health === undefined) return
    if (record.maintenance !== undefined) return
    /* v8 ignore next -- a recovery path resumes an available instance; stopped/starting is a race */
    if (record.status !== 'available') return
    await this.ensureHealthCheck(record)
  }

  /**
   * Join the health check already in flight for this instance, or start one.
   * The promise never rejects (a failing hook is a diagnostic), so callers may
   * await it for deterministic rows.
   */
  private ensureHealthCheck(record: AppRecord): Promise<void> {
    const running = record.checking
    if (running !== undefined) return running
    const epoch = ++record.healthEpoch
    const checking = this.runHealthCheck(record, epoch)
    record.checking = checking
    void checking.finally(() => {
      if (record.checking === checking) record.checking = undefined
    })
    return checking
  }

  /**
   * Run one health hook under the platform timeout and map its result onto the
   * public state. Never throws: a thrown hook, a timeout and an invalid result
   * are reported as degraded with a platform diagnostic in `detail` and NO new
   * reason code. A result that arrives after the instance moved on (stopped,
   * restarted, held, unloaded) is discarded instead of overwriting the newer
   * state. Only an explicit `unhealthy` stops the instance; the activation
   * setting is the user's and is not changed here, and nothing restarts it.
   */
  private async runHealthCheck(record: AppRecord, epoch: number): Promise<void> {
    const check = record.declaration.health
    if (check === undefined) return
    // Only a live, unheld instance is checked: a check raced by a stop or an
    // import hold is a no-op rather than a hook run against dead state.
    if (record.status !== 'available' || record.maintenance !== undefined) return
    const id = record.declaration.id
    const lifetime = record.abort
    const controller = new AbortController()
    const forwardAbort = (): void => { controller.abort(lifetime.signal.reason) }
    if (lifetime.signal.aborted) forwardAbort()
    else lifetime.signal.addEventListener('abort', forwardAbort, { once: true })
    const settled = (async (): Promise<HealthInvocation> => {
      try {
        return { result: await check({ signal: controller.signal }) }
      } catch (error) {
        return { failure: `health check failed: ${healthDetailText(error)}` }
      }
    })()
    const deadline = Date.now() + this.healthTimeoutMs
    const inTime = (await waitWithin([settled], deadline)).ended
    lifetime.signal.removeEventListener('abort', forwardAbort)
    if (!inTime) controller.abort(new Error('the health check timed out'))
    if (!this.healthResultApplies(record, lifetime, epoch)) return
    if (!inTime) {
      this.applyHealthDiagnostic(record, `health check timed out after ${String(this.healthTimeoutMs)}ms`)
      return
    }
    const outcome = await settled
    if (!this.healthResultApplies(record, lifetime, epoch)) return
    if (outcome.failure !== undefined) {
      this.applyHealthDiagnostic(record, outcome.failure)
      return
    }
    const result = validateHealthResult(outcome.result)
    if (result === undefined) {
      this.applyHealthDiagnostic(record, 'health check returned an invalid result')
      return
    }
    if (result.status === 'ok') {
      this.clearDiagnostics(record)
      this.notify(id, this.lifecycleListeners)
      return
    }
    if (result.status === 'degraded') {
      record.health = 'degraded'
      // A degraded report is the application's, not a platform reason code.
      record.reason = undefined
      record.detail = result.reason
      this.notify(id, this.lifecycleListeners)
      return
    }
    // Only an explicit `unhealthy` stops the instance. The activation setting
    // stays the user's (the public state is stopped + health degraded + the
    // stable reason); the platform never restarts it, and the user's explicit
    // enable is the recovery action (see setActivation).
    record.pendingHealthFailure = { reason: 'platform.health-failed', detail: result.reason ?? 'the application reported unhealthy' }
    record.health = 'degraded'
    record.reason = 'platform.health-failed'
    record.detail = result.reason
    this.notify(id, this.lifecycleListeners)
    // A stop that cannot finish keeps its own diagnostic until the late
    // cleanup reaches `stopped`; `enter('stopped')` re-applies this pending
    // health failure, so the reason is not lost between the two transitions.
    await this.stop(id)
    /* v8 ignore next 3 -- a later start/stop owns the terminal state; this is a defensive guard */
    if (this.apps.get(id) !== record) return
    if ((record.status as AppStatus) !== 'stopped') return
    this.notify(id, this.lifecycleListeners)
  }

  /** Whether a health result still describes the live instance it was asked of. */
  private healthResultApplies(record: AppRecord, lifetime: AbortController, epoch: number): boolean {
    return record.healthEpoch === epoch && record.abort === lifetime && record.status === 'available' && record.maintenance === undefined
  }

  /** Apply a platform diagnostic (timeout, throw, invalid result) without inventing a reason code. */
  private applyHealthDiagnostic(record: AppRecord, detail: string): void {
    record.health = 'degraded'
    record.reason = undefined
    record.detail = detail
    this.notify(record.declaration.id, this.lifecycleListeners)
  }

  // ---- object references -----------------------------------------------------

  /**
   * Resolve one cross-application object reference through the owning
   * application's declared read operation. The resolver receives only `{ id }`
   * and the caller's real identity; a result that names another ref, has an
   * empty title or a non-string summary is refused. A failure is a VALUE: the
   * bridge folds every thrown error into one transport code, so an exception
   * here would erase the reason the reference could not be read.
   * @param caller - the trusted caller resolving the reference.
   * @param ref - the reference to resolve.
   * @returns the display facts, or the stable reason they could not be read.
   */
  async resolveObject(caller: Caller, ref: ObjectRef): Promise<ObjectResolutionResult> {
    const refuse = (code: string, message: string): ObjectResolutionResult => ({ ok: false, error: errorBody(code, message) })
    if (typeof ref.appId !== 'string' || typeof ref.type !== 'string' || typeof ref.id !== 'string'
      || ref.appId === '' || ref.type === '' || ref.id === '') {
      return refuse('object-invalid-ref', 'an object reference needs non-empty appId, type and id')
    }
    const record = this.apps.get(ref.appId)
    if (record === undefined) return refuse('object-unknown-app', `no application ${ref.appId}`)
    const type = record.declaration.objectTypes?.[ref.type]
    if (type === undefined) return refuse('object-unknown-type', `application ${ref.appId} does not declare the object type ${ref.type}`)
    const outcome = await this.call(caller, ref.appId, type.resolveOperation, { id: ref.id })
    // The operation's own code is the reference's reason: the target says
    // `app.not-found` when the object is gone, and that is the one fact a
    // caller may branch on.
    if (outcome.status !== 'success') return { ok: false, error: outcome.error! }
    const value = outcome.result
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return refuse('object-invalid-resolution', 'the resolver did not return a resolution object')
    }
    const resolution = value as Record<string, unknown>
    const resolvedRef = resolution.ref
    const title = resolution.title
    const summary = resolution.summary
    if (resolvedRef === null || typeof resolvedRef !== 'object' || Array.isArray(resolvedRef)
      || (resolvedRef as Record<string, unknown>).appId !== ref.appId
      || (resolvedRef as Record<string, unknown>).type !== ref.type
      || (resolvedRef as Record<string, unknown>).id !== ref.id) {
      return refuse('object-invalid-resolution', 'the resolver returned a different object reference')
    }
    if (typeof title !== 'string' || title.trim() === '') {
      return refuse('object-invalid-resolution', 'the resolver returned no display title')
    }
    if (summary !== undefined && typeof summary !== 'string') {
      return refuse('object-invalid-resolution', 'the resolver summary must be a string')
    }
    return { ok: true, value: { ref: { appId: ref.appId, type: ref.type, id: ref.id }, title, ...(summary === undefined ? {} : { summary }) } }
  }

  // ---- events --------------------------------------------------------------

  /**
   * Publish one declared, refs-only event. Identity and time are bound here;
   * the caller cannot supply another application's identity, an eventId or a
   * body. Delivery is best-effort and never makes the publisher fail.
   * @param publisher - the application publishing.
   * @param type - the declared event type.
   * @param refs - optional affected-object references owned by the publisher.
   * @returns the event as delivered.
   */
  publishEvent(publisher: AppId, type: string, refs?: readonly ObjectRef[]): AppEvent {
    const record = this.apps.get(publisher)
    if (record === undefined) throw new AppError('event-unknown-app', `no application ${publisher}`)
    if (record.declaration.events?.[type] === undefined) throw new AppError('event-undeclared', `application ${publisher} does not declare the event ${type}`)
    for (const ref of refs ?? []) {
      if (ref.appId !== publisher || typeof ref.type !== 'string' || ref.type === '' || typeof ref.id !== 'string' || ref.id === '') {
        throw new AppError('event-ref-invalid', `event ${publisher}#${type} may reference only its own objects with non-empty type and id`)
      }
    }
    const event: AppEvent = {
      kind: 'app-event',
      appId: publisher,
      type,
      eventId: `event-${String(++this.serial)}`,
      occurredAt: this.now().toISOString(),
      ...(refs === undefined || refs.length === 0 ? {} : { refs: refs.map(ref => ({ appId: ref.appId, type: ref.type, id: ref.id })) }),
    }
    for (const binding of [...this.eventBindings]) {
      if (binding.publisher !== publisher || binding.type !== type) continue
      // A publisher that is not ready or has not opened the event yet keeps the
      // intent: startup must not fail for a collaboration that is merely
      // unavailable, and delivery re-checks the declaration at publish time.
      if (!this.eventBindingReady(binding)) continue
      // No standing grant yet: the intent waits for the user's approval instead
      // of being discarded, so approving it later takes effect immediately.
      if (!this.eventBindingApproved(binding)) continue
      try {
        void Promise.resolve(binding.listener(event)).catch((error: unknown) => {
          this.onProblem(`application ${binding.subscriber} failed to handle event ${publisher}#${type}: ${String((error as Error)?.message ?? error)}`)
        })
      } catch (error) {
        this.onProblem(`application ${binding.subscriber} failed to handle event ${publisher}#${type}: ${String((error as Error)?.message ?? error)}`)
      }
    }
    return event
  }

  /**
   * Record one subscription intent. The subscriber must declare the pair; a
   * publisher that is not registered yet is deferred rather than refused, so an
   * application may subscribe before the application it watches starts. A
   * registered publisher whose event is missing or closed also keeps the intent
   * (and reports a diagnostic) instead of failing the subscriber's start;
   * delivery is gated by the declaration and the user's standing grant at
   * publish time, so opening or approving the subscription later takes effect
   * without restarting the subscriber.
   * @param subscriber - the application subscribing.
   * @param publisher - the application publishing.
   * @param type - the publisher's event type.
   * @param listener - the subscriber's callback.
   * @returns the unsubscribe function.
   */
  async subscribe(subscriber: AppId, publisher: AppId, type: string, listener: AppEventListener): Promise<() => void> {
    const subscriberRecord = this.apps.get(subscriber)
    if (subscriberRecord === undefined) throw new AppError('event-unknown-app', `no application ${subscriber}`)
    const declared = (subscriberRecord.declaration.subscriptions ?? []).some(entry => entry.appId === publisher && entry.type === type)
    if (!declared) throw new AppError('subscription-undeclared', `application ${subscriber} does not declare the subscription ${publisher}#${type}`)
    const publisherRecord = this.apps.get(publisher)
    if (publisherRecord !== undefined) {
      const declaration = publisherRecord.declaration.events?.[type]
      if (declaration === undefined || (declaration.subscription ?? 'closed') !== 'open') {
        // The publisher is registered but the event is not open yet. Keep the
        // intent: a subscriber's start must not fail for a collaboration that is
        // merely unavailable, and delivery re-checks the declaration.
        this.onProblem(`subscription ${subscriber}#${publisher}:${type} waits: the publisher does not offer the event`)
      }
    }
    // Delivery runs synchronously and reads the standing grant table from the
    // cache, so warm that cache now: the first publish after this subscription
    // must be able to see an approval the user already made.
    await this.loadGrants()
    const binding: EventBinding = { subscriber, publisher, type, listener }
    this.eventBindings.add(binding)
    return () => { this.eventBindings.delete(binding) }
  }

  /**
   * Whether a live binding's publisher and event are ready for delivery now.
   * A missing publisher or a not-yet-open event keeps the intent alive and
   * only skips this publish; the subscriber removes its bindings when it stops.
   * The standing grant is a separate question ({@link eventBindingApproved})
   * because a missing grant must keep the intent alive for a later approval.
   */
  private eventBindingReady(binding: EventBinding): boolean {
    const publisher = this.apps.get(binding.publisher)
    /* v8 ignore next -- publishEvent has already refused an unregistered publisher */
    if (publisher === undefined) return false
    /* v8 ignore next -- a stopping publisher cannot start a new publish; a late one may race it */
    if (publisher.status !== 'available' && publisher.status !== 'starting') return false
    const event = publisher.declaration.events?.[binding.type]
    /* v8 ignore next -- publishEvent refuses an event the publisher does not declare */
    if (event === undefined) return false
    return event.subscription === 'open'
  }

  /**
   * Whether the user currently allows this subscription. Publish runs
   * synchronously, so this reads the grant table already loaded by the last
   * grant change; a missing cache delivers nothing rather than guessing.
   */
  private eventBindingApproved(binding: EventBinding): boolean {
    const grants = this.grantsCache
    /* v8 ignore next -- a missing cache fails closed */
    if (grants === undefined) return false
    return grants.some(grant => samePrincipal(grant.caller, { kind: 'app', appId: binding.subscriber })
      && grant.capabilities.includes(eventCapability(binding.publisher, binding.type)))
  }

  /** End every subscription held by one application (called when it stops). */
  private removeEventBindings(appId: AppId): void {
    for (const binding of [...this.eventBindings]) {
      if (binding.subscriber === appId) this.eventBindings.delete(binding)
    }
  }

  // ---- change notices -----------------------------------------------------

  /**
   * Subscribe to change notices. Returns the unsubscribe function.
   * @param listener - the listener.
   * @returns the unsubscribe.
   */
  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  /** Subscribe to registration, status changes and removal, independently of business data. */
  onLifecycle(listener: ChangeListener): () => void {
    this.lifecycleListeners.add(listener)
    return () => { this.lifecycleListeners.delete(listener) }
  }

  /** Emit a change notice for one application. */
  private notify(appId: AppId, listeners = this.changeListeners): void {
    for (const listener of listeners) {
      try {
        listener({ appId })
      } catch (error) {
        this.onProblem(`change listener threw for ${appId}: ${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  // ---- calls --------------------------------------------------------------

  /**
   * Call one operation. The one path every entry point shares: identity comes
   * from the caller argument (the trusted entry injects it), then availability,
   * declaration, parameters, openness and grant/confirmation are checked in
   * order, and only a call that passed all of them reaches the implementation.
   *
   * Waiting for a confirmation re-checks the target afterwards: a revoke, a
   * stop or a declaration change during the wait must take effect.
   * @param caller - WHO is asking (never taken from business arguments).
   * @param target - the application to call.
   * @param op - the operation name.
   * @param args - the arguments, validated against the operation's declaration.
   * @param signal - the caller's cancellation request, when it has one.
   * @param requestedId - the caller's own id for this call, when it has one
   *   (the browser supplies a request id, and every record of the call — its
   *   progress notices, its history row, the control it is cancelled by — must
   *   carry that same id so the caller can recognise its own work).
   * @returns the outcome; rejection kinds never ran the operation.
   */
  async call(caller: Caller, target: AppId, op: OpName, args: JsonValue, signal?: AbortSignal, requestedId?: string, chain: readonly AppId[] = []): Promise<CallOutcome> {
    const callId = requestedId ?? this.idFactory()
    const startedAt = this.now().toISOString()
    // A peer chain is bounded and acyclic. The chain carries the applications
    // already on this path (the current target included), so the check happens
    // before any declaration or permission work and a loop can never recurse.
    if (chain.includes(target)) {
      return rejectedOutcome(callId, 'call-cycle', `application call cycle: ${[...chain, target].join(' -> ')}`)
    }
    if (chain.length >= MAX_CALL_DEPTH) {
      return rejectedOutcome(callId, 'call-depth', `application call depth exceeds ${String(MAX_CALL_DEPTH)}`)
    }
    // A request cancelled before it reached the registry was never work; do
    // not start it just because an application ignores its signal.
    if (signal?.aborted === true) return cancelledOutcome(callId)
    // Track the whole call, from acceptance: a stop that begins while the
    // checks are still running must still wait for this work (and cancel it),
    // rather than waving it through its own availability re-check.
    const record = this.apps.get(target)
    const work = this.dispatch(caller, target, op, args, signal, callId, chain)
    record?.inFlight.add(work)
    const outcome = await (async () => {
      try {
        return await work
      } catch (error) {
        // The permission/policy ports are host seams; a broken store must
        // become a stable failed Outcome, not a thrown internal error that
        // reaches a model or leaks a host path.
        /* v8 ignore next -- authorization throws are already surfaced as a stable failed outcome */
        this.onProblem(`call ${callId} could not be authorized: ${String((error as Error)?.message ?? error)}`)
        return failedOutcome(callId, 'authorization-unavailable', 'the call could not be authorized')
      } finally {
        record?.inFlight.delete(work)
      }
    })()
    this.record({
      callId,
      caller,
      target,
      op,
      startedAt,
      endedAt: this.now().toISOString(),
      status: outcome.status,
      ...(outcome.status === 'success' || outcome.status === 'cancelled' || outcome.error === undefined ? {} : { code: outcome.error.code, message: outcome.error.message }),
    })
    return outcome
  }

  private async dispatch(caller: Caller, target: AppId, op: OpName, args: JsonValue, signal: AbortSignal | undefined, callId: string, chain: readonly AppId[]): Promise<CallOutcome> {
    const reject = (code: RejectionCode, message: string): CallOutcome => rejectedOutcome(callId, code, message)
    const record = this.apps.get(target)
    if (record === undefined) return reject('unknown-app', `no application ${target}`)
    if (record.activation === 'disabled') return reject('unavailable', `application ${target} is disabled`)
    if (record.status === 'stopping' || record.status === 'stopped' || record.status === 'stop-incomplete') return reject('stopping', `application ${target} is ${record.status}`)
    /* v8 ignore next -- failed/stopped statuses are rejected by the previous line */
    if (record.status !== 'available') return reject('unavailable', `application ${target} is ${record.status}${record.detail === undefined ? '' : `: ${record.detail}`}`)
    if (record.maintenance !== undefined) return reject('unavailable', `application ${target} is being restored from an import; retry when it finishes`)
    const declaration = record.declaration.ops[op]
    if (declaration === undefined) return reject('unknown-op', `application ${target} has no operation ${op}`)
    const argErrors = validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(declaration.params), args, 'args')
    if (argErrors.length > 0) return reject('invalid-args', argErrors.join('; '))

    const decision = await this.checkPermission(caller, target, op, declaration.exposure, declaration.effect ?? 'write', signal, record, callId, args)
    if (decision.verdict !== 'allow') {
      if (decision.verdict === 'deny') return reject('denied', `the call ${target}#${op} was refused`)
      if (decision.verdict === 'unavailable') return reject('confirmation-unavailable', `the call ${target}#${op} needs confirmation and no channel could deliver it`)
      return reject('not-open-to-caller', `operation ${target}#${op} is not open to ${caller.kind}`)
    }
    // A confirmation can wait for an unbounded user decision. Re-check the
    // target and the user policy after the answer, with the current registry
    // entry; a stop, disable, declaration change or `forbid` set while the
    // question was open invalidates the call instead of executing stale work.
    if (decision.waited) {
      const recheck = await this.recheckAfterConfirmation(caller, target, op, declaration.effect ?? 'write', record)
      if (recheck.verdict !== 'allow') {
        /* v8 ignore next -- deny is covered by the policy-change test; branch attribution is split by the recheck */
        if (recheck.verdict === 'deny') return reject('denied', `the call ${target}#${op} was refused after its confirmation`)
        /* v8 ignore next -- target stopped/disabled during a confirmation; ask() normally aborts first */
        if (recheck.verdict === 'unavailable') return reject('unavailable', `application ${target} became unavailable while its confirmation was open`)
        /* v8 ignore next -- declaration changed during a confirmation; the recheck is a safety net */
        return reject('not-open-to-caller', `operation ${target}#${op} is no longer open to ${caller.kind}`)
      }
      return await this.execute(recheck.record, recheck.declaration.execute, caller, target, op, args, signal, callId, recheck.declaration.result, chain)
    }
    return await this.execute(record, declaration.execute, caller, target, op, args, signal, callId, record.declaration.ops[op]!.result, chain)
  }

  /** The permission table of one call: author class rule + one user policy. */
  private async checkPermission(
    caller: Caller,
    target: AppId,
    op: OpName,
    exposure: { readonly ai?: 'closed' | 'open' | 'confirm'; readonly peers?: 'closed' | 'open' | 'confirm' } | undefined,
    effect: 'read' | 'write',
    signal: AbortSignal | undefined,
    record: AppRecord,
    callId: string,
    args: JsonValue,
  ): Promise<{ verdict: PermissionOutcome; waited: boolean }> {
    if (caller.kind === 'human') {
      // The human's own interface is their way in: no per-operation grant.
      return { verdict: 'allow', waited: false }
    }
    const rule = caller.kind === 'ai' ? exposure?.ai ?? 'closed' : exposure?.peers ?? 'closed'
    if (caller.kind === 'app' || caller.kind === 'background') {
      const callerRecord = this.apps.get(caller.appId)
      // A background call is the application calling as itself; the same declaration governs it.
      /* v8 ignore next -- the caller declaration was checked before the question */
      const declared = callerRecord === undefined ? undefined : declaredCallOps(callerRecord.declaration, target)
      if (declared === undefined) return { verdict: 'closed', waited: false }
      if (declared !== 'all' && !declared.includes(op)) return { verdict: 'closed', waited: false }
    }
    // A policy never opens a class the author closed.
    if (rule === 'closed') return { verdict: 'closed', waited: false }
    const capability = opCapability(target, op)
    const policy = await this.policyOf(target, op)
    if (policy === 'forbid') return { verdict: 'deny', waited: false }
    // A background task has no interaction context: it can never answer a
    // confirmation, so a rule that would ask must fail closed instead of
    // parking in the browser table.
    const ask = async (reason: string): Promise<PermissionOutcome> => caller.kind === 'background'
      ? 'unavailable'
      : await this.askApproval(caller, capability, reason, signal, record, callId, args, effect)
    // A development Session bound to this application forces one confirmation
    // per write, regardless of the author/user default and earlier grants.
    if (caller.kind === 'ai' && caller.developmentApp === target && effect === 'write') {
      return {
        verdict: await ask(`development session asks to write ${target}#${op}`),
        waited: true,
      }
    }
    if (policy === 'allow') return { verdict: 'allow', waited: false }
    if (policy === 'confirm') {
      return {
        verdict: await ask(`application ${callerKindLabel(caller)} asks to call ${target}#${op}`),
        waited: true,
      }
    }
    // `default`: follow the author's class rule. Approval is never remembered
    // outside the user's operation policy.
    if (rule === 'open') return { verdict: 'allow', waited: false }
    return {
      verdict: await ask(`application ${callerKindLabel(caller)} asks to call ${target}#${op}`),
      waited: true,
    }
  }

  /**
   * Re-check a call whose confirmation just returned `allowed-once`. The
   * confirmation is valid for this call only; the target's state, declaration,
   * caller scope and user policy may all have changed while it was open. The
   * recheck never asks again: a policy that turned to `confirm` still has the
   * answer for this call, while `forbid` always wins.
   * @returns the verdict and the CURRENT registration/declaration to execute.
   */
  private async recheckAfterConfirmation(
    caller: Caller,
    target: AppId,
    op: OpName,
    effect: OperationEffect,
    original: AppRecord,
  ): Promise<{ verdict: PermissionOutcome; record: AppRecord; declaration: OperationDeclaration }> {
    const record = this.apps.get(target)
    /* v8 ignore next -- a target removed/replaced while its confirmation is open */
    if (record === undefined || record !== original) {
      return { verdict: 'closed', record: original, declaration: original.declaration.ops[op]! }
    }
    /* v8 ignore next -- activation and stop changes abort the question before this point in practice */
    if (record.activation === 'disabled') return { verdict: 'unavailable', record, declaration: record.declaration.ops[op]! }
    /* v8 ignore next -- see above */
    if (record.status !== 'available') return { verdict: 'unavailable', record, declaration: record.declaration.ops[op]! }
    /* v8 ignore next -- see above */
    if (record.maintenance !== undefined) return { verdict: 'unavailable', record, declaration: record.declaration.ops[op]! }
    const declaration = record.declaration.ops[op]
    /* v8 ignore next -- the declaration was validated before the question was asked */
    if (declaration === undefined) return { verdict: 'closed', record, declaration: original.declaration.ops[op]! }
    /* v8 ignore next 4 -- the exposure was checked before the question */
    const rule = caller.kind === 'ai'
      ? declaration.exposure?.ai ?? 'closed'
      : caller.kind === 'app' || caller.kind === 'background'
        ? declaration.exposure?.peers ?? 'closed'
        : 'open'
    if (caller.kind === 'app' || caller.kind === 'background') {
      const callerRecord = this.apps.get(caller.appId)
      /* v8 ignore next -- the caller declaration was checked before the question */
      const declared = callerRecord === undefined ? undefined : declaredCallOps(callerRecord.declaration, target)
      /* v8 ignore next -- the caller declaration was checked before the question */
      if (declared === undefined) return { verdict: 'closed', record, declaration }
      /* v8 ignore next -- see above */
      if (declared !== 'all' && !declared.includes(op)) return { verdict: 'closed', record, declaration }
    }
    /* v8 ignore next -- the exposure was checked before the question */
    if (rule === 'closed') return { verdict: 'closed', record, declaration }
    if (await this.policyOf(target, op) === 'forbid') return { verdict: 'deny', record, declaration }
    // The answered confirmation is this call's grant. A development Session's
    // write confirmation is likewise already answered; only `forbid` overrides.
    if (caller.kind === 'ai' && caller.developmentApp === target && effect === 'write') {
      return { verdict: 'allow', record, declaration }
    }
    return { verdict: 'allow', record, declaration }
  }

  /**
   * Ask the confirmation channel about one OPERATION, with cancellation
   * honoured as "no answer". The answer covers this call only. A platform
   * capability is not asked about here: the user approves those in the
   * applications panel, and {@link checkCapability} reads that standing
   * approval.
   */
  private async askApproval(caller: Caller, capability: string, reason: string, signal: AbortSignal | undefined, record: AppRecord | undefined, label: string, args: JsonValue, effect: OperationEffect): Promise<PermissionOutcome> {
    if (this.confirm === undefined) return 'unavailable'
    const controller = new AbortController()
    const preview = confirmationPreview(args, effect)
    const timeout = setTimeout(() => controller.abort(), this.confirmationTimeoutMs)
    record?.pendingConfirmations.add(controller)
    const abort = (): void => { controller.abort() }
    // A request that arrives after the caller already cancelled is cancelled
    // too: adding a listener to an aborted signal would never fire.
    /* v8 ignore next -- the call entry already returns cancelled for an aborted signal */
    if (signal?.aborted === true) abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const aborted = new Promise<ConfirmationAnswer>((resolve) => {
        controller.signal.addEventListener('abort', () => { resolve('unavailable') }, { once: true })
      })
      const answer = await Promise.race([
        this.confirm.ask({ caller, capability, reason, signal: controller.signal, preview }),
        aborted,
      ])
      // A request that was cancelled has no valid answer: a late "allow" from
      // the channel must not revive a decision the user already ended.
      if (controller.signal.aborted) return 'unavailable'
      if (answer === 'allowed-once') return 'allow'
      if (answer === 'denied') return 'deny'
      return 'unavailable'
    } catch (error) {
      this.onProblem(`confirmation for ${label} failed: ${String((error as Error)?.message ?? error)}`)
      return 'unavailable'
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      record?.pendingConfirmations.delete(controller)
    }
  }

  /** Whether a stored grant covers one capability for this caller. A grant-store failure is an error, never an implicit allow. */
  private async isGranted(caller: Caller, capability: string): Promise<boolean> {
    const grants = await this.readGrants()
    return grants.some((grant) => grant.capabilities.includes(capability) && samePrincipal(grant.caller, caller))
  }

  /**
   * Whether one application may use one platform capability right now. The
   * capability entries (model, network, process, storage) call this through the
   * application's own door before doing the work their declaration promises.
   *
   * The answer is three-way: an application that never declared the capability
   * gets `undeclared` (a declaration bug, not a permission question), one whose
   * user has not approved it gets `not-approved` (the panel is where they do),
   * and an approved one gets `allow`.
   * @param caller - the caller asking, injected by the capability entry.
   * @param name - the capability name (`model`, `http`, ...).
   * @returns the verdict.
   */
  async checkCapability(caller: Caller, name: string): Promise<CapabilityVerdict> {
    const record = this.capabilityDeclaration(caller, name)
    if (record === undefined) return 'undeclared'
    return await this.isGranted(caller, platformCapability(name)) ? 'allow' : 'not-approved'
  }

  /**
   * The registration of the application a caller acts as, when its declaration
   * covers this capability — the one lookup both the verdict and the use share.
   */
  private capabilityDeclaration(caller: Caller, name: string): AppRecord | undefined {
    const appId = applicationIdOf(caller)
    if (appId === undefined) return undefined
    const record = this.apps.get(appId)
    if (record === undefined || !(record.declaration.capabilities ?? []).includes(name)) return undefined
    return record
  }

  /**
   * The capability door bound to ONE application (its operation or lifecycle
   * context). The identity is captured here, from the runtime's own record —
   * nothing a caller passes can change whose declaration and grants are read.
   */
  private capabilityAccess(appId: AppId, caller: Caller): CapabilityAccess {
    return {
      appId,
      use: async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
        const verdict = await this.checkCapability(caller, name)
        if (verdict !== 'allow') throw capabilityRefusal(name, verdict)
        return await work()
      },
    }
  }

  /**
   * The process entry bound to ONE application. Every use checks the declared
   * `process` capability and the user's grant, runs the work (the platform
   * subprocess service still owns the child), and appends one history record
   * with the command label. The declaration is disclosure, never a whitelist.
   */
  private processAccess(appId: AppId, caller: Caller): ProcessAccess {
    const door = this.capabilityAccess(appId, callerOfApp(appId))
    return {
      run: async <T>(descriptor: ProcessDescriptor, work: () => T | Promise<T>): Promise<T> => {
        const command = typeof descriptor.command === 'string' ? descriptor.command.trim() : ''
        if (command === '' || command.length > 200) throw new AppError('invalid-args', 'a process command must be a non-empty 1..200 character string')
        const callId = this.idFactory()
        const startedAt = this.now().toISOString()
        try {
          const value = await door.use('process', work)
          this.record({ callId, caller, target: appId, op: 'process', command, startedAt, endedAt: this.now().toISOString(), status: 'success' })
          return value
        } catch (error) {
          const raw = error instanceof AppError ? error.code : 'threw'
          const code = raw.startsWith('platform.') || raw.startsWith('app.') ? raw : `app.${raw}`
          this.record({
            callId,
            caller,
            target: appId,
            op: 'process',
            command,
            startedAt,
            endedAt: this.now().toISOString(),
            status: raw.startsWith('capability-') ? 'rejected' : 'failed',
            code,
            ...(error instanceof Error ? { message: error.message.slice(0, 500) } : {}),
          })
          throw error
        }
      },
    }
  }

  /**
   * The durable table for the CURRENT queue slot: the cache a previous slot
   * published, or the store when there is none. Only a queue step (a serialized
   * read or a change) calls this, which is what makes the two agree — whatever
   * one step observed is what the next step computes from.
   *
   * A store the host installs while the list was in flight is not this read's
   * to answer: the value fetched belongs to the store that was installed then,
   * and publishing it would hand the NEW store a table it never held.
   */
  private async loadGrants(): Promise<CapabilityGrant[]> {
    for (;;) {
      const cache = this.grantsCache
      if (cache !== undefined) return cache
      const store = this.grants
      const listed = store === undefined ? [] : [...await store.list()]
      if (this.grants === store) {
        this.grantsCache = listed
        return listed
      }
    }
  }

  /**
   * Read the table as ONE queue step, like a change. A read that does not join
   * the queue races it: it can finish after a change already landed and write
   * the value it fetched back over the change's result — the first authorization
   * read of a process holding a revoked table long enough for a revoke to be
   * saved and then restoring it in the cache. Joining the queue means the read
   * also answers what the LAST step left, never a half-finished change.
   */
  private readGrants(): Promise<CapabilityGrant[]> {
    const step = this.grantChain.then(async () => await this.loadGrants())
    this.grantChain = step.then(() => undefined, () => undefined)
    return step
  }

  /**
   * Record one grant. The save must succeed before the caller reports success;
   * the returned promise rejects when it does not — and a failed save leaves
   * the effective table exactly as the store last held it (the cache is
   * dropped, so the next read asks the store again instead of trusting a value
   * that was never persisted).
   * @param grant - the grant to persist.
   */
  async grant(grant: CapabilityGrant): Promise<void> {
    this.assertGrantable(grant)
    await this.changeGrants(async (grants) => [...grants, grant])
  }

  /**
   * Validate one grant against the CURRENT registry without recording it. The
   * external write paths (the host bridge's panel action and the runtime's own
   * confirmation answer) call this before {@link grant}; a direct host-side
   * `grant` is a lower-level write and must apply the same check itself.
   * @param grant - the grant about to be recorded.
   */
  validateGrant(grant: CapabilityGrant): void {
    this.assertGrantable(grant)
  }

  /**
   * Refuse a grant that names something the current registry cannot honour:
   * an unknown application or operation, an operation not open to the caller's
   * class, or a platform capability the application does not declare. An
   * anonymous AI caller has no durable principal. A platform-capability grant
   * for an application that is not registered yet is accepted and stays inert
   * until the application exists and declares it (the capability use checks the
   * declaration then); this is the startup/onboarding order.
   * @param grant - the grant about to be recorded.
   */
  private assertGrantable(grant: CapabilityGrant): void {
    const { caller } = grant
    if (grant.capabilities.length === 0) throw new AppError('grant-empty', 'a grant must name at least one capability')
    if (caller.kind === 'ai' && caller.sessionId === undefined) {
      throw new AppError('grant-unscoped', 'an anonymous AI call cannot hold a durable approval; allow it once instead')
    }
    for (const capability of grant.capabilities) {
      if (capability.startsWith('capability:')) {
        const name = capability.slice('capability:'.length)
        if (name === '') throw new AppError('grant-unknown', 'the grant names an empty platform capability')
        if (caller.kind !== 'app' && caller.kind !== 'background') {
          throw new AppError('grant-not-open', `${caller.kind} callers do not use the platform capability ${name}`)
        }
        const record = this.apps.get(caller.appId)
        if (record !== undefined && !(record.declaration.capabilities ?? []).includes(name)) {
          throw new AppError('grant-undeclared', `application ${caller.appId} does not declare the ${name} capability`)
        }
        continue
      }
      if (capability.startsWith('event:')) {
        const rest = capability.slice('event:'.length)
        const separator = rest.indexOf('#')
        if (separator <= 0 || separator === rest.length - 1) {
          throw new AppError('grant-unknown', `the grant event capability ${JSON.stringify(capability)} is not event:<application>#<type>`)
        }
        if (caller.kind !== 'app' && caller.kind !== 'background') {
          throw new AppError('grant-not-open', `${caller.kind} callers do not hold event subscriptions`)
        }
        const target = rest.slice(0, separator)
        const type = rest.slice(separator + 1)
        const record = this.apps.get(target)
        if (record === undefined) throw new AppError('grant-unknown-app', `the grant names the unregistered application ${target}`)
        const event = record.declaration.events?.[type]
        if (event === undefined) throw new AppError('grant-unknown-event', `application ${target} has no event ${type}`)
        if ((event.subscription ?? 'closed') !== 'open') {
          throw new AppError('grant-not-open', `event ${target}#${type} is not open to subscriptions, so a grant would never take effect`)
        }
        const subscriber = this.apps.get(caller.appId)
        if (subscriber !== undefined && !(subscriber.declaration.subscriptions ?? []).some(entry => entry.appId === target && entry.type === type)) {
          throw new AppError('grant-undeclared', `application ${caller.appId} does not declare the subscription ${target}#${type}`)
        }
        continue
      }
      throw new AppError('grant-unknown', `the grant capability ${JSON.stringify(capability)} is not capability:<name> or event:<application>#<type>; operation grants were removed in favor of per-operation policy`)
    }
  }

  /**
   * Revoke capabilities from a caller. The selector is either one exact
   * capability (`capability:<name>` or `event:<app>#<type>`), an application id
   * (that application's event subscriptions), or omitted (everything this
   * caller was granted). Revoked capabilities are removed from the stored grant, so the
   * next call re-asks rather than reusing a stale approval.
   * @param caller - the caller whose grants are revoked.
   * @param selector - an exact capability, an application id, or nothing for all.
   */
  async revoke(caller: Caller, selector?: string): Promise<void> {
    const matches = (capability: string): boolean => {
      if (selector === undefined) return true
      if (selector.includes('#') || selector.includes(':')) return capability === selector
      return capability.startsWith(`event:${selector}#`)
    }
    await this.changeGrants((grants) => grants
      .map((grant) => (samePrincipal(grant.caller, caller)
        ? { ...grant, capabilities: grant.capabilities.filter((entry) => !matches(entry)) }
        : grant))
      .filter((grant) => grant.capabilities.length > 0))
  }

  /**
   * One change to the durable grant table as ONE serial step: the read, the
   * computation, the save and the cache update together. Two overlapping
   * changes must never each compute from the same stale snapshot — the later
   * save would then resurrect a capability the earlier one had revoked (or drop
   * one it had approved). A step that fails leaves the table as the store last
   * held it and rejects to its caller; the next step still runs.
   *
   * Reads are steps of the same queue ({@link readGrants}): a read and a change
   * can never interleave their reads of the store and their cache updates, so
   * the answer a caller acts on is always one the queue really reached.
   */
  private changeGrants(compute: (grants: readonly CapabilityGrant[]) => readonly CapabilityGrant[] | Promise<readonly CapabilityGrant[]>): Promise<void> {
    const step = this.grantChain.then(async () => {
      // One step speaks to ONE store: a store the host installs mid-step owns
      // the steps after it, so this computation is neither saved to it nor
      // published for it.
      const store = this.grants
      const next = [...await compute(await this.loadGrants())]
      try {
        if (store !== undefined) await store.save(next)
      } catch (error) {
        // The durable state is unknown now (the store may have written part of
        // it or nothing): forget what we cached and let the next read ask the
        // store again — never report an unsaved change as effective.
        this.grantsCache = undefined
        throw error
      }
      if (this.grants === store) this.grantsCache = next
    })
    // The chain must survive a failed step, or one rejected save would wedge
    // every later approval.
    this.grantChain = step.then(() => undefined, () => undefined)
    return step
  }

  /** The grants currently in effect (a copy). */
  async grantsOf(): Promise<readonly CapabilityGrant[]> {
    return [...await this.readGrants()]
  }

  /** The user's operation policies currently in effect (a copy). */
  async policiesOf(): Promise<readonly OperationPolicyEntry[]> {
    return [...await this.readPolicies()]
  }

  /**
   * The effective user policy for one operation. A missing entry is `default`,
   * which follows the author's per-class rule; a policy never opens a class the
   * author closed.
   * @param appId - the target application.
   * @param op - the operation.
   * @returns the stored override or `default`.
   */
  async policyOf(appId: AppId, op: OpName): Promise<OperationPolicy> {
    const entry = (await this.readPolicies()).find(item => item.appId === appId && item.operation === op)
    return entry?.policy ?? 'default'
  }

  /**
   * Set (or clear, with `default`) one user operation policy. The save must
   * succeed before success is reported; a failed save leaves the previous table
   * in effect. A fully closed operation cannot be opened by a user policy.
   * @param appId - the target application.
   * @param op - the operation.
   * @param policy - the override.
   */
  async setPolicy(appId: AppId, op: OpName, policy: OperationPolicy): Promise<void> {
    const record = this.apps.get(appId)
    if (record === undefined) throw new AppError('unknown-app', `no application ${appId}`)
    const declaration = record.declaration.ops[op]
    if (declaration === undefined) throw new AppError('unknown-operation', `application ${appId} has no operation ${op}`)
    if (policy !== 'default' && (declaration.exposure?.ai ?? 'closed') === 'closed' && (declaration.exposure?.peers ?? 'closed') === 'closed') {
      throw new AppError('operation-closed', `operation ${appId}#${op} is not open to any external caller`)
    }
    const now = this.now().toISOString()
    await this.changePolicies((entries) => {
      const rest = entries.filter(entry => !(entry.appId === appId && entry.operation === op))
      return policy === 'default' ? rest : [...rest, { appId, operation: op, policy, updatedAt: now }]
    })
  }

  /** One serial step over the durable policy table. */
  private changePolicies(compute: (entries: readonly OperationPolicyEntry[]) => readonly OperationPolicyEntry[]): Promise<void> {
    const step = this.policyChain.then(async () => {
      const store = this.policies
      const next = [...compute(await this.loadPolicies())]
      try {
        if (store !== undefined) await store.save(next)
      } catch (error) {
        this.policiesCache = undefined
        throw error
      }
      if (this.policies === store) this.policiesCache = next
    })
    this.policyChain = step.then(() => undefined, () => undefined)
    return step
  }

  /** The policy table for one queue step: cache, or the installed store. */
  private async loadPolicies(): Promise<OperationPolicyEntry[]> {
    for (;;) {
      const cache = this.policiesCache
      if (cache !== undefined) return cache
      const store = this.policies
      const listed = store === undefined ? [] : [...await store.list()]
      if (this.policies === store) {
        this.policiesCache = listed
        return listed
      }
    }
  }

  /** Read the policy table through the same serial queue as a change. */
  private readPolicies(): Promise<OperationPolicyEntry[]> {
    const step = this.policyChain.then(async () => await this.loadPolicies())
    this.policyChain = step.then(() => undefined, () => undefined)
    return step
  }

  /**
   * The most recent calls this runtime recorded, newest first. It reads the
   * installed history sink's own window ({@link HistoryReader}); a sink that
   * only writes, or no sink at all, answers empty — a read of history is never
   * a reason to invent a record, and it never changes a call's outcome.
   * @param limit - how many records at most (absent = the default of {@link DEFAULT_RECENT_HISTORY}, the sink window bounds it too).
   * @param target - an application whose calls to answer; the filter is applied to the window BEFORE the limit, so a caller asking for one application is not answered out of a window other applications filled.
   * @returns the recorded calls, newest first.
   */
  recentHistory(limit: number = DEFAULT_RECENT_HISTORY, target?: string): readonly HistoryRecord[] {
    const sink = this.history
    if (sink === undefined) return []
    const reader = sink as HistorySink & Partial<HistoryReader>
    if (typeof reader.recent !== 'function') return []
    return reader.recent(limit, target)
  }

  // ---- execution ----------------------------------------------------------

  private async execute(
    record: AppRecord,
    execute: (args: JsonValue, ctx: OperationContext) => JsonValue | Promise<JsonValue>,
    caller: Caller,
    target: AppId,
    op: OpName,
    args: JsonValue,
    signal: AbortSignal | undefined,
    callId: string,
    resultSchema: ValueSchemaSpec,
    chain: readonly AppId[],
  ): Promise<CallOutcome> {
    const controller = new AbortController()
    const abort = (): void => { controller.abort(record.abort.signal.reason ?? signal?.reason) }
    if (signal?.aborted === true || record.abort.signal.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
    // A stop cancels the application's in-flight work: the operation sees the
    // same cancellation request as an explicit caller cancel.
    record.abort.signal.addEventListener('abort', abort, { once: true })
    const originSession = caller.kind === 'ai' || caller.kind === 'app' ? caller.sessionId : undefined
    const ctx: OperationContext = {
      appId: target,
      op,
      callId,
      caller,
      signal: controller.signal,
      capabilities: this.capabilityAccess(target, callerOfApp(target)),
      process: this.processAccess(target, caller),
      reportProgress: (message, data) => { this.progress(target, op, callId, message, data) },
      call: async (next, nextOp, nextArgs) => await this.call(callerOfApp(target, originSession), next, nextOp, nextArgs, controller.signal, undefined, [...chain, target]),
      notifyChanged: () => { this.notify(target) },
      publishEvent: (type, refs) => this.publishEvent(target, type, refs),
      startTask: (descriptor, work) => this.startTask(record, { kind: 'operation', callId, caller }, descriptor, work, [...chain, target]),
      delegations: this.delegationAccess(target, callerOfApp(target)),
    }
    const work = (async (): Promise<CallOutcome> => {
      try {
        const value = await execute(args, ctx)
        const errors = validateJsonSchemaValue(valueSchemaSpecToJsonSchema(resultSchema), value, 'result')
        if (errors.length > 0) return failedOutcome(callId, 'invalid-result', errors.join('; '))
        return { callId, status: 'success', result: value }
      } catch (error) {
        if (isAbort(error)) return cancelledOutcome(callId)
        return failedOutcome(callId, error instanceof AppError ? error.code : 'threw', String((error as Error)?.message ?? error), error instanceof AppError ? error.details : undefined)
      }
    })()
    try {
      return await work
    } finally {
      signal?.removeEventListener('abort', abort)
      record.abort.signal.removeEventListener('abort', abort)
    }
  }

  /** Progress is a transient notification: delivery failures are reported, never raised. */
  private progress(target: AppId, op: OpName, callId: string, message: string, data?: JsonValue): void {
    try {
      for (const listener of this.progressListeners) listener({ appId: target, op, callId, message, data })
    } catch (error) {
      this.onProblem(`progress listener threw for ${callId}: ${String((error as Error)?.message ?? error)}`)
    }
  }

  private readonly progressListeners = new Set<(event: ProgressNotice) => void>()

  /** Subscribe to progress notifications (the host wires them to the callers' transport). */
  onProgress(listener: (event: ProgressNotice) => void): () => void {
    this.progressListeners.add(listener)
    return () => { this.progressListeners.delete(listener) }
  }

  // ---- background tasks ---------------------------------------------------

  /**
   * Every task this runtime knows, optionally for one application. The
   * snapshots are control-plane projections; the application's own durable
   * record remains the business source of truth.
   * @param appId - optional application filter.
   * @returns task snapshots in insertion order.
   */
  tasks(appId?: AppId): readonly TaskSnapshot[] {
    if (appId !== undefined) {
      const record = this.apps.get(appId)
      return record === undefined ? [] : [...record.tasks.values()].map(entry => taskSnapshot(entry))
    }
    return [...this.apps.values()].flatMap(record => [...record.tasks.values()].map(entry => taskSnapshot(entry)))
  }

  /** Read one task snapshot, or undefined when the application/task is unknown. */
  task(appId: AppId, taskId: TaskId): TaskSnapshot | undefined {
    const entry = this.apps.get(appId)?.tasks.get(taskId)
    return entry === undefined ? undefined : taskSnapshot(entry)
  }

  /**
   * Ask one task to cancel. The task's signal aborts and its state becomes
   * `cancelling`; the work decides when it really stops. A settled task is not
   * reopened, and a missing id is reported as such.
   * @param appId - the task's owner.
   * @param taskId - the task to cancel.
   * @returns whether a cancel request was accepted, the task was already settled, or it is unknown.
   */
  cancelTask(appId: AppId, taskId: TaskId): TaskCancelResult {
    const entry = this.apps.get(appId)?.tasks.get(taskId)
    if (entry === undefined) return 'not-found'
    if (entry.state !== 'running' && entry.state !== 'cancelling') return 'settled'
    if (entry.state === 'cancelling') return 'accepted'
    this.requestTaskCancel(entry)
    return 'accepted'
  }

  /** Subscribe to task starts, progress, cancel requests and settlements. */
  onTask(listener: (notice: TaskNotice) => void): () => void {
    this.taskListeners.add(listener)
    return () => { this.taskListeners.delete(listener) }
  }

  /**
   * Start one application-owned task. Internal to the contexts: an operation
   * records its call/caller as display origin, while lifecycle/background work
   * is marked `background`. The task's calls run as the application in its
   * background role, never with the original caller's authority.
   * @param record - the owning application.
   * @param origin - display provenance.
   * @param descriptor - kind/title/externalId/idempotency key.
   * @param work - the work; its return value is a bounded summary.
   * @returns the task handle.
   */
  private startTask(record: AppRecord, origin: TaskOrigin, descriptor: TaskDescriptor, work: TaskWork, chain: readonly AppId[] = [record.declaration.id]): TaskHandle {
    assertTaskDescriptor(descriptor)
    if (record.activation === 'disabled' || (record.status !== 'starting' && record.status !== 'available')) {
      throw new AppError('unavailable', `application ${record.declaration.id} is ${record.status}; a task cannot start`)
    }
    if (record.maintenance !== undefined) {
      throw new AppError('unavailable', `application ${record.declaration.id} is paused for an import; a task cannot start`)
    }
    const existing = descriptor.requestId === undefined
      ? undefined
      : [...record.tasks.values()].find(entry => entry.requestId === descriptor.requestId)
    if (existing !== undefined) {
      if (existing.kind !== descriptor.kind || existing.externalId !== descriptor.externalId || existing.title !== descriptor.title) {
        throw new AppError('task-request-conflict', `request ${String(descriptor.requestId)} already names a different task`)
      }
      // Every task in the map got its done promise before the start event was
      // emitted, so a replayed request always has a handle to return.
      return { taskId: existing.taskId, done: existing.done! }
    }
    const running = [...record.tasks.values()].filter(entry => entry.state === 'running' || entry.state === 'cancelling').length
    if (running >= MAX_RUNNING_TASKS_PER_APP) {
      throw new AppError('task-limit', `application ${record.declaration.id} already runs ${String(MAX_RUNNING_TASKS_PER_APP)} task(s)`)
    }
    this.pruneTaskRecords(record)
    const now = this.now().toISOString()
    const taskId = this.taskIdFactory()
    const entry: TaskEntry = {
      taskId,
      traceId: taskId,
      appId: record.declaration.id,
      kind: descriptor.kind,
      title: descriptor.title,
      ...(descriptor.externalId === undefined ? {} : { externalId: descriptor.externalId }),
      ...(descriptor.requestId === undefined ? {} : { requestId: descriptor.requestId }),
      origin,
      chain,
      state: 'running',
      startedAt: now,
      updatedAt: now,
      controller: new AbortController(),
    }
    record.tasks.set(entry.taskId, entry)
    const onAppAbort = (): void => { this.requestTaskCancel(entry) }
    record.abort.signal.addEventListener('abort', onAppAbort, { once: true })
    // The work starts in a microtask so the start notice wins the ordering;
    // the done promise exists before a listener could replay the request id.
    const done = Promise.resolve()
      .then(async () => await work(this.taskContext(record, entry)))
      .then(
        (value) => { this.settleTask(entry, { ok: true, value }) },
        (error: unknown) => { this.settleTask(entry, { ok: false, error }) },
      )
      .then(() => {
        record.abort.signal.removeEventListener('abort', onAppAbort)
        record.background.delete(done)
      })
    entry.done = done
    record.background.add(done)
    this.emitTask(entry)
    return { taskId: entry.taskId, done }
  }

  private taskContext(record: AppRecord, entry: TaskEntry): TaskContext {
    const appId = record.declaration.id
    return {
      appId,
      taskId: entry.taskId,
      signal: entry.controller.signal,
      capabilities: this.capabilityAccess(appId, { kind: 'background', appId }),
      process: this.processAccess(appId, { kind: 'background', appId }),
      reportProgress: (message, data) => { this.taskProgress(entry, message, data) },
      call: async (target, op, args) => await this.call({ kind: 'background', appId }, target, op, args, entry.controller.signal, undefined, entry.chain),
      notifyChanged: () => { this.notify(appId) },
      publishEvent: (type, refs) => this.publishEvent(appId, type, refs),
    }
  }

  private taskProgress(entry: TaskEntry, message: string, data?: JsonValue): void {
    if (entry.state !== 'running' && entry.state !== 'cancelling') return
    const bounded = boundedJson(data, 'progress', entry, this.onProblem)
    entry.progress = {
      message: String(message).slice(0, 500),
      ...(bounded === undefined ? {} : { data: bounded }),
      updatedAt: this.now().toISOString(),
    }
    entry.updatedAt = entry.progress.updatedAt
    this.emitTask(entry)
  }

  private requestTaskCancel(entry: TaskEntry): void {
    if (entry.state !== 'running') return
    entry.state = 'cancelling'
    entry.updatedAt = this.now().toISOString()
    entry.controller.abort(new DOMException(`task ${entry.taskId} cancelled`, 'AbortError'))
    this.emitTask(entry)
  }

  private settleTask(entry: TaskEntry, result: { ok: true; value: JsonValue | void } | { ok: false; error: unknown }): void {
    const now = this.now().toISOString()
    entry.endedAt = now
    entry.updatedAt = now
    if (result.ok) {
      entry.state = 'succeeded'
      const summary = boundedJson(result.value, 'result', entry, this.onProblem)
      if (summary !== undefined) entry.resultSummary = summary
    } else if (isAbort(result.error)) {
      entry.state = 'cancelled'
    } else {
      entry.state = 'failed'
      entry.error = {
        code: (result.error instanceof AppError ? result.error.code : 'threw').slice(0, 200),
        message: String((result.error as Error)?.message ?? result.error).slice(0, 2_048),
      }
    }
    this.emitTask(entry)
  }

  private emitTask(entry: TaskEntry): void {
    const notice: TaskNotice = { appId: entry.appId, task: taskSnapshot(entry) }
    for (const listener of this.taskListeners) {
      try {
        listener(notice)
      } catch (error: unknown) {
        this.onProblem(`task listener threw for ${entry.taskId}: ${String((error as Error)?.message ?? error)}`)
      }
    }
  }

  private pruneTaskRecords(record: AppRecord): void {
    if (record.tasks.size < MAX_TASK_RECORDS_PER_APP) return
    const terminal = [...record.tasks.values()]
      .filter(entry => entry.state !== 'running' && entry.state !== 'cancelling')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    for (const entry of terminal) {
      if (record.tasks.size < MAX_TASK_RECORDS_PER_APP) break
      record.tasks.delete(entry.taskId)
    }
  }

  private appContext(record: AppRecord): AppContext {
    return {
      appId: record.declaration.id,
      signal: record.abort.signal,
      capabilities: this.capabilityAccess(
        record.declaration.id,
        // Lifecycle and background work act as the application in the
        // background role; the two identities share one grant (samePrincipal).
        { kind: 'background', appId: record.declaration.id },
      ),
      process: this.processAccess(record.declaration.id, { kind: 'background', appId: record.declaration.id }),
      call: async (target, op, args) => await this.call({ kind: 'background', appId: record.declaration.id }, target, op, args, record.abort.signal, undefined, [record.declaration.id]),
      notifyChanged: () => { this.notify(record.declaration.id) },
      publishEvent: (type, refs) => this.publishEvent(record.declaration.id, type, refs),
      subscribe: async (publisher, type, listener) => await this.subscribe(record.declaration.id, publisher, type, listener),
      startTask: (descriptor, work) => this.startTask(record, { kind: 'background' }, descriptor, work),
      delegations: this.delegationAccess(record.declaration.id, { kind: 'background', appId: record.declaration.id }),
    }
  }

  /**
   * The delegation door bound to ONE application. The identity is captured
   * here, from the runtime's own record; every use checks the application's
   * declared `delegate` capability and the user's standing approval, exactly
   * like the other platform capability entries.
   */
  private delegationAccess(appId: AppId, caller: Caller): AppDelegationAccess {
    const door = this.capabilityAccess(appId, caller)
    const port = async (): Promise<DelegationPort> => {
      const current = this.delegations
      if (current === undefined) throw new AppError('delegation-unavailable', 'this host has no delegation store')
      return current
    }
    return {
      create: async input => await door.use('delegate', async () => await (await port()).create(appId, input)),
      list: async () => await door.use('delegate', async () => await (await port()).list(appId)),
      read: async id => await door.use('delegate', async () => await (await port()).read(appId, id)),
      cancel: async id => await door.use('delegate', async () => await (await port()).cancel(appId, id)),
    }
  }

  private record(entry: HistoryRecord): void {
    if (this.history === undefined) return
    try {
      const result = this.history.write(entry)
      if (result instanceof Promise) result.catch((error: unknown) => { this.onProblem(`history write failed for ${entry.callId}: ${String((error as Error)?.message ?? error)}`) })
    } catch (error) {
      this.onProblem(`history write failed for ${entry.callId}: ${String((error as Error)?.message ?? error)}`)
    }
  }
}

/** The caller an application's own outgoing call carries. */
function callerOfApp(appId: AppId, sessionId?: string): Caller {
  return { kind: 'app', appId, ...(sessionId === undefined ? {} : { sessionId }) }
}

/** The application a caller acts as, for the two identities that have one. */
function applicationIdOf(caller: Caller): AppId | undefined {
  return caller.kind === 'app' || caller.kind === 'background' ? caller.appId : undefined
}

/**
 * Whether two callers are the same principal. An application acting in its own
 * name and that same application's background work are one principal: the
 * architecture gives background work the application's own declaration and
 * permissions, so a capability/event grant made to the application covers its
 * background work (and vice versa) — never more, and never a way around the
 * limits. AI capability grants are per session, and an anonymous AI call has no
 * durable principal at all.
 */
function samePrincipal(left: Caller, right: Caller): boolean {
  // Only application/background identities can hold durable grants: platform
  // capabilities and events reject every other caller kind.
  const leftApp = applicationIdOf(left)
  return leftApp !== undefined && leftApp === applicationIdOf(right)
}

/** The failure a capability entry reports when the use of the capability was refused. */
function capabilityRefusal(name: string, verdict: CapabilityVerdict): AppError {
  switch (verdict) {
    case 'not-approved':
      return new AppError('capability-not-approved', `the user has not approved the ${name} capability for this application (the applications panel approves it)`)
    default:
      return new AppError('capability-undeclared', `this application never declared the ${name} capability (capabilities: [...])`)
  }
}

/** The outcome of waiting for work under a deadline. */
interface WaitOutcome {
  /** Whether every item ended before the deadline. */
  readonly ended: boolean
}

/**
 * Wait for every item to settle, or give up when `deadline` (an epoch-
 * millisecond instant) passes. The wait itself never rejects: a rejection is a
 * completed item, and the callers keep the values they are waiting for.
 * @param items - the promises to wait for.
 * @param deadline - the instant the wait must not pass.
 * @returns whether every item ended in time.
 */
async function waitWithin(items: readonly Promise<unknown>[], deadline: number): Promise<WaitOutcome> {
  const settled = Promise.allSettled(items).then(() => true)
  // An unbounded wait (the late paths) is not a timer: `setTimeout` would read
  // `Infinity` as an overflow and fire immediately.
  if (!Number.isFinite(deadline)) { await settled; return { ended: true } }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, Math.max(0, deadline - Date.now()))
  })
  const ended = await Promise.race([settled, expired])
  clearTimeout(timer)
  return { ended }
}

/** Labels for the caller classes that have no application identity of their own. */
const ANONYMOUS_CALLER_LABELS: Record<'human' | 'ai', string> = {
  human: 'the user',
  ai: 'the assistant',
}

/** How long a human has to answer one confirmation before the call is refused. */
export const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000

const PREVIEW_MAX_BYTES = 2048
const PREVIEW_MAX_DEPTH = 3
const PREVIEW_MAX_KEYS = 20
const PREVIEW_MAX_ARRAY = 20
const PREVIEW_MAX_STRING = 256
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|api[-_]?key/iu

/** Bound and redact one argument tree for a human confirmation. */
function previewValue(value: JsonValue, depth: number): JsonValue {
  if (depth > PREVIEW_MAX_DEPTH) return '[depth]'
  if (typeof value === 'string') return value.length > PREVIEW_MAX_STRING ? `${value.slice(0, PREVIEW_MAX_STRING)}…` : value
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const head = value.slice(0, PREVIEW_MAX_ARRAY).map(entry => previewValue(entry, depth + 1))
    return value.length > PREVIEW_MAX_ARRAY ? [...head, '[…]'] : head
  }
  const entries = Object.entries(value).slice(0, PREVIEW_MAX_KEYS)
  const output: Record<string, JsonValue> = {}
  for (const [key, entry] of entries) output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : previewValue(entry, depth + 1)
  if (Object.keys(value).length > PREVIEW_MAX_KEYS) output['…'] = '[…]'
  return output
}

/** One confirmation preview; text is bounded and never raw. */
function confirmationPreview(args: JsonValue, effect: OperationEffect): ConfirmationPreview {
  let text: string
  try {
    /* v8 ignore next -- JSON.stringify of a JsonValue always returns a string */
    text = JSON.stringify(previewValue(args, 0)) ?? 'null'
  } catch {
    /* v8 ignore next -- a JsonValue cannot reach JSON.stringify's throw path */
    text = '[unserializable]'
  }
  /* v8 ignore next -- a small preview (the common case) does not truncate */
  if (text.length > PREVIEW_MAX_BYTES) text = `${text.slice(0, PREVIEW_MAX_BYTES)}…`
  return { effect, args: text }
}

/** A short label for confirmation text. */
function callerKindLabel(caller: Caller): string {
  return caller.kind === 'app' || caller.kind === 'background'
    ? `the application ${caller.appId}`
    : ANONYMOUS_CALLER_LABELS[caller.kind]
}

/** Whether a task descriptor is usable; user-facing text stays bounded. */
function assertTaskDescriptor(descriptor: TaskDescriptor): void {
  if (descriptor.kind.trim() === '' || descriptor.kind.length > 80) {
    throw new AppError('task-invalid', 'task kind must be 1..80 characters')
  }
  if (descriptor.title.trim() === '' || descriptor.title.length > 200) {
    throw new AppError('task-invalid', 'task title must be 1..200 characters')
  }
  if ((descriptor.externalId?.length ?? 0) > 200) {
    throw new AppError('task-invalid', 'task externalId must be at most 200 characters')
  }
  if ((descriptor.requestId?.length ?? 0) > 200) {
    throw new AppError('task-invalid', 'task requestId must be at most 200 characters')
  }
}

/** Build the immutable control-plane snapshot from the internal entry. */
function taskSnapshot(entry: TaskEntry): TaskSnapshot {
  return {
    taskId: entry.taskId,
    traceId: entry.traceId,
    appId: entry.appId,
    kind: entry.kind,
    title: entry.title,
    ...(entry.externalId === undefined ? {} : { externalId: entry.externalId }),
    ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
    origin: entry.origin,
    state: entry.state,
    ...(entry.progress === undefined ? {} : { progress: entry.progress }),
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(entry.resultSummary === undefined ? {} : { resultSummary: entry.resultSummary }),
  }
}

/**
 * Keep task summaries small enough to be control-plane data. An oversized or
 * unserializable value is dropped and reported; the task itself still settles.
 */
function boundedJson(
  value: JsonValue | void,
  label: 'progress' | 'result',
  entry: TaskEntry,
  onProblem: (problem: string) => void,
): JsonValue | undefined {
  if (value === undefined) return undefined
  try {
    const encoded = JSON.stringify(value)
    if (encoded.length > MAX_TASK_SUMMARY_CHARS) {
      onProblem(`task ${entry.taskId} ${label} summary exceeds ${String(MAX_TASK_SUMMARY_CHARS)} characters; dropped`)
      return undefined
    }
    return value
  } catch (error: unknown) {
    onProblem(`task ${entry.taskId} ${label} summary is not serializable: ${String((error as Error)?.message ?? error)}`)
    return undefined
  }
}

/**
 * Whether a thrown error is the operation honouring the cancellation request.
 * Only the conventional abort errors count: a cancellation request does not
 * turn a real failure into a cancellation, and work that finishes anyway is
 * reported as what it actually did.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** One health hook's settlement: its raw result, or the platform diagnostic for a throw. */
interface HealthInvocation {
  readonly result?: unknown
  readonly failure?: string
}

/** The longest diagnostic detail copied from an application's thrown health hook. */
const MAX_HEALTH_DETAIL_CHARS = 300

/** Render one thrown health-hook error as bounded diagnostic text (never a stack). */
function healthDetailText(error: unknown): string {
  const message = String((error as Error)?.message ?? error)
  return message.length > MAX_HEALTH_DETAIL_CHARS ? `${message.slice(0, MAX_HEALTH_DETAIL_CHARS)}…` : message
}

/**
 * Validate one health hook's result. Anything but the declared shape is an
 * invalid result — the platform never guesses a status.
 * @param value - the raw value the hook returned.
 * @returns the validated result, or undefined when the shape is invalid.
 */
function validateHealthResult(value: unknown): AppHealthCheckResult | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as { readonly status?: unknown; readonly reason?: unknown }
  if (record.status !== 'ok' && record.status !== 'degraded' && record.status !== 'unhealthy') return undefined
  if (record.reason !== undefined && (typeof record.reason !== 'string' || record.reason.trim() === '')) return undefined
  return { status: record.status, ...(record.reason === undefined ? {} : { reason: record.reason }) }
}
