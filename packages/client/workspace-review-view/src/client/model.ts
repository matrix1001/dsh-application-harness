/**
 * The workspace-review page's local wire vocabulary and formatting helpers.
 *
 * The view intentionally mirrors the host's wire shapes instead of importing
 * the host package: a page bundle is a browser artifact and the application's
 * exchange is JSON. Everything here is presentation-only — there is no
 * persistence and no ranking rule; agent names are metadata.
 * @module @matrix1001/dsh-application-harness-workspace-review-view/model
 */

/** The three supported agent sources. */
export type AgentKind = 'dsh' | 'claude-code' | 'codex'

/** The range choices shared with the host. */
export type ReviewRange = 'week' | 'last7' | 'month' | 'last30' | 'all' | 'custom'

/** One translation function. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** The subset of the shell's call outcome the page narrows. */
export interface CallOutcomeLike {
  status: 'success' | 'rejected' | 'failed' | 'cancelled' | 'unknown'
  result?: unknown
  error?: { message?: string }
}

/** One workspace row. */
export interface WorkspaceView {
  id: string
  name: string
  root: string
  aliases: string[]
  taskProjectId?: string
  createdAt: number
  lastSyncAt?: number
  lastReviewAt?: number
  sessionCount: number
  reviewCount: number
}

/** One source discovery row. */
export interface SourceInfo {
  agent: AgentKind
  label: string
  path: string
  found: boolean
  fileCount: number
  lastSyncAt?: number
  lastError?: string
}

/** The application settings the page reads. */
export interface ReviewSettings {
  sourceRoots: { dsh: string; claudeCode: string; codex: string }
  redactSecrets: boolean
  reviewRetention: number
  aiEnabled: boolean
}

/** The preview the generate modal shows. */
export interface ReviewPreview {
  workspaceId: string
  range: ReviewRange
  from: string
  to: string
  sessionCount: number
  aiSessions: number
  aiEnabled: boolean
}

/** One review-history row. */
export interface ReviewSummary {
  id: string
  workspaceId: string
  range: ReviewRange
  from: string
  to: string
  generatedAt: number
  sessionCount: number
  aiStatus: ReviewAiStatus
  model?: string
}

/** One deterministic session outcome. */
export type ReviewOutcome = 'has-result' | 'unconfirmed' | 'interrupted'

/** One timeline row. */
export interface TimelineEntry {
  sessionId: string
  date: string
  title: string
  agent: AgentKind
  outcome: ReviewOutcome
  summary: string
  durationMinutes: number
  turnCount: number
}

/** One deterministic fact. */
export interface ReviewSignal {
  kind: string
  text: string
  sessionIds: string[]
}

/** One source count. */
export interface ReviewSourceCount {
  agent: AgentKind
  count: number
}

/** One week of rhythm. */
export interface ReviewWeek {
  label: string
  from: string
  to: string
  agents: Partial<Record<AgentKind, number>>
  total: number
}

/** Optional Git evidence. */
export interface GitEvidence {
  available: boolean
  branch?: string
  clean?: boolean
  changedFiles: number
  commits: number
  recent?: Array<{ hash: string; subject: string; date?: string }>
  diff?: { files: number; additions?: number; deletions?: number }
  error?: string
}

/** Optional tasks evidence. */
export interface TaskEvidence {
  available: boolean
  projectId?: string
  total: number
  open: number
  error?: string
}

/** One evidence-chip identity. */
export interface ReviewEvidenceSession {
  id: string
  title: string
  agent: AgentKind
}

/** The deterministic half of a review. */
export interface DeterministicReview {
  metrics: Record<string, number>
  timeline: TimelineEntry[]
  signals: ReviewSignal[]
  sources: ReviewSourceCount[]
  weeks: ReviewWeek[]
  evidenceSessions: ReviewEvidenceSession[]
  git?: GitEvidence
  tasks?: TaskEvidence
}

/** One AI conclusion. */
export interface EvidenceConclusion {
  text: string
  evidence: string[]
}

/** One theme. */
export interface ThemeConclusion extends EvidenceConclusion {
  title: string
}

/** One decision. */
export interface DecisionConclusion extends EvidenceConclusion {
  kind: 'explicit' | 'inferred'
}

/** The AI narrative. */
export interface ReviewNarrative {
  summary?: EvidenceConclusion
  themes: ThemeConclusion[]
  decisions: DecisionConclusion[]
  deadEnds: EvidenceConclusion[]
  friction: EvidenceConclusion[]
  openLoops: EvidenceConclusion[]
}

/** Why the AI half did or did not run. */
export type ReviewAiStatus = 'generated' | 'disabled' | 'not-requested' | 'unavailable' | 'failed'

/** The AI record kept beside the report. */
export interface ReviewAi {
  status: ReviewAiStatus
  analyzedSessions?: number
  totalSessions?: number
  message?: string
}

/** One review snapshot. */
export interface Review {
  id: string
  workspaceId: string
  workspaceName: string
  root: string
  range: ReviewRange
  from: string
  to: string
  generatedAt: number
  model?: string
  sessionIds: string[]
  inputHash: string
  deterministic: DeterministicReview
  narrative?: ReviewNarrative
  ai: ReviewAi
}

/** One test result in the evidence drawer. */
export interface EvidenceTest {
  command: string
  status: 'passed' | 'failed' | 'unknown'
}

/** One key turn in the evidence drawer. */
export interface EvidenceTurn {
  role: 'user' | 'assistant'
  text: string
}

