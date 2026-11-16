/**
 * The git-browser application, declared once: four read-only operations over a
 * repository the caller names. Each op runs only fixed-argv git subcommands
 * through the injected process seam ({@link GitCommandRunner}); there is no
 * shell, no write subcommand and no durable state (`generation: 2`,
 * `data: { kind: 'none' }`).
 *
 * The stable failure codes the view reads are:
 *
 * - `not-a-repo` — the path is not inside a git repository;
 * - `path-not-found` — the path does not exist or is not a directory;
 * - `git-missing` — the git binary could not be started;
 * - `timeout` — a command exceeded its wall-clock deadline;
 * - `output-too-large` — a status/log stream hit the 1 MiB cap, so a partial
 *   list must not be presented as the whole repository;
 * - `invalid-args` / `invalid-rev` — a caller-supplied value cannot be that
 *   argument;
 * - `git-failed` — git refused for a reason none of the above names (its stderr
 *   rides in the message).
 *
 * `diff`/`show` patches are bounded to 1 MiB / 2000 lines instead of failing:
 * their result carries `truncated` and, for a binary change, `binary`.
 * @module @matrix1001/dsh-application-harness-git-browser/app
 */

import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { AppDeclaration, OperationContext, ParameterSchemaSpec, ValueSchemaSpec } from '@matrix1001/dsh-application-harness-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT,
  attachStats, classifyGitFailure, diffArgv, isEmptyRepository, isBinaryPatch,
  lastCommitArgv, logArgv, numstatArgv, parseCommitFiles, parseLog, parseNumstat,
  parseShowHeader, parseStatus, readLogLimit, readRepoFile, readRepoPath, readRev,
  readStaged, rootArgv, showHeaderArgv, showNumstatArgv, showPatchArgv, statusArgv,
  truncatePatch,
} from './git.ts'
import type { CommitSummary, LogResult, NumStatEntry, RepoStatus, ShowResult } from './git.ts'
import type { GitCommandResult, GitCommandRunner, GitRunContext } from './subprocess.ts'

/** What the application needs to run: the injected process seam. */
export interface GitBrowserOptions {
  /** The git command runner (the platform subprocess service behind it in production). */
  readonly run: GitCommandRunner
}

/** The `status` op's arguments. */
interface StatusArgs {
  readonly path: string
}

/** The `diff` op's arguments. */
interface DiffArgs {
  readonly path: string
  readonly file: string
  readonly staged: boolean
}

/** The `log` op's arguments. */
interface LogArgs {
  readonly path: string
  readonly limit: number
  readonly ref: string | undefined
}

/** The `show` op's arguments. */
interface ShowArgs {
  readonly path: string
  readonly rev: string
}

// ── schemas (the platform's JSON-Schema DSL) ────────────────────────────────

const str = (description: string, required = false): ValueSchemaSpec & { required?: true } =>
  required ? { type: 'string', description, required: true } : { type: 'string', description }

const int = (description: string): ValueSchemaSpec => ({ type: 'integer', description })
const bool = (description: string): ValueSchemaSpec => ({ type: 'boolean', description })

/** A string fact that is `null` when it has no value. */
const nullableStr = (description: string, absent: string): ValueSchemaSpec => ({
  oneOf: [{ type: 'string', description }, { type: 'null', description: absent }],
  description,
})

/** One worktree entry (a file changed on both sides yields two entries). */
const FILE_ENTRY: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    path: { type: 'string', description: 'Path relative to the repository root' },
    oldPath: { type: 'string', description: 'Pre-image path of a rename/copy (absent otherwise)' },
    status: { type: 'string', description: 'One of M, A, D, R, U, ?' },
    staged: bool('Whether this entry is the index side'),
    additions: int('Added lines (absent for untracked/binary files)'),
    deletions: int('Deleted lines (absent for untracked/binary files)'),
  },
  description: 'One changed path on one side',
}

