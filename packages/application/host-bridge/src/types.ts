/**
 * The browser-facing vocabulary of the host application surface: one call's
 * outcome, one application row, one pending confirmation, and the watch
 * stream's events.
 *
 * Browser-safe by construction: types only (every import is `import type`), no
 * host I/O and no Context merge, so a client package takes every shape it
 * needs from here — through the `./client` outlet — without pulling the bridge
 * or the runtime into its bundle. The vocabulary the runtime declares in its
 * own public type subpath (`Caller`, `CapabilityGrant`, `AppStatus`, the
 * exposure and code unions) is re-exported, never restated: it is the same fact
 * on both sides of the wire.
 *
 * The rest of the vocabulary is DECLARED here, for one reason: a Remote
 * boundary type must be OWNED by a workspace package — the typert generator
 * imports a boundary type from the package that declares it, and a foreign
 * package's alias has no import to emit. Concretely:
 *
 * - `JsonValue`/`JsonObject`: the platform's `JsonValue` is a foreign alias.
 * - `OpParams`/`OpParamSchema`: the platform's `ParameterSchemaSpec` is not a
 *   wire type at all (it carries a symbol index signature the validator
 *   refuses, and recurses through a foreign alias). The mirror is the READ
 *   shape of the very same values: the declaration's own schema object travels
 *   verbatim, so the platform DSL stays the single source of truth.
 * - `CallOutcome`, `HistoryRecord`, `ProgressNotice`: the runtime's own records
 *   in wire form. `CallOutcome` and `HistoryRecord` are declared at the
 *   runtime's package root (not in its `./types` subpath, which boundaries must
 *   use, and `ProgressNotice.data` is a required-but-possibly-undefined field
 *   the JSON boundary refuses as such). Every one of them is produced by the
 *   runtime unchanged and handed straight back, so a drift fails to compile
 *   rather than reaching the wire.
 * @module @matrix1001/dsh-application-harness-host-bridge/types
 */

import type { Activation, AppHealth, AppReason, Caller, OpExposure, ProcessDeclaration, RuntimeState, ObjectResolution } from '@matrix1001/dsh-application-harness-runtime/types'

export type {
  Activation, RuntimeState, AppHealth, AppReason, AppStatus, Caller, CapabilityGrant, Exposure, FailureCode, ObjectRef, ObjectResolution, ObjectTypeDeclaration, OpExposure, OperationPolicy, OperationPolicyEntry, RejectionCode,
  AppDelegation, AppDelegationAccess, DelegationCreateInput, ProcessDeclaration, ProcessDescriptor, ProcessAccess,
} from '@matrix1001/dsh-application-harness-runtime/types'

/**
 * One delegation's state, in wire form. Declared here (not aliased from the
 * runtime) because a Remote boundary type and every recursive type under it
 * must be owned by this face; the runtime's application-facing vocabulary is
 * the same fact, and the bridge's tests pin the two together.
 */
export type DelegationStatus = 'pending' | 'active' | 'needs-person' | 'ended'

/** Why a delegation ended, in wire form. */
export type DelegationOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable'

/** The execution Session's structured report, in wire form. */
export interface DelegationReport {
  /** What the Session reports. */
  readonly outcome: 'completed' | 'blocked' | 'failed'
  /** Readable summary of what happened. */
  readonly summary: string
  /** The concrete question a `blocked` report asks. */
  readonly question?: string
  /** Application-shaped payload; never conversation text. */
  readonly details?: JsonValue
}

/**
 * One delegation as the browser's management surface reads it. This is the
 * HUMAN-facing record: it carries the bound `sessionId` so the platform's
 * `openDelegation` action can show the execution, while the application-facing
 * port deliberately omits it. `instructions` is what the human reviews before
 * sending; the execution Session's transcript is never part of this record.
 */
