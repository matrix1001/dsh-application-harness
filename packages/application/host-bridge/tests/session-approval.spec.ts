/**
 * The in-session confirmation route: a call the AI makes inside a running
 * session turn asks through the platform's User Approval service, so the
 * question lands in the session dialog the user is already in. Every other
 * call — a host-side caller, an idle session, a deployment with no approval
 * service — parks in the browser table exactly as before. Neither route may
 * turn "nobody could answer" into an allow.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { demoApp, host, secretApp, waitFor } from './harness.ts'
import type { ApprovalAsk } from './harness.ts'

/** The caller's session id; the fake registry resolves exactly this one. */
const SESSION_ID = 'session-1'

/** A session whose log reads as the given event types, oldest first. */
function sessionOf(...events: string[]): Session {
  return {
    id: SESSION_ID,
    seq: events.length,
    eventAt: (seq: number) => ({ type: events[seq] }),
  } as unknown as Session
}

/** The fake approval service: every ask is recorded, and the scripted outcome answers it. */
function approvalAnswering(outcome: string | (() => Promise<string>), asks: ApprovalAsk[] = []) {
  return {
    asks,
    service: {
      request: async (request: ApprovalAsk): Promise<string> => {
        asks.push(request)
        return typeof outcome === 'function' ? await outcome() : outcome
      },
    },
  }
}

/**
 * The fake agent registry: the caller's session resolves to one live agent (or
 * none). `currentInitiator` is present only to prove the route does not use it.
 */
function agentsWith(session: Session | undefined) {
  return {
    currentInitiator: () => (session === undefined ? undefined : { session }),
    get: (id: unknown) => (session === undefined || String(id) !== SESSION_ID ? undefined : { session }),
  }
}

