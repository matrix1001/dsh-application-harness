// @vitest-environment jsdom
/**
 * The render-only pieces of the management dialog: one outcome in each of its
 * four shapes, and the record lists with every caller kind and every optional
 * record field (codes and messages travel verbatim, callers print as who they
 * are, and the empty states are the caller's own copy, passed in as captions).
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  Caller, HistoryRecord, PendingConfirmation,
} from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { CallOutcome } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { CallOutcomeView } from '../src/client/CallOutcomeView.tsx'
import { StatusBadge } from '../src/client/StatusBadge.tsx'
import { ConfirmationsList, GrantsIntoList, HistoryList, NeedsList, PoliciesList } from '../src/client/Lists.tsx'
import { describeNeed, type NeedDescription } from '../src/client/model.ts'

/** The dictionary key, as the panel's own `t` seat would resolve it. */
const t = ((key: string): string => key) as TranslateNS<'applications'>

/** One application row, for the descriptions of peer needs. */
function app(id: string, ops: Array<{ name: string; description: string }> = []): AppInfo {
  return {
    id,
    name: `${id} title`,
    description: `${id} description`,
    version: '1.0.0',
    status: 'available',
    health: 'ok', activation: 'enabled', runtime: 'ready',
    needs: [],
    ops: ops.map(entry => ({ ...entry, params: {}, exposure: {} })),
  }
}

/** The need descriptions the dialog composes (no registrations: names fall back to the host's). */
const describeOf = (need: string): NeedDescription => describeNeed(need, [app('workbook', [{ name: 'write', description: 'write a task' }])], new Map(), t)

/** One settled record. */
function record(callId: string, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    callId,
    caller: { kind: 'human' },
    target: 'workbook',
    op: 'write',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    status: 'success',
    ...over,
  }
}

/** One pending confirmation. */
function confirmation(id: string, caller: Caller): PendingConfirmation {
  return {
    id,
    caller,
    capability: 'workbook#delete',
    reason: 'the agent wants to delete a task',
    at: '2026-01-01T00:00:02.000Z',
  }
}

afterEach(cleanup)

describe('CallOutcomeView', () => {
  it('renders a success as pretty-printed JSON', () => {
    const outcome: CallOutcome = { callId: 'call-1', status: 'success', result: { total: 3 } }
    const view = render(<CallOutcomeView outcome={outcome} t={t} />)
    expect(view.container.querySelector('[data-status="success"]')).not.toBeNull()
    expect(view.getByText(/"total": 3/)).toBeDefined()
    expect(view.queryByText('threw')).toBeNull()
  })

  it('renders a rejection and a failure with their code and message, and a cancellation bare', () => {
    const rejected: CallOutcome = {
      callId: 'call-2', status: 'rejected', error: { code: 'platform.denied', message: 'the user refused' }
    }
    const rejectedView = render(<CallOutcomeView outcome={rejected} t={t} />)
    expect(rejectedView.getByText('platform.denied')).toBeDefined()
    expect(rejectedView.getByText('the user refused')).toBeDefined()
    rejectedView.unmount()

    const failed: CallOutcome = {
      callId: 'call-3', status: 'failed', error: { code: 'disk_full', message: 'no space left', }
    }
    const failedView = render(<CallOutcomeView outcome={failed} t={t} />)
    expect(failedView.getByText('disk_full')).toBeDefined()
    expect(failedView.getByText('no space left')).toBeDefined()
    failedView.unmount()

    const cancelled: CallOutcome = { callId: 'call-4', status: 'cancelled' }
    const cancelledView = render(<CallOutcomeView outcome={cancelled} t={t} />)
    expect(cancelledView.container.querySelector('[data-status="cancelled"]')).not.toBeNull()
    expect(cancelledView.getByText('cancelled')).toBeDefined()
  })
})

