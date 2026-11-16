/**
 * The durable review repository: one gated unified-store namespace holding
 * workspaces, normalized sessions, immutable review snapshots and the settings
 * document.
 *
 * The store is the source of truth; the in-memory maps are a read cache loaded
 * once (a failed load fails closed). Sessions are keyed by the agent's own
 * session id, so a re-sync updates an existing summary instead of creating a
 * duplicate; a manual workspace assignment survives later syncs. Reviews are
 * append-only: generating a new one never rewrites an old snapshot, and pruning
 * only removes snapshots beyond the configured retention.
 * @module @matrix1001/dsh-application-harness-workspace-review/repository
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { GatedStore } from '@matrix1001/dsh-application-harness-store'
import type { ParsedSession } from './adapters.ts'
import { matchWorkspace, resolveParents } from './attribution.ts'
import { normalizeSettings } from './settings.ts'
import type { Review, ReviewSettings, ReviewSummary, Session, Workspace, WorkspaceView } from './types.ts'
import { AGENTS } from './types.ts'

const SCHEMA_VERSION = 1
const SCHEMA_KEY = 'schemaVersion'
const PAGE_LIMIT = 1_000

interface StoredSettings { schemaVersion: 1; settings: ReviewSettings }

/** What one ingest changed. */
export interface IngestResult {
  added: number
  updated: number
  unchanged: number
  sessions: Session[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function corrupt(message: string): AppError {
  return new AppError('storage-corrupt', `workspace-review: ${message}`)
}

function validWorkspace(value: unknown): value is Workspace {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.root === 'string'
    && Array.isArray(value.aliases)
    && value.aliases.every(alias => typeof alias === 'string')
    && typeof value.createdAt === 'number'
}

function validSession(value: unknown): value is Session {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.nativeId === 'string'
    && typeof value.sourcePath === 'string'
    && typeof value.sourceHash === 'string'
    && typeof value.startedAt === 'number'
    && typeof value.cwd === 'string'
    && typeof value.title === 'string'
    && AGENTS.includes(value.agent as Session['agent'])
    && isRecord(value.flags)
    && isRecord(value.subagentNames ?? {})
    && Array.isArray(value.tools)
    && Array.isArray(value.filesTouched)
    && Array.isArray(value.commands)
    && Array.isArray(value.tests)
    && Array.isArray(value.keyTurns)
}

function validReview(value: unknown): value is Review {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.workspaceId === 'string'
    && typeof value.generatedAt === 'number'
    && typeof value.inputHash === 'string'
    && Array.isArray(value.sessionIds)
    && isRecord(value.deterministic)
    && isRecord(value.ai)
}

function dedupeKey(session: Pick<Session, 'agent' | 'nativeId' | 'sourcePath'>): string {
  return session.nativeId === '' ? `${session.agent}:path:${session.sourcePath}` : `${session.agent}:${session.nativeId}`
}

function withParent(session: Session, parentId: string | undefined): Session {
  const { parentSessionId: _previous, ...rest } = session
  return parentId === undefined ? rest : { ...rest, parentSessionId: parentId }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The review store. */
export class ReviewRepository {
  private readonly workspaces = new Map<string, Workspace>()
  private readonly sessions = new Map<string, Session>()
  private readonly reviews = new Map<string, Review>()
  private settingsCache: ReviewSettings | undefined
  private ready: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: GatedStore,
    private readonly defaults: ReviewSettings,
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  /** Bind the storage capability door (the application's start hook). */
  attach(access: Parameters<GatedStore['attach']>[0]): void { this.store.attach(access) }

  /** Load the durable state once; a failure is rethrown and may be retried by a later call. */
  async ensureLoaded(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = this.load().catch((error: unknown) => { this.ready = undefined; throw error })
    }
    await this.ready
  }

  /** Re-read the durable state after an external import. */
  async reload(): Promise<void> {
    this.ready = undefined
    await this.ensureLoaded()
  }

  /**
   * Read every row of one collection. The store caps a single page at 1000
   * rows; loading only the first page silently drops older sessions and
   * reviews. Follow `next` until the collection really ends.
   */
  private async loadAll<T>(name: string): Promise<Array<{ key: string; value: T }>> {
    const rows: Array<{ key: string; value: T }> = []
    let after: string | undefined
    for (;;) {
      const page = await this.store.collections.open(name).list<T>({ limit: PAGE_LIMIT, ...(after === undefined ? {} : { after }) })
      rows.push(...page.items.map(item => ({ key: item.key, value: item.value })))
      if (!page.hasMore || page.next === undefined) break
      after = page.next
    }
    return rows
  }

  private async load(): Promise<void> {
    const version = await this.store.meta.get(SCHEMA_KEY)
    if (version !== undefined && version !== String(SCHEMA_VERSION)) {
      throw corrupt(`unsupported schemaVersion ${version}; this build reads ${String(SCHEMA_VERSION)}`)
    }
    const [workspaceRows, sessionRows, reviewRows, storedSettings] = await Promise.all([
      this.loadAll<Workspace>('workspaces'),
      this.loadAll<Session>('sessions'),
      this.loadAll<Review>('reviews'),
      this.store.documents.get<StoredSettings>('settings'),
    ])
    const workspaces = new Map<string, Workspace>()
    for (const item of workspaceRows) {
      if (!validWorkspace(item.value)) throw corrupt(`workspace ${item.key} is malformed`)
      workspaces.set(item.key, item.value)
    }
    const sessions = new Map<string, Session>()
    for (const item of sessionRows) {
      if (!validSession(item.value)) throw corrupt(`session ${item.key} is malformed`)
      sessions.set(item.key, item.value)
    }
    const reviews = new Map<string, Review>()
    for (const item of reviewRows) {
      if (!validReview(item.value)) throw corrupt(`review ${item.key} is malformed`)
      reviews.set(item.key, item.value)
    }
    this.workspaces.clear()
    for (const [id, value] of workspaces) this.workspaces.set(id, value)
    this.sessions.clear()
    for (const [id, value] of sessions) this.sessions.set(id, value)
    this.reviews.clear()
    for (const [id, value] of reviews) this.reviews.set(id, value)
    this.settingsCache = normalizeSettings(storedSettings?.value.settings, this.defaults)
    if (version === undefined) await this.store.meta.set(SCHEMA_KEY, String(SCHEMA_VERSION))
  }

  private async write<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.then(() => undefined, () => undefined)
    return await run
  }

  /** All workspace records, sorted by name. */
  workspaceRecords(): Workspace[] {
    return [...this.workspaces.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The workspace list the page reads, with session/review counts. */
  workspaceViews(): WorkspaceView[] {
    const sessionCounts = new Map<string, number>()
    for (const session of this.sessions.values()) {
      if (session.workspaceId === undefined) continue
      sessionCounts.set(session.workspaceId, (sessionCounts.get(session.workspaceId) ?? 0) + 1)
    }
    const reviewCounts = new Map<string, number>()
    for (const review of this.reviews.values()) reviewCounts.set(review.workspaceId, (reviewCounts.get(review.workspaceId) ?? 0) + 1)
    return this.workspaceRecords().map(workspace => ({
      ...workspace,
      sessionCount: sessionCounts.get(workspace.id) ?? 0,
      reviewCount: reviewCounts.get(workspace.id) ?? 0,
    }))
  }

  /** One workspace or a `not-found` refusal. */
  requireWorkspace(id: string): Workspace {
    const workspace = this.workspaces.get(id)
    if (workspace === undefined) throw new AppError('not-found', `workspace-review: no workspace ${id}`)
    return workspace
  }

  /** Create one workspace. The app has already validated and normalized the root. */
  async createWorkspace(input: { name: string; root: string; aliases: string[]; taskProjectId?: string }, now: number): Promise<Workspace> {
    return await this.write(async () => {
      if (this.workspaceRecords().some(workspace => workspace.root === input.root)) {
        throw new AppError('workspace-exists', `workspace-review: the root ${input.root} is already a workspace`)
      }
      const workspace: Workspace = {
        id: `w_${this.newId()}`,
        name: input.name,
        root: input.root,
        aliases: input.aliases,
        createdAt: now,
        ...(input.taskProjectId === undefined ? {} : { taskProjectId: input.taskProjectId }),
      }
      await this.store.collections.open('workspaces').put(workspace.id, workspace)
      this.workspaces.set(workspace.id, workspace)
      return workspace
    })
  }

  /** Update one workspace's presentation fields. */
  async updateWorkspace(id: string, patch: { name?: string; root?: string; aliases?: string[]; taskProjectId?: string | null }): Promise<Workspace> {
    return await this.write(async () => {
      const current = this.requireWorkspace(id)
      if (patch.root !== undefined && patch.root !== current.root && this.workspaceRecords().some(workspace => workspace.id !== id && workspace.root === patch.root)) {
        throw new AppError('workspace-exists', `workspace-review: the root ${patch.root} is already a workspace`)
      }
      const { taskProjectId: previousProject, ...rest } = current
      const next: Workspace = {
        ...rest,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.root === undefined ? {} : { root: patch.root }),
        ...(patch.aliases === undefined ? {} : { aliases: patch.aliases }),
        ...(patch.taskProjectId === undefined
          ? (previousProject === undefined ? {} : { taskProjectId: previousProject })
          : (patch.taskProjectId === null ? {} : { taskProjectId: patch.taskProjectId })),
      }
      await this.store.collections.open('workspaces').put(id, next)
      this.workspaces.set(id, next)
      return next
    })
  }

  /** Remember a completed sync on the workspace. */
  async markSynced(id: string, at: number): Promise<void> {
    await this.write(async () => {
      const current = this.requireWorkspace(id)
      const next: Workspace = { ...current, lastSyncAt: at }
      await this.store.collections.open('workspaces').put(id, next)
      this.workspaces.set(id, next)
    })
  }

  /** Remember that a review snapshot was saved. */
  async markReviewed(id: string, at: number): Promise<void> {
    await this.write(async () => {
      const current = this.requireWorkspace(id)
      const next: Workspace = { ...current, lastReviewAt: at }
      await this.store.collections.open('workspaces').put(id, next)
      this.workspaces.set(id, next)
    })
  }

  /** All session summaries, newest first. */
  sessionRecords(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /** One session or a `not-found` refusal. */
  requireSession(id: string): Session {
    const session = this.sessions.get(id)
    if (session === undefined) throw new AppError('not-found', `workspace-review: no session ${id}`)
    return session
  }

  /** Sessions one workspace owns, newest first. */
  sessionsForWorkspace(workspaceId: string): Session[] {
    return this.sessionRecords().filter(session => session.workspaceId === workspaceId)
  }

  /** Sessions waiting for a human assignment. */
  unmatchedSessions(): Session[] {
    return this.sessionRecords().filter(session => session.workspaceId === undefined)
  }

  /**
   * Merge parsed summaries into the durable set, preserving ids, manual
   * assignments and parent links.
   * @param parsed - normalized summaries (empty sessions already filtered out).
   * @param now - import timestamp.
   * @returns the counts and the complete merged session set.
   */
  async ingest(parsed: readonly ParsedSession[], now: number): Promise<IngestResult> {
    return await this.write(async () => {
      const byKey = new Map<string, Session>()
      const bySource = new Map<string, Session>()
      for (const session of this.sessions.values()) {
        byKey.set(dedupeKey(session), session)
        bySource.set(session.sourcePath, session)
      }
      let added = 0
      let updated = 0
      let unchanged = 0
      const writes: Session[] = []
      for (const summary of parsed) {
        const existing = byKey.get(dedupeKey(summary)) ?? bySource.get(summary.sourcePath)
        if (existing !== undefined && existing.sourceHash === summary.sourceHash) {
          unchanged += 1
          continue
        }
        const base: Session = existing === undefined
          ? {
            id: `s_${this.newId()}`,
            sourceId: summary.sourceId,
            agent: summary.agent,
            nativeId: summary.nativeId,
            sourcePath: summary.sourcePath,
            sourceHash: summary.sourceHash,
            cwd: summary.cwd,
            startedAt: summary.startedAt,
            title: summary.title,
            turnCount: summary.turnCount,
            userTurns: summary.userTurns,
            toolCalls: summary.toolCalls,
            tools: summary.tools,
            filesTouched: summary.filesTouched,
            commands: summary.commands,
            tests: summary.tests,
            flags: summary.flags,
            ...(summary.subagentNames === undefined ? {} : { subagentNames: summary.subagentNames }),
            excerpt: summary.excerpt,
            keyTurns: summary.keyTurns,
            importedAt: now,
          }
          : { ...existing, importedAt: now }
        const next: Session = {
          ...base,
          agent: summary.agent,
          nativeId: summary.nativeId,
          sourceId: summary.sourceId,
          sourcePath: summary.sourcePath,
          sourceHash: summary.sourceHash,
          cwd: summary.cwd,
          startedAt: summary.startedAt,
          title: summary.title,
          turnCount: summary.turnCount,
          userTurns: summary.userTurns,
          toolCalls: summary.toolCalls,
          tools: summary.tools,
          filesTouched: summary.filesTouched,
          commands: summary.commands,
          tests: summary.tests,
          flags: summary.flags,
          ...(summary.subagentNames === undefined ? {} : { subagentNames: summary.subagentNames }),
          excerpt: summary.excerpt,
          keyTurns: summary.keyTurns,
          ...(summary.endedAt === undefined ? {} : { endedAt: summary.endedAt }),
          ...(summary.model === undefined ? {} : { model: summary.model }),
          ...(summary.parentNativeId === undefined ? {} : { parentNativeId: summary.parentNativeId }),
        }
        if (summary.endedAt === undefined) delete next.endedAt
        if (summary.model === undefined) delete next.model
        if (summary.parentNativeId === undefined) delete next.parentNativeId
        if (summary.subagentNames === undefined) delete next.subagentNames
        if (existing === undefined) added += 1
        else updated += 1
        writes.push(next)
      }
      const merged = new Map(this.sessions)
      for (const session of writes) merged.set(session.id, session)
      const sessions = this.resolveParentIds([...merged.values()])
      const toWrite: Session[] = []
      for (const session of sessions) {
        const previous = this.sessions.get(session.id)
        if (previous === undefined || !same(previous, session)) toWrite.push(session)
      }
      if (toWrite.length > 0) await this.store.collections.open('sessions').putMany(toWrite.map(session => ({ key: session.id, value: session })))
      for (const session of sessions) this.sessions.set(session.id, session)
      return { added, updated, unchanged, sessions: sessions.sort((a, b) => b.startedAt - a.startedAt) }
    })
  }

  private resolveParentIds(sessions: readonly Session[]): Session[] {
    const parents = resolveParents(sessions)
    return sessions.map(session => withParent(session, parents.get(session.id)))
  }

  /**
   * Persist the attribution decided by {@link attributeSessions}. A manual
   * assignment keeps its `assignedBy`; every other session is marked `cwd` or
   * `parent` from the rule that produced it.
   * @param assignments - session id → workspace id or undefined.
   * @returns how many sessions changed.
   */
  async applyAttribution(assignments: ReadonlyMap<string, string | undefined>): Promise<number> {
    return await this.write(async () => {
      const workspaces = this.workspaceRecords()
      const writes: Session[] = []
      for (const [id, workspaceId] of assignments) {
        const current = this.sessions.get(id)
        if (current === undefined) continue
        let assignedBy: Session['assignedBy']
        if (current.assignedBy === 'manual' && current.workspaceId === workspaceId) assignedBy = 'manual'
        else if (workspaceId === undefined) assignedBy = undefined
        else assignedBy = matchWorkspace(current.cwd, workspaces)?.id === workspaceId ? 'cwd' : 'parent'
        const next: Session = { ...current, ...(workspaceId === undefined ? {} : { workspaceId }), ...(assignedBy === undefined ? {} : { assignedBy }) }
        if (workspaceId === undefined) {
          delete next.workspaceId
          delete next.assignedBy
        }
        if (same(current, next)) continue
        writes.push(next)
      }
      if (writes.length > 0) await this.store.collections.open('sessions').putMany(writes.map(session => ({ key: session.id, value: session })))
      for (const session of writes) this.sessions.set(session.id, session)
      return writes.length
    })
  }

  /**
   * Assign one session manually, or clear that assignment. A parent's manual
   * assignment carries to its currently unattributed descendants.
   * @param sessionId - the session to assign.
   * @param workspaceId - the workspace, or null to clear.
   * @returns the changed sessions.
   */
  async assignSession(sessionId: string, workspaceId: string | null): Promise<Session[]> {
    return await this.write(async () => {
      const target = this.requireSession(sessionId)
      if (workspaceId !== null) this.requireWorkspace(workspaceId)
      const changed: Session[] = []
      const visit = (session: Session): void => {
        if (session.id !== target.id && session.assignedBy === 'manual') return
        const next: Session = workspaceId === null
          ? (() => {
            const copy: Session = { ...session }
            delete copy.workspaceId
            delete copy.assignedBy
            return copy
          })()
          : { ...session, workspaceId, assignedBy: session.id === target.id ? 'manual' : 'parent' }
        if (!same(session, next)) {
          changed.push(next)
          this.sessions.set(next.id, next)
        }
        for (const child of this.sessions.values()) {
          if (child.parentSessionId === session.id) visit(child)
        }
      }
      visit(target)
      if (changed.length > 0) await this.store.collections.open('sessions').putMany(changed.map(session => ({ key: session.id, value: session })))
      return changed
    })
  }

  /** Read the settings, filling missing fields from the defaults. */
  async settings(): Promise<ReviewSettings> {
    await this.ensureLoaded()
    /* v8 ignore next -- defaults are used before the settings document is loaded */
    return structuredClone(this.settingsCache ?? this.defaults)
  }

  /** Replace the settings document. */
  async saveSettings(settings: ReviewSettings): Promise<void> {
    await this.write(async () => {
      const stored: StoredSettings = { schemaVersion: SCHEMA_VERSION, settings }
      await this.store.documents.put('settings', stored, { schemaVersion: SCHEMA_VERSION })
      this.settingsCache = structuredClone(settings)
    })
  }

  /** Review summaries for one workspace, newest first. */
  reviewSummaries(workspaceId: string): ReviewSummary[] {
    return [...this.reviews.values()]
      .filter(review => review.workspaceId === workspaceId)
      .sort((a, b) => b.generatedAt - a.generatedAt)
      .map(review => ({
        id: review.id,
        workspaceId: review.workspaceId,
        range: review.range,
        from: review.from,
        to: review.to,
        generatedAt: review.generatedAt,
        sessionCount: review.sessionIds.length,
        aiStatus: review.ai.status,
        ...(review.model === undefined ? {} : { model: review.model }),
      }))
  }

  /** One review snapshot (a copy: callers cannot mutate the stored record). */
  getReview(id: string): Review | undefined {
    const review = this.reviews.get(id)
    return review === undefined ? undefined : structuredClone(review)
  }

  /**
   * Append one immutable snapshot and prune only the snapshots beyond the
   * configured retention.
   * @param review - the complete review to store.
   * @returns how many old snapshots were removed.
   */
  async saveReview(review: Review, retention: number): Promise<number> {
    return await this.write(async () => {
      const snapshot = structuredClone(review)
      await this.store.collections.open('reviews').put(snapshot.id, snapshot)
      this.reviews.set(snapshot.id, snapshot)
      const older = [...this.reviews.values()]
        .filter(candidate => candidate.workspaceId === snapshot.workspaceId)
        .sort((a, b) => b.generatedAt - a.generatedAt)
        .slice(retention)
      for (const candidate of older) {
        await this.store.collections.open('reviews').delete(candidate.id)
        this.reviews.delete(candidate.id)
      }
      return older.length
    })
  }
}
