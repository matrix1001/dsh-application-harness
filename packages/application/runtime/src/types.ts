/**
 * The application runtime's public vocabulary — the single definition of what
 * an application declares, who may call it, what a call returns, and what an
 * executing operation may ask of the platform.
 *
 * Browser-safe by construction: the module holds types only (the two imports
 * are `import type`, erased at build), so a client package may take the shape
 * of a call result or a declaration without pulling any host I/O into its
 * bundle.
 *
 * The parameters and results of an operation are declared in the PLATFORM's
 * JSON Schema DSL (`@deepseek-ai/dsh-tools`), the same one the platform's tools
 * use — an operation has one declaration, and the AI tool face, the remote
 * face and the permission check all read it. There is no second business
 * interface.
 * @module @matrix1001/dsh-application-harness-runtime/types
 */

import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable application identity (declared once by the application author). */
export type AppId = string

/** Operation name, unique within one application. */
export type OpName = string

/**
 * A business object's stable identity across entries. It names the owning
 * application, the application-defined object type and the object id; it
 * carries no display data, authorization, business version or platform
 * instance field.
 */
export interface ObjectRef {
  readonly appId: AppId
  readonly type: string
  readonly id: string
}

/** One event a publisher declares; subscription is closed unless explicitly opened. */
export interface AppEventDeclaration {
  /** What changed, in words the user can understand. */
  readonly description: string
  /** Whether other applications may subscribe; omitted = closed. */
  readonly subscription?: 'open' | 'closed'
}

/** One published, refs-only business-change notice. */
export interface AppEvent {
  readonly kind: 'app-event'
  readonly appId: AppId
  readonly type: string
  readonly eventId: string
  readonly occurredAt: string
  readonly refs?: readonly ObjectRef[]
}

/** A subscriber's callback; it receives only the refs-only event. */
export type AppEventListener = (event: AppEvent) => void | Promise<void>

/** One declared subscription: source application and event type. */
export interface EventSubscription {
  readonly appId: AppId
  readonly type: string
}

/** The fixed page actions a page can declare. */
export type PageActionName = 'navigate' | 'set-filters' | 'select'

/** One page this application exposes to its owner-session page service. */
export interface PageDeclaration {
  /** What the page is for. */
  readonly description: string
  /** Fixed actions this page supports; omitted means all three. */
  readonly actions?: readonly PageActionName[]
}

/** One process command an application declares for display and review. */
export interface ProcessCommandDeclaration {
  /** Stable command name shown in the management UI. */
  readonly name: string
  /** What the command is for. */
  readonly description: string
  /** Optional executable/argument display list; the platform does not enforce it. */
  readonly argv?: readonly string[]
}

/** One object type a cross-application reference can resolve. */
export interface ObjectTypeDeclaration {
  /** What the object type is, in words the user can understand. */
  readonly description?: string
  /** The declared read operation that resolves one reference by `{ id }`. */
  readonly resolveOperation: OpName
}

/** The display facts a resolver returns for one reference. */
export interface ObjectResolution {
  readonly ref: ObjectRef
  readonly title: string
  readonly summary?: string
}

/** The capability name of one event subscription. */
export function eventCapability(target: AppId, type: string): string {
  return `event:${target}#${type}`
}

/**
 * Who is asking. The trusted entry point injects this — it is never read from
 * business arguments, so a browser or an AI tool call cannot claim to be
 * someone else. A call from application A to application B carries A; B's own
 * calls onward carry B.
 */
export type Caller =
  | { readonly kind: 'human' }
  | {
    readonly kind: 'ai'
    /** The session whose turn triggered the call, when there is one. */
    readonly sessionId?: string
    /** Identity of the running turn, when the platform supplies it. */
    readonly turnId?: string
    /** The application a development Session is bound to; writes are forced to confirm. */
    readonly developmentApp?: AppId
  }
  | {
    readonly kind: 'app'
    readonly appId: AppId
    /** The source Session for a synchronous peer call; absent for a host-initiated one. */
    readonly sessionId?: string
  }
  | {
    readonly kind: 'background'
    readonly appId: AppId
    /** Background work never carries a Session: its interaction context is `none`. */
    readonly sessionId?: undefined
  }

