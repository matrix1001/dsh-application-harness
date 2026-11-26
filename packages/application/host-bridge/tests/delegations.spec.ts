/**
 * The host's durable delegation records over the real runtime and the real
 * bridge: the application port (create/list/read/cancel), the human's send
 * action into an application-area Session, the execution report the tool
 * service writes, cancellation, restart recovery, and the ownership/one-live
 * delegation rules. The only doubles are the platform seams (a fake `agents`
 * service and the Typert transport); the runtime and the store are production.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { AppDeclaration } from '@matrix1001/dsh-application-harness-runtime'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { DelegationInfo } from '../src/types.ts'
import { delegationContextMessage } from '../src/delegations.ts'
import { demoApp, host, settle }
  from './harness.ts'
import type { Host } from './harness.ts'

const at = '2026-01-01T00:00:00.000Z'

/** One application-area Session agent the fake `ctx.agents` answers. */
interface FakeAgent {
  readonly session: { readonly id: string }
  readonly followup: (message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }) => void
  readonly steer?: (message: unknown) => void
  readonly inject?: (message: unknown) => void
}

/** What one send delivered to the fake agent. */
interface Delivered {
  readonly sessionId: string
  readonly texts: readonly string[]
}

/** A fake `ctx.agents` service plus the sends it observed. */
interface AgentsDouble {
  readonly service: { get(id: unknown): FakeAgent | undefined }
  readonly delivered: Delivered[]
  readonly register: (sessionId: string, throwOnFollowup?: boolean | string) => FakeAgent
}

/** Build the fake platform agents service. */
function fakeAgents(): AgentsDouble {
  const sessions = new Map<string, FakeAgent>()
  const delivered: Delivered[] = []
  const service = {
    get: (id: unknown): FakeAgent | undefined => sessions.get(String(id)),
  }
  const register = (sessionId: string, throwOnFollowup: boolean | string = false): FakeAgent => {
    const agent: FakeAgent = {
      session: { id: sessionId },
      followup: (message) => {
        if (typeof throwOnFollowup === 'string') throw throwOnFollowup
        if (throwOnFollowup) throw new Error('the session refused the message')
        const texts = message.content.filter(block => block.type === 'text').map(block => block.text ?? '')
        delivered.push({ sessionId, texts })
      },
    }
    sessions.set(sessionId, agent)
    return agent
  }
  return { service, delivered, register }
}

/** One application that drives the delegation port from its operations. */
function ledgerApp(id = 'ledger'): AppDeclaration {
  const base = demoApp(id)
  return {
    ...base,
    capabilities: ['delegate'],
    ops: {
      ...base.ops,
      prepare: {
        description: 'prepare a pending delegation',
        params: { title: { type: 'string', required: true }, instructions: { type: 'string', required: true } },
        result: { type: 'json' },
        effect: 'write',
        execute: async (args, ctx) => (await ctx.delegations.create(args as { title: string; instructions: string })) as unknown as JsonValue,
      },
      mine: {
        description: 'list my delegations',
        params: {},
        result: { type: 'json' },
        effect: 'read',
        execute: async (_args, ctx) => (await ctx.delegations.list()) as unknown as JsonValue,
      },
      one: {
        description: 'read one of my delegations',
        params: { id: { type: 'string', required: true } },
        result: { type: 'json' },
        effect: 'read',
        execute: async (args, ctx) => ((await ctx.delegations.read((args as { id: string }).id)) ?? null) as unknown as JsonValue,
      },
      cancel: {
        description: 'cancel one of my delegations',
        params: { id: { type: 'string', required: true } },
        result: { type: 'json' },
        effect: 'write',
        execute: async (args, ctx) => (await ctx.delegations.cancel((args as { id: string }).id)) as unknown as JsonValue,
      },
    },
  }
}

/** A durable delegation file outside the harness's per-host temp home. */
function durablePath(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'application-harness-delegations-'))
  return { path: join(directory, 'delegations.json'), cleanup: () => { rmSync(directory, { recursive: true, force: true }) } }
}

/** Grant one application's delegation capability. */
async function grantDelegate(host: Host, appId = 'ledger'): Promise<void> {
  await host.runtime.grant({ caller: { kind: 'app', appId }, capabilities: ['capability:delegate'], grantedAt: at })
}

