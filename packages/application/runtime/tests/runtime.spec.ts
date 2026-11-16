/**
 * The runtime's rule book: one call path for every caller class, permission and
 * confirmation without a session, a lifecycle that reports what actually
 * happened, and history that never blocks business.
 */
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime, AppError, assertDeclarable } from '../src/runtime.ts'
import type { ConfirmationPort, GrantStorePort, HistoryRecord } from '../src/runtime.ts'
import { BoundedHistoryQueue, MemoryHistory } from '../src/history.ts'
import type { AppDeclaration, Caller, CallOutcome, CapabilityGrant } from '../src/types.ts'

/** One operation that returns its arguments (a probe for "did it run"). */
function echoApp(id: string, over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} app`,
    version: '1.0.0',
    ops: {
      echo: {
        description: 'returns its argument',
        params: { text: { type: 'string', required: true } },
        result: { type: 'string' },
        execute: (args) => (args as { text: string }).text,
      },
    },
    ...over,
  }
}

/** A peer-facing application that calls another app through ctx.call. */
function callerApp(id: string, target: string, over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} app`,
    version: '1.0.0',
    calls: [target],
    ops: {
      relay: {
        description: 'calls the target as this application',
        params: { text: { type: 'string', required: true } },
        result: { type: 'string' },
        execute: async (args, ctx) => {
          const outcome = await ctx.call(target, 'echo', args)
          return JSON.stringify(outcome)
        },
      },
    },
    ...over,
  }
}

const asUser: Caller = { kind: 'human' }
const asAi: Caller = { kind: 'ai' }
const asAiSession: Caller = { kind: 'ai', sessionId: 'session-1' }
const asApp = (appId: string): Caller => ({ kind: 'app', appId })

describe('registration', () => {
  it('refuses a duplicate id, a malformed declaration and an unsupported schema', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(echoApp('one'))
    await expect(runtime.register(echoApp('one'))).rejects.toThrow(/already registered/u)
    await expect(runtime.register({ ...echoApp('two'), id: 'Bad Id' })).rejects.toThrow(/must match/u)
    await expect(runtime.register({ ...echoApp('three'), name: ' ' })).rejects.toThrow(/name and a description/u)
    await expect(runtime.register({ ...echoApp('four'), ops: {} })).rejects.toThrow(/no operations/u)
    await expect(runtime.register({
      ...echoApp('five'),
      ops: { echo: { ...echoApp('five').ops.echo!, description: '' } },
    })).rejects.toThrow(/must carry a description/u)
    await expect(runtime.register({
      ...echoApp('six'),
      ops: { '1bad': echoApp('six').ops.echo! },
    })).rejects.toThrow(/must match/u)
    await expect(runtime.register({
      ...echoApp('seven'),
      ops: { echo: { ...echoApp('seven').ops.echo!, params: { bad: { type: 'nonsense' } } as never } },
    })).rejects.toThrow(/unsupported schema/u)
    await expect(runtime.register({ ...echoApp('eight'), calls: ['eight'] })).rejects.toThrow(/call to itself/u)
  })

  it('reports a start failure as a visible, uncallable state', async () => {
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(echoApp('broken', {
      start: () => { throw new Error('no storage') },
    }))
    expect(registration.status()).toBe('failed')
    expect(registration.failure()).toContain('no storage')
    const outcome = await runtime.call(asUser, 'broken', 'echo', { text: 'x' })
    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
  })

  it('rejects an unknown application and an unknown operation', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(echoApp('one'))
    expect(await runtime.call(asUser, 'nope', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.unknown-app' } })
    expect(await runtime.call(asUser, 'one', 'nope', {})).toMatchObject({ status: 'rejected', error: { code: 'platform.unknown-op' } })
  })
})

describe('one path for every caller', () => {
  it('runs the same implementation and the same argument check for human, AI and peer callers', async () => {
    const runtime = new ApplicationRuntime()
    const seen: Caller[] = []
    await runtime.register(echoApp('target', {
      ops: {
        echo: {
          description: 'records the caller',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          exposure: { ai: 'open', peers: 'open' },
          execute: (args, ctx) => { seen.push(ctx.caller); return (args as { text: string }).text },
        },
      },
    }))
    await runtime.register(callerApp('caller', 'target'))
    await runtime.grant({ caller: asApp('caller'), capabilities: ['target#echo'], grantedAt: '2026-01-01T00:00:00.000Z' })

    expect(await runtime.call(asUser, 'target', 'echo', { text: 'a' })).toMatchObject({ status: 'success', result: 'a' })
    expect(await runtime.call(asAi, 'target', 'echo', { text: 'b' })).toMatchObject({ status: 'success', result: 'b' })
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'c' })).toMatchObject({ status: 'success', result: 'c' })
    expect(seen).toEqual([asUser, asAi, asApp('caller')])

    // The same declaration rejects the same bad arguments for every caller.
    for (const caller of [asUser, asAi, asApp('caller')]) {
      expect(await runtime.call(caller, 'target', 'echo', {})).toMatchObject({ status: 'rejected', error: { code: 'platform.invalid-args' } })
    }
  })

  it('carries the calling application identity through a chained call', async () => {
    const runtime = new ApplicationRuntime()
    const callers: Caller[] = []
    await runtime.register({
      ...echoApp('third'),
      ops: {
        echo: {
          ...echoApp('third').ops.echo!,
          exposure: { peers: 'open' },
          execute: (args, ctx) => { callers.push(ctx.caller); return (args as { text: string }).text },
        },
      },
    })
    await runtime.register({
      ...callerApp('middle', 'third'),
      ops: {
        relay: {
          description: 'relays to third',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          exposure: { peers: 'open' },
          execute: async (args, ctx) => JSON.stringify(await ctx.call('third', 'echo', args)),
        },
      },
    })
    await runtime.register({
      ...echoApp('origin'),
      calls: ['middle'],
      ops: {
        relay: {
          description: 'relays to middle',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          exposure: { peers: 'open' },
          execute: async (args, ctx) => JSON.stringify(await ctx.call('middle', 'relay', args)),
        },
      },
    })
    const grantedAt = '2026-01-01T00:00:00.000Z'
    await runtime.grant({ caller: asApp('origin'), capabilities: ['middle#relay'], grantedAt })
    await runtime.grant({ caller: asApp('middle'), capabilities: ['third#echo'], grantedAt })

    const outcome = await runtime.call(asApp('origin'), 'middle', 'relay', { text: 'deep' })
    expect(outcome).toMatchObject({ status: 'success' })
    // origin → middle ran as origin; middle → third ran as middle, not origin.
    expect(callers).toEqual([asApp('middle')])
  })

  it('refuses a peer call the caller never declared, and one the target never opened', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(echoApp('closed')) // no exposure
    await runtime.register({ ...callerApp('undeclared', 'closed'), calls: [] })
    await runtime.register(callerApp('declared', 'closed'))
    expect(await runtime.call(asApp('undeclared'), 'closed', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })
    expect(await runtime.call(asApp('declared'), 'closed', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })
  })
})

