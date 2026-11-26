/**
 * Deterministic report construction and the optional, evidence-checked AI
 * narrative.
 *
 * The deterministic half is always built first: metrics, weekly rhythm, source
 * distribution, a parent-session timeline and fact signals. The AI half receives
 * only bounded session digests (never a transcript or raw tool output), must
 * return JSON where every conclusion cites a selected session id, and any
 * conclusion without a valid id is dropped. A failed AI call leaves the
 * deterministic snapshot intact and records why it did not run.
 * @module @matrix1001/dsh-application-harness-workspace-review/generation
 */

import { createHash } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { CapabilityAccess } from '@matrix1001/dsh-application-harness-runtime'
import type { ModelPort } from '@matrix1001/dsh-application-harness-host-bridge'
import type { PeerCall } from './evidence.ts'
import { readOptionalEvidence } from './evidence.ts'
import type {
  AgentKind, DeterministicReview, EvidenceConclusion, Review, ReviewAi, ReviewNarrative,
  ReviewPreview, ReviewRange, ReviewSettings, ReviewSignal, ReviewSourceCount, ReviewWeek, Session,
  ThemeConclusion, TimelineEntry, Workspace,
} from './types.ts'
import { AGENTS, agentLabel, outcomeOf } from './types.ts'

/** The default AI digest budget in characters. */
export const DEFAULT_DIGEST_CHARS = 24_000

/** How many sessions one digest may offer at most. */
export const MAX_DIGEST_SESSIONS = 60

/** One resolved review range. */
export interface ResolvedRange {
  range: ReviewRange
  /** Inclusive start date, or '' for "all". */
  from: string
  /** Inclusive end date, YYYY-MM-DD. */
  to: string
  fromMs: number
  toMs: number
}

/** A range request, before validation. */
export interface RangeRequest {
  range: ReviewRange
  from?: string
  to?: string
}

/** The bounded digest handed to the model. */
export interface SessionDigest {
  text: string
  sessionIds: string[]
}

const DAY = 24 * 60 * 60 * 1000

/** The UTC calendar day of one timestamp, YYYY-MM-DD. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function startOfDay(ms: number): number {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function endOfDay(ms: number): number {
  return startOfDay(ms) + DAY - 1
}

function mondayOf(ms: number): number {
  const date = new Date(startOfDay(ms))
  const day = date.getUTCDay()
  const offset = day === 0 ? 6 : day - 1
  return date.getTime() - offset * DAY
}

function dateFromDay(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new AppError('invalid-args', `${label} must be YYYY-MM-DD`)
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (Number.isNaN(ms)) throw new AppError('invalid-args', `${label} is not a real date`)
  return ms
}

/**
 * Resolve one range request against a clock. "最近 7 天" and "最近 30 天"
 * include today; "本周" begins on Monday; "本月" begins on the first day of the
 * current UTC month. Custom dates are inclusive.
 * @param request - the range key and optional custom dates.
 * @param now - the reference timestamp.
 * @returns the resolved range (dates and filtering bounds).
 */
export function resolveRange(request: RangeRequest, now: number): ResolvedRange {
  const today = startOfDay(now)
  if (request.range === 'custom') {
    const fromDay = request.from ?? ''
    const toDay = request.to ?? ''
    const fromMs = dateFromDay(fromDay, 'from')
    const toMs = endOfDay(dateFromDay(toDay, 'to'))
    if (fromMs > toMs) throw new AppError('invalid-args', 'from must not be after to')
    return { range: 'custom', from: fromDay, to: toDay, fromMs, toMs }
  }
  if (request.range === 'all') return { range: 'all', from: '', to: dayOf(today), fromMs: 0, toMs: endOfDay(today) }
  if (request.range === 'week') {
    const fromMs = mondayOf(today)
    return { range: 'week', from: dayOf(fromMs), to: dayOf(today), fromMs, toMs: endOfDay(today) }
  }
  if (request.range === 'last7') {
    const fromMs = today - 6 * DAY
    return { range: 'last7', from: dayOf(fromMs), to: dayOf(today), fromMs, toMs: endOfDay(today) }
  }
  if (request.range === 'month') {
    const date = new Date(today)
    const fromMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
    return { range: 'month', from: dayOf(fromMs), to: dayOf(today), fromMs, toMs: endOfDay(today) }
  }
  const fromMs = today - 29 * DAY
  return { range: 'last30', from: dayOf(fromMs), to: dayOf(today), fromMs, toMs: endOfDay(today) }
}

