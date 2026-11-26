/**
 * The git-browser vocabulary: the fixed read-only `git` argv templates, the
 * pure parsers that turn git's text into the wire shapes, the parameter
 * boundary (repository path, in-repository file, revision, page size) and the
 * bounded-patch rule.
 *
 * Every command is a fixed argv array with the repository named through
 * `-C`; nothing here builds a shell command. A caller-supplied revision is
 * validated (no blank, no leading `-`, no NUL) **and** placed after
 * `--end-of-options`, so an option-shaped value is refused twice. A file is
 * passed after `--` as a literal pathspec, and is required to be a relative
 * path inside the repository (no absolute path, no `..` segment).
 *
 * The patch cap is the view's contract, not a git option: `diff`/`show`
 * return the first 1 MiB / 2000 lines of the patch and say `truncated` when
 * they had to cut it. `status`/`log` refuse a capped stream with
 * `output-too-large` instead: a partial porcelain/log page cannot be
 * presented as the whole repository.
 * @module @matrix1001/dsh-application-harness-git-browser/git
 */

import { Buffer } from 'node:buffer'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'

/** `log`'s default page size. */
export const DEFAULT_LOG_LIMIT = 50

/** `log`'s hard page-size cap (a bigger page is a worse answer, not a better one). */
export const MAX_LOG_LIMIT = 100

/** The patch byte cap a `diff`/`show` result is cut at. */
export const MAX_PATCH_BYTES = 1024 * 1024

/** The patch line cap a `diff`/`show` result is cut at. */
export const MAX_PATCH_LINES = 2000

/** One file status letter (git's porcelain letter collapsed to the set the UI paints). */
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?'

/** One changed path in one worktree group. */
export interface RepoFile {
  /** Path relative to the repository root. */
  readonly path: string
  /** The pre-image path of a rename/copy entry (absent otherwise). */
  readonly oldPath?: string
  /** The status letter for this side. */
  readonly status: FileStatus
  /** Whether this entry is the staged (index) side. */
  readonly staged: boolean
  /** Added lines (absent for an untracked/binary file). */
  readonly additions?: number
  /** Deleted lines (absent for an untracked/binary file). */
  readonly deletions?: number
}

/** The last commit shown in the repository header. */
export interface CommitSummary {
  /** Full commit hash. */
  readonly hash: string
  /** Subject line. */
  readonly subject: string
  /** Author name. */
  readonly author: string
  /** Author date, strict ISO 8601 with offset. */
  readonly time: string
}

/** The `status` result. */
export interface RepoStatus {
  /** Repository root (`git rev-parse --show-toplevel`), or the requested path when git cannot resolve it. */
  readonly root: string
  /** Current branch name, or `null` on a detached HEAD. */
  readonly branch: string | null
  /** Whether HEAD is detached. */
  readonly detached: boolean
  /** Configured upstream, or `null`. */
  readonly upstream: string | null
  /** Commits ahead of the upstream (0 when none). */
  readonly ahead: number
  /** Commits behind the upstream (0 when none). */
  readonly behind: number
  /** One entry per change AND side: a file changed in both index and worktree has two entries. */
  readonly files: RepoFile[]
  /** The newest commit, when the repository has one. */
  readonly lastCommit?: CommitSummary
}

/** One file's line delta in a commit. */
export interface CommitFile {
  /** Path relative to the repository root. */
  readonly path: string
  /** Added lines, or `null` for a binary file. */
  readonly additions: number | null
  /** Deleted lines, or `null` for a binary file. */
  readonly deletions: number | null
  /** Whether git reported the file as binary. */
  readonly binary: boolean
}

export interface DiffResult {
  /** The unified patch (possibly a capped prefix when `truncated`). */
  readonly patch: string
  /** Whether the byte/line cap cut the patch. */
  readonly truncated: boolean
  /** Whether git reported a binary change. */
  readonly binary: boolean
}

/** The `log` result. */
export interface LogResult {
  /** Commits, newest first. */
  readonly commits: CommitSummary[]
}

/** One commit's full header. */
export interface CommitDetail extends CommitSummary {
  /** Commit body, with git's trailing newline trimmed (empty when there is none). */
  readonly body: string
}