describe('permission', () => {
  it('keeps an AI call closed by default and refuses it without a confirmation channel', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(echoApp('plain'))
    expect(await runtime.call(asAi, 'plain', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })

    await runtime.register({
      ...echoApp('guarded'),
      ops: { echo: { ...echoApp('guarded').ops.echo!, exposure: { ai: 'confirm' } } },
    })
    expect(await runtime.call(asAi, 'guarded', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
  })

  it('honours a confirmation channel, including denial and an unusable channel', async () => {
    const answers: string[] = ['allowed-once']
    const port: ConfirmationPort = { ask: () => Promise.resolve(answers.shift() as 'allowed-once') }
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation(port)
    await runtime.register({
      ...echoApp('guarded'),
      ops: { echo: { ...echoApp('guarded').ops.echo!, exposure: { ai: 'confirm' } } },
    })
    expect(await runtime.call(asAiSession, 'guarded', 'echo', { text: 'x' })).toMatchObject({ status: 'success', result: 'x' })
    answers.push('denied')
    expect(await runtime.call(asAi, 'guarded', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    answers.push('cancelled')
    expect(await runtime.call(asAi, 'guarded', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })

    const throwing: ConfirmationPort = { ask: () => { throw new Error('channel down') } }
    const problems: string[] = []
    const second = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    second.useConfirmation(throwing)
    await second.register({
      ...echoApp('guarded'),
      ops: { echo: { ...echoApp('guarded').ops.echo!, exposure: { ai: 'confirm' } } },
    })
    expect(await second.call(asAiSession, 'guarded', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(problems.join(' ')).toContain('channel down')
  })

  it('allows one confirmation for one call and never remembers it', async () => {
    const asked: string[] = []
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation({ ask: (request) => { asked.push(request.capability); return Promise.resolve('allowed-once') } })
    await runtime.register({
      ...echoApp('guarded'),
      ops: { echo: { ...echoApp('guarded').ops.echo!, exposure: { ai: 'confirm' } } },
    })
    expect(await runtime.call(asAiSession, 'guarded', 'echo', { text: 'x' })).toMatchObject({ status: 'success', result: 'x' })
    expect(await runtime.call(asAiSession, 'guarded', 'echo', { text: 'y' })).toMatchObject({ status: 'success', result: 'y' })
    expect(asked).toEqual(['guarded#echo', 'guarded#echo'])
    expect(await runtime.grantsOf()).toEqual([])
  })

  it('keeps a caller grant for the same application id across unregister and re-register', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('target'),
      ops: { echo: { ...echoApp('target').ops.echo!, exposure: { peers: 'open' } } },
    })
    await runtime.register(callerApp('caller', 'target'))
    await runtime.grant({ caller: asApp('caller'), capabilities: ['target#echo'], grantedAt: '2026-01-01T00:00:00.000Z' })
    await runtime.stop('caller')
    runtime.unregister('caller')
    // appId is the identity: unregistering the application does not erase what
    // the user approved for it; a re-registered application with the same id
    // inherits the approval (and the permission check still applies).
    expect(await runtime.grantsOf()).toMatchObject([{ caller: asApp('caller'), capabilities: ['target#echo'] }])
    await runtime.register(callerApp('caller', 'target'))
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
  })

  it('applies one user policy to peer calls, and default follows the author rule', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('target'),
      ops: { echo: { ...echoApp('target').ops.echo!, exposure: { peers: 'open' } } },
    })
    await runtime.register(callerApp('caller', 'target'))
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })

    await runtime.setPolicy('target', 'echo', 'confirm')
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })

    await runtime.setPolicy('target', 'echo', 'allow')
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })

    await runtime.setPolicy('target', 'echo', 'forbid')
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })

    await runtime.setPolicy('target', 'echo', 'default')
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    expect(await runtime.policiesOf()).toEqual([])
  })

  it('does not extend a user policy to another operation', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('target'),
      ops: {
        echo: { ...echoApp('target').ops.echo!, exposure: { peers: 'confirm' } },
        other: {
          description: 'another operation',
          params: {},
          result: { type: 'string' },
          exposure: { peers: 'confirm' },
          execute: () => 'other',
        },
      },
    })
    await runtime.register(callerApp('caller', 'target'))
    await runtime.setPolicy('target', 'echo', 'allow')
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    expect(await runtime.call(asApp('caller'), 'target', 'other', {})).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
  })

  it('reports a grant save failure instead of claiming success, and never widens on a read failure', async () => {
    const failing: GrantStorePort = {
      list: () => Promise.resolve([]),
      save: () => Promise.reject(new Error('disk full')),
    }
    const runtime = new ApplicationRuntime()
    runtime.useGrantStore(failing)
    await expect(runtime.grant({ caller: asApp('caller'), capabilities: ['target#echo'], grantedAt: '2026-01-01T00:00:00.000Z' })).rejects.toThrow(/disk full/u)

    const unreadable: GrantStorePort = {
      list: () => Promise.reject(new Error('corrupt')),
      save: () => Promise.resolve(),
    }
    const strict = new ApplicationRuntime()
    strict.useGrantStore(unreadable)
    await strict.register({
      ...echoApp('target'),
      ops: { echo: { ...echoApp('target').ops.echo!, exposure: { peers: 'confirm' } } },
    })
    await strict.register(callerApp('caller', 'target'))
    await expect(strict.call(asApp('caller'), 'target', 'echo', { text: 'x' })).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
  })

  it('keeps an operation closed to peers when the caller is not registered at all', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('target'),
      ops: { echo: { ...echoApp('target').ops.echo!, exposure: { peers: 'open' } } },
    })
    expect(await runtime.call(asApp('ghost'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })
  })
})