describe('HistoryList', () => {
  it('prints every caller kind, the codes and the messages verbatim', () => {
    const records = [
      record('call-1', { caller: { kind: 'human' }, status: 'rejected', code: 'platform.denied', message: 'refused' }),
      record('call-2', { caller: { kind: 'ai' } }),
      record('call-3', { caller: { kind: 'ai', sessionId: 'session-1' }, status: 'failed', code: 'platform.execution-failed', message: 'boom'}),
      record('call-4', { caller: { kind: 'app', appId: 'git-read' } }),
      record('call-5', { caller: { kind: 'background', appId: 'info-hub' } }),
    ]
    const view = render(<HistoryList records={records} t={t} />)
    expect(view.getByText('history.caller: human')).toBeDefined()
    expect(view.getByText('history.caller: ai')).toBeDefined()
    expect(view.getByText('history.caller: ai · session-1')).toBeDefined()
    expect(view.getByText('history.caller: app · git-read')).toBeDefined()
    expect(view.getByText('history.caller: background · info-hub')).toBeDefined()
    expect(view.getByText('platform.denied')).toBeDefined()
    expect(view.getByText('refused')).toBeDefined()
    expect(view.getByText('platform.execution-failed')).toBeDefined()
    expect(view.getByText('boom')).toBeDefined()
    // The record's operation travels verbatim; the TARGET is the list's subject
    // (the management dialog reads one application's history), so it is not
    // repeated on every row.
    expect(view.getAllByText('write')).toHaveLength(5)
    // Every row carries its own status; the three unoverridden records are ok.
    expect(view.getAllByText('success')).toHaveLength(3)
  })

  it('shows the empty hint when nothing was recorded', () => {
    const view = render(<HistoryList records={[]} t={t} />)
    expect(view.getByText('history.empty')).toBeDefined()
  })
})

describe('GrantsIntoList', () => {
  it('revokes exactly the capability shown, of the caller shown', async () => {
    const caller: Caller = { kind: 'app', appId: 'git-read' }
    const revoke = vi.fn()
    const view = render(
      <GrantsIntoList
        title="perm.into"
        empty="perm.noInto"
        entries={[{ caller, capabilities: ['workbook#write', 'workbook#read'] }]}
        describe={describeOf}
        revoke={revoke}
        t={t}
      />,
    )
    expect(view.getByText('perm.into')).toBeDefined()
    expect(view.getByText('app · git-read')).toBeDefined()
    expect(view.getByText('workbook#read')).toBeDefined()
    // The revoke names the capability AND the caller it came from: revoking here
    // must take away what is shown, never the caller's unrelated grants.
    fireEvent.click(view.container.querySelector('[data-grant-revoke="workbook#read"]') as HTMLElement)
    expect(revoke).toHaveBeenCalledWith(caller, 'workbook#read')
    await waitFor(() => expect(view.getAllByText('grants.revoke')).toHaveLength(2))
  })

  it('shows the caller’s own empty hint with nobody reaching in', () => {
    const view = render(<GrantsIntoList title="perm.into" empty="perm.noInto" entries={[]} describe={describeOf} revoke={vi.fn(async () => true)} t={t} />)
    expect(view.getByText('perm.noInto')).toBeDefined()
    // The section title belongs to the list; an empty list is only the hint.
    expect(view.queryByText('perm.into')).toBeNull()
  })
})

