/**
 * The browser's one door to the applications this host runs: the `applications`
 * Remote namespace over the application runtime.
 *
 * Everything here is a VIEW of `ctx.applications` — the runtime owns
 * registration, the one call path (identity, availability, declaration,
 * parameters, openness, grant or confirmation) and the lifecycle. The bridge
 * adds exactly what a browser needs and nothing else: the application rows,
 * the call path with a cancel handle, the basic history, grant management,
 * the confirmation channel (the caller's own AI session dialog when that
 * session has an open turn, otherwise the out-of-session table), application
 * stop, and one watch stream carrying change, progress and confirmation events.
 *
 * **The identity is fixed at this door.** Every call this surface makes is
 * `{ kind: 'human' }` — the browser IS the human's way in, and an identity is
 * never read from the request. AI and peer calls reach the same runtime through
 * their own entry points, never through here.
 *
 * **The confirmation channel is the bridge.** The runtime asks a
 * {@link ConfirmationPort} whenever a call needs the user's consent; with no
 * channel a `confirm` operation is refused. This bridge is that channel, with
 * two routes that both fail closed: a call made inside a running session turn
 * asks through the platform's User Approval service (the agent that is driving
 * the turn answers for its own session dialog), and everything else parks in
 * the browser table until a browser answers it (`answerConfirmation`). A full
 * table, an approval service that cannot deliver the question, and an answered
 * question that was withdrawn all report `unavailable` — a question nobody can
 * hold is a call nobody may run.
 * @module @matrix1001/dsh-application-harness-host-bridge
 */

import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { declaredCallOps, platformCapability } from '@matrix1001/dsh-application-harness-runtime'
import { SqliteDataStore } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import type { DataStoreExport } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import { GrantFileStore } from './grants.ts'
import { PolicyFileStore } from './policies.ts'
import { ActivationFileStore } from './activation.ts'
import { ModelSelectionStore } from './models.ts'
import { ModelUsageStore, type ModelUsageRecord } from './usage.ts'
import { ModelLimitGate, ModelLimitStore } from './limits.ts'
import { readVersionedJson, writeVersionedJson } from './platform-files.ts'
import { FileHistory } from './history.ts'
import { FileTasks } from './tasks.ts'
import { OnboardingFileStore } from './onboarding.ts'
import { AppSecretStore } from './secrets.ts'
import { eventCapability } from '@matrix1001/dsh-application-harness-runtime'
import type {
  ApplicationRuntime, AppDeclaration, AppRegistration, ConfirmationAnswer, ConfirmationPort, ConfirmationRequest, ObjectRef, ObjectResolution, OperationPolicy, OperationPolicyEntry, RuntimeState,
} from '@matrix1001/dsh-application-harness-runtime'
// The in-session confirmation route asks the platform's User Approval service
// for the agent that is driving the current turn, so these three type-only
// imports are the seams it resolves through (`ctx.approval`, `ctx.agents`) and
// the session vocabulary its turn check speaks. Absent at runtime in a
// composition without them, which the route tolerates by falling back to the
// browser table.
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
// The wire vocabulary is taken from `./types` — the browser-facing declarations
// this package owns. The runtime's own vocabulary is re-exported there where it
// is already a wire type, and mirrored where the runtime keeps it out of its
// public type subpath (`CallOutcome`, `HistoryRecord`) or where it is not a
// wire type at all (`JsonValue`).
import type {
  AppDataBackup, AppDataExport, AppDataImportPreview, AppDataImportResult, AppDataInfo, AppDataPruneResult, AppDataRestoreConflict, AppDataRestorePreview, AppDataRestoreResult, AppInfo, AppStatus, CallOutcome, Caller, CapabilityGrant, ConfirmationDecision, ConfirmationOutcome,
  AppCredentialStatus, HistoryRecord, JsonValue, ModelCatalog, ModelLimits, ModelUsageSummary, OnboardingState, PendingConfirmation, TaskCancelResult, TaskSnapshot, WatchEvent,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The bridge's own row. Optional on purpose: a composition may mount the
     * runtime without a browser face (the keyless examples do), and the wire
     * surface is only there when this row is.
     */
    applicationBridge?: ApplicationBridge
  }
}

/** How many confirmations may wait for a human answer at once. */
/** How long a page command waits for its owner client before failing closed. */
const PAGE_COMMAND_TIMEOUT_MS = 5_000

export const CONFIRMATION_CAPACITY = 32

/** How many frames one watch stream may buffer before it asks the client to resync. */
export const WATCH_QUEUE_CAPACITY = 256

/** The `app-bridge` row's config. */
export interface Config {
  /**
   * Where the durable grant table lives. Absent = the harness home's
   * `application-harness/grants.json` (the same `dshHomePath` convention as the
   * application store), so the row mounts with no config at all and approvals
   * still survive a restart. A deployment that wants another location names it
   * here.
   */
  grantsPath?: string
  /** Where the operation policy table lives; absent = the harness home. */
  policiesPath?: string
  /** Where the disabled-application set lives; absent = the harness home. */
  activationPath?: string
  /** Where the current development-session binding lives; absent = the harness home. */
  developmentPath?: string
  /** Where the per-application fixed model routes live; absent = the harness home. */
  modelSelectionsPath?: string
  /** Where the per-application model usage aggregates live; absent = the harness home. */
  modelUsagePath?: string
  /** Where the per-application model limits live; absent = the harness home. */
  modelLimitsPath?: string
  /**
   * Where the first-run onboarding record lives. Absent = the harness home's
   * `application-harness/onboarding.json`. This is a notification record (which card the
   * human already answered), never authorization: the grants stay in
   * `grants.json`.
   */
  onboardingPath?: string
  /**
   * Where the durable call history lives. Absent = the harness home's
   * `application-harness/history.jsonl`. The bridge owns the file and feeds the
   * runtime's history sink, so history survives a restart.
   */
  historyPath?: string
  /** Where the durable task projection lives. Absent = `application-harness/tasks.jsonl`. */
  tasksPath?: string
  /** Where declared application secrets live. Absent = `application-harness/secrets.json`. */
  secretsPath?: string
  /**
   * Where the application conversation's Session identity lives. Absent =
   * `application-harness/app-conversation.json`. The host marks this Session at boot and
   * after every explicit registration, so the full application tool surface is
   * independent of which browser entry opened the conversation.
   */
  conversationPath?: string
  /**
   * The unified store's database path. Absent = the harness home's
   * `application-harness/app-data.sqlite` (the same convention as the store row).
   */
  dataPath?: string
}

/**
 * One confirmation waiting for its answer: the record the browser reads, the
 * listener that ends it with its call, and the resolver the runtime awaits.
 */
interface PendingConfirmationEntry {
  readonly request: PendingConfirmation
  /** The runtime's own cancellation signal for the waiting call. */
  readonly signal: AbortSignal
  /** Ends this entry when the signal aborts; removed again when it settles. */
  readonly abort: () => void
  readonly settle: (answer: ConfirmationAnswer) => void
}

/** How long an import/restore preview plan stays committable. */
const DATA_PLAN_TTL_MS = 5 * 60 * 1000
/** Bound the plan table; an old preview is cheap to recreate. */
const DATA_PLAN_LIMIT = 50

type DataPlanKind = 'import' | 'restore'
type DataPlanResult = AppDataImportResult | AppDataRestoreResult

interface DataPlanEntry {
  readonly id: string
  readonly kind: DataPlanKind
  readonly appId: string
  readonly payload: { readonly json?: string; readonly backupPath?: string }
  /** Fingerprint the preview was computed from; the commit refuses a changed base. */
  readonly baseRevision: string
  readonly preview: AppDataImportPreview | AppDataRestorePreview
  readonly expiresAt: number
  used: boolean
  /** requestId → result, so a retry returns the first committed answer. */
  readonly results: Map<string, DataPlanResult>
}

/**
 * The host application surface. One instance per host; it mounts only with an
 * application runtime (`ctx.applications`), and unmounting it stops every
 * application and closes every watch stream.
 */
export class ApplicationBridge extends TypertRemoteService {
  /**
   * The runtime is the only thing this surface views; without it there is
   * nothing to expose, so the row does not mount at all.
   */
  static inject = ['applications']

  /** The row config schema: validated before the plugin starts (fail loud). */
  static Config = Schema.object({ grantsPath: Schema.string(), policiesPath: Schema.string(), activationPath: Schema.string(), developmentPath: Schema.string(), onboardingPath: Schema.string(), historyPath: Schema.string(), tasksPath: Schema.string(), secretsPath: Schema.string(), dataPath: Schema.string(), conversationPath: Schema.string(), modelSelectionsPath: Schema.string(), modelUsagePath: Schema.string(), modelLimitsPath: Schema.string() })

  private readonly runtime: ApplicationRuntime
  /** The host-side first-run record (fail-open reads, atomic serialized writes). */
  private readonly onboardingStore: OnboardingFileStore
  /** Per-application fixed model routes (absent = follow the platform default). */
  /** The host-only secret store behind the credential projection. */
  private readonly secretStore: AppSecretStore
  private readonly secretsReady: Promise<void>
  private readonly modelSelections: ModelSelectionStore
  /** Per-application model usage aggregates (telemetry, fail-open). */
  private readonly modelUsageStore: ModelUsageStore
  private readonly modelLimitsStore: ModelLimitStore
  private readonly modelLimitGate = new ModelLimitGate()
  /** The durable call history (JSONL, best-effort, loaded before `history()` answers). */
  private readonly historyFile: FileHistory
  /** The durable background-task projection (JSONL, control plane only). */
  private readonly taskFile: FileTasks
  /** The unified application store this data page reads and exports. */
  private readonly dataPath: string
  /** The durable application-conversation Session identity (host-owned, not a browser preference). */
  private readonly conversationPath: string
  /** The scoped tool bridge, when the row is mounted; registration marks its Session. */
  private appTools: {
    mark(sessionId: string): void
    unmark?(sessionId: string): void
    has?(sessionId: string): boolean
    markDevelopment?(sessionId: string, appId: string): void
  } | undefined
  /** The persisted application-conversation Session, when one exists. */
  private conversationSessionId: string | undefined
  /** The one startup read; explicit registration awaits it before writing. */
  private readonly conversationReady: Promise<void>
  /** The durable disabled-application set and its startup read. */
  private readonly activationFile: ActivationFileStore
  private readonly activationReady: Promise<void>
  private readonly modelSelectionsReady: Promise<void>
  private readonly modelUsageReady: Promise<void>
  private readonly modelLimitsReady: Promise<void>
  private readonly disabledApps = new Set<string>()
  /** Page commands waiting for an owner client answer. */
  /** Page id → owner Session, and the user-shared draft metadata. */
  private readonly pageOwners = new Map<string, string>()
  private readonly draftShares = new Map<string, { readonly sessionId: string; readonly pageId: string; readonly draftId: string; readonly fields?: readonly string[] }>()
  private readonly pageCommands = new Map<string, { readonly pageId?: string; readonly resolve: (accepted: boolean, error?: string, result?: JsonValue) => void; readonly timer: ReturnType<typeof setTimeout> }>()
  /** The durable development-session binding (one at a time). */
  private readonly developmentPath: string
  private readonly developmentReady: Promise<void>
  private developmentSessionId: string | undefined
  private developmentAppId: string | undefined
  /** Page-instance and snapshot ids, assigned by the host, never by the page. */
  private pageSerial = 0
  private snapshotSerial = 0
  private readonly pageIds = new Map<string, string>()
  /** Applications whose activation this bridge is changing right now. */
  private readonly changingActivation = new Set<string>()
  /**
   * In-flight cancellable calls, keyed by the id their caller named them with
   * (`requestId`): the runtime mints its own call id internally and only hands
   * it over with the outcome, so the caller's id is the only name a call can be
   * cancelled by while it runs. A set, not one controller: two calls may name
   * the same id (a caller bug, but one that must not silently overwrite the
   * first controller and make it uncancellable), and each entry is removed only
   * by its OWN call, so a fast call cannot erase a slow one's handle.
   */
  private readonly inFlight = new Map<string, Set<AbortController>>()
  /** Confirmations asked but not yet answered, in ask order. */
  private readonly confirmations = new Map<string, PendingConfirmationEntry>()
  /** Live watch streams; each gets every event from the moment it opens. */
  private readonly watchers = new Set<WatchQueue>()
  /**
   * The import queue: one import (backup, write, reload) at a time across the
   * whole database. Two imports must not take overlapping snapshots or
   * interleave their maintenance holds.
   */
  private importChain: Promise<unknown> = Promise.resolve()
  private serial = 0
  /** Short-lived import/restore preview plans, keyed by plan id. */
  private readonly dataPlans = new Map<string, DataPlanEntry>()