/** The `show` result: one commit, its file statistics and its unified patch. */
export interface ShowResult {
  /** The commit header. */
  readonly commit: CommitDetail
  /** File statistics, in git's order. */
  readonly files: CommitFile[]
  /** The unified patch (possibly a capped prefix when `truncated`). */
  readonly patch: string
  /** Whether the byte/line cap cut the patch. */
  readonly truncated: boolean
  /** Whether git reported a binary change. */
  readonly binary: boolean
}

/** A binary-aware `--numstat` entry (the `-`/`-` counts and the number pair are one fact). */
export type NumStatEntry =
  | { readonly additions: number; readonly deletions: number; readonly binary: false }
  | { readonly additions: null; readonly deletions: null; readonly binary: true }

/** The `status` record format: four header fields plus one record per changed path. */
export const STATUS_FORMAT = '--porcelain=v2 --branch --untracked-files=all -z'

/** The `log` record format: four fields joined by the unit separator. */
export const LOG_FORMAT = '%H%x1f%an%x1f%aI%x1f%s'

/** The `show -s` header format: the log fields, a record separator, then the body. */
export const SHOW_FORMAT = '%H%x1f%an%x1f%aI%x1f%s%x1e%b'

/** The unmerged porcelain codes: a conflicted index reports exactly these. */
const CONFLICT_CODES: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** The porcelain letters the view paints. */
const STATUS_LETTERS: Readonly<Record<string, FileStatus>> = {
  M: 'M', A: 'A', D: 'D', R: 'R', C: 'A', T: 'M', U: 'U', '?': '?',
}

/** An absolute file path (POSIX or Windows) is never inside the repository. */
const ABSOLUTE_FILE = /^(?:[\\/]|[A-Za-z]:[\\/])/u

/** The bytes of one UTF-8 string (the patch cap is a byte budget). */
function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The rest of a porcelain record after `fields` space-separated fixed fields.
 * The path is the raw remainder, so spaces inside it survive.
 * @param text - the record after the status code.
 * @param fields - how many fixed fields precede the path.
 * @returns the path, or `''` when the record is too short.
 */
function pathAfterFields(text: string, fields: number): string {
  let rest = text
  for (let count = 0; count < fields; count += 1) {
    const space = rest.indexOf(' ')
    if (space < 0) return ''
    rest = rest.slice(space + 1)
  }
  return rest
}

/** One porcelain letter, mapped to the UI vocabulary (`C` reads as added, `T` as modified). */
function letterOf(letter: string): FileStatus {
  return STATUS_LETTERS[letter] ?? 'M'
}

/**
 * One porcelain change record's entries: the staged and the unstaged side are
 * separate entries (a `MM` file is reachable from both groups, each with its
 * own diff), and an unmerged record is one conflict entry.
 */
function entriesFor(code: string, path: string, oldPath: string): RepoFile[] {
  if (code.length !== 2 || path === '') return []
  const renamed = oldPath === '' ? { path } : { path, oldPath }
  if (CONFLICT_CODES.has(code)) return [{ ...renamed, status: 'U', staged: false }]
  const files: RepoFile[] = []
  if (code[0] !== '.') files.push({ ...renamed, status: letterOf(code[0]!), staged: true })
  if (code[1] !== '.') files.push({ ...renamed, status: letterOf(code[1]!), staged: false })
  return files
}

/**
 * Parse `git status --porcelain=v2 --branch --untracked-files=all -z`.
 * Pure and total: an unknown record is skipped rather than failing the read.
 * @param stdout - the command's standard output.
 * @returns the branch header facts and one entry per change side.
 */
