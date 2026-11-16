import { describe, expect, it } from 'vitest'
import type { ModelAskRequest, ModelPort } from '@matrix1001/dsh-application-harness-host-bridge'
import { ModelUnavailableError } from '@matrix1001/dsh-application-harness-host-bridge'
import {
  DEFAULT_DIGEST_CHARS, ReviewGenerator, buildDeterministic, buildDigest, buildPrompt, parseNarrativeJson,
  resolveRange, selectSessions, validateNarrative,
} from '../src/generation.ts'
import { defaultReviewSettings } from '../src/settings.ts'
import type { ReviewNarrative, Session } from '../src/types.ts'
import { NOW, PASS_CAPABILITIES, session, workspace } from './helpers.ts'

const DAY = 24 * 60 * 60 * 1000
const ws = workspace()

function sampleSessions(): Session[] {
  return [
    session({
      id: 's_parent', workspaceId: ws.id, nativeId: 'parent', startedAt: NOW - DAY, endedAt: NOW - DAY + 2 * 60 * 60 * 1000,
      userTurns: 5, toolCalls: 3, filesTouched: ['src/shared.ts', 'src/a.ts'],
    }),
    session({
      id: 's_child', workspaceId: ws.id, nativeId: 'child', parentSessionId: 's_parent', parentNativeId: 'parent',
      startedAt: NOW - 2 * 60 * 60 * 1000, endedAt: NOW - 60 * 60 * 1000, userTurns: 1, toolCalls: 1,
      filesTouched: ['src/shared.ts'], agent: 'claude-code', tests: [{ command: 'pytest', status: 'failed' }],
      flags: { interrupted: true },
    }),
    session({
      id: 's_old', workspaceId: ws.id, nativeId: 'old', startedAt: Date.UTC(2026, 9, 20, 8), endedAt: Date.UTC(2026, 9, 20, 9),
      userTurns: 2, toolCalls: 2, filesTouched: ['src/shared.ts'], agent: 'codex',
    }),
  ].map((entry, index) => ({ ...entry, sourceHash: `hash-${String(index)}` }))
}

describe('review ranges', () => {
  it('resolves every preset against the same clock', () => {
    expect(resolveRange({ range: 'week' }, NOW)).toMatchObject({ from: '2026-11-02', to: '2026-11-05', fromMs: Date.UTC(2026, 10, 2) })
    expect(resolveRange({ range: 'week' }, Date.UTC(2026, 10, 8, 12))).toMatchObject({ from: '2026-11-02', fromMs: Date.UTC(2026, 10, 2) })
    expect(resolveRange({ range: 'last7' }, NOW)).toMatchObject({ from: '2026-10-30', to: '2026-11-05' })
    expect(resolveRange({ range: 'month' }, NOW)).toMatchObject({ from: '2026-11-01', to: '2026-11-05' })
    expect(resolveRange({ range: 'last30' }, NOW)).toMatchObject({ from: '2026-10-07', to: '2026-11-05' })
    expect(resolveRange({ range: 'all' }, NOW)).toMatchObject({ range: 'all', from: '', to: '2026-11-05', fromMs: 0 })
    expect(resolveRange({ range: 'custom', from: '2026-10-01', to: '2026-10-02' }, NOW)).toMatchObject({ fromMs: Date.UTC(2026, 9, 1), toMs: Date.UTC(2026, 9, 2) + DAY - 1 })
  })

  it('refuses malformed custom ranges', () => {
    expect(() => resolveRange({ range: 'custom' }, NOW)).toThrow(/YYYY-MM-DD/)
    expect(() => resolveRange({ range: 'custom', from: '2026-13-01', to: '2026-12-01' }, NOW)).toThrow(/real date/)
    expect(() => resolveRange({ range: 'custom', from: '2026-11-05', to: '2026-11-01' }, NOW)).toThrow(/must not be after/)
  })

  it('selects one workspace range newest first', () => {
    const range = resolveRange({ range: 'last30' }, NOW)
    expect(selectSessions([...sampleSessions(), session({ id: 's_other', workspaceId: 'w_other' })], ws.id, range).map(item => item.id)).toEqual(['s_child', 's_parent', 's_old'])
  })
})