/** One commit summary. */
const COMMIT_SUMMARY: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    hash: { type: 'string', description: 'Full commit hash' },
    subject: { type: 'string', description: 'Subject line' },
    author: { type: 'string', description: 'Author name' },
    time: { type: 'string', description: 'Author date, strict ISO 8601 with offset' },
  },
  description: 'One commit',
}

/** One commit file statistic. */
const COMMIT_FILE: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    path: { type: 'string', description: 'Path relative to the repository root' },
    additions: {
      oneOf: [{ type: 'integer', description: 'Added lines' }, { type: 'null', description: 'Binary file' }],
      description: 'Added lines',
    },
    deletions: {
      oneOf: [{ type: 'integer', description: 'Deleted lines' }, { type: 'null', description: 'Binary file' }],
      description: 'Deleted lines',
    },
    binary: bool('Whether git reported a binary change'),
  },
  description: 'One file in a commit',
}

/** The `status` result. */
const STATUS_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    root: { type: 'string', description: 'Repository root' },
    branch: nullableStr('Current branch name', 'Detached HEAD'),
    detached: bool('Whether HEAD is detached'),
    upstream: nullableStr('Configured upstream branch', 'No upstream configured'),
    ahead: int('Commits ahead of the upstream'),
    behind: int('Commits behind the upstream'),
    files: { type: 'array', items: FILE_ENTRY, description: 'Changed paths, one entry per side' },
    lastCommit: COMMIT_SUMMARY,
  },
  description: 'The working-tree status of one repository',
}

/** The `diff` result. */
const DIFF_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    patch: { type: 'string', description: 'File-level unified patch (possibly a capped prefix)' },
    truncated: bool('Whether the byte/line cap cut the patch'),
    binary: bool('Whether git reported a binary change'),
  },
  description: 'One file\'s unified patch',
}

/** The `log` result. */
const LOG_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    commits: { type: 'array', items: COMMIT_SUMMARY, description: 'Commits, newest first' },
  },
  description: 'Recent commits of one repository',
}

/** The `show` result. */
const SHOW_RESULT: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    commit: {
      type: 'object',
      additionalProperties: true,
      properties: {
        hash: { type: 'string', description: 'Full commit hash' },
        subject: { type: 'string', description: 'Subject line' },
        author: { type: 'string', description: 'Author name' },
        time: { type: 'string', description: 'Author date, strict ISO 8601 with offset' },
        body: { type: 'string', description: 'Commit body, trailing newline trimmed' },
      },
      description: 'The commit header',
    },
    files: { type: 'array', items: COMMIT_FILE, description: 'File statistics, in git order' },
    patch: { type: 'string', description: 'Unified patch (possibly a capped prefix)' },
    truncated: bool('Whether the byte/line cap cut the patch'),
    binary: bool('Whether any changed file is binary'),
  },
  description: 'One commit with its file statistics and patch',
}

/** The path parameter every op requires. */
const repoPath = (): ParameterSchemaSpec[string] => str('Repository (or a directory inside it) to inspect', true)

// ── the read path ───────────────────────────────────────────────────────────

/** The failure an exit code becomes: a stable class when git's stderr names one. */
function failureFor(result: GitCommandResult, label: string, rev?: string): AppError {
  const classified = classifyGitFailure(result.stderr, rev !== undefined)
  const detail = result.stderr.trim()
  const message = `${label} failed (exit ${String(result.code)}): ${detail === '' ? 'no stderr' : detail}`
  if (classified !== undefined) return new AppError(classified, message)
  return new AppError('git-failed', message)
}

/** Run one mandatory git command and require a zero exit. */
async function checked(
  runner: GitCommandRunner,
  argv: readonly string[],
  ctx: GitRunContext,
  label: string,
  rev?: string,
): Promise<GitCommandResult> {
  const result = await runner.run(argv, ctx)
  if (result.code !== 0) throw failureFor(result, label, rev)
  return result
}