describe('grant table consistency', () => {
  /** A grant store whose reads and writes are both slow enough to overlap. */
  function slowStore(initial: CapabilityGrant[] = []): { store: GrantStorePort; held: () => CapabilityGrant[] } {
    let held = [...initial]
    const tick = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 1) }) }
    return {
      store: {
        list: async () => { await tick(); return [...held] },
        save: async (grants) => { await tick(); held = [...grants] },
      },
      held: () => [...held],
    }
  }

  it('serializes overlapping changes: a grant racing a revoke neither restores it nor gets lost', async () => {
    const { store, held } = slowStore()
    const runtime = new ApplicationRuntime()
    runtime.useGrantStore(store)
    const caller = asApp('caller')
    await runtime.grant({ caller, capabilities: ['target#delete'], grantedAt: '2026-01-01T00:00:00.000Z' })
    // Both start from the same moment: without one serial read-modify-write the
    // second save would be computed from the pre-revoke snapshot and put the
    // revoked capability back.
    await Promise.all([
      runtime.revoke(caller, 'target#delete'),
      runtime.grant({ caller, capabilities: ['target#read'], grantedAt: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(held().flatMap((grant) => grant.capabilities)).toEqual(['target#read'])
    expect(await runtime.grantsOf()).toMatchObject([{ capabilities: ['target#read'] }])
  })

  it('never lets a read that started before a change restore what the change removed', async () => {
    const caller = asApp('owner')
    let held: CapabilityGrant[] = [{ caller, capabilities: ['capability:model'], grantedAt: '2026-01-01T00:00:00.000Z' }]
    let reads = 0
    const runtime = new ApplicationRuntime()
    runtime.useGrantStore({
      // The FIRST read of the process is the slow one: it arrives before the
      // revoke and answers after every queued change has run, carrying the
      // table as of its arrival — which is history by the time it is handed
      // over. The wait is a real timer on purpose: the change must be free to
      // finish first, which is exactly the interleaving under test.
      list: async () => {
        const answer = [...held]
        reads += 1
        if (reads === 1) await new Promise((resolve) => { setTimeout(resolve, 1) })
        return answer
      },
      save: async (grants) => { held = [...grants] },
    })
    await runtime.register({ ...echoApp('owner'), capabilities: ['model'] })
    const early = runtime.grantsOf()
    const revoked = runtime.revoke(caller, 'capability:model')
    // The read answers the table it really saw; the revoke saves the emptied
    // one. The late read must not put the revoked capability back — not in the
    // store, not in the cache the next check reads.
    expect(await early).toMatchObject([{ capabilities: ['capability:model'] }])
    await revoked
    expect(held).toEqual([])
    expect(await runtime.grantsOf()).toEqual([])
    expect(await runtime.checkCapability(caller, 'model')).toBe('not-approved')
  })

  it('answers a read from the store that is installed when it lands, not the one it started on', async () => {
    const caller = asApp('owner')
    const first: CapabilityGrant[] = [{ caller, capabilities: ['capability:model'], grantedAt: '' }]
    const second: CapabilityGrant[] = [{ caller, capabilities: ['capability:http'], grantedAt: '' }]
    const started = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<void>()
    const runtime = new ApplicationRuntime()
    runtime.useGrantStore({
      list: async () => { started.resolve(); await answered.promise; return [...first] },
      save: async () => {},
    })
    const early = runtime.grantsOf()
    await started.promise
    // The host replaces the store while the first read is still in flight: what
    // that read fetched belongs to the store that was installed then and must
    // never become the new store's answer.
    runtime.useGrantStore({ list: async () => [...second], save: async () => {} })
    answered.resolve()
    expect(await early).toMatchObject([{ capabilities: ['capability:http'] }])
    expect(await runtime.grantsOf()).toMatchObject([{ capabilities: ['capability:http'] }])
  })

  it('does not publish a change computed for a store the host replaced mid-save', async () => {
    const caller = asApp('owner')
    const saving = Promise.withResolvers<void>()
    const saved = Promise.withResolvers<void>()
    const runtime = new ApplicationRuntime()
    runtime.useGrantStore({
      list: async () => [],
      save: async () => { saving.resolve(); await saved.promise },
    })
    const granting = runtime.grant({ caller, capabilities: ['capability:model'], grantedAt: '' })
    await saving.promise
    runtime.useGrantStore({ list: async () => [], save: async () => {} })
    saved.resolve()
    await granting
    expect(await runtime.grantsOf()).toEqual([])
  })

  it('keeps a whole batch of overlapping grants and revokes consistent with the store', async () => {
    const { store, held } = slowStore()
    const runtime = new ApplicationRuntime()
    runtime.useGrantStore(store)
    const caller = asApp('caller')
    await runtime.grant({ caller, capabilities: ['a#one', 'a#two'], grantedAt: '' })
    await Promise.all([
      runtime.grant({ caller, capabilities: ['b#one'], grantedAt: '' }),
      runtime.revoke(caller, 'a#one'),
      runtime.grant({ caller: asApp('other'), capabilities: ['a#one'], grantedAt: '' }),
      runtime.revoke(caller, 'a#two'),
    ])
    expect(held().flatMap((grant) => grant.capabilities).sort()).toEqual(['a#one', 'b#one'])
    expect(await runtime.grantsOf()).toMatchObject([
      { caller: { kind: 'app', appId: 'caller' }, capabilities: ['b#one'] },
      { caller: { kind: 'app', appId: 'other' }, capabilities: ['a#one'] },
    ])
  })

  it('reads a fresh runtime’s grants from the store, not from the process that wrote them', async () => {
    const { store } = slowStore()
    const first = new ApplicationRuntime()
    first.useGrantStore(store)
    await first.grant({ caller: asApp('owner'), capabilities: ['capability:model'], grantedAt: '2026-01-01T00:00:00.000Z' })
    // A restart: a new runtime, the same durable table.
    const second = new ApplicationRuntime()
    second.useGrantStore(store)
    expect(await second.grantsOf()).toMatchObject([{ capabilities: ['capability:model'] }])
    await second.revoke(asApp('owner'), 'capability:model')
    const third = new ApplicationRuntime()
    third.useGrantStore(store)
    expect(await third.grantsOf()).toEqual([])
  })

  it('reports a failed save and never reports the unsaved change as effective', async () => {
    const problems: string[] = []
    let held: CapabilityGrant[] = [{ caller: asApp('owner'), capabilities: ['capability:model'], grantedAt: '' }]
    let reads = 0
    const runtime = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    runtime.useGrantStore({
      list: () => { reads += 1; return Promise.resolve([...held]) },
      save: (grants) => {
        // The write fails AND the store keeps what it had: the effective table
        // must stay exactly that.
        held = [...held]
        return grants.length > 1 ? Promise.reject(new Error('disk full')) : Promise.resolve().then(() => { held = [...grants] })
      },
    })
    await expect(runtime.grant({ caller: asApp('owner'), capabilities: ['target#echo'], grantedAt: '' })).rejects.toThrow(/disk full/u)
    // The failed change was not cached: the next read asks the store again and
    // sees only what is really there.
    const before = reads
    expect(await runtime.grantsOf()).toMatchObject([{ capabilities: ['capability:model'] }])
    expect(reads).toBeGreaterThan(before)
    // A revoke that the store accepts still works after the failed grant.
    await runtime.revoke(asApp('owner'), 'capability:model')
    expect(await runtime.grantsOf()).toEqual([])
    expect(problems).toEqual([])
  })
})

describe('execution outcomes', () => {
  it('separates a throw from an invalid result, and never retries', async () => {
    const runtime = new ApplicationRuntime()
    let runs = 0
    await runtime.register({
      ...echoApp('bad'),
      ops: {
        boom: {
          description: 'throws',
          params: {},
          result: { type: 'string' },
          execute: () => { runs += 1; throw new Error('midway') },
        },
        wrong: {
          description: 'returns the wrong shape',
          params: {},
          result: { type: 'string' },
          execute: () => 42 as never,
        },
      },
    })
    expect(await runtime.call(asUser, 'bad', 'boom', {})).toMatchObject({ status: 'failed', error: { code: 'platform.execution-failed', message: 'midway' }})
    expect(runs).toBe(1)
    const invalid = await runtime.call(asUser, 'bad', 'wrong', {})
    expect(invalid).toMatchObject({ status: 'failed', error: { code: 'platform.invalid-result' } })
  })

  it('carries a business refusal code through, keeping the failure a failure', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('careful'),
      ops: {
        echo: {
          description: 'refuses with a business code',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: () => { throw new AppError('stale-version', 'the object moved on', true) },
        },
      },
    })
    const outcome = await runtime.call(asUser, 'careful', 'echo', { text: 'x' })
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'app.stale-version', message: 'the object moved on' }})
  })

  it('treats a cancel request as a request: work that finishes anyway reports what it did', async () => {
    const controller = new AbortController()
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('slow'),
      ops: {
        echo: {
          description: 'finishes regardless',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: (args) => (args as { text: string }).text,
        },
        obeying: {
          description: 'honours the abort',
          params: {},
          result: { type: 'string' },
          execute: (_args, ctx) => {
            controller.abort()
            if (ctx.signal.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
            return 'never'
          },
        },
      },
    })
    expect(await runtime.call(asUser, 'slow', 'echo', { text: 'done' })).toMatchObject({ status: 'success', result: 'done' })
    controller.abort()
    expect(await runtime.call(asUser, 'slow', 'obeying', {}, controller.signal)).toMatchObject({ status: 'cancelled' })
  })

  it('reports progress to listeners, and a listener that throws does not affect the call', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    const seen: string[] = []
    const callIds: string[] = []
    runtime.onProgress((event) => { seen.push(event.message); callIds.push(event.callId) })
    const dispose = runtime.onProgress(() => { throw new Error('listener broke') })
    await runtime.register({
      ...echoApp('talker'),
      ops: {
        echo: {
          description: 'reports progress',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: (args, ctx) => {
            ctx.reportProgress('working', { step: 1 })
            return (args as { text: string }).text
          },
        },
      },
    })
    expect(await runtime.call(asUser, 'talker', 'echo', { text: 'x' }, undefined, 'caller-chosen-id')).toMatchObject({ status: 'success' })
    expect(seen).toEqual(['working'])
    // The caller's own id names every record of ITS call (progress notices
    // included), so a page can take over the rows of the call it started.
    expect(callIds).toEqual(['caller-chosen-id'])
    expect(problems.join(' ')).toContain('listener broke')
    dispose()
    expect(await runtime.call(asUser, 'talker', 'echo', { text: 'y' })).toMatchObject({ status: 'success' })
    // The disposed listener reports nothing further.
    expect(problems).toHaveLength(1)
  })

  it('delivers change notices from operations, and isolates a throwing listener', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    const notices: string[] = []
    runtime.onChange((notice) => { notices.push(notice.appId) })
    runtime.onChange(() => { throw new Error('bad listener') })
    await runtime.register({
      ...echoApp('writer'),
      ops: {
        echo: {
          description: 'writes and notifies',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: (args, ctx) => { ctx.notifyChanged(); return (args as { text: string }).text },
        },
      },
    })
    await runtime.call(asUser, 'writer', 'echo', { text: 'x' })
    expect(notices).toEqual(['writer'])
    expect(problems.join(' ')).toContain('bad listener')
  })
})

