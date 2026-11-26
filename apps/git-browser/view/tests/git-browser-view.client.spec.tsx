// @vitest-environment jsdom
/**
 * The git-browser page: the working-tree groups, the unified-patch renderer,
 * the history/commit detail, the recent list, the four separate failure states
 * and the narrow-layout list/detail switch. The page speaks only through the
 * shell's `call` face; the specs script that face and assert stable `data-*`
 * anchors, never translatable labels.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CallOutcome, JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { GitBrowserPage, GitBrowserView, type GitBrowserViewProps } from '../src/client/GitBrowserView.tsx'
import { zh } from '../src/client/locales.ts'
import { readRecentRepos, rememberRepo } from '../src/client/recent.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

type Call = GitBrowserViewProps['call']
type Responder = (args: Record<string, unknown>) => CallOutcome | Promise<CallOutcome>

/** One recorded call. */
interface RecordedCall {
  op: string
  args: Record<string, unknown>
}

const COMMIT_A = { hash: `${'a'.repeat(40)}`, subject: 'feat: workbench', author: 'Ada', time: '2026-09-14T15:03:00+08:00' }
const COMMIT_B = { hash: `${'b'.repeat(40)}`, subject: 'fix: parser', author: 'Grace', time: '2026-09-13T09:00:00+08:00' }

const STATUS = {
  root: '/srv/repo',
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
  files: [
    { path: 'a.txt', status: 'M', staged: true, additions: 3, deletions: 1 },
    { path: 'b.txt', status: 'M', staged: false, additions: 0, deletions: 2 },
    { path: 'both.txt', status: 'M', staged: true },
    { path: 'both.txt', status: 'M', staged: false },
    { path: 'untracked.txt', status: '?', staged: false },
    { path: 'conflict.txt', status: 'U', staged: false },
    { path: 'logo.bin', status: 'M', staged: true },
    { path: 'only-add.txt', status: 'A', staged: true, additions: 4 },
    { path: 'truncated.txt', status: 'M', staged: false },
  ],
  lastCommit: COMMIT_A,
}

const LOG = { commits: [COMMIT_A, COMMIT_B] }

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
  '',
].join('\n')

const DIFF = { patch: PATCH, truncated: false, binary: false }
const BINARY_DIFF = { patch: '', truncated: false, binary: true }
const TRUNCATED_DIFF = { patch: PATCH, truncated: true, binary: false }
const EMPTY_DIFF = { patch: '', truncated: false, binary: false }

const SHOW = {
  commit: { ...COMMIT_A, body: 'Body line one.\nBody line two.' },
  files: [
    { path: 'a.txt', additions: 3, deletions: 1, binary: false },
    { path: 'logo.bin', additions: null, deletions: null, binary: true },
    { path: 'weird.txt', additions: null, deletions: null, binary: false },
  ],
  patch: PATCH,
  truncated: false,
  binary: false,
}

/** One successful outcome. */
function ok(value: unknown): CallOutcome {
  return { callId: 'call', status: 'success', result: value as JsonValue }
}

/** One failed outcome. */
function failed(code: string, message: string): CallOutcome {
  return { callId: 'call', status: 'failed', error: { code, message } }
}

/** The default answer per operation. */
const DEFAULTS: Record<string, unknown> = { status: STATUS, log: LOG, diff: DIFF, show: SHOW }

/** Build the scripted call face and its record. */
function makeCall(overrides: Partial<Record<string, Responder>> = {}): { call: Call; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const call = (async (op: string, args: JsonValue): Promise<CallOutcome> => {
    const recorded: RecordedCall = { op, args: (args ?? {}) as Record<string, unknown> }
    calls.push(recorded)
    const responder = overrides[op]
    if (responder !== undefined) return await responder(recorded.args)
    const value = DEFAULTS[op]
    return value === undefined ? failed('git-failed', `unexpected op ${op}`) : ok(value)
  }) as Call
  return { call, calls }
}

/** The translate seat (Chinese by default) with `{name}` substitution. */
function translator(dictionary: Record<string, string> = zh as unknown as Record<string, string>): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
  }
}

const t = translator()

/** The view props around one call face. */
function uiStore(initial: Record<string, unknown> = {}) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (patch: Record<string, unknown>) => { state = { ...state, ...patch }; for (const listener of listeners) listener() },
  } as unknown as GitBrowserViewProps['ui']
}

function viewProps(
  call: Call,
  ui: GitBrowserViewProps['ui'] = uiStore(),
  overrides: Partial<GitBrowserViewProps> = {},
): GitBrowserViewProps {
  return {
    call,
    cancel: vi.fn(),
    claimProgress: vi.fn(() => () => undefined),
    onChanged: vi.fn(() => () => undefined),
    running: false,
    pageContext: { report: vi.fn(() => () => undefined) },
    openManagement: vi.fn(),
    viewport: { report: vi.fn(() => () => undefined) },
    ui,
    t,
    ...overrides,
  } as unknown as GitBrowserViewProps
}