/** The session summary the evidence drawer renders. */
export interface EvidenceSession {
  id: string
  workspaceId?: string
  agent: AgentKind
  nativeId: string
  sourcePath: string
  cwd: string
  startedAt: number
  endedAt?: number
  title: string
  model?: string
  parentSessionId?: string
  turnCount: number
  userTurns: number
  toolCalls: number
  tools: string[]
  filesTouched: string[]
  commands: string[]
  tests: EvidenceTest[]
  flags: { interrupted?: boolean; compacted?: boolean; hasSubagents?: boolean }
  excerpt: string
  keyTurns: EvidenceTurn[]
  importedAt: number
}

/** One session's evidence drawer payload. */
export interface SessionEvidenceView {
  session: EvidenceSession
  sourceAvailable: boolean
  outcome: ReviewOutcome
  subagents: Array<{ id: string; title: string; name?: string; agent: AgentKind; startedAt: number }>
}

/** Narrow one successful call outcome. */
export function valueOf<T>(outcome: CallOutcomeLike): T | undefined {
  return outcome.status === 'success' ? outcome.result as T : undefined
}

/** The failure message of one call outcome, if it failed. */
export function messageOf(outcome: CallOutcomeLike): string | undefined {
  if (outcome.status === 'success' || outcome.status === 'cancelled') return undefined
  return outcome.error?.message
}

/** The display label of one agent (a source name, never a ranking). */
export function agentLabel(agent: AgentKind): string {
  if (agent === 'dsh') return 'DSH'
  if (agent === 'claude-code') return 'Claude Code'
  return 'Codex'
}

/** The localization key of one range. */
export function rangeLabelKey(range: ReviewRange): string {
  return `view.range.${range}`
}

/** The localization key of one outcome. */
export function outcomeLabelKey(outcome: ReviewOutcome): string {
  return `view.outcome.${outcome}`
}

/** The localization key of one AI status. */
export function aiStatusLabelKey(status: ReviewAiStatus): string {
  return `view.ai.${status}`
}

/** The localization key of one deterministic signal kind. */
export function signalLabelKey(kind: string): string {
  return kind === 'interruptions' || kind === 'failed-tests' || kind === 'repeated-file' || kind === 'mixed-sources'
    ? `view.signal.${kind}`
    : 'view.signal.other'
}

/** Format one ISO date as MM/DD. */
export function shortDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return iso
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`
}

/** Format one ISO range for the history rail. */
export function rangeText(from: string, to: string, t: Translate): string {
  if (from === '') return to === '' ? t('view.range.all') : `${t('view.range.all')} · ${shortDate(to)}`
  return `${shortDate(from)} – ${shortDate(to)}`
}

/** Format one timestamp as a deterministic local date/time. */
export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Format a session duration in minutes. */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${String(rest)}m`
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`
}

/** The rounded share of one count (0 when the total is 0). */
export function percent(count: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((count / total) * 100)
}

/** The UTC Monday of one ISO date. */
export function weekStart(iso: string): string {
  const parsed = Date.parse(`${iso}T00:00:00.000Z`)
  if (Number.isNaN(parsed)) return iso
  const date = new Date(parsed)
  const day = date.getUTCDay()
  const offset = day === 0 ? 6 : day - 1
  return new Date(parsed - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** Format one week label as MM/DD – MM/DD. */
export function weekRangeText(label: string): string {
  const start = Date.parse(`${label}T00:00:00.000Z`)
  if (Number.isNaN(start)) return label
  const end = new Date(start + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return `${shortDate(label)} – ${shortDate(end)}`
}

/** Group the timeline by its UTC week, preserving the host's newest-first order. */
export function groupTimeline(entries: readonly TimelineEntry[]): Array<{ label: string; entries: TimelineEntry[] }> {
  const groups = new Map<string, TimelineEntry[]>()
  for (const entry of entries) {
    const label = weekStart(entry.date)
    const list = groups.get(label)
    if (list === undefined) groups.set(label, [entry])
    else list.push(entry)
  }
  return [...groups.entries()].map(([label, list]) => ({ label, entries: list }))
}

/** One metric row the page renders. */
export interface MetricEntry {
  key: string
  labelKey: string
  noteKey: string
  value: number
}

/** The six report metrics, always in the same order. */
export function metricEntries(review: Review): MetricEntry[] {
  const metrics = review.deterministic.metrics
  return [
    { key: 'sessions', labelKey: 'view.metric.sessions', noteKey: 'view.metric.sessionsNote', value: metrics.sessions ?? 0 },
    { key: 'activeDays', labelKey: 'view.metric.activeDays', noteKey: 'view.metric.activeDaysNote', value: metrics.activeDays ?? 0 },
    { key: 'userTurns', labelKey: 'view.metric.userTurns', noteKey: 'view.metric.userTurnsNote', value: metrics.userTurns ?? 0 },
    { key: 'files', labelKey: 'view.metric.files', noteKey: 'view.metric.filesNote', value: metrics.files ?? 0 },
    { key: 'gitCommits', labelKey: 'view.metric.gitCommits', noteKey: 'view.metric.gitCommitsNote', value: metrics.gitCommits ?? 0 },
    { key: 'tasks', labelKey: 'view.metric.tasks', noteKey: 'view.metric.tasksNote', value: metrics.tasks ?? 0 },
  ]
}

/** How many sessions each source contributed. */
export function sourceTotal(review: Review): number {
  return review.deterministic.sources.reduce((total, source) => total + source.count, 0)
}

/** The title behind one evidence id, falling back to the short id. */
export function evidenceTitle(review: Review, id: string): string {
  return review.deterministic.evidenceSessions.find(session => session.id === id)?.title ?? shortId(id)
}

/** A short, safe session id for an evidence chip. */
export function shortId(id: string): string {
  if (id.length <= 10) return id
  return `${id.slice(0, 8)}…`
}

/** The number of evidence rows one timeline entry exposes (the summary's turns/actions). */
export function evidenceCount(entry: TimelineEntry): number {
  return entry.turnCount > 0 ? entry.turnCount : 1
}