describe('NeedsList', () => {
  it('shows each need in words, with the raw id kept as a viewable detail', () => {
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    const view = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={caller}
        needs={['capability:model', 'capability:telepathy']}
        grants={[]}
        describe={describeOf}
        grant={vi.fn(async () => true)}
        revoke={vi.fn(async () => true)}
        t={t}
      />,
    )
    // A known capability is named and explained by the framework…
    expect(view.getByText('cap.model')).toBeDefined()
    expect(view.getByText('cap.modelPurpose')).toBeDefined()
    // …an unknown one keeps its identifier, and says so instead of guessing.
    expect(view.getByText('capability:telepathy')).toBeDefined()
    expect(view.getByText('cap.unknownPurpose')).toBeDefined()
    // The explained one keeps its raw identifier as a viewable detail; the
    // unexplained one already READS as its identifier, so it repeats no line.
    expect(view.container.querySelector('[data-need-details="capability:model"] code')?.textContent).toBe('capability:model')
    expect(view.container.querySelector('[data-need-details="capability:telepathy"]')).toBeNull()
  })

  it('approves an unapproved need and revokes an approved one through its own switch', async () => {
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    const grant = vi.fn(async () => true)
    const revoke = vi.fn(async () => true)
    const view = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={caller}
        needs={['capability:model', 'workbook#write']}
        grants={[{ caller, capabilities: ['workbook#write'], grantedAt: '2026-01-01T00:00:03.000Z' }]}
        describe={describeOf}
        grant={grant}
        revoke={revoke}
        t={t}
      />,
    )
    const switchOf = (need: string): HTMLElement =>
      view.container.querySelector(`[data-app-need="${need}"] [role="switch"]`) as HTMLElement
    expect(switchOf('capability:model').getAttribute('aria-checked')).toBe('false')
    expect(switchOf('workbook#write').getAttribute('aria-checked')).toBe('true')
    // The write is the EXACT selector, whatever the row reads in words.
    fireEvent.click(switchOf('capability:model'))
    await waitFor(() => expect(grant).toHaveBeenCalledWith(caller, ['capability:model']))
    fireEvent.click(switchOf('workbook#write'))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(caller, 'workbook#write'))
  })

  it('keeps the row’s own pending and failure state, and follows the read-back truth', async () => {
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    let settle: (ok: boolean) => void = () => {}
    const grant = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve }))
    const { container } = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={caller}
        needs={['capability:model']}
        grants={[]}
        describe={describeOf}
        grant={grant}
        revoke={vi.fn(async () => true)}
        t={t}
      />,
    )
    const switchOf = (): HTMLElement => container.querySelector('[data-app-need="capability:model"] [role="switch"]') as HTMLElement
    fireEvent.click(switchOf())
    // While the write is in flight the control refuses input and the row says so.
    expect(switchOf().hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(container.querySelector('[data-need-pending="capability:model"]')).not.toBeNull())
    await act(async () => { settle(false) })
    // A refusal is reported ON this row — the state it shows is still the host's.
    expect(container.querySelector('[data-need-error="capability:model"]')?.textContent).toBe('needs.failed')
    expect(switchOf().getAttribute('aria-checked')).toBe('false')
    expect(switchOf().hasAttribute('disabled')).toBe(false)
  })

  it('says nothing after it unmounts: a late answer writes no state', async () => {
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    let settle: (ok: boolean) => void = () => {}
    const grant = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve }))
    const { container, unmount } = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={caller}
        needs={['capability:model']}
        grants={[]}
        describe={describeOf}
        grant={grant}
        revoke={vi.fn(async () => true)}
        t={t}
      />,
    )
    fireEvent.click(container.querySelector('[role="switch"]') as HTMLElement)
    unmount()
    // The write was already out; its answer arrives to nothing (React 18 writes
    // nothing and warns about nothing) — the row must not resurrect itself.
    await act(async () => { settle(true) })
    expect(container.querySelector('[data-need-error="capability:model"]')).toBeNull()
  })

  it('describes a peer need by its target application and the operation’s own words', () => {
    const view = render(
      <NeedsList
        title="perm.peers"
        empty="perm.noPeers"
        caller={{ kind: 'app', appId: 'info-hub' }}
        needs={['workbook#write']}
        grants={[]}
        describe={describeOf}
        grant={vi.fn(async () => true)}
        revoke={vi.fn(async () => true)}
        t={t}
      />,
    )
    expect(view.getByText('workbook title · write')).toBeDefined()
    // The operation's description is the host's text, shown verbatim.
    expect(view.getByText('write a task')).toBeDefined()
    expect(view.container.querySelector('[data-need-details="workbook#write"] code')?.textContent).toBe('workbook#write')
  })

  it('counts a background grant of the same application (one principal), not another application’s', () => {
    const view = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={{ kind: 'app', appId: 'info-hub' }}
        needs={['capability:network']}
        grants={[
          { caller: { kind: 'background', appId: 'info-hub' }, capabilities: ['capability:network'], grantedAt: '' },
          { caller: { kind: 'app', appId: 'workbook' }, capabilities: ['capability:network'], grantedAt: '' },
        ]}
        describe={describeOf}
        grant={vi.fn(async () => true)}
        revoke={vi.fn(async () => true)}
        t={t}
      />,
    )
    expect(view.container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    // The other application's grant of the same name is NOT this caller's.
    const view2 = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={{ kind: 'app', appId: 'info-hub' }}
        needs={['capability:network']}
        grants={[{ caller: { kind: 'app', appId: 'workbook' }, capabilities: ['capability:network'], grantedAt: '' }]}
        describe={describeOf}
        grant={vi.fn(async () => true)}
        revoke={vi.fn(async () => true)}
        t={t}
      />,
    )
    expect(view2.container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('shows the caller’s own empty hint with nothing declared', () => {
    const view = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={{ kind: 'app', appId: 'workbook' }}
        needs={[]}
        grants={[]}
        describe={describeOf}
        grant={vi.fn(async () => true)}
        revoke={vi.fn(async () => true)}
        t={t}
      />,
    )
    expect(view.getByText('perm.noCapabilities')).toBeDefined()
    expect(view.queryByText('perm.capabilities')).toBeNull()
  })
})