/** Type a path and submit the open form. */
async function openRepository(container: HTMLElement, path = '/srv/repo'): Promise<void> {
  fireEvent.change(container.querySelector('[data-git-path-input]') as HTMLInputElement, { target: { value: path } })
  fireEvent.submit(container.querySelector('[data-git-open-form]') as HTMLFormElement)
  await waitFor(() => { expect(container.querySelector('[data-git-repo]')).toBeTruthy() })
}

describe('the empty state and opening a repository', () => {
  it('opens from the path input, renders the header and groups, and remembers the root', async () => {
    const { call, calls } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    expect(container.querySelector('[data-git-empty]')).toBeTruthy()
    expect(container.querySelector('[data-git-readonly]')!.textContent).toBe(zh['view.readonly'])

    fireEvent.click(container.querySelector('[data-git-recent-toggle]')!)
    expect(container.querySelector('[role="menu"]')).toBeTruthy()
    expect(container.querySelector('[data-git-recent-empty]')).toBeTruthy()
    fireEvent.click(container.querySelector('[data-git-recent-toggle]')!)
    expect(container.querySelector('[role="menu"]')).toBeNull()

    await openRepository(container)
    expect(container.querySelector('[data-git-repo-name]')!.textContent).toBe('repo')
    expect(container.querySelector('[data-git-branch]')!.textContent).toBe('main')
    expect(container.querySelector('[data-git-root]')!.textContent).toBe('/srv/repo')
    expect(container.querySelector('[data-git-upstream]')!.textContent).toContain('origin/main')
    expect(container.querySelector('[data-git-dirty]')!.getAttribute('data-git-dirty')).toBe('true')
    expect(container.querySelector('[data-git-last-commit]')!.textContent).toContain('feat: workbench')
    expect(container.querySelector('[data-git-list-head]')!.textContent).toContain('9')

    for (const group of ['staged', 'unstaged', 'untracked', 'conflict']) {
      expect(container.querySelector(`[data-git-group="${group}"]`), group).toBeTruthy()
    }
    expect(container.querySelectorAll('[data-git-file]')).toHaveLength(9)
    const stagedFile = container.querySelector('[data-git-file-path="a.txt"]')!
    expect(stagedFile.getAttribute('data-git-file-side')).toBe('staged')
    expect(stagedFile.getAttribute('data-git-file-status')).toBe('M')
    expect(container.querySelector('[data-git-file-path="a.txt"] [data-git-file-stat]')!.textContent).toContain('+3')
    expect(container.querySelector('[data-git-file-path="untracked.txt"] [data-git-file-stat]')).toBeNull()

    expect(readRecentRepos()).toEqual(['/srv/repo'])
    expect(calls.map((entry) => entry.op)).toEqual(['status', 'log'])
    expect(calls[0]!.args).toEqual({ path: '/srv/repo' })
    expect(calls[1]!.args).toEqual({ path: '/srv/repo', limit: 50 })
  })

  it('opens from the recent list and refresh re-reads the repository', async () => {
    rememberRepo('/srv/repo')
    const { call, calls } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    fireEvent.click(container.querySelector('[data-git-recent-toggle]')!)
    const item = container.querySelector('[data-git-recent-item]')!
    expect(item.textContent).toContain('/srv/repo')
    fireEvent.click(item)
    await waitFor(() => { expect(container.querySelector('[data-git-repo]')).toBeTruthy() })
    fireEvent.click(container.querySelector('[data-git-refresh]')!)
    await waitFor(() => { expect(calls.filter((entry) => entry.op === 'status')).toHaveLength(2) })
  })

  it('keeps the workbench when a refresh fails', async () => {
    let reads = 0
    const { call } = makeCall({
      status: () => {
        reads += 1
        return reads === 1 ? ok(STATUS) : failed('git-failed', 'refresh failed')
      },
    })
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)
    const before = container.querySelectorAll('[data-git-file]').length
    expect(before).toBeGreaterThan(0)
    fireEvent.click(container.querySelector('[data-git-refresh]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-error]')).toBeTruthy() })
    // The old workbench is still readable; the failure is reported above it.
    expect(container.querySelector('[data-git-repo]')).toBeTruthy()
    expect(container.querySelectorAll('[data-git-file]')).toHaveLength(before)
    expect(container.querySelector('[data-git-error]')!.textContent).toContain('读取失败')
  })

  it('does nothing for a blank submit, a refresh before opening and a blank open', async () => {
    const { call, calls } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    fireEvent.click(container.querySelector('[data-git-refresh]')!)
    fireEvent.submit(container.querySelector('[data-git-open-form]') as HTMLFormElement)
    expect(calls).toEqual([])
    fireEvent.change(container.querySelector('[data-git-path-input]') as HTMLInputElement, { target: { value: '   ' } })
    fireEvent.submit(container.querySelector('[data-git-open-form]') as HTMLFormElement)
    expect(calls).toEqual([])
  })
})