/**
 * Select the sessions of one workspace inside one resolved range.
 * @param sessions - all known sessions.
 * @param workspaceId - the workspace.
 * @param range - the resolved range.
 * @returns matching sessions, newest first.
 */
export function selectSessions(sessions: readonly Session[], workspaceId: string, range: ResolvedRange): Session[] {
  return sessions
    .filter(session => session.workspaceId === workspaceId && session.startedAt >= range.fromMs && session.startedAt <= range.toMs)
    .sort((a, b) => b.startedAt - a.startedAt)
}

function durationMinutes(session: Session): number {
  if (session.endedAt === undefined || session.startedAt <= 0) return 0
  return Math.max(0, Math.round((session.endedAt - session.startedAt) / 60_000))
}

function weeksOf(sessions: readonly Session[]): ReviewWeek[] {
  const map = new Map<string, ReviewWeek>()
  for (const session of sessions) {
    if (session.startedAt <= 0) continue
    const monday = mondayOf(session.startedAt)
    const label = dayOf(monday)
    let week = map.get(label)
    if (week === undefined) {
      week = { label, from: label, to: dayOf(monday + 6 * DAY), agents: {}, total: 0 }
      map.set(label, week)
    }
    week.agents[session.agent] = (week.agents[session.agent] ?? 0) + 1
    week.total += 1
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function sourceCounts(sessions: readonly Session[]): ReviewSourceCount[] {
  const counts = new Map<AgentKind, number>()
  for (const session of sessions) counts.set(session.agent, (counts.get(session.agent) ?? 0) + 1)
  return AGENTS.flatMap(agent => {
    const count = counts.get(agent)
    return count === undefined ? [] : [{ agent, count }]
  })
}

function timelineOf(sessions: readonly Session[]): TimelineEntry[] {
  const ids = new Set(sessions.map(session => session.id))
  return sessions
    .filter(session => session.parentSessionId === undefined || !ids.has(session.parentSessionId))
    .map(session => ({
      sessionId: session.id,
      date: session.startedAt > 0 ? dayOf(session.startedAt) : '',
      title: session.title,
      agent: session.agent,
      outcome: outcomeOf(session),
      summary: session.excerpt,
      durationMinutes: durationMinutes(session),
      turnCount: session.turnCount,
    }))
}

function signalsOf(sessions: readonly Session[], sources: readonly ReviewSourceCount[]): ReviewSignal[] {
  const signals: ReviewSignal[] = []
  const interrupted = sessions.filter(session => session.flags.interrupted === true)
  if (interrupted.length > 0) {
    signals.push({ kind: 'interruptions', text: `${String(interrupted.length)} session(s) were interrupted`, sessionIds: interrupted.map(session => session.id).slice(0, 20) })
  }
  const failedTests = sessions.flatMap(session => session.tests.filter(test => test.status === 'failed').map(() => session))
  if (failedTests.length > 0) {
    signals.push({ kind: 'failed-tests', text: `${String(failedTests.length)} test command(s) failed`, sessionIds: failedTests.map(session => session.id).slice(0, 20) })
  }
  const fileCounts = new Map<string, number>()
  for (const session of sessions) for (const file of session.filesTouched) fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1)
  /* v8 ignore next -- a repeated file is optional evidence */
  const repeated = [...fileCounts.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1])[0]
  if (repeated !== undefined) {
    const owners = sessions.filter(session => session.filesTouched.includes(repeated[0])).map(session => session.id).slice(0, 20)
    signals.push({ kind: 'repeated-file', text: `${repeated[0]} was touched in ${String(repeated[1])} sessions`, sessionIds: owners })
  }
  if (sources.length > 1) {
    signals.push({ kind: 'mixed-sources', text: `sessions came from ${String(sources.length)} agent sources`, sessionIds: [] })
  }
  return signals
}

/**
 * Build the deterministic half of one review.
 * @param input - selected sessions and optional evidence.
 * @returns the report that is always produced, with or without AI.
 */