describe('ConfirmationsList', () => {
  it('shows a localized sentence, keeps the raw wire in details, and answers once', async () => {
    const answer = vi.fn(async () => true)
    const view = render(
      <ConfirmationsList
        confirmations={[confirmation('confirmation-1', { kind: 'background', appId: 'workbook' })]}
        answer={answer}
        cancelConfirmation={vi.fn(async () => true)}
        sentence={request => `sentence:${request.id}`}
        t={t}
      />,
    )
    expect(view.getByText('sentence:confirmation-1')).toBeDefined()
    // The raw capability, caller and reason are technical detail, not the
    // decision sentence.
    expect(view.getByText('workbook#delete')).toBeDefined()
    expect(view.getByText('background · workbook')).toBeDefined()
    expect(view.getByText('the agent wants to delete a task')).toBeDefined()
    const stamp = view.container.querySelector('[data-confirm-details] time')!
    expect(stamp.textContent).not.toBe('2026-01-01T00:00:02.000Z')
    expect(stamp.getAttribute('title')).toBe('2026-01-01T00:00:02.000Z')
    fireEvent.click(view.getByText('confirm.allowOnce'))
    await waitFor(() => expect(answer).toHaveBeenCalledWith('confirmation-1', 'allowed-once'))
    fireEvent.click(view.getByText('confirm.deny'))
    await waitFor(() => expect(answer).toHaveBeenCalledWith('confirmation-1', 'denied'))
  })

  it('reports a refused withdrawal and clears the waiting question after a successful one', async () => {
    let resolveWithdraw: (value: boolean) => void = () => {}
    const cancel = vi.fn(() => new Promise<boolean>((resolve) => { resolveWithdraw = resolve }))
    const view = render(
      <ConfirmationsList
        confirmations={[confirmation('confirmation-1', { kind: 'human' })]}
        answer={vi.fn(async () => true)}
        cancelConfirmation={cancel}
        sentence={() => 'sentence'}
        t={t}
      />,
    )
    fireEvent.click(view.getByText('confirm.withdraw'))
    expect(view.container.querySelector('[data-confirm-pending]')).not.toBeNull()
    await act(async () => { resolveWithdraw(false) })
    expect(view.container.querySelector('[data-confirm-row-error]')).not.toBeNull()
    fireEvent.click(view.getByText('confirm.withdraw'))
    await act(async () => { resolveWithdraw(true) })
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('offers only a one-off answer to an anonymous AI caller', () => {
    const view = render(
      <ConfirmationsList
        confirmations={[confirmation('confirmation-anon', { kind: 'ai' })]}
        answer={vi.fn(async () => true)}
        cancelConfirmation={vi.fn(async () => true)}
        sentence={() => 'sentence'}
        t={t}
      />,
    )
    expect(view.container.querySelector('[data-confirm-allow-always]')).toBeNull()
    expect(view.container.querySelector('[data-confirm-allow-once]')).not.toBeNull()
  })

  it('reports a row-level pending and a refused answer', async () => {
    let settle: (value: boolean) => void = () => {}
    const answer = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve }))
    const view = render(
      <ConfirmationsList
        confirmations={[confirmation('confirmation-1', { kind: 'human' })]}
        answer={answer}
        cancelConfirmation={vi.fn(async () => true)}
        sentence={() => 'sentence'}
        t={t}
      />,
    )
    fireEvent.click(view.getByText('confirm.allowOnce'))
    expect(view.container.querySelector('[data-confirm-pending]')).not.toBeNull()
    await act(async () => { settle(false) })
    expect(view.container.querySelector('[data-confirm-row-error]')).not.toBeNull()
  })

  it('does not call an unanswered read empty', () => {
    const view = render(
      <ConfirmationsList confirmations={[]} answer={vi.fn(async () => true)} cancelConfirmation={vi.fn(async () => true)} sentence={() => 'sentence'} loaded={false} reading t={t} />
    )
    expect(view.getByText('confirm.loading')).toBeDefined()
    expect(view.queryByText('confirm.empty')).toBeNull()
    view.rerender(
      <ConfirmationsList confirmations={[]} answer={vi.fn(async () => true)} cancelConfirmation={vi.fn(async () => true)} sentence={() => 'sentence'} failed t={t} />
    )
    expect(view.getByText('confirm.loadFailed')).toBeDefined()
  })

  it('keeps an unparseable timestamp as text instead of inventing a date', () => {
    const bad = { ...confirmation('confirmation-bad', { kind: 'human' }), at: 'not-a-date' }
    const view = render(
      <ConfirmationsList confirmations={[bad]} answer={vi.fn(async () => true)} cancelConfirmation={vi.fn(async () => true)} sentence={() => 'sentence'} t={t} />
    )
    expect(view.getByText('not-a-date')).toBeDefined()
  })

  it('shows the empty hint only after a successful read', () => {
    const view = render(
      <ConfirmationsList confirmations={[]} answer={vi.fn(async () => true)} cancelConfirmation={vi.fn(async () => true)} sentence={() => 'sentence'} loaded t={t} />
    )
    expect(view.getByText('confirm.empty')).toBeDefined()
  })
})