describe('lifecycle', () => {
  it('stops in order: refuse new calls, end confirmations, cancel work, wait within the budget', async () => {
    let release: (() => void) | undefined
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ stopBudgetMs: 50, onProblem: (problem) => { problems.push(problem) } })
    const registration = await runtime.register({
      ...echoApp('slow'),
      ops: {
        echo: {
          description: 'waits for release',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args, ctx) => {
            await new Promise<void>((resolve) => { release = resolve })
            return ctx.signal.aborted ? 'aborted' : (args as { text: string }).text
          },
        },
      },
    })
    const inFlight = runtime.call(asUser, 'slow', 'echo', { text: 'x' })
    const stopping = runtime.stop('slow')
    expect(registration.status()).toBe('stopping')
    expect(await runtime.call(asUser, 'slow', 'echo', { text: 'y' })).toMatchObject({ status: 'rejected', error: { code: 'platform.stopping' } })
    release?.()
    expect((await inFlight)).toMatchObject({ status: 'success' })
    expect(await stopping).toBe('stopped')
    expect(registration.status()).toBe('stopped')
    expect(problems).toEqual([])
    // Stopping again is the same answer, not a second lifecycle.
    expect(await runtime.stop('slow')).toBe('stopped')
  })

  it('reports stop-incomplete when work outlives the budget, and never claims a cancellation', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10, onProblem: (problem) => { problems.push(problem) } })
    let finish: (() => void) | undefined
    await runtime.register({
      ...echoApp('stuck'),
      ops: {
        echo: {
          description: 'never ends',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async () => { await new Promise<void>((resolve) => { finish = resolve }); return 'late' },
        },
      },
    })
    const work = runtime.call(asUser, 'stuck', 'echo', { text: 'x' })
    expect(await runtime.stop('stuck')).toBe('stop-incomplete')
    expect(problems.join(' ')).toContain('stop incomplete')
    finish?.()
    expect((await work)).toMatchObject({ status: 'success' })
    // Once the work really ended, the status moves on — without a restart.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(runtime.list()[0]?.status()).toBe('stopped')
  })

  it('runs the stop hook only after the work it must release resources for has ended', async () => {
    const order: string[] = []
    const runtime = new ApplicationRuntime({ stopBudgetMs: 200 })
    await runtime.register({
      ...echoApp('ordered'),
      ops: {
        echo: {
          description: 'ends after a moment',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args, ctx) => {
            await new Promise((resolve) => { setTimeout(resolve, 5) })
            order.push(ctx.signal.aborted ? 'work ended (cancelled)' : 'work ended')
            return (args as { text: string }).text
          },
        },
      },
      stop: () => { order.push('hook') },
    })
    const work = runtime.call(asUser, 'ordered', 'echo', { text: 'x' })
    expect(await runtime.stop('ordered')).toBe('stopped')
    expect(await work).toMatchObject({ status: 'success' })
    // Cancellation first, the wait for the work, and only then the cleanup.
    expect(order).toEqual(['work ended (cancelled)', 'hook'])
  })

  it('waits for a stop hook that awaits its own release work', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 200 })
    let released = false
    await runtime.register({
      ...echoApp('releasing'),
      // Release work belongs to the hook's own promise: the runtime awaits the
      // hook inside the same budget, so an awaited cleanup is bounded too.
      stop: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 5) })
        released = true
      },
    })
    expect(await runtime.stop('releasing')).toBe('stopped')
    expect(released).toBe(true)
  })

  it('bounds the stop hook itself and follows its late completion', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10, onProblem: (problem) => { problems.push(problem) } })
    let release: (() => void) | undefined
    await runtime.register(echoApp('hung', { stop: () => new Promise<void>((resolve) => { release = resolve }) }))
    expect(await runtime.stop('hung')).toBe('stop-incomplete')
    expect(problems.join(' ')).toContain('stop hook did not finish within the 10ms stop budget')
    // The hook that hung for longer than the budget still ends normally later:
    // the application reaches `stopped` then — it is never reopened.
    release?.()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(runtime.list()[0]?.status()).toBe('stopped')
  })

  it('reports a hook that fails when it finally runs, after the work it waited for ended', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10, onProblem: (problem) => { problems.push(problem) } })
    let finish: (() => void) | undefined
    await runtime.register({
      ...echoApp('late-work'),
      ops: {
        echo: {
          description: 'ends when released',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async () => { await new Promise<void>((resolve) => { finish = resolve }); return 'late' },
        },
      },
      stop: () => { throw new Error('cleanup broke') },
    })
    const work = runtime.call(asUser, 'late-work', 'echo', { text: 'x' })
    expect(await runtime.stop('late-work')).toBe('stop-incomplete')
    finish?.()
    await work
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // The hook ran late (the work it had to release was still going), and its
    // failure is reported then — the application stays stop-incomplete.
    expect(problems.join(' ')).toContain('stop hook failed after the stop budget: cleanup broke')
    expect(runtime.list()[0]?.status()).toBe('stop-incomplete')
  })

  it('reports a stop hook that failed after the budget, and never claims the application stopped', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10, onProblem: (problem) => { problems.push(problem) } })
    let release: (() => void) | undefined
    await runtime.register(echoApp('late-hook-failure', {
      stop: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        throw new Error('cleanup broke late')
      },
    }))
    expect(await runtime.stop('late-hook-failure')).toBe('stop-incomplete')
    release?.()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // The hook's failure is reported when it finally ends, and the application
    // stays stop-incomplete: a cleanup that failed is not a stop that finished.
    expect(problems.join(' ')).toContain('stop hook failed after the stop budget: cleanup broke late')
    expect(runtime.list()[0]?.status()).toBe('stop-incomplete')
  })

  it('never reopens an application whose start outlived its stop', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10 })
    let release: (() => void) | undefined
    const registration = runtime.register({
      ...echoApp('starting'),
      start: () => new Promise<void>((resolve) => { release = resolve }),
    })
    // The stop is answered while the start hook is still running: the start is
    // the application's work and outlives the budget.
    expect(await runtime.stop('starting')).toBe('stop-incomplete')
    expect(runtime.list()[0]?.status()).toBe('stop-incomplete')
    release?.()
    // `register` itself only answers once start settled, so the handle arrives
    // AFTER the stop: it must carry the stop's state, not a fresh `available`.
    const handle = await registration
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(handle.status()).toBe('stopped')
    // The late start result neither reopened the application nor made it
    // callable: a stop owns the status from the moment it begins.
    expect(await runtime.call(asUser, 'starting', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.stopping' } })
  })

  it('reports a start that failed after the stop began without reopening the application', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10, onProblem: (problem) => { problems.push(problem) } })
    let release: (() => void) | undefined
    const registration = runtime.register({
      ...echoApp('late-failure'),
      start: () => new Promise<void>((_resolve, reject) => { release = () => { reject(new Error('start broke late')) } }),
    })
    expect(await runtime.stop('late-failure')).toBe('stop-incomplete')
    release?.()
    const handle = await registration
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(handle.status()).toBe('stopped')
    expect(handle.failure()).toBeUndefined()
    expect(problems.join(' ')).toContain('start failed after its stop began: start broke late')
  })

  it('refuses to unload an application it never registered', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(echoApp('known'))
    expect(() => { runtime.unregister('ghost') }).toThrow(/not registered/u)
  })

  it('drops a registration whose start failed after its row asked to unload it', async () => {
    const runtime = new ApplicationRuntime()
    let release: (() => void) | undefined
    const registering = runtime.register(echoApp('doomed', {
      start: () => new Promise<void>((_resolve, reject) => { release = () => { reject(new Error('start broke')) } }),
    }))
    // The row unloads while the application is still starting: not something to
    // delete yet, but the deletion is now owed.
    expect(runtime.unregister('doomed')).toBe(false)
    release?.()
    const registration = await registering
    expect(registration.status()).toBe('failed')
    expect(registration.failure()).toBe('start broke')
    expect(runtime.list()).toEqual([])
    // The id is free again for a fresh load.
    expect((await runtime.register(echoApp('doomed'))).status()).toBe('available')
  })

  it('unloads a stopped application, refuses to drop one that is still running, and reloads after it ends', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10 })
    let finish: (() => void) | undefined
    await runtime.register({
      ...echoApp('busy'),
      ops: {
        echo: {
          description: 'never ends until released',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async () => { await new Promise<void>((resolve) => { finish = resolve }); return 'late' },
        },
      },
    })
    const work = runtime.call(asUser, 'busy', 'echo', { text: 'x' })
    expect(await runtime.stop('busy')).toBe('stop-incomplete')
    // The row unloads while the work is still running: the registration must
    // NOT be deleted (that would hide a live instance and let a second one
    // load over it)...
    expect(runtime.unregister('busy')).toBe(false)
    await expect(runtime.register(echoApp('busy'))).rejects.toThrow(/already registered/u)
    // ...and it is dropped the moment the work really ends.
    finish?.()
    await work
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(runtime.list()).toEqual([])
    const reloaded = await runtime.register(echoApp('busy'))
    expect(reloaded.status()).toBe('available')
  })

  it('runs the stop hook, reports a cleanup failure as stop-incomplete, and refuses to stop an unknown application', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    let stopped = false
    await runtime.register(echoApp('app', { stop: () => { stopped = true; throw new Error('stop hook broke') } }))
    // A hook that threw did NOT release the application's resources: the stop
    // reports exactly that, instead of a `stopped` nobody earned.
    expect(await runtime.stop('app')).toBe('stop-incomplete')
    expect(stopped).toBe(true)
    expect(problems.join(' ')).toContain('stop hook broke')
    await expect(runtime.stop('ghost')).rejects.toThrow(/not registered/u)
  })
})

