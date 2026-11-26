/**
 * The inbox spec harness: the real application runtime and store, the inbox row
 * mounted through its own plugin, fake `todo`/`notes` peers, an optional event
 * subscriber and a routed transport. Nothing reaches the network.
 */
import { Context } from '@deepseek-ai/cordis'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { AppDeclaration, AppEvent, CallOutcome } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as InboxPlugin from '../src/index.ts'
import { DEFAULT_SETTINGS } from '../src/model.ts'
import type { Entry, InboxDocument, InboxSettings, Source, SourceKind } from '../src/model.ts'
import type { ApplicationHttpLike, FetchImpl, FetchResponseLike } from '../src/refresh.ts'

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

/** A source record for a seeded document. */
export function makeSource(kind: SourceKind, overrides: Partial<Source> = {}): Source {
  const url = kind === 'github' ? 'https://github.com/o/r' : 'https://feed.test/rss'
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
    schemaVersion: 2,
    sources: options.sources ?? [],
    entries: options.entries ?? [],
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
  }
}

/** How one fake peer answers a create call. */
export type PeerReply = () => JsonValue | Promise<JsonValue>

/** The fake `todo` application: records createTask calls and answers `reply`. */
export function todoApp(calls: JsonValue[], reply: PeerReply = () => ({ id: `t_${calls.length}` })): AppDeclaration {
  return {
    id: 'todo',
    name: 'Todo',
    description: 'Fake todo peer',
    version: '0.1.1-dev.0',
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
    version: '0.1.1-dev.0',
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

/** The fake event subscriber: declares the inbox `entry.created` subscription and records each delivery. */
export function watcherApp(events: AppEvent[]): AppDeclaration {
  return {
    id: 'watcher',
    name: 'Watcher',
    description: 'Fake inbox event subscriber',
    version: '0.1.1-dev.0',
    ops: {
      ping: {
        description: 'No-op read operation; the declaration requires at least one.',
        params: {},
        result: { type: 'json', description: 'Pong' },
        effect: 'read',
        execute: () => ({ ok: true }),
      },
    },
    subscriptions: [{ appId: 'inbox', type: 'entry.created' }],
    start: async (ctx) => { await ctx.subscribe('inbox', 'entry.created', event => { events.push(event) }) },
  }
}

/** The mounted application and everything a spec drives it with. */
export interface Mounted {
  ctx: Context
  runtime: ApplicationRuntime
  store: AppStore
  router: Router
  todoCalls: JsonValue[]
  noteCalls: JsonValue[]
  events: AppEvent[]
  gated: ReturnType<AppStore['openForMount']>
  call: (op: string, args?: JsonValue) => Promise<CallOutcome>
  dispose: () => Promise<void>
}

/** Wait for one registered application to become available. */
async function available(mounted: ApplicationRuntime, appId: string): Promise<void> {
  const registration = mounted.list().find(entry => entry.declaration.id === appId)
  for (let index = 0; index < 200 && registration?.status() !== 'available'; index += 1) {
    await new Promise<void>(resolve => { setTimeout(resolve, 2) })
  }
  if (registration?.status() !== 'available') throw new Error(`${appId} did not become available: ${String(registration?.status())}`)
}

/** Mount the inbox on a real runtime; `seed` is written to the unified namespace first. */
export async function mountInbox(options: {
  seed?: InboxDocument
  fetchImpl?: FetchImpl
  http?: ApplicationHttpLike
  tickMs?: number
  withTodo?: boolean
  withNotes?: boolean
  todoReply?: PeerReply
  notesReply?: PeerReply
  todoCalls?: JsonValue[]
  noteCalls?: JsonValue[]
  capabilities?: string[]
  /** Mount a fake application that subscribes to `inbox#entry.created`. */
  subscribeEvents?: boolean
  /** Mount the row with its own defaults (no injected transport, no tick override). */
  defaultConfig?: boolean
} = {}): Promise<Mounted> {
  const ctx = new Context()
  const runtime = new ApplicationRuntime({ stopBudgetMs: 100 })
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  const capabilityNames = options.capabilities ?? ['storage', 'network']
  if (capabilityNames.length > 0) {
    await runtime.grant({
      caller: { kind: 'app', appId: 'inbox' },
      capabilities: [
        ...capabilityNames.map(name => `capability:${name}`),
      ],
      grantedAt: '2026-01-01T00:00:00.000Z',
    })
  }
  const subscribeEvents = options.subscribeEvents === true
  const todoCalls = options.todoCalls ?? []
  const noteCalls = options.noteCalls ?? []
  if (options.withTodo !== false) runtime.mount(todoApp(todoCalls, options.todoReply))
  if (options.withNotes !== false) runtime.mount(notesApp(noteCalls, options.notesReply))
  const transport = router()
  if (options.seed !== undefined) {
    const gated = store.openForMount('inbox')
    gated.attach({ use: async (_name, work) => await work() })
    await gated.documents.put('document', options.seed, { schemaVersion: 2 })
  }
  await InboxPlugin.apply(ctx, options.defaultConfig === true ? {} : {
    fetchImpl: options.fetchImpl ?? transport.fetchImpl,
    ...(options.http === undefined ? {} : { http: options.http }),
    tickMs: options.tickMs ?? 0,
  })
  await available(runtime, 'inbox')
  const events: AppEvent[] = []
  if (subscribeEvents) {
    await runtime.grant({
      caller: { kind: 'app', appId: 'watcher' },
      capabilities: ['event:inbox#entry.created'],
      grantedAt: '2026-01-01T00:00:00.000Z',
    })
    runtime.mount(watcherApp(events))
    await available(runtime, 'watcher')
  }
  const gated = store.openForMount('inbox')
  gated.attach({ use: async (_name, work) => await work() })
  return {
    ctx,
    runtime,
    store,
    router: transport,
    todoCalls,
    noteCalls,
    events,
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