/** Create one pending delegation through the application's own operation. */
async function prepare(host: Host, title = '写总结', instructions = '总结本周进展', appId = 'ledger'): Promise<DelegationInfo> {
  const outcome = await host.runtime.call({ kind: 'human' }, appId, 'prepare', { title, instructions })
  if (outcome.status !== 'success') throw new Error(`prepare failed: ${JSON.stringify(outcome)}`)
  return outcome.result as unknown as DelegationInfo
}

/** Register the Session as an application-area conversation and give it a fake agent. */
async function openArea(host: Host, agents: AgentsDouble, sessionId: string, throwOnFollowup: boolean | string = false): Promise<void> {
  await host.bridge.registerAppConversation(sessionId)
  agents.register(sessionId, throwOnFollowup)
}

/** The bridge's report service (what the `delegation_report` tool calls). */
function reports(host: Host): { active: (sessionId: string) => Promise<DelegationInfo | undefined>; report: (sessionId: string, input: Record<string, unknown>) => Promise<{ delegationId: string; status: string }> } {
  return host.ctx.get('appDelegations') as never
}

describe('the application delegation port', () => {
  it('creates a pending record, lists and reads it, and persists it across a restart', async () => {
    const durable = durablePath()
    const first = await host([ledgerApp()], {}, { delegationsPath: durable.path })
    await grantDelegate(first)
    const created = await prepare(first)
    expect(created).toMatchObject({ appId: 'ledger', title: '写总结', instructions: '总结本周进展', status: 'pending' })
    expect(created.id).toMatch(/^delegation-/u)
    // The application may not see a Session handle: the port projection has none.
    expect('sessionId' in created).toBe(false)
    expect(await first.bridge.delegations()).toHaveLength(1)
    const list = await first.runtime.call({ kind: 'human' }, 'ledger', 'mine', {})
    expect(list).toMatchObject({ status: 'success', result: [{ id: created.id, status: 'pending' }] })
    const read = await first.runtime.call({ kind: 'human' }, 'ledger', 'one', { id: created.id })
    expect(read).toMatchObject({ status: 'success', result: { id: created.id } })
    await expect(first.bridge.delegation('delegation-missing')).rejects.toThrow(/no delegation/u)
    const path = first.delegationsPath
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 1, delegations: [{ id: created.id }] })
    await first.dispose()

    const second = await host([ledgerApp()], {}, { delegationsPath: path })
    await grantDelegate(second)
    const rows = await second.bridge.delegations('ledger')
    expect(rows).toMatchObject([{ id: created.id, status: 'pending' }])
    await second.dispose()
    durable.cleanup()
  })

  it('refuses the port without the declared capability grant, and never lets one application read another', async () => {
    const denied = await host([ledgerApp()])
    const rejected = await denied.runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' })
    expect(rejected).toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(await denied.bridge.delegations()).toHaveLength(0)
    await denied.dispose()

    const both = await host([ledgerApp('ledger'), ledgerApp('other')])
    await grantDelegate(both, 'ledger')
    await grantDelegate(both, 'other')
    const created = await prepare(both)
    const foreignRead = await both.runtime.call({ kind: 'human' }, 'other', 'one', { id: created.id })
    expect(foreignRead).toMatchObject({ status: 'success', result: null })
    const foreignCancel = await both.runtime.call({ kind: 'human' }, 'other', 'cancel', { id: created.id })
    expect(foreignCancel).toMatchObject({ status: 'failed', error: { code: 'app.delegation-unknown' } })
    // The bridge's record faces enforce the same ownership when an appId is named.
    await expect(both.bridge.delegation(created.id, 'other')).rejects.toThrow(/no delegation/u)
    await expect(both.bridge.cancelDelegation(created.id, 'other')).rejects.toThrow(/no delegation/u)
    await expect(both.bridge.sendDelegation(created.id, 'area-1', '', 'other')).rejects.toThrow(/no delegation/u)
    // The owner still sees the record unchanged.
    expect(await both.bridge.delegation(created.id, 'ledger')).toMatchObject({ status: 'pending' })
    await both.dispose()
  })

})

