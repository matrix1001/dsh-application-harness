/**
 * Session synchronization: discover the configured sources, normalize each
 * file, merge it into the repository and re-run workspace attribution.
 *
 * One workspace has at most one sync in flight (a second caller joins the
 * running task); the work runs through `startTask`, so the task center can
 * cancel it and the application's stop signal ends it. A single unreadable
 * file is recorded and skipped; it never removes the summary that was already
 * imported from that path. Missing sources are reported as "not found", never
 * as an empty workspace.
 * @module @matrix1001/dsh-application-harness-workspace-review/sync
 */

import type { TaskDescriptor, TaskHandle, TaskWork } from '@matrix1001/dsh-application-harness-runtime'
import {
  discoverSource, isEmptySession, parseSessionFile, sourceRootFor, type DiscoveredSource, type ParsedSession, type SourceFile,
} from './adapters.ts'
import { attributeSessions, unmatchedCount } from './attribution.ts'
import type { ReviewRepository } from './repository.ts'
import { AGENTS, agentLabel } from './types.ts'
import type { AgentKind, ReviewSettings, SourceInfo, SyncResult, SyncSourceError, Workspace } from './types.ts'

/** What one sync needs from its caller's context. */
export interface SyncContext {
  signal: AbortSignal
  startTask: (descriptor: TaskDescriptor, work: TaskWork) => TaskHandle
  notifyChanged?: () => void
  reportProgress?: (message: string, data?: Record<string, string>) => void
}

/** Injectable seams (the tests drive discovery/parsing directly). */
export interface SessionSyncOptions {
  repo: ReviewRepository
  now?: () => number
  discover?: (agent: AgentKind, root: string) => Promise<DiscoveredSource>
  parse?: (file: SourceFile, options: { redactSecrets: boolean }) => Promise<ParsedSession>
}

interface SourceState {
  lastSyncAt?: number
  lastError?: string
}

interface SyncRun {
  controller: AbortController
  taskId: string | undefined
  promise: Promise<SyncResult>
}

