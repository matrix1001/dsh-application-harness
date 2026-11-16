/**
 * The Cordis face of the application runtime: one service
 * (`ctx.applicationRuntime`) holding the registry, the call path and the
 * lifecycle. The plugin itself carries no rules — that is `ApplicationRuntime`,
 * which is Cordis-free so the whole rule book is testable with fakes; this
 * module only binds it to a context and hands it the row config.
 *
 * The host wires the outside world into it (confirmation channel, durable
 * grants, history sink) through the `use*` methods; every port has a safe
 * absence — no confirmation channel means a call that needs confirmation does
 * not run, never that it runs unconfirmed.
 * @module @matrix1001/dsh-application-harness-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ApplicationRuntime } from './runtime.ts'
import type { AppRegistration } from './runtime.ts'
import type { AppDeclaration } from './types.ts'
import { MemoryHistory } from './history.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The applications this host runs, registered by this plugin. Optional: a
     * composition that mounts nothing else still boots without it, and every
     * reader treats absence as a real case rather than inventing an empty
     * registry.
     *
     * (The key is `applications`, not `applicationRuntime`: the old anchor
     * still owns that name until it is retired, and two incompatible
     * declarations of one Context key cannot coexist in a program.)
     */
    applications?: ApplicationRuntime
  }
}

/** The `application-runtime` row's config. */
export interface ApplicationRuntimeConfig {
  /** Stop wait budget in milliseconds (work outliving it reports stop-incomplete). */
  stopBudgetMs?: number
}

/** The plugin name (the row id in a composition). */
export const name = 'application-runtime'

/** The row config schema: validated before the plugin starts (fail loud). */
export const Config = Schema.object({
  stopBudgetMs: Schema.number(),
})

/**
 * Provide the runtime service. The service value is the runtime itself, so
 * callers use `ctx.applicationRuntime.call(...)` exactly as they would the
 * standalone class.
 * @param ctx - the Cordis context.
 * @param config - the validated row config.
 */
export function apply(ctx: Context, config: ApplicationRuntimeConfig): void {
  const runtime = new ApplicationRuntime({
    ...(config.stopBudgetMs === undefined ? {} : { stopBudgetMs: config.stopBudgetMs }),
    onProblem: (problem) => { ctx.logger.warn(problem) },
  })
  // Basic operation history is part of what this row mounts: the runtime alone
  // keeps none (its ports have a safe absence), so without a sink here the
  // host records nothing and `applicationBridge.history()` answers empty for
  // ever (the D5 defect). The window is bounded and in memory on purpose — the
  // row has no data path, and a deployment that wants history durable installs
  // its own sink through `ctx.applications.useHistory` before the first call.
  runtime.useHistory(new MemoryHistory())
  ctx.provide('applications', runtime)
}

/**
 * Mount one application on the composition's runtime and tie its life to the
 * calling row: registration now, `stop` + `unregister` when the row unloads.
 * The unload is a real disposal, not a bookkeeping sweep — an application whose
 * work outlives its stop budget keeps its registration (so a second load of the
 * same id is refused while the old instance is genuinely still running) and is
 * dropped the moment that work really ends. Without the unregister a row that
 * is unloaded and mounted again would fail with "already registered".
 *
 * The tie is installed in the SAME synchronous turn as the mount, BEFORE the
 * start can settle: a row unloaded while its application is still starting must
 * cancel that start (the runtime's stop reaches a start in flight, and its
 * budget covers the whole stop), not wait for it and leave a half-started
 * application callable behind. A mount that throws — a duplicate id — installs
 * nothing, so this row's unload can never release a different instance of the
 * same id.
 *
 * The row does not wait for the start: the application is `starting` until its
 * start hook settles (a call made then is `unavailable`, and the panel shows
 * the state), which is the application's own work rather than the row's load.
 * @param ctx - the calling row's context (with the runtime injected).
 * @param declaration - the application declaration.
 * @returns the registration handle, once the application is mounted.
 */
export async function mountApplication(ctx: Context, declaration: AppDeclaration): Promise<AppRegistration> {
  const runtime = ctx.applications
  if (runtime === undefined) throw new Error(`application ${declaration.id} requires the application runtime (ctx.applications)`)
  const registration = runtime.mount(declaration)
  ctx.effect(() => async () => {
    const status = await runtime.stop(declaration.id)
    const dropped = runtime.unregister(declaration.id)
    if (!dropped) {
      ctx.logger.warn(`application ${declaration.id} was still ${status} when its row unloaded; it stays registered until its work ends`)
    }
  })
  return registration
}

export { ApplicationRuntime, AppError, assertDeclarable, declaredCallOps, DEFAULT_RECENT_HISTORY, DEFAULT_STOP_BUDGET_MS } from './runtime.ts'
export { defineOperation } from './define.ts'
export type { DefinedOperation } from './define.ts'
export { eventCapability, opCapability, platformCapability } from './types.ts'
// The platform's schema vocabulary the declarations are written in: an
// application author imports it from here, next to the declaration types.
export type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
export type {
  AppRegistration, ConfirmationAnswer, ConfirmationPort, ConfirmationRequest, ChangeListener,
  GrantStorePort, HistoryRecord, HistorySink, MaintenanceLease, RuntimeOptions, SecretStorePort,
} from './runtime.ts'
export type {
  TaskCancelResult, TaskContext, TaskDescriptor, TaskError, TaskHandle, TaskId, TaskNotice, TaskOrigin,
  TaskProgress, TaskSnapshot, TaskState, TaskWork,
} from './types.ts'
export { BoundedHistoryQueue, MemoryHistory } from './history.ts'
export { ProgressReporter, SingleFlight, TaskReceipts, runPeriodically } from './task-helpers.ts'
export type { PendingProgress, PeriodicOptions } from './task-helpers.ts'
export type { HistoryQueueOptions, HistoryReader, HistoryStore } from './history.ts'
export type {
  Activation, AppCall, AppChangeNotice, AppContext, AppDataDeclaration, AppDataKind, AppDeclaration, AppHealth, AppId, AppReason, AppSecretAccess, AppStatus, CallOutcome, Caller, CapabilityAccess,
  CapabilityGrant, CapabilityVerdict, Exposure, FailureCode, OpExposure, OpName,
  AppEvent, AppEventDeclaration, AppEventListener, EventSubscription, RuntimeState, ProcessCommandDeclaration, PageActionName, PageDeclaration, ObjectRef, ObjectResolution, ObjectTypeDeclaration, OperationContext, OperationDeclaration, OperationEffect, OperationPolicy, OperationPolicyEntry, OutcomeError, PermissionRequest, PermissionVerdict, PolicyStorePort, ProgressNotice, RejectionCode,
} from './types.ts'