describe('deterministic review', () => {
  const evidence = {
    git: { available: true, branch: 'main', clean: true, changedFiles: 2, commits: 4 },
    tasks: { available: true, projectId: 'p1', total: 3, open: 2 },
  }

  it('builds metrics, parent-only timeline, sources, weeks and fact signals', () => {
    const report = buildDeterministic({ sessions: sampleSessions(), evidence })
    expect(report.metrics).toMatchObject({
      sessions: 3, activeDays: 3, userTurns: 8, files: 2, gitCommits: 4, tasks: 3, interrupted: 1, testsFailed: 1,
    })
    expect(report.timeline.map(item => item.sessionId)).toEqual(['s_parent', 's_old'])
    expect(report.timeline[0]).toMatchObject({ date: '2026-11-04', durationMinutes: 120, turnCount: 2, outcome: 'has-result' })
    expect(report.sources).toEqual([{ agent: 'dsh', count: 1 }, { agent: 'claude-code', count: 1 }, { agent: 'codex', count: 1 }])
    expect(report.weeks.map(week => week.label)).toEqual(['2026-10-19', '2026-11-02'])
    expect(report.weeks[1]).toMatchObject({ total: 2, agents: { dsh: 1, 'claude-code': 1 } })
    expect(report.signals.map(signal => signal.kind)).toEqual(['interruptions', 'failed-tests', 'repeated-file', 'mixed-sources'])
    expect(report.git).toEqual(evidence.git)
    expect(report.tasks).toEqual(evidence.tasks)
  })

  it('keeps the outcome vocabulary deterministic and never labels failure', () => {
    const unconfirmed = session({ id: 's_empty', excerpt: '', flags: {}, startedAt: 0 })
    const interrupted = session({ id: 's_int', excerpt: 'x', flags: { interrupted: true }, startedAt: 0 })
    const report = buildDeterministic({ sessions: [unconfirmed, interrupted], evidence: { git: { available: false, changedFiles: 0, commits: 0 } } })
    expect(report.timeline.map(item => item.outcome)).toEqual(['unconfirmed', 'interrupted'])
    expect(report.metrics.gitCommits).toBe(0)
    expect(report.tasks).toBeUndefined()
    expect(report.weeks).toEqual([])
  })
})