export function buildDeterministic(input: {
  sessions: readonly Session[]
  evidence: Awaited<ReturnType<typeof readOptionalEvidence>>
}): DeterministicReview {
  const { sessions, evidence } = input
  const sources = sourceCounts(sessions)
  const activeDays = new Set(sessions.filter(session => session.startedAt > 0).map(session => dayOf(session.startedAt)))
  const files = new Set<string>()
  let userTurns = 0
  let toolCalls = 0
  let testsPassed = 0
  let testsFailed = 0
  for (const session of sessions) {
    for (const file of session.filesTouched) files.add(file)
    userTurns += session.userTurns
    toolCalls += session.toolCalls
    for (const test of session.tests) {
      if (test.status === 'passed') testsPassed += 1
      if (test.status === 'failed') testsFailed += 1
    }
  }
  const deterministic: DeterministicReview = {
    metrics: {
      sessions: sessions.length,
      activeDays: activeDays.size,
      userTurns,
      files: files.size,
      gitCommits: evidence.git.commits,
      tasks: evidence.tasks?.total ?? 0,
      toolCalls,
      testsPassed,
      testsFailed,
      interrupted: sessions.filter(session => session.flags.interrupted === true).length,
    },
    timeline: timelineOf(sessions),
    signals: signalsOf(sessions, sources),
    sources,
    weeks: weeksOf(sessions),
    evidenceSessions: sessions.map(session => ({ id: session.id, title: session.title, agent: session.agent })).slice(0, 300),
    git: evidence.git,
  }
  if (evidence.tasks !== undefined) deterministic.tasks = evidence.tasks
  return deterministic
}

/**
 * Build the bounded session digest sent to the model.
 * @param sessions - selected sessions.
 * @param maxChars - maximum digest JSON size.
 * @returns the digest text and the ids it contains.
 */
export function buildDigest(sessions: readonly Session[], maxChars = DEFAULT_DIGEST_CHARS): SessionDigest {
  const selected: Array<Record<string, unknown>> = []
  const ids: string[] = []
  for (const session of [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_DIGEST_SESSIONS)) {
    const item: Record<string, unknown> = {
      id: session.id,
      title: session.title,
      agent: agentLabel(session.agent),
      startedAt: session.startedAt,
      excerpt: session.excerpt,
      keyTurns: session.keyTurns,
      files: session.filesTouched.slice(0, 50),
      commands: session.commands.slice(0, 20),
      tests: session.tests,
      flags: session.flags,
      userTurns: session.userTurns,
      toolCalls: session.toolCalls,
    }
    const candidate = JSON.stringify({ sessions: [...selected, item] })
    if (candidate.length > maxChars && (selected.length > 0 || maxChars <= 0)) break
    selected.push(item)
    ids.push(session.id)
  }
  return {
    text: JSON.stringify({ sessions: selected }),
    sessionIds: ids,
  }
}

/** The system prompt of the AI narrative. */
export const NARRATIVE_SYSTEM_PROMPT = [
  'You summarize coding-agent session evidence for one local workspace.',
  'Return ONLY one JSON object, with no markdown or prose.',
  'Every conclusion MUST include an "evidence" array of session ids copied from the supplied digest.',
  'Never invent a session id; a conclusion without a valid id will be discarded.',
  'The summary object is {"text": string, "evidence": string[]}.',
  'Themes are {"title": string, "text": string, "evidence": string[]}.',
  'Decisions are {"text": string, "kind": "explicit" | "inferred", "evidence": string[]}.',
  'Dead ends, friction and open loops are {"text": string, "evidence": string[]}.',
  'Do not compare or rank agents, estimate code quality, count lines, or estimate time saved.',
  'Agent names are metadata, never a performance claim.',
].join('\n')

/**
 * Build the user prompt from the digest.
 * @param digest - the bounded digest.
 * @param rangeLabel - the human range key (for context only).
 * @returns the prompt text.
 */
export function buildPrompt(digest: SessionDigest, rangeLabel: string): string {
  return [
    `Range: ${rangeLabel}`,
    'Sessions:',
    digest.text,
    'Return JSON with keys: summary, themes, decisions, deadEnds, friction, openLoops.',
    'Include only what the supplied evidence supports. Prefer fewer, well-evidenced conclusions over many weak ones.',
  ].join('\n')
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed)
  return fenced?.[1] ?? trimmed
}

/**
 * Parse one JSON narrative answer.
 * @param text - the model's text.
 * @returns the parsed value (validation happens separately).
 * @throws when the answer is not JSON or has no object root.
 */