describe('the session approval route', () => {
  it('asks the platform approval service when a turn is open, and runs the call on allowed-once', async () => {
    const { asks, service } = approvalAnswering('allowed-once')
    // A real in-turn log: the turn is open and the newest event is not itself a
    // turn boundary (the check reads back past the events inside the turn).
    const session = sessionOf('turn/start', 'step/start', 'tool/call')
    const { runtime, bridge } = await host([secretApp()], { approval: service, agents: agentsWith(session) })

    await expect(runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})).resolves.toMatchObject({
      status: 'success',
      result: { secret: 42 },
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.agent).toEqual({ session })
    expect(asks[0]!.toolName).toBe('secret-app#secret')
    expect(asks[0]!.reason).toContain('secret-app#secret')
    expect(asks[0]!.signal).toBeInstanceOf(AbortSignal)
    // The question never reached the browser table: this session had a dialog.
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('maps a rejection to denied', async () => {
    const { service } = approvalAnswering('rejected')
    const { runtime, bridge } = await host([secretApp()], { approval: service, agents: agentsWith(sessionOf('turn/start')) })

    await expect(runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})).resolves.toMatchObject({
      status: 'rejected', error: { code: 'platform.denied' },
    })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('maps a withdrawn question to a rejection, never to a grant', async () => {
    const { service } = approvalAnswering('cancelled')
    const { runtime, bridge } = await host([secretApp()], { approval: service, agents: agentsWith(sessionOf('turn/start')) })

    await expect(runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})).resolves.toMatchObject({
      status: 'rejected', error: { code: 'platform.confirmation-unavailable' },
    })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('fails closed on an unavailable answerer: the call does not run and does not fall back', async () => {
    const { service } = approvalAnswering('unavailable')
    const { runtime, bridge } = await host([secretApp()], { approval: service, agents: agentsWith(sessionOf('turn/start')) })

    await expect(runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})).resolves.toMatchObject({
      status: 'rejected', error: { code: 'platform.confirmation-unavailable' },
    })
    // A route that could not deliver the question does not hand it to a second
    // one behind the user's back.
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('fails closed when the approval service throws, and reports it', async () => {
    const { ctx, runtime, bridge } = await host([secretApp()], {
      approval: { request: () => Promise.reject(new Error('no audit sink')) },
      agents: agentsWith(sessionOf('turn/start')),
    })
    const warned: string[] = []
    ctx.logger.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn

    await expect(runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})).resolves.toMatchObject({
      status: 'rejected', error: { code: 'platform.confirmation-unavailable' },
    })
    expect(bridge.pendingConfirmations()).toEqual([])
    expect(warned.join(' ')).toContain('could not be asked: Error: no audit sink')
  })

  it('falls back to the browser table when the session has no open turn', async () => {
    const { asks, service } = approvalAnswering('allowed-once')
    const { runtime, bridge } = await host([secretApp()], {
      approval: service,
      agents: agentsWith(sessionOf('turn/start', 'turn/end')),
    })

    const pending = runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})
    // Parked in the browser table: a grant-table read away, so wait for the
    // question to be there rather than guessing how many turns that takes.
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(asks).toEqual([])
    const [question] = bridge.pendingConfirmations()
    expect(question).toBeDefined()
    bridge.answerConfirmation(question!.id, 'allowed-once')
    await expect(pending).resolves.toMatchObject({ status: 'success' })
  })

  it('falls back to the browser table for an agent whose session has no events yet', async () => {
    const { asks, service } = approvalAnswering('allowed-once')
    const { runtime, bridge } = await host([secretApp()], { approval: service, agents: agentsWith(sessionOf()) })

    const pending = runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(asks).toEqual([])
    expect(bridge.pendingConfirmations()).toHaveLength(1)
    bridge.answerConfirmation(bridge.pendingConfirmations()[0]!.id, 'denied')
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
  })

  it('does not route an anonymous AI call through an ambient initiator', async () => {
    const { asks, service } = approvalAnswering('allowed-once')
    // The ambient chain has an agent with an open turn, but the call itself
    // names no session: it must park in the browser table, not borrow that
    // agent's dialog.
    const { runtime, bridge } = await host([secretApp()], { approval: service, agents: agentsWith(sessionOf('turn/start')) })

    const pending = runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(asks).toEqual([])
    expect(bridge.pendingConfirmations()).toHaveLength(1)
    bridge.answerConfirmation(bridge.pendingConfirmations()[0]!.id, 'denied')
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
  })

  it('falls back to the browser table when no live agent has the caller\'s session', async () => {
    const { asks, service } = approvalAnswering('allowed-once')
    const { runtime, bridge } = await host([secretApp()], { approval: service, agents: agentsWith(undefined) })

    const pending = runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(asks).toEqual([])
    expect(bridge.pendingConfirmations()).toHaveLength(1)
    bridge.answerConfirmation(bridge.pendingConfirmations()[0]!.id, 'denied')
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
  })

  it('parks a host-initiated application call, but fails background work closed', async () => {
    const { asks, service } = approvalAnswering('allowed-once')
    const target = {
      ...demoApp('target'),
      ops: {
        secret: {
          description: 'needs consent',
          params: {},
          result: { type: 'json' as const },
          exposure: { peers: 'confirm' as const },
          execute: () => ({ secret: 42 }),
        },
      },
    }
    const caller = demoApp('caller', { calls: ['target'] })
    // The ambient chain is an AI turn; a host-initiated app call has no source
    // Session, so the open dialog is not theirs to use.
    const { runtime, bridge } = await host([caller, target], { approval: service, agents: agentsWith(sessionOf('turn/start')) })

    const pending = runtime.call({ kind: 'app', appId: 'caller' }, 'target', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(asks).toEqual([])
    bridge.answerConfirmation(bridge.pendingConfirmations()[0]!.id, 'denied')
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })

    // Background work has no interactive channel at all.
    await expect(runtime.call({ kind: 'background', appId: 'caller' }, 'target', 'secret', {}))
      .resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('falls back to the browser table when no approval service is mounted', async () => {
    const { runtime, bridge } = await host([secretApp()], { agents: agentsWith(sessionOf('turn/start')) })

    const pending = runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(bridge.pendingConfirmations()).toHaveLength(1)
    bridge.answerConfirmation(bridge.pendingConfirmations()[0]!.id, 'allowed-once')
    await expect(pending).resolves.toMatchObject({ status: 'success' })
  })

  it('falls back to the browser table when neither platform service is mounted', async () => {
    const { runtime, bridge } = await host([secretApp()])

    const pending = runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(bridge.pendingConfirmations()).toHaveLength(1)
    bridge.answerConfirmation(bridge.pendingConfirmations()[0]!.id, 'denied')
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
  })
})

describe('peer calls inherit the source interaction context', () => {
  it('asks a synchronous A to B confirmation in the source session dialog', async () => {
    const { asks, service } = approvalAnswering('allowed-once')
    const session = sessionOf('turn/start', 'step/start')
    const target = demoApp('target')
    const source = demoApp('source')
    const { runtime, bridge } = await host([
      { ...target, ops: { echo: { ...target.ops.echo!, exposure: { peers: 'confirm' } } } },
      {
        ...source,
        calls: ['target'],
        ops: {
          relay: {
            description: 'relay to target',
            params: {},
            result: { type: 'json' },
            exposure: { ai: 'open' },
            execute: async (_args, ctx) => {
              const outcome = await ctx.call('target', 'echo', { text: 'peer' })
              return { status: outcome.status }
            },
          },
        },
      },
    ], { approval: service, agents: agentsWith(session) })

    await expect(runtime.call({ kind: 'ai', sessionId: SESSION_ID }, 'source', 'relay', {})).resolves.toMatchObject({
      status: 'success',
      result: { status: 'success' },
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]!.toolName).toBe('target#echo')
    expect(bridge.pendingConfirmations()).toEqual([])
  })
})