  /**
   * Mount the surface: take the runtime, become its confirmation channel, and
   * tie the subscriptions and the teardown to this row's fiber.
   * @param ctx - the owning context (with the runtime injected).
   * @param _config - the validated row config (no tunables).
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'applicationBridge', { namespace: 'applications' })
    const runtime = ctx.applications
    if (runtime === undefined) throw new Error('the host bridge requires the application runtime (ctx.applications)')
    this.runtime = runtime
    // The durable grant table (D6): without one the runtime's grants live for
    // this process only, so a product path that produced an approval ("allow
    // and remember" below, or the `grant` face) could never survive a restart.
    // The bridge owns it because the grants are the host's authorization
    // record, next to the application store under the harness home.
    runtime.useGrantStore(new GrantFileStore(config.grantsPath ?? dshHomePath('application-harness/grants.json')))
    runtime.usePolicyStore(new PolicyFileStore(config.policiesPath ?? dshHomePath('application-harness/policies.json')))
    const secrets = new AppSecretStore(config.secretsPath ?? dshHomePath('application-harness/secrets.json'))
    this.secretStore = secrets
    const secretsReady = secrets.load()
    this.secretsReady = secretsReady
    runtime.useSecretStore({
      names: async (appId) => { await secretsReady; return secrets.names(appId) },
      has: async (appId, name) => { await secretsReady; return secrets.has(appId, name) },
      get: async (appId, name) => { await secretsReady; return secrets.get(appId, name) },
      set: async (appId, name, value) => { await secretsReady; await secrets.set(appId, name, value) },
      delete: async (appId, name) => { await secretsReady; return await secrets.delete(appId, name) },
    })
    this.onboardingStore = new OnboardingFileStore(
      config.onboardingPath ?? dshHomePath('application-harness/onboarding.json'),
      (problem) => { this.ctx.logger.warn(problem) },
    )
    // Load in the background: a corrupt record is reported once and treated as
    // empty; the card's own read awaits the same record.
    void this.onboardingStore.load()
    // Durable call history (SPEC §3.3.2): the runtime's sink is the file-backed
    // queue; `history()` awaits its startup load so a reload never shows an
    // empty list while the file is still being read.
    this.dataPath = config.dataPath ?? dshHomePath('application-harness/app-data.sqlite')
    /* v8 ignore next -- deployment always supplies conversationPath; this is a boot fallback */
    this.conversationPath = config.conversationPath ?? dshHomePath('application-harness/app-conversation.json')
    this.conversationReady = this.loadAppConversation()
    this.activationFile = new ActivationFileStore(config.activationPath ?? dshHomePath('application-harness/activation.json'))
    this.activationReady = this.loadActivation()
    this.modelSelections = new ModelSelectionStore(config.modelSelectionsPath ?? dshHomePath('application-harness/model-selections.json'))
    this.modelSelectionsReady = this.modelSelections.load()
    const modelUsagePath = config.modelUsagePath ?? dshHomePath('application-harness/model-usage.json')
    this.modelUsageStore = new ModelUsageStore(modelUsagePath)
    this.modelUsageReady = this.modelUsageStore.load().catch((error: unknown) => {
      this.ctx.logger.warn(`model usage ${modelUsagePath} could not be read: ${String(error)}`)
    })
    const modelLimitsPath = config.modelLimitsPath ?? dshHomePath('application-harness/model-limits.json')
    this.modelLimitsStore = new ModelLimitStore(modelLimitsPath)
    this.modelLimitsReady = this.modelLimitsStore.load().catch((error: unknown) => {
      this.ctx.logger.warn(`model limits ${modelLimitsPath} could not be read: ${String(error)}`)
    })
    this.developmentPath = config.developmentPath ?? dshHomePath('application-harness/development.json')
    this.developmentReady = this.loadDevelopment()
    ctx.provide('appDrafts', {
      read: async (sessionId: string, input: { readonly pageId: string; readonly draftId: string; readonly fields?: readonly string[] }) => await this.readDraft(sessionId, input),
      update: async (sessionId: string, input: { readonly pageId: string; readonly draftId: string; readonly revision: string; readonly values: JsonValue }) => await this.updateDraft(sessionId, input),
    } as never)
    ctx.provide('appPages', {
      open: async (sessionId: string, input: { readonly view?: string; readonly record?: { readonly kind: string; readonly id: string } }) => await this.openPage(sessionId, input),
      act: async (sessionId: string, input: { readonly pageId: string; readonly snapshotId: string; readonly action: 'navigate' | 'set-filters' | 'select'; readonly input?: unknown }) => await this.actPage(sessionId, input),
    } as never)
    ctx.provide('applicationModelSettings', {
      selection: (appId: string) => this.modelSelections.get(appId),
    } as never)
    ctx.provide('applicationModelLimits', {
      get: async (appId: string) => { await this.modelLimitsReady; return this.modelLimitsStore.get(appId) },
      begin: async (appId: string, background: boolean) => {
        await this.modelLimitsReady
        return this.modelLimitGate.begin(appId, background, this.modelLimitsStore.get(appId))
      },
    } as never)
    ctx.provide('applicationModelUsage', {
      record: async (appId: string, record: ModelUsageRecord) => {
        await this.modelUsageReady
        try {
          await this.modelUsageStore.record(appId, record)
        } catch (error) {
          this.ctx.logger.warn(`model usage for ${appId} could not be saved: ${String(error)}`)
        }
      },
    } as never)
    ctx.inject(['appTools'], (scope) => {
      this.appTools = scope.get('appTools') as {
        mark(sessionId: string): void
        unmark?(sessionId: string): void
        has?(sessionId: string): boolean
        markDevelopment?(sessionId: string, appId: string): void
      } | undefined
      // A development binding restored from disk may have loaded before the
      // appTools injection existed; mark it now that the tools face is here.
      void this.developmentReady.then(() => {
        if (this.developmentSessionId !== undefined && this.developmentAppId !== undefined) {
          this.appTools?.markDevelopment?.(this.developmentSessionId, this.developmentAppId)
        }
      })
      if (this.appTools !== undefined && this.conversationSessionId !== undefined) {
        this.appTools.mark(this.conversationSessionId)
      }
      void this.developmentReady.then(() => {
        if (this.appTools !== undefined && this.developmentSessionId !== undefined && this.developmentAppId !== undefined) {
          this.appTools.markDevelopment?.(this.developmentSessionId, this.developmentAppId)
        }
      })
      return () => { this.appTools = undefined }
    })
    this.historyFile = new FileHistory(
      config.historyPath ?? dshHomePath('application-harness/history.jsonl'),
      /* v8 ignore next -- corrupt-file logging fallback; the parser and data paths are covered separately */
      (problem) => { this.ctx.logger.warn(problem) },
    )
    this.taskFile = new FileTasks(
      config.tasksPath ?? dshHomePath('application-harness/tasks.jsonl'),
      /* v8 ignore next -- corrupt-file logging fallback; the parser and data paths are covered separately */
      (problem) => { this.ctx.logger.warn(problem) },
    )
    runtime.useHistory(this.historyFile)
    runtime.useConfirmation({ ask: (request) => this.ask(request) })
    ctx.effect(() => runtime.onChange((notice) => { this.broadcast({ kind: 'changed', appId: notice.appId }) }), 'host bridge: application change notices')
    ctx.effect(() => runtime.onLifecycle(({ appId }) => { void this.applyActivation(appId); this.broadcast({ kind: 'lifecycle', appId, apps: this.rows() }) }), 'host bridge: application lifecycle')
    ctx.effect(() => runtime.onProgress((notice) => { this.broadcast({ kind: 'progress', notice }) }), 'host bridge: application progress')
    ctx.effect(() => runtime.onTask((notice) => {
      this.taskFile.record(notice.task as TaskSnapshot)
      this.broadcast({ kind: 'task', appId: notice.appId, task: notice.task as TaskSnapshot })
    }), 'host bridge: application tasks')
    ctx.effect(() => () => this.shutdown(), 'host bridge: stop every application and close the watch streams')
  }

  // ---- the application rows -------------------------------------------------

  /**
   * Every application this host runs, in registration order: identity, status
   * (with the start failure when it failed), and each operation's description,
   * declared parameters and openness. A failed application stays visible — it
   * is a state to show, not one to hide.
   * @returns one row per application.
   */
  @Remote
  list(): readonly AppInfo[] {
    return this.rows()
  }

  // ---- the application data ---------------------------------------------------

  /**
   * Resolve one application's unified-store namespace. The store keys rows by
   * the declared namespace, not by the application id (`workspace-review`
   * declares `review`); using the id here would silently read an empty
   * namespace. Non-unified storage is refused at the data-management boundary.
   * @param appId - the registered application.
   * @returns the declared namespace (falling back to the id for old registrations).
   */
  private unifiedNamespace(appId: string): string {
    const declared = this.runtime.list().find(entry => entry.declaration.id === appId)?.declaration.data
    if (declared === undefined) return appId
    if (declared.kind !== 'unified') {
      throw new Error(`application ${appId} declares ${declared.kind} data; only unified namespaces use this operation`)
    }
    /* v8 ignore next -- a declarable unified declaration always carries a namespace */
    return declared.namespace ?? appId
  }

  /**
   * The unified store's facts for ONE application. Reading a database that does
   * not exist never creates it: an absent file is an empty application, not a
   * reason to write.
   * @param appId - the application whose namespace is reported.
   * @returns path, size, schema version and collection counts.
   */
  @Remote
  dataInfo(appId: string): AppDataInfo {
    const declared = this.runtime.list().find(entry => entry.declaration.id === appId)?.declaration.data
    if (declared?.kind === 'own-sqlite' && declared.path !== undefined) {
      const path = join(dirname(this.dataPath), declared.path)
      let byteSize: number | undefined
      /* v8 ignore next -- an absent files path still reports its declared path */
      try { byteSize = statSync(path).size } catch { byteSize = undefined }
      return {
        appId,
        path,
        /* v8 ignore next -- absent file fallback; both sides are exercised in data.spec */
        ...(byteSize === undefined ? {} : { byteSize }),
        /* v8 ignore next -- declarable own-sqlite data requires schemaVersion */
        /* v8 ignore next -- a declarable files declaration always carries schemaVersion */
        schemaVersion: declared.schemaVersion ?? 0,
        documentCount: 0,
        collections: {},
        backups: [],
        backupCount: 0,
        legacyImports: {},
      }
    }
    if (declared !== undefined && declared.kind !== 'unified') {
      /* v8 ignore next -- a declarable files declaration always carries a path */
      const path = declared.path === undefined ? this.dataPath : join(dirname(this.dataPath), declared.path)
      let byteSize: number | undefined
      /* v8 ignore next -- an absent files path still reports its declared path */
      try { byteSize = statSync(path).size } catch { byteSize = undefined }
      return {
        appId,
        path,
        /* v8 ignore next -- absent file fallback; both sides are exercised in data.spec */
        ...(byteSize === undefined ? {} : { byteSize }),
        /* v8 ignore next -- a declarable files declaration always carries schemaVersion */
        schemaVersion: declared.schemaVersion ?? 0,
        documentCount: 0,
        collections: {},
        backups: [],
        backupCount: 0,
        legacyImports: {},
      }
    }
    const namespace = this.unifiedNamespace(appId)
    const { backups, backupCount } = this.dataBackups()
    if (!existsSync(this.dataPath)) {
      return { appId, path: this.dataPath, byteSize: 0, schemaVersion: 0, documentCount: 0, collections: {}, backups, backupCount, legacyImports: {} }
    }
    const store = new SqliteDataStore({ dbPath: this.dataPath })
    try {
      const app = store.exportAll().apps[namespace]
      const documents = app?.documents ?? {}
      const appCollections = (app?.collections ?? {}) as Record<string, unknown[]>
      const collections = Object.fromEntries(Object.entries(appCollections).map(([name, rows]) => [name, rows.length]))
      const docRecords = documents as Record<string, { schemaVersion: number }>
      const schemaVersion = Object.values(docRecords).reduce((max, doc) => Math.max(max, doc.schemaVersion), 0)
      const byteSize = store.byteSize()
      const legacyImports = Object.fromEntries(
        Object.entries(app?.meta ?? {}).filter(([key]) => key.startsWith('legacy-')).sort(([a], [b]) => a.localeCompare(b)),
      )
      return {
        appId,
        path: this.dataPath,
        /* v8 ignore next -- an on-disk database always has a file size */
        /* v8 ignore next -- absent file fallback; both sides are exercised in data.spec */
        ...(byteSize === undefined ? {} : { byteSize }),
        schemaVersion,
        documentCount: Object.keys(documents).length,
        collections,
        backups,
        backupCount,
        legacyImports,
      }
    } finally {
      store.close()
    }
  }

  /**
   * The pre-import snapshots beside the unified database, newest first. A
   * snapshot is the WHOLE application-data database (the import path filters
   * one namespace, but the backup is consistent for every app), so the page
   * labels it accordingly and restores only one app at a time.
   * @returns the five newest snapshots and the total count.
   */
  private dataBackups(): { backups: AppDataBackup[]; backupCount: number } {
    const snapshots = this.backupSnapshots()
    return { backups: snapshots.slice(0, 5), backupCount: snapshots.length }
  }

  /** Every pre-import snapshot beside the database, newest first. */
  private backupSnapshots(): AppDataBackup[] {
    if (this.dataPath === ':memory:') return []
    const directory = dirname(this.dataPath)
    if (!existsSync(directory)) return []
    const prefix = `${basename(this.dataPath)}.before-import-`
    return readdirSync(directory).filter(name => name.startsWith(prefix)).flatMap((name) => {
      const path = join(directory, name)
      try {
        const stat = statSync(path)
        if (!stat.isFile()) return []
        return [{ path, byteSize: stat.size, modifiedAt: stat.mtimeMs }]
      } catch {
        return []
      }
    }).sort((a, b) => b.modifiedAt - a.modifiedAt)
  }

  /**
   * Delete the oldest pre-import snapshots beyond the newest `keep`. This is the
   * explicit maintenance action behind the data page's second-confirm button;
   * one unreadable/deletable file is reported and skipped, never silently
   * counted as removed.
   * @param keep - how many newest whole-database snapshots to keep.
   * @returns how many files were actually removed.
   */
  /** Keep a small automatic rollback window after a successful import/restore. */
  private async pruneBackupsAfterCommit(): Promise<void> {
    try {
      await this.dataPruneBackups(5)
    } catch (error) {
      /* v8 ignore next -- a failed housekeeping unlink is logged; it must not fail the committed import */
      this.ctx.logger.warn(`application-data backup cleanup failed: ${String((error as Error)?.message ?? error)}`)
    }
  }

  @Remote
  async dataPruneBackups(keep: number): Promise<AppDataPruneResult> {
    if (!Number.isInteger(keep) || keep < 1) throw new Error('the backup retention count must be a positive integer')
    let removed = 0
    for (const snapshot of this.backupSnapshots().slice(keep)) {
      try {
        unlinkSync(snapshot.path)
        removed += 1
      } catch (error) {
        /* v8 ignore next -- fs removals throw Errors; the stringified fallback is defensive */
        this.ctx.logger.warn(`application-data backup could not be removed ${snapshot.path}: ${String((error as Error)?.message ?? error)}`)
      }
    }
    return { removed }
  }

  /**
   * Export ONE application's namespace as a JSON dump. A missing namespace is
   * an empty export, not a path to another application's rows.
   * @param appId - the application to export.
   * @returns the suggested file name and the JSON text.
   */
  @Remote
  dataExport(appId: string): AppDataExport {
    const declared = this.runtime.list().find(entry => entry.declaration.id === appId)?.declaration.data
    if (declared !== undefined && declared.kind !== 'unified') {
      throw new Error(`application ${appId} declares ${declared.kind} data; only unified namespaces use this export`)
    }
    const namespace = this.unifiedNamespace(appId)
    const empty: DataStoreExport = { version: 1, exportedAt: Date.now(), apps: {} }
    if (!existsSync(this.dataPath)) {
      return { fileName: `application-harness-${appId}.json`, json: `${JSON.stringify(empty, null, 2)}\n` }
    }
    const store = new SqliteDataStore({ dbPath: this.dataPath })
    try {
      const dump = store.exportAll()
      const app = dump.apps[namespace]
      const filtered: DataStoreExport = { version: 1, exportedAt: dump.exportedAt, apps: app === undefined ? {} : { [namespace]: app } }
      return { fileName: `application-harness-${appId}.json`, json: `${JSON.stringify(filtered, null, 2)}\n` }
    } finally {
      store.close()
    }
  }

  /**
   * Validate one application JSON import in memory. The dump is filtered to
   * `appId`, so a full-store export can never restore another application's
   * rows through this page.
   * @param appId - the application whose namespace the import would touch.
   * @param json - the exported JSON text.
   * @returns the row counts a real import would write.
   */
  @Remote
  dataImportPreview(appId: string, json: string): AppDataImportPreview {
    const namespace = this.unifiedNamespace(appId)
    const filtered = this.filterImport(appId, namespace, json)
    const memory = new SqliteDataStore({ dbPath: ':memory:' })
    try {
      const summary = memory.importAll(filtered, { mode: 'merge' })
      const current = this.currentAppData(namespace)
      const preview: AppDataImportPreview = {
        appId,
        apps: summary.apps,
        documents: summary.documents,
        collections: summary.collections,
        ...this.importDelta(current, filtered.apps[namespace]!),
      }
      return this.attachDataPlan('import', appId, { json }, this.planFingerprint(current, json), preview)
    } finally {
      memory.close()
    }
  }

  /**
   * Preview restoring ONE application from a whole-database backup. The backup
   * is copied aside and read through the store, so the snapshot itself is never
   * written; the live database is read for the diff only. Nothing is changed.
   * @param appId - the application to restore.
   * @param backupPath - a `.before-import-*` sibling of the live database.
   * @returns the exact-replace diff, bounded conflicts and a one-shot fingerprint.
   */
  @Remote
  dataRestorePreview(appId: string, backupPath: string): AppDataRestorePreview {
    const namespace = this.unifiedNamespace(appId)
    const plan = this.restorePlan(appId, namespace, backupPath)
    return this.attachDataPlan('restore', appId, { backupPath: plan.preview.backupPath }, plan.preview.previewFingerprint, plan.preview)
  }

  /**
   * Restore ONE application from a backup by exact namespace replacement. The
   * rest of the database is untouched; a pre-restore whole-database backup is
   * written first; a running application is held and reloaded like an import.
   * @param appId - the application to restore.
   * @param backupPath - a `.before-import-*` sibling of the live database.
   * @param previewFingerprint - the fingerprint returned by the preview; a
   *   changed current/backup pair is refused rather than silently overwriting.
   *   It is compared again after the application's in-flight work has drained,
   *   which is the write window a pre-drain check cannot see (DATA-001).
   * @returns the counts, pre-restore backup and reload outcome.
   */
  @Remote
  async dataRestore(appId: string, backupPath: string, previewFingerprint?: string, planId?: string, requestId?: string): Promise<AppDataRestoreResult> {
    return await this.serializedImport(async () => {
      const taken = planId === undefined ? undefined : this.takeDataPlan(planId, 'restore', appId, requestId)
      if (taken?.replay !== undefined) return taken.replay as AppDataRestoreResult
      if (taken !== undefined) {
        backupPath = taken.plan.payload.backupPath!
        previewFingerprint = taken.plan.baseRevision
      }
      const registration = this.runtime.list().find(entry => entry.declaration.id === appId)
      if (registration === undefined) throw new Error(`application ${appId} is not registered; an orphan namespace is not a restore target`)
      const status = registration.status()
      if (status === 'starting' || status === 'stopping' || status === 'stop-incomplete') {
        throw new Error(`application ${appId} is ${status}; wait until it is available or stopped before restoring`)
      }
      const namespace = this.unifiedNamespace(appId)
      const plan = this.restorePlan(appId, namespace, backupPath)
      if (previewFingerprint !== undefined && previewFingerprint !== plan.preview.previewFingerprint) {
        throw new Error(`application ${appId} changed since the restore preview; preview again`)
      }
      const lease = status === 'available' ? await this.runtime.beginMaintenance(appId) : undefined
      let result: Omit<AppDataRestoreResult, 'reload' | 'reloadError'>
      try {
        // Compare the baseline AGAIN inside the hold: the check above ran before
        // the drain, and a call that was already in flight can commit while
        // beginMaintenance waits for it. Replacing the namespace then would
        // overwrite more than the preview showed the user.
        const currentFingerprint = this.restoreFingerprint(plan.preview.backupPath, this.currentAppData(namespace), plan.backup)
        if (previewFingerprint !== undefined && currentFingerprint !== plan.preview.previewFingerprint) {
          throw new Error(`application ${appId} changed since the restore preview; preview again`)
        }
        const store = new SqliteDataStore({ dbPath: this.dataPath })
        try {
          const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
          const backup = store.backupTo(`${this.dataPath}.before-import-${stamp}`)
          const counts = store.replaceNamespace(namespace, plan.backup)
          result = {
            appId,
            restoredFrom: plan.preview.backupPath,
            backupPath: backup,
            documents: counts.documents,
            collections: counts.collections,
          }
        } finally {
          store.close()
        }
      } catch (error) {
        if (lease !== undefined) await lease.release()
        throw error
      }
      let reload: AppDataRestoreResult['reload'] = lease === undefined ? 'skipped' : 'ok'
      let reloadError: string | undefined
      if (lease !== undefined) {
        try {
          await this.runtime.reload(appId)
          await lease.release()
        } catch (error) {
          reload = 'failed'
          reloadError = String((error as Error)?.message ?? error)
        }
      }
      const committed = { ...result, reload, ...(reloadError === undefined ? {} : { reloadError }) }
      this.broadcast({ kind: 'changed', appId })
      if (taken !== undefined) this.completeDataPlan(taken.plan, requestId!, committed)
      await this.pruneBackupsAfterCommit()
      return committed
    })
  }

  /** Drop a preview plan explicitly (the data page's cancel path). */
  @Remote
  discardDataPlan(planId: string): boolean {
    return this.dataPlans.delete(planId)
  }

  /** Store a plan and attach its token to the preview. */
  private attachDataPlan<T extends AppDataImportPreview | AppDataRestorePreview>(
    kind: DataPlanKind,
    appId: string,
    payload: DataPlanEntry['payload'],
    baseRevision: string,
    preview: T,
  ): T {
    this.pruneDataPlans()
    const id = `plan_${randomUUID()}`
    const expiresAt = Date.now() + DATA_PLAN_TTL_MS
    this.dataPlans.set(id, {
      id, kind, appId, payload, baseRevision, preview, expiresAt, used: false, results: new Map(),
    })
    while (this.dataPlans.size > DATA_PLAN_LIMIT) {
      const oldest = this.dataPlans.keys().next().value
      /* v8 ignore next -- a non-empty map always yields a key */
      if (oldest === undefined) break
      this.dataPlans.delete(oldest)
    }
    return { ...preview, planId: id, expiresAt } as T
  }

  /** Take a committable plan, or replay the result of the same requestId. */
  private takeDataPlan(
    planId: string,
    kind: DataPlanKind,
    appId: string,
    requestId: string | undefined,
  ): { plan: DataPlanEntry; replay?: DataPlanResult } {
    this.pruneDataPlans()
    const plan = this.dataPlans.get(planId)
    if (plan === undefined) throw new Error('the data plan is missing or expired; preview again')
    if (plan.kind !== kind || plan.appId !== appId) throw new Error('the data plan belongs to a different application or operation')
    if (requestId === undefined) throw new Error('committing a data plan requires a request id')
    if (plan.used) {
      const result = plan.results.get(requestId)
      if (result !== undefined) return { plan, replay: result }
      throw new Error('the data plan was already committed with a different request id; preview again')
    }
    return { plan }
  }

  /** Record a committed plan's result for idempotent retries. */
  private completeDataPlan(plan: DataPlanEntry, requestId: string, result: DataPlanResult): void {
    plan.used = true
    plan.results.set(requestId, result)
  }

  /** Drop expired plans; called before using/creating one. */
  private pruneDataPlans(): void {
    const now = Date.now()
    for (const [id, plan] of this.dataPlans) if (now > plan.expiresAt) this.dataPlans.delete(id)
  }

  /** The import plan's base: current namespace plus the submitted JSON. */
  private planFingerprint(current: DataStoreExport['apps'][string] | undefined, json: string): string {
    return createHash('sha256').update(JSON.stringify({ current: current ?? null, json })).digest('hex')
  }

  /** Refuse a commit whose base changed after the preview. */
  private assertImportPlan(plan: DataPlanEntry): void {
    const base = this.planFingerprint(this.currentAppData(this.unifiedNamespace(plan.appId)), plan.payload.json!)
    if (base !== plan.baseRevision) throw new Error('the application data changed since the import preview; preview again')
  }

  /** Read a backup into an app namespace and build the exact-replace preview. */
  private restorePlan(appId: string, namespace: string, backupPath: string): { preview: AppDataRestorePreview; backup: DataStoreExport['apps'][string] } {
    const validated = this.validatedBackupPath(backupPath)
    const backupStat = statSync(validated)
    const backup = this.readBackupApp(validated, namespace, appId)
    const current = this.currentAppData(namespace)
    const preview = this.restorePreview(appId, validated, backupStat, current, backup)
    return { preview, backup }
  }

  /** Validate that a path is one of this database's whole-DB snapshots. */
  private validatedBackupPath(path: string): string {
    if (this.dataPath === ':memory:') throw new Error('an in-memory database has no backup to restore')
    if (typeof path !== 'string' || path === '') throw new Error('the restore backup path is required')
    if (lstatSync(path).isSymbolicLink()) throw new Error('a symlink is not a restore backup')
    const directory = realpathSync(dirname(this.dataPath))
    const candidate = realpathSync(path)
    if (dirname(candidate) !== directory) throw new Error('the restore backup must be beside the application database')
    if (existsSync(this.dataPath) && realpathSync(this.dataPath) === candidate) throw new Error('the live database is not a restore backup')
    if (!basename(candidate).startsWith(`${basename(this.dataPath)}.before-import-`)) {
      throw new Error('the restore source is not a pre-import backup of this database')
    }
    if (!statSync(candidate).isFile()) throw new Error('the restore backup is not a regular file')
    return candidate
  }

  /** Read one app's namespace out of a backup through a temporary copy. */
  private readBackupApp(path: string, namespace: string, appId: string = namespace): DataStoreExport['apps'][string] {
    const temporary = mkdtempSync(`${tmpdir()}/application-harness-restore-`)
    const copy = join(temporary, 'backup.sqlite')
    try {
      copyFileSync(path, copy)
      const store = new SqliteDataStore({ dbPath: copy })
      try {
        const app = store.exportAll().apps[namespace]
        if (app === undefined) throw new Error(`the backup has no data for ${appId}`)
        return app
      } finally {
        store.close()
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  /** One-shot fingerprint over the live namespace, backup namespace and path. */
  private restoreFingerprint(path: string, current: DataStoreExport['apps'][string] | undefined, backup: DataStoreExport['apps'][string]): string {
    return createHash('sha256').update(JSON.stringify({ path, current: current ?? null, backup })).digest('hex')
  }

  /** The exact-replace diff used by the preview and by the restore's fingerprint guard. */
  private restorePreview(
    appId: string,
    backupPath: string,
    backupStat: { size: number; mtimeMs: number },
    current: DataStoreExport['apps'][string] | undefined,
    backup: DataStoreExport['apps'][string],
  ): AppDataRestorePreview {
    const documents = { backupOnly: 0, currentOnly: 0, modified: 0, unchanged: 0 }
    const collections = { backupOnly: 0, currentOnly: 0, modified: 0, unchanged: 0 }
    const conflicts: AppDataRestoreConflict[] = []
    const currentDocuments = current?.documents ?? {}
    const backupDocuments = backup.documents
    for (const name of new Set([...Object.keys(currentDocuments), ...Object.keys(backupDocuments)])) {
      const before = currentDocuments[name]
      const after = backupDocuments[name]
      if (before === undefined) documents.backupOnly += 1
      else if (after === undefined) {
        documents.currentOnly += 1
        conflicts.push({ kind: 'document', name, currentUpdatedAt: before.updatedAt })
      } else if (JSON.stringify(before.value) !== JSON.stringify(after.value)) {
        documents.modified += 1
        conflicts.push({ kind: 'document', name, currentUpdatedAt: before.updatedAt, backupUpdatedAt: after.updatedAt })
      } else documents.unchanged += 1
    }
    const currentCollections = current?.collections ?? {}
    for (const collection of new Set([...Object.keys(currentCollections), ...Object.keys(backup.collections)])) {
      const before = new Map((currentCollections[collection] ?? []).map(row => [row.key, row]))
      const after = new Map((backup.collections[collection] ?? []).map(row => [row.key, row]))
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const currentRow = before.get(key)
        const backupRow = after.get(key)
        if (currentRow === undefined) collections.backupOnly += 1
        else if (backupRow === undefined) {
          collections.currentOnly += 1
          conflicts.push({ kind: 'collection', name: collection, key, currentUpdatedAt: currentRow.updatedAt })
        } else if (JSON.stringify(currentRow.value) !== JSON.stringify(backupRow.value)) {
          collections.modified += 1
          conflicts.push({ kind: 'collection', name: collection, key, currentUpdatedAt: currentRow.updatedAt, backupUpdatedAt: backupRow.updatedAt })
        } else collections.unchanged += 1
      }
    }
    const currentMeta = current?.meta ?? {}
    /* v8 ignore next -- SqliteDataStore.exportAll always carries a meta map */
    const backupMeta = backup.meta ?? {}
    const metaChanged = [...new Set([...Object.keys(currentMeta), ...Object.keys(backupMeta)])]
      .filter(key => currentMeta[key] !== backupMeta[key])
      .sort()
    const conflictCount = documents.currentOnly + documents.modified + collections.currentOnly + collections.modified
    return {
      appId,
      backupPath,
      backupModifiedAt: backupStat.mtimeMs,
      backupByteSize: backupStat.size,
      documents,
      collections,
      conflicts: conflicts.slice(0, 50),
      conflictCount,
      truncated: conflicts.length > 50,
      metaChanged,
      previewFingerprint: this.restoreFingerprint(backupPath, current, backup),
    }
  }

  /** The current namespace values for one app, without creating a database. */
  private currentAppData(namespace: string): DataStoreExport['apps'][string] | undefined {
    if (!existsSync(this.dataPath)) return undefined
    const store = new SqliteDataStore({ dbPath: this.dataPath })
    try {
      return store.exportAll().apps[namespace]
    } finally {
      store.close()
    }
  }

  /**
   * What a merge would create/overwrite. The host imports with `mode: 'merge'`,
   * which never deletes a row the file does not name; the removed counts are
   * therefore always zero and the UI says so explicitly.
   */
  private importDelta(
    current: DataStoreExport['apps'][string] | undefined,
    incoming: DataStoreExport['apps'][string],
  ): Pick<AppDataImportPreview, 'newDocuments' | 'overwrittenDocuments' | 'removedDocuments' | 'newCollectionItems' | 'overwrittenCollectionItems' | 'removedCollectionItems'> {
    const currentDocuments = current?.documents ?? {}
    let newDocuments = 0
    let overwrittenDocuments = 0
    for (const scope of Object.keys(incoming.documents)) {
      if (scope in currentDocuments) overwrittenDocuments += 1
      else newDocuments += 1
    }
    let newCollectionItems = 0
    let overwrittenCollectionItems = 0
    for (const [name, rows] of Object.entries(incoming.collections)) {
      const existing = new Set((current?.collections[name] ?? []).map(row => row.key))
      for (const row of rows) {
        if (existing.has(row.key)) overwrittenCollectionItems += 1
        else newCollectionItems += 1
      }
    }
    return {
      newDocuments,
      overwrittenDocuments,
      removedDocuments: 0,
      newCollectionItems,
      overwrittenCollectionItems,
      removedCollectionItems: 0,
    }
  }

  /**
   * Import one application's JSON after taking a consistent pre-import backup.
   * The merge keeps rows the dump does not name; it never deletes another
   * application's namespace. A running application is held out of service for
   * the import (new calls are refused, work already running is drained), then
   * asked to reload; a reload that fails keeps the hold until
   * {@link dataReload} retries it. A stopped/failed application imports
   * offline and reads the document on its next start.
   * @param appId - the application to restore.
   * @param json - the exported JSON text.
   * @param planId - the one-shot preview plan; its base is compared after the
   *   drain, so a write that lands while the held work settles refuses the
   *   import instead of being overwritten (DATA-001).
   * @param requestId - the caller's idempotency key for a plan commit.
   * @returns the counts, the backup path and the reload outcome.
   */
  @Remote
  async dataImport(appId: string, json: string, planId?: string, requestId?: string): Promise<AppDataImportResult> {
    return await this.serializedImport(async () => {
      const taken = planId === undefined ? undefined : this.takeDataPlan(planId, 'import', appId, requestId)
      if (taken?.replay !== undefined) return taken.replay as AppDataImportResult
      if (taken !== undefined) json = taken.plan.payload.json!
      const registration = this.runtime.list().find(entry => entry.declaration.id === appId)
      if (registration === undefined) throw new Error(`application ${appId} is not registered; an orphan namespace is not an import target`)
      const status = registration.status()
      if (status === 'starting' || status === 'stopping' || status === 'stop-incomplete') {
        throw new Error(`application ${appId} is ${status}; wait until it is available or stopped before importing`)
      }
      const namespace = this.unifiedNamespace(appId)
      const filtered = this.filterImport(appId, namespace, json)
      // Only a running application has a cache to hold still. A stopped or
      // failed one imports offline and reads the document on its next start.
      const lease = status === 'available' ? await this.runtime.beginMaintenance(appId) : undefined
      const base = await (async (): Promise<Omit<AppDataImportResult, 'reload' | 'reloadError'>> => {
        let store: SqliteDataStore | undefined
        try {
          // The plan's baseline is compared AFTER the drain: a call that was
          // already in flight when the preview was taken can commit while
          // beginMaintenance waits for it, and the merge must not silently
          // overwrite a write the preview never showed.
          if (taken !== undefined) this.assertImportPlan(taken.plan)
          store = new SqliteDataStore({ dbPath: this.dataPath })
          const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
          const backupPath = store.backupTo(`${this.dataPath}.before-import-${stamp}`)
          const delta = this.importDelta(store.exportAll().apps[namespace], filtered.apps[namespace]!)
          const summary = store.importAll(filtered, { mode: 'merge' })
          return { appId, apps: summary.apps, documents: summary.documents, collections: summary.collections, ...delta, backupPath }
        } catch (error) {
          if (lease !== undefined) await lease.release()
          throw error
        } finally {
          store?.close()
        }
      })()
      let reload: AppDataImportResult['reload'] = lease === undefined ? 'skipped' : 'ok'
      let reloadError: string | undefined
      if (lease !== undefined) {
        try {
          await this.runtime.reload(appId)
          await lease.release()
        } catch (error) {
          reload = 'failed'
          reloadError = String((error as Error)?.message ?? error)
          this.ctx.logger.warn(`application-data import could not reload ${appId}: ${reloadError}`)
          // The hold stays: the application must not serve its stale cache.
        }
      }
      this.broadcast({ kind: 'changed', appId })
      const committed = { ...base, reload, ...(reloadError === undefined ? {} : { reloadError }) }
      if (taken !== undefined) this.completeDataPlan(taken.plan, requestId!, committed)
      await this.pruneBackupsAfterCommit()
      return committed
    })
  }

  /**
   * Retry the reload an import could not complete. The import is already
   * committed and the application is held out of service; this runs the reload
   * hook again and releases the hold only after it succeeds.
   * @param appId - the application whose import is waiting for a reload.
   * @returns when the reload settled and the application is callable again.
   */
  @Remote
  async dataReload(appId: string): Promise<void> {
    const registration = this.runtime.list().find(entry => entry.declaration.id === appId)
    if (registration === undefined) throw new Error(`application ${appId} is not registered`)
    if (!this.runtime.maintenance(appId)) throw new Error(`application ${appId} is not waiting for a reload`)
    await this.runtime.reload(appId)
    await this.runtime.endMaintenance(appId)
    this.broadcast({ kind: 'changed', appId })
  }

  /** Run one import behind the previous one; a failed predecessor never blocks the next. */
  private async serializedImport<T>(work: () => Promise<T>): Promise<T> {
    // The tail never rejects (both handlers are attached below), so the next
    // import always starts from a settled predecessor.
    const run = this.importChain.then(work)
    this.importChain = run.then(() => undefined, () => undefined)
    return await run
  }

  /** Parse an export and keep only the requested application's namespace. */
  private filterImport(appId: string, namespace: string, json: string): DataStoreExport {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new Error('the import is not valid JSON')
    }
    const record = parsed as { version?: unknown; apps?: Record<string, unknown>; exportedAt?: unknown }
    if (record === null || typeof record !== 'object' || record.version !== 1 || typeof record.apps !== 'object' || record.apps === null) {
      throw new Error('the import is not a version-1 application export')
    }
    const app = record.apps[namespace]
    if (app === undefined) throw new Error(`the import has no data for ${appId} (namespace ${namespace})`)
    return {
      version: 1,
      exportedAt: typeof record.exportedAt === 'number' ? record.exportedAt : Date.now(),
      apps: { [namespace]: app as DataStoreExport['apps'][string] },
    }
  }

  // ---- the call path --------------------------------------------------------

  /**
   * Call one operation as the human. `args` is validated by the runtime against
   * the operation's own declaration; the outcome says whether the operation
   * never ran (rejected), ran and failed (its effects may stand), completed, or
   * was cancelled. The human is not subject to per-operation openness — but the
   * operation, its parameters and the application's availability still are.
   * @param appId - the application to call.
   * @param op - the operation name.
   * @param args - the JSON arguments.
   * @param requestId - the caller's correlation/cancellation id. It is NOT
   *   folded into the arguments: an operation that declares `requestId` reads
   *   it from `args` (the caller writes it there explicitly, so a retry reuses
   *   the same value), while this parameter only names the call for progress
   *   and `cancel` while it runs.
   * @param signal - aborts this call (the carrier's own cancellation).
   * @returns the outcome.
   */
  @Remote
  async call(appId: string, op: string, args: JsonValue, requestId?: string, signal?: AbortSignal): Promise<CallOutcome> {
    const controller = new AbortController()
    if (requestId !== undefined) {
      const controllers = this.inFlight.get(requestId) ?? new Set<AbortController>()
      controllers.add(controller)
      this.inFlight.set(requestId, controllers)
    }
    try {
      // The runtime carries the caller's id on every record (progress notices
      // included), so a page can recognise — and take over — the progress rows
      // of ITS OWN call while the raw progress stays in the shell. The
      // arguments are passed through untouched: request-id semantics belong to
      // the operation's own declaration, not to a transport rewrite.
      return await this.runtime.call({ kind: 'human' }, appId, op, args, combinedSignal(signal, controller.signal), requestId)
    } finally {
      if (requestId !== undefined) {
        const controllers = this.inFlight.get(requestId)
        controllers?.delete(controller)
        if (controllers?.size === 0) this.inFlight.delete(requestId)
      }
    }
  }

  /**
   * Cancel one in-flight call started through {@link call} under the given id.
   * Cancellation is a REQUEST: an operation that ignores its signal runs to its
   * own end, and effects already produced are never undone.
   * @param callId - the `requestId` the call was started with.
   * @returns whether a call was in flight under that id (a call started without
   *   an id, or one that already settled, cannot be cancelled here — the
   *   carrier's own signal still cancels it).
   */
  @Remote
  cancel(callId: string): boolean {
    const controllers = this.inFlight.get(callId)
    if (controllers === undefined) return false
    for (const controller of controllers) {
      controller.abort(new Error(`application call ${callId} was cancelled from the browser`))
    }
    return true
  }

  /**
   * The most recent calls this host recorded, newest first — who called what,
   * when, and how it ended (never arguments or results). Basic history is
   * best-effort and independent of execution: an empty answer means "nothing
   * recorded is readable", not "nothing happened".
   * @param limit - how many records at most (absent = the runtime's default).
   * @param target - an application whose calls to answer; the runtime applies
   *   the filter to its window BEFORE the limit, so "this application's recent
   *   calls" is answered from the whole window rather than from a global slice
   *   other applications may have crowded out.
   * @returns the recorded calls, newest first.
   */
  @Remote
  async history(limit?: number, target?: string): Promise<readonly HistoryRecord[]> {
    return await this.historyFile.history(limit, target)
  }

  /**
   * The task projections this host knows: live runtime tasks merged with the
   * durable store (including tasks marked `interrupted` at startup), newest
   * first. The application's own record remains the business truth.
   * @param target - optional application filter.
   * @returns task snapshots.
   */
  @Remote
  async tasks(target?: string): Promise<readonly TaskSnapshot[]> {
    const stored = await this.taskFile.list()
    const live = this.runtime.tasks(target)
    const byId = new Map<string, TaskSnapshot>()
    for (const task of stored) byId.set(task.taskId, task)
    for (const task of live) byId.set(task.taskId, task as TaskSnapshot)
    return [...byId.values()]
      .filter(task => target === undefined || task.appId === target)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /**
   * Ask one task to cancel. A task that only exists in the durable store is
   * already settled/interrupted and cannot be cancelled across a restart.
   * @param appId - the task's owner.
   * @param taskId - the task to cancel.
   * @returns accepted, already settled, or unknown.
   */
  @Remote
  async cancelTask(appId: string, taskId: string): Promise<TaskCancelResult> {
    const live = this.runtime.cancelTask(appId, taskId)
    if (live !== 'not-found') return live
    const stored = await this.taskFile.task(appId, taskId)
    return stored === undefined ? 'not-found' : 'settled'
  }

  /**
   * Stop one application: it stops accepting calls, its in-flight and
   * background work is cancelled, its own stop hook runs, and the answer is the
   * final status — `stop-incomplete` when work outlived the stop budget (that
   * work is still tracked, and the application is not restarted).
   * @param appId - the application to stop.
   * @returns the final status.
   * @throws when no application is registered under that id (the runtime's own refusal).
   */
  @Remote
  async stopApp(appId: string): Promise<AppStatus> {
    return await this.runtime.stop(appId)
  }

  /**
   * Mark one Session as the application-area conversation. The host's scoped
   * tool bridge attaches the application operations to that Session's Agent;
   * a Session that is never marked keeps the standard tool set only. Marking
   * is additive and idempotent, and it is the browser's action on a Session it
   * created in the dedicated application workspace.
   * @param sessionId - the Session the application area opened.
   * @returns whether a scoped tool bridge is mounted and accepted the mark.
   */
  @Remote
  async registerAppConversation(sessionId: string): Promise<boolean> {
    await this.conversationReady
    const previous = this.conversationSessionId
    if (previous !== undefined && previous !== sessionId) this.appTools?.unmark?.(previous)
    this.conversationSessionId = sessionId
    this.appTools?.mark(sessionId)
    try {
      await writeVersionedJson(this.conversationPath, 1, { sessionId })
    } catch (error) {
      // The current process still has the mark; the next boot cannot restore it.
      this.ctx.logger.warn(`the application conversation record ${this.conversationPath} could not be written: ${String(error)}`)
    }
    return this.appTools !== undefined
  }

  /**
   * Forget the application conversation target: unmark the current Session and
   * remove the durable record. This runs when the browser clears a stale target;
   * a later first use writes a fresh one.
   * @returns whether the operation completed (a missing file is already clear).
   */
  @Remote
  async clearAppConversation(): Promise<boolean> {
    await this.conversationReady
    const previous = this.conversationSessionId
    this.conversationSessionId = undefined
    if (previous !== undefined) this.appTools?.unmark?.(previous)
    try {
      if (existsSync(this.conversationPath)) unlinkSync(this.conversationPath)
    } catch (error) {
      this.ctx.logger.warn(`the application conversation record ${this.conversationPath} could not be removed: ${String(error)}`)
      return false
    }
    return true
  }

  /**
   * Set the application page the human is looking at for one application-area
   * Session. The page is a pointer, not content: the context reader resolves it
   * through the application's own read operation at send time, and the browser
   * shows the same chip. Passing null clears it when the human leaves the area.
   * @param sessionId - the application-area Session.
   * @param context - the current page pointer, or null to clear it.
   * @returns whether the context reader is mounted and accepted the value.
   */
  @Remote
  async setAppConversationContext(sessionId: string, context: JsonValue | null): Promise<boolean> {
    const service = this.ctx.get('appConversationContext') as {
      set(sessionId: string, page: import('@matrix1001/dsh-application-harness-context').AppConversationPage | null): void
      get(sessionId: string): import('@matrix1001/dsh-application-harness-context').AppConversationPage | undefined
    } | undefined
    if (service === undefined) return false
    // The ambient page pointer is a page-service seat for the application
    // conversation and development sessions only; a normal session must not
    // acquire page context by writing a pointer.
    if (sessionId !== this.conversationSessionId && sessionId !== this.developmentSessionId) return false
    if (context === null) {
      const previousPageId = this.pageIds.get(sessionId)
      this.pageIds.delete(sessionId)
      if (previousPageId !== undefined) {
        this.invalidatePageCommands(previousPageId)
        this.dropPageShares(previousPageId)
      }
      service.set(sessionId, null)
      return true
    }
    if (typeof context !== 'object' || Array.isArray(context)) return false
    const value = context as Record<string, JsonValue>
    const appId = value['appId']
    const label = value['label']
    if (typeof appId !== 'string' || appId === '' || typeof label !== 'string') return false
    const rawRecord = value['record']
    let record: { kind: string; id: string } | undefined
    if (rawRecord !== undefined) {
      if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)) return false
      const kind = (rawRecord as Record<string, JsonValue>)['kind']
      const id = (rawRecord as Record<string, JsonValue>)['id']
      if (typeof kind !== 'string' || typeof id !== 'string' || kind === '' || id === '') return false
      record = { kind, id }
    }
    const rawSelection = value['selection']
    let selection: Array<{ kind: string; id: string }> | undefined
    if (rawSelection !== undefined) {
      if (!Array.isArray(rawSelection)) return false
      selection = rawSelection.flatMap((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
        const kind = (item as Record<string, JsonValue>)['kind']
        const id = (item as Record<string, JsonValue>)['id']
        return typeof kind === 'string' && kind !== '' && typeof id === 'string' && id !== '' ? [{ kind, id }] : []
      })
      if (selection.length !== rawSelection.length) return false
    }
    const view = value['view']
    if (view !== undefined && (typeof view !== 'string' || view === '')) return false
    const dirty = value['hasUnsavedChanges']
    if (dirty !== undefined && typeof dirty !== 'boolean') return false
    const previous = service.get(sessionId)
    const pageId = previous?.appId === appId && previous.view === view && this.pageIds.has(sessionId)
      ? this.pageIds.get(sessionId)!
      : `page-${String(++this.pageSerial)}`
    const previousPageId = this.pageIds.get(sessionId)
    if (previousPageId !== undefined && previousPageId !== pageId) {
      this.invalidatePageCommands(previousPageId)
      this.dropPageShares(previousPageId)
    }
    this.pageIds.set(sessionId, pageId)
    this.pageOwners.set(pageId, sessionId)
    service.set(sessionId, {
      pageId,
      snapshotId: `snapshot-${String(++this.snapshotSerial)}`,
      appId,
      label,
      ...(record === undefined ? {} : { record }),
      ...(view === undefined ? {} : { view }),
      ...(selection === undefined ? {} : { selection }),
      ...(dirty === undefined ? {} : { hasUnsavedChanges: dirty }),
    })
    return true
  }

  /**
   * Read the host-owned application conversation identity once at startup and
   * mark it when the scoped tool bridge is present. A malformed record is a
   * warning, not a boot failure: it only loses a convenience mapping.
   * @returns when the record (or its absence) has been applied.
   */
  private async loadAppConversation(): Promise<void> {
    try {
      const record = await readVersionedJson(this.conversationPath, 1, 'application conversation record', (document) => {
        const sessionId = document.sessionId
        if (sessionId === undefined) return {}
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('the application conversation record carries an invalid sessionId')
        }
        return { sessionId }
      })
      if (record?.sessionId !== undefined) {
        this.conversationSessionId = record.sessionId
        this.appTools?.mark(record.sessionId)
      }
    } catch (error) {
      this.ctx.logger.warn(`the application conversation record ${this.conversationPath} could not be read: ${String(error)}`)
    }
  }

  /** Load the disabled set once; a corrupt file is reported and treated as empty by the store read? */
  private async loadActivation(): Promise<void> {
    try {
      for (const appId of await this.activationFile.list()) this.disabledApps.add(appId)
      for (const entry of this.runtime.list()) await this.applyActivation(entry.declaration.id)
    } catch (error) {
      this.ctx.logger.warn(`the activation table could not be read: ${String(error)}`)
    }
  }

  /** Apply the stored activation to one registered application, once. */
  private async applyActivation(appId: string): Promise<void> {
    if (this.changingActivation.has(appId) || !this.disabledApps.has(appId)) return
    const registration = this.runtime.list().find(entry => entry.declaration.id === appId)
    /* v8 ignore next -- an app that disappeared or is already disabled needs no action */
    if (registration === undefined || registration.activation() === 'disabled') return
    this.changingActivation.add(appId)
    try {
      await this.runtime.setActivation(appId, 'disabled')
    } catch (error) {
      /* v8 ignore next -- applyActivation cannot fail for an enabled application in the tested model */
      this.ctx.logger.warn(`application ${appId} could not be disabled: ${String(error)}`)
    } finally {
      this.changingActivation.delete(appId)
    }
  }

  /** Read the one development-session binding; absence is normal. */
  private async loadDevelopment(): Promise<void> {
    try {
      const record = await readVersionedJson(this.developmentPath, 1, 'development-session record', (document) => {
        const sessionId = document.sessionId
        const appId = document.appId
        if (typeof sessionId !== 'string' || sessionId === '' || typeof appId !== 'string' || appId === '') {
          throw new Error('the development-session record needs sessionId and appId')
        }
        return { sessionId, appId }
      })
      if (record?.sessionId !== undefined && record.appId !== undefined) {
        this.developmentSessionId = record.sessionId
        this.developmentAppId = record.appId
        this.appTools?.markDevelopment?.(record.sessionId, record.appId)
      }
    } catch (error) {
      this.ctx.logger.warn(`the development-session record ${this.developmentPath} could not be read: ${String(error)}`)
    }
  }

  // ---- grants ---------------------------------------------------------------

  /** The grants currently in effect (a copy; the caller's own capability set as approved). */
  @Remote
  async grants(): Promise<readonly CapabilityGrant[]> {
    return await this.runtime.grantsOf()
  }

  /**
   * Record that a caller may use a set of capabilities. The set is frozen at
   * approval time: a later declaration that adds operations does not extend it.
   * @param caller - the caller the grant belongs to.
   * @param capabilities - the exact capability set being approved
   *   (`<appId>#<op>` for an operation, `capability:<name>` for a platform capability).
   * @returns the recorded grant, with the host's approval timestamp.
   */
  @Remote
  async grant(caller: Caller, capabilities: readonly string[]): Promise<CapabilityGrant> {
    const grant: CapabilityGrant = { caller, capabilities: [...capabilities], grantedAt: new Date().toISOString() }
    this.runtime.validateGrant(grant)
    await this.runtime.grant(grant)
    return grant
  }

  /**
   * Revoke capabilities from one caller. Revoked capabilities are removed, not
   * remembered: the next call asks again rather than reusing a stale approval.
   * @param caller - the caller whose grants are revoked.
   * @param selector - an exact capability, an application id (all of that
   *   application's operations), or absent (everything this caller was granted).
   */
  @Remote
  async revoke(caller: Caller, selector?: string): Promise<void> {
    await this.runtime.revoke(caller, selector)
  }

  /**
   * Enable or disable one deployed application. Disabling stops it; enabling
   * restarts it. The write must persist before this returns.
   * @param appId - the application.
   * @param activation - enabled or disabled.
   * @returns the rows after the change.
   */
  @Remote
  async setActivation(appId: string, activation: 'enabled' | 'disabled'): Promise<readonly AppInfo[]> {
    await this.activationReady
    this.changingActivation.add(appId)
    try {
      await this.runtime.setActivation(appId, activation)
      const previous = new Set(this.disabledApps)
      if (activation === 'disabled') this.disabledApps.add(appId)
      else this.disabledApps.delete(appId)
      try {
        await this.activationFile.save([...this.disabledApps])
      } catch (error) {
        this.disabledApps.clear()
        for (const id of previous) this.disabledApps.add(id)
        /* v8 ignore next -- a revert failure is reported by the original save error */
        try { await this.runtime.setActivation(appId, previous.has(appId) ? 'disabled' : 'enabled') } catch { /* reported below */ }
        throw error
      }
    } finally {
      this.changingActivation.delete(appId)
    }
    return this.rows()
  }

  /**
   * Bind one Session as a development conversation for one application. The
   * Session then sees only that application through the unified tool, and its
   * writes require one confirmation each. Replacing the binding clears the old
   * development mark unless the old Session is also the application conversation.
   * @param sessionId - the development Session.
   * @param appId - the application under development.
   * @returns whether the binding was recorded.
   */
  @Remote
  async registerDevelopmentSession(sessionId: string, appId: string): Promise<boolean> {
    if (sessionId === '' || appId === '' || !this.runtime.list().some(entry => entry.declaration.id === appId)) return false
    await this.developmentReady
    const previousSession = this.developmentSessionId
    const previousApp = this.developmentAppId
    this.developmentSessionId = sessionId
    this.developmentAppId = appId
    if (previousSession !== undefined && previousSession !== sessionId && previousSession !== this.conversationSessionId) this.appTools?.unmark?.(previousSession)
    this.appTools?.markDevelopment?.(sessionId, appId)
    try {
      await writeVersionedJson(this.developmentPath, 1, { sessionId, appId })
      return true
    } catch (error) {
      this.developmentSessionId = previousSession
      this.developmentAppId = previousApp
      if (previousSession !== undefined && previousSession !== this.conversationSessionId) this.appTools?.markDevelopment?.(previousSession, previousApp as string)
      this.ctx.logger.warn(`the development-session record ${this.developmentPath} could not be written: ${String(error)}`)
      return false
    }
  }

  /** Clear the development-session binding. */
  @Remote
  async clearDevelopmentSession(): Promise<boolean> {
    await this.developmentReady
    const previous = this.developmentSessionId
    this.developmentSessionId = undefined
    this.developmentAppId = undefined
    if (previous !== undefined && previous !== this.conversationSessionId) this.appTools?.unmark?.(previous)
    try {
      if (existsSync(this.developmentPath)) unlinkSync(this.developmentPath)
      return true
    } catch (error) {
      this.ctx.logger.warn(`the development-session record ${this.developmentPath} could not be removed: ${String(error)}`)
      return false
    }
  }

  /**
   * Record the user's explicit draft share. Only identifiers, field scope and
   * the owning page/session are stored; values stay in the page editor.
   * @param sessionId - the owner Session.
   * @param draftId - the page-defined draft id.
   * @param fields - optional JSON Pointer fields; omitted means the whole draft.
   * @returns whether the share was recorded.
   */
  @Remote
  async shareDraft(sessionId: string, draftId: string, fields?: readonly string[]): Promise<boolean> {
    if (sessionId !== this.conversationSessionId && sessionId !== this.developmentSessionId) return false
    if (draftId === '') return false
    if (fields !== undefined && (fields.length === 0 || new Set(fields).size !== fields.length || fields.some(field => field !== '' && !field.startsWith('/')))) return false
    const service = this.ctx.get('appConversationContext') as { get?: (id: string) => { readonly pageId?: string } | undefined } | undefined
    const pageId = service?.get?.(sessionId)?.pageId
    if (pageId === undefined) return false
    this.draftShares.set(`${pageId}\0${draftId}`, { sessionId, pageId, draftId, ...(fields === undefined ? {} : { fields: [...fields] }) })
    return true
  }

  /** Withdraw one draft share. */
  @Remote
  revokeDraftShare(sessionId: string, draftId: string): boolean {
    const pageId = this.pageIds.get(sessionId)
    if (pageId === undefined) return false
    return this.draftShares.delete(`${pageId}\0${draftId}`)
  }

  /** Fail every command still waiting on a page instance that just went away. */
  private invalidatePageCommands(pageId: string): void {
    for (const [commandId, pending] of this.pageCommands) {
      if (pending.pageId !== pageId) continue
      clearTimeout(pending.timer)
      this.pageCommands.delete(commandId)
      pending.resolve(false, 'the page changed before the command was answered')
    }
  }

  /** Drop every share belonging to one page instance. */
  private dropPageShares(pageId: string): void {
    this.pageOwners.delete(pageId)
    /* v8 ignore next -- shares are keyed by page; the loop only sees this page's entries at drop time */
    for (const [key, share] of this.draftShares) if (share.pageId === pageId) this.draftShares.delete(key)
  }

  /**
   * Read one explicitly shared draft through the owner client's page
   * controller. The values never live on the host.
   * @param sessionId - the owner Session.
   * @param input - page, draft and optional field scope.
   * @returns the draft result as an outcome.
   */
  private async readDraft(sessionId: string, input: { readonly pageId: string; readonly draftId: string; readonly fields?: readonly string[] }): Promise<CallOutcome> {
    const callId = `draft-${String(++this.serial)}`
    const reject = (code: string, message: string): CallOutcome => ({ callId, status: 'rejected', error: { code, message } })
    if (sessionId !== this.conversationSessionId && sessionId !== this.developmentSessionId) return reject('platform.draft-not-shared', 'no owner client is bound to this Session')
    if (this.pageIds.get(sessionId) !== input.pageId) return reject('platform.page-unavailable', 'the page is no longer visible')
    const share = this.draftShares.get(`${input.pageId}\0${input.draftId}`)
    if (share === undefined || share.sessionId !== sessionId) return reject('platform.draft-not-shared', 'the draft has not been shared with this Session')
    if (share.fields !== undefined && input.fields !== undefined && input.fields.some(field => !share.fields!.includes(field))) {
      return reject('platform.draft-scope', 'one or more requested fields are outside the shared scope')
    }
    const commandId = `page-command-${String(++this.serial)}`
    const page = (this.ctx.get('appConversationContext') as { get?: (id: string) => { appId: string } | undefined } | undefined)?.get?.(sessionId)
    const command = { commandId, sessionId, action: 'draft-read' as const, appId: page?.appId as string, input: { draftId: input.draftId, ...(input.fields === undefined ? {} : { fields: [...input.fields] }) } }
    const answer = await new Promise<{ accepted: boolean; error?: string; result?: JsonValue }>((resolve) => {
      const timer = setTimeout(() => { this.pageCommands.delete(commandId); resolve({ accepted: false, error: 'the owner client did not answer in time' }) }, PAGE_COMMAND_TIMEOUT_MS)
      this.pageCommands.set(commandId, { pageId: input.pageId, resolve: (accepted, error, result) => { resolve({ accepted, ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }) }) }, timer })
      this.broadcast({ kind: 'page-command', command })
    })
    if (!answer.accepted || answer.result === undefined) return reject('platform.page-unavailable', answer.error ?? 'the page refused the draft read')
    const value = answer.result
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject('platform.draft-invalid', 'the draft result must be an object')
    const draft = value as Record<string, unknown>
    if (typeof draft['revision'] !== 'string' || draft['revision'] === '') return reject('platform.draft-invalid', 'the draft result needs a revision')
    if (typeof draft['values'] !== 'object' || draft['values'] === null || Array.isArray(draft['values'])) return reject('platform.draft-invalid', 'the draft result needs a values object')
    return { callId, status: 'success', result: { pageId: input.pageId, draftId: input.draftId, revision: draft['revision'], values: draft['values'] as JsonValue } }
  }

  /**
   * Update one explicitly shared draft through the owner page controller.
   * Values are restricted to the shared field scope; the page enforces its own
   * revision and returns a conflict marker when it has moved on.
   * @param sessionId - the owner Session.
   * @param input - page, draft, revision and field values.
   * @returns the updated draft as an outcome.
   */
  private async updateDraft(sessionId: string, input: { readonly pageId: string; readonly draftId: string; readonly revision: string; readonly values: JsonValue }): Promise<CallOutcome> {
    const callId = `draft-${String(++this.serial)}`
    const reject = (code: string, message: string): CallOutcome => ({ callId, status: 'rejected', error: { code, message } })
    if (sessionId !== this.conversationSessionId && sessionId !== this.developmentSessionId) return reject('platform.draft-not-shared', 'no owner client is bound to this Session')
    if (this.pageIds.get(sessionId) !== input.pageId) return reject('platform.page-unavailable', 'the page is no longer visible')
    const share = this.draftShares.get(`${input.pageId}\0${input.draftId}`)
    if (share === undefined || share.sessionId !== sessionId) return reject('platform.draft-not-shared', 'the draft has not been shared with this Session')
    if (typeof input.revision !== 'string' || input.revision === '') return reject('platform.draft-invalid', 'the draft revision must be a non-empty string')
    if (typeof input.values !== 'object' || input.values === null || Array.isArray(input.values)) return reject('platform.draft-invalid', 'the draft values must be an object')
    if (share.fields !== undefined && Object.keys(input.values).some(field => !share.fields!.includes(field))) {
      return reject('platform.draft-scope', 'one or more updated fields are outside the shared scope')
    }
    const page = (this.ctx.get('appConversationContext') as { get?: (id: string) => { appId: string } | undefined } | undefined)?.get?.(sessionId)
    const commandId = `page-command-${String(++this.serial)}`
    const command = { commandId, sessionId, action: 'draft-update' as const, appId: page?.appId as string, input: { draftId: input.draftId, revision: input.revision, values: input.values } }
    const answer = await new Promise<{ accepted: boolean; error?: string; result?: JsonValue }>((resolve) => {
      const timer = setTimeout(() => { this.pageCommands.delete(commandId); resolve({ accepted: false, error: 'the owner client did not answer in time' }) }, PAGE_COMMAND_TIMEOUT_MS)
      this.pageCommands.set(commandId, { pageId: input.pageId, resolve: (accepted, error, result) => { resolve({ accepted, ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }) }) }, timer })
      this.broadcast({ kind: 'page-command', command })
    })
    if (!answer.accepted || answer.result === undefined) return reject('platform.page-unavailable', answer.error ?? 'the page refused the draft update')
    const value = answer.result
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return reject('platform.draft-invalid', 'the draft result must be an object')
    const draft = value as Record<string, unknown>
    if (draft['conflict'] === true) return reject('platform.draft-conflict', 'the draft changed since the supplied revision')
    if (typeof draft['revision'] !== 'string' || draft['revision'] === '') return reject('platform.draft-invalid', 'the draft result needs a revision')
    if (typeof draft['values'] !== 'object' || draft['values'] === null || Array.isArray(draft['values'])) return reject('platform.draft-invalid', 'the draft result needs a values object')
    return { callId, status: 'success', result: { pageId: input.pageId, draftId: input.draftId, revision: draft['revision'], values: draft['values'] as JsonValue } }
  }

  /** The live provider/model catalog for the management UI. */
  @Remote
  async modelCatalog(): Promise<ModelCatalog> {
    const llm = this.ctx.get('llm') as {
      listProviders?(): readonly { id: string; name: string }[]
      listModels?(id: string): Promise<readonly { id: string; name: string }[]>
    } | undefined
    if (llm?.listProviders === undefined || llm.listModels === undefined) return { providers: [] }
    const providers = await Promise.all(llm.listProviders().map(async provider => ({
      id: provider.id,
      name: provider.name,
      models: (await llm.listModels!(provider.id)).map(model => ({ id: model.id, name: model.name })),
    })))
    return { providers }
  }

  /**
   * Set or clear one application's fixed model route. The selection is only a
   * routing preference; model access still requires the declared capability and
   * the user's standing grant.
   * @param appId - the application.
   * @param selection - provider/model, or null to follow the default.
   * @returns whether the choice was saved.
   */
  @Remote
  async setAppModel(appId: string, selection: { readonly provider: string; readonly model: string } | null): Promise<boolean> {
    if (!this.runtime.list().some(entry => entry.declaration.id === appId)) return false
    try {
      await this.modelSelectionsReady
      await this.modelSelections.set(appId, selection)
      return true
    } catch (error) {
      this.ctx.logger.warn(`model selection for ${appId} could not be saved: ${String(error)}`)
      return false
    }
  }

  /**
   * Read one application's aggregated model usage.
   * @param appId - the application; unknown ids return the empty aggregate.
   * @returns counters, duration, last model/status and known token usage.
   */
  @Remote
  async modelUsage(appId: string): Promise<ModelUsageSummary> {
    await this.modelUsageReady
    return this.modelUsageStore.get(appId)
  }

  /**
   * Project the application's DECLARED credentials as name/set status.
   * Values never cross this boundary.
   * @param appId - the application.
   * @returns declared names and whether each is set.
   */
  @Remote
  async credentials(appId: string): Promise<readonly AppCredentialStatus[]> {
    await this.secretsReady
    const declaration = this.runtime.list().find(entry => entry.declaration.id === appId)?.declaration
    const fields = declaration?.data?.secretFields ?? []
    return fields.map(name => ({ name, set: this.secretStore.has(appId, name) }))
  }

  /**
   * Set one declared credential. The value is stored host-only and is never
   * returned by any read.
   * @param appId - the application.
   * @param name - one of the declaration's secretFields.
   * @param value - the non-empty value.
   * @returns whether it was saved.
   */
  @Remote
  async setCredential(appId: string, name: string, value: string): Promise<boolean> {
    const declaration = this.runtime.list().find(entry => entry.declaration.id === appId)?.declaration
    if (declaration?.data?.secretFields?.includes(name) !== true || value === '') return false
    try {
      await this.secretsReady
      await this.secretStore.set(appId, name, value)
      return true
    } catch (error) {
      this.ctx.logger.warn(`credential ${name} for ${appId} could not be saved: ${String(error)}`)
      return false
    }
  }

  /**
   * Delete one declared credential.
   * @param appId - the application.
   * @param name - one of the declaration's secretFields.
   * @returns whether it existed and was removed.
   */
  @Remote
  async deleteCredential(appId: string, name: string): Promise<boolean> {
    const declaration = this.runtime.list().find(entry => entry.declaration.id === appId)?.declaration
    if (declaration?.data?.secretFields?.includes(name) !== true) return false
    try {
      await this.secretsReady
      return await this.secretStore.delete(appId, name)
    } catch (error) {
      this.ctx.logger.warn(`credential ${name} for ${appId} could not be deleted: ${String(error)}`)
      return false
    }
  }

  /**
   * Read one application's model limits.
   * @param appId - the application.
   * @returns the stored limits (defaults when unset).
   */
  @Remote
  async modelLimits(appId: string): Promise<ModelLimits> {
    await this.modelLimitsReady
    return this.modelLimitsStore.get(appId)
  }

  /**
   * Set one application's model limits.
   * @param appId - the application.
   * @param limits - background permission and optional caps.
   * @returns whether the choice was saved.
   */
  @Remote
  async setModelLimits(appId: string, limits: ModelLimits): Promise<boolean> {
    if (!this.runtime.list().some(entry => entry.declaration.id === appId)) return false
    try {
      await this.modelLimitsReady
      await this.modelLimitsStore.set(appId, limits)
      return true
    } catch (error) {
      this.ctx.logger.warn(`model limits for ${appId} could not be saved: ${String(error)}`)
      return false
    }
  }

  /**
   * Answer one host-to-client page command. Only the owner client should call
   * this; a late or duplicate answer is a no-op.
   * @param commandId - the command id.
   * @param accepted - whether the client executed the navigation.
   * @param error - an optional refusal reason.
   * @returns whether a pending command was answered.
   */
  @Remote
  completePageCommand(commandId: string, accepted: boolean, error?: string, result?: JsonValue): boolean {
    const pending = this.pageCommands.get(commandId)
    if (pending === undefined) return false
    this.pageCommands.delete(commandId)
    clearTimeout(pending.timer)
    pending.resolve(accepted, error, result)
    return true
  }

  /**
   * Ask the owner client to open a page within its current application. The
   * command is delivered on the watch stream; a client that does not own the
   * Session ignores it, and an unanswered command fails closed.
   * @param sessionId - the owner Session.
   * @param input - optional view and record.
   * @returns the command's outcome.
   */
  private async openPage(sessionId: string, input: { readonly view?: string; readonly record?: { readonly kind: string; readonly id: string } }): Promise<CallOutcome> {
    const callId = `page-${String(++this.serial)}`
    const reject = (message: string, code = 'platform.page-unavailable'): CallOutcome => ({
      callId,
      status: 'rejected',
      error: { code, message },
    })
    if (sessionId !== this.conversationSessionId && sessionId !== this.developmentSessionId) return reject('no owner client is bound to this Session')
    const service = this.ctx.get('appConversationContext') as { get?: (id: string) => { readonly appId: string; readonly pageId?: string } | undefined } | undefined
    const page = service?.get?.(sessionId)
    if (page === undefined) return reject('no application page is currently open')
    const registered = this.runtime.list().find(entry => entry.declaration.id === page.appId)
    const raw = input as Record<string, unknown>
    const view = raw['view']
    if (registered?.declaration.pages !== undefined && view !== undefined
      && (typeof view !== 'string' || registered.declaration.pages[view] === undefined)) {
      return reject(`application ${page.appId} does not declare the page view ${String(view)}`, 'platform.action-not-allowed')
    }
    if (view !== undefined && (typeof view !== 'string' || view === '')) return reject('the page view must be a non-empty string')
    const rawRecord = raw['record']
    let record: { kind: string; id: string } | undefined
    if (rawRecord !== undefined) {
      if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)) return reject('the page record must be { kind, id }')
      const kind = (rawRecord as Record<string, unknown>)['kind']
      const id = (rawRecord as Record<string, unknown>)['id']
      if (typeof kind !== 'string' || kind === '' || typeof id !== 'string' || id === '') return reject('the page record must be { kind, id }')
      record = { kind, id }
    }
    const commandId = `page-command-${String(++this.serial)}`
    const command = {
      commandId,
      sessionId,
      action: 'open' as const,
      appId: page.appId,
      ...(view === undefined ? {} : { view }),
      ...(record === undefined ? {} : { record }),
    }
    const answer = await new Promise<{ accepted: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pageCommands.delete(commandId)
        resolve({ accepted: false, error: 'the owner client did not answer in time' })
      }, PAGE_COMMAND_TIMEOUT_MS)
      this.pageCommands.set(commandId, { pageId: page.pageId!, resolve: (accepted, error) => { resolve({ accepted, ...(error === undefined ? {} : { error }) }) }, timer })
      this.broadcast({ kind: 'page-command', command })
    })
    if (!answer.accepted) return reject(answer.error ?? 'the owner client refused the page command')
    return { callId, status: 'success', result: { accepted: true } }
  }

  /**
   * Apply one fixed page action to the owner-session visible page. Only
   * `navigate` is executable today; other fixed actions return a stable
   * action-not-allowed rejection.
   * @param sessionId - the owner Session.
   * @param input - page/snapshot ids, action and action input.
   * @returns the action's outcome.
   */
  private async actPage(sessionId: string, input: { readonly pageId: string; readonly snapshotId: string; readonly action: 'navigate' | 'set-filters' | 'select'; readonly input?: unknown }): Promise<CallOutcome> {
    const callId = `page-${String(++this.serial)}`
    const reject = (code: string, message: string): CallOutcome => ({
      callId,
      status: 'rejected',
      error: { code, message },
    })
    if (sessionId !== this.conversationSessionId && sessionId !== this.developmentSessionId) return reject('platform.page-unavailable', 'no owner client is bound to this Session')
    const service = this.ctx.get('appConversationContext') as { get?: (id: string) => { readonly appId: string; readonly pageId?: string; readonly snapshotId?: string; readonly view?: string } | undefined } | undefined
    const page = service?.get?.(sessionId)
    if (page === undefined || page.pageId === undefined || page.snapshotId === undefined) return reject('platform.page-unavailable', 'no application page is currently open')
    if (page.pageId !== input.pageId) return reject('platform.stale-snapshot', 'the page instance is no longer visible; read it again')
    if (page.snapshotId !== input.snapshotId) return reject('platform.stale-snapshot', 'the page snapshot is stale; read it again')
    const registered = this.runtime.list().find(entry => entry.declaration.id === page.appId)
    const declaredPages = registered?.declaration.pages
    if (declaredPages !== undefined && page.view !== undefined) {
      const declared = declaredPages[page.view]
      if (declared === undefined) return reject('platform.action-not-allowed', `application ${page.appId} does not declare the page view ${page.view}`)
      const allowed = declared.actions ?? ['navigate', 'set-filters', 'select']
      if (!allowed.includes(input.action)) return reject('platform.action-not-allowed', `page ${page.view} does not declare the action ${input.action}`)
    }
    const raw = input.input
    if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reject('platform.action-not-allowed', `${input.action} needs an input object`)
    let command: { commandId: string; sessionId: string; action: 'navigate' | 'set-filters' | 'select'; appId: string; view?: string; record?: { kind: string; id: string }; input?: JsonValue }
    if (input.action === 'navigate') {
      const view = (raw as Record<string, unknown>)['view']
      if (view !== undefined && (typeof view !== 'string' || view === '')) return reject('platform.action-not-allowed', 'navigate.view must be a non-empty string')
      if (view !== undefined && declaredPages !== undefined && declaredPages[view] === undefined) return reject('platform.action-not-allowed', `application ${page.appId} does not declare the page view ${view}`)
      const rawRecord = (raw as Record<string, unknown>)['record']
      let record: { kind: string; id: string } | undefined
      if (rawRecord !== undefined) {
        if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)) return reject('platform.action-not-allowed', 'navigate.record must be { kind, id }')
        const kind = (rawRecord as Record<string, unknown>)['kind']
        const id = (rawRecord as Record<string, unknown>)['id']
        if (typeof kind !== 'string' || kind === '' || typeof id !== 'string' || id === '') return reject('platform.action-not-allowed', 'navigate.record must be { kind, id }')
        record = { kind, id }
      }
      command = { commandId: '', sessionId, action: 'navigate', appId: page.appId, ...(view === undefined ? {} : { view }), ...(record === undefined ? {} : { record }) }
    } else if (input.action === 'set-filters') {
      const filters = (raw as Record<string, unknown>)['filters']
      if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) return reject('platform.action-not-allowed', 'set-filters needs a filters object')
      command = { commandId: '', sessionId, action: 'set-filters', appId: page.appId, input: { filters: filters as JsonValue } }
    } else {
      const selection = (raw as Record<string, unknown>)['selection']
      if (!Array.isArray(selection)) return reject('platform.action-not-allowed', 'select needs a selection array')
      const refs: Array<{ kind: string; id: string }> = []
      for (const item of selection) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return reject('platform.action-not-allowed', 'select items must be { kind, id }')
        const kind = (item as Record<string, unknown>)['kind']
        const id = (item as Record<string, unknown>)['id']
        if (typeof kind !== 'string' || kind === '' || typeof id !== 'string' || id === '') return reject('platform.action-not-allowed', 'select items must be { kind, id }')
        refs.push({ kind, id })
      }
      command = { commandId: '', sessionId, action: 'select', appId: page.appId, input: { selection: refs } }
    }
    const commandId = `page-command-${String(++this.serial)}`
    const sent = { ...command, commandId }
    const answer = await new Promise<{ accepted: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pageCommands.delete(commandId)
        resolve({ accepted: false, error: 'the owner client did not answer in time' })
      }, PAGE_COMMAND_TIMEOUT_MS)
      this.pageCommands.set(commandId, { pageId: page.pageId!, resolve: (accepted, error) => { resolve({ accepted, ...(error === undefined ? {} : { error }) }) }, timer })
      this.broadcast({ kind: 'page-command', command: sent })
    })
    if (!answer.accepted) return reject(input.action === 'navigate' ? 'platform.page-unavailable' : 'platform.action-not-allowed', answer.error ?? 'the owner client refused the page action')
    return { callId, status: 'success', result: { accepted: true } }
  }

  /**
   * Resolve one cross-application object reference as the human. The owning
   * application's declared read operation runs with its normal permissions;
   * this method does not read business data itself.
   * @param ref - the reference to resolve.
   * @returns the display facts.
   */
  @Remote
  async resolveObject(ref: ObjectRef): Promise<ObjectResolution> {
    return await this.runtime.resolveObject({ kind: 'human' }, ref)
  }

  // ---- operation policies ---------------------------------------------------

  /** The user's operation-policy overrides currently in effect. */
  @Remote
  async policies(): Promise<readonly OperationPolicyEntry[]> {
    return await this.runtime.policiesOf()
  }

  /**
   * Set or clear (with `default`) one operation's user policy. The save must
   * succeed before this returns; a fully closed operation cannot be opened.
   * @param appId - the target application.
   * @param op - the operation.
   * @param policy - the override.
   * @returns the table after the change.
   */
  @Remote
  async setPolicy(appId: string, op: string, policy: OperationPolicy): Promise<readonly OperationPolicyEntry[]> {
    await this.runtime.setPolicy(appId, op, policy)
    return await this.runtime.policiesOf()
  }

  // ---- first-run onboarding ------------------------------------------------

  /** The host-side "already answered" record for the first-run permission cards. */
  @Remote
  async onboarding(): Promise<OnboardingState> {
    return await this.onboardingStore.load()
  }

  /**
   * Record that the human answered or postponed the first-run card for one
   * application at its current capability-set fingerprint. The stored answer is
   * a notification, never a grant.
   * @param appId - the application the card was about; it must be registered.
   * @param fingerprint - the fingerprint the card showed; a stale one is refused.
   * @returns the record after the write.
   */
  @Remote
  async markOnboardingSeen(appId: string, fingerprint: string): Promise<OnboardingState> {
    const registration = this.runtime.list().find((entry) => entry.declaration.id === appId)
    if (registration === undefined) throw new Error(`unknown application: ${appId}`)
    const current = fingerprintOf(registration.declaration)
    if (fingerprint !== current) throw new Error(`the onboarding fingerprint for ${appId} is stale`)
    return await this.onboardingStore.mark(appId, current)
  }

  // ---- out-of-session confirmation ------------------------------------------

  /**
   * The confirmations waiting for a human answer right now, in ask order. A
   * caller that needs confirmation and has no session dialog leaves its
   * question here; the call stays parked until a browser answers it (or the
   * call is cancelled, which ends the question).
   * @returns the pending confirmations (a copy).
   */
  @Remote
  pendingConfirmations(): readonly PendingConfirmation[] {
    return [...this.confirmations.values()].map((entry) => entry.request)
  }

  /**
   * Answer one pending confirmation. The waiting call re-checks its target
   * afterwards, so a revoke or a stop that happened during the wait still takes
   * effect.
   * @param id - the confirmation's id.
   * @param decision - allow this one call, allow it and remember the approval
   *   as a durable grant, or refuse it.
   * @returns whether a pending confirmation was answered (an unknown or already
   *   settled id answers `false` — a late answer never revives a decision).
   */
  @Remote
  answerConfirmation(id: string, decision: ConfirmationDecision): boolean {
    return this.settle(id, decision)
  }

  /**
   * Withdraw one pending confirmation. The waiting call does not run; this is
   * distinct from a denial because it records that the question itself was
   * abandoned (the user moved on, the call is no longer wanted).
   * @param id - the confirmation's id.
   * @returns whether a pending confirmation was withdrawn.
   */
  @Remote
  cancelConfirmation(id: string): boolean {
    return this.settle(id, 'cancelled')
  }

  /**
   * The runtime's confirmation channel. An AI call whose own session has a
   * live agent with an open turn asks through the platform's User Approval
   * service, so the question appears in that session's dialog and the answer is
   * audited on the session it belongs to. Every other call — an application, a
   * background job, an anonymous AI call, an idle session, a deployment
   * without the approval service — parks in the out-of-session table. The
   * ambient initiator is never the router: it is causal attribution, not the
   * caller's identity.
   *
   * Neither route may answer "allow" by default: a question nobody can hold,
   * and an approval service that cannot deliver the question, are both
   * `unavailable`, which the runtime reads as "the call does not run".
   * @param request - the runtime's request (caller, target, op, reason, signal).
   * @returns the answer the runtime acts on.
   */
  ask(request: ConfirmationRequest): Promise<ConfirmationAnswer> {
    // Background work has no interactive channel: a confirmation it cannot
    // receive must fail closed, never park for a browser answer it will not own.
    if (request.caller.kind === 'background') return Promise.resolve('unavailable')
    const inSession = this.askInSession(request)
    if (inSession !== undefined) return inSession
    return this.parkOutOfSession(request)
  }

  /**
   * The session-dialog route, when the CALLER is an AI whose own live session
   * has an open turn. The approval service demands an Agent whose session has an
   * open turn (its audit pair must be enclosed by the durable log's commit
   * boundary), so the question is offered here only under exactly that
   * precondition. The ambient initiator is deliberately not consulted: it
   * answers "who caused this", not "who is allowed to answer".
   * @param request - the runtime's request.
   * @returns the mapped answer, or `undefined` when this route does not apply
   *   and the caller must fall back to the browser table.
   */
  private askInSession(request: ConfirmationRequest): Promise<ConfirmationAnswer> | undefined {
    const approval = this.ctx.get('approval')
    const caller = request.caller
    // A synchronous peer call carries the source Session; background work
    // never does, and an anonymous AI call has no dialog of its own.
    /* v8 ignore next -- background work never reaches this route (ask() fails it closed first) */
    const sessionId = caller.kind === 'ai' || caller.kind === 'app' ? caller.sessionId : undefined
    const agent = sessionId === undefined
      ? undefined
      : this.ctx.get('agents')?.get?.(SessionId(sessionId))
    if (approval === undefined || agent === undefined || !hasOpenTurn(agent.session)) return undefined
    return this.requestApproval(approval, agent, request)
  }

  /**
   * Ask the platform's approval service and map its four outcomes to the
   * runtime's vocabulary: only `allowed-once` is a grant.
   * @param approval - the mounted approval service.
   * @param agent - the live agent resolved from the caller's own session.
   * @param request - the runtime's request.
   * @returns the answer the runtime acts on; an undeliverable question is `unavailable`.
   */
  private async requestApproval(approval: ApprovalService, agent: Agent, request: ConfirmationRequest): Promise<ConfirmationAnswer> {
    try {
      // The capability name the question carries (`<appId>#<op>`, or
      // `capability:<name>` for a platform capability) is what the approval
      // names: the audit and the dialog speak the runtime's own vocabulary,
      // and the reason sentence says the same thing in words.
      const outcome = await approval.request({
        agent,
        toolName: request.capability,
        reason: request.reason,
        signal: request.signal,
      })
      if (outcome === 'allowed-once') return 'allowed-once'
      if (outcome === 'rejected') return 'denied'
      if (outcome === 'cancelled') return 'cancelled'
      return 'unavailable'
    } catch (error) {
      // A question the platform refused to put (no open turn any more, a
      // failed audit append) was never answered: the call does not run.
      this.ctx.logger.warn(`application confirmation through the session could not be asked: ${String(error)}`)
      return 'unavailable'
    }
  }

  /**
   * The out-of-session route: park one request until a browser answers it, and
   * report `unavailable` when the table is full — the call then does not run
   * (never "runs unconfirmed").
   * @param request - the runtime's request (caller, target, op, reason, signal).
   * @returns the answer the runtime acts on.
   */
  private parkOutOfSession(request: ConfirmationRequest): Promise<ConfirmationAnswer> {
    if (this.confirmations.size >= CONFIRMATION_CAPACITY) {
      this.ctx.logger.warn(`application confirmation refused: ${String(CONFIRMATION_CAPACITY)} confirmations are already waiting for an answer`)
      return Promise.resolve('unavailable')
    }
    const id = `confirmation-${String(++this.serial)}`
    const settled = Promise.withResolvers<ConfirmationAnswer>()
    const abort = (): void => { this.settle(id, 'cancelled') }
    const pending: PendingConfirmation = {
      id,
      caller: request.caller,
      capability: request.capability,
      reason: request.reason,
      at: new Date().toISOString(),
    }
    this.confirmations.set(id, { request: pending, signal: request.signal, abort, settle: settled.resolve })
    request.signal.addEventListener('abort', abort, { once: true })
    // A request that arrives already cancelled must not wait for an answer that
    // can no longer come (adding the listener fired nothing): end it here —
    // quietly, because no question was ever announced for anyone to answer.
    if (request.signal.aborted) {
      this.confirmations.delete(id)
      request.signal.removeEventListener('abort', abort)
      settled.resolve('cancelled')
      return settled.promise
    }
    this.broadcast({ kind: 'confirmation', action: 'asked', request: pending })
    return settled.promise
  }

  /**
   * End one pending confirmation: drop it from the table, hand the answer to
   * the waiting call, and broadcast that it ended.
   * @param id - the confirmation's id.
   * @param outcome - the user's answer, or `cancelled` when the wait was ended
   *   (the caller cancelled, or the application stopped — the runtime reports
   *   that as `confirmation-unavailable`, since no channel answered).
   * @returns whether an entry was there to settle.
   */
  private settle(id: string, outcome: ConfirmationOutcome): boolean {
    const entry = this.confirmations.get(id)
    if (entry === undefined) return false
    this.confirmations.delete(id)
    entry.signal.removeEventListener('abort', entry.abort)
    entry.settle(outcome)
    this.broadcast({ kind: 'confirmation', action: 'settled', id, outcome })
    return true
  }

  // ---- the watch stream ------------------------------------------------------

  /**
   * Open the watch stream: a ready frame with the application list right at
   * open, then one frame per change (`{ kind: 'changed' }`), progress report and
   * confirmation event. The stream ends when the caller cancels it (the
   * carrier's signal) or the bridge unloads.
   * @param signal - the carrier's own cancellation for this stream.
   * @returns the frames, in the order the host produced them.
   */
  @Remote({ mode: 'stream' })
  watch(signal?: AbortSignal): AsyncIterable<WatchEvent> {
    const queue = new WatchQueue()
    this.watchers.add(queue)
    queue.push({ kind: 'ready', apps: this.rows() })
    return queue.iterate(signal, () => { this.watchers.delete(queue) })
  }

  /** Push one event to every open watch stream. */
  private broadcast(event: WatchEvent): void {
    for (const watcher of this.watchers) watcher.push(event)
  }

  /**
   * Everything one application's declaration says it needs, named the way a
   * grant records it (see {@link AppInfo.needs}). Only operations whose target
   * is actually open to peers count: proposing a call the runtime would refuse
   * regardless would offer the user an approval that can never take effect.
   */
  private needsOf(declaration: AppDeclaration): readonly string[] {
    const needs = (declaration.capabilities ?? []).map((name) => platformCapability(name))
    for (const subscription of declaration.subscriptions ?? []) {
      const source = this.runtime.list().find((entry) => entry.declaration.id === subscription.appId)
      const event = source?.declaration.events?.[subscription.type]
      if (event?.subscription !== 'open') continue
      needs.push(eventCapability(subscription.appId, subscription.type))
    }
    return needs
  }

  /** Every application as a browser row, in registration order. */
  private rows(): readonly AppInfo[] {
    return this.runtime.list().map((registration: AppRegistration) => {
      const { declaration } = registration
      const failure = registration.failure()
      const reason = registration.reason()
      return {
        id: declaration.id,
        name: declaration.name,
        description: declaration.description,
        version: declaration.version,
        ...(this.modelSelections.get(declaration.id) === undefined ? {} : { model: this.modelSelections.get(declaration.id)! }),
        status: registration.status(),
        runtime: runtimeStateOf(registration.status()),
        activation: registration.activation(),
        health: registration.health(),
        ...(reason === undefined ? {} : { reason }),
        ...(failure === undefined ? {} : { failure }),
        needs: this.needsOf(declaration),
        ...(declaration.calls === undefined && declaration.subscriptions === undefined ? {} : {
          connections: [
            ...(declaration.calls ?? []).map((call) => {
              const target = typeof call === 'string' ? call : call.app
              const ops = declaredCallOps(declaration, target)!
              return { kind: 'call' as const, target, ops, available: this.runtime.list().some(entry => entry.declaration.id === target) }
            }),
            ...(declaration.subscriptions ?? []).map((subscription) => {
              const source = this.runtime.list().find(entry => entry.declaration.id === subscription.appId)
              const event = source?.declaration.events?.[subscription.type]
              return {
                kind: 'subscription' as const,
                publisher: subscription.appId,
                event: subscription.type,
                open: event?.subscription === 'open',
                available: event !== undefined,
              }
            }),
          ],
        }),
        ...(declaration.data === undefined ? {} : { data: declaration.data }),
        ops: Object.entries(declaration.ops).map(([name, op]) => ({
          name,
          description: op.description,
          params: op.params,
          exposure: op.exposure ?? {},
        })),
        ...(declaration.events === undefined ? {} : {
          events: Object.entries(declaration.events).map(([type, event]) => ({
            type,
            description: event.description,
            subscription: event.subscription ?? 'closed',
          })),
        }),
        ...(declaration.process === undefined ? {} : { process: declaration.process.commands }),
        ...(declaration.pages === undefined ? {} : {
          pages: Object.entries(declaration.pages).map(([view, page]) => ({
            view,
            description: page.description,
            actions: page.actions ?? ['navigate', 'set-filters', 'select'],
          })),
        }),
        ...(declaration.objectTypes === undefined ? {} : {
          objectTypes: Object.entries(declaration.objectTypes).map(([type, entry]) => ({
            type,
            ...(entry.description === undefined ? {} : { description: entry.description }),
            resolveOperation: entry.resolveOperation,
          })),
        }),
      }
    })
  }

  /**
   * The row unloaded: close every watch stream, then stop every application the
   * runtime still runs (this is a real disposal, not a bookkeeping sweep — a
   * `stop-incomplete` is reported by the runtime, never hidden here).
   */
  private async shutdown(): Promise<void> {
    for (const watcher of [...this.watchers]) watcher.close()
    this.watchers.clear()
    for (const [commandId, pending] of this.pageCommands) {
      clearTimeout(pending.timer)
      this.pageCommands.delete(commandId)
      pending.resolve(false, 'the host is shutting down')
    }
    for (const registration of this.runtime.list()) await this.runtime.stop(registration.declaration.id)
    // Stop emits the final task/history rows; flush after the stops so a
    // graceful unload does not lose the last records in the append queues.
    /* v8 ignore next 4 -- a flush failure is best-effort logging and has no deterministic trigger */
    await Promise.all([
      this.historyFile.flush().catch((error: unknown) => { this.ctx.logger.warn(`call history flush failed: ${String(error)}`) }),
      this.taskFile.flush().catch((error: unknown) => { this.ctx.logger.warn(`task projection flush failed: ${String(error)}`) }),
    ])
  }
}

