/**
 * The git-browser workbench model: narrows the four ops' wire results into
 * typed renderable faces, derives the worktree grouping, parses a unified patch
 * into renderable lines with line numbers, and owns the small pure helpers the
 * page needs (short hash, repository name, failure copy kind).
 *
 * Everything here is a pure function over `unknown` or plain data, so a
 * malformed wire section narrows to `undefined` (the page says "could not read
 * the result") instead of rendering a half-parsed repository.
 * @module @matrix1001/dsh-application-harness-git-browser-view/model
 */

import { finiteOr, formatLocalDateTime, isRecord, type TimeFormatOptions } from '@matrix1001/dsh-application-harness-client-chrome'
import type { CallOutcome } from '@matrix1001/dsh-application-harness-host-bridge/client'

/** One file status letter (mirrors the host's `FileStatus`). */
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?'

/** One worktree entry: a file changed on both sides arrives as two entries. */
export interface StatusFile {
  readonly path: string
  readonly oldPath?: string
  readonly status: FileStatus
  readonly staged: boolean
  readonly additions?: number
  readonly deletions?: number
}

/** One commit summary. */
export interface CommitFace {
  readonly hash: string
  readonly subject: string
  readonly author: string
  readonly time: string
}

/** The `status` section's renderable face. */
export interface StatusFace {
  readonly root: string
  readonly branch: string | null
  readonly detached: boolean
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  readonly files: StatusFile[]
  readonly lastCommit?: CommitFace
}

/** The `diff` section's renderable face. */
export interface DiffFace {
  readonly patch: string
  readonly truncated: boolean
  readonly binary: boolean
}

/** The `log` section's renderable face. */
export interface LogFace {
  readonly commits: CommitFace[]
}

/** One commit file statistic. */
export interface CommitFileFace {
  readonly path: string
  readonly additions: number | null
  readonly deletions: number | null
  readonly binary: boolean
}

/** One commit's header plus its body. */
export interface CommitDetailFace extends CommitFace {
  readonly body: string
}

/** The `show` section's renderable face. */
export interface ShowFace {
  readonly commit: CommitDetailFace
  readonly files: CommitFileFace[]
  readonly patch: string
  readonly truncated: boolean
  readonly binary: boolean
}

/** The stable failure shapes the page shows separately. */
export type ErrorKind = 'not-repo' | 'git-missing' | 'path-missing' | 'permission' | 'timeout' | 'output-too-large' | 'other'

/** The failure a call reports, as copy plus the host's own detail. */
export interface FailureInfo {
  readonly code?: string
  readonly message: string
}

/** A successful call's value, or `undefined` for any other outcome. */
export function valueOf(outcome: CallOutcome): unknown {
  return outcome.status === 'success' ? outcome.result : undefined
}

/**
 * The failure to show for a non-success outcome. A cancelled call has no host
 * message of its own, so the page's fallback copy is used; a success that the
 * narrowers refused reaches this helper as the same fallback (the caller says
 * "could not read the result").
 * @param outcome - the runtime's outcome.
 * @param fallback - the page's copy when the outcome carries no failure text.
 * @returns the failure copy.
 */
export function failureOf(outcome: CallOutcome, fallback: string): FailureInfo {
  if (outcome.status === 'failed' || outcome.status === 'rejected') return { ...(outcome.error?.code === undefined ? {} : { code: outcome.error.code }), message: outcome.error?.message ?? fallback }
  return { message: fallback }
}

/** One thrown value's message (a rejected call may reject with either). */
export function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The status letters this view understands. */
const FILE_STATUSES: readonly string[] = ['M', 'A', 'D', 'R', 'U', '?']

/** Whether a wire value is a status letter. */
function isFileStatus(value: unknown): value is FileStatus {
  return typeof value === 'string' && FILE_STATUSES.includes(value)
}

/** One commit's four string fields; `undefined` when the shape is not a commit. */
function commitFieldsOf(value: Record<string, unknown>): CommitFace | undefined {
  if (typeof value.hash !== 'string' || typeof value.subject !== 'string' || typeof value.author !== 'string' || typeof value.time !== 'string') return undefined
  return { hash: value.hash, subject: value.subject, author: value.author, time: value.time }
}

/** One commit record; `undefined` when malformed. */
function commitOf(value: unknown): CommitFace | undefined {
  if (!isRecord(value)) return undefined
  return commitFieldsOf(value)
}

