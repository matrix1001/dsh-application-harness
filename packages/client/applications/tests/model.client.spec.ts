/**
 * The area's pure derivations, as plain data: how a lifecycle status is
 * captioned, which half of a declared need belongs to whom, which grants reach
 * ONE application (and which records target it), and who a caller is — the
 * identity rules the permission lists are built on. No React and no wire: every
 * function here is the production one, exercised without a component.
 */
import { describe, expect, it } from 'vitest'
import type {
  AppInfo, AppStatus, Caller, CapabilityGrant, HistoryRecord,
} from '@matrix1001/dsh-application-harness-host-bridge/client'
import {
  STATUS_KEYS, callerLabel, callerText, capabilityNeeds, confirmationSentence, covers, describeNeed, displayDescription, displayName,
  grantedTo, grantsInto, hasPage, hasSettings, historyInto, isCapabilityNeed, moveApplicationBy, moveIdBefore,
  onboardingPending, orderApplications, sameCaller,
} from '../src/client/model.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApplicationsState } from '../src/client/shell.ts'

/** The dictionary key, as the panel's own `t` seat would resolve it. */
const t = ((key: string) => key) as TranslateNS<'applications'>

/** One application row with the fields the derivations read. */
function app(id: string, needs: readonly string[] = [], ops: Array<{ name: string; description: string }> = []): AppInfo {
  return {
    id, name: `${id} title`, description: '', version: '1.0.0', status: 'available', health: 'ok', activation: 'enabled', runtime: 'ready', needs,
    ops: ops.map(entry => ({ ...entry, params: {}, exposure: {} })),
  }
}

/** One grant. */
function grant(caller: Caller, capabilities: readonly string[]): CapabilityGrant {
  return { caller, capabilities: [...capabilities], grantedAt: '2026-01-01T00:00:00.000Z' }
}

/** One settled record. */
function record(callId: string, target: string): HistoryRecord {
  return {
    callId,
    caller: { kind: 'human' },
    target,
    op: 'write',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    status: 'success',
  }
}

describe('what a registration draws', () => {
  it('separates a page from settings, and neither from both', () => {
    expect(hasPage(undefined)).toBe(false)
    expect(hasSettings(undefined)).toBe(false)
    expect(hasPage({ Component: () => null })).toBe(true)
    expect(hasSettings({ Component: () => null })).toBe(false)
    expect(hasPage({ Settings: () => null })).toBe(false)
    expect(hasSettings({ Settings: () => null })).toBe(true)
    expect(hasPage({ Component: () => null, Settings: () => null })).toBe(true)
    expect(hasSettings({ Component: () => null, Settings: () => null })).toBe(true)
  })

  it('shows the client registration’s own name over the host’s', () => {
    expect(displayName(app('workbook'), undefined)).toBe('workbook title')
    expect(displayName(app('workbook'), { name: 'Notebook' })).toBe('Notebook')
    // A getter is resolved per read, so a language switch reaches the row.
    let language = 'zh'
    const localized = { name: () => (language === 'zh' ? '工作簿' : 'Workbook') }
    expect(displayName(app('workbook'), localized)).toBe('工作簿')
    language = 'en'
    expect(displayName(app('workbook'), localized)).toBe('Workbook')
  })

  it('shows the registration’s own short description, the host’s description without one', () => {
    const row: AppInfo = { ...app('workbook'), description: 'the host row' }
    expect(displayDescription(row, undefined)).toBe('the host row')
    expect(displayDescription(row, { name: 'Notebook' })).toBe('the host row')
    expect(displayDescription(row, { description: '笔记与任务。' })).toBe('笔记与任务。')
    // Same getter rule as the name: the human reads what it returns NOW.
    let language = 'zh'
    const localized = { description: () => (language === 'zh' ? '笔记与任务。' : 'Notes and tasks.') }
    expect(displayDescription(row, localized)).toBe('笔记与任务。')
    language = 'en'
    expect(displayDescription(row, localized)).toBe('Notes and tasks.')
  })
})

describe('lifecycle captions', () => {
  it('names every status the runtime reports', () => {
    const statuses: readonly AppStatus[] = ['starting', 'available', 'stopping', 'stopped', 'stop-incomplete', 'failed']
    expect(Object.keys(STATUS_KEYS).sort()).toEqual([...statuses].sort())
    expect(STATUS_KEYS.failed).toBe('status.failed')
    expect(STATUS_KEYS['stop-incomplete']).toBe('status.stop-incomplete')
  })
})