describe('the history page and commit detail', () => {
  it('lists commits, opens one detail, and closes it with the back control', async () => {
    const { call, calls } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)
    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(container.querySelectorAll('[data-git-commit]')).toHaveLength(2) })
    expect(container.querySelector('[data-git-history-total]')!.textContent).toContain('2')
    expect(container.querySelector('[data-git-history-total]')!.textContent).toContain('提交')
    const commitRow = container.querySelectorAll('[data-git-commit-open]')[0]!
    expect(commitRow.textContent).toContain('feat: workbench')
    fireEvent.click(commitRow)
    await waitFor(() => { expect(container.querySelector('[data-git-show]')).toBeTruthy() })
    expect(container.querySelector('[data-git-show-subject]')!.textContent).toBe('feat: workbench')
    expect(container.querySelector('[data-git-show-body]')!.textContent).toContain('Body line one.')
    expect(container.querySelectorAll('[data-git-show-file]')).toHaveLength(3)
    expect(container.querySelector('[data-git-show-file]')!.textContent).toContain('a.txt')
    expect(container.querySelector('[data-git-show-files]')).toBeTruthy()
    expect(container.querySelector('[data-git-patch]')).toBeTruthy()
    expect(container.querySelector('[data-git-commit-readonly]')!.textContent).toContain('只读')
    expect(container.querySelector('[data-git-main]')!.getAttribute('data-git-show-detail')).toBe('true')
    expect(calls.find((entry) => entry.op === 'show')!.args).toEqual({ path: '/srv/repo', rev: COMMIT_A.hash })

    fireEvent.click(container.querySelector('[data-git-back]')!)
    expect(container.querySelector('[data-git-show]')).toBeNull()
    expect(container.querySelector('[data-git-main]')!.getAttribute('data-git-show-detail')).toBe('false')
    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="worktree"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-group="staged"]')).toBeTruthy() })
  })

  it('closes a commit detail with Escape and restores focus to its row', async () => {
    const { call } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)
    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(container.querySelectorAll('[data-git-commit]')).toHaveLength(2) })
    const commitRow = container.querySelectorAll('[data-git-commit-open]')[0] as HTMLElement
    fireEvent.click(commitRow)
    await waitFor(() => { expect(container.querySelector('[data-git-show]')).toBeTruthy() })
    // Opening moves focus to the back control; Escape closes the detail and
    // returns focus to the row that opened it.
    await waitFor(() => { expect(document.activeElement).toBe(container.querySelector('[data-git-back]')) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(container.querySelector('[data-git-show]')).toBeNull() })
    await waitFor(() => { expect(document.activeElement).toBe(commitRow) })
  })

  it('shows the loading state, an empty file list and a binary/truncated commit', async () => {
    const pending = Promise.withResolvers<CallOutcome>()
    const { call } = makeCall({
      show: (args) => {
        if (args.rev === COMMIT_A.hash) return pending.promise
        if (args.rev === COMMIT_B.hash) {
          return ok({ ...SHOW, commit: { ...COMMIT_B, body: '' }, files: [], patch: '', binary: true, truncated: true })
        }
        return ok(SHOW)
      },
    })
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)
    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(container.querySelectorAll('[data-git-commit]')).toHaveLength(2) })
    fireEvent.click(container.querySelectorAll('[data-git-commit-open]')[0]!)
    expect(container.querySelector('[data-git-show-loading]')!.textContent).toBe(zh['view.show.loading'])
    pending.resolve(ok({ ...SHOW, files: [], patch: '' }))
    await waitFor(() => { expect(container.querySelector('[data-git-show-files-empty]')).toBeTruthy() })
    expect(container.querySelector('[data-git-show-body]')!.textContent).toContain('Body line one.')
    expect(container.querySelector('[data-git-patch]')).toBeNull()

    fireEvent.click(container.querySelectorAll('[data-git-commit-open]')[1]!)
    await waitFor(() => { expect(container.querySelector('[data-git-show-binary]')).toBeTruthy() })
    expect(container.querySelector('[data-git-show-truncated]')).toBeTruthy()
    expect(container.querySelector('[data-git-show-body]')!.textContent).toBe('—')
  })
})