describe('AI digest and narrative validation', () => {
  it('bounds the digest and drops everything when the budget is zero', () => {
    const digest = buildDigest(sampleSessions(), 0)
    expect(digest.sessionIds).toEqual([])
    expect(JSON.parse(digest.text)).toEqual({ sessions: [] })
    const full = buildDigest(sampleSessions())
    expect(full.sessionIds).toEqual(['s_child', 's_parent', 's_old'])
    expect(full.text.length).toBeLessThanOrEqual(DEFAULT_DIGEST_CHARS)
    expect(buildPrompt(full, 'last30')).toContain('Range: last30')
  })

  it('parses fenced JSON and refuses non-object answers', () => {
    expect(parseNarrativeJson('```json\n{"summary":{}}\n```')).toEqual({ summary: {} })
    expect(() => parseNarrativeJson('[]')).toThrow(/JSON object/)
    expect(() => parseNarrativeJson('<not json>')).toThrow()
  })

  it('keeps only conclusions backed by a selected session id', () => {
    const valid = validateNarrative({
      summary: { text: 'Summary', evidence: ['s_parent#turn:1', 3, 42] },
      themes: [
        { title: 'Theme', text: 'Body', evidence: ['s_parent', 's_missing'] },
        { title: 3, text: 'Bad title', evidence: ['s_parent'] },
        { title: '', text: 'No title', evidence: ['s_parent'] },
        { title: 'No evidence', text: 'Body', evidence: ['s_missing'] },
        { title: 'Not a record', evidence: ['s_parent'] },
      ],
      decisions: [
        { text: 'Explicit', kind: 'explicit', evidence: ['s_parent'] },
        { text: 'Inferred', evidence: ['s_child'] },
        { text: 'Invalid', evidence: [] },
      ],
      deadEnds: [{ text: 'Dead', evidence: ['s_old'] }, { text: 'Dropped', evidence: ['s_none'] }],
      friction: [{ text: 'Friction', evidence: ['s_parent', 's_parent'] }],
      unknown: 42,
      openLoops: [{ text: 'Open', evidence: ['s_child'] }],
    }, new Set(['s_parent', 's_child', 's_old']))
    expect(valid).toBeDefined()
    expect(valid!.summary?.evidence).toEqual(['s_parent'])
    expect(valid!.themes.map(theme => theme.title)).toEqual(['Theme'])
    expect(valid!.decisions).toEqual([
      { text: 'Explicit', kind: 'explicit', evidence: ['s_parent'] },
      { text: 'Inferred', kind: 'inferred', evidence: ['s_child'] },
    ])
    expect(valid!.deadEnds).toHaveLength(1)
    expect(valid!.friction[0]?.evidence).toEqual(['s_parent'])
    expect(valid!.openLoops).toHaveLength(1)
  })

  it('returns undefined when no conclusion survives', () => {
    expect(validateNarrative('nope', new Set())).toBeUndefined()
    expect(validateNarrative({ summary: { text: 'x', evidence: ['nope'] } }, new Set())).toBeUndefined()
    expect(validateNarrative({ themes: 'nope', decisions: 'nope', deadEnds: 'nope' }, new Set())).toBeUndefined()
  })
})

function modelReturning(value: unknown, model = { provider: 'deepseek', model: 'chat' }): ModelPort & { calls: ModelAskRequest[] } {
  const calls: ModelAskRequest[] = []
  return {
    calls,
    ask: async <T>(request: ModelAskRequest<T>) => {
      calls.push(request as ModelAskRequest)
      const parsed = request.parse?.(JSON.stringify(value))
      return { text: JSON.stringify(value), ...(parsed === undefined ? {} : { structured: parsed }), model }
    },
  }
}

function narrative(): ReviewNarrative {
  return {
    summary: { text: 'AI summary', evidence: ['s_parent'] },
    themes: [{ title: 'Theme', text: 'Text', evidence: ['s_parent'] }],
    decisions: [{ text: 'Decision', kind: 'explicit', evidence: ['s_parent'] }],
    deadEnds: [],
    friction: [],
    openLoops: [{ text: 'Open', evidence: ['s_child'] }],
  }
}

function generator(model?: ModelPort, extra: { maxDigestChars?: number } = {}): ReviewGenerator {
  const options: ConstructorParameters<typeof ReviewGenerator>[0] = { now: () => NOW, newId: () => 'review-id', ...(model === undefined ? {} : { model }) }
  if (extra.maxDigestChars !== undefined) options.maxDigestChars = extra.maxDigestChars
  return new ReviewGenerator(options)
}

const settings = defaultReviewSettings('/home/test')
const range = { range: 'last30' as const }

function input(overrides: Partial<Parameters<ReviewGenerator['generate']>[0]> = {}): Parameters<ReviewGenerator['generate']>[0] {
  return {
    workspace: ws,
    sessions: sampleSessions(),
    range,
    useAi: true,
    settings,
    capabilities: PASS_CAPABILITIES,
    ...overrides,
  }
}