describe('declared needs', () => {
  it('splits platform capabilities from the calls into other applications', () => {
    const row = app('workbook', ['capability:model', 'capability:network', 'disk-analysis#scan', 'git-read#log'])
    expect(isCapabilityNeed('capability:model')).toBe(true)
    expect(isCapabilityNeed('disk-analysis#scan')).toBe(false)
    expect(capabilityNeeds(row)).toEqual(['capability:model', 'capability:network'])
    expect(capabilityNeeds(app('workbook'))).toEqual([])
  })

})

describe('grants', () => {
  it('covers one capability by exact name', () => {
    expect(covers(grant({ kind: 'human' }, ['workbook#write']), 'workbook#write')).toBe(true)
    expect(covers(grant({ kind: 'human' }, ['workbook#write']), 'workbook#read')).toBe(false)
  })


  it('reads the grants that let OTHER callers reach one application, grouped and narrowed', () => {
    const ai = grant({ kind: 'ai', sessionId: 'session-1' }, ['workbook#write', 'disk-analysis#scan', 'workbook#read'])
    const appGrant = grant({ kind: 'app', appId: 'git-read' }, ['workbook#write', 'workbook#read'])
    const unrelated = grant({ kind: 'human' }, ['capability:model'])
    const into = grantsInto([ai, appGrant, unrelated], 'workbook')
    expect(into.map(entry => callerLabel(entry.caller))).toEqual(['ai · session-1', 'app · git-read'])
    // Only the capabilities naming this application travel; a duplicate of the
    // same capability from the same caller is not listed twice.
    expect(into[0]?.capabilities).toEqual(['workbook#write', 'workbook#read'])
    expect(into[1]?.capabilities).toEqual(['workbook#write', 'workbook#read'])
    expect(grantsInto([unrelated], 'workbook')).toEqual([])
  })

  it('counts a grant of the caller or of its own background work, and nobody else’s', () => {
    const caller: Caller = { kind: 'app', appId: 'info-hub' }
    const background = grant({ kind: 'background', appId: 'info-hub' }, ['capability:network'])
    const other = grant({ kind: 'app', appId: 'workbook' }, ['capability:network'])
    expect(grantedTo([background], caller, 'capability:network')).toBe(true)
    expect(grantedTo([other], caller, 'capability:network')).toBe(false)
    // A different capability of the right caller is not covered either.
    expect(grantedTo([background], caller, 'capability:model')).toBe(false)
    // A human grant is only ever the human's own.
    const human: Caller = { kind: 'human' }
    expect(grantedTo([grant({ kind: 'human' }, ['capability:model'])], human, 'capability:model')).toBe(true)
    expect(grantedTo([grant({ kind: 'human' }, ['capability:model'])], { kind: 'ai' }, 'capability:model')).toBe(false)
    expect(grantedTo(
      [grant({ kind: 'ai', sessionId: 's-1' }, ['capability:model'])],
      { kind: 'ai', sessionId: 's-2' },
      'capability:model',
    )).toBe(false)
  })
})