export function parseNarrativeJson(text: string): unknown {
  const parsed = JSON.parse(stripFences(text)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('the narrative must be a JSON object')
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function evidenceOf(value: unknown, validIds: ReadonlySet<string>): string[] {
  /* v8 ignore next -- evidence is either one string or an array by contract */
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const evidence: string[] = []
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue
    const match = /^(s_[A-Za-z0-9_-]+)/u.exec(candidate.trim())
    if (match === null || !validIds.has(match[1]!)) continue
    if (!evidence.includes(match[1]!)) evidence.push(match[1]!)
  }
  return evidence
}

function conclusionOf(value: unknown, validIds: ReadonlySet<string>): EvidenceConclusion | undefined {
  if (!isRecord(value)) return undefined
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  const evidence = evidenceOf(value.evidence, validIds)
  if (text === '' || evidence.length === 0) return undefined
  return { text, evidence }
}

function themesOf(value: unknown, validIds: ReadonlySet<string>): ThemeConclusion[] {
  if (!Array.isArray(value)) return []
  const themes: ThemeConclusion[] = []
  for (const candidate of value) {
    const conclusion = conclusionOf(candidate, validIds)
    if (conclusion === undefined || !isRecord(candidate)) continue
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    if (title === '') continue
    themes.push({ title, ...conclusion })
  }
  return themes
}

function decisionsOf(value: unknown, validIds: ReadonlySet<string>): ReviewNarrative['decisions'] {
  if (!Array.isArray(value)) return []
  const decisions: ReviewNarrative['decisions'] = []
  for (const candidate of value) {
    const conclusion = conclusionOf(candidate, validIds)
    if (conclusion === undefined || !isRecord(candidate)) continue
    const kind = candidate.kind === 'explicit' ? 'explicit' : 'inferred'
    decisions.push({ ...conclusion, kind })
  }
  return decisions
}

function conclusionsOf(value: unknown, validIds: ReadonlySet<string>): EvidenceConclusion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(candidate => {
    const conclusion = conclusionOf(candidate, validIds)
    return conclusion === undefined ? [] : [conclusion]
  })
}

/**
 * Validate the model answer against the ids actually sent. Conclusions with no
 * valid evidence are dropped, not repaired.
 * @param value - the parsed JSON value.
 * @param validIds - the session ids present in the digest.
 * @returns the checked narrative, or undefined when nothing valid remains.
 */
export function validateNarrative(value: unknown, validIds: ReadonlySet<string>): ReviewNarrative | undefined {
  if (!isRecord(value)) return undefined
  const summary = conclusionOf(value.summary, validIds)
  const narrative: ReviewNarrative = {
    ...(summary === undefined ? {} : { summary }),
    themes: themesOf(value.themes, validIds),
    decisions: decisionsOf(value.decisions, validIds),
    deadEnds: conclusionsOf(value.deadEnds, validIds),
    friction: conclusionsOf(value.friction, validIds),
    openLoops: conclusionsOf(value.openLoops, validIds),
  }
  if (narrative.summary === undefined && narrative.themes.length === 0 && narrative.decisions.length === 0
    && narrative.deadEnds.length === 0 && narrative.friction.length === 0 && narrative.openLoops.length === 0) {
    return undefined
  }
  return narrative
}

/** The inputs of one generation. */
export interface GenerateInput {
  workspace: Workspace
  sessions: readonly Session[]
  range: RangeRequest
  useAi: boolean
  settings: ReviewSettings
  capabilities: CapabilityAccess
  call?: PeerCall
  signal?: AbortSignal
}

/** The generator's dependencies. */
export interface ReviewGeneratorOptions {
  now?: () => number
  newId?: () => string
  model?: ModelPort
  maxDigestChars?: number
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
}

function inputHashOf(workspace: Workspace, range: ResolvedRange, sessions: readonly Session[]): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: workspace.id,
    range: range.range,
    from: range.from,
    to: range.to,
    sessions: sessions.map(session => [session.id, session.sourceHash]),
  })).digest('hex')
}

/** The review generator (deterministic always, AI optionally). */
export class ReviewGenerator {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly maxDigestChars: number

