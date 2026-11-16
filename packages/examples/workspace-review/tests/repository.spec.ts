import { Context } from '@deepseek-ai/cordis'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviewRepository } from '../src/repository.ts'
import { defaultReviewSettings } from '../src/settings.ts'
import type { Review } from '../src/types.ts'
import { PASS_CAPABILITIES, NOW, makeRepo, parsed, workspace } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function rawStore(): Promise<{ store: AppStore; repo: ReviewRepository; ctx: Context }> {
  const ctx = new Context()
  const store = new AppStore(ctx)
  const namespace = store.gatedNamespace('review')
  namespace.attach(PASS_CAPABILITIES)
  const repo = new ReviewRepository(store.gatedNamespace('review'), defaultReviewSettings('/home/test'))
  repo.attach(PASS_CAPABILITIES)
  return { store, repo, ctx }
}

function review(id: string, workspaceId = 'w_1', generatedAt = NOW): Review {
  return {
    id,
    workspaceId,
    workspaceName: 'Alpha',
    root: '/work/alpha',
    range: 'last30',
    from: '2026-10-07',
    to: '2026-11-05',
    generatedAt,
    sessionIds: ['s_1'],
    inputHash: 'hash',
    ai: { status: 'not-requested', totalSessions: 1 },
    deterministic: {
      metrics: { sessions: 1 },
      timeline: [],
      signals: [],
      sources: [],
      weeks: [],
      evidenceSessions: [],
    },
  }
}

describe('ReviewRepository storage', () => {
  it('starts empty and writes the schema version once', async () => {
    const { store, repo, ctx } = await rawStore()
    cleanups.push(async () => { store.close(); await ctx.fiber.dispose() })
    await repo.ensureLoaded()
    const namespace = store.gatedNamespace('review')
    namespace.attach(PASS_CAPABILITIES)
    expect(await namespace.meta.get('schemaVersion')).toBe('1')
    expect(repo.workspaceRecords()).toEqual([])
    expect(await repo.settings()).toEqual(defaultReviewSettings('/home/test'))
  })

  it('loads every collection page beyond the store page cap', async () => {
    const { store, repo, ctx } = await rawStore()
    cleanups.push(async () => { store.close(); await ctx.fiber.dispose() })
    const namespace = store.gatedNamespace('review')
    namespace.attach(PASS_CAPABILITIES)
    const rows = Array.from({ length: 1_001 }, (_, index) => ({
      key: `s_${String(index).padStart(4, '0')}`,
      value: {
        id: `s_${String(index).padStart(4, '0')}`, agent: 'dsh', nativeId: `n-${String(index)}`, sourceId: 'dsh',
        sourcePath: `/p/${String(index)}`, sourceHash: 'h', cwd: '/c', startedAt: index + 1, title: 't',
        turnCount: 1, userTurns: 1, toolCalls: 0, tools: [], filesTouched: [], commands: [], tests: [],
        flags: {}, excerpt: '', keyTurns: [], importedAt: 1,
      },
    }))
    expect(await namespace.collections.open('sessions').putMany(rows)).toBe(1_001)
    await repo.ensureLoaded()
    expect(repo.sessionRecords()).toHaveLength(1_001)
  })

  it('refuses an unknown schema version and each malformed stored record', async () => {
    const cases: Array<(namespace: ReturnType<AppStore['gatedNamespace']>) => Promise<void>> = [
      async namespace => { await namespace.meta.set('schemaVersion', '2') },
      async namespace => { await namespace.collections.open('workspaces').put('w_bad', { oops: true }) },
      async namespace => { await namespace.collections.open('sessions').put('s_bad', { oops: true }) },
      async namespace => { await namespace.collections.open('reviews').put('r_bad', { oops: true }) },
    ]
    for (const prepare of cases) {
      const ctx = new Context()
      const store = new AppStore(ctx)
      const namespace = store.gatedNamespace('review')
      namespace.attach(PASS_CAPABILITIES)
      await prepare(namespace)
      const repo = new ReviewRepository(store.gatedNamespace('review'), defaultReviewSettings('/home/test'))
      repo.attach(PASS_CAPABILITIES)
      await expect(repo.ensureLoaded()).rejects.toMatchObject({ code: 'storage-corrupt' })
      store.close()
      await ctx.fiber.dispose()
    }
  })

  it('retries a failed load and reloads external changes', async () => {
    const ctx = new Context()
    const store = new AppStore(ctx)
    const namespace = store.gatedNamespace('review')
    namespace.attach(PASS_CAPABILITIES)
    await namespace.collections.open('workspaces').put('w_bad', { oops: true })
    const repo = new ReviewRepository(store.gatedNamespace('review'), defaultReviewSettings('/home/test'))
    repo.attach(PASS_CAPABILITIES)
    await expect(repo.ensureLoaded()).rejects.toBeDefined()
    await namespace.collections.open('workspaces').delete('w_bad')
    await repo.ensureLoaded()
    expect(repo.workspaceRecords()).toEqual([])
    await namespace.collections.open('workspaces').put('w_ext', workspace({ id: 'w_ext' }))
    await repo.reload()
    expect(repo.workspaceRecords().map(item => item.id)).toEqual(['w_ext'])
    store.close()
    await ctx.fiber.dispose()
  })

  it('normalizes stored settings', async () => {
    const { store, repo, ctx } = await rawStore()
    cleanups.push(async () => { store.close(); await ctx.fiber.dispose() })
    const namespace = store.gatedNamespace('review')
    namespace.attach(PASS_CAPABILITIES)
    await namespace.documents.put('settings', { schemaVersion: 1, settings: { sourceRoots: { dsh: '/srv/dsh' }, reviewRetention: 3 } })
    await repo.reload()
    expect(await repo.settings()).toMatchObject({ sourceRoots: { dsh: '/srv/dsh' }, reviewRetention: 3, redactSecrets: true })
  })
})