describe('caller identity', () => {
  it('calls two records the same subject only when they really are one', () => {
    const workbook: Caller = { kind: 'app', appId: 'workbook' }
    expect(sameCaller(workbook, { kind: 'app', appId: 'workbook' })).toBe(true)
    expect(sameCaller(workbook, { kind: 'app', appId: 'git-read' })).toBe(false)
    // An application and its background work are NOT the same subject here —
    // the principal rule (grantedTo) is what folds them.
    expect(sameCaller(workbook, { kind: 'background', appId: 'workbook' })).toBe(false)
    expect(sameCaller({ kind: 'background', appId: 'workbook' }, { kind: 'background', appId: 'workbook' })).toBe(true)
    expect(sameCaller({ kind: 'background', appId: 'workbook' }, { kind: 'background', appId: 'info-hub' })).toBe(false)
    expect(sameCaller({ kind: 'ai', sessionId: 's-1', turnId: 't-1' }, { kind: 'ai', sessionId: 's-1', turnId: 't-1' })).toBe(true)
    expect(sameCaller({ kind: 'ai', sessionId: 's-1', turnId: 't-1' }, { kind: 'ai', sessionId: 's-2', turnId: 't-1' })).toBe(false)
    // The turn is not an identity: one session's grant is not re-scoped per turn.
    expect(sameCaller({ kind: 'ai', sessionId: 's-1', turnId: 't-1' }, { kind: 'ai', sessionId: 's-1', turnId: 't-2' })).toBe(true)
    // An anonymous AI call has no durable principal at all.
    expect(sameCaller({ kind: 'ai' }, { kind: 'ai' })).toBe(false)
    expect(sameCaller({ kind: 'ai' }, { kind: 'ai', sessionId: 's-1' })).toBe(false)
    expect(sameCaller({ kind: 'human' }, { kind: 'human' })).toBe(true)
    expect(sameCaller(workbook, { kind: 'ai', sessionId: 's-1' })).toBe(false)
    expect(sameCaller(workbook, { kind: 'human' })).toBe(false)
  })

  it('localizes a caller and builds a consent sentence from structured fields', () => {
    const workbook = app('workbook', [], [{ name: 'write', description: 'write a task' }])
    const apps = [workbook]
    const views = new Map()
    expect(callerText({ kind: 'human' }, apps, views, t)).toBe('caller.human')
    expect(callerText({ kind: 'ai' }, apps, views, t)).toBe('caller.ai')
    expect(callerText({ kind: 'ai', sessionId: 's-1' }, apps, views, t)).toBe('caller.aiSession')
    expect(callerText({ kind: 'app', appId: 'workbook' }, apps, views, t)).toBe('caller.app')
    expect(callerText({ kind: 'background', appId: 'workbook' }, apps, views, t)).toBe('caller.background')
    const request = (capability: string): { id: string; caller: { kind: 'app'; appId: string }; capability: string; reason: string; at: string } => ({
      id: 'c1', caller: { kind: 'app', appId: 'git-read' }, capability, reason: 'raw', at: '2026-01-01T00:00:00.000Z',
    })
    expect(confirmationSentence(request('workbook#write'), apps, views, t)).toBe('confirm.callOp')
    expect(confirmationSentence(request('capability:storage'), apps, views, t)).toBe('confirm.useCapability')
    expect(confirmationSentence(request('something-else'), apps, views, t)).toBe('confirm.generic')
  })

  it('prints a caller as who it is', () => {
    expect(callerLabel({ kind: 'human' })).toBe('human')
    expect(callerLabel({ kind: 'ai' })).toBe('ai')
    expect(callerLabel({ kind: 'ai', sessionId: 's-1' })).toBe('ai · s-1')
    expect(callerLabel({ kind: 'ai', sessionId: 's-1', turnId: 't-1' })).toBe('ai · s-1')
    expect(callerLabel({ kind: 'app', appId: 'workbook' })).toBe('app · workbook')
    expect(callerLabel({ kind: 'background', appId: 'workbook' })).toBe('background · workbook')
  })
})

describe('describeNeed', () => {
  it('explains a known capability and keeps its raw identifier as the selector', () => {
    const described = describeNeed('capability:storage', [], new Map(), t)
    expect(described.label).toBe('cap.storage')
    expect(described.purpose).toBe('cap.storagePurpose')
    expect(described.selector).toBe('capability:storage')
  })

  it('keeps an unknown capability as its own name, and says it has no built-in description', () => {
    const described = describeNeed('capability:telepathy', [], new Map(), t)
    expect(described.label).toBe('capability:telepathy')
    expect(described.purpose).toBe('cap.unknownPurpose')
    expect(described.selector).toBe('capability:telepathy')
  })

  it('names a peer need by its target application and the operation’s own description', () => {
    const target = app('workbook', [], [{ name: 'write', description: 'write a task' }])
    const described = describeNeed('workbook#write', [target], new Map(), t)
    expect(described.label).toBe('workbook title · write')
    // The host's own words travel verbatim (never translated).
    expect(described.purpose).toBe('write a task')
    expect(described.selector).toBe('workbook#write')
  })

  it('falls back to the raw need when the target is gone or the operation unnamed', () => {
    const lacking = app('workbook', [], [{ name: 'read', description: '' }])
    const unknownTarget = describeNeed('ghost#write', [lacking], new Map(), t)
    expect(unknownTarget.label).toBe('ghost#write')
    expect(unknownTarget.purpose).toBeUndefined()
    // A declared operation with an empty description still gives the target's name.
    const described = describeNeed('workbook#read', [lacking], new Map(), t)
    expect(described.label).toBe('workbook title · read')
    expect(described.purpose).toBe('')
    // A need that is not this vocabulary at all comes back whole.
    const odd = describeNeed('something-else', [lacking], new Map(), t)
    expect(odd.label).toBe('something-else')
    expect(odd.selector).toBe('something-else')
  })
})