/** The plugin body: the loader mounts this class (its Config validates the row). */
export default ApplicationBridge

/**
 * Whether one session currently sits inside an open turn — a `turn/start` not
 * yet closed by a `turn/end`. The approval service requires exactly this
 * precondition (its ask/answer audit pair must be enclosed by the log's
 * commit/replay boundary) and does not export its check, so the bridge asks
 * the same question of the same log before choosing the in-session route.
 * @param session - the session to read.
 * @returns whether an open turn is the log's current tail state.
 */
function hasOpenTurn(session: Session): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- the same synchronous tail read the approval service makes
    const type = session.eventAt(SessionSeq(seq))?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/** One signal that aborts when either input does. */
function combinedSignal(signal: AbortSignal | undefined, own: AbortSignal): AbortSignal {
  return signal === undefined ? own : AbortSignal.any([signal, own])
}

/**
 * One open watch stream: a single-consumer push queue. Frames pushed before the
 * consumer's first read wait in order; `close` ends the stream after everything
 * already queued has been delivered; the abort signal ends it too (the
 * platform's stream carrier aborts for the client, so an abandoned consumer
 * still releases its slot).
 */
class WatchQueue {
  private readonly queue: WatchEvent[] = []
  private wake: (() => void) | undefined
  private ended = false

