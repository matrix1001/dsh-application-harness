import { vi } from 'vitest'
import type { ApplicationUiState, ApplicationUiStore, PageContextInput, ViewportInput } from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import type {
  EvidenceSession, Review, ReviewEvidenceSession, ReviewPreview, ReviewSettings, ReviewSummary, SessionEvidenceView,
  SourceInfo, TimelineEntry, WorkspaceView,
} from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'

export type HarnessKey = keyof typeof zh
export type Outcome = { callId: string; status: 'success'; result: unknown } | { callId: string; status: 'failed' | 'rejected'; error: { code: string; message: string } } | { callId: string; status: 'cancelled' }
export type Args = Record<string, unknown>
export type Responder = (args: Args) => Outcome | Promise<Outcome>

export const NOW = Date.UTC(2026, 10, 5, 8, 40)

export function ok(value: unknown): Outcome { return { callId: 'call', status: 'success', result: value } }
export function failed(message = 'boom', code = 'failed'): Outcome { return { callId: 'call', status: 'failed', error: { code: `app.${code}`, message } } }
export function rejected(message = 'rejected', code = 'denied'): Outcome { return { callId: 'call', status: 'rejected', error: { code: `platform.${code}`, message } } }
export function cancelled(): Outcome { return { callId: 'call', status: 'cancelled' } }

export const SOURCES: SourceInfo[] = [
  { agent: 'dsh', label: 'DSH', path: '/home/ada/.dsh/sessions', found: true, fileCount: 12, lastSyncAt: NOW },
  { agent: 'claude-code', label: 'Claude Code', path: '/home/ada/.claude/projects', found: true, fileCount: 8 },
  { agent: 'codex', label: 'Codex', path: '/home/ada/.codex/sessions', found: false, fileCount: 0, lastError: 'not found' },
]
export const SOURCES_MISSING: SourceInfo[] = SOURCES.map(source => ({ ...source, found: false, fileCount: 0 }))

export const SETTINGS: ReviewSettings = {
  sourceRoots: { dsh: '/home/ada/.dsh/sessions', claudeCode: '/home/ada/.claude/projects', codex: '/home/ada/.codex/sessions' },
  redactSecrets: true,
  reviewRetention: 20,
  aiEnabled: true,
}

export const WORKSPACES: WorkspaceView[] = [
  { id: 'w_alpha', name: 'dsh-application-harness', root: '/work/dsh-application-harness', aliases: [], createdAt: NOW - 30 * 86_400_000, lastSyncAt: NOW, lastReviewAt: NOW, sessionCount: 38, reviewCount: 2 },
  { id: 'w_beta', name: 'deepseek-harness', root: '/work/deepseek-harness', aliases: [], createdAt: NOW - 40 * 86_400_000, sessionCount: 4, reviewCount: 0 },
]

export const REVIEWS: ReviewSummary[] = [
  { id: 'r_1', workspaceId: 'w_alpha', range: 'last30', from: '2026-10-07', to: '2026-11-05', generatedAt: NOW, sessionCount: 4, aiStatus: 'generated', model: 'p/m' },
  { id: 'r_2', workspaceId: 'w_alpha', range: 'last30', from: '2026-09-07', to: '2026-10-06', generatedAt: NOW - 30 * 86_400_000, sessionCount: 2, aiStatus: 'failed' },
]

const evidenceSessions: ReviewEvidenceSession[] = [
  { id: 's_1', title: '信息收件箱和 Git 浏览的设计收口', agent: 'dsh' },
  { id: 's_2', title: '任务与日历的界面尺度统一', agent: 'claude-code' },
  { id: 's_3', title: '应用组合从四应用拆到七应用', agent: 'dsh' },
  { id: 's_4', title: '存储方案改回纯 SQLite', agent: 'codex' },
]

const timeline: TimelineEntry[] = [
  { sessionId: 's_1', date: '2026-11-05', title: '信息收件箱和 Git 浏览的设计收口', agent: 'dsh', outcome: 'has-result', summary: '从范围、mock 到 plan，补上跨应用导航记录。', durationMinutes: 134, turnCount: 26 },
  { sessionId: 's_2', date: '2026-11-03', title: '任务与日历的界面尺度统一', agent: 'claude-code', outcome: 'interrupted', summary: '对齐应用排版、详情抽屉和移动端断点。', durationMinutes: 92, turnCount: 18 },
  { sessionId: 's_3', date: '2026-10-28', title: '应用组合从四应用拆到七应用', agent: 'dsh', outcome: 'unconfirmed', summary: '改部署、路由和旧应用保留策略；出现一次回归。', durationMinutes: 185, turnCount: 41 },
  { sessionId: 's_4', date: '2026-10-27', title: '存储方案改回纯 SQLite', agent: 'codex', outcome: 'has-result', summary: '先试 Markdown 文件，后确认改回统一 SQLite。', durationMinutes: 48, turnCount: 12 },
]