export interface DelegationInfo {
  /** Platform-assigned identity. */
  readonly id: string
  /** The application that prepared and owns the delegation. */
  readonly appId: string
  /** Short display title the application prepared. */
  readonly title: string
  /** The application's instructions, snapshotted at creation. */
  readonly instructions: string
  /** Delegation state (not an application status). */
  readonly status: DelegationStatus
  /** Why it ended; present exactly when `status` is `ended`. */
  readonly outcome?: DelegationOutcome
  /** The application-area Session the delegation was sent to, after a human sends it. */
  readonly sessionId?: string
  /** The newest report the execution Session wrote. */
  readonly latestReport?: DelegationReport
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * One progress notification, bound to the call that reported it — the runtime's
 * own `ProgressNotice` in wire form: `data` is optional here because JSON has
 * no `undefined` and a report without data omits the field (the runtime's
 * record carries `undefined` explicitly, which the transport drops either way).
 */
export interface ProgressNotice {
  readonly appId: string
  readonly op: string
  readonly callId: string
  readonly message: string
  readonly data?: JsonValue | undefined
}

/** One background task's lifecycle, in wire form. */
export type TaskState =
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Where a task came from; the caller is display provenance, not authority. */
export type TaskOrigin =
  | { readonly kind: 'operation'; readonly callId: string; readonly caller: Caller }
  | { readonly kind: 'background' }

/** The latest progress of one task. */
export interface TaskProgress {
  readonly message: string
  readonly data?: JsonValue
  readonly updatedAt: string
}

/** A controlled task failure. */
export interface TaskError {
  readonly code: string
  readonly message: string
}

/**
 * The control-plane projection of one task. The application's own durable
 * record remains the business source of truth; `externalId` points at it.
 */
export interface TaskSnapshot {
  readonly taskId: string
  /** Stable trace anchor for this task; the task id in the minimal chain. */
  readonly traceId: string
  readonly appId: string
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
  readonly resultSummary?: JsonValue
}

/** The answer to a task-cancel request. */
export type TaskCancelResult = 'accepted' | 'settled' | 'not-found'

/**
 * One JSON object: the open string-keyed map every JSON tree is built from.
 * Declared as a named type (rather than inlined into {@link JsonValue}) so this
 * recursive vocabulary is a declaration this package owns — the wire
 * generator's recursive types must be, and the platform's own `JsonValue` is a
 * foreign alias.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/**
 * The JSON vocabulary every business argument, result and payload on this wire
 * is written in — the runtime's own `JsonValue`, declared here because a Remote
 * boundary type must be owned by a workspace package (see the module note).
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

/**
 * The annotation keywords every schema node may carry (the platform's
 * `ValueSchemaAnnotations`, verbatim). `required` rides here because the
 * platform writes requiredness as a per-property annotation on the implicit
 * parameter object rather than as a separate list.
 */
export interface OpParamAnnotations {
  /** Human-readable description of the parameter. */
  readonly description?: string
  /** Human-readable title of the parameter. */
  readonly title?: string
  /** Non-validating default annotation (lossless JSON data). */
  readonly default?: JsonValue
  /** Non-validating examples annotation (lossless JSON data). */
  readonly examples?: JsonValue
  /** Set on a parameter the caller must supply. */
  readonly required?: true
}

/** A string parameter, optionally constrained to literals. */
export interface OpParamStringSchema extends OpParamAnnotations {
  readonly type: 'string'
  readonly enum?: readonly string[]
  readonly const?: string
}

/** A finite-number parameter, optionally constrained to literals. */
export interface OpParamNumberSchema extends OpParamAnnotations {
  readonly type: 'number'
  readonly enum?: readonly number[]
  readonly const?: number
}

/** An integer parameter, optionally constrained to literals. */
export interface OpParamIntegerSchema extends OpParamAnnotations {
  readonly type: 'integer'
  readonly enum?: readonly number[]
  readonly const?: number
}

/** A boolean parameter, optionally constrained to literals. */
export interface OpParamBooleanSchema extends OpParamAnnotations {
  readonly type: 'boolean'
  readonly enum?: readonly boolean[]
  readonly const?: boolean
}

/** A null parameter, optionally constrained to literals. */
export interface OpParamNullSchema extends OpParamAnnotations {
  readonly type: 'null'
  readonly enum?: readonly null[]
  readonly const?: null
}

/** An array parameter; an omitted `items` accepts any lossless JSON item. */
export interface OpParamArraySchema extends OpParamAnnotations {
  readonly type: 'array'
  readonly items?: OpParamSchema
}

/** An object parameter. `additionalProperties` is always explicit in the platform DSL. */
export interface OpParamObjectSchema extends OpParamAnnotations {
  readonly type: 'object'
  readonly properties?: OpParams
  readonly additionalProperties: boolean
}

/** An author-only unconstrained lossless JSON parameter. */
export interface OpParamJsonSchema extends OpParamAnnotations {
  readonly type: 'json'
}

/** An exact-one union parameter (at least two branches in the platform DSL). */
export interface OpParamOneOfSchema extends OpParamAnnotations {
  readonly oneOf: readonly OpParamSchema[]
}

/** One parameter's declared schema, as the browser reads it. */
export type OpParamSchema =
  | OpParamStringSchema
  | OpParamNumberSchema
  | OpParamIntegerSchema
  | OpParamBooleanSchema
  | OpParamNullSchema
  | OpParamArraySchema
  | OpParamObjectSchema
  | OpParamJsonSchema
  | OpParamOneOfSchema

/**
 * One operation's declared parameters: the implicit open object root, keyed by
 * parameter name. An interface rather than a `Readonly<Record<…>>` alias on
 * purpose — a recursive wire type must be a declaration this package owns, and
 * the standard library's `Readonly` is not one.
 */
export interface OpParams {
  readonly [name: string]: OpParamSchema
}

/** One operation of one application, as the browser sees it. */
export interface AppOp {
  /** Operation name, unique within the application. */
  readonly name: string
  /** Human-readable description of what the operation does. */
  readonly description: string
  /** The declared parameters, carried verbatim in the platform's schema DSL. */
  readonly params: OpParams
  /**
   * Per-class openness as declared (a class the declaration omits is `closed`).
   * A human using the application's own interface is not subject to it: the
   * interface is the human's way in.
   */
  readonly exposure: OpExposure
}

/** One application's answer to the first-run permission card (the capability-set fingerprint it saw). */
export interface OnboardingRecord {
  /** The sorted platform-capability fingerprint that was answered. */
  readonly fingerprint: string
  /** When the answer was recorded (ISO 8601). */
  readonly seenAt: string
}

/** The host-side first-run record, keyed by application id. */
export interface OnboardingState {
  /** One entry per application the human has answered or postponed. */
  readonly apps: Record<string, OnboardingRecord>
}

/** The browser-safe projection of one application's durable-data description. */
export interface AppDataDescription {
  readonly kind: 'none' | 'unified' | 'own-sqlite' | 'files'
  readonly namespace?: string
  readonly path?: string
  readonly schemaVersion?: number
}

/** One application the host runs, as the browser sees it. */
export interface AppInfo {
  /** Stable application identity. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** What the application is for. */
  readonly description: string
  /** The application's declared version. */
  readonly version: string
  /** The user's fixed model route; absent means follow the platform default. */
  readonly model?: { readonly provider: string; readonly model: string }
  /** The four public runtime states. */
  readonly runtime: RuntimeState
  /** User activation: disabled applications stay visible and stopped. */
  readonly activation: Activation
  /** True when the durable activation table could not be read; all applications stay disabled until it is repaired. */
  readonly activationUnavailable?: boolean
  /** Health beside the runtime state; present only while the application is ready. */
  readonly health?: AppHealth
  /** Stable reason for a degraded/blocked state, when one applies. */
  readonly reason?: AppReason
  /** Readable diagnostic detail: start failure, health reason, maintenance. */
  readonly detail?: string
  /**
   * Everything this application's declaration says it needs, each named the way
   * a grant records it: `capability:<name>` for a declared platform capability,
   * `event:<appId>#<type>` for a declared subscription to an event that is
   * actually open. It is a statement of need, NOT a grant — the panel offers
   * each one for approval, and the runtime refuses a use the declaration (or
   * the effective grants) does not cover.
   */
  readonly needs: readonly string[]
  /** The application's operations, in declaration order. */
  readonly ops: readonly AppOp[]
  /** Executables and commands this application declared for review. */
  readonly process?: readonly ProcessDeclaration[]
  /** Events this application publishes, when it declares any. */
  readonly events?: readonly AppEventInfo[]
  /** Object types the application exposes for cross-application references. */
  readonly objectTypes?: readonly AppObjectTypeInfo[]
  /** Declared cross-application calls and event subscriptions. */
  readonly connections?: readonly AppConnectionInfo[]
  /** Durable-data description, when the application declared one. */
  readonly data?: AppDataDescription
}

/** One declared cross-application connection. */
export type AppConnectionInfo =
  | {
    readonly kind: 'call'
    readonly target: string
    readonly ops: readonly string[] | 'all'
    readonly available: boolean
  }
  | {
    readonly kind: 'subscription'
    readonly publisher: string
    readonly event: string
    readonly open: boolean
    readonly available: boolean
  }

/** One application's model limits. */
export interface ModelLimits {
  /** Whether calls marked as background may run. */
  readonly background: boolean
  /** Maximum calls in flight; absent means unlimited. */
  readonly maxConcurrent?: number
  /** Maximum calls started in a rolling minute; absent means unlimited. */
  readonly maxCallsPerMinute?: number
}

/** One application's aggregated model usage. */
export interface ModelUsageSummary {
  readonly calls: number
  readonly succeeded: number
  readonly failed: number
  readonly cancelled: number
  /** Calls whose provider reported no token usage. */
  readonly usageMissing: number
  readonly totalDurationMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly lastAt?: string
  readonly lastStatus?: 'success' | 'failed' | 'cancelled'
  readonly lastModel?: { readonly provider: string; readonly model: string }
}

/** The live model catalog for the management UI. */
export interface ModelCatalog {
  readonly providers: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly { readonly id: string; readonly name: string }[]
  }[]
}

