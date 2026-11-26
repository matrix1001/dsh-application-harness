/**
 * The view model: wire narrowing, worktree grouping, unified-patch parsing and
 * the small pure helpers the page reads. Every malformed shape narrows to
 * `undefined` and every boundary value is asserted here, so the components can
 * render one already-checked face.
 */
import { describe, expect, it } from 'vitest'
import {
  commitDateLabel, diffOf, errorKindOf, failureOf, groupFiles, groupOf, logOf,
  messageOfError, parsePatch, patchStats, repoNameOf, shortHash, showOf, statusOf,
  valueOf,
} from '../src/client/model.ts'
import type { StatusFile } from '../src/client/model.ts'

const COMMIT = { hash: `${'a'.repeat(40)}`, subject: 'feat: workbench', author: 'Ada', time: '2026-09-14T15:03:00+08:00' }

const STATUS = {
  root: '/srv/repo',
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
  files: [
    { path: 'a.txt', status: 'M', staged: true, additions: 3, deletions: 1 },
    { path: 'b.txt', status: 'M', staged: false },
    { path: 'both.txt', status: 'M', staged: true },
    { path: 'old.txt', status: 'R', staged: true, oldPath: 'new.txt' },
    { path: 'untracked.txt', status: '?', staged: false },
    { path: 'conflict.txt', status: 'U', staged: false },
  ],
  lastCommit: COMMIT,
}

describe('statusOf', () => {
  it('narrows the full status face', () => {
    expect(statusOf(STATUS)).toEqual(STATUS)
  })

  it('defaults the optional header facts and an absent last commit', () => {
    expect(statusOf({ root: '/srv/repo', files: [] })).toEqual({
      root: '/srv/repo', branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [],
    })
  })

  it('refuses a malformed face instead of rendering half a repository', () => {
    expect(statusOf(null)).toBeUndefined()
    expect(statusOf([])).toBeUndefined()
    expect(statusOf({ files: [] })).toBeUndefined()
    expect(statusOf({ root: 7, files: [] })).toBeUndefined()
    expect(statusOf({ root: '', files: [] })).toBeUndefined()
    expect(statusOf({ root: '/srv/repo' })).toBeUndefined()
    expect(statusOf({ root: '/srv/repo', files: [null] })).toBeUndefined()
    expect(statusOf({ root: '/srv/repo', files: [{ path: 7, status: 'M' }] })).toBeUndefined()
    expect(statusOf({ root: '/srv/repo', files: [{ path: '', status: 'M' }] })).toBeUndefined()
    expect(statusOf({ root: '/srv/repo', files: [{ path: 'a', status: 'Z' }] })).toBeUndefined()
    expect(statusOf({ root: '/srv/repo', files: [], lastCommit: { hash: 'a' } })).toEqual({
      root: '/srv/repo', branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [],
    })
  })
})

describe('diffOf, logOf and showOf', () => {
  it('narrows a diff and defaults its flags', () => {
    expect(diffOf({ patch: 'x', truncated: true, binary: true })).toEqual({ patch: 'x', truncated: true, binary: true })
    expect(diffOf({ patch: '' })).toEqual({ patch: '', truncated: false, binary: false })
    expect(diffOf(null)).toBeUndefined()
    expect(diffOf({ patch: 7 })).toBeUndefined()
  })

  it('narrows a log page', () => {
    expect(logOf({ commits: [COMMIT] })).toEqual({ commits: [COMMIT] })
    expect(logOf({ commits: [] })).toEqual({ commits: [] })
    expect(logOf(null)).toBeUndefined()
    expect(logOf({ commits: 'x' })).toBeUndefined()
    expect(logOf({ commits: [{}] })).toBeUndefined()
  })

  it('narrows a commit detail and its file statistics', () => {
    const show = {
      commit: { ...COMMIT, body: 'body' },
      files: [
        { path: 'a.txt', additions: 2, deletions: 1, binary: false },
        { path: 'b.bin', additions: null, deletions: null, binary: true },
      ],
      patch: 'patch',
      truncated: false,
      binary: true,
    }
    expect(showOf(show)).toEqual(show)
    expect(showOf({ ...show, commit: { ...COMMIT } , files: [], patch: '' })).toEqual({
      commit: { ...COMMIT, body: '' }, files: [], patch: '', truncated: false, binary: true,
    })
    expect(showOf(null)).toBeUndefined()
    expect(showOf({ ...show, patch: 7 })).toBeUndefined()
    expect(showOf({ ...show, files: 'x' })).toBeUndefined()
    expect(showOf({ ...show, commit: null })).toBeUndefined()
    expect(showOf({ ...show, commit: {} })).toBeUndefined()
    expect(showOf({ ...show, files: [null] })).toBeUndefined()
    expect(showOf({ ...show, files: [{ path: 7 }] })).toBeUndefined()
  })
})