/** Read one side's numstat counts; a failed/capped numstat read is a missing statistic, not a failed status. */
async function statsFor(
  runner: GitCommandRunner,
  path: string,
  staged: boolean,
  ctx: GitRunContext,
): Promise<Map<string, NumStatEntry>> {
  const result = await runner.run(numstatArgv(path, staged), ctx)
  if (result.code !== 0 || result.truncated) return new Map()
  return parseNumstat(result.stdout)
}

/** Read the newest commit; an unborn HEAD (and a capped answer) simply has none. */
async function lastCommitFor(runner: GitCommandRunner, path: string, ctx: GitRunContext): Promise<CommitSummary | undefined> {
  const result = await runner.run(lastCommitArgv(path), ctx)
  if (result.code !== 0 || result.truncated) return undefined
  return parseLog(result.stdout)[0]
}

/** Resolve the canonical repository root, falling back to the requested path. */
async function rootFor(runner: GitCommandRunner, path: string, ctx: GitRunContext): Promise<string> {
  const result = await runner.run(rootArgv(path), ctx)
  if (result.code !== 0) return path
  const root = result.stdout.trim()
  return root === '' ? path : root
}

/** Run the `status` read. */
async function status(path: string, runner: GitCommandRunner, ctx: GitRunContext): Promise<RepoStatus> {
  const result = await checked(runner, statusArgv(path), ctx, 'git status')
  if (result.truncated) throw new AppError('output-too-large', 'git status output exceeded the 1 MiB cap')
  const parsed = parseStatus(result.stdout)
  const staged = await statsFor(runner, path, true, ctx)
  const worktree = await statsFor(runner, path, false, ctx)
  const lastCommit = await lastCommitFor(runner, path, ctx)
  const root = await rootFor(runner, path, ctx)
  return {
    root,
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files: attachStats(parsed.files, staged, worktree),
    ...(lastCommit === undefined ? {} : { lastCommit }),
  }
}

/** Run the `diff` read and bound its patch. */
async function diff(args: DiffArgs, runner: GitCommandRunner, ctx: GitRunContext): Promise<{ patch: string; truncated: boolean; binary: boolean }> {
  const result = await checked(runner, diffArgv(args.path, args.file, args.staged), ctx, 'git diff')
  const bounded = truncatePatch(result.stdout)
  return {
    patch: bounded.patch,
    truncated: [bounded.truncated, result.truncated].includes(true),
    binary: isBinaryPatch(result.stdout),
  }
}

/** Run the `log` read. */
async function log(args: LogArgs, runner: GitCommandRunner, ctx: GitRunContext): Promise<LogResult> {
  const ref = args.ref ?? 'HEAD'
  const result = await runner.run(logArgv(args.path, args.limit, ref), ctx)
  if (result.code !== 0) {
    // An unborn HEAD is an empty history, not a failure the view should paint
    // as an error: the repository simply has no commits yet.
    if (isEmptyRepository(result.stderr)) return { commits: [] }
    throw failureFor(result, 'git log', args.ref)
  }
  if (result.truncated) throw new AppError('output-too-large', 'git log output exceeded the 1 MiB cap')
  return { commits: parseLog(result.stdout) }
}

/** Run the `show` read: header, file statistics and the bounded patch. */
async function show(args: ShowArgs, runner: GitCommandRunner, ctx: GitRunContext): Promise<ShowResult> {
  const header = await checked(runner, showHeaderArgv(args.path, args.rev), ctx, 'git show', args.rev)
  if (header.truncated) throw new AppError('output-too-large', 'git show header exceeded the 1 MiB cap')
  const numstat = await checked(runner, showNumstatArgv(args.path, args.rev), ctx, 'git show', args.rev)
  const patch = await checked(runner, showPatchArgv(args.path, args.rev), ctx, 'git show', args.rev)
  const bounded = truncatePatch(patch.stdout)
  const files = parseCommitFiles(numstat.stdout)
  return {
    commit: parseShowHeader(header.stdout),
    files,
    patch: bounded.patch,
    truncated: [numstat.truncated, bounded.truncated, patch.truncated].includes(true),
    binary: [isBinaryPatch(patch.stdout), files.some((file) => file.binary)].includes(true),
  }
}

