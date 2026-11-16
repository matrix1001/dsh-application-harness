/**
 * The pure half of the git-browser application: parser, argument-boundary and
 * bounded-patch vocabularies. No process runs here — these are total functions
 * over text and arrays, so every branch is reachable deterministically.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import {
  DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT, MAX_PATCH_BYTES, MAX_PATCH_LINES,
  attachStats, classifyGitFailure, diffArgv, isEmptyRepository, isBinaryPatch,
  lastCommitArgv, logArgv, numstatArgv, parseCommitFiles, parseLog, parseNumstat,
  parseShowHeader, parseStatus, readLogLimit, readRepoFile, readRepoPath, readRev,
  readStaged, rootArgv, showHeaderArgv, showNumstatArgv, showPatchArgv, statusArgv,
  truncatePatch,
} from '../src/git.ts'

describe('parseStatus', () => {
  it('parses the branch header and every porcelain record type', () => {
    const stdout = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb a.txt',
      '1 .M N... 100644 100644 100644 aaa bbb b.txt',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 renamed name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
      '? untracked.txt',
      '! ignored.txt',
      'x unknown record',
      '',
    ].join('\0')
    expect(parseStatus(stdout)).toEqual({
      branch: 'main',
      detached: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'a.txt', status: 'M', staged: true },
        { path: 'b.txt', status: 'M', staged: false },
        { path: 'both.txt', status: 'M', staged: true },
        { path: 'both.txt', status: 'M', staged: false },
        { path: 'renamed name.txt', oldPath: 'old name.txt', status: 'R', staged: true },
        { path: 'conflict.txt', status: 'U', staged: false },
        { path: 'untracked.txt', status: '?', staged: false },
      ],
    })
  })

  it('reports a detached HEAD and defaults an absent header', () => {
    expect(parseStatus('# branch.head (detached)\0? u.txt\0')).toEqual({
      branch: null,
      detached: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [{ path: 'u.txt', status: '?', staged: false }],
    })
    expect(parseStatus('')).toEqual({ branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] })
  })

  it('skips malformed records without inventing entries', () => {
    // Too short to carry the fixed fields, a one-letter XY code, a rename with
    // no pre-image NUL record, and an empty trailing token.
    const stdout = [
      '1 M. short',
      '1 X short',
      '1 X',
      '2 R. short',
      'u UU short',
    ].join('\0')
    expect(parseStatus(stdout).files).toEqual([])
    // The rename that is the last token (no following NUL) omits `oldPath`.
    expect(parseStatus('2 R. N... 100644 100644 100644 aaa bbb R100 only.txt').files).toEqual([
      { path: 'only.txt', status: 'R', staged: true },
    ])
    // A rename whose pre-image token is empty also omits `oldPath`.
    expect(parseStatus('2 R. N... 100644 100644 100644 aaa bbb R100 only.txt\0\0').files).toEqual([
      { path: 'only.txt', status: 'R', staged: true },
    ])
  })

  it('maps the colloquial letters and defaults an unknown one to modified', () => {
    const stdout = [
      '1 A. N... 100644 100644 100644 aaa bbb added.txt',
      '1 D. N... 100644 100644 100644 aaa bbb deleted.txt',
      '1 T. N... 100644 100644 100644 aaa bbb typechanged.txt',
      '1 C. N... 100644 100644 100644 aaa bbb copied.txt',
      '1 X. N... 100644 100644 100644 aaa bbb unknown.txt',
    ].join('\0')
    expect(parseStatus(stdout).files.map((file) => file.status)).toEqual(['A', 'D', 'M', 'A', 'M'])
  })
})

describe('parseNumstat', () => {
  it('parses text, binary and malformed records', () => {
    const stdout = [
      '3\t1\ta.txt',
      '-\t-\tlogo.png',
      'notatab',
      '1\t2',
      '1\t2\t',
      'x\t2\tbad.txt',
      '',
    ].join('\0')
    expect([...parseNumstat(stdout)]).toEqual([
      ['a.txt', { additions: 3, deletions: 1, binary: false }],
      ['logo.png', { additions: null, deletions: null, binary: true }],
    ])
  })

  it('parses one commit file set, keeping binary counts null', () => {
    expect(parseCommitFiles('2\t0\ta.txt\0-\t-\tb.bin\0')).toEqual([
      { path: 'a.txt', additions: 2, deletions: 0, binary: false },
      { path: 'b.bin', additions: null, deletions: null, binary: true },
    ])
  })
})

describe('attachStats', () => {
  const files = [
    { path: 'a.txt', status: 'M' as const, staged: true },
    { path: 'b.txt', status: 'M' as const, staged: false },
    { path: 'c.txt', status: 'M' as const, staged: true },
    { path: 'd.txt', status: '?' as const, staged: false },
  ]
  const staged = new Map([
    ['a.txt', { additions: 5, deletions: 1, binary: false as const }],
    ['c.txt', { additions: null, deletions: null, binary: true as const }],
  ])
  const worktree = new Map([['b.txt', { additions: 0, deletions: 2, binary: false as const }]])

  it('attaches counts per side, leaves binary and untracked entries without them', () => {
    expect(attachStats(files, staged, worktree)).toEqual([
      { path: 'a.txt', status: 'M', staged: true, additions: 5, deletions: 1 },
      { path: 'b.txt', status: 'M', staged: false, additions: 0, deletions: 2 },
      { path: 'c.txt', status: 'M', staged: true },
      { path: 'd.txt', status: '?', staged: false },
    ])
  })
})

describe('parseLog and parseShowHeader', () => {
  it('parses commit lines and skips incomplete ones', () => {
    const stdout = [
      'aaaaaaaa\x1fauthor-a\x1f2026-09-14T15:03:00+08:00\x1ffeat: one',
      'short',
      '',
      'bbbbbbbb\x1fauthor-b\x1f2026-09-13T09:00:00+08:00\x1ffix: two',
    ].join('\n')
    expect(parseLog(stdout)).toEqual([
      { hash: 'aaaaaaaa', author: 'author-a', time: '2026-09-14T15:03:00+08:00', subject: 'feat: one' },
      { hash: 'bbbbbbbb', author: 'author-b', time: '2026-09-13T09:00:00+08:00', subject: 'fix: two' },
    ])
  })

  it('parses a show header with a body, and one without the separator', () => {
    expect(parseShowHeader('abc\x1fan\x1f2026-09-14T15:03:00+08:00\x1fsubject\x1ebody line\n\n')).toEqual({
      hash: 'abc', author: 'an', time: '2026-09-14T15:03:00+08:00', subject: 'subject', body: 'body line',
    })
    expect(parseShowHeader('abc\x1fan\x1f2026-09-14T15:03:00+08:00')).toEqual({
      hash: 'abc', author: 'an', time: '2026-09-14T15:03:00+08:00', subject: '', body: '',
    })
  })
})

describe('patch limits', () => {
  it('recognizes the two binary patch shapes', () => {
    expect(isBinaryPatch('Binary files a/x.png and b/x.png differ\n')).toBe(true)
    expect(isBinaryPatch('GIT binary patch\nliteral 12\n')).toBe(true)
    expect(isBinaryPatch('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n')).toBe(false)
  })

  it('keeps a patch under both caps unchanged', () => {
    expect(truncatePatch('a\nb', 100, 10)).toEqual({ patch: 'a\nb', truncated: false })
    expect(MAX_PATCH_BYTES).toBe(1024 * 1024)
    expect(MAX_PATCH_LINES).toBe(2000)
  })

  it('cuts at the line cap and the byte cap', () => {
    expect(truncatePatch('a\nb\nc', 100, 2)).toEqual({ patch: 'a\nb', truncated: true })
    expect(truncatePatch('aaaa\nbbbb', 4, 10)).toEqual({ patch: 'aaaa', truncated: true })
    // A first line that cannot fit at all yields an empty prefix, never a
    // partially cut line.
    expect(truncatePatch('aaaaaaaa', 2, 10)).toEqual({ patch: '', truncated: true })
  })
})

describe('failure classification', () => {
  it('classifies path, repository and revision failures from git stderr', () => {
    expect(classifyGitFailure("fatal: cannot change to '/nope': No such file or directory")).toBe('path-not-found')
    expect(classifyGitFailure("fatal: cannot change to 'file': not a directory")).toBe('path-not-found')
    expect(classifyGitFailure('fatal: not a git repository (or any of the parent directories): .git')).toBe('not-a-repo')
    expect(classifyGitFailure('fatal: this operation must be run in a work tree')).toBe('not-a-repo')
    expect(classifyGitFailure("fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.", true)).toBe('invalid-rev')
    expect(classifyGitFailure("fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.")).toBeUndefined()
    expect(classifyGitFailure('fatal: something else')).toBeUndefined()
  })

  it('recognizes an unborn HEAD', () => {
    expect(isEmptyRepository("fatal: your current branch 'main' does not have any commits yet")).toBe(true)
    expect(isEmptyRepository("fatal: bad default revision 'HEAD'")).toBe(true)
    expect(isEmptyRepository('fatal: not a git repository')).toBe(false)
  })
})

describe('the argument boundary', () => {
  it('reads a repository path, refusing a non-string, a blank and a NUL', () => {
    expect(readRepoPath('  /srv/repo  ')).toBe('/srv/repo')
    expect(() => readRepoPath(7)).toThrow(/path must be a string/u)
    expect(() => readRepoPath('   ')).toThrow(/path must not be empty/u)
    expect(() => readRepoPath('/srv\0repo')).toThrow(/NUL/u)
  })

  it('reads a repository-relative file, refusing absolute paths and escapes', () => {
    expect(readRepoFile('dir/file with space.ts')).toBe('dir/file with space.ts')
    expect(readRepoFile('-leading.txt')).toBe('-leading.txt')
    expect(() => readRepoFile(7)).toThrow(/file must be a non-empty string/u)
    expect(() => readRepoFile('')).toThrow(/file must be a non-empty string/u)
    expect(() => readRepoFile('a\0b')).toThrow(/NUL/u)
    expect(() => readRepoFile('/etc/passwd')).toThrow(/must be relative/u)
    expect(() => readRepoFile('C:\\repo\\file')).toThrow(/must be relative/u)
    expect(() => readRepoFile('\\\\server\\share')).toThrow(/must be relative/u)
    expect(() => readRepoFile('a/../b')).toThrow(/inside the repository/u)
    expect(() => readRepoFile('a\\..\\b')).toThrow(/inside the repository/u)
  })

  it('reads a required or optional revision, refusing options and a NUL', () => {
    expect(readRev(' HEAD~1 ', true)).toBe('HEAD~1')
    expect(readRev(undefined, false)).toBeUndefined()
    expect(readRev('  ', false)).toBeUndefined()
    expect(() => readRev(undefined, true)).toThrow(/rev is required/u)
    expect(() => readRev('  ', true)).toThrow(/rev must not be empty/u)
    expect(() => readRev(7, true)).toThrow(/rev must be a string/u)
    expect(() => readRev('--output=/tmp/x', true)).toThrow(/must not start with/u)
    expect(() => readRev('HEAD\0main', true)).toThrow(/NUL/u)
  })

  it('clamps the page size and reads the staged flag', () => {
    expect(readLogLimit(undefined)).toBe(DEFAULT_LOG_LIMIT)
    expect(readLogLimit('5')).toBe(DEFAULT_LOG_LIMIT)
    expect(readLogLimit(Number.NaN)).toBe(DEFAULT_LOG_LIMIT)
    expect(readLogLimit(0)).toBe(1)
    expect(readLogLimit(37)).toBe(37)
    expect(readLogLimit(1000)).toBe(MAX_LOG_LIMIT)
    expect(readStaged(true)).toBe(true)
    expect(readStaged('true')).toBe(false)
    expect(readStaged(undefined)).toBe(false)
  })
})

describe('the fixed argv templates', () => {
  const PREFIX = ['--no-pager', '--literal-pathspecs', '-C', '/srv/repo', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false']

  it('builds the status, root and last-commit commands', () => {
    expect(statusArgv('/srv/repo')).toEqual([...PREFIX, '-c', 'status.relativePaths=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'])
    expect(rootArgv('/srv/repo')).toEqual([...PREFIX, 'rev-parse', '--show-toplevel'])
    expect(lastCommitArgv('/srv/repo')).toEqual([...PREFIX, 'log', '-1', '--pretty=format:%H%x1f%an%x1f%aI%x1f%s', '--end-of-options', 'HEAD'])
  })

  it('builds both numstat sides and both diff sides', () => {
    expect(numstatArgv('/srv/repo', true)).toEqual([...PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', '--cached', '--'])
    expect(numstatArgv('/srv/repo', false)).toEqual([...PREFIX, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', '--'])
    expect(diffArgv('/srv/repo', 'a b.txt', true)).toEqual([
      ...PREFIX, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--cached', '--', 'a b.txt',
    ])
    expect(diffArgv('/srv/repo', '-leading.txt', false)).toEqual([
      ...PREFIX, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--', '-leading.txt',
    ])
  })

  it('builds the log and show commands with the revision after --end-of-options', () => {
    expect(logArgv('/srv/repo', 50, 'HEAD~2')).toEqual([
      ...PREFIX, 'log', '--max-count=50', '--pretty=format:%H%x1f%an%x1f%aI%x1f%s', '--end-of-options', 'HEAD~2',
    ])
    expect(showHeaderArgv('/srv/repo', 'abc')).toEqual([
      ...PREFIX, 'show', '-s', '--pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1e%b', '--end-of-options', 'abc',
    ])
    expect(showNumstatArgv('/srv/repo', 'abc')).toEqual([
      ...PREFIX, 'show', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', '--format=', '--end-of-options', 'abc',
    ])
    expect(showPatchArgv('/srv/repo', 'abc')).toEqual([
      ...PREFIX, 'show', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--format=', '--end-of-options', 'abc',
    ])
  })

  it('never composes a shell word', () => {
    const argv = diffArgv('/srv/repo', '$(rm -rf /).txt', false)
    expectTypeOf(argv).toEqualTypeOf<string[]>()
    expect(argv.at(-1)).toBe('$(rm -rf /).txt')
    expect(argv.some((item) => item.includes('sh -c'))).toBe(false)
  })

  it('raises AppError with the stable codes', () => {
    try {
      readRepoPath('')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('invalid-args')
    }
    try {
      readRev('-x', true)
    } catch (error) {
      expect((error as AppError).code).toBe('invalid-rev')
    }
  })
})