export const REVIEW_FULL: Review = {
  id: 'r_1',
  workspaceId: 'w_alpha',
  workspaceName: 'dsh-application-harness',
  root: '/work/dsh-application-harness',
  range: 'last30',
  from: '2026-10-07',
  to: '2026-11-05',
  generatedAt: NOW,
  model: 'deepseek/chat',
  sessionIds: ['s_1', 's_2', 's_3', 's_4'],
  inputHash: 'hash',
  ai: { status: 'generated', analyzedSessions: 4, totalSessions: 4 },
  deterministic: {
    metrics: { sessions: 4, activeDays: 3, userTurns: 97, files: 11, gitCommits: 2, tasks: 3, toolCalls: 40, testsPassed: 2, testsFailed: 1, interrupted: 1 },
    timeline,
    signals: [
      { kind: 'interruptions', text: '1 session(s) were interrupted', sessionIds: ['s_2'] },
      { kind: 'failed-tests', text: '1 test command(s) failed', sessionIds: ['s_2'] },
      { kind: 'repeated-file', text: 'src/shared.ts was touched in 2 sessions', sessionIds: ['s_1', 's_2'] },
      { kind: 'mixed-sources', text: 'sessions came from 3 agent sources', sessionIds: [] },
      { kind: 'other', text: 'an unknown fact', sessionIds: [] },
    ],
    sources: [{ agent: 'dsh', count: 2 }, { agent: 'claude-code', count: 1 }, { agent: 'codex', count: 1 }],
    weeks: [
      { label: '2026-10-26', from: '2026-10-26', to: '2026-11-01', agents: { dsh: 1, codex: 1 }, total: 2 },
      { label: '2026-11-02', from: '2026-11-02', to: '2026-11-08', agents: { dsh: 1, 'claude-code': 1 }, total: 2 },
    ],
    evidenceSessions,
    git: { available: true, branch: 'main', clean: false, changedFiles: 3, commits: 2, recent: [{ hash: 'abc', subject: 'feat: review' }], diff: { files: 3, additions: 10, deletions: 2 } },
    tasks: { available: true, projectId: 'p1', total: 3, open: 2 },
  },
  narrative: {
    summary: { text: '这个月主要完成了应用组合的重新拆分。', evidence: ['s_1', 's_3'] },
    themes: [
      { title: '应用组合拆分', text: '把应用拆成独立应用。', evidence: ['s_3'] },
      { title: '统一存储与契约', text: '统一 SQLite namespace。', evidence: ['s_4'] },
    ],
    decisions: [
      { text: '应用拆成独立应用。', kind: 'explicit', evidence: ['s_3'] },
      { text: '先记录跨应用导航。', kind: 'inferred', evidence: ['s_1'] },
    ],
    deadEnds: [{ text: '先试 Markdown 文件但没有继续。', evidence: ['s_4'] }],
    friction: [{ text: '存储方案改过两次。', evidence: ['s_4'] }],
    openLoops: [{ text: '跨应用页面导航契约未落地。', evidence: ['s_1'] }],
  },
}

export const REVIEW_FAILED: Review = ({
  ...REVIEW_FULL,
  id: 'r_2',
  generatedAt: NOW - 30 * 86_400_000,
  ai: { status: 'failed', analyzedSessions: 0, totalSessions: 2, message: 'model exploded' },
  model: undefined,
  narrative: undefined,
} as unknown as Review)

export const REVIEW_CLOSED: Review = ({
  ...REVIEW_FULL,
  id: 'r_closed',
  ai: { status: 'disabled', totalSessions: 4 },
  narrative: undefined,
} as unknown as Review)

export const REVIEW_UNAVAILABLE: Review = ({
  ...REVIEW_FULL,
  id: 'r_unavailable',
  ai: { status: 'unavailable', totalSessions: 4, message: 'no route' },
  narrative: undefined,
} as unknown as Review)

export const REVIEW_NOT_REQUESTED: Review = ({
  ...REVIEW_FULL,
  id: 'r_not_requested',
  ai: { status: 'not-requested', totalSessions: 4 },
  narrative: undefined,
} as unknown as Review)

export const REVIEW_NO_NARRATIVE: Review = ({
  ...REVIEW_FULL,
  id: 'r_no_narrative',
  ai: { status: 'generated', analyzedSessions: 4, totalSessions: 4 },
  narrative: undefined,
} as unknown as Review)

export const PREVIEW: ReviewPreview = { workspaceId: 'w_alpha', range: 'last30', from: '2026-10-07', to: '2026-11-05', sessionCount: 4, aiSessions: 4, aiEnabled: true }

