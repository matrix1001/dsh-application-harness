import { describe, expect, it } from 'vitest'
import {
  agentLabel, aiStatusLabelKey, evidenceCount, evidenceTitle, formatDateTime, formatDuration, groupTimeline,
  messageOf, metricEntries, outcomeLabelKey, percent, rangeLabelKey, rangeText, shortDate, shortId, signalLabelKey,
  sourceTotal, valueOf, weekRangeText, weekStart,
} from '../src/client/model.ts'
import { en, zh } from '../src/client/locales.ts'
import { REVIEW_FULL, SOURCES, WORKSPACES, translator } from './view-harness.tsx'

const t = translator()
const translate = (key: string): string => key

describe('wire narrowing', () => {
  it('narrows only successful outcomes and suppresses cancelled messages', () => {
    expect(valueOf<number>({ status: 'success', result: 3 })).toBe(3)
    expect(valueOf({ status: 'failed', error: { message: 'x' } })).toBeUndefined()
    expect(messageOf({ status: 'success' })).toBeUndefined()
    expect(messageOf({ status: 'cancelled' })).toBeUndefined()
    expect(messageOf({ status: 'failed', error: { message: 'x' } })).toBe('x')
    expect(messageOf({ status: 'rejected', error: { message: 'y' } })).toBe('y')
  })
})

describe('labels and dates', () => {
  it('names agents, ranges, outcomes, statuses and known signals', () => {
    expect(agentLabel('dsh')).toBe('DSH')
    expect(agentLabel('claude-code')).toBe('Claude Code')
    expect(agentLabel('codex')).toBe('Codex')
    expect(rangeLabelKey('last30')).toBe('view.range.last30')
    expect(outcomeLabelKey('has-result')).toBe('view.outcome.has-result')
    expect(aiStatusLabelKey('failed')).toBe('view.ai.failed')
    expect(signalLabelKey('interruptions')).toBe('view.signal.interruptions')
    expect(signalLabelKey('failed-tests')).toBe('view.signal.failed-tests')
    expect(signalLabelKey('repeated-file')).toBe('view.signal.repeated-file')
    expect(signalLabelKey('mixed-sources')).toBe('view.signal.mixed-sources')
    expect(signalLabelKey('something-else')).toBe('view.signal.other')
  })

  it('formats short dates, ranges and timestamps', () => {
    expect(shortDate('2026-11-05')).toBe('11/05')
    expect(shortDate('not-a-date')).toBe('not-a-date')
    expect(rangeText('2026-10-07', '2026-11-05', t)).toBe('10/07 – 11/05')
    expect(rangeText('', '2026-11-05', t)).toBe('全部 · 11/05')
    expect(rangeText('', '', t)).toBe('全部')
    expect(formatDateTime(0)).toBe('')
    expect(formatDateTime(Number.NaN)).toBe('')
    expect(formatDateTime(REVIEW_FULL.generatedAt)).toMatch(/^2026-11-05 \d\d:\d\d$/u)
  })

  it('formats durations and percentages', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(-1)).toBe('0m')
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(60)).toBe('1h')
    expect(formatDuration(134)).toBe('2h 14m')
    expect(percent(1, 4)).toBe(25)
    expect(percent(0, 0)).toBe(0)
  })

  it('computes week boundaries for weekdays, Sundays and invalid dates', () => {
    expect(weekStart('2026-11-05')).toBe('2026-11-02')
    expect(weekStart('2026-11-08')).toBe('2026-11-02')
    expect(weekStart('invalid')).toBe('invalid')
    expect(weekRangeText('2026-11-02')).toBe('11/02 – 11/08')
    expect(weekRangeText('invalid')).toBe('invalid')
  })
})

describe('report helpers', () => {
  it('groups the timeline by week preserving the newest-first order', () => {
    const groups = groupTimeline(REVIEW_FULL.deterministic.timeline)
    expect(groups.map(group => group.label)).toEqual(['2026-11-02', '2026-10-26'])
    expect(groups.map(group => group.entries.length)).toEqual([2, 2])
    expect(groupTimeline([])).toEqual([])
  })

  it('reads the six metrics in a stable order and fills absent values with zero', () => {
    const entries = metricEntries(REVIEW_FULL)
    expect(entries.map(entry => entry.key)).toEqual(['sessions', 'activeDays', 'userTurns', 'files', 'gitCommits', 'tasks'])
    expect(entries.map(entry => entry.value)).toEqual([4, 3, 97, 11, 2, 3])
    const bare = metricEntries({ ...REVIEW_FULL, deterministic: { ...REVIEW_FULL.deterministic, metrics: {} } })
    expect(bare.every(entry => entry.value === 0)).toBe(true)
  })

  it('counts sources and resolves evidence titles and ids', () => {
    expect(sourceTotal(REVIEW_FULL)).toBe(4)
    expect(evidenceTitle(REVIEW_FULL, 's_1')).toBe('信息收件箱和 Git 浏览的设计收口')
    expect(evidenceTitle(REVIEW_FULL, 's_unknown_long_id')).toBe('s_unknow…')
    expect(shortId('s_short')).toBe('s_short')
    expect(shortId('s_very_long_session_id')).toBe('s_very_l…')
    expect(evidenceCount(REVIEW_FULL.deterministic.timeline[0]!)).toBe(26)
    expect(evidenceCount({ ...REVIEW_FULL.deterministic.timeline[0]!, turnCount: 0 })).toBe(1)
  })

  it('keeps both dictionaries complete and identical in key set', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(zh['app.name']).toBe('工作区回顾')
    expect(en['app.name']).toBe('Workspace Review')
    expect(rangeText('2026-10-07', '2026-11-05', translator(en))).toBe('10/07 – 11/05')
    expect(translate('any')).toBe('any')
    expect(SOURCES.length).toBe(3)
    expect(WORKSPACES.length).toBe(2)
  })
})