/** One commit detail record; `undefined` when malformed (a missing body reads as empty). */
function commitDetailOf(value: unknown): CommitDetailFace | undefined {
  if (!isRecord(value)) return undefined
  const fields = commitFieldsOf(value)
  if (fields === undefined) return undefined
  return { ...fields, body: typeof value.body === 'string' ? value.body : '' }
}

/** One worktree row; `undefined` when the shape is not a row. */
function statusFileOf(value: unknown): StatusFile | undefined {
  if (!isRecord(value) || typeof value.path !== 'string' || value.path === '' || !isFileStatus(value.status)) return undefined
  return {
    path: value.path,
    status: value.status,
    staged: value.staged === true,
    ...(typeof value.oldPath === 'string' ? { oldPath: value.oldPath } : {}),
    ...(typeof value.additions === 'number' ? { additions: value.additions } : {}),
    ...(typeof value.deletions === 'number' ? { deletions: value.deletions } : {}),
  }
}

/**
 * Narrow the `status` section; `undefined` when malformed. A read must name a
 * non-empty repository root: without one there is no canonical root for the
 * page's later reads.
 * @param value - the raw op result.
 * @returns the renderable face, or undefined.
 */
export function statusOf(value: unknown): StatusFace | undefined {
  if (!isRecord(value) || typeof value.root !== 'string' || value.root === '' || !Array.isArray(value.files)) return undefined
  const files: StatusFile[] = []
  for (const raw of value.files) {
    const file = statusFileOf(raw)
    if (file === undefined) return undefined
    files.push(file)
  }
  const lastCommit = commitOf(value.lastCommit)
  return {
    root: value.root,
    branch: typeof value.branch === 'string' ? value.branch : null,
    detached: value.detached === true,
    upstream: typeof value.upstream === 'string' ? value.upstream : null,
    ahead: finiteOr(value.ahead, 0),
    behind: finiteOr(value.behind, 0),
    files,
    ...(lastCommit === undefined ? {} : { lastCommit }),
  }
}

/**
 * Narrow the `diff` section; `undefined` when malformed.
 * @param value - the raw op result.
 * @returns the renderable face, or undefined.
 */
export function diffOf(value: unknown): DiffFace | undefined {
  if (!isRecord(value) || typeof value.patch !== 'string') return undefined
  return { patch: value.patch, truncated: value.truncated === true, binary: value.binary === true }
}

/**
 * Narrow the `log` section; `undefined` when malformed.
 * @param value - the raw op result.
 * @returns the renderable face, or undefined.
 */
export function logOf(value: unknown): LogFace | undefined {
  if (!isRecord(value) || !Array.isArray(value.commits)) return undefined
  const commits: CommitFace[] = []
  for (const raw of value.commits) {
    const commit = commitOf(raw)
    if (commit === undefined) return undefined
    commits.push(commit)
  }
  return { commits }
}

/** One commit file row; `undefined` when malformed (a missing count reads as binary's null). */
function commitFileOf(value: unknown): CommitFileFace | undefined {
  if (!isRecord(value) || typeof value.path !== 'string') return undefined
  return {
    path: value.path,
    binary: value.binary === true,
    additions: typeof value.additions === 'number' ? value.additions : null,
    deletions: typeof value.deletions === 'number' ? value.deletions : null,
  }
}

/**
 * Narrow the `show` section; `undefined` when malformed.
 * @param value - the raw op result.
 * @returns the renderable face, or undefined.
 */
export function showOf(value: unknown): ShowFace | undefined {
  if (!isRecord(value) || typeof value.patch !== 'string' || !Array.isArray(value.files)) return undefined
  const commit = commitDetailOf(value.commit)
  if (commit === undefined) return undefined
  const files: CommitFileFace[] = []
  for (const raw of value.files) {
    const file = commitFileOf(raw)
    if (file === undefined) return undefined
    files.push(file)
  }
  return {
    commit,
    files,
    patch: value.patch,
    truncated: value.truncated === true,
    binary: value.binary === true,
  }
}

/** The four worktree groups, in display order. */
export type WorktreeGroup = 'staged' | 'unstaged' | 'untracked' | 'conflict'

/** The group order as a constant (the group id is code, its label is copy). */
export const WORKTREE_GROUPS: readonly WorktreeGroup[] = ['staged', 'unstaged', 'untracked', 'conflict']

/** One non-empty worktree section. */
export interface WorktreeSection {
  readonly group: WorktreeGroup
  readonly files: StatusFile[]
}