export function parseStatus(stdout: string): {
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  files: RepoFile[]
} {
  let branch: string | null = null
  let detached = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: RepoFile[] = []
  const records = stdout.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (record === '') continue
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length).trim()
      detached = value === '(detached)'
      branch = detached ? null : value
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length).trim()
      continue
    }
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record)
    if (ab !== null) {
      ahead = Number(ab[1])
      behind = Number(ab[2])
      continue
    }
    if (record.startsWith('1 ')) {
      files.push(...entriesFor(record.slice(2, 4), pathAfterFields(record.slice(4).trimStart(), 6), ''))
      continue
    }
    if (record.startsWith('2 ')) {
      // A rename/copy: `-z` puts the pre-image path in the NEXT NUL record.
      const oldPath = records[index + 1] ?? ''
      index += 1
      files.push(...entriesFor(record.slice(2, 4), pathAfterFields(record.slice(4).trimStart(), 7), oldPath))
      continue
    }
    if (record.startsWith('u ')) {
      files.push(...entriesFor(record.slice(2, 4), pathAfterFields(record.slice(4).trimStart(), 8), ''))
      continue
    }
    if (record.startsWith('? ')) {
      files.push({ path: record.slice(2), status: '?', staged: false })
      continue
    }
    // `! ` (ignored) and any future record type carry nothing this view shows.
  }
  return { branch, detached, upstream, ahead, behind, files }
}

/**
 * Parse `git diff --numstat -z` / `git show --numstat -z` output. The runs use
 * `--no-renames`, so every record is `<added>\t<deleted>\t<path>` and the
 * binary marker is the literal `-`/`-` pair (never `0`/`0`).
 * @param stdout - the command's standard output.
 * @returns one entry per changed file, in git's order.
 */
export function parseNumstat(stdout: string): Map<string, NumStatEntry> {
  const files = new Map<string, NumStatEntry>()
  for (const token of stdout.split('\0')) {
    if (token === '') continue
    const firstTab = token.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue
    const path = token.slice(secondTab + 1)
    if (path === '') continue
    const added = token.slice(0, firstTab)
    const deleted = token.slice(firstTab + 1, secondTab)
    if (added === '-' && deleted === '-') {
      files.set(path, { additions: null, deletions: null, binary: true })
      continue
    }
    const additions = Number.parseInt(added, 10)
    const deletions = Number.parseInt(deleted, 10)
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue
    files.set(path, { additions, deletions, binary: false })
  }
  return files
}

/**
 * Attach the per-side line counts a status read computed. A binary file keeps
 * no counts (`-`/`-` is not `0`/`0`); a path the numstat run did not mention
 * (an untracked file) keeps the entry as it is.
 * @param files - the porcelain entries.
 * @param staged - the index-side counts.
 * @param worktree - the worktree-side counts.
 * @returns the entries with counts where they exist.
 */
export function attachStats(
  files: readonly RepoFile[],
  staged: ReadonlyMap<string, NumStatEntry>,
  worktree: ReadonlyMap<string, NumStatEntry>,
): RepoFile[] {
  return files.map((file) => {
    const stats = (file.staged ? staged : worktree).get(file.path)
    if (stats === undefined || stats.binary) return file
    return { ...file, additions: stats.additions, deletions: stats.deletions }
  })
}

/**
 * Parse `git log --pretty=format:%H%x1f%an%x1f%aI%x1f%s` output. Records are
 * newline-separated with no trailing newline; a malformed line is skipped.
 * @param stdout - the command's standard output.
 * @returns the commits, in git's order.
 */
export function parseLog(stdout: string): CommitSummary[] {
  const commits: CommitSummary[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [hash, author, time, subject] = line.split('\x1f')
    if (hash === undefined || author === undefined || time === undefined || subject === undefined) continue
    commits.push({ hash, author, time, subject })
  }
  return commits
}

/**
 * Parse `git show -s --pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1e%b` output.
 * The record separator is always written; a missing one leaves the body empty.
 * @param stdout - the command's standard output.
 * @returns the commit header.
 */
export function parseShowHeader(stdout: string): CommitDetail {
  const separator = stdout.indexOf('\x1e')
  const header = separator < 0 ? stdout : stdout.slice(0, separator)
  const body = separator < 0 ? '' : stdout.slice(separator + 1)
  const [hash = '', author = '', time = '', subject = ''] = header.split('\x1f')
  return { hash, author, time, subject, body: body.trim() }
}

/**
 * Turn one `--numstat` set into commit file statistics. The binary marker is
 * preserved as `null` counts, never read as zero.
 * @param stdout - the command's standard output.
 * @returns one entry per changed file.
 */
export function parseCommitFiles(stdout: string): CommitFile[] {
  return [...parseNumstat(stdout)].map(([path, stats]) => stats.binary
    ? { path, additions: null, deletions: null, binary: true }
    : { path, additions: stats.additions, deletions: stats.deletions, binary: false })
}

