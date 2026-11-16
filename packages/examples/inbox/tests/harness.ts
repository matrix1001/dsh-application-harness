/**
 * The inbox spec harness: the real application runtime and store, the inbox row
 * mounted through its own plugin, fake `tasks`/`notes` peers, a secret store and
 * a routed transport. Nothing reaches the network.
 */
import { Context } from '@deepseek-ai/cordis'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { AppDeclaration, CallOutcome, SecretStorePort } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as InboxPlugin from '../src/index.ts'
import { DEFAULT_SETTINGS } from '../src/model.ts'
import type { Entry, InboxDocument, InboxSettings, Source, SourceKind } from '../src/model.ts'
import type { FetchImpl, FetchResponseLike } from '../src/refresh.ts'

/** A response the routed transport can answer. */
export function textResponse(body: string, status = 200): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

/** One routed transport plus the requests it saw. */
export interface Router {
  fetchImpl: FetchImpl
  calls: Array<{ url: string; headers: Record<string, string> }>
  route(prefix: string, body: string | ((url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => string | Promise<string>), status?: number): void
  routeFetch(prefix: string, handler: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>): void
}

/** Build a routed transport; an unrouted request fails loudly. */
export function router(): Router {
  const calls: Router['calls'] = []
  const routes = new Map<string, (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>>()
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return await handler(url, init)
    }
    throw new Error(`test transport: no fixture configured for ${url}`)
  }
  return {
    fetchImpl,
    calls,
    route(prefix, body, status = 200) {
      routes.set(prefix, async () => textResponse(typeof body === 'string' ? body : await body(prefix, { headers: {}, signal: new AbortController().signal }), status))
    },
    routeFetch(prefix, handler) {
      routes.set(prefix, handler)
    },
  }
}

/** The fake secret store the runtime hands to the application. */
export function secrets(): { values: Map<string, string>; port: SecretStorePort } {
  const values = new Map<string, string>()
  const key = (appId: string, name: string): string => `${appId}/${name}`
  return {
    values,
    port: {
      names: async appId => [...values.keys()].filter(entry => entry.startsWith(`${appId}/`)).map(entry => entry.slice(appId.length + 1)),
      has: async (appId, name) => values.has(key(appId, name)),
      get: async (appId, name) => values.get(key(appId, name)),
      set: async (appId, name, value) => { values.set(key(appId, name), value) },
      delete: async (appId, name) => values.delete(key(appId, name)),
    },
  }
}

/** A source record for a seeded document. */
export function makeSource(kind: SourceKind, overrides: Partial<Source> = {}): Source {
  const url = kind === 'github' ? 'https://github.com/o/r' : kind === 'rss' ? 'https://feed.test/rss' : 'https://page.test/'
  return {
    id: `s_${kind}`,
    kind,
    name: kind,
    url,
    enabled: true,
    intervalMs: 300_000,
    config: kind === 'github' ? { repo: 'o/r' } : {},
    removed: false,
    failures: 0,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...overrides,
  }
}

/** An entry record for a seeded document. */
export function makeEntry(overrides: Partial<Entry> = {}): Entry {
  const value: Entry = {
    id: 'e_1',
    sourceId: 's_rss',
    sourceKind: 'rss',
    externalId: 'x1',
    url: 'https://feed.test/1',
    title: 'First',
    summary: 'Summary one',
    content: 'Body one',
    fetchedAt: 1000,
    contentHash: 'h1',
    favorite: false,
    ...overrides,
  }
  if (overrides.sourceKind === 'manual') delete value.sourceId
  return value
}

/** A seeded document (settings default unless overridden). */
export function seeded(options: { sources?: Source[]; entries?: Entry[]; settings?: Partial<InboxSettings> } = {}): InboxDocument {
  return {
    schemaVersion: 1,
    sources: options.sources ?? [],
    entries: options.entries ?? [],
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
  }
}

/** How one fake peer answers a create call. */
export type PeerReply = () => JsonValue | Promise<JsonValue>

/** The fake `tasks` application: records createTask calls and answers `reply`. */
export function tasksApp(calls: JsonValue[], reply: PeerReply = () => ({ id: `t_${calls.length}` })): AppDeclaration {
  return {
    id: 'tasks',
    name: 'Tasks',
    description: 'Fake tasks peer',
    version: '0.2.0-rc.1',
    ops: {
      createTask: {
        description: 'Create a task',
        params: {},
        result: { type: 'json', description: 'Task' },
        effect: 'write',
        exposure: { peers: 'open' },
        execute: async (args: JsonValue) => { calls.push(args); return await reply() },
      },
    },
  }
}