/** One resolvable object type, as the management UI shows it. */
export interface AppObjectTypeInfo {
  readonly type: string
  readonly description?: string
  readonly resolveOperation: string
}

/** One published event declaration, as the management UI shows it. */
export interface AppEventInfo {
  readonly type: string
  readonly description: string
  readonly subscription: 'open' | 'closed'
}

/** The public error body of every non-success outcome, in wire form. */
export interface OutcomeError {
  readonly code: string
  readonly message: string
  readonly details?: JsonValue
}

/**
 * One reference resolution's outcome on the wire: the display facts, or the
 * owning operation's own stable reason. Declared here (not aliased from the
 * runtime) because a Remote boundary type must be owned by this face; the
 * bridge method returns the runtime's result, so a structural drift between the
 * two fails to compile instead of reaching the wire.
 */
export type ObjectResolutionResult =
  | { readonly ok: true; readonly value: ObjectResolution }
  | { readonly ok: false; readonly error: OutcomeError }

/**
 * One call's outcome on the wire: the runtime's own five-way result, carried
 * through unchanged (the bridge maps nothing — a rejection means the operation
 * never ran, a failure means it ran and its effects may stand, unknown means
 * the platform cannot determine the result).
 *
 * `result`/`error` are the only fields; the old `value`/`code`/`message`
 * aliases are gone.
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

/**
 * One recorded call, newest first in `history()`: who called what, when, and
 * how it ended — never arguments or results. The runtime's own `HistoryRecord`
 * in wire form (its declaration lives behind the runtime's package root, which
 * no Remote boundary type may use); the bridge returns the runtime's records
 * unchanged, so a drift fails to compile.
 */
