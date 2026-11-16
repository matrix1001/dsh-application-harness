// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as clientApply } from '../src/client/index.ts'
import { WorkspaceReviewPage, WorkspaceReviewView, pageTitle } from '../src/client/WorkspaceReviewView.tsx'
import type { WorkspaceReviewTranslate } from '../src/client/WorkspaceReviewView.tsx'
import {
  PREVIEW, REVIEWS, REVIEW_CLOSED, REVIEW_FAILED, REVIEW_FULL, REVIEW_NO_NARRATIVE, REVIEW_NOT_REQUESTED, REVIEW_UNAVAILABLE,
  SOURCES_MISSING, UNMATCHED, WORKSPACES, failed, makeCall, makeChanged, makePageContext, makeViewport, ok, props,
  translator, type Outcome,
} from './view-harness.tsx'

const t = translator() as unknown as WorkspaceReviewTranslate

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderView(overrides: Parameters<typeof props>[1] = {}, call = makeCall()): { call: ReturnType<typeof makeCall>; changed: ReturnType<typeof makeChanged> } {
  const changed = makeChanged()
  const pageContext = makePageContext()
  const viewport = makeViewport()
  render(<WorkspaceReviewView {...props(call.call, { onChanged: changed.onChanged, pageContext: pageContext as never, viewport: viewport as never, ...overrides })} t={t} />)
  return { call, changed }
}

describe('WorkspaceReviewPage', () => {
  it('binds the locale dictionary and renders the body', async () => {
    const call = makeCall()
    const snapshot = { language: 'zh' }
    const locale = { subscribe: () => () => undefined, getSnapshot: () => snapshot, bind: () => t }
    render(<WorkspaceReviewPage {...props(call.call)} locale={locale as never} />)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    expect(pageTitle(t)).toBe('工作区回顾')
  })
})