describe('the human send action', () => {
  it('binds a pending delegation to an application-area Session and delivers instructions plus supplement', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    await openArea(h, agents, 'area-1')
    const sent = await h.bridge.sendDelegation(created.id, 'area-1', '  用户补充  ')
    expect(sent).toMatchObject({ status: 'active', sessionId: 'area-1' })
    expect(agents.delivered).toHaveLength(1)
    const texts = agents.delivered[0]!.texts
    expect(texts.join('\n')).toContain('总结本周进展')
    expect(texts.join('\n')).toContain('用户补充')
    // The supplement is delivered to the Session only: it is not in the record.
    const record = await h.bridge.delegation(created.id)
    expect(JSON.stringify(record)).not.toContain('用户补充')
    expect(record.instructions).toBe('总结本周进展')
    await h.dispose()
  })

  it('refuses a non-application-area Session, a stopped application, a non-pending delegation and a busy Session', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const first = await prepare(h)
    await expect(h.bridge.sendDelegation(first.id, 'ordinary-1', '')).rejects.toThrow(/not an application-area conversation/u)
    await openArea(h, agents, 'area-1')
    await expect(h.bridge.sendDelegation(first.id, 'area-1', 'x'.repeat(4_001))).rejects.toThrow(/at most 4000 characters/u)
    await expect(h.bridge.sendDelegation(first.id, 'area-missing', '')).rejects.toThrow(/not an application-area conversation/u)
    await h.bridge.sendDelegation(first.id, 'area-1', '')
    await expect(h.bridge.sendDelegation(first.id, 'area-1', '')).rejects.toThrow(/only a pending delegation/u)
    const second = await prepare(h, '第二件')
    await expect(h.bridge.sendDelegation(second.id, 'area-1', '')).rejects.toThrow(/already executing another delegation/u)
    const pendingBeforeStop = await prepare(h, '停用前')
    await h.runtime.stop('ledger')
    await expect(h.bridge.sendDelegation(pendingBeforeStop.id, 'area-1', '')).rejects.toThrow(/is stopped/u)
    const third = await h.runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' })
    expect(third.status).toBe('rejected')
    await h.dispose()
  })

  it('records a delivery failure truthfully instead of leaving an active delegation', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    await openArea(h, agents, 'area-1', true)
    await expect(h.bridge.sendDelegation(created.id, 'area-1', '')).rejects.toThrow(/could not be delivered/u)
    expect(await h.bridge.delegation(created.id)).toMatchObject({ status: 'ended', outcome: 'unavailable' })
    await h.dispose()
  })

  it('refuses empty ids, a non-text supplement and an unknown delegation', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    await expect(h.bridge.sendDelegation('', 'area-1', '')).rejects.toThrow(/needs a delegation id/u)
    await expect(h.bridge.sendDelegation(created.id, '', '')).rejects.toThrow(/needs the target application-area session/u)
    await openArea(h, agents, 'area-1')
    await expect(h.bridge.sendDelegation(created.id, 'area-1', 42 as never)).rejects.toThrow(/supplement must be text/u)
    await expect(h.bridge.sendDelegation('delegation-missing', 'area-1', '')).rejects.toThrow(/no delegation delegation-missing/u)
    // Nothing was written by the refusals.
    expect(await h.bridge.delegation(created.id)).toMatchObject({ status: 'pending' })
    await h.dispose()
  })

  it('refuses a target whose application is gone or whose Session has no live agent', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    // A registered application-area conversation whose agent is not mounted: the
    // Session is not running, so nothing can be delivered to it.
    await h.bridge.registerAppConversation('area-no-agent')
    await expect(h.bridge.sendDelegation(created.id, 'area-no-agent', '')).rejects.toThrow(/is not running/u)
    // Unload the owning application entirely: the pending record can never be
    // sent because there is no registration left to deliver for.
    await openArea(h, agents, 'area-1')
    await h.runtime.stop('ledger')
    expect(h.runtime.unregister('ledger')).toBe(true)
    await expect(h.bridge.sendDelegation(created.id, 'area-1', '')).rejects.toThrow(/is not registered/u)
    await h.dispose()
  })

  it('reports a raw non-Error delivery refusal without reading .message', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    await openArea(h, agents, 'area-1', 'the transport vanished')
    await expect(h.bridge.sendDelegation(created.id, 'area-1', ''))
      .rejects.toThrow(/could not be delivered to the session: the transport vanished/u)
    expect(await h.bridge.delegation(created.id)).toMatchObject({ status: 'ended', outcome: 'unavailable' })
    await h.dispose()
  })

  it('reports delivery and state changes to the application pages', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const stream = h.bridge.watch()[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ done: false, value: { kind: 'ready' } })
    const created = await prepare(h)
    await settle()
    const changed = await stream.next()
    expect(changed.done).toBe(false)
    expect(changed.value).toMatchObject({ kind: 'changed', appId: 'ledger' })
    await openArea(h, agents, 'area-1')
    await h.bridge.sendDelegation(created.id, 'area-1', '')
    await settle()
    expect((await stream.next()).value).toMatchObject({ kind: 'changed', appId: 'ledger' })
    await h.dispose()
  })
})