export interface HistoryRecord {
  readonly callId: string
  readonly caller: Caller
  readonly target: string
  readonly op: string
  /** ISO-8601 stamp of when the call was accepted. */
  readonly startedAt: string
  /** ISO-8601 stamp of when it ended. */
  readonly endedAt: string
  readonly status: CallOutcome['status']
  /** Stable rejection/failure code when the call did not succeed. */
  readonly code?: string
  /** Failure/rejection message (never full arguments or results). */
  readonly message?: string
  /** The command label of one process use; absent for operation calls. */
  readonly command?: string
}

/**
 * The answers a user may give to one pending confirmation.
 *
 * `allowed-once` lets this call run. Confirmation is never remembered; the
 * user's operation policy is the persistent setting. `denied` refuses it.
 */
export type ConfirmationDecision = 'allowed-once' | 'denied'

/** How one pending confirmation ended: the user's answer, or `cancelled` when the wait itself was ended. */
export type ConfirmationOutcome = ConfirmationDecision | 'cancelled'

/**
 * One confirmation waiting for a human answer, outside any session: an AI or
 * peer call — or an application's own use of a platform capability — needs the
 * user's consent and no in-session dialog can deliver it, so it waits here
 * until a browser answers it.
 */
export interface PendingConfirmation {
  /** Stable id within this host's lifetime; the id `answerConfirmation` names. */
  readonly id: string
  /** Who is asking. */
  readonly caller: Caller
  /**
   * The capability the user is being asked to approve: `<appId>#<op>` for an
   * operation, `capability:<name>` for a platform capability an application
   * declares. The approval covers this call only.
   */
  readonly capability: string
  /** What the user is being asked to allow, in words. */
  readonly reason: string
  /** The call's bounded, redacted arguments and effect, when the runtime supplied them. */
  readonly preview?: { readonly effect: 'read' | 'write'; readonly args: string }
  /** The Session that owns the question, when the caller has one. */
  readonly sessionId?: string
  /** Host stamp (ISO-8601) of when the question was asked. */
  readonly at: string
}