describe('outcome helpers', () => {
  it('reads a success value and no value otherwise', () => {
    expect(valueOf({ callId: 'c', status: 'success', result: 7 })).toBe(7)
    expect(valueOf({ callId: 'c', status: 'cancelled' })).toBeUndefined()
  })

  it('reads a failure code/message, falling back for cancellation and success', () => {
    expect(failureOf({ callId: 'c', status: 'failed', error: { code: 'timeout', message: 'slow'  }}, 'fallback')).toEqual({ code: 'timeout', message: 'slow' })
    expect(failureOf({ callId: 'c', status: 'rejected', error: { code: 'denied', message: 'no'  }}, 'fallback')).toEqual({ code: 'denied', message: 'no' })
    expect(failureOf({ callId: 'c', status: 'cancelled' }, 'fallback')).toEqual({ message: 'fallback' })
    expect(failureOf({ callId: 'c', status: 'success', result: null }, 'fallback')).toEqual({ message: 'fallback' })
    expect(failureOf({ callId: 'c', status: 'failed' }, 'fallback')).toEqual({ message: 'fallback' })
  })

  it('reads one thrown value\'s message', () => {
    expect(messageOfError(new Error('boom'))).toBe('boom')
    expect(messageOfError('boom')).toBe('boom')
  })
})

describe('worktree grouping', () => {
  const files: StatusFile[] = [
    { path: 'untracked.txt', status: '?', staged: false },
    { path: 'conflict.txt', status: 'U', staged: false },
    { path: 'staged.txt', status: 'M', staged: true },
    { path: 'unstaged.txt', status: 'M', staged: false },
  ]

  it('maps each entry to its group', () => {
    expect(files.map(groupOf)).toEqual(['untracked', 'conflict', 'staged', 'unstaged'])
  })

  it('returns only non-empty sections, in display order', () => {
    expect(groupFiles(files).map((section) => section.group)).toEqual(['staged', 'unstaged', 'untracked', 'conflict'])
    expect(groupFiles([files[2]!])).toEqual([{ group: 'staged', files: [files[2]] }])
    expect(groupFiles([])).toEqual([])
  })
})

describe('small helpers', () => {
  it('shortens a hash', () => {
    expect(shortHash('abcdef0123456789')).toBe('abcdef01')
  })

  it('names a repository from its root, keeping a root-only path', () => {
    expect(repoNameOf('/srv/repo')).toBe('repo')
    expect(repoNameOf('/srv/repo/')).toBe('repo')
    expect(repoNameOf('/')).toBe('/')
  })

  it('formats a commit date, keeping an unparseable stamp verbatim', () => {
    expect(commitDateLabel('2026-09-14T15:03:00+08:00', { locale: 'en-US', timeZone: 'UTC' })).toContain('2026')
    expect(commitDateLabel('not-a-date')).toBe('not-a-date')
  })

  it('maps every stable host code to its page state', () => {
    expect(errorKindOf('not-a-repo')).toBe('not-repo')
    expect(errorKindOf('git-missing')).toBe('git-missing')
    expect(errorKindOf('path-not-found')).toBe('path-missing')
    expect(errorKindOf('timeout')).toBe('timeout')
    expect(errorKindOf('output-too-large')).toBe('output-too-large')
    expect(errorKindOf('git-failed')).toBe('other')
    expect(errorKindOf(undefined)).toBe('other')
  })
})

describe('parsePatch', () => {
  const PATCH = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+two changed',
    '+three',
    ' four',
    '\\ No newline at end of file',
    '',
  ].join('\n')

  it('parses hunk headers and numbered add/delete/context lines', () => {
    expect(parsePatch(PATCH)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,4 @@', oldLine: null, newLine: null },
      { kind: 'ctx', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'two', oldLine: 2, newLine: null },
      { kind: 'add', text: 'two changed', oldLine: null, newLine: 2 },
      { kind: 'add', text: 'three', oldLine: null, newLine: 3 },
      { kind: 'ctx', text: 'four', oldLine: 3, newLine: 4 },
    ])
    expect(patchStats(parsePatch(PATCH))).toEqual({ additions: 2, deletions: 1 })
  })

  it('starts a new numbering at each file and tolerates an unnumbered hunk header', () => {
    const multi = [
      'diff --git a/a b/a',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/b b/b',
      'index 111..222 100644',
      '@@ malformed',
      '+x',
    ].join('\n')
    expect(parsePatch(multi)).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@', oldLine: null, newLine: null },
      { kind: 'del', text: 'a', oldLine: 1, newLine: null },
      { kind: 'add', text: 'b', oldLine: null, newLine: 1 },
      { kind: 'hunk', text: '@@ malformed', oldLine: null, newLine: null },
      { kind: 'add', text: 'x', oldLine: null, newLine: 2 },
    ])
  })

  it('returns nothing for an empty or metadata-only patch', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('diff --git a/a b/a\nindex 1..2\n')).toEqual([])
    expect(patchStats([])).toEqual({ additions: 0, deletions: 0 })
  })
})
