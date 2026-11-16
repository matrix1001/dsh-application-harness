/**
 * Keyless smoke driver: exercise the runtime through one human read, one AI
 * read (direct or through the platform tool face), and one application-to-
 * application read, then print the legs and the runtime history window.
 *
 * The mounted composition supplies an in-memory store and the notes app. The
 * driver grants the notes app its storage capability before any read; no
 * business file or database is written by this composition.
 */
import type { Context } from '@deepseek-ai/cordis'
import { MemoryHistory, type AppDeclaration, type CallOutcome } from '@matrix1001/dsh-application-harness-runtime'

export const name = 'smoke-driver'
export const inject = ['applications']

/** A marker used by the AI/tool read; it does not write business data. */
export const SMOKE_NOTE_TEXT = 'hello from the smoke driver'

async function waitFor<T>(probe: () => T | undefined, describe: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`smoke driver: timeout waiting for ${describe}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The peer application: it reads the notes list as itself. */
function peerDeclaration(): AppDeclaration {
  return {
    id: 'smoke-peer',
    name: 'smoke-peer',
    description: '冒烟驱动自带的第二应用（应用发起调用的身份路径）',
    version: '0.0.0',
    calls: ['notes'],
    ops: {
      forwardToNotes: {
        description: 'Read the notes list as THIS application (the peer path)',
        params: {},
        result: { type: 'json', description: 'The forwarded call outcome' },
        execute: async (_args, opCtx) => {
          const outcome = await opCtx.call('notes', 'list', {})
          if (outcome.status !== 'success') return { status: outcome.status, ...(outcome.error?.code === undefined ? {} : { code: outcome.error.code }) }
          const value = outcome.result
          return { status: outcome.status, count: Array.isArray(value) ? value.length : 0 }
        },
      },
    },
  }
}

interface LegRecord {
  readonly leg: string
  readonly status: CallOutcome['status']
  readonly code?: string
}

function record(leg: string, outcome: CallOutcome): LegRecord {
  return outcome.status === 'rejected' || outcome.status === 'failed'
    ? { leg, status: outcome.status, ...(outcome.error?.code === undefined ? {} : { code: outcome.error.code }) }
    : { leg, status: outcome.status }
}

function fail(message: string, timer: NodeJS.Timeout): never {
  console.error(`smoke driver failed: ${message}`)
  clearTimeout(timer)
  process.exit(1)
}

export function apply(ctx: Context): void {
  const runtime = ctx.applications
  if (runtime === undefined) throw new Error('smoke-driver requires the application runtime (ctx.applications)')
  const history = new MemoryHistory()
  runtime.useHistory(history)
  const peerRegistered = runtime.register(peerDeclaration())
  const timer = setTimeout(() => { fail('30s timeout', timer) }, 30_000)
  void (async () => {
    try {
      await peerRegistered
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const statuses = runtime.list().map((app) => `${app.declaration.id}:${String(app.status())}`)
      if (!statuses.includes('notes:available')) fail(`runtime apps: ${statuses.join(', ')}`, timer)
      await runtime.grant({ caller: { kind: 'app', appId: 'notes' }, capabilities: ['capability:storage'], grantedAt: new Date().toISOString() })
      const legs: LegRecord[] = []
      // Human read.
      const human = await runtime.call({ kind: 'human' }, 'notes', 'list', {})
      legs.push(record('notes/list (human)', human))
      // AI read, through the tool face in tooled mode.
      if (process.env.DSH_SMOKE_TOOLED === '1') {
        const tools = ctx.get('tools')
        if (!tools) fail('the tools service is not mounted in the tooled composition', timer)
        await waitFor(() => tools.get('applications'), 'applications tool registration')
        ;(ctx.get('appTools') as { mark?: (id: string) => void } | undefined)?.mark?.('smoke-agent')
        const batch = await tools.execute({
          calls: [{
            type: 'tool-call',
            id: 'smoke-ai' as never,
            name: 'applications',
            arguments: JSON.stringify({ action: 'call', appId: 'notes', op: 'list', args: {} }),
          }],
          signal: new AbortController().signal,
          agent: { session: { id: 'smoke-agent' } } as never,
        })
        const read = batch.results[0]?.result
        legs.push({ leg: 'applications#call notes/list (tools, ai)', status: read?.isError === true ? 'failed' : 'success' })
        if (read === undefined || read.isError === true) fail('the applications tool call failed', timer)
      } else {
        const read = await runtime.call({ kind: 'ai', sessionId: 'smoke-agent' }, 'notes', 'list', {})
        legs.push(record('notes/list (ai)', read))
        if (read.status !== 'success') fail(`notes/list (ai) -> ${read.status}`, timer)
      }
      // Application-to-application read.
      const peer = await runtime.call({ kind: 'human' }, 'smoke-peer', 'forwardToNotes', {})
      legs.push(record('smoke-peer/forwardToNotes', peer))
      if (human.status !== 'success') fail(`notes/list (human) -> ${human.status}`, timer)
      if (peer.status !== 'success') fail(`smoke-peer/forwardToNotes -> ${peer.status}`, timer)
      const records = history.all()
      const peerAttempt = records.find((entry) => entry.caller.kind === 'app' && entry.target === 'notes' && entry.op === 'list')
      if (peerAttempt?.status !== 'success') fail(`the peer notes read expected success (the author opened the operation to peers and the user policy is default), got ${String(peerAttempt?.status)}: ${JSON.stringify(records.map((r) => [r.caller, r.target, r.op, r.status]))}`, timer)
      const humanRead = records.find((entry) => entry.caller.kind === 'human' && entry.target === 'notes' && entry.op === 'list')
      if (humanRead?.status !== 'success') fail('the human notes read is not recorded as ok', timer)
      clearTimeout(timer)
      console.log(`smoke driver: ${JSON.stringify({ legs, history: records.length })}`)
      process.exit(0)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), timer)
    }
  })()
}