describe('one application’s records', () => {
  it('keeps only the calls whose TARGET is that application', () => {
    const records = [record('call-1', 'workbook'), record('call-2', 'disk-analysis'), record('call-3', 'workbook')]
    expect(historyInto(records, 'workbook').map(item => item.callId)).toEqual(['call-1', 'call-3'])
    expect(historyInto(records, 'info-hub')).toEqual([])
  })
})

describe('the navigation order', () => {
  const rows = [app('workbook'), app('disk-analysis'), app('info-hub')]

  it('applies the saved order, appends new rows and ignores removed ids', () => {
    expect(orderApplications(rows, []).map(row => row.id)).toEqual(['workbook', 'disk-analysis', 'info-hub'])
    expect(orderApplications(rows, ['info-hub', 'gone', 'workbook']).map(row => row.id)).toEqual(['info-hub', 'workbook', 'disk-analysis'])
    // A saved list naming nothing this build knows is the host order.
    expect(orderApplications(rows, ['gone']).map(row => row.id)).toEqual(['workbook', 'disk-analysis', 'info-hub'])
  })

  it('moves before an original index for a pointer drop, and one slot for the keyboard', () => {
    const ids = ['a', 'b', 'c', 'd']
    // Drag "a" before the row at index 2 ("c"): the result is b, a, c, d.
    expect(moveIdBefore(ids, 'a', 2)).toEqual(['b', 'a', 'c', 'd'])
    // Drag "d" before the first row.
    expect(moveIdBefore(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
    // Dropping onto its own slot is a no-op.
    expect(moveIdBefore(ids, 'b', 1)).toEqual(ids)
    expect(moveIdBefore(ids, 'b', 2)).toEqual(ids)
    // An id that is no longer in the list changes nothing.
    expect(moveIdBefore(ids, 'gone', 2)).toEqual(ids)
    expect(moveApplicationBy(ids, 'b', 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveApplicationBy(ids, 'a', -1)).toEqual(ids)
    expect(moveApplicationBy(ids, 'd', 1)).toEqual(ids)
  })
})

/** The first-run predicate reads only these fields; the rest keep the type honest. */
function firstRunState(over: Partial<ApplicationsState> = {}): ApplicationsState {
  return {
    apps: [], activeAppId: undefined, running: new Map(), runningCalls: [], outcomes: new Map(),
    refusals: new Map(), progress: [], claims: new Map(), history: [], historyLoaded: true,
    historyReading: false, historyFailed: false, historyTarget: undefined, tasks: [],
    tasksLoaded: false, tasksReading: false, tasksFailed: false, policies: [], policiesReading: false, policiesFailed: false, policiesLoaded: false, grants: [], grantsReading: false,
    grantsFailed: false, onboarding: { apps: {} }, grantsLoaded: true, onboardingLoaded: true,
    confirmations: [], confirmationsLoaded: true, confirmationsReading: false, confirmationsFailed: false,
    watching: true, connectionError: undefined, error: undefined,
    ...over,
  }
}

describe('onboardingPending', () => {
  const subject = app('info-hub', ['capability:storage'])

  it('is owed while a platform capability is missing and nothing was answered', () => {
    expect(onboardingPending(subject, firstRunState())).toBe(true)
  })

  it('is not owed once every declared platform capability is granted', () => {
    const grants = [grant({ kind: 'app', appId: 'info-hub' }, ['capability:storage'])]
    expect(onboardingPending(subject, firstRunState({ grants }))).toBe(false)
  })

  it('is not owed when this exact capability set was answered or postponed', () => {
    const onboarding = { apps: { 'info-hub': { fingerprint: 'capability:storage', seenAt: '2026-01-01T00:00:00.000Z' } } }
    expect(onboardingPending(subject, firstRunState({ onboarding }))).toBe(false)
  })

  it('is owed again when the capability set changed', () => {
    const onboarding = { apps: { 'info-hub': { fingerprint: 'capability:network', seenAt: '2026-01-01T00:00:00.000Z' } } }
    expect(onboardingPending(subject, firstRunState({ onboarding }))).toBe(true)
  })

  it('is not owed for an unknown or unavailable application', () => {
    expect(onboardingPending(undefined, firstRunState())).toBe(false)
    expect(onboardingPending({ ...subject, status: 'failed' }, firstRunState())).toBe(false)
  })

  it('waits for both reads before deciding', () => {
    expect(onboardingPending(subject, firstRunState({ grantsLoaded: false }))).toBe(false)
    expect(onboardingPending(subject, firstRunState({ onboardingLoaded: false }))).toBe(false)
  })

  it('is not owed when the application declares no platform capability', () => {
    expect(onboardingPending(app('plain'), firstRunState())).toBe(false)
  })
})
