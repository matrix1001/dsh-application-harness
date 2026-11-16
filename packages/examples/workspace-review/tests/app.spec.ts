import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertDeclarable } from '@matrix1001/dsh-application-harness-runtime'
import type { ModelAskRequest, ModelPort } from '@matrix1001/dsh-application-harness-host-bridge'
import { WorkspaceReviewApp, WorkspaceReviewDeclaration } from '../src/app.ts'
import type { GenerateContext } from '../src/app.ts'
import { ReviewGenerator } from '../src/generation.ts'
import { SessionSync } from '../src/sync.ts'
import type { ParsedSession, SourceFile } from '../src/adapters.ts'
import {
  NOW, PASS_CAPABILITIES, failed, immediateTasks, makeRepo, ok, parsed, peerTable,
} from './helpers.ts'
import { defaultReviewSettings } from '../src/settings.ts'

const cleanups: Array<() => Promise<void>> = []
const temps: Array<() => Promise<void>> = []

function context(tasks = immediateTasks()): { context: GenerateContext; tasks: ReturnType<typeof immediateTasks>; controller: AbortController; notify: ReturnType<typeof vi.fn> } {
  const controller = new AbortController()
  const notify = vi.fn()
  return {
    controller,
    tasks,
    notify,
    context: {
      signal: controller.signal,
      capabilities: PASS_CAPABILITIES,
      call: peerTable({ status: failed('no git'), log: failed('no git'), diff: failed('no git'), listTasks: failed('no tasks') }),
      startTask: tasks.startTask,
      notifyChanged: notify,
      reportProgress: vi.fn(),
    },
  }
}

async function tempRoot(): Promise<string> {
  const { dir, cleanup } = await import('./helpers.ts').then(module => module.tempDir())
  temps.push(cleanup)
  return dir
}

async function engine(overrides: {
  parse?: (file: SourceFile) => Promise<ParsedSession>
  discoverFiles?: boolean
  model?: ModelPort
  fileExists?: (path: string) => Promise<boolean>
} = {}): Promise<{
  app: WorkspaceReviewApp
  repo: Awaited<ReturnType<typeof makeRepo>>['repo']
  sync: SessionSync
  root: string
  close: () => Promise<void>
}> {
  const { repo, close } = await makeRepo('/home/test')
  const root = await tempRoot()
  const sync = new SessionSync({
    repo,
    now: () => NOW,
    discover: async agent => ({
      agent,
      root: `/sources/${agent}`,
      found: overrides.discoverFiles !== false && agent === 'dsh',
      files: overrides.discoverFiles !== false && agent === 'dsh'
        ? [{ agent, path: '/sessions/one.jsonl', mtimeMs: NOW, size: 1 }]
        : [],
      errors: [],
    }),
    parse: overrides.parse ?? (async file => parsed({
      sourcePath: file.path,
      cwd: root,
      nativeId: 'native-1',
      startedAt: NOW - 60_000,
      endedAt: NOW,
      title: 'Worked on the app',
      excerpt: 'It works.',
      filesTouched: ['src/a.ts'],
    })),
  })
  const generator = new ReviewGenerator({ now: () => NOW, newId: () => 'generated', ...(overrides.model === undefined ? {} : { model: overrides.model }) })
  const app = new WorkspaceReviewApp({
    repo,
    sync,
    generator,
    now: () => NOW,
    ...(overrides.fileExists === undefined ? {} : { fileExists: overrides.fileExists }),
  })
  cleanups.push(close)
  return { app, repo, sync, root, close }
}

