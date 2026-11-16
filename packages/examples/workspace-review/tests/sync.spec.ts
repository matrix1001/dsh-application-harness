import { describe, expect, it, vi } from 'vitest'
import { SessionSync } from '../src/sync.ts'
import type { DiscoveredSource, ParsedSession, SourceFile } from '../src/adapters.ts'
import { NOW, makeRepo, parsed } from './helpers.ts'

function source(agent: DiscoveredSource['agent'], files: SourceFile[], errors: string[] = [], truncated = false): DiscoveredSource {
  return { agent, root: `/sources/${agent}`, found: true, files, errors, ...(truncated ? { truncated: true } : {}) }
}

function file(agent: DiscoveredSource['agent'], path: string, mtimeMs = NOW): SourceFile {
  return { agent, path, mtimeMs, size: 1 }
}

async function setup(): Promise<{
  repo: Awaited<ReturnType<typeof makeRepo>>['repo']
  close: () => Promise<void>
  workspaceId: string
}> {
  const { repo, close } = await makeRepo()
  const created = await repo.createWorkspace({ name: 'Alpha', root: '/work/alpha', aliases: [] }, NOW)
  return { repo, close, workspaceId: created.id }
}

const settings = { sourceRoots: { dsh: '/dsh', claudeCode: '/claude', codex: '/codex' }, redactSecrets: true, reviewRetention: 20, aiEnabled: true }