/** The first frame of every watch stream: the application list at the moment the stream opened. */
export interface WatchReady {
  readonly kind: 'ready'
  /** Every application the host runs, in registration order. */
  readonly apps: readonly AppInfo[]
}

/** One application's data changed; readers of that application should re-read it. */
export interface WatchChanged {
  readonly kind: 'changed'
  /** The application that changed. */
  readonly appId: string
}

/** Updated application rows after registration, a status change or removal. */
export interface WatchLifecycle {
  readonly kind: 'lifecycle'
  readonly appId: string
  readonly apps: readonly AppInfo[]
}

/** One operation reported progress, bound to the call that reported it. */
export interface WatchProgress {
  readonly kind: 'progress'
  /** The runtime's own notice (application, op, call id, message, data). */
  readonly notice: ProgressNotice
}

/** One confirmation appeared for a human to answer. */
export interface WatchConfirmationAsked {
  readonly kind: 'confirmation'
  readonly action: 'asked'
  /** The pending question, the same record `pendingConfirmations` answers. */
  readonly request: PendingConfirmation
}

/** The unified store's current facts for one application (the data page). */
export interface AppDataInfo {
  readonly appId: string
  /** The database path, or `:memory:` when this deployment has no durable store. */
  readonly path: string
  /** Current database file size (the main file only), when it has a file. */
  readonly byteSize?: number
  /** Current SQLite WAL size, when a WAL file exists. */
  readonly walByteSize?: number
  /** Main file + WAL; the size a human should compare against disk. */
  readonly totalByteSize?: number
  /** The highest document schema version this application currently holds (0 when empty). */
  readonly schemaVersion: number
  /** The number of named document scopes. */
  readonly documentCount: number
  /** Row counts by collection name. */
  readonly collections: Readonly<Record<string, number>>
  /** The most recent pre-import database snapshots (the whole database, not one app). */
  readonly backups: readonly AppDataBackup[]
  /** Every pre-import snapshot beside this database (including those beyond the recent five). */
  readonly backupCount: number
}

/** One pre-import database snapshot discovered beside the unified store. */
export interface AppDataBackup {
  /** The full path of the snapshot (the whole app-data database). */
  readonly path: string
  readonly byteSize: number
  /** File modification time, epoch ms. */
  readonly modifiedAt: number
}

/** One application's JSON export, ready for a browser download. */
export interface AppDataExport {
  readonly fileName: string
  readonly json: string
}

/** The dry-run answer for one application JSON import. */
export interface AppDataImportPreview {
  readonly appId: string
  /** How many apps the filtered import would touch (0 or 1). */
  readonly apps: number
  /** How many documents / collection items the import file names. */
  readonly documents: number
  readonly collections: number
  /** Documents the merge would create / overwrite; merge never deletes. */
  readonly newDocuments: number
  readonly overwrittenDocuments: number
  readonly removedDocuments: number
  /** Collection items the merge would create / overwrite; merge never deletes. */
  readonly newCollectionItems: number
  readonly overwrittenCollectionItems: number
  readonly removedCollectionItems: number
  /** Short-lived plan token; the import commit must present it. */
  readonly planId: string
  /** Epoch ms after which the plan is refused. */
  readonly expiresAt: number
}