/**
 * How one class of caller may reach an operation:
 *
 * - `closed` — not offered to this class at all (the default);
 * - `open` — allowed; for a peer call this still requires the caller to have
 *   declared it and the user to have granted it;
 * - `confirm` — allowed only after the user confirms this call.
 *
 * A human using the application's own interface is not subject to this: the
 * interface is the human's way in.
 */
export type Exposure = 'closed' | 'open' | 'confirm'

/** Per-class openness of one operation; omitted classes stay closed. */
export interface OpExposure {
  /** May the AI call it (through the platform's tools), and how. */
  readonly ai?: Exposure
  /** May another application call it, and how. */
  readonly peers?: Exposure
}

/** The user's one override per operation; `default` follows the author's class rule. */
export type OperationPolicy = 'default' | 'allow' | 'confirm' | 'forbid'

/** One persisted user override. */
export interface OperationPolicyEntry {
  readonly appId: AppId
  readonly operation: OpName
  readonly policy: Exclude<OperationPolicy, 'default'>
  readonly updatedAt: string
}

/** Durable storage for the user's operation policies. */
export interface PolicyStorePort {
  /** Read the stored entries; a missing store is an empty table. */
  list(): Promise<readonly OperationPolicyEntry[]>
  /** Replace the whole table; a failed save must reject. */
  save(entries: readonly OperationPolicyEntry[]): Promise<void>
}

/** Lifecycle state of one application, distinct from the plugin's own state. */
export type AppStatus =
  | 'starting'
  | 'available'
  | 'stopping'
  | 'stopped'
  /** Stop ran out of its wait budget with work still running. */
  | 'stop-incomplete'
  /** Start threw; the application is not callable and reports why. */
  | 'failed'

/** The four public runtime states, independent of health and activation. */
export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'stopping'

/** User activation, separate from the runtime lifecycle state. */
export type Activation = 'enabled' | 'disabled'

/** Optional health beside the lifecycle state; absent is healthy enough for the state. */
export type AppHealth = 'ok' | 'degraded'

/** Stable reason codes for a non-ready or degraded application. */
export type AppReason =
  | 'platform.updating'
  | 'platform.start-failed'
  | 'platform.health-failed'
  | 'platform.unavailable'
  | 'platform.stop-incomplete'

/** Stable rejection codes for calls refused BEFORE the operation ran. */
export type RejectionCode =
  | 'unknown-app'
  | 'unknown-op'
  | 'unavailable'
  | 'stopping'
  | 'invalid-args'
  /** The operation is not open to this class of caller. */
  | 'not-open-to-caller'
  /** A peer caller that has not declared this call. */
  | 'caller-not-declared'
  /** A peer call revisited an application already in its chain. */
  | 'call-cycle'
  /** A peer call exceeded the runtime's nesting limit. */
  | 'call-depth'
  /** The user (or the stored grant) refused. */
  | 'denied'
  /** The operation wants confirmation and no channel can deliver it. */
  | 'confirmation-unavailable'
  | 'confirmation-declined'

/**
 * Stable failure codes for calls that FAILED after the operation started.
 * `threw` and `invalid-result` are the runtime's own; anything else is the
 * application's business code, carried through from {@link AppError}.
 */
export type FailureCode =
  /** The operation threw without a business code. Effects already produced are NOT rolled back. */
  | 'threw'
  /** The operation returned a value its own result declaration rejects. */
  | 'invalid-result'
  // eslint-disable-next-line @typescript-eslint/ban-types -- the open-ended arm keeps autocomplete for the two above.
  | (string & {})

/** The public error body of every non-success outcome. */
export interface OutcomeError {
  /** Stable code; platform codes use the `platform.` prefix, business codes `app.`. */
  readonly code: string
  /** Readable, localizable explanation; programs branch on `code`, not this text. */
  readonly message: string
  /** Optional JSON object with field paths, known effects or object references. */
  readonly details?: JsonValue
}

/**
 * The outcome of one call. The five kinds are deliberately distinguishable:
 * a rejection means the operation did not run; a failure means it ran (or
 * partly ran) and the caller must treat effects as possible; cancellation is a
 * request that stopped the call; unknown means the platform cannot determine
 * whether the operation ran or what it produced.
 *
 */