describe('list read states', () => {
  it('disables a need switch until grants are known, and retries a failed grants read', () => {
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    const onRetry = vi.fn()
    const view = render(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={caller}
        needs={['capability:model']}
        grants={[]}
        describe={describeOf}
        grant={vi.fn(async () => true)}
        revoke={vi.fn(async () => true)}
        loaded={false}
        reading
        onRetry={onRetry}
        t={t}
      />,
    )
    const toggle = view.container.querySelector('[data-app-need="capability:model"] [role="switch"]') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(view.getByText('reads.loading')).toBeDefined()
    view.rerender(
      <NeedsList
        title="perm.capabilities"
        empty="perm.noCapabilities"
        caller={caller}
        needs={['capability:model']}
        grants={[]}
        describe={describeOf}
        grant={vi.fn(async () => true)}
        revoke={vi.fn(async () => true)}
        loaded={false}
        failed
        onRetry={onRetry}
        t={t}
      />,
    )
    expect(view.getByText('reads.failed')).toBeDefined()
    fireEvent.click(view.container.querySelector('[data-needs-retry]')!)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('disables revoke while a grants read failed and retries from the list', () => {
    const onRetry = vi.fn()
    const view = render(
      <GrantsIntoList
        title="perm.into"
        empty="perm.noInto"
        entries={[{ caller: { kind: 'app', appId: 'git-read' }, capabilities: ['workbook#write'] }]}
        describe={describeOf}
        revoke={vi.fn(async () => true)}
        loaded
        failed
        onRetry={onRetry}
        t={t}
      />,
    )
    expect((view.container.querySelector('[data-grant-revoke="workbook#write"]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.container.querySelector('[data-into-retry]')!)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('does not call an unanswered history read empty and keeps stale data marked', () => {
    const view = render(<HistoryList records={[]} t={t} loaded={false} reading />)
    expect(view.getByText('reads.loading')).toBeDefined()
    expect(view.queryByText('history.empty')).toBeNull()
    view.rerender(<HistoryList records={[record('call-1')]} t={t} loaded reading />)
    expect(view.getByText('write')).toBeDefined()
    expect(view.getByText('reads.loading')).toBeDefined()
    view.rerender(<HistoryList records={[record('call-1')]} t={t} loaded failed />)
    expect(view.getByText('reads.failed')).toBeDefined()
  })
})

describe('operation policy selectors', () => {
  const policyApp: AppInfo = {
    ...app('workbook'),
    ops: [
      { name: 'write', description: 'write a task', params: {}, exposure: { ai: 'confirm', peers: 'open' } },
      { name: 'read', description: 'read tasks', params: {}, exposure: { ai: 'open' } },
      { name: 'hidden', description: 'closed', params: {}, exposure: {} },
    ],
  }

  it('shows one selector per externally open operation and saves the chosen policy', async () => {
    let release: (value: boolean) => void = () => {}
    const setPolicy = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve }))
    const view = render(
      <PoliciesList
        app={policyApp}
        policies={[{ appId: 'workbook', operation: 'write', policy: 'confirm', updatedAt: 't' }]}
        setPolicy={setPolicy}
        t={t}
      />,
    )
    expect(view.container.querySelectorAll('[data-app-policy]')).toHaveLength(2)
    const write = view.container.querySelector('[data-app-policy="write"] select') as HTMLSelectElement
    expect(write.value).toBe('confirm')
    fireEvent.change(write, { target: { value: 'allow' } })
    expect(setPolicy).toHaveBeenCalledWith('workbook', 'write', 'allow')
    expect(view.container.querySelector('[data-policy-pending]')).not.toBeNull()
    await act(async () => { release(true) })
    await waitFor(() => expect(view.container.querySelector('[data-policy-pending]')).toBeNull())

    // A failed save keeps the old selector value and shows the row error.
    setPolicy.mockResolvedValueOnce(false)
    fireEvent.change(write, { target: { value: 'forbid' } })
    await waitFor(() => expect(view.container.querySelector('[data-policy-error]')).not.toBeNull())
  })

  it('renders loading, failure and empty states', () => {
    const empty = render(<PoliciesList app={{ ...policyApp, ops: [] }} policies={[]} setPolicy={async () => true} t={t} />)
    expect(empty.container.textContent).toContain('policy.empty')
    empty.unmount()
    const failed = render(
      <PoliciesList app={policyApp} policies={[]} setPolicy={async () => true} t={t} failed onRetry={() => {}} />,
    )
    expect(failed.container.querySelector('[data-policies-failed]')).not.toBeNull()
    expect(failed.container.querySelector('[data-policies-retry]')).not.toBeNull()
    failed.unmount()
    const reading = render(
      <PoliciesList app={policyApp} policies={[]} setPolicy={async () => true} t={t} reading loaded={false} />,
    )
    expect(reading.container.querySelector('[data-policies-reading]')).not.toBeNull()
    expect(reading.container.querySelector('[data-app-policy]')).toBeNull()
  })
})

describe('status health', () => {
  it('shows degraded health beside an available status, and not beside a failed one', () => {
    const available = render(<StatusBadge runtime="ready" status="available" health="degraded" t={t} />)
    expect(available.container.querySelector('[data-health="degraded"]')).not.toBeNull()
    available.unmount()
    const failed = render(<StatusBadge runtime="stopped" status="failed" health="degraded" t={t} />)
    expect(failed.container.querySelector('[data-health="degraded"]')).toBeNull()
    failed.unmount()
    const disabled = render(<StatusBadge runtime="stopped" status="stopped" activation="disabled" t={t} />)
    expect(disabled.container.textContent).toContain('activation.disabled')
    disabled.unmount()
    const healthy = render(<StatusBadge runtime="ready" status="available" health="ok" t={t} />)
    expect(healthy.container.querySelector('[data-health="degraded"]')).toBeNull()
  })
})

describe('event needs', () => {
  it('names the source application and shows the event description', () => {
    const publisher: AppInfo = {
      ...app('tasks'),
      events: [{ type: 'changed', description: 'a task changed', subscription: 'open' }],
    }
    expect(describeNeed('event:tasks#changed', [publisher], new Map(), t)).toMatchObject({
      label: 'tasks title · changed',
      purpose: 'a task changed',
      selector: 'event:tasks#changed',
    })
    expect(describeNeed('event:missing#changed', [publisher], new Map(), t)).toMatchObject({
      label: 'event:missing#changed',
      selector: 'event:missing#changed',
    })
  })
})