describe('WorkspaceReviewView report', () => {
  it('renders the full report, rhythm, sources, timeline, narrative and evidence drawer', async () => {
    const pageContext = makePageContext()
    const viewport = makeViewport()
    const { call } = renderView({ pageContext: pageContext as never, viewport: viewport as never })
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    expect(screen.getAllByText('上次回顾后有 2 个新会话，已同步到本地。').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-wr-metrics] [data-metric]')).toHaveLength(6)
    expect(document.querySelectorAll('[data-wr-rhythm] [data-wr-week]')).toHaveLength(2)
    expect(document.querySelectorAll('[data-wr-sources] [data-source]')).toHaveLength(3)
    expect(screen.getByText('不比较 agent 表现；只说明会话来源。')).toBeTruthy()
    expect(document.querySelectorAll('[data-wr-timeline-session]')).toHaveLength(4)
    expect(document.querySelectorAll('[data-wr-signals] [data-signal]')).toHaveLength(5)
    expect(document.querySelector('[data-wr-summary]')).toBeTruthy()
    expect(document.querySelectorAll('[data-wr-themes] [data-wr-evidence]').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-wr-decisions] [data-kind]').length).toBe(2)
    expect(document.querySelector('[data-wr-patterns]')).toBeTruthy()
    expect(document.querySelector('[data-wr-dead-ends]')).toBeTruthy()
    expect(document.querySelector('[data-wr-open-loops]')).toBeTruthy()
    expect(pageContext.labels.length).toBeGreaterThan(0)
    expect(viewport.reports.length).toBeGreaterThan(0)
    expect(call.calls.some(entry => entry.op === 'syncWorkspace')).toBe(true)
    const beforeSync = call.calls.filter(entry => entry.op === 'syncWorkspace').length
    fireEvent.click(document.querySelector('[data-wr-sync]')!)
    await waitFor(() => { expect(call.calls.filter(entry => entry.op === 'syncWorkspace').length).toBeGreaterThan(beforeSync) })

    fireEvent.click(document.querySelector('[data-wr-evidence="s_1"]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-evidence-drawer]')).toBeTruthy() })
    expect(screen.getByText('完成两个应用的设计与计划；跨应用导航只记录，未实现。')).toBeTruthy()
    expect(screen.getAllByText('pnpm test').length).toBeGreaterThan(0)
    expect(screen.getAllByText('子任务').length).toBeGreaterThan(0)
    fireEvent.click(document.querySelector('[data-wr-drawer-close]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-evidence-drawer]')).toBeNull() })
    fireEvent.click(document.querySelector('[data-wr-timeline-session="s_2"]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-evidence-drawer]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-drawer-close]')!)
  })

  it('switches history to a failed-AI snapshot but keeps the deterministic report', async () => {
    renderView()
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-review="r_2"]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-ai-failure]')).toBeTruthy() })
    expect(screen.getByText(/AI 生成失败：model exploded/u)).toBeTruthy()
    expect(document.querySelector('[data-wr-metrics]')).toBeTruthy()
  })

  it('fires onChanged and reloads the report', async () => {
    const { call, changed } = renderView()
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    const before = call.calls.filter(entry => entry.op === 'listReviews').length
    changed.fire()
    await waitFor(() => { expect(call.calls.filter(entry => entry.op === 'listReviews').length).toBeGreaterThan(before) })
  })

  it('shows the empty drawer state and then an evidence read failure', async () => {
    const call = makeCall({ getSessionEvidence: () => ok({ session: { ...REVIEW_FULL.deterministic.evidenceSessions[0], excerpt: '', keyTurns: [], tools: [], filesTouched: [], commands: [], tests: [], title: 'Empty' }, sourceAvailable: false, outcome: 'unconfirmed', subagents: [] }) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-evidence="s_1"]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-evidence-drawer]')).toBeTruthy() })
    expect(screen.getByText('没有可显示的摘要内容。')).toBeTruthy()
    expect(screen.getByText('源文件不可用；保留的摘要仍可查看。')).toBeTruthy()
    fireEvent.click(document.querySelector('[data-wr-drawer-close]')!)
    call.respond('getSessionEvidence', () => failed('cannot read'))
    fireEvent.click(document.querySelector('[data-wr-evidence="s_1"]')!)
    await waitFor(() => { expect(screen.getByText(/读取证据失败：cannot read/u)).toBeTruthy() })
  })
})

describe('WorkspaceReviewView generation', () => {
  it('opens the modal, previews ranges, custom dates and generates', async () => {
    const { call } = renderView()
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-generate]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-generate-modal]')).toBeTruthy() })
    await waitFor(() => { expect(document.querySelector('[data-wr-preview]')).toBeTruthy() })
    expect(call.calls.some(entry => entry.op === 'previewReview')).toBe(true)
    fireEvent.click(document.querySelector('[data-wr-range="custom"]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-custom-from]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-custom-from]')!, { target: { value: '2026-10-01' } })
    fireEvent.change(document.querySelector('[data-wr-custom-to]')!, { target: { value: '2026-10-31' } })
    await waitFor(() => { expect(call.calls.filter(entry => entry.op === 'previewReview').some(entry => entry.args.from === '2026-10-01')).toBe(true) })
    fireEvent.click(document.querySelector('[data-wr-confirm]')!)
    await waitFor(() => { expect(call.calls.some(entry => entry.op === 'generateReview' && entry.args.range === 'custom')).toBe(true) })
    await waitFor(() => { expect(document.querySelector('[data-wr-generate-modal]')).toBeNull() })
    expect(screen.getByText('回顾已生成：4 个会话')).toBeTruthy()
    fireEvent.click(document.querySelector('[data-wr-generate]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-generate-modal]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-modal-close]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-generate-modal]')).toBeNull() })
  })

  it('shows preview failures and a zero-session range', async () => {
    const call = makeCall({ previewReview: () => failed('bad range') })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-generate]')!)
    await waitFor(() => { expect(screen.getByText(/无法预览范围：bad range/u)).toBeTruthy() })
    call.respond('previewReview', () => ok({ ...PREVIEW, sessionCount: 0, aiSessions: 0 }))
    fireEvent.click(document.querySelector('[data-wr-range="last7"]')!)
    await waitFor(() => { expect((document.querySelector('[data-wr-confirm]') as HTMLButtonElement).disabled).toBe(true) })
    expect(screen.getByText('这个范围没有可分析的会话。')).toBeTruthy()
  })

  it('disables generation while running and shows a generate failure', async () => {
    const call = makeCall({ generateReview: () => failed('generation exploded') })
    renderView({ running: true }, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    expect((document.querySelector('[data-wr-generate]') as HTMLButtonElement).disabled).toBe(true)
    renderView({}, call)
    await waitFor(() => { expect(document.querySelectorAll('[data-wr-report]').length).toBe(2) })
    fireEvent.click(document.querySelectorAll('[data-wr-generate]')[1]!)
    await waitFor(() => { expect(document.querySelector('[data-wr-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-confirm]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-generate-error]')).toBeTruthy() })
  })
})

