/**
 * The shared test host: the REAL application runtime, mounted through its own
 * plugin, with the real host bridge on top of it. Nothing is faked except the
 * Typert transport itself — every assertion drives the service methods the
 * Remote face calls, and the runtime underneath is the one production runs.
 *
 * The bridge is mounted as a plugin fiber so a test can unload the row
 * (`dispose`), which is what the deployment does when the composition stops.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AppError, apply as applyRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { AppDeclaration } from '@matrix1001/dsh-application-harness-runtime/types'
import ApplicationBridge from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** One host: the runtime, the bridge and the fiber that owns them. */
export interface Host {
  readonly ctx: Context
  readonly runtime: ApplicationRuntime
  readonly bridge: ApplicationBridge
  /**
   * The durable grant table this host was mounted with — a fresh file in a
   * per-host temp directory, so a test never reads or writes the developer's
   * own harness home and a case can re-mount over the SAME table to prove
   * persistence.
   */
  readonly grantsPath: string
  /** The durable operation-policy table this host was mounted with. */
  readonly policiesPath: string
  /** The durable disabled-application set this host was mounted with. */
  readonly activationPath: string
  /** The development-session record this host was mounted with. */
  readonly developmentPath: string
  /** The first-run record this host was mounted with (a fresh file beside the grants). */
  readonly onboardingPath: string
  /** The durable call-history file this host was mounted with. */
  readonly historyPath: string
  /** The durable task-projection file this host was mounted with. */
  readonly tasksPath: string
  /** The secret store this host was mounted with. */
  readonly secretsPath: string
  /** The unified store path this host's data page reads. */
  readonly dataPath: string
  /** The host-owned application-conversation record path. */
  readonly conversationPath: string
  /** Unload the row: the bridge stops every application and closes its streams. */
  readonly dispose: () => Promise<void>
}

/** The optional platform services the in-session confirmation route resolves through. */
export interface SessionServices {
  /** The `ctx.approval` service the route asks, when it is mounted. */
  readonly approval?: {
    request(request: ApprovalAsk): Promise<string>
  }
  /**
   * The `ctx.agents` service the route resolves the caller's own live agent
   * from, when it is mounted. `currentInitiator` stays on the fake only so a
   * case can prove the route ignores it.
   */
  readonly agents?: {
    get?(id: unknown): unknown
    currentInitiator?(): unknown
  }
}

/** One recorded `approval.request` argument object. */
export interface ApprovalAsk {
  agent?: unknown
  toolName?: string
  reason?: string
  signal?: AbortSignal
}

/** How one test wants its host built. */
export interface HarnessOptions {
  /**
   * Mount the bridge over this grant table instead of a fresh temp file — the
   * seam a case uses to stage a corrupt, unwritable or shared table. `null`
   * mounts with NO path configured, i.e. the row's own default under the
   * harness home (only for the case that asserts that default, with `DSH_HOME`
   * pointed at a temp home first).
   */
  readonly grantsPath?: string | null
  /** Mount the bridge over this policy table instead of a fresh temp file. */
  readonly policiesPath?: string
  /** Mount the bridge over this disabled-application set. */
  readonly activationPath?: string
  /** Mount the bridge over this development-session record. */
  readonly developmentPath?: string
  /** Mount the bridge over this model-selection table. */
  readonly modelSelectionsPath?: string
  /** Mount the bridge over this model-usage table. */
  readonly modelUsagePath?: string
  /** Mount the bridge over this model-limits table. */
  readonly modelLimitsPath?: string
  /**
   * Mount the bridge over this first-run record instead of a fresh temp file.
   * Absent = a temp file beside the grants, so a test never touches the
   * developer's harness home.
   */
  readonly onboardingPath?: string
  /** Mount the bridge over this call-history file instead of a fresh temp file. */
  readonly historyPath?: string
  /** Mount the bridge over this task-projection file instead of a fresh temp file. */
  readonly tasksPath?: string
  /** Mount the bridge over this secret store instead of a fresh temp file. */
  readonly secretsPath?: string
  /** Mount the bridge over this unified-store database (null = omit the config and use the row default). */
  readonly dataPath?: string | null
  /** Mount the bridge over this application-conversation record. */
  readonly conversationPath?: string
}