  constructor(private readonly options: ReviewGeneratorOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID())
    this.maxDigestChars = options.maxDigestChars ?? DEFAULT_DIGEST_CHARS
  }

  /**
   * Build one immutable snapshot. The AI half is attempted only when enabled,
   * requested and available; its failure is recorded on the snapshot.
   * @param input - workspace, selected data, range, settings and context.
   * @returns the new snapshot (not yet stored; the service stores it atomically).
   */
  async generate(input: GenerateInput): Promise<Review> {
    const now = this.now()
    const range = resolveRange(input.range, now)
    abortIfNeeded(input.signal)
    const sessions = selectSessions(input.sessions, input.workspace.id, range)
    if (sessions.length === 0) throw new AppError('no-sessions', 'workspace-review: the selected range contains no sessions')
    const evidence = await readOptionalEvidence(input.call, input.workspace, range.from, range.to, input.signal)
    abortIfNeeded(input.signal)
    const deterministic = buildDeterministic({ sessions, evidence })
    let ai: ReviewAi = { status: 'not-requested', totalSessions: sessions.length }
    let narrative: ReviewNarrative | undefined
    let modelName: string | undefined
    if (!input.settings.aiEnabled) {
      ai = { status: 'disabled', totalSessions: sessions.length }
    } else if (input.useAi) {
      if (this.options.model === undefined) {
        ai = { status: 'unavailable', totalSessions: sessions.length, message: 'this composition provides no platform model' }
      } else {
        const digest = buildDigest(sessions, this.maxDigestChars)
        if (digest.sessionIds.length === 0) {
          ai = { status: 'failed', totalSessions: sessions.length, analyzedSessions: 0, message: 'the session digest is empty' }
        } else {
          try {
            const result = await this.options.model.ask({
              prompt: buildPrompt(digest, range.range),
              system: NARRATIVE_SYSTEM_PROMPT,
              capabilities: input.capabilities,
              maxOutputTokens: 2_000,
              temperature: 0.2,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              parse: parseNarrativeJson,
            })
            abortIfNeeded(input.signal)
            narrative = validateNarrative(result.structured, new Set(digest.sessionIds))
            if (narrative === undefined) {
              ai = { status: 'failed', totalSessions: sessions.length, analyzedSessions: digest.sessionIds.length, message: 'the model returned no evidence-backed conclusions' }
            } else {
              ai = { status: 'generated', totalSessions: sessions.length, analyzedSessions: digest.sessionIds.length }
              if (result.model !== undefined) modelName = `${result.model.provider}/${result.model.model}`
            }
          } catch (error) {
            if (input.signal?.aborted === true) throw error
            const name = (error as Error)?.name
            if (name === 'ModelUnavailableError') {
              ai = { status: 'unavailable', totalSessions: sessions.length, analyzedSessions: digest.sessionIds.length, message: String((error as Error).message) }
            } else {
              ai = { status: 'failed', totalSessions: sessions.length, analyzedSessions: digest.sessionIds.length, message: String((error as Error)?.message ?? error) }
            }
          }
        }
      }
    }
    const review: Review = {
      id: `r_${this.newId()}`,
      workspaceId: input.workspace.id,
      workspaceName: input.workspace.name,
      root: input.workspace.root,
      range: range.range,
      from: range.from,
      to: range.to,
      generatedAt: now,
      sessionIds: sessions.map(session => session.id),
      inputHash: inputHashOf(input.workspace, range, sessions),
      deterministic,
      ai,
      ...(narrative === undefined ? {} : { narrative }),
      ...(modelName === undefined ? {} : { model: modelName }),
    }
    abortIfNeeded(input.signal)
    return review
  }

  /**
   * Preview the counts the generate modal shows before the user confirms.
   * @param workspace - the workspace.
   * @param sessions - the workspace's stored sessions.
   * @param request - the requested range.
   * @param settings - current settings (AI on/off).
   * @returns the preview.
   */
  preview(workspace: Workspace, sessions: readonly Session[], request: RangeRequest, settings: ReviewSettings): ReviewPreview {
    const range = resolveRange(request, this.now())
    const selected = selectSessions(sessions, workspace.id, range)
    const digest = buildDigest(selected, this.maxDigestChars)
    return {
      workspaceId: workspace.id,
      range: range.range,
      from: range.from,
      to: range.to,
      sessionCount: selected.length,
      aiSessions: digest.sessionIds.length,
      aiEnabled: settings.aiEnabled,
    }
  }
}