describe('WorkspaceReviewView empty and failure states', () => {
  it('retries a failed workspace load', async () => {
    const call = makeCall({ listWorkspaces: () => failed('workspace read failed') })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-load-error]')).toBeTruthy() })
    expect(screen.getByText(/读取失败：workspace read failed/u)).toBeTruthy()
    call.respond('listWorkspaces', () => ok(WORKSPACES))
    fireEvent.click(within(document.querySelector('[data-wr-load-error]') as HTMLElement).getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    expect(call.calls.filter(entry => entry.op === 'listWorkspaces').length).toBeGreaterThan(1)
  })

  it('shows the no-workspace state and disables the workspace actions', async () => {
    const call = makeCall({ listWorkspaces: () => ok([]) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-empty-workspaces]')).toBeTruthy() })
    expect((document.querySelector('[data-wr-mobile-workspace]') as HTMLSelectElement).disabled).toBe(true)
    expect((document.querySelector('[data-wr-sync]') as HTMLButtonElement).disabled).toBe(true)
    expect((document.querySelector('[data-wr-generate]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a missing source before a generic empty review', async () => {
    const call = makeCall({ listReviews: () => ok([]), listSources: () => ok(SOURCES_MISSING) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-source-missing]')).toBeTruthy() })
    expect(screen.getByText(/这些目录不存在/u)).toBeTruthy()
    expect(screen.getAllByText('/home/ada/.dsh/sessions').length).toBeGreaterThan(0)
  })

  it('shows source and unmatched truncation instead of hiding the cut', async () => {
    const call = makeCall({
      listReviews: () => ok([]),
      syncWorkspace: () => ok({ newSinceReview: 1, truncatedSources: ['dsh', 'codex'], unmatchedTruncated: true }),
    })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-sync-warning]')?.textContent).toContain('dsh, codex') })
    expect(document.querySelector('[data-wr-sync-warning]')?.textContent).toContain('500')
  })

  it('keeps a partial sync warning visible after a successful sync', async () => {
    const call = makeCall({ listReviews: () => ok([]), syncWorkspace: () => ok({ newSinceReview: 1, errors: ['source offline'] }) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-sync-error]')?.textContent).toContain('source offline') })
  })

  it('shows a sync failure instead of an empty report', async () => {
    const call = makeCall({ listReviews: () => ok([]), syncWorkspace: () => failed('source offline') })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-sync-error]')).toBeTruthy() })
    expect(screen.getByText(/同步失败：source offline/u)).toBeTruthy()
    expect(document.querySelector('[data-wr-empty-review]')).toBeNull()
  })

  it('shows the empty review and opens the generator from it', async () => {
    const call = makeCall({ listReviews: () => ok([]) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-empty-review]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '生成第一份回顾' }))
    await waitFor(() => { expect(document.querySelector('[data-wr-generate-modal]')).toBeTruthy() })
  })

  it('renders every non-generated AI status with the deterministic report kept', async () => {
    for (const [fixture, text] of [
      [REVIEW_FAILED, /AI 生成失败：model exploded/u],
      [REVIEW_CLOSED, /AI 已在设置中关闭/u],
      [REVIEW_UNAVAILABLE, /AI 不可用：no route/u],
      [REVIEW_NOT_REQUESTED, /本次只生成确定性报告/u],
    ] as const) {
      const call = makeCall({ getReview: () => ok(fixture) })
      const { unmount } = render(<WorkspaceReviewView {...props(call.call)} t={t} />)
      await waitFor(() => { expect(document.querySelector('[data-wr-ai-failure]')).toBeTruthy() })
      expect(screen.getByText(text)).toBeTruthy()
      expect(document.querySelector('[data-wr-metrics]')).toBeTruthy()
      unmount()
    }
    const call = makeCall({ getReview: () => ok(REVIEW_NO_NARRATIVE) })
    render(<WorkspaceReviewView {...props(call.call)} t={t} />)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    expect(document.querySelector('[data-wr-summary]')).toBeNull()
    expect(document.querySelector('[data-wr-ai-failure]')).toBeNull()
  })
})

describe('WorkspaceReviewView unmatched sessions', () => {
  it('assigns an unmatched session and shows the confirmation', async () => {
    const call = makeCall()
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('tab', { name: '未归类' }))
    await waitFor(() => { expect(document.querySelector('[data-wr-unmatched-session="s_unmatched"]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-assign="s_unmatched"]')!, { target: { value: 'w_alpha' } })
    await waitFor(() => { expect(call.calls.some(entry => entry.op === 'assignSession' && entry.args.sessionId === 's_unmatched')).toBe(true) })
    expect(screen.getByText('已归属到 dsh-application-harness')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '回顾' }))
  })

  it('shows assignment failures and an empty unmatched list', async () => {
    const call = makeCall({ listUnmatchedSessions: () => ok(UNMATCHED), assignSession: () => failed('cannot assign') })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('tab', { name: '未归类' }))
    await waitFor(() => { expect(document.querySelector('[data-wr-assign="s_unmatched"]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-assign="s_unmatched"]')!, { target: { value: 'w_beta' } })
    await waitFor(() => { expect(document.querySelector('[data-wr-assign-error]')).toBeTruthy() })
    expect(screen.getByText(/归属失败：cannot assign/u)).toBeTruthy()
    call.respond('listUnmatchedSessions', () => ok([]))
    fireEvent.click(screen.getByRole('tab', { name: '回顾' }))
    fireEvent.click(screen.getByRole('tab', { name: '未归类' }))
    await waitFor(() => { expect(screen.getByText('没有未归类会话。')).toBeTruthy() })
  })

  it('reports a failed unmatched read', async () => {
    const call = makeCall({ listUnmatchedSessions: () => failed('unmatched read failed') })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('tab', { name: '未归类' }))
    await waitFor(() => { expect(document.querySelector('[data-wr-assign-error]')).toBeTruthy() })
  })
})

describe('WorkspaceReviewView add workspace and sync', () => {
  it('adds a workspace through the form', async () => {
    const call = makeCall()
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-add]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-root]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-add-root]')!, { target: { value: '/tmp/new-workspace' } })
    fireEvent.change(document.querySelector('[data-wr-add-name]')!, { target: { value: 'New workspace' } })
    fireEvent.click(document.querySelector('[data-wr-add-confirm]')!)
    await waitFor(() => { expect(call.calls.some(entry => entry.op === 'createWorkspace')).toBe(true) })
    expect(call.calls.find(entry => entry.op === 'createWorkspace')?.args).toEqual({ root: '/tmp/new-workspace', name: 'New workspace' })
  })

  it('cancels the form and reports a create failure', async () => {
    const call = makeCall({ createWorkspace: () => failed('root missing') })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-add]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-root]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(call.calls.some(entry => entry.op === 'createWorkspace')).toBe(false)
    fireEvent.click(document.querySelector('[data-wr-add]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-root]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-add-root]')!, { target: { value: '/tmp/x' } })
    fireEvent.click(document.querySelector('[data-wr-add-confirm]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-error]')).toBeTruthy() })
    expect(screen.getAllByText(/添加工作区失败：root missing/u).length).toBeGreaterThan(0)
  })

  it('shows a running sync and then completes it', async () => {
    let finish!: (outcome: Outcome) => void
    const call = makeCall({ syncWorkspace: () => new Promise<Outcome>(resolve => { finish = resolve }) })
    renderView({}, call)
    await waitFor(() => { expect(screen.getByText('同步中…')).toBeTruthy() })
    expect((document.querySelector('[data-wr-sync]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(document.querySelector('[data-wr-cancel-sync]')!)
    await waitFor(() => { expect(call.calls.some(entry => entry.op === 'cancelSync')).toBe(true) })
    finish(ok({ newSinceReview: 1 }))
    await waitFor(() => { expect(screen.getByText('同步')).toBeTruthy() })
    expect(screen.getByText(/上次回顾后有 1 个新会话/u)).toBeTruthy()
  })

  it('cancels an in-flight generation', async () => {
    let finish!: (outcome: Outcome) => void
    const call = makeCall({ generateReview: () => new Promise<Outcome>(resolve => { finish = resolve }) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-generate]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-confirm]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-cancel-generate]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-cancel-generate]')!)
    await waitFor(() => { expect(call.calls.some(entry => entry.op === 'cancelGenerate')).toBe(true) })
    finish(ok(REVIEW_FULL))
    await waitFor(() => { expect(document.querySelector('[data-wr-notice]')).toBeTruthy() })
  })
})

