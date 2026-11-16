/**
 * The workspace-review application's durable and wire vocabulary.
 *
 * The unit is one local working directory; the subject is the coding-agent
 * sessions that ran with that directory as their cwd. Only normalized summaries
 * are stored — never a full transcript or tool output. Git and task data are
 * optional evidence, and agent names are metadata, never a ranking.
 * @module @matrix1001/dsh-application-harness-workspace-review/types
 */

/** The local agents this build can normalize. */
export type AgentKind = 'dsh' | 'claude-code' | 'codex'

/** One local workspace (a directory, with or without Git). */
export interface Workspace {
  id: string
  name: string
  /** Normalized real path of the workspace root. */
  root: string
  /** Additional path prefixes that belong to this workspace. */
  aliases: string[]
  /** Optional tasks project used as read-only evidence. */
  taskProjectId?: string
  createdAt: number
  lastSyncAt?: number
  lastReviewAt?: number
}

/** One workspace as the list operation returns it. */
export interface WorkspaceView extends Workspace {
  sessionCount: number
  reviewCount: number
}

/** How a session obtained its workspace. */
export type WorkspaceAssignment = 'cwd' | 'parent' | 'manual'

/** One searchable test result lifted from a session's tool calls. */
export interface SessionTest {
  command: string
  status: 'passed' | 'failed' | 'unknown'
}

/** One short user/assistant turn kept as evidence. */
export interface KeyTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Normalized session signals; no transcript is kept. */
export interface SessionFlags {
  interrupted?: boolean
  compacted?: boolean
  hasSubagents?: boolean
}

/**
 * One normalized agent session summary. This is the whole durable session
 * record: bounded text excerpts and references, never raw tool output.
 */
export interface Session {
  /** Our stable id (`s_…`). */
  id: string
  workspaceId?: string
  assignedBy?: WorkspaceAssignment
  agent: AgentKind
  /** The agent's own session id, used to resolve parents and de-duplicate. */
  nativeId: string
  /** The configured source this file came from. */
  sourceId: AgentKind
  sourcePath: string
  sourceHash: string
  cwd: string
  startedAt: number
  endedAt?: number
  title: string
  model?: string
  /** Normalized id of the parent session, when this one is a subagent. */
  parentSessionId?: string
  /** The agent's own parent id, kept so a later sync can resolve the parent. */
  parentNativeId?: string
  /** Direct child native id → the named subagent's name, from the parent's catalog events. */
  subagentNames?: Record<string, string>
  turnCount: number
  userTurns: number
  toolCalls: number
  tools: string[]
  filesTouched: string[]
  commands: string[]
  tests: SessionTest[]
  flags: SessionFlags
  excerpt: string
  keyTurns: KeyTurn[]
  importedAt: number
}

/** Optional Git evidence read through `git-browser`. */
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

/** Optional tasks evidence read through `tasks`. */
export interface TaskEvidence {
  available: boolean
  projectId?: string
  total: number
  open: number
  error?: string
}

/** One reviewed-session identity (enough for an evidence chip, no content). */
export interface ReviewEvidenceSession {
  id: string
  title: string
  agent: AgentKind
}

/** One session on the deterministic timeline. Children are listed as evidence, not timeline rows. */
export interface TimelineEntry {
  sessionId: string
  /** ISO date (YYYY-MM-DD) of the session start. */
  date: string
  title: string
  agent: AgentKind
  outcome: ReviewOutcome
  summary: string
  durationMinutes: number
  turnCount: number
}

/** The deterministic outcome vocabulary: never "success" or "failure". */
export type ReviewOutcome = 'has-result' | 'unconfirmed' | 'interrupted'

/** One deterministic fact. */
export interface ReviewSignal {
  kind: string
  text: string
  sessionIds: string[]
}

/** Sessions per agent: metadata only, never a ranking. */
export interface ReviewSourceCount {
  agent: AgentKind
  count: number
}