describe('the working-tree diff', () => {
  it('opens staged/unstaged files and renders numbered add/delete/context lines', async () => {
    const { call, calls } = makeCall({
      diff: (args) => {
        if (args.file === 'logo.bin') return ok(BINARY_DIFF)
        if (args.file === 'truncated.txt') return ok(TRUNCATED_DIFF)
        if (args.file === 'untracked.txt' || args.file === 'conflict.txt') return ok(EMPTY_DIFF)
        return ok(DIFF)
      },
    })
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)

    fireEvent.click(container.querySelector('[data-git-file-path="a.txt"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-patch]')).toBeTruthy() })
    expect(calls.find((entry) => entry.op === 'diff')!.args).toEqual({ path: '/srv/repo', file: 'a.txt', staged: true })
    expect(container.querySelector('[data-git-file-path="a.txt"]')!.getAttribute('data-git-selected')).toBe('true')
    expect(container.querySelector('[data-git-diff-title]')!.textContent).toBe('a.txt')
    expect(container.querySelector('[data-git-diff-subtitle]')!.textContent).toContain('已暂存')
    expect(container.querySelector('[data-git-diff-stats]')!.textContent).toContain('+2')
    expect(container.querySelectorAll('[data-git-hunk]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-git-line-kind="add"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-git-line-kind="del"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-git-line-kind="ctx"]')).toHaveLength(2)
    const firstDelete = container.querySelector('[data-git-line-kind="del"]')!
    expect(firstDelete.querySelector('[data-git-line-old]')!.textContent).toBe('2')
    expect(firstDelete.querySelector('[data-git-line-new]')!.textContent).toBe('')
    expect(container.querySelectorAll('[data-git-line-kind="add"]')[0]!.querySelector('[data-git-line-new]')!.textContent).toBe('2')
    expect(container.querySelector('[data-git-diff-readonly]')!.textContent).toContain('只读')

    fireEvent.click(container.querySelector('[data-git-file-path="logo.bin"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-binary]')).toBeTruthy() })
    expect(container.querySelector('[data-git-patch]')).toBeNull()

    fireEvent.click(container.querySelector('[data-git-file-path="truncated.txt"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-truncated]')).toBeTruthy() })
    expect(calls.filter((entry) => entry.op === 'diff').at(-1)!.args).toEqual({ path: '/srv/repo', file: 'truncated.txt', staged: false })

    fireEvent.click(container.querySelector('[data-git-file-path="untracked.txt"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-diff-empty]')!.textContent).toBe(zh['view.diff.untracked']) })

    fireEvent.click(container.querySelector('[data-git-file-path="conflict.txt"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-diff-empty]')!.textContent).toBe(zh['view.diff.empty']) })
  })

  it('shows the loading states while diff and show reads are in flight', async () => {
    const diffPending = Promise.withResolvers<CallOutcome>()
    const { call } = makeCall({ diff: () => diffPending.promise })
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)
    fireEvent.click(container.querySelector('[data-git-file-path="a.txt"]')!)
    expect(container.querySelector('[data-git-diff-pending]')!.textContent).toBe(zh['view.diff.loading'])
    diffPending.resolve(ok(DIFF))
    await waitFor(() => { expect(container.querySelector('[data-git-patch]')).toBeTruthy() })
    fireEvent.click(container.querySelector('[data-git-back]')!)
    expect(container.querySelector('[data-git-diff]')).toBeNull()

    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(container.querySelectorAll('[data-git-commit]')).toHaveLength(2) })
    expect(container.querySelector('[data-git-detail-empty]')!.textContent).toBe(zh['view.history.select'])
  })
})