describe('the execution report and cancellation', () => {
  it('moves active to needs-person on a blocker, then to ended on completion, idempotently', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    await openArea(h, agents, 'area-1')
    await h.bridge.sendDelegation(created.id, 'area-1', '')
    expect(await reports(h).active('area-1')).toMatchObject({ id: created.id, status: 'active' })
    const blocked = await reports(h).report('area-1', { outcome: 'blocked', summary: '需要用户选择', question: '选哪个方案？' })
    expect(blocked).toMatchObject({ delegationId: created.id, status: 'needs-person' })
    expect(await h.bridge.delegation(created.id)).toMatchObject({
      status: 'needs-person',
      latestReport: { outcome: 'blocked', summary: '需要用户选择', question: '选哪个方案？' },
    })
    const completed = await reports(h).report('area-1', { outcome: 'completed', summary: '已完成', details: { link: 'note-1' } })
    expect(completed).toMatchObject({ delegationId: created.id, status: 'ended' })
    expect(await h.bridge.delegation(created.id)).toMatchObject({
      status: 'ended',
      outcome: 'completed',
      latestReport: { outcome: 'completed', summary: '已完成', details: { link: 'note-1' } },
    })
    // A retried identical report after the end is idempotent, not an error.
    const retried = await reports(h).report('area-1', { outcome: 'completed', summary: '已完成', details: { link: 'note-1' } })
    expect(retried).toMatchObject({ delegationId: created.id, status: 'ended' })
    // A different report for the same (ended) session is refused.
    await expect(reports(h).report('area-1', { outcome: 'failed', summary: 'different' })).rejects.toThrow(/not executing a delegation/u)
    // The application reads the outcome it owns; no Session data leaks in.
    const read = await h.runtime.call({ kind: 'human' }, 'ledger', 'one', { id: created.id })
    expect(read.status === 'success' ? read.result : undefined).toMatchObject({ status: 'ended', outcome: 'completed' })
    expect(JSON.stringify(read.status === 'success' ? read.result : undefined)).not.toContain('area-1')
    await h.dispose()
  })

  it('rejects reports from an unbound Session and malformed envelopes', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    await openArea(h, agents, 'area-1')
    const created = await prepare(h)
    await expect(reports(h).report('area-1', { outcome: 'completed', summary: 'x' })).rejects.toThrow(/not executing a delegation/u)
    await h.bridge.sendDelegation(created.id, 'area-1', '')
    await expect(reports(h).report('area-1', { outcome: 'blocked', summary: 'need' })).rejects.toThrow(/question/u)
    await expect(reports(h).report('area-1', { outcome: 'done', summary: 'x' })).rejects.toThrow(/outcome/u)
    await expect(reports(h).report('area-1', { outcome: 'failed', summary: '   ' })).rejects.toThrow(/summary/u)
    await expect(reports(h).report('area-1', { outcome: 'failed', summary: 'x', details: { big: 'x'.repeat(20_000) } })).rejects.toThrow(/details/u)
    await expect(reports(h).report('area-2', { outcome: 'failed', summary: 'x' })).rejects.toThrow(/not executing a delegation/u)
    expect(await h.bridge.delegation(created.id)).toMatchObject({ status: 'active' })
    await h.dispose()
  })

  it('cancels pending and live delegations on the human and the application request', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const first = await prepare(h)
    const byHuman = await h.bridge.cancelDelegation(first.id)
    expect(byHuman).toMatchObject({ status: 'ended', outcome: 'cancelled' })
    // Cancelling again is idempotent: the final state is what the caller observes.
    expect(await h.bridge.cancelDelegation(first.id)).toMatchObject({ status: 'ended', outcome: 'cancelled' })
    await expect(reports(h).active('area-1')).resolves.toBeUndefined()

    const second = await prepare(h, '第二件')
    await openArea(h, agents, 'area-1')
    await h.bridge.sendDelegation(second.id, 'area-1', '')
    const byApp = await h.runtime.call({ kind: 'human' }, 'ledger', 'cancel', { id: second.id })
    expect(byApp).toMatchObject({ status: 'success', result: { status: 'ended', outcome: 'cancelled' } })
    // An ended delegation accepts no report any more.
    await expect(reports(h).report('area-1', { outcome: 'completed', summary: 'late' })).rejects.toThrow(/not executing a delegation/u)
    await expect(h.bridge.cancelDelegation('delegation-missing')).rejects.toThrow(/no delegation/u)
    await h.dispose()
  })

  it('recovers in-flight delegations as interrupted after a host restart and never resends', async () => {
    const durable = durablePath()
    const agents = fakeAgents()
    const first = await host([ledgerApp()], { agents: agents.service }, { delegationsPath: durable.path })
    await grantDelegate(first)
    const created = await prepare(first)
    await openArea(first, agents, 'area-1')
    await first.bridge.sendDelegation(created.id, 'area-1', '')
    const path = first.delegationsPath
    await first.dispose()
    expect(agents.delivered).toHaveLength(1)

    const second = await host([ledgerApp()], {}, { delegationsPath: path })
    const recovered = await second.bridge.delegation(created.id)
    expect(recovered).toMatchObject({ status: 'ended', outcome: 'interrupted' })
    expect(agents.delivered).toHaveLength(1)
    await second.dispose()
    durable.cleanup()
  })

  it('fails closed on a corrupt record and reports it instead of silently dropping delegations', async () => {
    const durable = durablePath()
    const broken = await host([ledgerApp()], {}, { delegationsPath: durable.path })
    await grantDelegate(broken)
    const created = await prepare(broken)
    const path = broken.delegationsPath
    await broken.dispose()
    writeFileSync(path, '{"schemaVersion":1,"delegations":[{"id":42}]}')
    const failed = await host([ledgerApp()], {}, { delegationsPath: path })
    await expect(failed.bridge.delegations()).rejects.toThrow(/application delegation needs a unique/u)
    await failed.dispose()
    // The original record is not rewritten by the failed host.
    expect(readFileSync(path, 'utf8')).toContain('"id":42')
    expect(created.id).not.toBe('')
    durable.cleanup()
  })
})