/**
 * Mount a host with the given applications registered.
 * @param apps - the application declarations to register, in order.
 * @param services - the optional `ctx.approval` / `ctx.agents` fakes the
 *   in-session confirmation route resolves; absent means the deployment has
 *   neither, and the route must fall back to the browser table.
 * @param options - the grant-table override (absent = a fresh temp file).
 * @returns the host.
 */
export async function host(apps: readonly AppDeclaration[] = [], services: SessionServices = {}, options: HarnessOptions = {}): Promise<Host> {
  const ctx = new Context()
  if (services.approval !== undefined) ctx.reflect.provide('approval', services.approval as never)
  if (services.agents !== undefined) ctx.reflect.provide('agents', services.agents as never)
  applyRuntime(ctx, {})
  // The bridge mounts with its DEFAULT grant-table location in production; a
  // test must never write the developer's harness home, so every host gets its
  // own temp directory and names it explicitly (the config is the seam). A case
  // that stages a corrupt or unwritable table overrides the path itself.
  const home = options.grantsPath === undefined ? mkdtempSync(join(tmpdir(), 'application-harness-bridge-')) : undefined
  // Conversation identity and the data page are NEVER mounted over the
  // developer's real harness home: unlike the file-backed grants, a test that
  // clears a conversation or inspects data would delete/read live state.
  const stateHome = mkdtempSync(join(tmpdir(), 'application-harness-state-'))
  const grantsPath = options.grantsPath === null
    ? dshHomePath('application-harness/grants.json')
    : (options.grantsPath ?? join(home!, 'grants.json'))
  const policiesPath = options.policiesPath ?? (home === undefined ? dshHomePath('application-harness/policies.json') : join(home, 'policies.json'))
  const activationPath = options.activationPath ?? (home === undefined ? dshHomePath('application-harness/activation.json') : join(home, 'activation.json'))
  const developmentPath = options.developmentPath ?? (home === undefined ? dshHomePath('application-harness/development.json') : join(home, 'development.json'))
  const modelSelectionsPath = options.modelSelectionsPath ?? (home === undefined ? dshHomePath('application-harness/model-selections.json') : join(home, 'model-selections.json'))
  const modelUsagePath = options.modelUsagePath ?? (home === undefined ? dshHomePath('application-harness/model-usage.json') : join(home, 'model-usage.json'))
  const modelLimitsPath = options.modelLimitsPath ?? (home === undefined ? dshHomePath('application-harness/model-limits.json') : join(home, 'model-limits.json'))
  const onboardingPath = options.onboardingPath
    ?? (home === undefined ? dshHomePath('application-harness/onboarding.json') : join(home, 'onboarding.json'))
  const historyPath = options.historyPath
    ?? (home === undefined ? dshHomePath('application-harness/history.jsonl') : join(home, 'history.jsonl'))
  const tasksPath = options.tasksPath
    ?? (home === undefined ? dshHomePath('application-harness/tasks.jsonl') : join(home, 'tasks.jsonl'))
  const secretsPath = options.secretsPath
    ?? (home === undefined ? dshHomePath('application-harness/secrets.json') : join(home, 'secrets.json'))
  const configuredDataPath = options.dataPath === null ? undefined : (options.dataPath ?? join(stateHome, 'app-data.sqlite'))
  const conversationPath = options.conversationPath ?? join(stateHome, 'app-conversation.json')
  const config: Config = {
    ...(options.grantsPath === null ? {} : { grantsPath, policiesPath, activationPath, developmentPath, modelSelectionsPath, modelUsagePath, modelLimitsPath, onboardingPath, historyPath, tasksPath, secretsPath }),
    ...(configuredDataPath === undefined ? {} : { dataPath: configuredDataPath }),
    conversationPath,
  }
  const fiber = ctx.plugin(ApplicationBridge, config)
  await fiber
  const runtime = ctx.applications
  const bridge = ctx.applicationBridge
  if (runtime === undefined || bridge === undefined) throw new Error('host bridge test: the host did not mount')
  for (const declaration of apps) await runtime.register(declaration)
  return {
    ctx,
    runtime,
    bridge,
    grantsPath,
    policiesPath,
    activationPath,
    developmentPath,
    onboardingPath,
    historyPath,
    tasksPath,
    secretsPath,
    dataPath: configuredDataPath ?? dshHomePath('application-harness/app-data.sqlite'),
    conversationPath,
    dispose: async () => {
      await ctx.fiber.dispose()
      if (home !== undefined) rmSync(home, { recursive: true, force: true })
      rmSync(stateHome, { recursive: true, force: true })
    },
  }
}