describe('the failure states', () => {
  const CASES: Array<[string, string, string]> = [
    ['not-a-repo', 'not-repo', 'view.error.notRepo.title'],
    ['git-missing', 'git-missing', 'view.error.gitMissing.title'],
    ['path-not-found', 'path-missing', 'view.error.pathMissing.title'],
    ['timeout', 'timeout', 'view.error.timeout.title'],
    ['output-too-large', 'output-too-large', 'view.error.tooLarge.title'],
    ['git-failed', 'other', 'view.error.other.title'],
  ]

  it('shows the repository, git, path, timeout and generic failures separately', async () => {
    for (const [code, kind, titleKey] of CASES) {
      const { call } = makeCall({ status: () => failed(code, `boom-${code}`) })
      const { container, unmount } = render(<GitBrowserView {...viewProps(call)} t={t} />)
      fireEvent.change(container.querySelector('[data-git-path-input]') as HTMLInputElement, { target: { value: '/nope' } })
      fireEvent.submit(container.querySelector('[data-git-open-form]') as HTMLFormElement)
      await waitFor(() => { expect(container.querySelector('[data-git-error]')).toBeTruthy() })
      expect(container.querySelector('[data-git-error]')!.getAttribute('data-git-error-kind')).toBe(kind)
      expect(container.querySelector('[data-git-error]')!.textContent).toContain((zh as unknown as Record<string, string>)[titleKey])
      expect(container.querySelector('[data-git-error-detail]')!.textContent).toContain(`boom-${code}`)
      expect(container.querySelector('[data-git-empty]')).toBeNull()
      unmount()
    }
  })

  it('shows a cancelled, a rejected and a malformed status read', async () => {
    const cancelled = makeCall({ status: () => ({ callId: 'call', status: 'cancelled' }) })
    const first = render(<GitBrowserView {...viewProps(cancelled.call)} t={t} />)
    fireEvent.change(first.container.querySelector('[data-git-path-input]') as HTMLInputElement, { target: { value: '/srv/repo' } })
    fireEvent.submit(first.container.querySelector('[data-git-open-form]') as HTMLFormElement)
    await waitFor(() => { expect(first.container.querySelector('[data-git-error-detail]')!.textContent).toContain(zh['view.cancelled']) })
    first.unmount()

    const rejected = makeCall({ status: () => Promise.reject(new Error('carrier broke')) })
    const second = render(<GitBrowserView {...viewProps(rejected.call)} t={t} />)
    fireEvent.change(second.container.querySelector('[data-git-path-input]') as HTMLInputElement, { target: { value: '/srv/repo' } })
    fireEvent.submit(second.container.querySelector('[data-git-open-form]') as HTMLFormElement)
    await waitFor(() => { expect(second.container.querySelector('[data-git-error-detail]')!.textContent).toContain('carrier broke') })
    second.unmount()

    const malformed = makeCall({ status: () => ok({ not: 'a status' }) })
    const third = render(<GitBrowserView {...viewProps(malformed.call)} t={t} />)
    fireEvent.change(third.container.querySelector('[data-git-path-input]') as HTMLInputElement, { target: { value: '/srv/repo' } })
    fireEvent.submit(third.container.querySelector('[data-git-open-form]') as HTMLFormElement)
    await waitFor(() => { expect(third.container.querySelector('[data-git-error-detail]')!.textContent).toContain(zh['view.malformed']) })
    third.unmount()
  })

  it('keeps history and detail failures inside their own panes, never on the page banner', async () => {
    const logFailure = makeCall({ log: () => failed('timeout', 'history timed out') })
    const first = render(<GitBrowserView {...viewProps(logFailure.call)} t={t} />)
    await openRepository(first.container)
    expect(first.container.querySelector('[data-git-repo]')).toBeTruthy()
    expect(first.container.querySelector('[data-git-error]')).toBeNull()
    fireEvent.click(first.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(first.container.querySelector('[data-git-log-error]')?.textContent).toContain('history timed out') })
    expect(first.container.querySelector('[data-git-error]')).toBeNull()
    first.unmount()

    const logMalformed = makeCall({ log: () => ok({ commits: [{ hash: 'only-a-hash' }] }) })
    const second = render(<GitBrowserView {...viewProps(logMalformed.call)} t={t} />)
    await openRepository(second.container)
    fireEvent.click(second.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(second.container.querySelector('[data-git-log-error]')?.textContent).toContain(zh['view.malformed']) })
    expect(second.container.querySelector('[data-git-error]')).toBeNull()
    second.unmount()

    const diffFailure = makeCall({ diff: () => failed('not-a-repo', 'diff failed') })
    const third = render(<GitBrowserView {...viewProps(diffFailure.call)} t={t} />)
    await openRepository(third.container)
    fireEvent.click(third.container.querySelector('[data-git-file-path="a.txt"]')!)
    await waitFor(() => { expect(third.container.querySelector('[data-git-diff-error]')?.textContent).toContain('diff failed') })
    expect(third.container.querySelector('[data-git-error]')).toBeNull()
    // Back closes the detail; its local error goes with it and no unrelated
    // page banner is left behind.
    fireEvent.click(third.container.querySelector('[data-git-back]')!)
    expect(third.container.querySelector('[data-git-diff-error]')).toBeNull()
    expect(third.container.querySelector('[data-git-error]')).toBeNull()
    third.unmount()

    const diffMalformed = makeCall({ diff: () => ok({ patch: 7 }) })
    const malformedDiff = render(<GitBrowserView {...viewProps(diffMalformed.call)} t={t} />)
    await openRepository(malformedDiff.container)
    fireEvent.click(malformedDiff.container.querySelector('[data-git-file-path="a.txt"]')!)
    await waitFor(() => { expect(malformedDiff.container.querySelector('[data-git-diff-error]')?.textContent).toContain(zh['view.malformed']) })
    expect(malformedDiff.container.querySelector('[data-git-error]')).toBeNull()
    malformedDiff.unmount()

    const showFailure = makeCall({ show: () => failed('timeout', 'show failed') })
    const fifth = render(<GitBrowserView {...viewProps(showFailure.call)} t={t} />)
    await openRepository(fifth.container)
    fireEvent.click(fifth.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(fifth.container.querySelectorAll('[data-git-commit]')).toHaveLength(2) })
    fireEvent.click(fifth.container.querySelectorAll('[data-git-commit-open]')[0]!)
    await waitFor(() => { expect(fifth.container.querySelector('[data-git-show-error]')?.textContent).toContain('show failed') })
    expect(fifth.container.querySelector('[data-git-error]')).toBeNull()
    // Re-selecting the active pane is a no-op: its error is still current.
    fireEvent.click(fifth.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    expect(fifth.container.querySelector('[data-git-show-error]')).toBeTruthy()
    // Leaving the pane drops its local error too.
    fireEvent.click(fifth.container.querySelector('[data-git-tabs] [data-git-tab="worktree"]')!)
    fireEvent.click(fifth.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(fifth.container.querySelector('[data-git-show-error]')).toBeNull() })
    expect(fifth.container.querySelector('[data-git-error]')).toBeNull()
    fifth.unmount()

    const showMalformed = makeCall({ show: () => ok({ commit: null }) })
    const sixth = render(<GitBrowserView {...viewProps(showMalformed.call)} t={t} />)
    await openRepository(sixth.container)
    fireEvent.click(sixth.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(sixth.container.querySelectorAll('[data-git-commit]')).toHaveLength(2) })
    fireEvent.click(sixth.container.querySelectorAll('[data-git-commit-open]')[0]!)
    await waitFor(() => { expect(sixth.container.querySelector('[data-git-show-error]')?.textContent).toContain(zh['view.malformed']) })
    expect(sixth.container.querySelector('[data-git-error]')).toBeNull()
  })

  it('keeps a valid refresh failure on the page banner while the human moves between tabs', async () => {
    let reads = 0
    const { call } = makeCall({
      status: () => {
        reads += 1
        return reads === 1 ? ok(STATUS) : failed('git-failed', 'refresh failed')
      },
    })
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)
    fireEvent.click(container.querySelector('[data-git-refresh]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-error]')?.textContent).toContain('refresh failed') })
    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(container.querySelectorAll('[data-git-commit]')).toHaveLength(2) })
    expect(container.querySelector('[data-git-error]')?.textContent).toContain('refresh failed')
    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="worktree"]')!)
    expect(container.querySelector('[data-git-error]')?.textContent).toContain('refresh failed')
  })
})