it('mounts with the row default delegation path when the deployment omits the config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'application-harness-delegations-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const h = await host([], {}, { delegationsPath: null })
    try {
      expect(h.delegationsPath).toBe(join(home, 'application-harness/delegations.json'))
      expect(await h.bridge.delegations()).toEqual([])
    } finally {
      await h.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

it('reports a restart recovery that could not be rewritten instead of dropping it', async () => {
  const durable = durablePath()
  // A valid document holding one in-flight delegation: the restart recovery has
  // to rewrite it as interrupted, and the write is refused below.
  writeFileSync(durable.path, JSON.stringify({
    schemaVersion: 1,
    delegations: [{
      id: 'delegation-recovered', appId: 'ledger', title: '恢复', instructions: '继续', status: 'active',
      sessionId: 'area-1', createdAt: at, updatedAt: at,
    }],
  }))
  chmodSync(join(durable.path, '..'), 0o500)
  const warned: string[] = []
  try {
    const h = await host([ledgerApp()], {}, { delegationsPath: durable.path, warn: (line) => { warned.push(line) } })
    // The recovered record is still readable; only the rewrite failed.
    expect(await h.bridge.delegation('delegation-recovered')).toMatchObject({ status: 'ended', outcome: 'interrupted' })
    expect(warned.join('\n')).toContain('could not be rewritten after the restart recovery')
    await h.dispose()
  } finally {
    chmodSync(join(durable.path, '..'), 0o700)
    durable.cleanup()
  }
})

describe('the delegation execution context injection', () => {
  it('does not reject an unrelated pre-step when the delegation table is corrupt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-delegations-corrupt-'))
    const path = join(dir, 'delegations.json')
    writeFileSync(path, '{ not json')
    const warned: string[] = []
    try {
      const h = await host([], {}, { delegationsPath: path, warn: (line) => { warned.push(line) } })
      const agent = { session: { id: 'ordinary-session' } } as unknown as Agent
      const events = agentEvents(h.ctx, agent)
      const decision = await events.waterfall('agent/pre-step', {
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
        modelSelection: { provider: 'test', model: 'test' },
      } as never, () => Promise.resolve({ kind: 'enter', messages: [] } as never))
      expect(decision).toMatchObject({ kind: 'enter', messages: [] })
      expect(warned.join('\n')).toContain('delegation execution context')
      // The failure is reported once, not once per step.
      await events.waterfall('agent/pre-step', {
        messages: [], turn: 1, step: 1, signal: new AbortController().signal,
        modelSelection: { provider: 'test', model: 'test' },
      } as never, () => Promise.resolve({ kind: 'enter', messages: [] } as never))
      expect(warned.filter(line => line.includes('delegation execution context'))).toHaveLength(1)
      await h.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds the platform context to an entering step and leaves a rejecting or unbound step alone', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    await openArea(h, agents, 'area-1')
    const agent = { session: { id: 'area-1' } } as unknown as Agent
    const events = agentEvents(h.ctx, agent)
    const payload = {
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      modelSelection: { provider: 'test', model: 'test' },
    } as never
    const enter = (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] } as never)
    // No live delegation bound to the Session yet: the decision passes through.
    const plain = await events.waterfall('agent/pre-step', payload, enter)
    expect(plain).toMatchObject({ kind: 'enter', messages: [] })
    // A rejecting earlier rung is handed back untouched.
    const rejected = await events.waterfall('agent/pre-step', payload, () => Promise.resolve({ kind: 'reject' } as never))
    expect(rejected).toMatchObject({ kind: 'reject' })
    // While the delegation is active the platform's own context joins the step.
    await h.bridge.sendDelegation(created.id, 'area-1', '')
    const bound = await events.waterfall('agent/pre-step', payload, enter)
    expect(bound.kind).toBe('enter')
    if (bound.kind !== 'enter') throw new Error('expected an enter decision')
    expect(bound.messages).toHaveLength(1)
    expect(bound.messages[0]).toMatchObject({ source: { kind: 'delegation', delegationId: created.id, appId: 'ledger' } })
    // The context is appended once per delegation, not once per step.
    const repeated = await events.waterfall('agent/pre-step', payload, enter)
    expect(repeated).toMatchObject({ kind: 'enter', messages: [] })
    await h.dispose()
  })
})