  /**
   * Queue one frame for the consumer. A consumer that falls more than
   * {@link WATCH_QUEUE_CAPACITY} frames behind loses the backlog: the queue is
   * replaced by one reset frame, and the client re-reads the derived state
   * (rows, grants, confirmations, view data) instead of growing without bound.
   * @param event - the frame to deliver.
   */
  push(event: WatchEvent): void {
    if (this.queue.length >= WATCH_QUEUE_CAPACITY) {
      this.queue.length = 0
      this.queue.push({ kind: 'reset', reason: 'slow-consumer' })
    } else {
      this.queue.push(event)
    }
    this.wakeUp()
  }

  /** End this stream after its queued frames are delivered. */
  close(): void {
    this.ended = true
    this.wakeUp()
  }

  /**
   * The consumer's view of this queue.
   * @param signal - the caller's cancellation; an aborted signal ends the stream.
   * @param onEnd - called once when the stream ends, however it ends.
   * @returns the frames in arrival order.
   */
  async *iterate(signal: AbortSignal | undefined, onEnd: () => void): AsyncGenerator<WatchEvent> {
    const wake = (): void => { this.wakeUp() }
    signal?.addEventListener('abort', wake)
    try {
      while (true) {
        const next = this.queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (this.ended || signal?.aborted === true) return
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', wake)
      onEnd()
    }
  }

  /** Release a pending read, if any. */
  private wakeUp(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** Map the detailed lifecycle status onto the four public runtime states. */
function runtimeStateOf(status: AppStatus): RuntimeState {
  if (status === 'available') return 'ready'
  if (status === 'starting') return 'starting'
  if (status === 'stopping' || status === 'stop-incomplete') return 'stopping'
  return 'stopped'
}

/** The capability-set fingerprint the first-run card is keyed by (the same one the client computes). */
function fingerprintOf(declaration: AppDeclaration): string {
  return [...(declaration.capabilities ?? [])].map((name) => platformCapability(name)).sort().join('|')
}

export { AppSecretStore } from './secrets.ts'

export { createPlatformModelPort, ModelCallError, ModelUnavailableError } from './model.ts'
export type { ModelAskRequest, ModelAskResult, ModelCallCode, ModelPort } from './model.ts'