/**
 * One application whose ops cover the shapes this surface carries:
 *
 * - `echo` returns its arguments (so a caller sees what the operation received);
 * - `touch` declares that the application's data changed;
 * - `tick` reports progress;
 * - `slow` waits, cooperatively, for its cancellation signal;
 * - `boom` fails with a business code.
 *
 * `secret` is the same shape with AI confirmation exposure: a call from an AI
 * needs the user's consent, which is what the bridge's confirmation channel is
 * for.
 */
export function demoApp(id = 'demo', over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} application`,
    version: '1.2.3',
    ops: {
      echo: {
        description: 'returns its arguments',
        params: { text: { type: 'string', required: true } },
        result: { type: 'json' },
        execute: (args) => args,
      },
      touch: {
        description: 'declares that the data changed',
        params: {},
        result: { type: 'json' },
        execute: (_args, ctx) => { ctx.notifyChanged(); return { touched: true } },
      },
      tick: {
        description: 'reports progress and returns',
        params: {},
        result: { type: 'json' },
        execute: (_args, ctx) => { ctx.reportProgress('halfway', { done: 1 }); return { ran: true } },
      },
      slow: {
        description: 'waits for its cancellation signal',
        params: {},
        result: { type: 'json' },
        execute: (_args, ctx) => new Promise((_resolve, reject) => {
          const cancelled = (): void => { reject(abortError()) }
          if (ctx.signal.aborted) { cancelled(); return }
          ctx.signal.addEventListener('abort', cancelled, { once: true })
        }),
      },
      boom: {
        description: 'fails with a business code',
        params: {},
        result: { type: 'json' },
        execute: () => { throw new AppError('stale-version', 'the note changed') },
      },
    },
    ...over,
  }
}

/** An AbortError as the platform raises it: the runtime maps it to `cancelled`. */
export function abortError(): Error {
  const error = new Error('the call was cancelled')
  error.name = 'AbortError'
  return error
}

/** A demo whose echo/tick are open to AI and peers (the grant-table tests). */
export function openDemoApp(id = 'demo'): AppDeclaration {
  const base = demoApp(id)
  return {
    ...base,
    ops: {
      ...base.ops,
      echo: { ...base.ops.echo!, exposure: { ai: 'open', peers: 'open' } },
      tick: { ...base.ops.tick!, exposure: { ai: 'open', peers: 'open' } },
    },
  }
}

/** An application whose op needs the user's consent before an AI may run it. */
export function secretApp(id = 'secret-app'): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} application`,
    version: '1.0.0',
    ops: {
      secret: {
        description: 'reads something the user must approve',
        params: {},
        result: { type: 'json' },
        exposure: { ai: 'confirm' },
        execute: () => ({ secret: 42 }),
      },
    },
  }
}

/** An application whose start throws: it stays visible and uncallable. */
export function brokenApp(id = 'broken'): AppDeclaration {
  return {
    ...demoApp(id),
    start: () => { throw new Error('no storage') },
  }
}

/** Wait a few macrotask turns, so a call that was started has really begun. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Wait until `probe` holds, up to a bound. `settle`'s fixed turn count is a
 * guess about how much work a started call needs (the grant table is a FILE
 * read before the question can park), and a slower run — coverage, a loaded
 * machine — outruns it: a spec that asserts on a parked question polls for the
 * fact instead of sleeping a guessed interval.
 * @param probe - what to wait for.
 * @param timeoutMs - how long to wait before giving up (the assertion then says so).
 */
export async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() >= deadline) return
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}