describe('ReviewRepository workspaces and sessions', () => {
  it('creates, updates and counts workspaces', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    const alpha = await repo.createWorkspace({ name: 'Alpha', root: '/work/alpha', aliases: [], taskProjectId: 'p1' }, NOW)
    expect(alpha).toMatchObject({ name: 'Alpha', root: '/work/alpha', taskProjectId: 'p1' })
    await expect(repo.createWorkspace({ name: 'Dup', root: '/work/alpha', aliases: [] }, NOW)).rejects.toMatchObject({ code: 'workspace-exists' })
    const beta = await repo.createWorkspace({ name: 'Beta', root: '/work/beta', aliases: ['/alt/beta'] }, NOW)
    await expect(repo.updateWorkspace(beta.id, { root: '/work/alpha' })).rejects.toMatchObject({ code: 'workspace-exists' })
    const updated = await repo.updateWorkspace(beta.id, { name: 'Beta 2', aliases: ['/alt/beta2'], taskProjectId: null })
    expect(updated).toMatchObject({ name: 'Beta 2', aliases: ['/alt/beta2'] })
    expect(updated.taskProjectId).toBeUndefined()
    await repo.markSynced(alpha.id, NOW + 1)
    await repo.markReviewed(alpha.id, NOW + 2)
    const ingested = await repo.ingest([parsed({ cwd: '/work/alpha' })], NOW)
    await repo.applyAttribution(new Map([[ingested.sessions[0]!.id, alpha.id]]))
    await repo.saveReview(review('r_1', alpha.id), 20)
    expect(repo.workspaceViews().find(item => item.id === alpha.id)).toMatchObject({ sessionCount: 1, reviewCount: 1, lastSyncAt: NOW + 1, lastReviewAt: NOW + 2 })
    expect(() => repo.requireWorkspace('missing')).toThrow(/no workspace/)
  })

  it('ingests new sessions, resolves parents and updates changed content in place', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    const first = await repo.ingest([parsed({ nativeId: 'parent' })], NOW)
    expect(first).toMatchObject({ added: 1, updated: 0, unchanged: 0 })
    const parent = first.sessions[0]!
    expect(parent.id).toMatch(/^s_/)
    const second = await repo.ingest([
      parsed({ nativeId: 'child', cwd: '', parentNativeId: 'parent', sourcePath: '/sessions/child.jsonl' }),
    ], NOW + 1)
    expect(second.added).toBe(1)
    expect(second.sessions.find(item => item.nativeId === 'child')?.parentSessionId).toBe(parent.id)
    const unchanged = await repo.ingest([parsed({ nativeId: 'parent' })], NOW + 2)
    expect(unchanged.unchanged).toBe(1)
    expect(unchanged.added).toBe(0)
    const updated = await repo.ingest([parsed({ nativeId: 'parent', sourceHash: 'hash-2', title: 'Changed', excerpt: 'new' })], NOW + 3)
    expect(updated.updated).toBe(1)
    expect(updated.sessions.find(item => item.nativeId === 'parent')).toMatchObject({ id: parent.id, title: 'Changed', excerpt: 'new' })
    expect(() => repo.requireSession('missing')).toThrow(/no session/)
  })

  it('drops removed optional fields when a later summary no longer has them', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    const created = await repo.ingest([parsed({ parentNativeId: 'p', endedAt: NOW, model: 'm' })], NOW)
    const id = created.sessions[0]!.id
    await repo.ingest([parsed({ nativeId: 'parent-of-one' })], NOW + 1)
    await repo.ingest([parsed({ nativeId: 'native-1', sourceHash: 'hash-2', endedAt: undefined, model: undefined, parentNativeId: undefined } as never)], NOW + 2)
    const summary = repo.requireSession(id)
    expect(summary.endedAt).toBeUndefined()
    expect(summary.model).toBeUndefined()
    expect(summary.parentNativeId).toBeUndefined()
  })

  it('attributes cwd, parent and manual assignments and keeps manual choices', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    const alpha = await repo.createWorkspace({ name: 'Alpha', root: '/work/alpha', aliases: [] }, NOW)
    void alpha
    const beta = await repo.createWorkspace({ name: 'Beta', root: '/work/beta', aliases: [] }, NOW)
    const ingested = await repo.ingest([
      parsed({ nativeId: 'parent', cwd: '/work/alpha/src' }),
      parsed({ nativeId: 'child', cwd: '', parentNativeId: 'parent', sourcePath: '/sessions/child.jsonl' }),
      parsed({ nativeId: 'manual', cwd: '/work/alpha/x', sourcePath: '/sessions/manual.jsonl' }),
      parsed({ nativeId: 'out', cwd: '/elsewhere', sourcePath: '/sessions/out.jsonl' }),
    ], NOW)
    const workspaces = repo.workspaceRecords()
    const { attributeSessions } = await import('../src/attribution.ts')
    await repo.applyAttribution(attributeSessions(ingested.sessions, workspaces))
    const parent = ingested.sessions.find(item => item.nativeId === 'parent')!
    const child = ingested.sessions.find(item => item.nativeId === 'child')!
    const manual = ingested.sessions.find(item => item.nativeId === 'manual')!
    expect(repo.requireSession(parent.id).assignedBy).toBe('cwd')
    expect(repo.requireSession(child.id).assignedBy).toBe('parent')
    await repo.assignSession(manual.id, beta.id)
    expect(repo.requireSession(manual.id)).toMatchObject({ workspaceId: beta.id, assignedBy: 'manual' })
    await repo.assignSession(parent.id, beta.id)
    expect(repo.requireSession(child.id).workspaceId).toBe(beta.id)
    await repo.assignSession(parent.id, null)
    expect(repo.requireSession(parent.id).workspaceId).toBeUndefined()
    expect(repo.requireSession(child.id).workspaceId).toBeUndefined()
    expect(repo.unmatchedSessions().length).toBeGreaterThan(0)
    expect(await repo.assignSession(manual.id, beta.id)).toEqual([])
    await expect(repo.assignSession(manual.id, 'missing')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses a malformed session record through the not-found path', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    expect(() => repo.requireSession('nope')).toThrow(/no session/)
  })
})

