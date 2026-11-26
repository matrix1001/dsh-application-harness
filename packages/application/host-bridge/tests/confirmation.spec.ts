/**
 * The out-of-session confirmation channel: the bridge is the runtime's
 * `ConfirmationPort`, so a call that needs the user's consent — an AI call to a
 * `confirm` operation, with no session dialog that could ask — parks here until
 * a browser answers it. A question nobody can hold (a full table) or that
 * nobody can answer any more (a cancelled call, a stopped application) never
 * lets the call run.
 */

import { describe, expect, it } from 'vitest'
import { CONFIRMATION_CAPACITY } from '../src/index.ts'
import { demoApp, host, secretApp, settle, waitFor } from './harness.ts'

describe('out-of-session confirmation', () => {
  it('parks an AI confirmation until a browser allows it, and the call continues', async () => {
    const { runtime, bridge } = await host([secretApp()])
    await expect(bridge.pendingConfirmations()).toEqual([])
    // An id nobody asked about answers false: a late answer revives nothing.
    expect(bridge.answerConfirmation('confirmation-1', 'denied')).toBe(false)

    const pending = runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {})
    // A parked question is a grant-table read away (the runtime checks the
    // stored grants before it publishes the question), so wait for the FACT
    // instead of guessing how many event-loop turns that takes: a slower run
    // outran the guess and read an empty table.
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [question] = bridge.pendingConfirmations()
    expect(question).toMatchObject({ id: 'confirmation-1', caller: { kind: 'ai' }, capability: 'secret-app#secret' })
    expect(Date.parse(question!.at)).not.toBeNaN()
    expect(question!.reason).toContain('secret-app#secret')
    expect(question!.preview).toMatchObject({ effect: 'write' })
    expect(question!.preview?.args).toBe('{}')

    // Allowing runs the call once, and clears the question.
    expect(bridge.answerConfirmation(question!.id, 'allowed-once')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'success', result: { secret: 42 } })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('withdraws a waiting question without running the call', async () => {
    const { runtime, bridge } = await host([secretApp()])
    const pending = runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [question] = bridge.pendingConfirmations()
    expect(bridge.cancelConfirmation(question!.id)).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(bridge.pendingConfirmations()).toEqual([])
    expect(bridge.cancelConfirmation(question!.id)).toBe(false)
  })

  it('honours a refusal', async () => {
    const { runtime, bridge } = await host([secretApp()])
    const pending = runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [question] = bridge.pendingConfirmations()
    expect(bridge.answerConfirmation(question!.id, 'denied')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('ends a pending question when its call is cancelled', async () => {
    const { runtime, bridge } = await host([secretApp()])
    const controller = new AbortController()
    const pending = runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {}, controller.signal)
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(bridge.pendingConfirmations()).toHaveLength(1)

    controller.abort()
    await settle()
    // The runtime maps a cancelled question to "no channel could deliver an
    // answer", so the call does not run — and the question is gone.
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('fails closed for background callers and answers nothing for a pre-cancelled question', async () => {
    const { bridge } = await host([secretApp()])
    expect(await bridge.ask({
      caller: { kind: 'background', appId: 'worker' },
      capability: 'secret-app#secret', reason: 'background', signal: new AbortController().signal,
    })).toBe('unavailable')
    const controller = new AbortController()
    controller.abort()
    expect(await bridge.ask({
      caller: { kind: 'ai' }, capability: 'secret-app#secret', reason: 'cancelled', signal: controller.signal,
    })).toBe('cancelled')
  })

  it('ends a request that arrives already cancelled, without announcing it', async () => {
    const { runtime, bridge } = await host([secretApp()])
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {}, controller.signal)).resolves.toMatchObject({
      status: 'cancelled', error: { code: 'platform.cancelled' },
    })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('drops a question whose application stopped', async () => {
    const { runtime, bridge } = await host([secretApp()])
    const pending = runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    expect(bridge.pendingConfirmations()).toHaveLength(1)

    await expect(runtime.stop('secret-app')).resolves.toBe('stopped')
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(bridge.pendingConfirmations()).toEqual([])
  })

  it('refuses a call when the table is full, and reports it', async () => {
    const { ctx, runtime, bridge } = await host([secretApp()])
    const warned: string[] = []
    ctx.logger.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn

    const parked = Array.from({ length: CONFIRMATION_CAPACITY }, () =>
      runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {}))
    await waitFor(() => bridge.pendingConfirmations().length === CONFIRMATION_CAPACITY)
    expect(bridge.pendingConfirmations()).toHaveLength(CONFIRMATION_CAPACITY)

    await expect(runtime.call({ kind: 'ai' }, 'secret-app', 'secret', {})).resolves.toMatchObject({
      status: 'rejected', error: { code: 'platform.confirmation-unavailable' },
    })
    expect(warned.join(' ')).toContain('confirmations are already waiting')

    for (const question of bridge.pendingConfirmations()) bridge.answerConfirmation(question.id, 'denied')
    await expect(Promise.all(parked)).resolves.toHaveLength(CONFIRMATION_CAPACITY)
    expect(bridge.pendingConfirmations()).toEqual([])
  })
})

describe('background confirmation', () => {
  it('fails closed instead of parking a question background work cannot answer', async () => {
    const target = demoApp('target')
    const { runtime, bridge } = await host([
      { ...target, ops: { echo: { ...target.ops.echo!, exposure: { peers: 'confirm' } } } },
      { ...demoApp('worker'), calls: ['target'] },
    ])
    await expect(runtime.call({ kind: 'background', appId: 'worker' }, 'target', 'echo', { text: 'x' }))
      .resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(bridge.pendingConfirmations()).toEqual([])
  })
})