function model(): ModelPort & { calls: ModelAskRequest[] } {
  const calls: ModelAskRequest[] = []
  return {
    calls,
    ask: async <T>(request: ModelAskRequest<T>) => {
      calls.push(request as ModelAskRequest)
      const evidenceId = /"(s_[A-Za-z0-9_-]+)"/u.exec(request.prompt)?.[1] ?? 's_1'
      const value = {
        summary: { text: 'AI summary', evidence: [evidenceId] },
        themes: [{ title: 'Theme', text: 'Text', evidence: [evidenceId] }],
        decisions: [{ text: 'Decision', kind: 'explicit', evidence: [evidenceId] }],
        deadEnds: [], friction: [], openLoops: [],
      }
      const parsedValue = request.parse?.(JSON.stringify(value))
      return { text: JSON.stringify(value), ...(parsedValue === undefined ? {} : { structured: parsedValue }), model: { provider: 'p', model: 'm' } }
    },
  }
}

describe('WorkspaceReviewDeclaration', () => {
  it('declares generation 2, the review namespace, capabilities and peer calls', async () => {
    const { app, root: _root, close } = await engine()
    cleanups.push(close)
    const declaration = WorkspaceReviewDeclaration(app)
    expect(declaration).toMatchObject({
      id: 'workspace-review',
      generation: 2,
      data: { kind: 'unified', namespace: 'review', schemaVersion: 1 },
      capabilities: ['storage', 'model'],
    })
    expect(declaration.calls).toEqual([
      { app: 'git-browser', ops: ['status', 'log', 'diff'] },
      { app: 'tasks', ops: ['listTasks'] },
    ])
    expect(Object.keys(declaration.ops).sort()).toEqual([
      'assignSession', 'cancelGenerate', 'cancelSync', 'createWorkspace', 'generateReview', 'getReview',
      'getSessionEvidence', 'listReviews', 'listSources', 'listUnmatchedSessions', 'listWorkspaces', 'previewReview',
      'setSettings', 'settings', 'syncWorkspace', 'updateWorkspace',
    ])
    expect(() => assertDeclarable(declaration)).not.toThrow()
    expect(declaration.ops.generateReview?.exposure).toEqual({ ai: 'confirm', peers: 'open' })
    expect(declaration.ops.syncWorkspace?.exposure).toEqual({ ai: 'confirm', peers: 'open' })
    expect(declaration.ops.createWorkspace?.exposure).toEqual({ ai: 'closed', peers: 'closed' })
    expect(declaration.ops.listWorkspaces?.exposure).toEqual({ ai: 'open', peers: 'open' })
    expect(declaration.ops.settings?.exposure).toEqual({ ai: 'closed', peers: 'closed' })
  })
})