describe('ReviewRepository reviews', () => {
  it('stores immutable snapshots, lists summaries and prunes beyond retention', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    const alpha = await repo.createWorkspace({ name: 'Alpha', root: '/work/alpha', aliases: [] }, NOW)
    await repo.saveReview(review('r_1', alpha.id, NOW - 3), 2)
    await repo.saveReview(review('r_2', alpha.id, NOW - 2), 2)
    await repo.saveReview(review('r_3', alpha.id, NOW - 1), 2)
    expect(repo.reviewSummaries(alpha.id).map(item => item.id)).toEqual(['r_3', 'r_2'])
    expect(repo.getReview('r_1')).toBeUndefined()
    const copy = repo.getReview('r_3')!
    copy.workspaceName = 'Mutated'
    expect(repo.getReview('r_3')?.workspaceName).toBe('Alpha')
    expect(repo.reviewSummaries('missing')).toEqual([])
  })
})

describe('ReviewRepository validation and edge attribution', () => {
  const validSessionRecord = {
    id: 's_valid', agent: 'dsh', nativeId: 'n', sourceId: 'dsh', sourcePath: '/p', sourceHash: 'h',
    cwd: '/c', startedAt: 1, title: 't', turnCount: 1, userTurns: 1, toolCalls: 0, tools: [], filesTouched: [],
    commands: [], tests: [], flags: {}, excerpt: '', keyTurns: [], importedAt: 1,
  }
  const validWorkspaceRecord = { id: 'w_valid', name: 'W', root: '/w', aliases: [], createdAt: 1 }
  const validReviewRecord = {
    id: 'r_valid', workspaceId: 'w', workspaceName: 'W', root: '/w', range: 'last30', from: 'a', to: 'b',
    generatedAt: 1, sessionIds: [], inputHash: 'h', ai: { status: 'not-requested' },
    deterministic: { metrics: {}, timeline: [], signals: [], sources: [], weeks: [], evidenceSessions: [] },
  }

  it('rejects every malformed workspace/session/review field', async () => {
    const workspaceCases: unknown[] = [
      { ...validWorkspaceRecord, id: 3 }, { ...validWorkspaceRecord, name: 3 }, { ...validWorkspaceRecord, root: 3 },
      { ...validWorkspaceRecord, aliases: 'x' }, { ...validWorkspaceRecord, aliases: [3] }, { ...validWorkspaceRecord, createdAt: 'x' },
    ]
    const sessionCases: unknown[] = [
      { ...validSessionRecord, id: 3 }, { ...validSessionRecord, nativeId: 3 }, { ...validSessionRecord, sourcePath: 3 },
      { ...validSessionRecord, sourceHash: 3 }, { ...validSessionRecord, startedAt: 'x' }, { ...validSessionRecord, cwd: 3 },
      { ...validSessionRecord, title: 3 }, { ...validSessionRecord, agent: 'unknown' }, { ...validSessionRecord, flags: 3 },
      { ...validSessionRecord, tools: 3 }, { ...validSessionRecord, filesTouched: 3 }, { ...validSessionRecord, commands: 3 },
      { ...validSessionRecord, tests: 3 }, { ...validSessionRecord, keyTurns: 3 },
    ]
    const reviewCases: unknown[] = [
      { ...validReviewRecord, id: 3 }, { ...validReviewRecord, workspaceId: 3 }, { ...validReviewRecord, generatedAt: 'x' },
      { ...validReviewRecord, inputHash: 3 }, { ...validReviewRecord, sessionIds: 3 }, { ...validReviewRecord, deterministic: 3 },
      { ...validReviewRecord, ai: 3 },
    ]
    const cases: Array<{ collection: string; value: unknown }> = [
      ...workspaceCases.map(value => ({ collection: 'workspaces', value })),
      ...sessionCases.map(value => ({ collection: 'sessions', value })),
      ...reviewCases.map(value => ({ collection: 'reviews', value })),
    ]
    for (const entry of cases) {
      const ctx = new Context()
      const store = new AppStore(ctx)
      const namespace = store.gatedNamespace('review')
      namespace.attach(PASS_CAPABILITIES)
      await namespace.collections.open(entry.collection).put('bad', entry.value)
      const repo = new ReviewRepository(store.gatedNamespace('review'), defaultReviewSettings('/home/test'))
      repo.attach(PASS_CAPABILITIES)
      await expect(repo.ensureLoaded()).rejects.toMatchObject({ code: 'storage-corrupt' })
      store.close()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('covers empty native ids, unmatched counts, update branches and no-op attribution', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    const alpha = await repo.createWorkspace({ name: 'Alpha', root: '/work/alpha', aliases: [], taskProjectId: 'p1' }, NOW)
    const beta = await repo.createWorkspace({ name: 'Beta', root: '/work/beta', aliases: [] }, NOW)
    expect(await repo.ingest([parsed({ nativeId: '', cwd: '/elsewhere', sourcePath: '/elsewhere.jsonl' })], NOW)).toMatchObject({ added: 1 })
    expect(await repo.ingest([parsed({ nativeId: '', cwd: '/elsewhere', sourcePath: '/elsewhere.jsonl' })], NOW + 1)).toMatchObject({ unchanged: 1 })
    expect(repo.workspaceViews().map(item => item.sessionCount)).toEqual([0, 0])
    const nameOnly = await repo.updateWorkspace(alpha.id, { name: 'Alpha 2' })
    expect(nameOnly.name).toBe('Alpha 2')
    const rootOnly = await repo.updateWorkspace(alpha.id, { root: '/work/alpha2' })
    expect(rootOnly.root).toBe('/work/alpha2')
    const aliasesOnly = await repo.updateWorkspace(alpha.id, { aliases: ['/work/alias'] })
    expect(aliasesOnly.aliases).toEqual(['/work/alias'])
    const projectKept = await repo.updateWorkspace(alpha.id, {})
    expect(projectKept.taskProjectId).toBe('p1')
    const projectSet = await repo.updateWorkspace(alpha.id, { taskProjectId: 'p2' })
    expect(projectSet.taskProjectId).toBe('p2')
    const projectCleared = await repo.updateWorkspace(alpha.id, { taskProjectId: null })
    expect(projectCleared.taskProjectId).toBeUndefined()
    const projectAbsent = await repo.updateWorkspace(beta.id, { name: 'Beta 2' })
    expect(projectAbsent.taskProjectId).toBeUndefined()
    expect(await repo.applyAttribution(new Map([['missing', alpha.id]]))).toBe(0)
    await repo.saveReview({ ...review('r_model', alpha.id, NOW), model: 'p/m' }, 20)
    expect(repo.reviewSummaries(alpha.id)[0]?.model).toBe('p/m')
  })

  it('keeps a manually assigned child when its parent is re-assigned', async () => {
    const { repo, close } = await makeRepo()
    cleanups.push(close)
    const alpha = await repo.createWorkspace({ name: 'Alpha', root: '/work/alpha', aliases: [] }, NOW)
    void alpha
    const beta = await repo.createWorkspace({ name: 'Beta', root: '/work/beta', aliases: [] }, NOW)
    const ingested = await repo.ingest([
      parsed({ nativeId: 'parent', cwd: '/work/alpha' }),
      parsed({ nativeId: 'child', cwd: '', parentNativeId: 'parent', sourcePath: '/sessions/child.jsonl' }),
    ], NOW)
    const { attributeSessions } = await import('../src/attribution.ts')
    await repo.applyAttribution(attributeSessions(ingested.sessions, repo.workspaceRecords()))
    const parent = ingested.sessions.find(item => item.nativeId === 'parent')!
    const child = ingested.sessions.find(item => item.nativeId === 'child')!
    await repo.assignSession(child.id, alpha.id)
    await repo.assignSession(parent.id, beta.id)
    expect(repo.requireSession(child.id).workspaceId).toBe(alpha.id)
  })
})