describe('import maintenance', () => {
  it('refuses new calls while the hold is taken and drains the work already running', async () => {
    let release: (() => void) | undefined
    const runtime = new ApplicationRuntime({ stopBudgetMs: 100 })
    await runtime.register({
      ...echoApp('imported'),
      ops: {
        echo: {
          description: 'waits for release',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args) => {
            await new Promise<void>((resolve) => { release = resolve })
            return (args as { text: string }).text
          },
        },
        ping: {
          description: 'answers immediately',
          params: {},
          result: { type: 'string' },
          execute: () => 'pong',
        },
      },
    })
    const inFlight = runtime.call(asUser, 'imported', 'echo', { text: 'before' })
    const holding = runtime.beginMaintenance('imported')
    // The hold is visible as soon as it is taken: a call that arrives while the
    // in-flight work drains is refused, not queued behind the import.
    expect(await runtime.call(asUser, 'imported', 'ping', {})).toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
    expect(runtime.maintenance('imported')).toBe(true)
    release?.()
    const lease = await holding
    expect((await inFlight)).toMatchObject({ status: 'success', result: 'before' })
    expect(runtime.maintenance('imported')).toBe(true)
    await lease.release()
    expect(runtime.maintenance('imported')).toBe(false)
    expect(await runtime.call(asUser, 'imported', 'ping', {})).toMatchObject({ status: 'success', result: 'pong' })
  })

  it('refuses the hold when work outlives the budget, leaves the app callable, and stop clears the hold', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 5 })
    let finish: (() => void) | undefined
    await runtime.register({
      ...echoApp('busy'),
      ops: {
        echo: {
          description: 'waits for the test',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args) => {
            await new Promise<void>((resolve) => { finish = resolve })
            return (args as { text: string }).text
          },
        },
        ping: {
          description: 'answers immediately',
          params: {},
          result: { type: 'string' },
          execute: () => 'pong',
        },
      },
    })
    const work = runtime.call(asUser, 'busy', 'echo', { text: 'x' })
    await expect(runtime.beginMaintenance('busy')).rejects.toMatchObject({ code: 'maintenance-busy' })
    expect(runtime.maintenance('busy')).toBe(false)
    // The refusal did not take the application out of service: the fast call
    // still runs while the slow one is in flight.
    expect(await runtime.call(asUser, 'busy', 'ping', {})).toMatchObject({ status: 'success' })
    finish?.()
    await work
    // A hold that was taken explicitly is cleared by a stop as well.
    const lease = await runtime.beginMaintenance('busy')
    expect(runtime.maintenance('busy')).toBe(true)
    expect(await runtime.stop('busy')).toBe('stopped')
    expect(runtime.maintenance('busy')).toBe(false)
    await lease.release()
  })

  it('rejects a second hold, and endMaintenance releases the hold after a failed reload', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(echoApp('held'))
    const lease = await runtime.beginMaintenance('held')
    await expect(runtime.beginMaintenance('held')).rejects.toMatchObject({ code: 'maintenance' })
    await runtime.endMaintenance('held')
    expect(runtime.maintenance('held')).toBe(false)
    // The old lease cannot clear a newer hold.
    const next = await runtime.beginMaintenance('held')
    await lease.release()
    expect(runtime.maintenance('held')).toBe(true)
    await next.release()
    expect(runtime.maintenance('held')).toBe(false)
  })

  it('pauses the application before draining and resumes it when the hold is released', async () => {
    const events: string[] = []
    let release: (() => void) | undefined
    const runtime = new ApplicationRuntime({ stopBudgetMs: 100 })
    await runtime.register({
      ...echoApp('pausing'),
      pause: () => { events.push('pause') },
      resume: async () => { events.push('resume') },
      ops: {
        echo: {
          description: 'waits for release',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args) => {
            await new Promise<void>((resolve) => { release = resolve })
            return (args as { text: string }).text
          },
        },
      },
    })
    const inFlight = runtime.call(asUser, 'pausing', 'echo', { text: 'x' })
    const holding = runtime.beginMaintenance('pausing')
    expect(events).toEqual(['pause'])
    for (let turn = 0; release === undefined && turn < 100; turn += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 1) })
    }
    release?.()
    const lease = await holding
    expect(events).toEqual(['pause'])
    await lease.release()
    expect(events).toEqual(['pause', 'resume'])
    await inFlight
  })

  it('refuses the hold when pause fails, and reports a resume failure without blocking calls', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    await runtime.register({
      ...echoApp('pause-broken'),
      pause: () => { throw new Error('pause broke') },
    })
    await expect(runtime.beginMaintenance('pause-broken')).rejects.toMatchObject({ code: 'maintenance-pause-failed' })
    expect(runtime.maintenance('pause-broken')).toBe(false)
    expect(await runtime.call(asUser, 'pause-broken', 'echo', { text: 'ok' })).toMatchObject({ status: 'success' })

    await runtime.register({
      ...echoApp('resume-broken'),
      resume: () => { throw 'resume broke' },
    })
    const lease = await runtime.beginMaintenance('resume-broken')
    await lease.release()
    expect(problems.join(' ')).toContain('resume hook failed')
    expect(await runtime.call(asUser, 'resume-broken', 'echo', { text: 'ok' })).toMatchObject({ status: 'success' })

    // A pause hook that refuses with a string keeps the string in the reason.
    await runtime.register({ ...echoApp('pause-string'), pause: () => { throw 'pause text' } })
    await expect(runtime.beginMaintenance('pause-string')).rejects.toMatchObject({ code: 'maintenance-pause-failed' })
    expect(runtime.maintenance('pause-string')).toBe(false)
  })

  it('bounds a hanging pause by the import budget, and a late pause does not revive or undo a newer hold (LIFE-001)', async () => {
    const events: string[] = []
    let calls = 0
    let releasePause!: () => void
    const pauseGate = new Promise<void>((resolve) => { releasePause = resolve })
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10 })
    await runtime.register({
      ...echoApp('slow-pause'),
      pause: async () => {
        calls += 1
        events.push(`pause:${String(calls)}`)
        if (calls === 1) {
          await pauseGate
          events.push('paused:1')
        }
      },
      resume: async () => { events.push('resume') },
    })
    // The first hold times out while its pause hook is still running: the caller
    // gets a bounded refusal instead of waiting forever.
    await expect(runtime.beginMaintenance('slow-pause')).rejects.toMatchObject({ code: 'maintenance-busy' })
    expect(runtime.maintenance('slow-pause')).toBe(false)
    // The application is callable again (the hold was cleared), and a NEW hold
    // may be taken while the old pause is still pending.
    expect(await runtime.call(asUser, 'slow-pause', 'echo', { text: 'ok' })).toMatchObject({ status: 'success' })
    const newer = await runtime.beginMaintenance('slow-pause')
    expect(events).toEqual(['pause:1', 'pause:2'])
    // The late pause settles while the NEWER hold owns the application: it must
    // not resume it (that would undo the newer hold) and must not resurrect the
    // old one.
    releasePause()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(events).toEqual(['pause:1', 'pause:2', 'paused:1'])
    expect(runtime.maintenance('slow-pause')).toBe(true)
    await newer.release()
    expect(events).toEqual(['pause:1', 'pause:2', 'paused:1', 'resume'])
    expect(runtime.maintenance('slow-pause')).toBe(false)
  })

  it('resumes a pause that settles after the budget, and reports one that fails then (LIFE-001)', async () => {
    const events: string[] = []
    let releasePause!: () => void
    const pauseGate = new Promise<void>((resolve) => { releasePause = resolve })
    const runtime = new ApplicationRuntime({ stopBudgetMs: 5 })
    await runtime.register({
      ...echoApp('late-ok'),
      pause: async () => { events.push('pause'); await pauseGate },
      resume: async () => { events.push('resume') },
    })
    await expect(runtime.beginMaintenance('late-ok')).rejects.toMatchObject({ code: 'maintenance-busy' })
    // Nothing else holds the application when the late pause finishes, so the
    // host undoes it exactly once instead of leaving the app paused forever.
    releasePause()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(events).toEqual(['pause', 'resume'])
    expect(runtime.maintenance('late-ok')).toBe(false)

    const problems: string[] = []
    const failing = new ApplicationRuntime({ stopBudgetMs: 5, onProblem: (problem) => { problems.push(problem) } })
    let rejectPause!: (error: Error) => void
    const failingGate = new Promise<void>((_resolve, reject) => { rejectPause = reject })
    await failing.register({
      ...echoApp('late-fail'),
      pause: async () => { await failingGate },
    })
    await expect(failing.beginMaintenance('late-fail')).rejects.toMatchObject({ code: 'maintenance-busy' })
    rejectPause(new Error('pause broke late'))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    // A late failure is a reported problem, not a resumed application and not a
    // hold that reappears.
    expect(problems.join(' ')).toContain('pause hook failed after the import budget')
    expect(failing.maintenance('late-fail')).toBe(false)

    // A hook that rejects with a non-Error still reports its own text.
    let rejectText!: (reason: string) => void
    const textGate = new Promise<void>((_resolve, reject) => { rejectText = reject })
    await failing.register({ ...echoApp('late-text'), pause: async () => { await textGate } })
    await expect(failing.beginMaintenance('late-text')).rejects.toMatchObject({ code: 'maintenance-busy' })
    rejectText('late pause text')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(problems.join(' ')).toContain('late pause text')
  })

  it('does not duplicate the resume when the hold was released during the pause (LIFE-001)', async () => {
    const events: string[] = []
    let releasePause!: () => void
    const pauseGate = new Promise<void>((resolve) => { releasePause = resolve })
    const runtime = new ApplicationRuntime({ stopBudgetMs: 5 })
    await runtime.register({
      ...echoApp('released-pause'),
      pause: async () => { events.push('pause'); await pauseGate },
      resume: async () => { events.push('resume') },
    })
    const holding = runtime.beginMaintenance('released-pause')
    // The owner releases the hold while the hook is still running: that release
    // already resumed the application.
    await runtime.endMaintenance('released-pause')
    await expect(holding).rejects.toMatchObject({ code: 'maintenance-busy' })
    expect(runtime.maintenance('released-pause')).toBe(false)
    releasePause()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    // The late pause adds no second resume and no hold.
    expect(events).toEqual(['pause', 'resume'])
    expect(runtime.maintenance('released-pause')).toBe(false)
  })

  it('clears a hold that a pause hook released while it was still running, and survives a throwing quiet wait', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('pause-cleared'),
      pause: async () => {
        await runtime.endMaintenance('pause-cleared')
        throw new Error('pause cleared')
      },
    })
    await expect(runtime.beginMaintenance('pause-cleared')).rejects.toMatchObject({ code: 'maintenance-pause-failed' })
    expect(runtime.maintenance('pause-cleared')).toBe(false)

    const quietRuntime = new ApplicationRuntime()
    await quietRuntime.register(echoApp('quiet-broken'))
    ;(quietRuntime as unknown as { quiet: () => Promise<boolean> }).quiet = async () => { throw new Error('quiet broke') }
    await expect(quietRuntime.beginMaintenance('quiet-broken')).rejects.toThrow(/quiet broke/u)
    expect(quietRuntime.maintenance('quiet-broken')).toBe(false)
  })

  it('does not return a lease when the hold is released while the drain is waiting', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 100 })
    let finish: (() => void) | undefined
    await runtime.register({
      ...echoApp('released'),
      ops: {
        echo: {
          description: 'waits for the test',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args) => {
            await new Promise<void>((resolve) => { finish = resolve })
            return (args as { text: string }).text
          },
        },
      },
    })
    const work = runtime.call(asUser, 'released', 'echo', { text: 'x' })
    const holding = runtime.beginMaintenance('released')
    await runtime.endMaintenance('released')
    for (let turn = 0; finish === undefined && turn < 100; turn += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 1) })
    }
    finish?.()
    await work
    await expect(holding).rejects.toThrow(/left its import hold/u)
  })

  it('refuses an unknown or unavailable application and clears an unknown id defensively', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(echoApp('known'))
    await expect(runtime.beginMaintenance('ghost')).rejects.toThrow(/not registered/u)
    expect(await runtime.stop('known')).toBe('stopped')
    await expect(runtime.beginMaintenance('known')).rejects.toThrow(/not available/u)
    expect(runtime.maintenance('ghost')).toBe(false)
    await runtime.endMaintenance('ghost')
  })

  it('does not clear a hold that was already released while the import budget expired', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 5 })
    let finish: (() => void) | undefined
    await runtime.register({
      ...echoApp('expiring'),
      ops: {
        echo: {
          description: 'waits for the test',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args) => {
            await new Promise<void>((resolve) => { finish = resolve })
            return (args as { text: string }).text
          },
        },
      },
    })
    const work = runtime.call(asUser, 'expiring', 'echo', { text: 'x' })
    const holding = runtime.beginMaintenance('expiring')
    await runtime.endMaintenance('expiring')
    await expect(holding).rejects.toMatchObject({ code: 'maintenance-busy' })
    finish?.()
    await work
  })
})

