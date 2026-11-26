import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration, AppEvent, CapabilityGrant, GrantStorePort } from '../src/index.ts'

const at = '2026-01-01T00:00:00.000Z'

function store(grants: CapabilityGrant[]): GrantStorePort & { grants: CapabilityGrant[] } {
  const state = { grants }
  return {
    grants: state.grants,
    list: async () => [...state.grants],
    save: async (next) => { state.grants = [...next] },
  }
}

function publisher(over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id: 'publisher', name: 'Publisher', description: 'publishes changes', version: '1.0.0',
    events: {
      changed: { description: 'a task changed', subscription: 'open' },
      private: { description: 'private' },
      other: { description: 'another change', subscription: 'open' },
    },
    ops: {
      publish: {
        description: 'publish a change',
        params: {},
        result: { type: 'json' },
        execute: (_args, ctx) => {
          ctx.publishEvent('changed', [{ appId: 'publisher', type: 'task', id: '1' }])
          return { published: true }
        },
      },
    },
    ...over,
  }
}

function subscriber(over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id: 'subscriber', name: 'Subscriber', description: 'subscribes', version: '1.0.0',
    subscriptions: [{ appId: 'publisher', type: 'changed' }],
    ops: { noop: { description: 'noop', params: {}, result: { type: 'json' }, execute: () => ({}) } },
    ...over,
  }
}

function otherWithoutSubscriptions(): AppDeclaration {
  const { subscriptions: _subscriptions, ...other } = subscriber({ id: 'other' })
  return other
}

function grantFor(appId: string, capabilities: readonly string[]): CapabilityGrant {
  return { caller: { kind: 'app', appId }, capabilities: [...capabilities], grantedAt: at }
}

function grant(capabilities: readonly string[]): CapabilityGrant {
  return grantFor('subscriber', capabilities)
}