/** Read the raw arguments as a record (the runtime validated the schema already; this is the typed half). */
function recordOf(raw: JsonValue): Record<string, unknown> {
  return raw as unknown as Record<string, unknown>
}

/** Read the `status` arguments. */
function statusArgsOf(raw: JsonValue): StatusArgs {
  const args = recordOf(raw)
  return { path: readRepoPath(args.path) }
}

/** Read the `diff` arguments. */
function diffArgsOf(raw: JsonValue): DiffArgs {
  const args = recordOf(raw)
  return { path: readRepoPath(args.path), file: readRepoFile(args.file), staged: readStaged(args.staged) }
}

/** Read the `log` arguments. */
function logArgsOf(raw: JsonValue): LogArgs {
  const args = recordOf(raw)
  return { path: readRepoPath(args.path), limit: readLogLimit(args.limit), ref: readRev(args.ref, false) }
}

/** Read the `show` arguments. */
function showArgsOf(raw: JsonValue): ShowArgs {
  const args = recordOf(raw)
  return { path: readRepoPath(args.path), rev: readRev(args.rev, true)! }
}

/**
 * Build the application declaration.
 * @param options - the injected process seam.
 * @returns the declaration the runtime registers.
 */
export function gitBrowserDeclaration(options: GitBrowserOptions): AppDeclaration {
  const runner = options.run
  return {
    id: 'git-browser',
    name: 'git-browser',
    description: '只读 Git 浏览：`status`/`diff`/`log`/`show` 四个只读 op，返回工作区分组、文件级 unified patch、提交历史与提交详情；patch 有 1 MiB / 2000 行上限并显式标记截断与二进制',
    version: '0.2.0-rc.1',
    generation: 2,
    data: { kind: 'none' },
    capabilities: ['process'],
    ops: {
      status: {
        description: 'Read the working-tree status of a git repository (read-only)',
        params: { path: repoPath() },
        result: STATUS_RESULT,
        exposure: { ai: 'open', peers: 'open' },
        effect: 'read',
        execute: async (raw, ctx: OperationContext) => {
          const args = statusArgsOf(raw)
          return await status(args.path, runner, ctx) as unknown as JsonValue
        },
      },
      diff: {
        description: 'Read one file\'s unified patch from the working tree or the index (read-only)',
        params: {
          path: repoPath(),
          file: str('File path relative to the `path` argument (usually the repository root)', true),
          staged: bool('Diff the index against HEAD (`--cached`); default false = the working tree'),
        },
        result: DIFF_RESULT,
        exposure: { ai: 'open', peers: 'open' },
        effect: 'read',
        execute: async (raw, ctx: OperationContext) => {
          const args = diffArgsOf(raw)
          return await diff(args, runner, ctx) as unknown as JsonValue
        },
      },
      log: {
        description: 'Read the recent commit history of a git repository (read-only)',
        params: {
          path: repoPath(),
          limit: int(`Number of commits to return (default ${String(DEFAULT_LOG_LIMIT)}, hard cap ${String(MAX_LOG_LIMIT)})`),
          ref: str('Revision to walk (default `HEAD`); a value starting with "-" is rejected'),
        },
        result: LOG_RESULT,
        exposure: { ai: 'open', peers: 'open' },
        effect: 'read',
        execute: async (raw, ctx: OperationContext) => {
          const args = logArgsOf(raw)
          return await log(args, runner, ctx) as unknown as JsonValue
        },
      },
      show: {
        description: 'Read one commit of a git repository: header, file statistics and unified patch (read-only)',
        params: {
          path: repoPath(),
          rev: str('The commit to show (e.g. `HEAD`, a hash, a tag); a value starting with "-" is rejected', true),
        },
        result: SHOW_RESULT,
        exposure: { ai: 'open', peers: 'open' },
        effect: 'read',
        execute: async (raw, ctx: OperationContext) => {
          const args = showArgsOf(raw)
          return await show(args, runner, ctx) as unknown as JsonValue
        },
      },
    },
  }
}