export type CallOutcome =
  | { readonly callId: string; readonly status: 'success'; readonly result?: JsonValue }
  | {
    readonly callId: string
    readonly status: 'rejected'
    readonly error?: OutcomeError
  }
  | {
    readonly callId: string
    readonly status: 'failed'
    readonly error?: OutcomeError
  }
  | { readonly callId: string; readonly status: 'cancelled'; readonly error?: OutcomeError }
  | {
    readonly callId: string
    readonly status: 'unknown'
    readonly error?: OutcomeError
  }

/** The verdict of one permission check. */
export type PermissionVerdict = 'allow' | 'deny' | 'confirm'

/** The application that changed; the subscription selects data or lifecycle changes. */
export interface AppChangeNotice {
  readonly appId: AppId
}

/**
 * One progress notification, bound to the call that reported it. Progress is
 * transient: it is not history, it is not persisted, and a delivery failure
 * never changes what the operation achieves.
 */
export interface ProgressNotice {
  readonly appId: AppId
  readonly op: OpName
  readonly callId: string
  readonly message: string
  readonly data: JsonValue | undefined
}

/** Stable background-task identity, unique per runtime. */
export type TaskId = string

/**
 * One background task's lifecycle. `cancelling` is a request that has not
 * settled yet; `interrupted` is a task found running when the host restarted,
 * not one the application finished or cancelled.
 */
export type TaskState =
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Who/where a task came from; the caller is display provenance, not authority. */
export type TaskOrigin =
  | { readonly kind: 'operation'; readonly callId: string; readonly caller: Caller }
  | { readonly kind: 'background' }

/** What an application says about one task when it starts it. */
export interface TaskDescriptor {
  /** Business kind, e.g. `scan` or `refresh`; display grouping only. */
  readonly kind: string
  /** Human-readable title; the application owns the wording. */
  readonly title: string
  /** The application's own durable record id, when one exists. */
  readonly externalId?: string
  /** Idempotency key: a replay returns the already-started task. */
  readonly requestId?: string
}

/** Latest progress reported by one task; transient, not a log. */
export interface TaskProgress {
  readonly message: string
  readonly data?: JsonValue
  readonly updatedAt: string
}

/** Controlled task failure; never a stack trace or full result. */
export interface TaskError {
  readonly code: string
  readonly message: string
}

/**
 * The immutable control-plane projection of one task. Business state stays in
 * the application's own record (`externalId` points at it); this snapshot is
 * what the host, the client and the task center read.
 */
export interface TaskSnapshot {
  readonly taskId: TaskId
  /** Stable trace anchor for this task; the task id in the minimal chain. */
  readonly traceId: string
  readonly appId: AppId
  readonly kind: string
  readonly title: string
  readonly externalId?: string
  readonly requestId?: string
  readonly origin: TaskOrigin
  readonly state: TaskState
  readonly progress?: TaskProgress
  readonly startedAt: string
  readonly updatedAt: string
  readonly endedAt?: string
  readonly error?: TaskError
  /** Bounded summary; not the application's business result. */
  readonly resultSummary?: JsonValue
}

/** One task state/progress/settlement notification. */
export interface TaskNotice {
  readonly appId: AppId
  readonly task: TaskSnapshot
}

/** What a task's own work may do; cancellation is a request, not a rollback. */
export interface TaskContext {
  readonly appId: AppId
  readonly taskId: TaskId
  /** Aborted by task cancellation or application stop. */
  readonly signal: AbortSignal
  /** The application's capability door, in its background role. */
  readonly capabilities: CapabilityAccess
  /** This application's declared secrets, kept outside its business data. */
  readonly secrets: AppSecretAccess
  /** Report the latest progress; delivery never changes the task's outcome. */
  reportProgress(message: string, data?: JsonValue): void
  /** Call another application as this one, under this task's cancellation. */
  call(target: AppId, op: OpName, args: JsonValue): Promise<CallOutcome>
  /** Declare that this application's data changed. */
  notifyChanged(): void
  /** Publish one declared business-change event after the task's work. */
  publishEvent(type: string, refs?: readonly ObjectRef[]): void
}