/**
 * The group one entry belongs to. Untracked and conflicted entries have their
 * own groups; the rest follows the side the entry belongs to.
 * @param file - one narrowed status entry.
 * @returns the group id.
 */
export function groupOf(file: StatusFile): WorktreeGroup {
  if (file.status === '?') return 'untracked'
  if (file.status === 'U') return 'conflict'
  return file.staged ? 'staged' : 'unstaged'
}

/**
 * Group the status entries for display (empty groups are omitted).
 * @param files - the narrowed status entries.
 * @returns the non-empty sections, in {@link WORKTREE_GROUPS} order.
 */
export function groupFiles(files: readonly StatusFile[]): WorktreeSection[] {
  return WORKTREE_GROUPS
    .map((group) => ({ group, files: files.filter((file) => groupOf(file) === group) }))
    .filter((section) => section.files.length > 0)
}

/** The short commit identity shown in a history row (8 hex chars, git-style abbreviation). */
export function shortHash(hash: string): string {
  return hash.slice(0, 8)
}

/**
 * The repository name from its root path.
 * @param root - the resolved repository root.
 * @returns the last path segment, or the root itself when it has none (`/`).
 */
export function repoNameOf(root: string): string {
  const parts = root.split('/').filter((part) => part !== '')
  return parts.at(-1) ?? root
}

/**
 * Format a commit's ISO author time; an unparseable stamp stays verbatim
 * (never `Invalid Date`).
 * @param iso - the wire's strict ISO 8601 stamp.
 * @param options - locale/time-zone pinning (tests).
 * @returns the local date-time label.
 */
export function commitDateLabel(iso: string, options: TimeFormatOptions = {}): string {
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp) ? iso : formatLocalDateTime(timestamp, options)
}

/** One renderable unified-diff line. */
export interface PatchLine {
  readonly kind: 'hunk' | 'add' | 'del' | 'ctx'
  /** The line text, without the diff marker (`hunk` keeps its header verbatim). */
  readonly text: string
  /** The old-side line number (`null` for a hunk header and an added line). */
  readonly oldLine: number | null
  /** The new-side line number (`null` for a hunk header and a deleted line). */
  readonly newLine: number | null
}

/** One hunk header's numbers: `@@ -old,count +new,count @@`. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u

/**
 * Parse a unified patch into hunk headers and numbered lines. File metadata is
 * skipped (only hunks and their lines are rendered); the end-of-file marker
 * (`\ No newline at end of file`) is not content and is skipped too. A second
 * file in the patch starts its own hunk numbering because `diff --git` ends the
 * previous hunk.
 * @param patch - the unified patch.
 * @returns the renderable lines, in patch order.
 */
export function parsePatch(patch: string): PatchLine[] {
  const lines: PatchLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const header = HUNK_HEADER.exec(raw)
      if (header !== null) {
        oldLine = Number(header[1])
        newLine = Number(header[2])
      }
      inHunk = true
      lines.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null })
      continue
    }
    if (raw.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine })
      newLine += 1
      continue
    }
    if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldLine, newLine: null })
      oldLine += 1
      continue
    }
    if (raw.startsWith(' ')) {
      lines.push({ kind: 'ctx', text: raw.slice(1), oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }
  return lines
}

/** The line totals of one parsed patch (binary patches have none). */
export interface PatchStats {
  readonly additions: number
  readonly deletions: number
}

/**
 * Count a parsed patch's added and deleted lines.
 * @param lines - the parsed lines.
 * @returns the two counts.
 */
export function patchStats(lines: readonly PatchLine[]): PatchStats {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.kind === 'add') additions += 1
    else if (line.kind === 'del') deletions += 1
  }
  return { additions, deletions }
}

/**
 * The failure kind a stable host code names — the four states the page shows
 * separately plus the generic fallback.
 * @param code - the outcome's code, when it carried one.
 * @returns the kind.
 */
export function errorKindOf(code: string | undefined): ErrorKind {
  switch (code) {
    case 'not-a-repo': return 'not-repo'
    case 'git-missing': return 'git-missing'
    case 'path-not-found': return 'path-missing'
    case 'capability-not-approved':
    case 'app.capability-not-approved':
    case 'capability-undeclared':
    case 'app.capability-undeclared': return 'permission'
    case 'timeout': return 'timeout'
    case 'output-too-large': return 'output-too-large'
    default: return 'other'
  }
}