describe('grant validation and AI principals', () => {
  it('validates a grant against the current registry and refuses an anonymous AI grant', async () => {
    const runtime = new ApplicationRuntime()
    const base = echoApp('target')
    await runtime.register({
      ...base,
      capabilities: ['model'],
      ops: {
        open: {
          description: 'open to both',
          params: {},
          result: { type: 'json' },
          exposure: { ai: 'open', peers: 'open' },
          execute: () => ({ open: true }),
        },
        closed: {
          description: 'closed to every class',
          params: {},
          result: { type: 'json' },
          execute: () => ({ closed: true }),
        },
      },
    })
    const ai = { kind: 'ai' as const, sessionId: 's1' }
    const at = '2026-01-01T00:00:00.000Z'
    expect(() => runtime.validateGrant({ caller: ai, capabilities: ['ghost#op'], grantedAt: at })).toThrow(/unregistered/u)
    expect(() => runtime.validateGrant({ caller: ai, capabilities: ['target#missing'], grantedAt: at })).toThrow(/no operation/u)
    expect(() => runtime.validateGrant({ caller: ai, capabilities: ['target#closed'], grantedAt: at })).toThrow(/not open/u)
    expect(() => runtime.validateGrant({ caller: { kind: 'ai' }, capabilities: ['target#open'], grantedAt: at })).toThrow(/anonymous/u)
    expect(() => runtime.validateGrant({ caller: ai, capabilities: ['capability:model'], grantedAt: at })).toThrow(/do not use/u)
    expect(() => runtime.validateGrant({ caller: ai, capabilities: ['target'], grantedAt: at })).toThrow(/not <application>/u)
    expect(() => runtime.validateGrant({ caller: ai, capabilities: [], grantedAt: at })).toThrow(/at least one/u)
    expect(() => runtime.validateGrant({ caller: ai, capabilities: ['capability:'], grantedAt: at })).toThrow(/empty platform/u)
    runtime.validateGrant({ caller: ai, capabilities: ['target#open'], grantedAt: at })
    runtime.validateGrant({ caller: { kind: 'app', appId: 'target' }, capabilities: ['target#open'], grantedAt: at })
    // A human can be granted any registered operation; a platform-capability
    // grant for an application that does not exist yet is deferred, not lost.
    runtime.validateGrant({ caller: { kind: 'human' }, capabilities: ['target#closed'], grantedAt: at })
    runtime.validateGrant({ caller: { kind: 'app', appId: 'not-registered' }, capabilities: ['capability:model'], grantedAt: at })
    expect(() => runtime.validateGrant({ caller: { kind: 'app', appId: 'target' }, capabilities: ['capability:storage'], grantedAt: at })).toThrow(/does not declare/u)
    runtime.validateGrant({ caller: { kind: 'app', appId: 'target' }, capabilities: ['capability:model'], grantedAt: at })
    // An application with no declaration has no capabilities to grant.
    await runtime.register(echoApp('bare'))
    expect(() => runtime.validateGrant({ caller: { kind: 'app', appId: 'bare' }, capabilities: ['capability:model'], grantedAt: at })).toThrow(/does not declare/u)
  })
})