/** One week of session rhythm. */
export interface ReviewWeek {
  /** Monday of the week, YYYY-MM-DD. */
  label: string
  from: string
  to: string
  agents: Partial<Record<AgentKind, number>>
  total: number
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

/** One AI conclusion with evidence ids. */
export interface EvidenceConclusion {
  text: string
  evidence: string[]
}

/** One theme conclusion. */
export interface ThemeConclusion extends EvidenceConclusion {
  title: string
}

/** One decision, marked explicit or inferred. */
export interface DecisionConclusion extends EvidenceConclusion {
  kind: 'explicit' | 'inferred'
}

/** The AI narrative; every member is evidence-checked before it is stored. */
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

/** The AI generation record kept beside the deterministic report. */
export interface ReviewAi {
  status: ReviewAiStatus
  /** Number of session digests actually offered to the model. */
  analyzedSessions?: number
  /** Total sessions selected by the range. */
  totalSessions?: number
  message?: string
}

/** One immutable review snapshot. */
export interface Review {
  id: string
  workspaceId: string
  workspaceName: string
  root: string
  range: ReviewRange
  /** Inclusive start date, YYYY-MM-DD (0 for "all"). */
  from: string
  /** Inclusive end date, YYYY-MM-DD. */
  to: string
  generatedAt: number
  model?: string
  sessionIds: string[]
  inputHash: string
  deterministic: DeterministicReview
  narrative?: ReviewNarrative
  ai: ReviewAi
}

/** The range choices the page and the host share. */
export type ReviewRange = 'week' | 'last7' | 'month' | 'last30' | 'all' | 'custom'

/** A review summary for the history rail. */
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

/** The configured session-source roots. */
export interface SourceRoots {
  dsh: string
  claudeCode: string
  codex: string
}

/** The application settings. */
export interface ReviewSettings {
  sourceRoots: SourceRoots
  /** Redact likely credentials from stored excerpts, commands and titles. */
  redactSecrets: boolean
  /** How many review snapshots to keep per workspace (1..20). */
  reviewRetention: number
  /** Whether a requested AI narrative may call the platform model. */
  aiEnabled: boolean
}

/** One source's discovery state. */
export interface SourceInfo {
  agent: AgentKind
  label: string
  path: string
  found: boolean
  fileCount: number
  /** Discovery stopped at a bound before visiting every candidate. */
  truncated?: boolean
  lastSyncAt?: number
  /** Last discovery/parse error for this source, bounded to one line. */
  lastError?: string
}

/** One file parsed or skipped by sync. */
export interface SyncSourceError {
  agent: AgentKind
  path: string
  message: string
}

/** The result of one workspace sync. */
export interface SyncResult {
  taskId: string
  workspaceId: string
  scanned: number
  added: number
  updated: number
  unchanged: number
  skipped: number
  unmatched: number
  newSinceReview: number
  sources: SourceInfo[]
  errors: SyncSourceError[]
  /** Sources whose discovery hit a bound in this run. */
  truncatedSources?: AgentKind[]
  /** More unmatched sessions exist than the list operation returns. */
  unmatchedTruncated?: boolean
}

/** What the generate modal needs before it confirms. */
export interface ReviewPreview {
  workspaceId: string
  range: ReviewRange
  from: string
  to: string
  sessionCount: number
  /** Sessions whose digest fits in the bounded AI input. */
  aiSessions: number
  aiEnabled: boolean
}

/** One session's evidence drawer payload; never a full transcript. */
export interface SessionEvidenceView {
  session: Session
  sourceAvailable: boolean
  outcome: ReviewOutcome
  subagents: Array<{ id: string; title: string; name?: string; agent: AgentKind; startedAt: number }>
}

export const AGENTS: readonly AgentKind[] = ['dsh', 'claude-code', 'codex']

/** The labels shown for an agent source (never a performance claim). */
export function agentLabel(agent: AgentKind): string {
  if (agent === 'dsh') return 'DSH'
  if (agent === 'claude-code') return 'Claude Code'
  return 'Codex'
}

/** The deterministic outcome of one session summary. */
export function outcomeOf(session: Pick<Session, 'flags' | 'excerpt'>): ReviewOutcome {
  if (session.flags.interrupted === true) return 'interrupted'
  if (session.excerpt !== '') return 'has-result'
  return 'unconfirmed'
}