describe('events', () => {
  it('delivers a refs-only event to a declared, granted subscriber', async () => {
    const grants = store([grant(['event:publisher#changed'])])
    const runtime = new ApplicationRuntime({ grants, now: () => new Date('2026-11-07T10:00:00Z') })
    const received: AppEvent[] = []
    let off: (() => void) | undefined
    await runtime.register(publisher())
    await runtime.register(subscriber({
      start: async (ctx) => { off = await ctx.subscribe('publisher', 'changed', (event) => { received.push(event) }) },
    }))

    const outcome = await runtime.call({ kind: 'human' }, 'publisher', 'publish', {})
    expect(outcome).toMatchObject({ status: 'success' })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      kind: 'app-event', appId: 'publisher', type: 'changed', eventId: 'event-2',
      occurredAt: '2026-11-07T10:00:00.000Z', refs: [{ appId: 'publisher', type: 'task', id: '1' }],
    })
    // Only identity, time and refs: no business body or changed field values.
    expect(Object.keys(received[0]!)).toEqual(['kind', 'appId', 'type', 'eventId', 'occurredAt', 'refs'])

    // Revoking the event grant ends the live subscription, not only future ones.
    await runtime.revoke({ kind: 'app', appId: 'subscriber' }, 'publisher')
    await runtime.call({ kind: 'human' }, 'publisher', 'publish', {})
    expect(received).toHaveLength(1)
    expect(await runtime.grantsOf()).toEqual([])
    off?.()
    await runtime.stop('subscriber')
  })

  it('removes every subscription when the subscriber stops', async () => {
    const runtime = new ApplicationRuntime({ grants: store([grant(['event:publisher#changed'])]) })
    const received: AppEvent[] = []
    await runtime.register(publisher())
    await runtime.register(subscriber({ start: async (ctx) => { await ctx.subscribe('publisher', 'changed', (event) => { received.push(event) }) } }))
    await runtime.stop('subscriber')
    await runtime.call({ kind: 'human' }, 'publisher', 'publish', {})
    expect(received).toEqual([])
  })

  it('keeps the intent without failing start when a registered publisher has not opened the event', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(publisher({ events: { changed: { description: 'not open yet' } } }))
    const started: string[] = []
    const received: AppEvent[] = []
    await runtime.register(subscriber({
      start: async (ctx) => {
        started.push('started')
        await ctx.subscribe('publisher', 'changed', (event) => { received.push(event) })
      },
    }))
    expect(started).toEqual(['started'])
    // Publishing the closed event skips delivery but keeps the intent.
    runtime.publishEvent('publisher', 'changed')
    expect(received).toEqual([])
    const noop = (): void => {}
    await expect(runtime.subscribe('missing', 'publisher', 'changed', noop)).rejects.toThrow(/no application missing/u)
    await runtime.register(subscriber({ id: 'wide', subscriptions: [
      { appId: 'publisher', type: 'changed' },
      { appId: 'publisher', type: 'unknown' },
      { appId: 'publisher', type: 'private' },
    ] }))
    // Registered but not open is a wait, not a rejection.
    await expect(runtime.subscribe('wide', 'publisher', 'unknown', noop)).resolves.toBeTypeOf('function')
    await expect(runtime.subscribe('wide', 'publisher', 'private', noop)).resolves.toBeTypeOf('function')
    await runtime.register(otherWithoutSubscriptions())
    await expect(runtime.subscribe('other', 'publisher', 'changed', noop)).rejects.toThrow(/does not declare the subscription/u)
    // An unregistered publisher is deferred, not refused: an application may
    // subscribe before the application it watches starts.
    await runtime.register(subscriber({ id: 'watcher', subscriptions: [{ appId: 'ghost', type: 'changed' }] }))
    await expect(runtime.subscribe('watcher', 'ghost', 'changed', noop)).resolves.toBeTypeOf('function')
  })

  it('records a subscription before the approval and delivers once granted', async () => {
    const runtime = new ApplicationRuntime({ grants: store([]) })
    const received: AppEvent[] = []
    await runtime.register(publisher())
    await runtime.register(subscriber())
    await runtime.subscribe('subscriber', 'publisher', 'changed', (event) => { received.push(event) })
    runtime.publishEvent('publisher', 'changed')
    expect(received).toEqual([])
    await runtime.grant({ caller: { kind: 'app', appId: 'subscriber' }, capabilities: ['event:publisher#changed'], grantedAt: at })
    runtime.publishEvent('publisher', 'changed')
    expect(received).toHaveLength(1)
    // Replacing the approval stops delivery but keeps the intent, so approving
    // again resumes it without a restart.
    await runtime.revoke({ kind: 'app', appId: 'subscriber' }, 'publisher')
    runtime.publishEvent('publisher', 'changed')
    expect(received).toHaveLength(1)
    await runtime.grant({ caller: { kind: 'app', appId: 'subscriber' }, capabilities: ['event:publisher#changed'], grantedAt: at })
    runtime.publishEvent('publisher', 'changed')
    expect(received).toHaveLength(2)
    await runtime.stop('subscriber')
  })

  it('defers a subscription whose publisher is not registered yet', async () => {
    const runtime = new ApplicationRuntime({ grants: store([grant(['event:publisher#changed'])]) })
    const received: AppEvent[] = []
    await runtime.register(subscriber())
    await runtime.subscribe('subscriber', 'publisher', 'changed', (event) => { received.push(event) })
    await runtime.register(publisher())
    runtime.publishEvent('publisher', 'changed')
    expect(received).toHaveLength(1)
    await runtime.stop('subscriber')
  })

  it('validates the publisher, event type and every reference', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(publisher())
    expect(() => runtime.publishEvent('missing', 'changed')).toThrow(/no application/u)
    expect(() => runtime.publishEvent('publisher', 'unknown')).toThrow(/does not declare the event/u)
    expect(() => runtime.publishEvent('publisher', 'changed', [{ appId: 'other', type: 'task', id: '1' }]))
      .toThrow(/may reference only its own objects/u)
    expect(() => runtime.publishEvent('publisher', 'changed', [{ appId: 'publisher', type: '', id: '1' }]))
      .toThrow(/may reference only its own objects/u)
    expect(() => runtime.publishEvent('publisher', 'changed', [{ appId: 'publisher', type: 'task', id: '' }]))
      .toThrow(/may reference only its own objects/u)
    const event = runtime.publishEvent('publisher', 'changed')
    expect(event).not.toHaveProperty('refs')
  })

  it('reports a subscriber failure without failing the publisher', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ grants: store([grant(['event:publisher#changed'])]), onProblem: (problem) => { problems.push(problem) } })
    await runtime.register(publisher())
    await runtime.register(subscriber())
    await runtime.subscribe('subscriber', 'publisher', 'changed', () => { throw 'handler broke' })
    expect(await runtime.call({ kind: 'human' }, 'publisher', 'publish', {})).toMatchObject({ status: 'success' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(problems.join(' ')).toContain('handler broke')
    await runtime.subscribe('subscriber', 'publisher', 'changed', async () => { throw null })
    await runtime.call({ kind: 'human' }, 'publisher', 'publish', {})
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(problems.join(' ')).toContain('null')
  })

  it('publishes from the lifecycle context', async () => {
    const runtime = new ApplicationRuntime({ now: () => new Date('2026-11-07T10:00:00Z') })
    await runtime.register(publisher({ start: (ctx) => { ctx.publishEvent('changed') } }))
    await runtime.stop('publisher')
  })

  it('drops a binding when the grant table is replaced without that grant', async () => {
    const runtime = new ApplicationRuntime({ grants: store([grant(['event:publisher#changed'])]) })
    const received: AppEvent[] = []
    await runtime.register(publisher())
    await runtime.register(subscriber())
    await runtime.subscribe('subscriber', 'publisher', 'changed', (event) => { received.push(event) })
    runtime.useGrantStore(store([]))
    runtime.publishEvent('publisher', 'changed')
    expect(received).toEqual([])
    await runtime.stop('subscriber')
  })

  it('drops a binding when the publisher closes the event after it was subscribed', async () => {
    const runtime = new ApplicationRuntime({ grants: store([grant(['event:publisher#changed'])]) })
    const received: AppEvent[] = []
    await runtime.register(publisher())
    await runtime.register(subscriber())
    await runtime.subscribe('subscriber', 'publisher', 'changed', (event) => { received.push(event) })
    await runtime.stop('publisher')
    runtime.unregister('publisher')
    await runtime.register(publisher({ events: { changed: { description: 'now closed', subscription: 'closed' } } }))
    expect(runtime.publishEvent('publisher', 'changed')).toBeDefined()
    expect(received).toEqual([])
    await runtime.stop('subscriber')
  })

  it('skips bindings for another event and drops delivery after the publisher stops', async () => {
    const runtime = new ApplicationRuntime({ grants: store([grant(['event:publisher#changed'])]) })
    const received: AppEvent[] = []
    await runtime.register(publisher())
    await runtime.register(subscriber())
    await runtime.subscribe('subscriber', 'publisher', 'changed', (event) => { received.push(event) })
    runtime.publishEvent('publisher', 'other')
    expect(received).toEqual([])
    // The publisher's stop makes the binding stale; publish returns the event
    // but the live check removes the binding before delivery.
    await runtime.stop('publisher')
    expect(runtime.publishEvent('publisher', 'changed')).toBeDefined()
    expect(received).toEqual([])
    await runtime.stop('subscriber')
  })

  it('drops only the revoked subscriber binding and keeps an unrelated grant and binding', async () => {
    const grants = store([
      grant(['event:publisher#changed', 'capability:storage']),
      grantFor('other', ['event:publisher#changed']),
    ])
    const runtime = new ApplicationRuntime({ grants })
    const forSubscriber: AppEvent[] = []
    const forOther: AppEvent[] = []
    await runtime.register(publisher())
    await runtime.register(subscriber())
    await runtime.register(subscriber({ id: 'other' }))
    await runtime.subscribe('subscriber', 'publisher', 'changed', (event) => { forSubscriber.push(event) })
    await runtime.subscribe('other', 'publisher', 'changed', (event) => { forOther.push(event) })
    // A storage revoke leaves the event grant and the live subscription intact.
    await runtime.revoke({ kind: 'app', appId: 'subscriber' }, 'capability:storage')
    runtime.publishEvent('publisher', 'changed')
    expect(forSubscriber).toHaveLength(1)
    expect(forOther).toHaveLength(1)
    // Revoking the event grant removes only the subscriber's binding; the other
    // subscriber's binding is walked but kept.
    await runtime.revoke({ kind: 'app', appId: 'subscriber' }, 'publisher')
    runtime.publishEvent('publisher', 'changed')
    expect(forSubscriber).toHaveLength(1)
    expect(forOther).toHaveLength(2)
    await runtime.stop('subscriber')
    await runtime.stop('other')
  })

  it('validates event declarations and event grants', async () => {
    expect(() => new ApplicationRuntime().mount(publisher({ events: { 'Bad Type': { description: 'x' } } })))
      .toThrow(/must match/u)
    expect(() => new ApplicationRuntime().mount(publisher({ events: { changed: { description: ' ' } } })))
      .toThrow(/must carry a description/u)
    expect(() => new ApplicationRuntime().mount(publisher({ events: { changed: { description: 'x', subscription: 'confirm' as never } } })))
      .toThrow(/invalid subscription/u)
    expect(() => new ApplicationRuntime().mount(subscriber({ subscriptions: [{ appId: 'Bad', type: 'changed' }] })))
      .toThrow(/malformed subscription source/u)
    expect(() => new ApplicationRuntime().mount(subscriber({ subscriptions: [{ appId: 'publisher', type: 'Bad' }] })))
      .toThrow(/malformed subscription event/u)
    expect(() => new ApplicationRuntime().mount(subscriber({ subscriptions: [{ appId: 'publisher', type: 'changed' }, { appId: 'publisher', type: 'changed' }] })))
      .toThrow(/repeats the subscription/u)

    const runtime = new ApplicationRuntime()
    await runtime.register(publisher())
    await runtime.register(subscriber())
    await runtime.register(otherWithoutSubscriptions())
    expect(() => runtime.validateGrant(grant(['event:publisher']))).toThrow(/event:<application>#<type>/u)
    expect(() => runtime.validateGrant({ caller: { kind: 'app', appId: 'other' }, capabilities: ['event:publisher#changed'], grantedAt: at })).toThrow(/does not declare the subscription/u)
    expect(() => runtime.validateGrant({ caller: { kind: 'ai', sessionId: 's' }, capabilities: ['event:publisher#changed'], grantedAt: at })).toThrow(/do not hold event/u)
    expect(() => runtime.validateGrant({ caller: { kind: 'app', appId: 'other' }, capabilities: ['event:publisher#changed'], grantedAt: at })).toThrow(/does not declare the subscription/u)
    expect(() => runtime.validateGrant(grant(['event:missing#changed']))).toThrow(/unregistered application/u)
    expect(() => runtime.validateGrant(grant(['event:publisher#unknown']))).toThrow(/no event/u)
    expect(() => runtime.validateGrant(grant(['event:publisher#private']))).toThrow(/not open to subscriptions/u)
    expect(() => runtime.validateGrant(grant(['event:publisher#changed']))).not.toThrow()
  })
})