describe('WorkspaceReviewApp workspaces', () => {
  it('creates, lists, updates and validates workspaces and roots', async () => {
    const { app, root: engineRoot, close } = await engine()
    cleanups.push(close)
    expect(await app.listWorkspaces()).toEqual([])
    const root = engineRoot
    const nested = join(root, 'nested')
    await mkdir(nested)
    const file = join(root, 'file.txt')
    await import('node:fs/promises').then(module => module.writeFile(file, 'x'))
    const created = await app.createWorkspace({ root, aliases: [nested, nested], taskProjectId: 'p1' })
    expect(created).toMatchObject({ root, aliases: [nested], taskProjectId: 'p1' })
    expect((await app.listWorkspaces())[0]).toMatchObject({ id: created.id, sessionCount: 0, reviewCount: 0 })
    const named = await app.createWorkspace({ root: await tempRoot(), name: 'Named' })
    expect(named.name).toBe('Named')
    const noop = await app.updateWorkspace({ id: named.id })
    expect(noop).toEqual(named)
    const updated = await app.updateWorkspace({ id: named.id, name: 'Renamed', aliases: [root], taskProjectId: null })
    expect(updated).toMatchObject({ name: 'Renamed', aliases: [root] })
    expect(updated.taskProjectId).toBeUndefined()
    await expect(app.createWorkspace({ root })).rejects.toMatchObject({ code: 'workspace-exists' })
    await expect(app.createWorkspace({ root: join(root, 'missing') })).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(app.createWorkspace({ root: file })).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(app.createWorkspace({ root, name: 'x'.repeat(121) })).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(app.updateWorkspace({ id: 'missing' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(app.updateWorkspace({ id: named.id, root })).rejects.toMatchObject({ code: 'workspace-exists' })
  })
})

describe('WorkspaceReviewApp sync, evidence and reviews', () => {
  it('syncs, lists unmatched sessions, assigns them and returns evidence', async () => {
    const { app, repo, root, close } = await engine({ fileExists: async () => false })
    cleanups.push(close)
    const created = await app.createWorkspace({ root })
    const tasks = immediateTasks()
    const sync = await app.syncWorkspace(created.id, {
      signal: new AbortController().signal,
      startTask: tasks.startTask,
      notifyChanged: vi.fn(),
      reportProgress: vi.fn(),
    })
    expect(sync).toMatchObject({ workspaceId: created.id, added: 1, unmatched: 0 })
    const [session] = repo.sessionRecords()
    expect(session?.workspaceId).toBe(created.id)
    expect((await app.listUnmatchedSessions()).length).toBe(0)
    const evidence = await app.getSessionEvidence(session!.id)
    expect(evidence).toMatchObject({ sourceAvailable: false, outcome: 'has-result', subagents: [] })
    expect(evidence.session.id).toBe(session!.id)
    await expect(app.getSessionEvidence('missing')).rejects.toMatchObject({ code: 'not-found' })
    expect(app.cancelSync('missing')).toBe('not-found')
    expect(await app.listSources()).toHaveLength(3)
    await expect(app.syncWorkspace('missing', { signal: new AbortController().signal, startTask: tasks.startTask })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('assigns unmatched sessions and ignores a repeated assignment', async () => {
    const { app, repo, root, close } = await engine()
    cleanups.push(close)
    const created = await app.createWorkspace({ root })
    const ingested = await repo.ingest([parsed({ cwd: '/elsewhere', sourcePath: '/elsewhere.jsonl' })], NOW)
    const id = ingested.sessions[0]!.id
    expect((await app.listUnmatchedSessions()).map(item => item.id)).toEqual([id])
    expect(await app.assignSession({ sessionId: id, workspaceId: created.id })).toHaveLength(1)
    expect(await app.assignSession({ sessionId: id, workspaceId: created.id })).toEqual([])
    expect((await app.listUnmatchedSessions()).length).toBe(0)
    await expect(app.assignSession({ sessionId: id, workspaceId: 'missing' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(app.assignSession({ sessionId: 'missing', workspaceId: created.id })).rejects.toMatchObject({ code: 'not-found' })
    expect(repo.requireSession(id).workspaceId).toBe(created.id)
  })

  it('previews and generates a deterministic snapshot, then lists and reads it', async () => {
    const { app, repo, root, close } = await engine()
    cleanups.push(close)
    const created = await app.createWorkspace({ root })
    const tasks = immediateTasks()
    const { context: generateContext, notify } = context(tasks)
    const review = await app.generateReview({ workspaceId: created.id, range: 'last30' }, generateContext)
    expect(review).toMatchObject({ workspaceId: created.id, range: 'last30' })
    expect(review.deterministic.metrics.sessions).toBe(1)
    expect(review.ai.status).toBe('unavailable')
    expect(review.narrative).toBeUndefined()
    expect(notify).toHaveBeenCalled()
    expect(repo.reviewSummaries(created.id)).toHaveLength(1)
    expect((await app.listReviews(created.id))[0]).toMatchObject({ id: review.id, sessionCount: 1 })
    expect((await app.getReview(review.id)).id).toBe(review.id)
    await expect(app.getReview('missing')).rejects.toMatchObject({ code: 'not-found' })
    await expect(app.listReviews('missing')).rejects.toMatchObject({ code: 'not-found' })
    const preview = await app.previewReview({ workspaceId: created.id, range: 'last30' })
    expect(preview).toMatchObject({ sessionCount: 1, aiSessions: 1, aiEnabled: true })
    expect(app.cancelGenerate(created.id)).toBe('not-found')
    expect(app.cancelGenerate('missing')).toBe('not-found')
    await expect(app.generateReview({ workspaceId: 'missing', range: 'last30' }, generateContext)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('runs the AI narrative when available and respects the AI switches', async () => {
    const fake = model()
    const { app, root, close } = await engine({ model: fake })
    cleanups.push(close)
    const created = await app.createWorkspace({ root })
    const { context: generateContext } = context()
    const review = await app.generateReview({ workspaceId: created.id, range: 'last30' }, generateContext)
    expect(review.ai.status).toBe('generated')
    expect(review.narrative?.summary?.text).toBe('AI summary')
    expect(review.model).toBe('p/m')
    const noAi = await app.generateReview({ workspaceId: created.id, range: 'last30', useAi: false }, generateContext)
    expect(noAi.ai.status).toBe('not-requested')
    const settings = await app.setSettings({ aiEnabled: false })
    expect(settings.aiEnabled).toBe(false)
    const disabled = await app.generateReview({ workspaceId: created.id, range: 'last30' }, generateContext)
    expect(disabled.ai.status).toBe('disabled')
  })

  it('refuses generation with no sessions and propagates a cancelled generation', async () => {
    const { app, root, close } = await engine({ discoverFiles: false })
    cleanups.push(close)
    const created = await app.createWorkspace({ root })
    const { context: generateContext } = context()
    await expect(app.generateReview({ workspaceId: created.id, range: 'last30' }, generateContext)).rejects.toMatchObject({ code: 'no-sessions' })
  })

  it('cancels an in-flight generation and sync', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const cancelling: ModelPort = {
      ask: async request => {
        entered()
        await gate
        return await new Promise((_resolve, reject) => {
          const signal = request.signal
          if (signal?.aborted === true) {
            const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); return
          }
          signal?.addEventListener('abort', () => {
            const error = new Error('cancelled'); error.name = 'AbortError'; reject(error)
          }, { once: true })
        })
      },
    }
    const { app, root, close } = await engine({ model: cancelling })
    cleanups.push(close)
    const created = await app.createWorkspace({ root })
    const { context: generateContext } = context()
    const pending = app.generateReview({ workspaceId: created.id, range: 'last30' }, generateContext)
    await started
    expect(app.cancelGenerate(created.id)).toBe('accepted')
    release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(app.cancelGenerate(created.id)).toBe('not-found')
  })

  it('returns settings, refuses invalid settings, and lists sources', async () => {
    const { app, root: _root, close } = await engine({ discoverFiles: false })
    cleanups.push(close)
    const notify = vi.fn()
    const initial = await app.settings()
    expect(initial).toEqual(defaultReviewSettings('/home/test'))
    expect(await app.setSettings({ sourceRoots: { dsh: '/srv/dsh' }, reviewRetention: 2 }, { notifyChanged: notify })).toMatchObject({
      sourceRoots: { dsh: '/srv/dsh' }, reviewRetention: 2,
    })
    expect(notify).toHaveBeenCalled()
    await expect(app.setSettings({ reviewRetention: 0 })).rejects.toMatchObject({ code: 'invalid-args' })
    const sources = await app.listSources()
    expect(sources.every(source => source.found === false)).toBe(true)
    expect(sources.map(source => source.agent)).toEqual(['dsh', 'claude-code', 'codex'])
    await app.reload()
    expect((await app.settings()).sourceRoots.dsh).toBe('/srv/dsh')
    app.attach(PASS_CAPABILITIES)
  })
})

describe('WorkspaceReview declaration operations', () => {
  it('executes every declared read/write operation through its closure', async () => {
    const { app, repo, root, close } = await engine({ fileExists: async () => true })
    cleanups.push(close)
    const workspace = await app.createWorkspace({ root, name: 'Ops workspace' })
    const declaration = WorkspaceReviewDeclaration(app)
    const tasks = immediateTasks()
    const events: string[] = []
    const call = peerTable({
      status: ok({ branch: 'main', clean: true, files: [] }),
      log: ok({ commits: [] }),
      diff: ok({}),
      listTasks: ok([]),
    })
    const ctx = {
      appId: 'workspace-review',
      op: 'test',
      callId: 'call-1',
      caller: { kind: 'human' },
      signal: new AbortController().signal,
      capabilities: PASS_CAPABILITIES,
      secrets: {},
      reportProgress: (message: string) => { events.push(message) },
      notifyChanged: () => { events.push('changed') },
      call,
      startTask: tasks.startTask,
    } as never
    const invoke = async (name: string, args: unknown): Promise<unknown> => {
      const op = declaration.ops[name]
      if (op === undefined) throw new Error(`missing op ${name}`)
      return await op.execute(args as never, ctx)
    }
    expect(await invoke('listWorkspaces', {})).toHaveLength(1)
    const secondRoot = await tempRoot()
    const second = await invoke('createWorkspace', { root: secondRoot, name: 'Second', aliases: [secondRoot], taskProjectId: 'p1' }) as { id: string }
    expect(second).toMatchObject({ name: 'Second', taskProjectId: 'p1' })
    expect(await invoke('updateWorkspace', { id: second.id, name: 'Second 2', root: secondRoot, aliases: [], taskProjectId: 'p2' })).toMatchObject({ name: 'Second 2', taskProjectId: 'p2' })
    await expect(invoke('getReview', {})).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(invoke('createWorkspace', { root })).rejects.toMatchObject({ code: 'workspace-exists' })
    await expect(invoke('createWorkspace', { root: secondRoot, aliases: [3] })).rejects.toMatchObject({ code: 'invalid-args' })
    const synced = await invoke('syncWorkspace', { workspaceId: workspace.id }) as { added: number }
    expect(synced.added).toBe(1)
    const session = repo.sessionRecords()[0]!
    expect(await invoke('listUnmatchedSessions', {})).toEqual([])
    expect(await invoke('assignSession', { sessionId: session.id, workspaceId: null })).toHaveLength(1)
    expect((await invoke('listUnmatchedSessions', {})) as unknown[]).toHaveLength(1)
    expect(await invoke('assignSession', { sessionId: session.id, workspaceId: workspace.id })).toHaveLength(1)
    expect(await invoke('listReviews', { workspaceId: workspace.id })).toEqual([])
    expect(await invoke('previewReview', { workspaceId: workspace.id, range: 'last30' })).toMatchObject({ sessionCount: 1 })
    const generated = await invoke('generateReview', { workspaceId: workspace.id, range: 'last30' }) as { id: string }
    expect(generated.id).toBeTruthy()
    expect(await invoke('getReview', { reviewId: generated.id })).toMatchObject({ id: generated.id })
    expect(await invoke('cancelGenerate', { workspaceId: workspace.id })).toEqual({ status: 'not-found' })
    expect(await invoke('cancelSync', { workspaceId: workspace.id })).toEqual({ status: 'not-found' })
    const evidence = await invoke('getSessionEvidence', { sessionId: session.id }) as { sourceAvailable: boolean }
    expect(evidence.sourceAvailable).toBe(true)
    expect((await invoke('listSources', {})) as unknown[]).toHaveLength(3)
    expect(await invoke('settings', {})).toMatchObject({ aiEnabled: true })
    expect(await invoke('setSettings', { aiEnabled: false })).toMatchObject({ aiEnabled: false })
    expect(events).toContain('changed')
    expect(events.some(event => event.startsWith('discover'))).toBe(true)
    expect(await declaration.start?.({ capabilities: PASS_CAPABILITIES } as never)).toBeUndefined()
    await declaration.reload?.({} as never)
    expect(tasks.contexts.length).toBeGreaterThan(0)
    expect(call.calls.some(entry => entry.app === 'git-browser')).toBe(true)
  })
})

describe('WorkspaceReviewApp generation edge cases', () => {
  it('uses the default file probe and maps a child session in evidence', async () => {
    const { app, repo, root, close } = await engine()
    cleanups.push(close)
    const workspace = await app.createWorkspace({ root })
    const sourceFile = join(root, 'session.jsonl')
    await import('node:fs/promises').then(module => module.writeFile(sourceFile, '{}'))
    const ingested = await repo.ingest([
      parsed({ nativeId: 'parent', cwd: root, sourcePath: sourceFile, subagentNames: { child: 'reviewer' } }),
      parsed({ nativeId: 'child', cwd: '', parentNativeId: 'parent', sourcePath: '/sessions/child.jsonl' }),
      parsed({ nativeId: 'child-2', cwd: '', parentNativeId: 'parent', sourcePath: '/sessions/child-2.jsonl' }),
    ], NOW)
    await repo.assignSession(ingested.sessions.find(item => item.nativeId === 'child')!.id, workspace.id)
    const parent = repo.sessionRecords().find(item => item.nativeId === 'parent')!
    const evidence = await app.getSessionEvidence(parent.id)
    expect(evidence.sourceAvailable).toBe(true)
    expect(evidence.subagents.map(child => child.title)).toContain('Session')
    expect(evidence.subagents.find(child => child.title === 'Session')?.name).toBe('reviewer')
    expect(evidence.subagents.find(child => child.id !== evidence.subagents[0]?.id)?.name).toBeUndefined()
  })

  it('forwards custom dates, joins an existing generation and aborts through the caller signal', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let release!: (outcome: unknown) => void
    const pending = new Promise<unknown>(resolve => { release = resolve })
    const model: ModelPort = {
      ask: async request => {
        entered()
        await pending
        return await new Promise((_resolve, reject) => {
          if (request.signal?.aborted === true) { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); return }
          const error = new Error('cancelled'); error.name = 'AbortError'; reject(error)
        })
      },
    }
    const { app, root, close } = await engine({ model })
    cleanups.push(close)
    const workspace = await app.createWorkspace({ root })
    const firstContext = context()
    const first = app.generateReview({ workspaceId: workspace.id, range: 'custom', from: '2026-11-05', to: '2026-11-05' }, firstContext.context)
    await started
    const second = app.generateReview({ workspaceId: workspace.id, range: 'custom', from: '2026-11-05', to: '2026-11-05' }, context().context)
    firstContext.controller.abort()
    release(undefined)
    const settled = await Promise.allSettled([first, second])
    expect(settled.map(entry => entry.status)).toEqual(['rejected', 'rejected'])
    for (const entry of settled) if (entry.status === 'rejected') expect((entry.reason as Error).name).toBe('AbortError')
    await expect(app.previewReview({ workspaceId: workspace.id, range: 'custom', from: '2026-11-05', to: '2026-11-05' })).resolves.toMatchObject({ range: 'custom' })
  })

  it('aborts before starting when the caller signal is already gone and tolerates a context without notifiers', async () => {
    const { app, root, close } = await engine()
    cleanups.push(close)
    const workspace = await app.createWorkspace({ root })
    const aborted = new AbortController()
    aborted.abort()
    const bareContext = {
      signal: aborted.signal,
      capabilities: PASS_CAPABILITIES,
      call: async () => failed('peer') as never,
      startTask: immediateTasks().startTask,
    }
    await expect(app.generateReview({ workspaceId: workspace.id, range: 'last30' }, bareContext)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(app.getReview('')).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(app.getSessionEvidence('')).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(app.updateWorkspace({ id: '' })).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(app.createWorkspace({ root: '' })).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(app.createWorkspace({ root, name: '' })).rejects.toMatchObject({ code: 'invalid-args' })
  })
})
