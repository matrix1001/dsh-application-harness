/**
 * Optional evidence from peer applications.
 *
 * Git history and tasks are never required for a review: every peer call has a
 * real "unavailable" outcome, a refused call is recorded rather than raised,
 * and the deterministic report keeps working without either application. The
 * application only reads Git (status/log/diff) and tasks (listTasks); it never
 * writes to either peer.
 * @module @matrix1001/dsh-application-harness-workspace-review/evidence
 */

import type { CallOutcome } from '@matrix1001/dsh-application-harness-runtime'
import type { GitEvidence, TaskEvidence, Workspace } from './types.ts'

/** The peer-call face both operation and task contexts provide. */
export type PeerCall = (app: string, op: string, args: Record<string, unknown>) => Promise<CallOutcome>

/** The evidence a deterministic report may carry. */
export interface OptionalEvidence {
  git: GitEvidence
  tasks?: TaskEvidence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (isRecord(value) && Array.isArray(value[key])) return value[key].filter(isRecord)
  return []
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
}

async function peer(call: PeerCall, app: string, op: string, args: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  let outcome: CallOutcome
  try {
    outcome = await call(app, op, args)
  } catch (error) {
    return { ok: false, message: String((error as Error)?.message ?? error) }
  }
  if (outcome.status === 'success') return { ok: true, value: outcome.result }
  if (outcome.status === 'cancelled') return { ok: false, message: 'cancelled' }
  /* v8 ignore next -- a failed peer outcome always carries a message; the fallback keeps the contract total */
  return { ok: false, message: outcome.error?.message ?? 'failed' }
}

interface GitStatusRead {
  branch?: string
  clean?: boolean
  files: Record<string, unknown>[]
  error?: string
}

async function readStatus(call: PeerCall, workspace: Workspace): Promise<GitStatusRead> {
  const outcome = await peer(call, 'git-browser', 'status', { path: workspace.root })
  if (!outcome.ok) return { files: [], error: outcome.message }
  const value = outcome.value
  if (!isRecord(value)) return { files: [], error: 'git-browser status returned no object' }
  const files = recordArray(value.files, 'files')
  const branch = stringOf(value.branch)
  return {
    files,
    clean: files.length === 0,
    ...(branch === undefined ? {} : { branch }),
  }
}

interface GitLogRead {
  commits: Array<{ hash: string; subject: string; date?: string }>
  error?: string
}

async function readLog(call: PeerCall, workspace: Workspace, from: string, to: string): Promise<GitLogRead> {
  const outcome = await peer(call, 'git-browser', 'log', { path: workspace.root, limit: 50 })
  if (!outcome.ok) return { commits: [], error: outcome.message }
  if (!isRecord(outcome.value)) return { commits: [], error: 'git-browser log returned no object' }
  const commits: Array<{ hash: string; subject: string; date?: string }> = []
  for (const commit of recordArray(outcome.value, 'commits').slice(0, 10)) {
    const hash = stringOf(commit.hash)
    const subject = stringOf(commit.subject)
    if (hash === undefined || subject === undefined) continue
    const date = stringOf(commit.time)
    if (date !== undefined && from !== '' && date.slice(0, 10) < from.slice(0, 10)) continue
    if (date !== undefined && to !== '' && date.slice(0, 10) > to.slice(0, 10)) continue
    commits.push({ hash, subject, ...(date === undefined ? {} : { date }) })
  }
  return { commits }
}

/**
 * Read Git status, log and diff as evidence. All three calls are attempted; a
 * single missing/refused peer call does not erase the parts that succeeded.
 * @param call - the application's peer-call face.
 * @param workspace - the workspace root.
 * @param from - inclusive ISO date, or '' for an unbounded range.
 * @param to - inclusive ISO date.
 * @param signal - cancellation signal.
 * @returns the optional Git evidence (always present, `available` says whether anything was read).
 */
export async function readGitEvidence(call: PeerCall, workspace: Workspace, from: string, to: string, signal?: AbortSignal): Promise<GitEvidence> {
  abortIfNeeded(signal)
  const status = await readStatus(call, workspace)
  abortIfNeeded(signal)
  const log = await readLog(call, workspace, from, to)
  abortIfNeeded(signal)
  const errors = [status.error, log.error].filter((message): message is string => message !== undefined)
  const evidence: GitEvidence = {
    available: status.error === undefined || log.error === undefined,
    changedFiles: status.files.length,
    commits: log.commits.length,
  }
  if (status.branch !== undefined) evidence.branch = status.branch
  if (status.clean !== undefined) evidence.clean = status.clean
  if (log.commits.length > 0) evidence.recent = log.commits
  if (status.error === undefined) {
    const additions = status.files.reduce((sum, file) => sum + (numberOf(file.additions) ?? 0), 0)
    const deletions = status.files.reduce((sum, file) => sum + (numberOf(file.deletions) ?? 0), 0)
    const hasLineStats = status.files.some(file => numberOf(file.additions) !== undefined || numberOf(file.deletions) !== undefined)
    evidence.diff = { files: status.files.length, ...(hasLineStats ? { additions, deletions } : {}) }
  }
  if (errors.length > 0) evidence.error = errors.join('; ')
  return evidence
}

/**
 * Read the bound tasks project as evidence.
 * @param call - the application's peer-call face.
 * @param projectId - the workspace's optional task project.
 * @param signal - cancellation signal.
 * @returns the optional tasks evidence, or undefined when no project is bound.
 */
export async function readTaskEvidence(call: PeerCall, projectId: string | undefined, signal?: AbortSignal): Promise<TaskEvidence | undefined> {
  if (projectId === undefined) return undefined
  abortIfNeeded(signal)
  const outcome = await peer(call, 'tasks', 'listTasks', { projectId, includeCompleted: true })
  abortIfNeeded(signal)
  if (!outcome.ok) return { available: false, projectId, total: 0, open: 0, error: outcome.message }
  const tasks = recordArray(outcome.value, 'tasks')
  return {
    available: true,
    projectId,
    total: tasks.length,
    open: tasks.filter(task => task.completedAt === null || task.completedAt === undefined).length,
  }
}

/**
 * Read all optional evidence for one workspace.
 * @param call - the application's peer-call face (absent in a keyless unit test).
 * @param workspace - the workspace.
 * @param from - inclusive ISO date, or ''.
 * @param to - inclusive ISO date.
 * @param signal - cancellation signal.
 * @returns Git evidence plus tasks evidence when a project is bound.
 */
export async function readOptionalEvidence(call: PeerCall | undefined, workspace: Workspace, from: string, to: string, signal?: AbortSignal): Promise<OptionalEvidence> {
  if (call === undefined) return { git: { available: false, changedFiles: 0, commits: 0 } }
  const [git, tasks] = await Promise.all([
    readGitEvidence(call, workspace, from, to, signal),
    readTaskEvidence(call, workspace.taskProjectId, signal),
  ])
  return { git, ...(tasks === undefined ? {} : { tasks }) }
}