/** What a started task hands back; `done` never rejects. */
export interface TaskHandle {
  readonly taskId: TaskId
  /** Resolves when the task settles; the outcome is in the task snapshot. */
  readonly done: Promise<void>
}

/** The result of asking to cancel one task. */
export type TaskCancelResult = 'accepted' | 'settled' | 'not-found'

/** The work a task runs; its return value becomes the bounded result summary. */
export type TaskWork = (ctx: TaskContext) => JsonValue | void | Promise<JsonValue | void>

/** One application's own secret fields, gated by its data declaration. */
export interface AppSecretAccess {
  /** Names currently set for this application (never values). */
  names(): Promise<readonly string[]>
  /** Whether one declared secret is set. */
  has(name: string): Promise<boolean>
  /** Read one declared secret value; host-only, never sent to the browser. */
  get(name: string): Promise<string | undefined>
  /** Set one declared secret. */
  set(name: string, value: string): Promise<void>
  /** Delete one declared secret. */
  delete(name: string): Promise<boolean>
}

/**
 * What an executing operation may do. Bound to the one call it belongs to —
 * `call` carries this application's identity, `reportProgress` speaks for this
 * call, `signal` carries the caller's cancellation request.
 */
export interface OperationContext {
  /** The application the operation belongs to. */
  readonly appId: AppId
  readonly op: OpName
  /** Correlation id of this call, unique per runtime. */
  readonly callId: string
  readonly caller: Caller
  /**
   * Aborted when the caller asks to cancel. Cancellation is a request: the
   * operation decides how to stop, and the effects it already produced are
   * not undone.
   */
  readonly signal: AbortSignal
  /**
   * This application's door to the platform capabilities it declared (see
   * {@link CapabilityAccess}): the entry checks the application's declaration
   * and the user's grants before the capability is used. A human using the
   * interface adds no operation grant of their own — but the application's use
   * of a platform capability is still the application's to be authorized.
   */
  readonly capabilities: CapabilityAccess
  /** This application's declared secrets, kept outside its business data. */
  readonly secrets: AppSecretAccess
  /**
   * Report progress for this call. Delivery is best-effort: a reporting
   * failure never changes what the operation achieves.
   */
  reportProgress(message: string, data?: JsonValue): void
  /**
   * Call another application as THIS application. The callee's checks run
   * against this application's declaration and grants — not the original
   * caller's.
   */
  call(target: AppId, op: OpName, args: JsonValue): Promise<CallOutcome>
  /**
   * Declare that this application's data changed (whether from an operation,
   * background work or an observed external change). Readers of this
   * application re-read through operations; the notice carries no data.
   */
  notifyChanged(): void
  /**
   * Start application-owned background work that outlives this call. The task
   * is a control-plane projection; the application's own durable record stays
   * the business source of truth.
   */
  startTask(descriptor: TaskDescriptor, work: TaskWork): TaskHandle
  /** Publish one declared, refs-only change notice; delivery is best-effort. */
  publishEvent(type: string, refs?: readonly ObjectRef[]): AppEvent
}

/** The context handed to an application's start/stop hooks. */
export interface AppContext {
  readonly appId: AppId
  /** Aborted when the application is asked to stop. */
  readonly signal: AbortSignal
  /**
   * This application's capability door for lifecycle and background work (see
   * {@link CapabilityAccess}). Background work obeys the application's own
   * declaration and grants — the same ones its operations use.
   */
  readonly capabilities: CapabilityAccess
  /** This application's declared secrets, kept outside its business data. */
  readonly secrets: AppSecretAccess
  /** Call another application as this one (same rules as {@link OperationContext.call}). */
  call(target: AppId, op: OpName, args: JsonValue): Promise<CallOutcome>
  notifyChanged(): void
  /** Publish one declared, refs-only change notice; delivery is best-effort. */
  publishEvent(type: string, refs?: readonly ObjectRef[]): AppEvent
  /**
   * Subscribe to one declared event of another application as this application.
   * Requires the subscriber's declaration, an open publisher event and the
   * user's standing grant; the returned function ends the subscription.
   */
  subscribe(publisher: AppId, type: string, listener: AppEventListener): Promise<() => void>
  /** Start application-owned background work; see {@link OperationContext.startTask}. */
  startTask(descriptor: TaskDescriptor, work: TaskWork): TaskHandle
}