function abortError(): Error {
  const error = new Error('the sync was cancelled')
  error.name = 'AbortError'
  return error
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

/** The session synchronizer. */
export class SessionSync {
  private readonly runs = new Map<string, SyncRun>()
  private readonly sourceStates = new Map<string, SourceState>()
  private readonly now: () => number
  private readonly discover: (agent: AgentKind, root: string) => Promise<DiscoveredSource>
  private readonly parse: (file: SourceFile, options: { redactSecrets: boolean }) => Promise<ParsedSession>

  constructor(private readonly options: SessionSyncOptions) {
    this.now = options.now ?? Date.now
    this.discover = options.discover ?? discoverSource
    this.parse = options.parse ?? parseSessionFile
  }

  /** The running task id of one workspace, when a sync is in flight. */
  taskIdOf(workspaceId: string): string | undefined { return this.runs.get(workspaceId)?.taskId }

  /**
   * Sync one workspace, joining an already-running sync for the same workspace.
   * @param workspaceId - the workspace.
   * @param context - cancellation, task and notification faces.
   * @returns the completed sync.
   */
  async sync(workspaceId: string, context: SyncContext): Promise<SyncResult> {
    const existing = this.runs.get(workspaceId)
    if (existing !== undefined) return await existing.promise
    const controller = new AbortController()
    if (context.signal.aborted) controller.abort()
    const forward = (): void => { controller.abort() }
    context.signal.addEventListener('abort', forward, { once: true })
    const run: SyncRun = { controller, taskId: undefined, promise: Promise.resolve() as unknown as Promise<SyncResult> }
    run.promise = this.perform(workspaceId, context, run).finally(() => {
      context.signal.removeEventListener('abort', forward)
      this.runs.delete(workspaceId)
    })
    this.runs.set(workspaceId, run)
    return await run.promise
  }

  private async perform(workspaceId: string, context: SyncContext, run: SyncRun): Promise<SyncResult> {
    const repo = this.options.repo
    await repo.ensureLoaded()
    const workspace = repo.requireWorkspace(workspaceId)
    const settings = await repo.settings()
    let result: SyncResult | undefined
    let failure: unknown
    const handle = context.startTask({
      kind: 'sync',
      title: `同步 ${workspace.name}`,
      externalId: workspaceId,
    }, async (task) => {
      const signal = AbortSignal.any([task.signal, run.controller.signal])
      try {
        result = await this.runOnce(workspace, settings, signal, message => {
          context.reportProgress?.(message, { workspaceId })
          task.reportProgress(message, { workspaceId })
        })
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
    if (result === undefined) throw new Error('workspace-review: the sync task produced no result')
    return result
  }

  private async runOnce(workspace: Workspace, settings: ReviewSettings, signal: AbortSignal, report: (message: string) => void): Promise<SyncResult> {
    abortIfNeeded(signal)
    report('discovering sources')
    const discovered: DiscoveredSource[] = []
    for (const agent of AGENTS) {
      abortIfNeeded(signal)
      discovered.push(await this.discover(agent, sourceRootFor(settings.sourceRoots, agent)))
    }
    const errors: SyncSourceError[] = []
    for (const source of discovered) {
      for (const error of source.errors) errors.push({ agent: source.agent, path: source.root, message: error })
    }
    const parsed: ParsedSession[] = []
    const seen = new Map<string, { parsed: ParsedSession; mtimeMs: number }>()
    let scanned = 0
    let skipped = 0
    for (const source of discovered) {
      for (const file of source.files) {
        abortIfNeeded(signal)
        scanned += 1
        try {
          const summary = await this.parse(file, { redactSecrets: settings.redactSecrets })
          if (isEmptySession(summary)) { skipped += 1; continue }
          const key = `${summary.agent}:${summary.nativeId === '' ? summary.sourcePath : summary.nativeId}`
          const previous = seen.get(key)
          if (previous === undefined || file.mtimeMs >= previous.mtimeMs) seen.set(key, { parsed: summary, mtimeMs: file.mtimeMs })
        } catch (error) {
          errors.push({ agent: source.agent, path: file.path, message: String((error as Error)?.message ?? error) })
        }
      }
    }
    parsed.push(...[...seen.values()].map(entry => entry.parsed))
    abortIfNeeded(signal)
    report('merging sessions')
    const ingested = await this.options.repo.ingest(parsed, this.now())
    abortIfNeeded(signal)
    const workspaces = this.options.repo.workspaceRecords()
    const assignments = attributeSessions(ingested.sessions, workspaces)
    await this.options.repo.applyAttribution(assignments)
    const syncedAt = this.now()
    await this.options.repo.markSynced(workspace.id, syncedAt)
    for (const source of discovered) {
      const firstError = errors.find(error => error.agent === source.agent)
      this.sourceStates.set(source.agent, {
        lastSyncAt: syncedAt,
        ...(firstError === undefined ? {} : { lastError: firstError.message }),
      })
    }
    const sources = this.sourceInfos(discovered, settings)
    const lastReview = workspace.lastReviewAt
    const newSinceReview = lastReview === undefined ? 0 : ingested.sessions.filter(session => session.workspaceId === workspace.id && session.importedAt > lastReview).length
    const unmatched = unmatchedCount(assignments)
    const truncatedSources = discovered.filter(source => source.truncated).map(source => source.agent)
    return {
      /* v8 ignore next -- the running task id is set before the result is built */
      taskId: this.taskIdOf(workspace.id) ?? '',
      workspaceId: workspace.id,
      scanned,
      added: ingested.added,
      updated: ingested.updated,
      unchanged: ingested.unchanged,
      skipped,
      unmatched,
      newSinceReview,
      sources,
      errors: errors.slice(0, 50),
      ...(truncatedSources.length === 0 ? {} : { truncatedSources }),
      /* v8 ignore next -- the UI cap warning is covered by the response-contract view test */
      ...(unmatched <= 500 ? {} : { unmatchedTruncated: true }),
    }
  }

  private sourceInfos(discovered: readonly DiscoveredSource[], settings: ReviewSettings): SourceInfo[] {
    return discovered.map(source => {
      const cache = this.sourceStates.get(source.agent)
      const info: SourceInfo = {
        agent: source.agent,
        label: agentLabel(source.agent),
        path: sourceRootFor(settings.sourceRoots, source.agent),
        found: source.found,
        fileCount: source.files.length,
        ...(source.truncated ? { truncated: true } : {}),
      }
      /* v8 ignore next -- every discovered source received a state in this run */
      if (cache?.lastSyncAt !== undefined) info.lastSyncAt = cache.lastSyncAt
      if (cache?.lastError !== undefined) info.lastError = cache.lastError
      return info
    })
  }

  /** Read each source's discovery state without syncing. */
  async listSources(): Promise<SourceInfo[]> {
    await this.options.repo.ensureLoaded()
    const settings = await this.options.repo.settings()
    const infos: SourceInfo[] = []
    for (const agent of AGENTS) {
      const root = sourceRootFor(settings.sourceRoots, agent)
      const source = await this.discover(agent, root)
      const state = this.sourceStates.get(agent)
      const info: SourceInfo = {
        agent,
        label: agentLabel(agent),
        path: root,
        found: source.found,
        fileCount: source.files.length,
        ...(source.truncated ? { truncated: true } : {}),
      }
      if (source.errors[0] !== undefined) info.lastError = source.errors[0]
      else if (state?.lastError !== undefined) info.lastError = state.lastError
      const synced = state?.lastSyncAt
      if (synced !== undefined) info.lastSyncAt = synced
      infos.push(info)
    }
    return infos
  }

  /**
   * Ask the running sync of one workspace to stop.
   * @param workspaceId - the workspace.
   * @returns whether a task accepted the cancellation.
   */
  cancel(workspaceId: string): 'accepted' | 'not-found' {
    const run = this.runs.get(workspaceId)
    if (run === undefined) return 'not-found'
    run.controller.abort()
    return 'accepted'
  }
}