describe('degraded and narrow layouts', () => {
  it('renders a clean detached repository with no commits', async () => {
    const { call } = makeCall({
      status: () => ok({ root: '/', branch: null, detached: true, upstream: null, ahead: 0, behind: 0, files: [] }),
      log: () => ok({ commits: [] }),
    })
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container, '/')
    expect(container.querySelector('[data-git-repo-name]')!.textContent).toBe('/')
    expect(container.querySelector('[data-git-branch]')!.textContent).toBe(zh['view.repo.detached'])
    expect(container.querySelector('[data-git-upstream]')).toBeNull()
    expect(container.querySelector('[data-git-dirty]')!.getAttribute('data-git-dirty')).toBe('false')
    expect(container.querySelector('[data-git-worktree-empty]')).toBeTruthy()
    expect(container.querySelector('[data-git-last-commit]')).toBeNull()
    fireEvent.click(container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-history-empty]')).toBeTruthy() })
  })

  it('switches from the list to the detail and back (the narrow-screen controls)', async () => {
    const { call } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call)} t={t} />)
    await openRepository(container)
    expect(container.querySelector('[data-git-main]')!.getAttribute('data-git-show-detail')).toBe('false')
    expect(container.querySelector('[data-git-detail-empty]')).toBeTruthy()
    fireEvent.click(container.querySelector('[data-git-file-path="a.txt"]')!)
    await waitFor(() => { expect(container.querySelector('[data-git-diff]')).toBeTruthy() })
    expect(container.querySelector('[data-git-main]')!.getAttribute('data-git-show-detail')).toBe('true')
    expect(container.querySelector('[data-git-back]')).toBeTruthy()
    fireEvent.click(container.querySelector('[data-git-back]')!)
    expect(container.querySelector('[data-git-main]')!.getAttribute('data-git-show-detail')).toBe('false')
    expect(container.querySelector('[data-git-back]')).toBeNull()
  })

  it('takes the narrow breakpoint from the page container, not the viewport', () => {
    const stylesheet = readFileSync(join(process.cwd(), 'apps/git-browser/view/src/client/GitBrowserView.module.css'), 'utf8')
    // The page root is a real query container, and every narrow rule asks it.
    expect(stylesheet).toMatch(/\.view \{[^}]*container-type:\s*inline-size/u)
    expect(stylesheet).toContain('@container (max-width: 720px)')
    expect(stylesheet).not.toContain('@media (max-width: 720px)')
    expect(stylesheet).toMatch(/\.mainDetail \.listPane\s*\{\s*display:\s*none/u)
    expect(stylesheet).toMatch(/\.mainDetail \.detailPane\s*\{\s*display:\s*block/u)
    // The back control is present at every width (the detail overlays the list
    // between 721px and the two-pane width), and stays visible while scrolling.
    expect(stylesheet).toMatch(/\.backBtn \{[^}]*display:\s*inline-flex/u)
    expect(stylesheet).toMatch(/\.backBtn \{[^}]*position:\s*sticky/u)
    const source = readFileSync(join(process.cwd(), 'apps/git-browser/view/src/client/GitBrowserView.tsx'), 'utf8')
    expect(source).toContain('data-git-show-detail={detailOpen')
    expect(source).toContain('data-git-back')
  })

  it('pins the 1440×900 worktree first-row stack inside the 200px budget', () => {
    const stylesheet = readFileSync(join(process.cwd(), 'apps/git-browser/view/src/client/GitBrowserView.module.css'), 'utf8')
    const source = readFileSync(join(process.cwd(), 'apps/git-browser/view/src/client/GitBrowserView.tsx'), 'utf8')
    // The measurable stack the browser lane reads from the window top:
    // shell header 48 + [data-git-repo] 41 + [data-git-tabs] 37
    // + [data-git-list-head] 24 + [data-git-group] 24 = 174 (budget 200).
    // The repo header holds one row because a zero flex basis keeps its path
    // from starving the metadata it shares the row with.
    expect(stylesheet).toMatch(/\.repoHead \{[^}]*padding:\s*4px 20px/u)
    expect(stylesheet).toMatch(/\.repoMain \{[^}]*flex:\s*1 1 0/u)
    expect(stylesheet).toMatch(/\.tabs \{[^}]*--app-tab-row-height:\s*36px/u)
    expect(stylesheet).toMatch(/\.tabs \[role=['"]tab['"]\] \{[^}]*padding:\s*8px 0 7px/u)
    expect(stylesheet).toMatch(/\.listHead \{[^}]*padding:\s*4px 14px 2px/u)
    expect(stylesheet).toMatch(/\.groupHead \{[^}]*padding:\s*4px 14px 2px/u)
    for (const anchor of ['data-git-repo', 'data-git-tabs', 'data-git-list-head', 'data-git-group', 'data-git-file']) {
      expect(source, anchor).toContain(anchor)
    }
  })
})

describe('the registered page', () => {
  it('binds the locale service and renders the page', async () => {
    const snapshot = { language: 'zh' }
    const locale = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      bind: () => t,
    }
    const { call } = makeCall()
    render(<GitBrowserPage {...viewProps(call)} locale={locale as never} />)
    await waitFor(() => { expect(screen.getByText(zh['view.empty.title'])).toBeTruthy() })
  })

  it('loads older commits, changes repository and retries failed details', async () => {
    const many = { commits: Array.from({ length: 50 }, (_, index) => ({ ...COMMIT_A, hash: `${String(index).padStart(40, '0')}` })) }
    let diffCalls = 0
    const calls = makeCall({
      log: (args) => ok({ commits: args.limit === 100 ? [...many.commits, ...many.commits] : many.commits }),
      diff: () => { diffCalls += 1; return diffCalls === 1 ? failed('timeout', 'diff failed') : ok(DIFF) },
      show: () => failed('timeout', 'show failed'),
    })
    const view = render(<GitBrowserView {...viewProps(calls.call)} t={t} />)
    await openRepository(view.container)
    fireEvent.click(view.container.querySelector('[data-git-change-repo]')!)
    expect(view.container.querySelector('[data-git-open-form]')).toBeTruthy()
    fireEvent.click(view.container.querySelector('[data-git-recent-toggle]')!)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(view.container.querySelector('[role="menu"]')).toBeNull() })
    fireEvent.click(view.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-load-more]')).toBeTruthy() })
    fireEvent.click(view.container.querySelector('[data-git-load-more]')!)
    await waitFor(() => { expect(calls.calls.some(entry => entry.op === 'log' && entry.args.limit === 100)).toBe(true) })
    fireEvent.click(view.container.querySelector('[data-git-tabs] [data-git-tab="worktree"]')!)
    fireEvent.click(view.container.querySelector('[data-git-file-path="a.txt"]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-diff-error]')).toBeTruthy() })
    fireEvent.click(view.container.querySelector('[data-git-diff-retry]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-patch]')).toBeTruthy() })
    fireEvent.click(view.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-commit]')).toBeTruthy() })
    fireEvent.click(view.container.querySelector('[data-git-commit-open]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-show-error]')).toBeTruthy() })
    fireEvent.click(view.container.querySelector('[data-git-show-retry]')!)
    await waitFor(() => { expect(calls.calls.filter(entry => entry.op === 'show').length).toBeGreaterThan(1) })
  })

  it('keeps a failed or malformed older-history page in the history pane', async () => {
    const many = { commits: Array.from({ length: 50 }, (_, index) => ({ ...COMMIT_A, hash: `${String(index).padStart(40, '0')}` })) }
    let fail = false
    const calls = makeCall({ log: (args) => fail ? failed('timeout', 'more failed') : ok(args.limit === 100 ? many : many) })
    const view = render(<GitBrowserView {...viewProps(calls.call)} t={t} />)
    await openRepository(view.container)
    fireEvent.click(view.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-load-more]')).toBeTruthy() })
    fail = true
    fireEvent.click(view.container.querySelector('[data-git-load-more]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-log-error]')?.textContent).toContain('more failed') })
    // The rows that were already read stay visible; only the pane's own error
    // is added, never the page banner.
    expect(view.container.querySelectorAll('[data-git-commit]')).toHaveLength(50)
    expect(view.container.querySelector('[data-git-error]')).toBeNull()
  })

  it('replaces the load-more control with the host cap notice at 100 commits', async () => {
    const commits = Array.from({ length: 100 }, (_, index) => ({ ...COMMIT_A, hash: `${String(index).padStart(40, '0')}` }))
    const calls = makeCall({ log: (args) => ok({ commits: commits.slice(0, Math.min(Number(args.limit), 100)) }) })
    const view = render(<GitBrowserView {...viewProps(calls.call)} t={t} />)
    await openRepository(view.container)
    fireEvent.click(view.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-git-commit]')).toHaveLength(50) })
    expect(view.container.querySelector('[data-git-load-more]')).toBeTruthy()
    fireEvent.click(view.container.querySelector('[data-git-load-more]')!)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-git-commit]')).toHaveLength(100) })
    expect(view.container.querySelector('[data-git-load-more]')).toBeNull()
    expect(view.container.querySelector('[data-git-log-cap]')!.textContent).toBe(zh['view.history.cap'].replace('{count}', '100'))
  })

  it('leaves no dead control or cap notice when fewer than the cap are loaded', async () => {
    const commits = Array.from({ length: 80 }, (_, index) => ({ ...COMMIT_A, hash: `${String(index).padStart(40, '0')}` }))
    const calls = makeCall({ log: (args) => ok({ commits: commits.slice(0, Math.min(Number(args.limit), 80)) }) })
    const view = render(<GitBrowserView {...viewProps(calls.call)} t={t} />)
    await openRepository(view.container)
    fireEvent.click(view.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-git-commit]')).toHaveLength(50) })
    fireEvent.click(view.container.querySelector('[data-git-load-more]')!)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-git-commit]')).toHaveLength(80) })
    expect(view.container.querySelector('[data-git-load-more]')).toBeNull()
    expect(view.container.querySelector('[data-git-log-cap]')).toBeNull()
  })

  it('shows the in-flight copy while a diff or commit detail is being read', async () => {
    let resolveDiff!: (outcome: CallOutcome) => void
    let resolveShow!: (outcome: CallOutcome) => void
    const calls = makeCall({
      diff: () => new Promise<CallOutcome>((resolve) => { resolveDiff = resolve }),
      show: () => new Promise<CallOutcome>((resolve) => { resolveShow = resolve }),
    })
    const view = render(<GitBrowserView {...viewProps(calls.call)} t={t} />)
    await openRepository(view.container)
    fireEvent.click(view.container.querySelector('[data-git-file-path="a.txt"]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-diff-pending]')?.textContent).toContain('正在读取') })
    resolveDiff(ok(DIFF))
    await waitFor(() => { expect(view.container.querySelector('[data-git-patch]')).toBeTruthy() })
    fireEvent.click(view.container.querySelector('[data-git-tabs] [data-git-tab="history"]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-commit]')).toBeTruthy() })
    fireEvent.click(view.container.querySelector('[data-git-commit-open]')!)
    await waitFor(() => { expect(view.container.querySelector('[data-git-show-loading]')?.textContent).toContain('正在读取') })
    resolveShow(ok(SHOW))
    await waitFor(() => { expect(view.container.querySelector('[data-git-show]')).toBeTruthy() })
  })
})