/** Whether one operation only reads its application's state or can change it. */
export type OperationEffect = 'read' | 'write'

/**
 * One operation, declared once: what a caller sees (description, parameters,
 * result, openness) and what runs (execute). The same declaration feeds the
 * remote face, the AI tool face and the permission check.
 */
export interface OperationDeclaration {
  /** Human- and model-readable description of what the operation does. */
  readonly description: string
  /** Platform-DSL parameter schema; `{}` declares an operation that takes none. */
  readonly params: ParameterSchemaSpec
  /** Platform-DSL schema of the value the operation returns. */
  readonly result: ValueSchemaSpec
  /** Per-class openness; omitted classes are closed. */
  readonly exposure?: OpExposure
  /**
   * Whether the operation is read-only. Omitted means `write`: the safe default
   * for a capability the platform may offer through a read-only surface. Reads
   * must not change durable state or cause an external side effect.
   */
  readonly effect?: OperationEffect
  /** The business implementation. */
  readonly execute: (args: JsonValue, ctx: OperationContext) => JsonValue | Promise<JsonValue>
}

/** How one application keeps its durable data. */
export type AppDataKind = 'none' | 'unified' | 'own-sqlite' | 'files'

/** Where an application's durable data lives and how the host may handle it. */
export interface AppDataDeclaration {
  readonly kind: AppDataKind
  /** Unified-store namespace; required for `unified`, forbidden otherwise. */
  readonly namespace?: string
  /** Path under the harness data root; required for `own-sqlite` / `files`. */
  readonly path?: string
  /** Durable schema version, owned by the application. */
  readonly schemaVersion?: number
  /** Whether the host's whole-data backup includes this data (default include). */
  readonly backup?: 'include' | 'exclude'
  /** Operation that serialises this application's data for export. */
  readonly exportOp?: OpName
  /** Operation that imports data previously produced by `exportOp`. */
  readonly importOp?: OpName
  /** Names of secret fields managed by the host secret store, never by app data. */
  readonly secretFields?: readonly string[]
}

/** One peer application this declaration may call. */
export type AppCall =
  | AppId
  | {
    readonly app: AppId
    /** The exact operations this application may call on the target. */
    readonly ops: readonly OpName[]
  }

/**
 * One application, declared once: identity, operations, what it needs from
 * others, and its optional start/stop hooks. No base class is involved —
 * registration, permission checks and lifecycle coordination are the
 * runtime's job.
 */
export interface AppDeclaration {
  readonly id: AppId
  /** Display name. */
  readonly name: string
  readonly description: string
  readonly version: string
  /** The application's operations, keyed by name. */
  readonly ops: Readonly<Record<OpName, OperationDeclaration>>
  /** Applications/operations this one declares it may call (peer calls outside this list are refused). */
  readonly calls?: readonly AppCall[]
  /** Events this application publishes, keyed by type. */
  readonly events?: Readonly<Record<string, AppEventDeclaration>>
  /** Event subscriptions this application declares. */
  readonly subscriptions?: readonly EventSubscription[]
  /** Object types this application exposes for cross-application references. */
  readonly objectTypes?: Readonly<Record<string, ObjectTypeDeclaration>>
  /** Process commands this application declares, for display only. */
  readonly process?: { readonly commands: readonly ProcessCommandDeclaration[] }
  /** Pages this application exposes; view keys are stable and local to it. */
  readonly pages?: Readonly<Record<string, PageDeclaration>>
  /** Declaration generation; new applications use 2 and must declare `data`. */
  readonly generation?: number
  /** Durable data description; required for generation 2 applications. */
  readonly data?: AppDataDeclaration
  /**
   * Platform capabilities this one declares it needs, in the harness's own
   * vocabulary: `model` (the platform LLM), `network` (the harness network
   * seam), `process` (running subprocesses) and `storage` (the harness store).
   * Each harness-mediated entry of those capabilities checks this declaration
   * AND the user's grant before doing its work; using an entry the declaration
   * does not cover is refused (`capability-undeclared`). An application's own
   * file and network use is not mediated here — declaring a capability states a
   * need, it is not a sandbox and never a substitute for the check.
   */
  readonly capabilities?: readonly string[]
  /** Optional: run when the application becomes available. */
  readonly start?: (ctx: AppContext) => void | Promise<void>
  /** Optional: run when the application stops, before its tracked work is awaited. */
  readonly stop?: (ctx: AppContext) => void | Promise<void>
  /**
   * Optional: re-read the application's durable data after an external writer
   * (the host's application-data import) changed it while this instance kept a
   * cached document. The runtime calls it without changing the application's
   * lifecycle or status; the caller announces the data change separately.
   */
  readonly reload?: (ctx: AppContext) => void | Promise<void>
  /**
   * Optional: stop starting new background work before the host replaces this
   * application's durable data. The runtime refuses new calls, calls this, then
   * waits for the work already in flight; {@link resume} runs when the hold is
   * released. A missing hook means the application has no timers or background
   * work to pause.
   */
  readonly pause?: (ctx: AppContext) => void | Promise<void>
  /** Optional: re-arm the work {@link pause} stopped, after the import reload. */
  readonly resume?: (ctx: AppContext) => void | Promise<void>
}