/**
 * Whether a patch reports a binary change. Neither git's "Binary files … differ"
 * nor a `GIT binary patch` body is a text hunk, so the view must label it
 * instead of rendering an empty diff.
 * @param patch - the unified patch.
 * @returns whether the patch is binary.
 */
export function isBinaryPatch(patch: string): boolean {
  return /^(?:Binary files .* differ|GIT binary patch)$/mu.test(patch)
}

/**
 * Cut a patch at the byte and line caps. A cut is reported (`truncated`) so the
 * view never presents a prefix as the whole change.
 * @param patch - the unified patch.
 * @param maxBytes - the byte cap (default {@link MAX_PATCH_BYTES}).
 * @param maxLines - the line cap (default {@link MAX_PATCH_LINES}).
 * @returns the bounded patch and whether it was cut.
 */
export function truncatePatch(
  patch: string,
  maxBytes: number = MAX_PATCH_BYTES,
  maxLines: number = MAX_PATCH_LINES,
): { patch: string; truncated: boolean } {
  const lines = patch.split('\n')
  if (lines.length <= maxLines && bytesOf(patch) <= maxBytes) return { patch, truncated: false }
  let bytes = 0
  const kept: string[] = []
  for (const line of lines.slice(0, maxLines)) {
    const cost = bytesOf(line) + (kept.length === 0 ? 0 : 1)
    if (bytes + cost > maxBytes) break
    kept.push(line)
    bytes += cost
  }
  return { patch: kept.join('\n'), truncated: true }
}

/** The stable failure classes this application derives from git's own stderr. */
export type GitFailureClass = 'not-a-repo' | 'path-not-found' | 'invalid-rev'

/**
 * Classify one failed git run. The child runs under the C locale, so these are
 * git's exact English shapes rather than a guess at a translated message.
 * @param stderr - git's standard error.
 * @param revSupplied - whether the caller supplied the revision (an unknown
 *   revision is the caller's argument, while an unborn HEAD also fails here).
 * @returns the stable class, or `undefined` when the message names none.
 */
export function classifyGitFailure(stderr: string, revSupplied = false): GitFailureClass | undefined {
  if (/cannot change to .*(?:No such file or directory|not a directory)/iu.test(stderr)) return 'path-not-found'
  if (/not a git repository|not a working tree|must be run in a work tree/iu.test(stderr)) return 'not-a-repo'
  if (revSupplied && /unknown revision|ambiguous argument|bad revision|invalid revision range|unknown commit object/iu.test(stderr)) return 'invalid-rev'
  return undefined
}

/**
 * Whether a failed `log` names an unborn HEAD (an empty repository, which is an
 * empty history rather than an error).
 * @param stderr - git's standard error.
 * @returns whether the message says there are no commits yet.
 */
export function isEmptyRepository(stderr: string): boolean {
  return /does not have any commits yet|bad default revision 'HEAD'|ambiguous argument 'HEAD'/iu.test(stderr)
}

/**
 * Read the required repository path. The path is trimmed (the UI's input
 * contract) and must be a non-empty string without a NUL byte; it is never
 * split, resolved or turned into a shell word.
 * @param value - the raw argument.
 * @returns the path.
 * @throws AppError `invalid-args` when the value cannot be a path.
 */
export function readRepoPath(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('invalid-args', 'path must be a string')
  const path = value.trim()
  if (path === '') throw new AppError('invalid-args', 'path must not be empty')
  if (path.includes('\0')) throw new AppError('invalid-args', 'path must not contain a NUL byte')
  return path
}

/**
 * Read the required in-repository file. Names are kept verbatim (spaces are
 * legal); an absolute path and a `..` segment are refused because a diff is
 * only ever about a path INSIDE the repository. The value rides after `--`,
 * so a leading dash is still a literal pathspec rather than an option.
 * @param value - the raw argument.
 * @returns the repository-relative path.
 * @throws AppError `invalid-args` when the value cannot be such a path.
 */
