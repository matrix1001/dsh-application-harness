import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DelegationInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { createDelegation } from '../src/client/delegation.ts'
import { ApplicationsShell, type ApplicationsRemote } from '../src/client/shell.ts'

/** One successful Remote answer. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One delegation record (pending unless the case overrides it). */
function delegation(over: Partial<DelegationInfo> = {}): DelegationInfo {
  return {
    id: 'delegation-1',
    appId: 'todo',
    title: '待办：写总结',
    instructions: '总结这周的进展',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** The Remote double the delegation faces use; the other methods stay unmounted. */
function remote(records: readonly DelegationInfo[] = [delegation()]) {
  return {
    delegation: vi.fn(async (id: string): Promise<RemoteResult<DelegationInfo>> => {
      const found = records.find(record => record.id === id)
      if (found === undefined) return { ok: false, error: new Error(`no delegation ${id}`) as never }
      return ok(found)
    }),
    delegations: vi.fn(async (): Promise<RemoteResult<readonly DelegationInfo[]>> => ok(records)),
    sendDelegation: vi.fn(async (id: string, sessionId: string, supplement?: string): Promise<RemoteResult<DelegationInfo>> =>
      ok(delegation({ id, status: 'active', sessionId, ...(supplement === undefined ? {} : {}) }))),
    cancelDelegation: vi.fn(async (id: string): Promise<RemoteResult<DelegationInfo>> =>
      ok(delegation({ id, status: 'ended', outcome: 'cancelled' }))),
  }
}

/** Build one shell over the double. */
function shellOf(
  double: ReturnType<typeof remote>,
  options: ConstructorParameters<typeof ApplicationsShell>[1] = {},
): ApplicationsShell {
  return new ApplicationsShell(double as unknown as ApplicationsRemote, options)
}

describe('the delegation send request', () => {
  it('parks one request, resolves it once and supersedes the older one', async () => {
    const service = createDelegation()
    const seen: string[] = []
    service.state.subscribe(() => { seen.push(service.state.getSnapshot()?.delegation.id ?? 'empty') })
    const first = service.request(delegation())
    expect(service.state.getSnapshot()).toMatchObject({ delegation: { id: 'delegation-1' } })
    service.answer('sent')
    await expect(first).resolves.toBe('sent')
    expect(service.state.getSnapshot()).toBeUndefined()
    const second = service.request(delegation({ id: 'delegation-2' }))
    const third = service.request(delegation({ id: 'delegation-3' }))
    await expect(second).resolves.toBe('unavailable')
    service.answer('cancelled')
    await expect(third).resolves.toBe('cancelled')
    expect(seen).toEqual(['delegation-1', 'empty', 'delegation-2', 'delegation-3', 'empty'])
  })

  it('ignores an answer when no request is pending', () => {
    const service = createDelegation()
    service.answer('cancelled')
    expect(service.state.getSnapshot()).toBeUndefined()
  })
})

describe('the shell delegation faces', () => {
  it('offers a pending delegation to the human and refuses a non-pending one', async () => {
    const pending = delegation()
    const double = remote([pending])
    const offers: DelegationInfo[] = []
    const shell = shellOf(double, {
      delegationRequest: async (record) => { offers.push(record); return 'sent' },
    })
    await shell.viewProps('todo').delegation?.requestSend('delegation-1')
    expect(offers.map(record => record.id)).toEqual(['delegation-1'])
    expect(double.delegation).toHaveBeenCalledWith('delegation-1', 'todo')

    const ended = delegation({ status: 'ended', outcome: 'completed' })
    const endedShell = shellOf(remote([ended]), { delegationRequest: async () => 'sent' })
    await expect(endedShell.viewProps('todo').delegation?.requestSend('delegation-1'))
      .rejects.toThrow(/only a pending delegation/u)
    shell.dispose()
    endedShell.dispose()
  })

  it('sends and cancels through the host and fans the change to the page', async () => {
    const double = remote()
    const shell = shellOf(double)
    let changed = 0
    const stop = shell.onChanged('todo', () => { changed += 1 })

    const bound = await shell.sendDelegation('delegation-1', 'area-1', '补充')
    expect(double.sendDelegation).toHaveBeenCalledWith('delegation-1', 'area-1', '补充')
    expect(bound).toMatchObject({ status: 'active', sessionId: 'area-1' })
    const ended = await shell.cancelDelegation('delegation-1')
    expect(ended).toMatchObject({ status: 'ended', outcome: 'cancelled' })
    expect(changed).toBe(2)
    expect(await shell.delegations('todo')).toHaveLength(1)
    expect(await shell.delegation('delegation-1')).toMatchObject({ id: 'delegation-1' })
    stop()
    shell.dispose()
  })

  it('opens the bound execution Session and refuses one without a binding', async () => {
    const opened: string[] = []
    const boundShell = shellOf(remote([delegation({ status: 'active', sessionId: 'area-1' })]), {
      openSession: (sessionId) => { opened.push(sessionId) },
    })
    await expect(boundShell.viewProps('todo').delegation?.open('delegation-1')).resolves.toBe(true)
    expect(opened).toEqual(['area-1'])
    boundShell.dispose()

    const pendingShell = shellOf(remote())
    await expect(pendingShell.viewProps('todo').delegation?.open('delegation-1')).resolves.toBe(false)
    pendingShell.dispose()

    const noSeat = shellOf(remote([delegation({ status: 'active', sessionId: 'area-1' })]))
    await expect(noSeat.viewProps('todo').delegation?.open('delegation-1')).resolves.toBe(false)
    noSeat.dispose()
  })

  it('answers true only when the cancelled record really ended', async () => {
    const double = remote()
    const shell = shellOf(double)
    await expect(shell.viewProps('todo').delegation?.cancel('delegation-1')).resolves.toBe(true)
    expect(double.cancelDelegation).toHaveBeenCalledWith('delegation-1', 'todo')
    shell.dispose()
  })

  it('reports a rejected cancel or open as a false action on the panel error line', async () => {
    const double = remote()
    double.cancelDelegation.mockResolvedValueOnce({ ok: false, error: new Error('cancel refused') as never })
    double.delegation.mockResolvedValueOnce({ ok: false, error: new Error('open refused') as never })
    const shell = shellOf(double)
    await expect(shell.viewProps('todo').delegation?.cancel('delegation-1')).resolves.toBe(false)
    expect(shell.state.getSnapshot().error).toContain('cancel refused')
    await expect(shell.viewProps('todo').delegation?.open('delegation-1')).resolves.toBe(false)
    expect(shell.state.getSnapshot().error).toContain('open refused')
    shell.dispose()
  })

  it('reports a host refusal as a false action and a Remote failure as a thrown read', async () => {
    const double = remote()
    double.cancelDelegation.mockResolvedValueOnce({ ok: false, error: new Error('refused') as never })
    const shell = shellOf(double)
    await expect(shell.viewProps('todo').delegation?.cancel('delegation-1')).resolves.toBe(false)
    const missing = shellOf(remote([]))
    await expect(missing.delegation('delegation-missing')).rejects.toThrow(/no delegation/u)
    shell.dispose()
    missing.dispose()
  })
})
