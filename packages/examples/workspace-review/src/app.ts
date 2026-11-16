/**
 * The workspace-review application service and its declaration.
 *
 * The service is the single place that turns operations into repository,
 * sync and generation work. Sync and generation are runtime tasks (so they can
 * be cancelled and observed); AI input is bounded and evidence-checked; and a
 * failure of the optional AI half never removes the deterministic snapshot.
 * @module @matrix1001/dsh-application-harness-workspace-review/app
 */

import { access, realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type {
  AppContext, AppDeclaration, CallOutcome, CapabilityAccess, OperationContext, TaskDescriptor, TaskHandle, TaskWork,
} from '@matrix1001/dsh-application-harness-runtime'
import type { PeerCall } from './evidence.ts'
import type { ReviewGenerator } from './generation.ts'
import type { ReviewRepository } from './repository.ts'
import { mergeSettings } from './settings.ts'
import type { SessionSync, SyncContext } from './sync.ts'
import type {
  Review, ReviewPreview, ReviewRange, ReviewSettings, ReviewSummary, Session, SessionEvidenceView, SourceInfo,
  SyncResult, Workspace, WorkspaceView,
} from './types.ts'
import { outcomeOf } from './types.ts'

/** The context fields generation needs (the runtime's OperationContext satisfies it). */
export interface GenerateContext {
  signal: AbortSignal
  capabilities: CapabilityAccess
  call: (app: string, op: string, args: Record<string, unknown>) => Promise<CallOutcome>
  startTask: (descriptor: TaskDescriptor, work: TaskWork) => TaskHandle
  reportProgress?: (message: string, data?: Record<string, string>) => void
  notifyChanged?: () => void
}

/** The options the row wires into the service. */
export interface WorkspaceReviewAppOptions {
  repo: ReviewRepository
  sync: SessionSync
  generator: ReviewGenerator
  now?: () => number
  fileExists?: (path: string) => Promise<boolean>
}

interface Run<T> {
  controller: AbortController
  taskId: string | undefined
  promise: Promise<T>
}

function rootError(message: string): AppError {
  return new AppError('invalid-args', `workspace-review: ${message}`)
}

function textOf(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('invalid-args', `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new AppError('invalid-args', `${field} must not be empty`)
  return trimmed
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return textOf(value, field)
}

function aliasesOf(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(alias => typeof alias !== 'string' || alias.trim() === '')) {
    throw new AppError('invalid-args', 'aliases must be an array of non-empty path strings')
  }
  return [...new Set(value.map(alias => resolve(alias.trim())))]
}

/** The workspace-review service. */
export class WorkspaceReviewApp {
  private readonly now: () => number
  private readonly fileExists: (path: string) => Promise<boolean>
  private readonly generationRuns = new Map<string, Run<Review>>()

  constructor(private readonly options: WorkspaceReviewAppOptions) {
    this.now = options.now ?? Date.now
    /* v8 ignore next -- deployments inject fileExists; the default is a defensive fallback */
    this.fileExists = options.fileExists ?? (async path => {
      try { await access(path); return true } catch { return false }
    })
  }

  private async load(): Promise<void> { await this.options.repo.ensureLoaded() }

  /** Bind the storage capability door (the runtime's start hook). */
  attach(capabilities: CapabilityAccess): void { this.options.repo.attach(capabilities) }

  /** Re-read the durable state after an external import. */
  async reload(): Promise<void> { await this.options.repo.reload() }

  /** Validate an existing workspace root and return its real path. */
  private async workspaceRoot(value: unknown): Promise<string> {
    const root = resolve(textOf(value, 'root'))
    let info
    try { info = await stat(root) } catch { throw rootError(`root does not exist: ${root}`) }
    if (!info.isDirectory()) throw rootError(`root is not a directory: ${root}`)
    return await realpath(root)
  }

  private nameOf(value: unknown, fallback: string): string {
    const name = value === undefined ? fallback : textOf(value, 'name')
    if (name.length > 120) throw new AppError('invalid-args', 'name must be at most 120 characters')
    return name
  }

  private async reattribute(): Promise<void> {
    const { attributeSessions } = await import('./attribution.ts')
    await this.options.repo.applyAttribution(attributeSessions(this.options.repo.sessionRecords(), this.options.repo.workspaceRecords()))
  }

  /** List workspaces with their session/review counts. */
  async listWorkspaces(): Promise<WorkspaceView[]> {
    await this.load()
    return this.options.repo.workspaceViews()
  }

  /** Create one workspace; the root must exist and be a directory. */
  async createWorkspace(input: { name?: string; root: string; aliases?: string[]; taskProjectId?: string }): Promise<Workspace> {
    await this.load()
    const root = await this.workspaceRoot(input.root)
    const workspace = await this.options.repo.createWorkspace({
      name: this.nameOf(input.name, basename(root)),
      root,
      aliases: aliasesOf(input.aliases).filter(alias => alias !== root),
      ...(optionalText(input.taskProjectId, 'taskProjectId') === undefined ? {} : { taskProjectId: optionalText(input.taskProjectId, 'taskProjectId')! }),
    }, this.now())
    await this.reattribute()
    return workspace
  }

  /** Update a workspace; changing the root re-runs attribution for every session. */
  async updateWorkspace(input: { id: string; name?: string; root?: string; aliases?: string[]; taskProjectId?: string | null }): Promise<Workspace> {
    await this.load()
    const id = textOf(input.id, 'id')
    this.options.repo.requireWorkspace(id)
    const root = input.root === undefined ? undefined : await this.workspaceRoot(input.root)
    const patch = {
      ...(input.name === undefined ? {} : { name: this.nameOf(input.name, 'workspace') }),
      ...(root === undefined ? {} : { root }),
      ...(input.aliases === undefined ? {} : { aliases: aliasesOf(input.aliases).filter(alias => alias !== root) }),
      ...(input.taskProjectId === undefined ? {} : { taskProjectId: input.taskProjectId === null ? null : textOf(input.taskProjectId, 'taskProjectId') }),
    }
    if (Object.keys(patch).length === 0) return this.options.repo.requireWorkspace(id)
    const workspace = await this.options.repo.updateWorkspace(id, patch)
    if (root !== undefined) await this.reattribute()
    return workspace
  }

  /** Sync one workspace's sources as a runtime task. */
  async syncWorkspace(workspaceId: string, context: SyncContext): Promise<SyncResult> {
    await this.load()
    const workspace = this.options.repo.requireWorkspace(workspaceId)
    const result = await this.options.sync.sync(workspace.id, context)
    context.notifyChanged?.()
    return result
  }

  /** Cancel the running sync of one workspace, when there is one. */
  cancelSync(workspaceId: string): 'accepted' | 'not-found' {
    return this.options.sync.cancel(workspaceId)
  }

  /** Sessions waiting for a human workspace assignment. */
  async listUnmatchedSessions(): Promise<Session[]> {
    await this.load()
    return this.options.repo.unmatchedSessions().slice(0, 500)
  }

  /** Assign one session (or clear its assignment) as a human decision. */
  async assignSession(input: { sessionId: string; workspaceId: string | null }): Promise<Session[]> {
    await this.load()
    const changed = await this.options.repo.assignSession(textOf(input.sessionId, 'sessionId'), input.workspaceId)
    return changed
  }

  /** Review history for one workspace. */
  async listReviews(workspaceId: string): Promise<ReviewSummary[]> {
    await this.load()
    this.options.repo.requireWorkspace(workspaceId)
    return this.options.repo.reviewSummaries(workspaceId)
  }

  /** One review snapshot. */
  async getReview(reviewId: string): Promise<Review> {
    await this.load()
    const review = this.options.repo.getReview(textOf(reviewId, 'reviewId'))
    if (review === undefined) throw new AppError('not-found', `workspace-review: no review ${reviewId}`)
    return review
  }

  /** Counts shown by the generate modal before the user confirms. */
  async previewReview(input: { workspaceId: string; range: ReviewRange; from?: string; to?: string }): Promise<ReviewPreview> {
    await this.load()
    const workspace = this.options.repo.requireWorkspace(input.workspaceId)
    const settings = await this.options.repo.settings()
    return this.options.generator.preview(workspace, this.options.repo.sessionsForWorkspace(workspace.id), {
      range: input.range,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    }, settings)
  }

  /**
   * Generate one review snapshot. The work is a runtime task; sync runs first,
   * then the deterministic report, then the optional AI narrative.
   */
  async generateReview(input: {
    workspaceId: string
    range: ReviewRange
    from?: string
    to?: string
    useAi?: boolean
  }, context: GenerateContext): Promise<Review> {
    await this.load()
    const workspace = this.options.repo.requireWorkspace(input.workspaceId)
    // One run per (workspace, range, useAi). Sharing by workspace alone made a
    // second request in another range receive the first run's snapshot.
    const runKey = [workspace.id, input.range, input.from ?? '', input.to ?? '', input.useAi === false ? '0' : '1'].join('\u0000')
    const existing = this.generationRuns.get(runKey)
    if (existing !== undefined) return await existing.promise
    const controller = new AbortController()
    if (context.signal.aborted) controller.abort()
    const forward = (): void => { controller.abort() }
    context.signal.addEventListener('abort', forward, { once: true })
    const run: Run<Review> = { controller, taskId: undefined, promise: undefined as unknown as Promise<Review> }
    run.promise = this.performGenerate(workspace, input, context, run).finally(() => {
      context.signal.removeEventListener('abort', forward)
      /* v8 ignore next -- a newer generation may already own the slot */
      if (this.generationRuns.get(runKey) === run) this.generationRuns.delete(runKey)
    })
    this.generationRuns.set(runKey, run)
    return await run.promise
  }

  private async performGenerate(
    workspace: Workspace,
    input: { workspaceId: string; range: ReviewRange; from?: string; to?: string; useAi?: boolean },
    context: GenerateContext,
    run: Run<Review>,
  ): Promise<Review> {
    let result: Review | undefined
    let failure: unknown
    const handle = context.startTask({
      kind: 'generate',
      title: `生成回顾 ${workspace.name}`,
      externalId: workspace.id,
    }, async task => {
      const signal = AbortSignal.any([task.signal, run.controller.signal])
      try {
        const syncContext: SyncContext = {
          signal,
          startTask: context.startTask,
          ...(context.notifyChanged === undefined ? {} : { notifyChanged: context.notifyChanged }),
          ...(context.reportProgress === undefined ? {} : { reportProgress: context.reportProgress }),
        }
        await this.options.sync.sync(workspace.id, syncContext)
        const settings = await this.options.repo.settings()
        const peer: PeerCall = async (app, op, args) => await context.call(app, op, args)
        result = await this.options.generator.generate({
          workspace,
          sessions: this.options.repo.sessionsForWorkspace(workspace.id),
          range: {
            range: input.range,
            ...(input.from === undefined ? {} : { from: input.from }),
            ...(input.to === undefined ? {} : { to: input.to }),
          },
          useAi: input.useAi !== false,
          settings,
          capabilities: context.capabilities,
          call: peer,
          signal,
        })
        const retention = settings.reviewRetention
        await this.options.repo.saveReview(result, retention)
        await this.options.repo.markReviewed(workspace.id, result.generatedAt)
        context.notifyChanged?.()
        return result as never
      } catch (error) {
        failure = error
        throw error
      }
    })
    run.taskId = handle.taskId
    await handle.done
    if (failure !== undefined) throw failure
    /* v8 ignore next -- the task settles with a result or an error */
    if (result === undefined) throw new Error('workspace-review: the generation task produced no result')
    return result
  }

  /** Cancel the running generation of one workspace. */
  cancelGenerate(workspaceId: string): 'accepted' | 'not-found' {
    let found = false
    for (const [key, run] of this.generationRuns) {
      /* v8 ignore next -- the loop also visits other workspaces' runs; covered by the not-found path */
      if (!key.startsWith(`${workspaceId}\u0000`)) continue
      run.controller.abort()
      found = true
    }
    return found ? 'accepted' : 'not-found'
  }

  /** One session's bounded evidence for the drawer. */
  async getSessionEvidence(sessionId: string): Promise<SessionEvidenceView> {
    await this.load()
    const session = this.options.repo.requireSession(textOf(sessionId, 'sessionId'))
    const names = session.subagentNames ?? {}
    const subagents = this.options.repo.sessionRecords()
      .filter(candidate => candidate.parentSessionId === session.id)
      .map(candidate => ({
        id: candidate.id,
        title: candidate.title,
        agent: candidate.agent,
        startedAt: candidate.startedAt,
        ...(names[candidate.nativeId] === undefined ? {} : { name: names[candidate.nativeId] }),
      }))
    return {
      session,
      sourceAvailable: await this.fileExists(session.sourcePath),
      outcome: outcomeOf(session),
      subagents,
    }
  }

  /** The configured sources and whether each was found. */
  async listSources(): Promise<SourceInfo[]> {
    await this.load()
    return await this.options.sync.listSources()
  }

  /** The current settings. */
  async settings(): Promise<ReviewSettings> {
    await this.load()
    return await this.options.repo.settings()
  }

  /** Merge and save a settings patch. */
  async setSettings(patch: unknown, ctx: { notifyChanged?: () => void } = {}): Promise<ReviewSettings> {
    await this.load()
    const current = await this.options.repo.settings()
    const next = mergeSettings(current, patch)
    await this.options.repo.saveSettings(next)
    ctx.notifyChanged?.()
    return next
  }
}

const str = (description: string, required = false) => required
  ? { type: 'string' as const, description, required: true as const }
  : { type: 'string' as const, description }
const int = (description: string) => ({ type: 'integer' as const, description })
const bool = (description: string) => ({ type: 'boolean' as const, description })
const json = (description: string) => ({ type: 'json' as const, description })
const strings = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description })
const rangeOf = (description: string) => ({
  type: 'string' as const,
  enum: ['week', 'last7', 'month', 'last30', 'all', 'custom'] as const,
  description,
})

function peerCall(context: OperationContext): PeerCall {
  return async (app, op, args) => await context.call(app, op, args as never)
}

function syncContextOf(context: OperationContext): SyncContext {
  return {
    signal: context.signal,
    startTask: context.startTask,
    notifyChanged: context.notifyChanged,
    reportProgress: message => { context.reportProgress(message) },
  }
}

/**
 * Build the workspace-review declaration.
 * @param app - the service bound to the row's repository, sync and generator.
 * @returns the declaration mounted by the runtime.
 */
export function WorkspaceReviewDeclaration(app: WorkspaceReviewApp): AppDeclaration {
  const read = (description: string, params: Record<string, unknown>, run: (args: never, ctx: OperationContext) => unknown, peers: 'open' | 'closed' = 'open') => ({
    description,
    params,
    result: { type: 'json' as const, description: 'Operation result' },
    effect: 'read' as const,
    exposure: { ai: peers === 'open' ? 'open' as const : 'closed' as const, peers },
    execute: async (args: unknown, ctx: OperationContext) => run(args as never, ctx) as never,
  })
  const write = (description: string, params: Record<string, unknown>, run: (args: never, ctx: OperationContext) => unknown, exposure: { ai: 'closed' | 'confirm'; peers: 'open' | 'closed' } = { ai: 'closed', peers: 'closed' }) => ({
    description,
    params,
    result: { type: 'json' as const, description: 'Operation result' },
    effect: 'write' as const,
    exposure,
    execute: async (args: unknown, ctx: OperationContext) => run(args as never, ctx) as never,
  })
  return {
    id: 'workspace-review',
    name: '工作区回顾',
    description: '按本地工作区汇总 DSH、Claude Code、Codex 的会话，输出确定性指标、时间线与可选 AI 归纳。',
    version: '0.2.0-rc.1',
    generation: 2,
    data: { kind: 'unified', namespace: 'review', schemaVersion: 1 },
    capabilities: ['storage', 'model'],
    calls: [
      { app: 'git-browser', ops: ['status', 'log', 'diff'] },
      { app: 'tasks', ops: ['listTasks'] },
    ],
    start: async (ctx: AppContext) => { app.attach(ctx.capabilities) },
    reload: async () => { await app.reload() },
    ops: {
      listWorkspaces: read('列出本地工作区及会话/回顾数量', {}, () => app.listWorkspaces()) as never,
      createWorkspace: write('添加一个本地工作区（root 必须存在）', {
        name: str('显示名称'), root: str('工作区目录的绝对路径', true), aliases: strings('额外的路径前缀'), taskProjectId: str('可选的 tasks 项目 id'),
      }, (args: { name?: string; root: string; aliases?: string[]; taskProjectId?: string }) => app.createWorkspace(args)) as never,
      updateWorkspace: write('修改工作区名称、根目录、别名或任务项目', {
        id: str('工作区 id', true), name: str('显示名称'), root: str('新的根目录'), aliases: strings('额外的路径前缀'), taskProjectId: json('tasks 项目 id，null 表示解除绑定'),
      }, (args: { id: string; name?: string; root?: string; aliases?: string[]; taskProjectId?: string | null }) => app.updateWorkspace(args)) as never,
      syncWorkspace: write('增量同步一个工作区的三种 agent 会话源', { workspaceId: str('工作区 id', true) }, (args: { workspaceId: string }, ctx: OperationContext) => app.syncWorkspace(args.workspaceId, syncContextOf(ctx)), { ai: 'confirm', peers: 'open' }) as never,
      cancelSync: write('取消该工作区正在运行的同步', { workspaceId: str('工作区 id', true) }, (args: { workspaceId: string }) => ({ status: app.cancelSync(args.workspaceId) }), { ai: 'closed', peers: 'open' }) as never,
      listUnmatchedSessions: read('列出尚未归属到任何工作区的会话', {}, () => app.listUnmatchedSessions()) as never,
      assignSession: write('人工把一个会话归属到工作区，或传 null 解除归属', { sessionId: str('会话 id', true), workspaceId: json('工作区 id 或 null') }, (args: { sessionId: string; workspaceId: string | null }) => app.assignSession(args)) as never,
      listReviews: read('列出工作区的回顾历史', { workspaceId: str('工作区 id', true) }, (args: { workspaceId: string }) => app.listReviews(args.workspaceId)) as never,
      getReview: read('读取一份回顾快照', { reviewId: str('回顾 id', true) }, (args: { reviewId: string }) => app.getReview(args.reviewId)) as never,
      previewReview: read('预览生成范围与将发送给模型的会话摘要数量', {
        workspaceId: str('工作区 id', true), range: rangeOf('范围'), from: str('自定义起始日 YYYY-MM-DD'), to: str('自定义结束日 YYYY-MM-DD'),
      }, (args: { workspaceId: string; range: ReviewRange; from?: string; to?: string }) => app.previewReview(args)) as never,
      generateReview: write('生成不可变回顾快照（确定性报告 + 可选 AI 归纳）', {
        workspaceId: str('工作区 id', true), range: rangeOf('范围'), from: str('自定义起始日 YYYY-MM-DD'), to: str('自定义结束日 YYYY-MM-DD'), useAi: bool('是否调用模型（默认 true）'),
      }, (args: { workspaceId: string; range: ReviewRange; from?: string; to?: string; useAi?: boolean }, ctx: OperationContext) => app.generateReview(args, {
        signal: ctx.signal,
        capabilities: ctx.capabilities,
        call: peerCall(ctx),
        startTask: ctx.startTask,
        reportProgress: (message, data) => { ctx.reportProgress(message, data) },
        notifyChanged: ctx.notifyChanged,
      }), { ai: 'confirm', peers: 'open' }) as never,
      cancelGenerate: write('取消该工作区正在运行的回顾生成', { workspaceId: str('工作区 id', true) }, (args: { workspaceId: string }) => ({ status: app.cancelGenerate(args.workspaceId) }), { ai: 'closed', peers: 'open' }) as never,
      getSessionEvidence: read('读取单个会话的只读摘要证据', { sessionId: str('会话 id', true) }, (args: { sessionId: string }) => app.getSessionEvidence(args.sessionId)) as never,
      listSources: read('查看三种 agent 会话源是否发现', {}, () => app.listSources()) as never,
      settings: read('读取源目录、脱敏、保留上限与 AI 开关', {}, () => app.settings(), 'closed') as never,
      setSettings: write('修改源目录、脱敏、保留上限与 AI 开关', {
        sourceRoots: json('三种 agent 的源目录'), redactSecrets: bool('是否脱敏'), reviewRetention: int('保留份数 1..20'), aiEnabled: bool('是否允许 AI 归纳'),
      }, (args: unknown, ctx: OperationContext) => app.setSettings(args, { notifyChanged: ctx.notifyChanged })) as never,
    },
  }
}