export function readRepoFile(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new AppError('invalid-args', 'file must be a non-empty string')
  if (value.includes('\0')) throw new AppError('invalid-args', 'file must not contain a NUL byte')
  if (ABSOLUTE_FILE.test(value)) throw new AppError('invalid-args', `file must be relative to the repository (got ${JSON.stringify(value)})`)
  if (value.split(/[\\/]/u).includes('..')) throw new AppError('invalid-args', `file must stay inside the repository (got ${JSON.stringify(value)})`)
  return value
}

/**
 * Read an optional or required revision. A revision is never an option:
 * blank, a leading `-` and a NUL are refused. Everything else belongs to
 * git's revision grammar and is passed through verbatim.
 * @param value - the raw argument.
 * @param required - whether an absent value is an error (`show`) or the op's
 *   default (`log`).
 * @returns the trimmed revision, or `undefined` when absent and optional.
 * @throws AppError `invalid-rev` when the value cannot be a revision.
 */
export function readRev(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new AppError('invalid-rev', 'rev is required')
    return undefined
  }
  if (typeof value !== 'string') throw new AppError('invalid-rev', 'rev must be a string')
  const rev = value.trim()
  if (rev === '') {
    if (required) throw new AppError('invalid-rev', 'rev must not be empty')
    return undefined
  }
  if (rev.startsWith('-')) throw new AppError('invalid-rev', `rev must not start with "-" (got ${JSON.stringify(rev)})`)
  if (rev.includes('\0')) throw new AppError('invalid-rev', 'rev must not contain a NUL byte')
  return rev
}

/**
 * Read and clamp a page size. A missing or non-numeric value takes the default;
 * a number is bounded to `[1, MAX_LOG_LIMIT]` so a huge page is never asked
 * for (and a negative one never reaches git as `--max-count`).
 * @param value - the raw argument.
 * @returns the page size to request.
 */
export function readLogLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LOG_LIMIT
  return Math.max(1, Math.min(Math.trunc(value), MAX_LOG_LIMIT))
}

/** Read the `staged` flag: only the boolean `true` means the index side. */
export function readStaged(value: unknown): boolean {
  return value === true
}

/** The fixed top-level arguments every command carries. */
const GIT_GLOBAL = ['--no-pager', '--literal-pathspecs'] as const

/** The repository/option prefix every command carries (the path is an `-C` argument, never a shell word). */
function prefix(path: string): string[] {
  return [...GIT_GLOBAL, '-C', path, '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false']
}

/** The `status` argv. */
export function statusArgv(path: string): string[] {
  return [...prefix(path), '-c', 'status.relativePaths=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']
}

/** The root-resolution argv. */
export function rootArgv(path: string): string[] {
  return [...prefix(path), 'rev-parse', '--show-toplevel']
}

/** The newest-commit argv (its non-zero exit on an unborn HEAD is tolerated). */
export function lastCommitArgv(path: string): string[] {
  return [...prefix(path), 'log', '-1', `--pretty=format:${LOG_FORMAT}`, '--end-of-options', 'HEAD']
}

/** One side's numstat argv (the index side with `--cached`). */
export function numstatArgv(path: string, staged: boolean): string[] {
  return [...prefix(path), 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', ...(staged ? ['--cached'] : []), '--']
}

/** One file's unified-patch argv (the file rides after `--` as a literal pathspec). */
export function diffArgv(path: string, file: string, staged: boolean): string[] {
  return [...prefix(path), 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', ...(staged ? ['--cached'] : []), '--', file]
}

/** The history argv. */
export function logArgv(path: string, limit: number, rev: string): string[] {
  return [...prefix(path), 'log', `--max-count=${String(limit)}`, `--pretty=format:${LOG_FORMAT}`, '--end-of-options', rev]
}

/** The commit-header argv. */
export function showHeaderArgv(path: string, rev: string): string[] {
  return [...prefix(path), 'show', '-s', `--pretty=format:${SHOW_FORMAT}`, '--end-of-options', rev]
}

/** One commit's numstat argv. */
export function showNumstatArgv(path: string, rev: string): string[] {
  return [...prefix(path), 'show', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', '--format=', '--end-of-options', rev]
}

/** One commit's unified-patch argv. */
export function showPatchArgv(path: string, rev: string): string[] {
  return [...prefix(path), 'show', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--format=', '--end-of-options', rev]
}
