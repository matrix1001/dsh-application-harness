import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import type { CapabilityAccess, CallOutcome, TaskContext, TaskDescriptor, TaskHandle, TaskWork } from '@matrix1001/dsh-application-harness-runtime'
import { ReviewRepository } from '../src/repository.ts'
import { defaultReviewSettings } from '../src/settings.ts'
import type { PeerCall } from '../src/evidence.ts'
import type { AgentKind, Session, SessionTest, Workspace } from '../src/types.ts'

export const NOW = Date.UTC(2026, 10, 5, 12, 0, 0)
export const DAY = 24 * 60 * 60 * 1000

/** One isolated temp directory under the repository's tmp tree. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = join(process.cwd(), 'tmp', 'workspace-review-tests')
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(join(base, 'case-'))
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }) } }
}

/** Write one file below a temp root, creating parents. */
export async function writeFixture(root: string, relative: string, content: string): Promise<string> {
  const path = join(root, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

/** Write JSONL records. */
export async function writeJsonl(root: string, relative: string, records: unknown[]): Promise<string> {
  return await writeFixture(root, relative, records.map(record => JSON.stringify(record)).join('\n') + '\n')
}

/** The capability door that allows its work (the unit-test stand-in for a grant). */
export const PASS_CAPABILITIES: CapabilityAccess = {
  appId: 'workspace-review',
  use: async (_name, work) => await work(),
}

/** Build one in-memory repository with the storage gate attached. */
export async function makeRepo(home = '/home/test'): Promise<{
  repo: ReviewRepository
  store: AppStore
  ctx: Context
  close: () => Promise<void>
}> {
  const ctx = new Context()
  const store = new AppStore(ctx)
  const repo = new ReviewRepository(store.gatedNamespace('review'), defaultReviewSettings(home))
  repo.attach(PASS_CAPABILITIES)
  await repo.ensureLoaded()
  return { repo, store, ctx, close: async () => { store.close(); await ctx.fiber.dispose() } }
}

/** One session fixture with deterministic defaults. */
export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's_1',
    agent: 'dsh',
    nativeId: 'native-1',
    sourceId: 'dsh',
    sourcePath: '/sessions/one.jsonl',
    sourceHash: 'hash-1',
    cwd: '/work/alpha',
    startedAt: NOW - DAY,
    endedAt: NOW - DAY + 60 * 60 * 1000,
    title: 'First session',
    turnCount: 2,
    userTurns: 2,
    toolCalls: 1,
    tools: ['bash'],
    filesTouched: ['src/a.ts'],
    commands: ['pnpm test'],
    tests: [{ command: 'pnpm test', status: 'passed' }],
    flags: {},
    excerpt: 'Done with the first task.',
    keyTurns: [{ role: 'user', text: 'do it' }, { role: 'assistant', text: 'done' }],
    importedAt: NOW,
    ...overrides,
  }
}

/** One workspace fixture. */
export function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w_1',
    name: 'Alpha',
    root: '/work/alpha',
    aliases: [],
    createdAt: NOW - 10 * DAY,
    ...overrides,
  }
}

/** One test record. */
export function testResult(command: string, status: SessionTest['status']): SessionTest {
  return { command, status }
}

/** A fake task runner that runs the work immediately. */
export function immediateTasks(): {
  startTask: (descriptor: TaskDescriptor, work: TaskWork) => TaskHandle
  descriptors: TaskDescriptor[]
  contexts: TaskContext[]
} {
  const descriptors: TaskDescriptor[] = []
  const contexts: TaskContext[] = []
  let counter = 0
  return {
    descriptors,
    contexts,
    startTask: (descriptor, work) => {
      const taskId = `task-${String(++counter)}`
      const controller = new AbortController()
      const task: TaskContext = {
        appId: 'workspace-review',
        taskId,
        signal: controller.signal,
        capabilities: PASS_CAPABILITIES,
        secrets: {} as TaskContext['secrets'],
        reportProgress: () => undefined,
        call: async () => ({ callId: 'peer', status: 'rejected', error: { code: 'unknown-app', message: 'none'  }}) as CallOutcome,
        notifyChanged: () => undefined,
      publishEvent: () => undefined,
      }
      descriptors.push(descriptor)
      contexts.push(task)
      const done = Promise.resolve().then(async () => { try { await work(task) } catch { /* a real task projection settles; the work's failure is captured by the caller */ } })
      return { taskId, done }
    },
  }
}

/** A fake peer-call table: each op answers with an outcome, or throws. */
export function peerTable(table: Record<string, CallOutcome | Error | ((args: Record<string, unknown>) => CallOutcome)>): PeerCall & { calls: Array<{ app: string; op: string; args: Record<string, unknown> }> } {
  const calls: Array<{ app: string; op: string; args: Record<string, unknown> }> = []
  const call = async (app: string, op: string, args: Record<string, unknown>): Promise<CallOutcome> => {
    calls.push({ app, op, args })
    const answer = table[op]
    if (answer instanceof Error) throw answer
    const outcome = typeof answer === 'function' ? answer(args) : answer
    if (outcome === undefined) return { callId: 'peer', status: 'rejected', error: { code: 'unknown-app', message: `no ${app}#${op}` } }
    return outcome
  }
  return Object.assign(call, { calls })
}

/** One successful outcome. */
export function ok(value: unknown): CallOutcome {
  return { callId: 'peer', status: 'success', result: value as never }
}

/** One refused outcome. */
export function failed(message: string, code = 'peer-failed'): CallOutcome {
  return { callId: 'peer', status: 'failed', error: { code, message } }
}

/** A parsed-session-shaped fixture for sync tests. */
export function parsed(overrides: Partial<import('../src/adapters.ts').ParsedSession> = {}): import('../src/adapters.ts').ParsedSession {
  return {
    agent: 'dsh' as AgentKind,
    sourceId: 'dsh',
    nativeId: 'native-1',
    sourcePath: '/sessions/one.jsonl',
    sourceHash: 'hash-1',
    cwd: '/work/alpha',
    startedAt: NOW - DAY,
    endedAt: NOW - DAY + 1000,
    title: 'Session',
    turnCount: 1,
    userTurns: 1,
    toolCalls: 0,
    tools: [],
    filesTouched: [],
    commands: [],
    tests: [],
    flags: {},
    excerpt: 'done',
    keyTurns: [],
    ...overrides,
  }
}