/** The fake `notes` application: records create calls and answers `reply`. */
export function notesApp(calls: JsonValue[], reply: PeerReply = () => ({ id: `n_${calls.length}` })): AppDeclaration {
  return {
    id: 'notes',
    name: 'Notes',
    description: 'Fake notes peer',
    version: '0.2.0-rc.1',
    ops: {
      create: {
        description: 'Create a note',
        params: {},
        result: { type: 'json', description: 'Note' },
        effect: 'write',
        exposure: { peers: 'open' },
        execute: async (args: JsonValue) => { calls.push(args); return await reply() },
      },
    },
  }
}

/** The mounted application and everything a spec drives it with. */
export interface Mounted {
  ctx: Context
  runtime: ApplicationRuntime
  store: AppStore
  router: Router
  taskCalls: JsonValue[]
  noteCalls: JsonValue[]
  secretValues: Map<string, string>
  gated: ReturnType<AppStore['gatedNamespace']>
  call: (op: string, args?: JsonValue) => Promise<CallOutcome>
  dispose: () => Promise<void>
}

/** Mount the inbox on a real runtime; `seed` is written to the unified namespace first. */
export async function mountInbox(options: {
  seed?: InboxDocument
  fetchImpl?: FetchImpl
  tickMs?: number
  withTasks?: boolean
  withNotes?: boolean
  tasksReply?: PeerReply
  notesReply?: PeerReply
  taskCalls?: JsonValue[]
  noteCalls?: JsonValue[]
  capabilities?: string[]
  /** Mount the row with its own defaults (no injected transport, no tick override). */
  defaultConfig?: boolean
} = {}): Promise<Mounted> {
  const ctx = new Context()
  const secret = secrets()
  const runtime = new ApplicationRuntime({ stopBudgetMs: 100, secrets: secret.port })
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  const capabilityNames = options.capabilities ?? ['storage', 'network']
  if (capabilityNames.length > 0) {
    await runtime.grant({
      caller: { kind: 'app', appId: 'inbox' },
      capabilities: [
        ...capabilityNames.map(name => `capability:${name}`),
        'tasks#createTask',
        'notes#create',
      ],
      grantedAt: '2026-01-01T00:00:00.000Z',
    })
  }
  const taskCalls = options.taskCalls ?? []
  const noteCalls = options.noteCalls ?? []
  if (options.withTasks !== false) runtime.mount(tasksApp(taskCalls, options.tasksReply))
  if (options.withNotes !== false) runtime.mount(notesApp(noteCalls, options.notesReply))
  const transport = router()
  if (options.seed !== undefined) {
    const gated = store.gatedNamespace('inbox')
    gated.attach({ use: async (_name, work) => await work() })
    await gated.documents.put('document', options.seed, { schemaVersion: 1 })
  }
  await InboxPlugin.apply(ctx, options.defaultConfig === true ? {} : {
    fetchImpl: options.fetchImpl ?? transport.fetchImpl,
    tickMs: options.tickMs ?? 0,
  })
  const registration = runtime.list().find(entry => entry.declaration.id === 'inbox')
  for (let index = 0; index < 200 && registration?.status() !== 'available'; index += 1) {
    await new Promise<void>(resolve => { setTimeout(resolve, 2) })
  }
  if (registration?.status() !== 'available') throw new Error(`inbox did not become available: ${String(registration?.status())}`)
  const gated = store.gatedNamespace('inbox')
  gated.attach({ use: async (_name, work) => await work() })
  return {
    ctx,
    runtime,
    store,
    router: transport,
    taskCalls,
    noteCalls,
    secretValues: secret.values,
    gated,
    call: async (op, args = {}) => await runtime.call({ kind: 'human' }, 'inbox', op, args),
    dispose: async () => {
      await ctx.fiber.dispose()
      store.close()
    },
  }
}

/** Call one operation and require it to succeed. */
export async function ok<T>(mounted: Mounted, op: string, args: JsonValue = {}): Promise<T> {
  const outcome = await mounted.call(op, args)
  if (outcome.status !== 'success') throw new Error(`${op} failed: ${JSON.stringify(outcome)}`)
  return outcome.result as T
}

/** The latest task of the inbox application. */
export function latestTask(mounted: Mounted): ReturnType<ApplicationRuntime['task']> {
  const tasks = mounted.runtime.tasks('inbox')
  return tasks[tasks.length - 1]
}