export const EVIDENCE_SESSION: EvidenceSession = {
  id: 's_1',
  agent: 'dsh',
  nativeId: 'native-1',
  sourcePath: '/home/ada/.dsh/sessions/one.jsonl',
  cwd: '/work/dsh-application-harness',
  startedAt: NOW - 7_200_000,
  endedAt: NOW,
  title: '信息收件箱和 Git 浏览的设计收口',
  turnCount: 26,
  userTurns: 12,
  toolCalls: 14,
  tools: ['read', 'write', 'bash'],
  filesTouched: ['tmp/inbox/implementation-plan.md'],
  commands: ['pnpm test'],
  tests: [{ command: 'pnpm test', status: 'passed' }, { command: 'pytest', status: 'failed' }, { command: 'go test', status: 'unknown' }],
  flags: { interrupted: false },
  excerpt: '完成两个应用的设计与计划；跨应用导航只记录，未实现。',
  keyTurns: [{ role: 'user', text: '先记录跨应用导航问题。' }, { role: 'assistant', text: '已完成两个 mock 和实施计划。' }],
  importedAt: NOW,
}

export const EVIDENCE: SessionEvidenceView = {
  session: EVIDENCE_SESSION,
  sourceAvailable: true,
  outcome: 'has-result',
  subagents: [{ id: 's_child', title: '子任务', agent: 'dsh', startedAt: NOW - 3_600_000 }],
}

export const EVIDENCE_EMPTY: SessionEvidenceView = ({
  session: {
    ...EVIDENCE_SESSION,
    id: 's_empty',
    title: 'Empty',
    excerpt: '',
    keyTurns: [],
    tools: [],
    filesTouched: [],
    commands: [],
    tests: [],
    endedAt: undefined,
  },
  sourceAvailable: false,
  outcome: 'unconfirmed',
  subagents: [],
} as unknown as SessionEvidenceView)

export const UNMATCHED: EvidenceSession[] = [
  { ...EVIDENCE_SESSION, id: 's_unmatched', title: 'Outside session' } as EvidenceSession,
]

export interface CallStub {
  call: ApplicationViewProps['call']
  calls: Array<{ op: string; args: Args; requestId?: string }>
  respond: (op: string, responder: Responder) => void
}

export function makeCall(overrides: Record<string, Responder> = {}): CallStub {
  const calls: Array<{ op: string; args: Args; requestId?: string }> = []
  const responders: Record<string, Responder> = {
    listWorkspaces: () => ok(WORKSPACES),
    listSources: () => ok(SOURCES),
    settings: () => ok(SETTINGS),
    listReviews: () => ok(REVIEWS),
    getReview: args => ok(args.reviewId === 'r_2' ? REVIEW_FAILED : REVIEW_FULL),
    syncWorkspace: () => ok({ taskId: 't1', workspaceId: 'w_alpha', newSinceReview: 2 }),
    listUnmatchedSessions: () => ok(UNMATCHED),
    previewReview: () => ok(PREVIEW),
    generateReview: () => ok(REVIEW_FULL),
    getSessionEvidence: args => ok(args.sessionId === 's_empty' ? EVIDENCE_EMPTY : EVIDENCE),
    assignSession: () => ok([]),
    createWorkspace: () => ok({ ...WORKSPACES[0], id: 'w_new', name: 'new-workspace' }),
    cancelGenerate: () => ok({ status: 'accepted' }),
    cancelSync: () => ok({ status: 'accepted' }),
    ...overrides,
  }
  const call = async (op: string, args: Args, requestId?: string): Promise<Outcome> => {
    calls.push({ op, args: args ?? {}, ...(requestId === undefined ? {} : { requestId }) })
    const responder = responders[op]
    return await (responder === undefined ? failed(`no ${op}`) : responder((args ?? {}) as Args))
  }
  return {
    call: call as ApplicationViewProps['call'],
    calls,
    respond: (op, responder) => { responders[op] = responder },
  }
}

export function makeChanged(): { onChanged: ApplicationViewProps['onChanged']; fire: () => void; count: () => number } {
  const listeners = new Set<() => void>()
  return {
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    fire: () => { for (const listener of [...listeners]) listener() },
    count: () => listeners.size,
  }
}

export function makePageContext(): { report: ApplicationViewProps['pageContext']['report']; labels: string[]; live: () => number } {
  const labels: string[] = []
  const live = new Set<symbol>()
  return {
    labels,
    report: (input: PageContextInput) => { labels.push(input.label); const token = Symbol('report'); live.add(token); return () => { live.delete(token) } },
    live: () => live.size,
  }
}

export function makeViewport(): { report: ApplicationViewProps['viewport']['report']; reports: ViewportInput[] } {
  const reports: ViewportInput[] = []
  return { reports, report: input => { reports.push(input); return () => undefined } }
}

export function makeUi(): ApplicationUiStore {
  let state: ApplicationUiState = {}
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    set: patch => {
      const next = { ...state }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      state = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

export function translator(dictionary: Record<string, string> = zh): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
  }
}

export function props(call: CallStub['call'], overrides: Partial<ApplicationViewProps> = {}): ApplicationViewProps {
  return {
    call,
    cancel: vi.fn(),
    claimProgress: vi.fn(() => () => undefined),
    onChanged: makeChanged().onChanged,
    running: false,
    pageContext: makePageContext() as ApplicationViewProps['pageContext'],
    openManagement: vi.fn(),
    viewport: makeViewport() as ApplicationViewProps['viewport'],
    ui: makeUi(),
    ...overrides,
  }
}