/**
 * One recorded grant: which caller may use which capabilities. A capability is
 * named once, in the same vocabulary the check speaks:
 *
 * - `<appId>#<op>` — one operation of one application;
 * - `capability:<name>` — one platform capability an application declares.
 *
 * The capability set is exactly what the user approved at grant time: a later
 * declaration that adds operations or capabilities does not extend it.
 */
export interface CapabilityGrant {
  /** The caller the grant belongs to. */
  readonly caller: Caller
  /** The exact capability set the user approved at grant time. */
  readonly capabilities: readonly string[]
  /** When the user approved it (ISO-8601). */
  readonly grantedAt: string
}

/** The capability name of one operation of one application. */
export function opCapability(target: AppId, op: OpName): string {
  return `${target}#${op}`
}

/** The capability name of one platform capability. */
export function platformCapability(name: string): string {
  return `capability:${name}`
}

/**
 * The verdict of one capability check — which is also what one capability USE
 * comes to. A use is checked against the application's declaration and the
 * user's STANDING approval; there is no per-use question to ask, because the
 * user approves a capability in the applications panel and that approval (or
 * its revocation) is what every later use reads. An application never asks for
 * itself, and never grants itself anything.
 */
export type CapabilityVerdict =
  /** Declared and approved: the entry may do the work. */
  | 'allow'
  /** The application never declared it: a declaration bug, not a permission question. */
  | 'undeclared'
  /** Declared, but not approved: the panel is where the user approves it. */
  | 'not-approved'

/**
 * One application's own door to the platform capabilities it declared — the
 * face the runtime binds to an application's operation or lifecycle context and
 * hands to the capability entries (the model port, the network seam, the
 * process runner, the store).
 *
 * The identity is bound HERE, by the trusted entry that built the face: no
 * business argument carries it, so an entry cannot be made to check (or to
 * answer for) another application. `use` is the only way in — it asks the
 * runtime, which checks the application's declaration and the user's standing
 * approval and refuses with an `AppError` (`capability-not-approved` /
 * `capability-undeclared`) when the use is not allowed. The work never runs in
 * that case; an entry that wants to degrade catches that error. The verdict
 * WITHOUT using anything is the runtime's own `checkCapability`.
 */
export interface CapabilityAccess {
  /** The application this face acts as. */
  readonly appId: AppId
  /**
   * Run `work` allowed to use one platform capability as this application.
   * @param name - the capability name (`model`, `network`, `process`, `storage`).
   * @param work - what runs once the use is allowed; it does not run otherwise.
   * @returns the work's value.
   */
  use<T>(name: string, work: () => T | Promise<T>): Promise<T>
}

/** The permission question the runtime answers for one call. */
export interface PermissionRequest {
  readonly caller: Caller
  readonly target: AppId
  readonly op: OpName
}
