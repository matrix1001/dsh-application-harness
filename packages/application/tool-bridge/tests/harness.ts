/**
 * The shared test host: the REAL application runtime, mounted through its own
 * plugin, with the REAL tool bridge on top of it and a stub tool registry that
 * reproduces the platform registry's contract — a duplicate name fails loud,
 * and the returned disposer is the exact unregistration.
 *
 * Applications mount the way the deployment mounts them: their own plugin row
 * registers the declaration and stops the application again when the row
 * unloads. Nothing here fakes a change notice the runtime does not emit.
 */

import { Context } from '@deepseek-ai/cordis'
import { AppError, apply as applyRuntime, mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import type { ApplicationRuntime, AppDeclaration } from '@matrix1001/dsh-application-harness-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition, ToolRegistrationOptions, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as ToolBridge from '../src/index.ts'
import { APPLICATIONS_TOOL } from '../src/index.ts'

/** The stub tool registry: names in, definitions out, duplicates refused. */
export class StubTools {
  /** Every currently registered definition, by name. */
  readonly definitions = new Map<string, ToolDefinition>()
  /** The registration options each definition was installed with, by name. */
  readonly options = new Map<string, ToolRegistrationOptions | undefined>()
  /** Names another package already owns; a registration for one fails like the real registry. */
  readonly occupied = new Set<string>()

  /**
   * Register one definition.
   * @param definition - the tool definition.
   * @param options - the registration options (the step-time visibility condition).
   * @returns the exact disposer that unregisters it.
   */
  register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void {
    if (this.definitions.has(definition.name) || this.occupied.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`)
    }
    this.definitions.set(definition.name, definition)
    this.options.set(definition.name, options)
    return () => {
      this.definitions.delete(definition.name)
      this.options.delete(definition.name)
    }
  }

  /** One registered definition, by name. */
  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name)
  }

  /** Every registered name, in registration order. */
  names(): string[] {
    return [...this.definitions.keys()]
  }
}

/** One mounted test host. */
export interface ToolHost {
  readonly ctx: Context
  readonly runtime: ApplicationRuntime
  readonly tools: StubTools
  /** Everything the bridge warned about, in order. */
  readonly warnings: string[]
  /** Put applications into one ordinary Session's current-turn scope. */
  readonly allow: (sessionId: string, appIds: readonly string[]) => void
  /** Mark one Session as an application/development conversation (all apps). */
  readonly mark: (sessionId: string) => void
  /** Set the current page context for one Session. */
  readonly setPage: (sessionId: string, page: unknown) => void
  /** Mark one Session as a development conversation bound to one application. */
  readonly markDevelopment: (sessionId: string, appId: string) => void
}

/** One application row, the way the deployment mounts applications. */
export interface AppRow {
  name: string
  inject: string[]
  apply(ctx: Context): Promise<void>
}

/**
 * The plugin row one application mounts as: it registers the declaration and
 * stops the application again when the row unloads.
 * @param declaration - the application declaration.
 * @returns the row plugin.
 */
export function appRow(declaration: AppDeclaration): AppRow {
  return {
    name: `row-${declaration.id}`,
    inject: ['applications'],
    async apply(ctx: Context): Promise<void> {
      await mountApplication(ctx, declaration)
    },
  }
}

/**
 * Mount the host (runtime + bridge + stub registry). Applications are NOT
 * registered here: a test mounts each one through {@link appRow} or
 * `runtime.register`, so which trigger picked it up stays visible.
 * @param occupied - names another package already owns before the bridge mounts.
 * @returns the host.
 */
export async function host(occupied: readonly string[] = []): Promise<ToolHost> {
  const ctx = new Context()
  const tools = new StubTools()
  for (const name of occupied) tools.occupied.add(name)
  const warnings: string[] = []
  ctx.logger.warn = ((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn
  ctx.reflect.provide('tools', tools as never)
  const scopes = new Map<string, Set<string>>()
  const pages = new Map<string, unknown>()
  ctx.reflect.provide('appReadScope', {
    allows: (sessionId: string, appId: string) => scopes.get(sessionId)?.has(appId) ?? false,
    list: (sessionId: string) => [...(scopes.get(sessionId) ?? [])],
  } as never)
  ctx.reflect.provide('appConversationContext', {
    get: (sessionId: string) => pages.get(sessionId),
  } as never)
  applyRuntime(ctx, {})
  const fiber = ctx.plugin(ToolBridge, {})
  await fiber
  const runtime = ctx.applications
  if (runtime === undefined) throw new Error('test host: the runtime did not mount')
  return {
    ctx,
    runtime,
    tools,
    warnings,
    allow: (sessionId, appIds) => { scopes.set(sessionId, new Set(appIds)) },
    mark: (sessionId) => { (ctx.get('appTools') as { mark(id: string): void } | undefined)?.mark(sessionId) },
    setPage: (sessionId, page) => { pages.set(sessionId, page) },
    markDevelopment: (sessionId, appId) => { (ctx.get('appTools') as { markDevelopment(id: string, app: string): void } | undefined)?.markDevelopment(sessionId, appId) },
  }
}

/** One tool execution as the platform hands it to a tool body. */
export function execution(over: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'test',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('test-token'),
    deferContext: () => {},
    concludeTurn: () => {},
    ...over,
  } as unknown as ToolRunContext
}

/** One tool execution as a specific Session. */
export function sessionExecution(sessionId: string, over: Partial<ToolRunContext> = {}): ToolRunContext {
  return execution({ agent: { session: { id: sessionId } }, ...over } as Partial<ToolRunContext>)
}

/** Run the unified application tool for one Session. */
export async function runApplicationTool(
  hostTools: StubTools,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<JsonValue> {
  const tool = hostTools.get(APPLICATIONS_TOOL)
  if (tool === undefined) throw new Error(`test host: no "${APPLICATIONS_TOOL}" tool is registered`)
  return await tool.execute(input, sessionExecution(sessionId)) as JsonValue
}

/**
 * The demo application: one AI-open operation (`echo`), one AI-confirmed
 * (`secret`), one closed (`hidden`), one that fails with a business code
 * (`boom`) and one that waits for its cancellation (`slow`).
 * @param id - the application id.
 * @param over - declaration overrides.
 * @returns the declaration.
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
        exposure: { ai: 'open' },
        effect: 'read',
        execute: (args) => args,
      },
      secret: {
        description: 'reads something the user must approve',
        params: {},
        result: { type: 'json' },
        exposure: { ai: 'confirm' },
        execute: () => ({ secret: 42 }),
      },
      hidden: {
        description: 'the AI may not call this',
        params: {},
        result: { type: 'json' },
        execute: () => ({ hidden: true }),
      },
      closedRead: {
        description: 'a read whose exposure is closed',
        params: {},
        result: { type: 'json' },
        effect: 'read',
        execute: () => ({ closed: true }),
      },
      boom: {
        description: 'fails with a business code',
        params: {},
        result: { type: 'json' },
        exposure: { ai: 'open' },
        execute: () => { throw new AppError('stale-version', 'the note changed') },
      },
      slow: {
        description: 'waits for its cancellation signal',
        params: {},
        result: { type: 'json' },
        exposure: { ai: 'open' },
        execute: (_args, opCtx) => new Promise((_resolve, reject) => {
          const cancelled = (): void => {
            const error = new Error('the call was cancelled')
            error.name = 'AbortError'
            reject(error)
          }
          if (opCtx.signal.aborted) { cancelled(); return }
          opCtx.signal.addEventListener('abort', cancelled, { once: true })
        }),
      },
    },
    ...over,
  }
}

/** An AbortError as the platform raises it (the runtime maps it to `cancelled`). */
export function abortError(): Error {
  const error = new Error('cancelled from the test')
  error.name = 'AbortError'
  return error
}