describe('SessionSync', () => {
  it('discovers, parses, de-duplicates and attributes sessions', async () => {
    const { repo, close, workspaceId } = await setup()
    const emptyFile = file('codex', '/sessions/empty.jsonl')
    const staleFile = file('dsh', '/sessions/dup.jsonl', NOW - 10)
    const freshFile = file('dsh', '/sessions/dup-2.jsonl', NOW)
    const childFile = file('dsh', '/sessions/child.jsonl')
    const outFile = file('dsh', '/sessions/out.jsonl')
    const parse = vi.fn(async (entry: SourceFile): Promise<ParsedSession> => {
      if (entry.path === emptyFile.path) return parsed({ agent: 'codex', nativeId: 'empty', userTurns: 0, toolCalls: 0, excerpt: '', sourcePath: entry.path })
      if (entry.path === staleFile.path) return parsed({ nativeId: 'dup', title: 'stale', sourcePath: entry.path })
      if (entry.path === freshFile.path) return parsed({ nativeId: 'dup', title: 'fresh', sourcePath: entry.path })
      if (entry.path === childFile.path) return parsed({ nativeId: 'child', cwd: '', parentNativeId: 'dup', sourcePath: entry.path })
      if (entry.path === outFile.path) return parsed({ nativeId: 'out', cwd: '/elsewhere', sourcePath: entry.path })
      throw new Error('bad file')
    })
    const discover = vi.fn(async (agent: DiscoveredSource['agent']) => {
      if (agent === 'dsh') return source(agent, [staleFile, freshFile, childFile, outFile], ['walk warning'])
      if (agent === 'codex') return source(agent, [emptyFile])
      return source(agent, [file('claude-code', '/sessions/broken.jsonl')])
    })
    const sync = new SessionSync({ repo, now: () => NOW + 100, discover, parse })
    const tasks = (await import('./helpers.ts')).immediateTasks()
    const controller = new AbortController()
    const notify = vi.fn()
    const progress = vi.fn()
    const result = await sync.sync(workspaceId, {
      signal: controller.signal,
      startTask: tasks.startTask,
      notifyChanged: notify,
      reportProgress: progress,
    })
    expect(result).toMatchObject({ workspaceId, scanned: 6, skipped: 1, added: 3, unmatched: 1 })
    expect(result.errors.some(error => error.path === '/sessions/broken.jsonl')).toBe(true)
    expect(result.sources.find(item => item.agent === 'dsh')).toMatchObject({ found: true, fileCount: 4, lastError: 'walk warning' })
    expect(tasks.descriptors[0]).toMatchObject({ kind: 'sync', externalId: workspaceId })
    expect(progress).toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(repo.sessionRecords().find(item => item.nativeId === 'dup')?.title).toBe('fresh')
    expect(repo.sessionRecords().find(item => item.nativeId === 'child')?.workspaceId).toBe(workspaceId)
    expect(repo.sessionRecords().find(item => item.nativeId === 'out')?.workspaceId).toBeUndefined()
    expect(repo.requireWorkspace(workspaceId).lastSyncAt).toBe(NOW + 100)
    expect(sync.cancel(workspaceId)).toBe('not-found')
    expect(sync.taskIdOf(workspaceId)).toBeUndefined()
    expect(sync.listSources).toBeTypeOf('function')
    expect(settings).toBeDefined()
    close()
  })

  it('joins one in-flight sync per workspace', async () => {
    const { repo, close, workspaceId } = await setup()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let calls = 0
    const startTask = (descriptor: { kind: string }, work: (task: never) => unknown) => {
      void descriptor
      calls += 1
      const controller = new AbortController()
      const done = (async () => {
        await work({
          appId: 'workspace-review',
          taskId: 'task-one',
          signal: controller.signal,
          capabilities: { appId: 'workspace-review', use: async (_n: string, fn: () => unknown) => await fn() },
          secrets: {},
          reportProgress: () => undefined,
          call: async () => ({ callId: 'x', status: 'rejected', error: { code: 'unknown-app', message: 'x'  }}),
          notifyChanged: () => undefined,
        } as never)
      })()
      return { taskId: 'task-one', done }
    }
    const parse = async (entry: SourceFile): Promise<ParsedSession> => {
      entered()
      await gate
      return parsed({ sourcePath: entry.path })
    }
    const sync = new SessionSync({
      repo,
      now: () => NOW,
      discover: async agent => source(agent, agent === 'dsh' ? [file('dsh', '/sessions/one.jsonl')] : []),
      parse,
    })
    const context = { signal: new AbortController().signal, startTask }
    const first = sync.sync(workspaceId, context)
    await started
    expect(sync.taskIdOf(workspaceId)).toBe('task-one')
    const second = sync.sync(workspaceId, context)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(calls).toBe(1)
    close()
  })

  it('cancels the running task and reports the abort', async () => {
    const { repo, close, workspaceId } = await setup()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const startTask = (_descriptor: { kind: string }, work: (task: never) => unknown) => {
      const controller = new AbortController()
      const done = (async () => {
        await work({
          appId: 'workspace-review',
          taskId: 'task-cancel',
          signal: controller.signal,
          capabilities: { appId: 'workspace-review', use: async (_n: string, fn: () => unknown) => await fn() },
          secrets: {},
          reportProgress: () => undefined,
          call: async () => ({ callId: 'x', status: 'rejected', error: { code: 'unknown-app', message: 'x'  }}),
          notifyChanged: () => undefined,
        } as never)
      })()
      return { taskId: 'task-cancel', done }
    }
    const sync = new SessionSync({
      repo,
      now: () => NOW,
      discover: async agent => source(agent, agent === 'dsh' ? [file('dsh', '/sessions/one.jsonl')] : []),
      parse: async (entry: SourceFile) => {
        entered()
        await gate
        return parsed({ sourcePath: entry.path })
      },
    })
    const promise = sync.sync(workspaceId, { signal: new AbortController().signal, startTask })
    await started
    expect(sync.cancel(workspaceId)).toBe('accepted')
    release()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(sync.taskIdOf(workspaceId)).toBeUndefined()
    close()
  })

  it('refuses an already-cancelled caller and an unknown workspace', async () => {
    const { repo, close, workspaceId } = await setup()
    const sync = new SessionSync({
      repo,
      discover: async agent => source(agent, agent === 'dsh' ? [file('dsh', '/sessions/one.jsonl')] : []),
      parse: async entry => parsed({ sourcePath: entry.path }),
    })
    const aborted = new AbortController()
    aborted.abort()
    const tasks = (await import('./helpers.ts')).immediateTasks()
    await expect(sync.sync(workspaceId, { signal: aborted.signal, startTask: tasks.startTask })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(sync.sync('missing', { signal: new AbortController().signal, startTask: tasks.startTask })).rejects.toMatchObject({ code: 'not-found' })
    close()
  })

  it('reports every source whose discovery hit a bound', async () => {
    const { repo, close, workspaceId } = await setup()
    const sync = new SessionSync({
      repo,
      discover: async agent => source(agent, [], [], true),
      parse: async entry => parsed({ sourcePath: entry.path }),
    })
    const tasks = (await import('./helpers.ts')).immediateTasks()
    const result = await sync.sync(workspaceId, { signal: new AbortController().signal, startTask: tasks.startTask })
    expect(result.truncatedSources).toEqual(['dsh', 'claude-code', 'codex'])
    close()
  })

  it('marks a truncated source in the listed discovery state', async () => {
    const { repo, close } = await setup()
    const sync = new SessionSync({
      repo,
      discover: async agent => source(agent, [], [], agent === 'dsh'),
      parse: async entry => parsed({ sourcePath: entry.path }),
    })
    const listed = await sync.listSources()
    expect(listed.find(item => item.agent === 'dsh')?.truncated).toBe(true)
    expect(listed.find(item => item.agent === 'codex')?.truncated).toBeUndefined()
    close()
  })

  it('lists source discovery state and remembers sync errors', async () => {
    const { repo, close, workspaceId } = await setup()
    let missing = false
    const sync = new SessionSync({
      repo,
      discover: async agent => missing
        ? { agent, root: `/sources/${agent}`, found: false, files: [], errors: [] }
        : source(agent, agent === 'dsh' ? [file('dsh', '/sessions/one.jsonl')] : [], agent === 'claude-code' ? ['read failed'] : []),
      parse: async entry => parsed({ sourcePath: entry.path }),
    })
    const tasks = (await import('./helpers.ts')).immediateTasks()
    await sync.sync(workspaceId, { signal: new AbortController().signal, startTask: tasks.startTask })
    const listed = await sync.listSources()
    expect(listed.find(item => item.agent === 'claude-code')).toMatchObject({ found: true, fileCount: 0, lastError: 'read failed' })
    missing = true
    const missingList = await sync.listSources()
    expect(missingList.every(item => item.found === false)).toBe(true)
    close()
  })
})

describe('SessionSync edge cases', () => {
  it('propagates a discovery task failure and keeps an empty native id addressable by path', async () => {
    const { repo, close, workspaceId } = await setup()
    const failing = new SessionSync({ repo, discover: async () => { throw new Error('discovery exploded') } })
    const tasks = (await import('./helpers.ts')).immediateTasks()
    await expect(failing.sync(workspaceId, { signal: new AbortController().signal, startTask: tasks.startTask })).rejects.toThrow(/discovery exploded/)
    const sync = new SessionSync({
      repo,
      discover: async agent => source(agent, agent === 'dsh' ? [file('dsh', '/sessions/no-id.jsonl')] : []),
      parse: async entry => parsed({ nativeId: '', sourcePath: entry.path }),
    })
    const result = await sync.sync(workspaceId, { signal: new AbortController().signal, startTask: tasks.startTask })
    expect(result.added).toBe(1)
    close()
  })

  it('reports a non-Error parse failure and aborts when the caller signal fires', async () => {
    const { repo, close, workspaceId } = await setup()
    const parseFailure = new SessionSync({
      repo,
      discover: async agent => source(agent, agent === 'dsh' ? [file('dsh', '/sessions/bad.jsonl')] : []),
      parse: async () => { throw 'plain parse failure' },
    })
    const tasks = (await import('./helpers.ts')).immediateTasks()
    const result = await parseFailure.sync(workspaceId, { signal: new AbortController().signal, startTask: tasks.startTask })
    expect(result.errors[0]?.message).toContain('plain parse failure')

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const sync = new SessionSync({
      repo,
      discover: async agent => source(agent, agent === 'dsh' ? [file('dsh', '/sessions/slow.jsonl')] : []),
      parse: async () => { entered(); await gate; return parsed({}) },
    })
    const caller = new AbortController()
    const promise = sync.sync(workspaceId, { signal: caller.signal, startTask: tasks.startTask })
    await started
    caller.abort()
    release()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    close()
  })
})