describe('history', () => {
  it('records every outcome, and a failing sink never changes the call', async () => {
    const problems: string[] = []
    const records: HistoryRecord[] = []
    const runtime = new ApplicationRuntime({
      onProblem: (problem) => { problems.push(problem) },
      history: { write: (record) => { records.push(record) } },
    })
    await runtime.register(echoApp('app'))
    await runtime.call(asUser, 'app', 'echo', { text: 'x' })
    await runtime.call(asUser, 'app', 'echo', {})
    expect(records.map((record) => record.status)).toEqual(['success', 'rejected'])
    expect(records[1]).toMatchObject({ code: 'platform.invalid-args', target: 'app', op: 'echo' })
    // History keeps who/what/when/how-it-ended — never the arguments or results.
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(['callId', 'caller', 'endedAt', 'op', 'startedAt', 'status', 'target', ...(record.status === 'success' ? [] : ['code', 'message'])].sort())
    }

    const failing = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    failing.useHistory({ write: () => { throw new Error('history store down') } })
    await failing.register(echoApp('app'))
    expect(await failing.call(asUser, 'app', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    expect(problems.join(' ')).toContain('history store down')

    const asyncFailing = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    asyncFailing.useHistory({ write: () => Promise.reject(new Error('async history down')) })
    await asyncFailing.register(echoApp('app'))
    expect(await asyncFailing.call(asUser, 'app', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(problems.join(' ')).toContain('async history down')
  })

  it('answers recentHistory from the sink read window and never invents records', async () => {
    // No sink at all: nothing was recorded, so nothing is read.
    const bare = new ApplicationRuntime()
    await bare.register(echoApp('app'))
    await bare.call(asUser, 'app', 'echo', { text: 'x' })
    expect(bare.recentHistory()).toEqual([])

    // A write-only sink keeps no read window: still nothing to read.
    const writeOnly = new ApplicationRuntime({ history: { write: () => {} } })
    await writeOnly.register(echoApp('app'))
    await writeOnly.call(asUser, 'app', 'echo', { text: 'x' })
    expect(writeOnly.recentHistory(5)).toEqual([])

    // A sink that keeps a window answers newest first, bounded by the caller's
    // limit and by the window the sink keeps (call ids are minted in order).
    const sink = new MemoryHistory(2)
    const memory = new ApplicationRuntime({ history: sink })
    await memory.register(echoApp('app'))
    await memory.call(asUser, 'app', 'echo', { text: '1' })
    await memory.call(asUser, 'app', 'echo', { text: '2' })
    await memory.call(asUser, 'app', 'echo', { text: '3' })
    expect(memory.recentHistory().map((record) => record.callId)).toEqual(['call-3', 'call-2'])
    expect(memory.recentHistory(1).map((record) => record.callId)).toEqual(['call-3'])
  })

  it('drops the oldest records when the bounded queue is full, and drains in order', async () => {
    const problems: string[] = []
    const batches: string[][] = []
    // The store is slow on purpose: the queue must bound what it holds while
    // the first batch is still in flight.
    let releaseFirst: (() => void) | undefined
    const queue = new BoundedHistoryQueue({
      append: (records) => {
        batches.push(records.map((record) => record.callId))
        if (releaseFirst === undefined && batches.length === 1) {
          return new Promise<void>((resolve) => { releaseFirst = () => { resolve() } })
        }
        return Promise.resolve()
      },
    }, { capacity: 2, onProblem: (problem) => { problems.push(problem) } })
    for (const id of ['a', 'b', 'c', 'd']) {
      queue.write({ callId: id, caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' })
    }
    // 'a' is already in the in-flight batch; the pending queue overflows at
    // 'd', which drops the oldest (b) — the record 'a' is unaffected.
    expect(queue.droppedCount).toBe(1)
    expect(problems.join(' ')).toContain('queue full')
    releaseFirst?.()
    await queue.flush()
    expect(batches.flat()).toEqual(['a', 'c', 'd'])
  })

  it('reports a store failure per batch and keeps draining', async () => {
    const problems: string[] = []
    const written: string[][] = []
    let fail = true
    const queue = new BoundedHistoryQueue({
      append: (records) => {
        if (fail) { fail = false; return Promise.reject(new Error('store down')) }
        written.push(records.map((record) => record.callId))
        return Promise.resolve()
      },
    }, { onProblem: (problem) => { problems.push(problem) } })
    queue.write({ callId: 'a', caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' })
    await queue.flush()
    expect(problems.join(' ')).toContain('store down')
    queue.write({ callId: 'b', caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' })
    await queue.flush()
    expect(written.flat()).toEqual(['b'])
  })

  it('keeps the most recent records in the memory sink', () => {
    const history = new MemoryHistory(2)
    for (const id of ['a', 'b', 'c']) {
      history.write({ callId: id, caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' })
    }
    expect(history.all().map((record) => record.callId)).toEqual(['b', 'c'])
  })

  it('reads the sinks\' own window newest first, bounded by the limit', async () => {
    const record = (callId: string): HistoryRecord => ({ callId, caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' })
    const history = new MemoryHistory(3)
    for (const id of ['a', 'b']) history.write(record(id))
    expect(history.recent().map((entry) => entry.callId)).toEqual(['b', 'a'])
    expect(history.recent(1).map((entry) => entry.callId)).toEqual(['b'])
    expect(history.recent(0)).toEqual([])

    // A TARGET narrows the window before the limit is taken: another
    // application's traffic can never crowd the one being asked about out of
    // its own answer.
    const mixed = new MemoryHistory(5)
    for (const [id, target] of [['a', 'one'], ['b', 'two'], ['c', 'one'], ['d', 'two']] as const) {
      mixed.write({ callId: id, caller: asUser, target, op: 'o', startedAt: '', endedAt: '', status: 'success' })
    }
    expect(mixed.recent(undefined, 'one').map((entry) => entry.callId)).toEqual(['c', 'a'])
    expect(mixed.recent(1, 'one').map((entry) => entry.callId)).toEqual(['c'])
    expect(mixed.recent(undefined, 'absent')).toEqual([])
    expect(mixed.recent(0, 'one')).toEqual([])

    // The queue's read window is bounded like the queue itself: a record that
    // fell out is gone from the window whether or not it reached the store.
    const queue = new BoundedHistoryQueue({ append: () => Promise.resolve() }, { capacity: 2 })
    for (const id of ['a', 'b', 'c']) queue.write(record(id))
    await queue.flush()
    expect(queue.recent().map((entry) => entry.callId)).toEqual(['c', 'b'])
    expect(queue.recent(1).map((entry) => entry.callId)).toEqual(['c'])
  })
})

describe('assertDeclarable', () => {
  it('accepts a well-formed declaration', () => {
    expect(() => { assertDeclarable(echoApp('fine')) }).not.toThrow()
  })

  it('accepts a grant that matches a background caller', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('target'),
      ops: { echo: { ...echoApp('target').ops.echo!, exposure: { peers: 'open' } } },
    })
    let captured: CallOutcome | undefined
    await runtime.register({
      ...echoApp('owner'),
      calls: ['target'],
      start: (ctx) => {
        // Background work is a task; its context carries the application's own
        // background identity, so the same declaration and grant apply.
        ctx.startTask({ kind: 'peer-call', title: 'call target' }, async (taskCtx) => {
          await new Promise((resolve) => { setTimeout(resolve, 10) })
          captured = await taskCtx.call('target', 'echo', { text: 'from background' })
        })
      },
    })
    const grant: CapabilityGrant = { caller: asApp('owner'), capabilities: ['target#echo'], grantedAt: '2026-01-01T00:00:00.000Z' }
    await runtime.grant(grant)
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(captured).toMatchObject({ status: 'success' })
    await runtime.stop('owner')
  })

  it('lets a lifecycle hook call another application as the application itself', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({
      ...echoApp('target'),
      ops: { echo: { ...echoApp('target').ops.echo!, exposure: { peers: 'open' } } },
    })
    // The grant exists before the hook runs: a start hook's call is checked
    // exactly like an operation's (same declaration, same grant, same identity).
    await runtime.grant({ caller: asApp('owner'), capabilities: ['target#echo'], grantedAt: '2026-01-01T00:00:00.000Z' })
    let outcome: CallOutcome | undefined
    await runtime.register({
      ...echoApp('owner'),
      calls: ['target'],
      start: async (ctx) => { outcome = await ctx.call('target', 'echo', { text: 'from hook' }) },
    })
    expect(outcome).toMatchObject({ status: 'success', result: 'from hook' })
    await runtime.stop('owner')
  })
})