describe('the trusted execution context', () => {
  it('builds the platform-authored context message the bound Session receives', () => {
    const message = delegationContextMessage({
      id: 'delegation-1',
      appId: 'todo',
      title: '待办：写总结',
      instructions: '总结这周的进展',
      status: 'active',
      sessionId: 'area-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    // The source is the platform's own producer identity, not the application's
    // or the human's: a page cannot manufacture this context.
    expect(message.source).toMatchObject({ kind: 'delegation', delegationId: 'delegation-1', appId: 'todo' })
    const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    expect(text).toContain('todo')
    expect(text).toContain('delegation_report')
    expect(text).toContain('不是权限')
    expect(text).toContain('completed')
    expect(text).toContain('blocked')
    expect(text).toContain('failed')
    // The full instructions are not copied into the context: it orients the
    // model, the human's message carries the work.
    expect(text.length).toBeLessThan(4_000)
  })
})

describe('the delegation report tool gating (host service)', () => {
  it('answers the live delegation for a bound Session only', async () => {
    const agents = fakeAgents()
    const h = await host([ledgerApp()], { agents: agents.service })
    await grantDelegate(h)
    const created = await prepare(h)
    await openArea(h, agents, 'area-1')
    expect(await reports(h).active('area-1')).toBeUndefined()
    await h.bridge.sendDelegation(created.id, 'area-1', '')
    expect(await reports(h).active('area-1')).toMatchObject({ id: created.id })
    expect(await reports(h).active('area-2')).toBeUndefined()
    await h.dispose()
  })
})