/** The committed import's answer, including the pre-import backup. */
export interface AppDataImportResult extends Omit<AppDataImportPreview, 'planId' | 'expiresAt'> {
  /** The consistent database snapshot taken before the write. */
  readonly backupPath: string
  /**
   * Whether the running application re-read the imported document. `skipped`
   * means it was not running (stopped/failed); its next start reads the data.
   */
  readonly reload: 'ok' | 'failed' | 'skipped'
  /** The reload failure, when `reload` is `failed`; the import is still committed. */
  readonly reloadError?: string
}

/** One document/collection difference between the current app and a backup. */
export interface AppDataRestoreConflict {
  readonly kind: 'document' | 'collection'
  /** Document scope, or collection name. */
  readonly name: string
  /** Collection row key; absent for documents. */
  readonly key?: string
  readonly currentUpdatedAt?: number
  readonly backupUpdatedAt?: number
}

/** The dry-run answer for restoring one application from a whole-database backup. */
export interface AppDataRestorePreview {
  readonly appId: string
  readonly backupPath: string
  readonly backupModifiedAt: number
  readonly backupByteSize: number
  readonly documents: {
    /** In the backup, absent now: the restore adds them. */
    readonly backupOnly: number
    /** Present now, absent in the backup: the restore deletes them. */
    readonly currentOnly: number
    /** Present in both with different values: the restore overwrites them. */
    readonly modified: number
    readonly unchanged: number
  }
  readonly collections: {
    readonly backupOnly: number
    readonly currentOnly: number
    readonly modified: number
    readonly unchanged: number
  }
  /** Current-only and modified rows, bounded for display. */
  readonly conflicts: readonly AppDataRestoreConflict[]
  readonly conflictCount: number
  readonly truncated: boolean
  /** Metadata keys whose values differ (legacy markers etc.). */
  readonly metaChanged: readonly string[]
  /** One-shot optimistic guard: the restore rejects if this no longer matches. */
  readonly previewFingerprint: string
  /** Short-lived plan token; the restore commit must present it. */
  readonly planId: string
  /** Epoch ms after which the plan is refused. */
  readonly expiresAt: number
}

/** The committed restore's answer. */
export interface AppDataRestoreResult {
  readonly appId: string
  /** The backup the user selected. */
  readonly restoredFrom: string
  /** The pre-restore whole-database backup. */
  readonly backupPath: string
  readonly documents: number
  readonly collections: number
  readonly reload: 'ok' | 'failed' | 'skipped'
  readonly reloadError?: string
}

/** The data page's backup-prune answer. */
export interface AppDataPruneResult {
  /** How many snapshot files were actually removed. */
  readonly removed: number
}

/** One pending confirmation ended: answered by a user, or cancelled with its call. */
export interface WatchConfirmationSettled {
  readonly kind: 'confirmation'
  readonly action: 'settled'
  /** The id of the confirmation that ended. */
  readonly id: string
  /** How it ended. */
  readonly outcome: ConfirmationOutcome
}

/** One task started, progressed, was asked to cancel, or settled. */
export interface WatchTask {
  readonly kind: 'task'
  readonly appId: string
  readonly task: TaskSnapshot
}

/** One host-to-client page command; the owner client executes and answers it. */
export interface PageCommand {
  readonly commandId: string
  readonly sessionId: string
  readonly action: 'open' | 'navigate' | 'set-filters' | 'select' | 'draft-read' | 'draft-update'
  readonly appId: string
  readonly view?: string
  readonly record?: { readonly kind: string; readonly id: string }
  readonly input?: JsonValue
}

/** One page command on the watch stream. */
export interface WatchPageCommand {
  readonly kind: 'page-command'
  readonly command: PageCommand
}

/** The visible page instance went away; the owner client drops page-scoped state. */
export interface WatchPageClosed {
  readonly kind: 'page-closed'
  readonly sessionId: string
  readonly pageId: string
}

/** One watch stream overflowed; the client re-reads all derived state and continues. */
export interface WatchReset {
  readonly kind: 'reset'
  readonly reason: 'slow-consumer'
}

/** One frame of the watch stream. */
export type WatchEvent =
  | WatchReady
  | WatchLifecycle
  | WatchReset
  | WatchChanged
  | WatchProgress
  | WatchTask
  | WatchPageCommand
  | WatchPageClosed
  | WatchConfirmationAsked
  | WatchConfirmationSettled