describe('ReviewGenerator', () => {
  it('generates a deterministic report without calling a missing model', async () => {
    const review = await generator().generate(input({}))
    expect(review.ai).toMatchObject({ status: 'unavailable', totalSessions: 3 })
    expect(review.deterministic.metrics.sessions).toBe(3)
    expect(review.narrative).toBeUndefined()
    expect(review.id).toBe('r_review-id')
    expect(review.workspaceName).toBe('Alpha')
    expect(review.range).toBe('last30')
  })

  it('honours the AI-enabled and useAi switches', async () => {
    const disabled = await generator(modelReturning(narrative())).generate(input({ settings: { ...settings, aiEnabled: false } }))
    expect(disabled.ai).toEqual({ status: 'disabled', totalSessions: 3 })
    const requested = await generator(modelReturning(narrative())).generate(input({ useAi: false }))
    expect(requested.ai).toEqual({ status: 'not-requested', totalSessions: 3 })
  })

  it('sends the bounded digest and stores the evidence-checked narrative', async () => {
    const model = modelReturning(narrative())
    const review = await generator(model).generate(input())
    expect(review.ai).toMatchObject({ status: 'generated', analyzedSessions: 3, totalSessions: 3 })
    expect(review.narrative).toEqual(narrative())
    expect(review.model).toBe('deepseek/chat')
    const noModelPort: ModelPort = {
      ask: async <T>(request: ModelAskRequest<T>) => {
        const parsed = request.parse?.(JSON.stringify(narrative()))
        return { text: JSON.stringify(narrative()), ...(parsed === undefined ? {} : { structured: parsed }) }
      },
    }
    const reviewNoModel = await generator(noModelPort).generate(input())
    expect(reviewNoModel.model).toBeUndefined()
    expect(model.calls[0]?.prompt).toContain('s_parent')
    expect(model.calls[0]?.system).toContain('evidence')
  })

  it('records a failed AI answer without losing the report', async () => {
    const failed = await generator(modelReturning({ summary: { text: 'x', evidence: ['missing'] } })).generate(input())
    expect(failed.ai.status).toBe('failed')
    expect(failed.narrative).toBeUndefined()
    expect(failed.deterministic.metrics.sessions).toBe(3)
    const empty = await generator(modelReturning(narrative()), { maxDigestChars: 0 }).generate(input())
    expect(empty.ai).toMatchObject({ status: 'failed', analyzedSessions: 0 })
  })

  it('maps model availability and failures, but rethrows cancellation', async () => {
    const unavailable: ModelPort = { ask: async () => { throw new ModelUnavailableError('no route') } }
    expect((await generator(unavailable).generate(input())).ai).toMatchObject({ status: 'unavailable', message: 'no route' })
    const broken: ModelPort = { ask: async () => { throw new Error('upstream died') } }
    expect((await generator(broken).generate(input())).ai).toMatchObject({ status: 'failed', message: 'upstream died' })
    const thrownString: ModelPort = { ask: async () => { throw 'oops' } }
    expect((await generator(thrownString).generate(input())).ai).toMatchObject({ status: 'failed', message: 'oops' })
    const aborted = new AbortController()
    const cancelling: ModelPort = { ask: async () => { aborted.abort(); const error = new Error('cancelled'); error.name = 'AbortError'; throw error } }
    await expect(generator(cancelling).generate(input({ signal: aborted.signal }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refuses an empty selection and an aborted caller', async () => {
    await expect(generator().generate(input({ sessions: [] }))).rejects.toMatchObject({ code: 'no-sessions' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(generator().generate(input({ signal: aborted.signal }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('previews counts and keeps the input hash stable for equal input', async () => {
    const preview = generator().preview(ws, sampleSessions(), range, settings)
    expect(preview).toMatchObject({ workspaceId: ws.id, sessionCount: 3, aiSessions: 3, aiEnabled: true })
    const first = await generator().generate(input())
    const second = await generator().generate(input())
    const defaulted = await new ReviewGenerator({ now: () => NOW, model: modelReturning(narrative()) }).generate(input())
    expect(defaulted.id).toMatch(/^r_[0-9a-f-]+$/u)
    expect(first.inputHash).toBe(second.inputHash)
  })
})