describe('restoring the workbench and permission copy', () => {
  it('reopens the repository, tab and commit from the shell UI state', async () => {
    const ui = uiStore({ path: '/srv/repo', tab: 'history', commit: COMMIT_A.hash })
    const { call, calls } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call, ui)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-git-show-subject]')?.textContent).toContain('feat: workbench') })
    expect(calls.some(entry => entry.op === 'status' && entry.args.path === '/srv/repo')).toBe(true)
    expect(calls.some(entry => entry.op === 'show' && entry.args.rev === COMMIT_A.hash)).toBe(true)
    expect(container.querySelector('[data-git-tab="history"]')?.getAttribute('aria-selected')).toBe('true')
  })

  it('reopens the selected file and its staged side from the UI state', async () => {
    const ui = uiStore({ path: '/srv/repo', tab: 'worktree', file: 'a.txt', side: 'staged' })
    const { call, calls } = makeCall()
    const { container } = render(<GitBrowserView {...viewProps(call, ui)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-git-diff-title]')?.textContent).toBe('a.txt') })
    expect(calls.some(entry => entry.op === 'diff' && entry.args.file === 'a.txt' && entry.args.staged === true)).toBe(true)
  })

  it('offers the permission page from a refusal and points at the header Notifications control', async () => {
    const openManagement = vi.fn()
    const { call } = makeCall({ status: () => failed('app.capability-not-approved', 'process capability was not approved') })
    const { container } = render(<GitBrowserView {...viewProps(call, undefined, { openManagement })} t={t} />)
    fireEvent.change(container.querySelector('[data-git-path-input]') as HTMLInputElement, { target: { value: '/srv/repo' } })
    fireEvent.submit(container.querySelector('[data-git-open-form]') as HTMLFormElement)
    await waitFor(() => { expect(container.querySelector('[data-git-error]')).toBeTruthy() })
    const error = container.querySelector('[data-git-error]') as HTMLElement
    expect(error.getAttribute('data-git-error-kind')).toBe('permission')
    expect(error.querySelector('strong')?.textContent).toBe(zh['view.error.permission.title'])
    // The copy names the header control by its real accessible name.
    expect(error.querySelector('p')?.textContent).toBe(zh['view.error.permission.body'])
    expect(error.querySelector('p')?.textContent).toContain('通知')
    const manage = error.querySelector('[data-git-manage-permissions]') as HTMLElement
    expect(manage.textContent).toBe(zh['view.error.permission.manage'])
    fireEvent.click(manage)
    expect(openManagement).toHaveBeenCalledWith('permissions')
    // The raw host message stays available for diagnosis.
    expect(error.querySelector('details')?.textContent).toContain('process capability was not approved')
  })
})