describe('WorkspaceReviewView narrow layout', () => {
  it('provides the mobile workspace switch and the narrow-screen stylesheet rules', async () => {
    const call = makeCall()
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    const mobile = document.querySelector('[data-wr-mobile-workspace]') as HTMLSelectElement
    expect(mobile).toBeTruthy()
    fireEvent.click(document.querySelector('[data-wr-workspace="w_beta"]')!)
    await waitFor(() => { expect(call.calls.filter(entry => entry.op === 'listReviews').some(entry => entry.args.workspaceId === 'w_beta')).toBe(true) })
    fireEvent.change(mobile, { target: { value: 'w_alpha' } })
    await waitFor(() => { expect((document.querySelector('[data-wr-mobile-workspace]') as HTMLSelectElement).value).toBe('w_alpha') })
    const stylesheet = readFileSync(join(process.cwd(), 'packages/client/workspace-review-view/src/client/WorkspaceReviewView.module.css'), 'utf8')
    expect(stylesheet).toContain('@media (max-width: 720px)')
    expect(stylesheet).toMatch(/\.rail\s*\{\s*display:\s*none;/u)
    expect(stylesheet).toMatch(/\.drawer\s*\{\s*width:\s*100%;/u)
  })
})

describe('WorkspaceReviewView defensive rendering', () => {
  it('renders a report with no signals, no sources and empty evidence lists', async () => {
    const sparse = {
      ...REVIEW_FULL,
      narrative: {
        ...REVIEW_FULL.narrative!,
        summary: { text: 'sparse', evidence: [] },
        themes: [{ title: 'Sparse theme', text: 'x', evidence: [] }],
        decisions: [{ text: 'Sparse decision', kind: 'inferred' as const, evidence: [] }],
        friction: [], deadEnds: [], openLoops: [],
      },
      deterministic: {
        ...REVIEW_FULL.deterministic,
        signals: [],
        sources: [],
      },
    }
    const call = makeCall({ getReview: () => ok(sparse) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    expect(document.querySelector('[data-wr-signals]')).toBeNull()
    expect(document.querySelector('[data-wr-sources] [data-source]')).toBeNull()
    expect(document.querySelectorAll('[data-wr-summary] .evidenceChip').length).toBe(0)
  })

  it('reports a failed review detail read from the history click', async () => {
    const call = makeCall({ getReview: args => args.reviewId === 'r_2' ? failed('review read failed') : ok(REVIEW_FULL) })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-review="r_2"]')!)
    await waitFor(() => { expect(screen.getByText(/读取失败：review read failed/u)).toBeTruthy() })
  })
})

describe('WorkspaceReviewView review read failures', () => {
  it('reports a failed history list and a failed detail read on workspace switch', async () => {
    const call = makeCall({
      listReviews: args => args.workspaceId === 'w_beta' ? failed('list failed') : ok(REVIEWS),
      getReview: () => ok(REVIEW_FULL),
      syncWorkspace: args => args.workspaceId === 'w_beta' ? new Promise<Outcome>(() => undefined) : ok({ taskId: 't1', workspaceId: 'w_alpha', newSinceReview: 0 }),
    })
    renderView({}, call)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-workspace="w_beta"]')!)
    await waitFor(() => { expect(screen.getByText(/读取失败：list failed/u)).toBeTruthy() })
    call.respond('listReviews', args => args.workspaceId === 'w_beta' ? ok([{ ...REVIEWS[0]!, id: 'r_beta' }]) : ok(REVIEWS))
    call.respond('getReview', () => failed('detail failed'))
    fireEvent.click(document.querySelector('[data-wr-workspace="w_alpha"]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-workspace="w_beta"]')!)
    await waitFor(() => { expect(screen.getByText(/读取失败：detail failed/u)).toBeTruthy() })
  })
})

describe('client registration', () => {
  it('registers the settings surface with the view', () => {
    let captured: { Settings?: (props: unknown) => unknown } | undefined
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      locale: { register: () => () => undefined, bind: () => t },
      applicationViews: { register: (_id: string, view: { Settings?: (props: unknown) => unknown }) => { captured = view; return () => undefined } },
    }
    clientApply(ctx as never)
    expect(captured?.Settings).toBeTypeOf('function')
    const element = captured!.Settings!({ call: vi.fn(), t })
    expect(element).toBeTruthy()
  })
})

describe('WorkspaceReviewView first-run and mobile entry points', () => {
  it('opens the add-workspace form from the first-run card, the rail and the mobile bar', async () => {
    const empty = makeCall({
      listWorkspaces: () => ok([]),
      listReviews: () => ok([]),
      listSources: () => ok([]),
    })
    renderView({}, empty)
    await waitFor(() => { expect(document.querySelector('[data-wr-first-run]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-first-run-add]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-root]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[role="dialog"] button[aria-label="关闭"]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-root]')).toBeNull() })

    fireEvent.click(document.querySelector('[data-wr-add]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-add-confirm]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-error]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    const normal = makeCall()
    renderView({}, normal)
    await waitFor(() => { expect(document.querySelector('[data-wr-report]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-wr-mobile-add]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-add-root]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.change(document.querySelector('[data-wr-mobile-workspace]')!, { target: { value: 'w_beta' } })
    await waitFor(() => { expect(document.querySelector('[data-wr-mobile-review]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-mobile-review]')!, { target: { value: '' } })
    fireEvent.change(document.querySelector('[data-wr-mobile-review]')!, { target: { value: 'r_2' } })
    await waitFor(() => { expect(normal.calls.some(entry => entry.op === 'getReview' && entry.args.reviewId === 'r_2')).toBe(true) })
    normal.respond('getReview', () => failed('mobile detail failed'))
    fireEvent.change(document.querySelector('[data-wr-mobile-review]')!, { target: { value: 'r_1' } })
    await waitFor(() => { expect(document.querySelector('[data-wr-load-error]')).toBeTruthy() })
  })
})
