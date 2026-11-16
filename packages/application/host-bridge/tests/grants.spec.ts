/**
 * The durable grant table and the "allow and remember" answer.
 *
 * Authorization state has a product path now: the out-of-session table's answer
 * can record a grant (`allowed-always`), the bridge persists the table under the
 * harness home through the shared atomic write, and the runtime reads it back on
 * the next call. Every failure direction is asserted, because the two that
 * matter most point opposite ways: a table that cannot be READ must never answer
 * "no grants" (that is the strict direction, but silently discards approvals and
 * lets the next save persist the loss), and a table that cannot be SAVED must
 * never be reported as saved.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDeclaration } from '@matrix1001/dsh-application-harness-runtime/types'
import { GRANT_TABLE_VERSION, GrantFileStore } from '../src/grants.ts'
import { demoApp, host, openDemoApp, secretApp, waitFor } from './harness.ts'

/** A caller application that calls one operation of a peer target. */
function callerApp(id: string, target: string): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} application`,
    version: '1.0.0',
    calls: [target],
    ops: {
      ping: {
        description: 'calls the target as this application',
        params: {},
        result: { type: 'json' },
        execute: async (_args, ctx) => {
          const outcome = await ctx.call(target, 'bump', {})
          return { ok: outcome.status === 'success' }
        },
      },
    },
  }
}

/** A target whose operation needs the user's consent for a peer caller. */
function consentTarget(id = 'peer-target'): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} application`,
    version: '1.0.0',
    ops: {
      bump: {
        description: 'bumps something the user must approve',
        params: {},
        result: { type: 'json' },
        exposure: { peers: 'confirm' },
        execute: () => ({ bumped: true }),
      },
    },
  }
}

describe('the durable grant table', () => {
  let home: string
  let path: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'application-harness-grants-'))
    path = join(home, 'application-harness', 'grants.json')
    mkdirSync(dirname(path), { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('answers the empty table before anything was approved, and round-trips what is saved', async () => {
    const store = new GrantFileStore(path)
    expect(await store.list()).toEqual([])

    const grant = { caller: { kind: 'app' as const, appId: 'notes' }, capabilities: ['tasks#create'], grantedAt: '2026-10-13T00:00:00.000Z' }
    await store.save([grant])
    expect(await store.list()).toEqual([grant])
    // The file is the versioned envelope, written whole (and its directory created).
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: GRANT_TABLE_VERSION, grants: [grant] })
    // A save replaces the table; it never appends.
    await store.save([])
    expect(await store.list()).toEqual([])
  })

  it('refuses a table it cannot trust instead of answering a partial or empty one', async () => {
    const store = new GrantFileStore(path)
    const cases: Array<[string, string, RegExp]> = [
      ['not JSON', '{', /not valid JSON/],
      ['not an object', '[1, 2]', /is not an object/],
      ['no version this build writes', JSON.stringify({ schemaVersion: 99, grants: [] }), /names schema 99/],
      ['no grants array', JSON.stringify({ schemaVersion: GRANT_TABLE_VERSION }), /carries no grants array/],
      ['a malformed grant', JSON.stringify({ schemaVersion: GRANT_TABLE_VERSION, grants: [{ caller: { kind: 'app' }, capabilities: ['x#y'], grantedAt: 'now' }] }), /malformed grant/],
    ]
    for (const [label, text, pattern] of cases) {
      writeFileSync(path, text)
      await expect(store.list(), label).rejects.toThrow(pattern)
    }
    // A read that fails for a reason other than absence is an error too — never
    // the empty table (a directory where the file should be).
    const asDirectory = new GrantFileStore(home)
    await expect(asDirectory.list()).rejects.toThrow(/cannot be read/)
  })

  it('round-trips every caller shape it stores, and refuses a grant it cannot read', async () => {
    const store = new GrantFileStore(path)
    const grants = [
      { caller: { kind: 'ai' as const, sessionId: 'session-1', turnId: 'turn-1' }, capabilities: ['notes#create'], grantedAt: '2026-10-13T00:00:00.000Z' },
      { caller: { kind: 'ai' as const }, capabilities: ['notes#list'], grantedAt: '2026-10-13T00:00:00.000Z' },
      { caller: { kind: 'app' as const, appId: 'notes' }, capabilities: ['tasks#create'], grantedAt: '2026-10-13T00:00:00.000Z' },
      { caller: { kind: 'background' as const, appId: 'notes' }, capabilities: ['capability:model'], grantedAt: '2026-10-13T00:00:00.000Z' },
    ]
    await store.save(grants)
    expect(await store.list()).toEqual(grants)

    const write = (grant: unknown): void => {
      writeFileSync(path, JSON.stringify({ schemaVersion: GRANT_TABLE_VERSION, grants: [grant] }))
    }
    const malformed: Array<[string, unknown]> = [
      ['a grant that is not an object', 7],
      ['a caller that is not an object', { caller: 7, capabilities: ['a#b'], grantedAt: 'now' }],
      ['a caller of an unknown kind', { caller: { kind: 'robot' }, capabilities: ['a#b'], grantedAt: 'now' }],
      ['an application caller with no id', { caller: { kind: 'app' }, capabilities: ['a#b'], grantedAt: 'now' }],
      ['an application caller with a blank id', { caller: { kind: 'app', appId: '' }, capabilities: ['a#b'], grantedAt: 'now' }],
      ['no capabilities array', { caller: { kind: 'human' }, capabilities: 'a#b', grantedAt: 'now' }],
      ['an empty capability set', { caller: { kind: 'human' }, capabilities: [], grantedAt: 'now' }],
      ['a capability that is not a string', { caller: { kind: 'human' }, capabilities: [7], grantedAt: 'now' }],
      ['a blank capability', { caller: { kind: 'human' }, capabilities: [''], grantedAt: 'now' }],
      ['no approval time', { caller: { kind: 'human' }, capabilities: ['a#b'] }],
    ]
    for (const [label, grant] of malformed) {
      write(grant)
      await expect(store.list(), label).rejects.toThrow(/malformed grant/)
    }
  })

  it('rejects a save that did not reach the file, so nobody reports it as saved', async () => {
    // The parent path is a FILE, so the temp write cannot be created.
    const blocked = join(home, 'a-file')
    writeFileSync(blocked, 'not a directory')
    const store = new GrantFileStore(join(blocked, 'grants.json'))
    await expect(store.save([{ caller: { kind: 'ai' }, capabilities: ['demo#echo'], grantedAt: '2026-10-13T00:00:00.000Z' }]))
      .rejects.toThrow()
  })
})

describe('the grant face over the durable table', () => {
  it('persists a grant across a re-mount, and a revoke takes it away for good', async () => {
    // The table outlives each host, so the three mounts share one file the test
    // owns (a host's own temp directory is removed with the host).
    const home = mkdtempSync(join(tmpdir(), 'application-harness-grants-'))
    const grantsPath = join(home, 'grants.json')

    const first = await host([openDemoApp()], {}, { grantsPath })
    await first.bridge.grant({ kind: 'app', appId: 'notes' }, ['demo#echo'])
    expect(await first.bridge.grants()).toMatchObject([{ caller: { kind: 'app', appId: 'notes' }, capabilities: ['demo#echo'] }])
    await first.dispose()
    expect(JSON.parse(readFileSync(grantsPath, 'utf8')).grants).toMatchObject([{ capabilities: ['demo#echo'] }])

    // A fresh host over the SAME table: the approval survived the restart.
    const second = await host([openDemoApp()], {}, { grantsPath })
    expect(await second.bridge.grants()).toMatchObject([{ caller: { kind: 'app', appId: 'notes' }, capabilities: ['demo#echo'] }])
    // The revoke drops it from the table, so a third host sees nothing.
    await second.bridge.revoke({ kind: 'app', appId: 'notes' })
    await second.dispose()

    const third = await host([openDemoApp()], {}, { grantsPath })
    expect(await third.bridge.grants()).toEqual([])
    await third.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  it('reports a failed save as a failure, never as a recorded grant', async () => {
    // A readable table in an unwritable directory: the read works, the atomic
    // replacement cannot be created.
    const home = mkdtempSync(join(tmpdir(), 'application-harness-grants-'))
    const grantsPath = join(home, 'grants.json')
    writeFileSync(grantsPath, JSON.stringify({ schemaVersion: GRANT_TABLE_VERSION, grants: [] }))
    chmodSync(home, 0o500)
    try {
      const { bridge, dispose } = await host([openDemoApp()], {}, { grantsPath })
      await expect(bridge.grant({ kind: 'ai', sessionId: 'session-1' }, ['demo#echo'])).rejects.toThrow()
      expect(await bridge.grants()).toEqual([])
      await dispose()
    } finally {
      chmodSync(home, 0o700)
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('defaults to the harness home when the row config names no path', async () => {
    // The deployed bundle mounts `app-bridge` with no config at all, so the
    // default location is the one the product really uses: the harness home's
    // `application-harness/grants.json` (the same convention as the application store).
    const home = mkdtempSync(join(tmpdir(), 'application-harness-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const { bridge, grantsPath, dispose } = await host([openDemoApp()], {}, { grantsPath: null })
      expect(grantsPath).toBe(join(home, 'application-harness', 'grants.json'))
      await bridge.grant({ kind: 'ai', sessionId: 'session-1' }, ['demo#echo'])
      expect(JSON.parse(readFileSync(grantsPath, 'utf8')).grants).toMatchObject([{ capabilities: ['demo#echo'] }])
      await dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('fails closed on a table it cannot read: no grant is invented and a peer call cannot slip through', async () => {
    const home = mkdtempSync(join(tmpdir(), 'application-harness-grants-'))
    const grantsPath = join(home, 'grants.json')
    writeFileSync(grantsPath, '{ not json')
    const openToPeers = demoApp('target')
    const { runtime, bridge, dispose } = await host([
      { ...openToPeers, ops: { echo: { ...openToPeers.ops.echo!, exposure: { peers: 'confirm' } } } },
      demoApp('caller', { calls: ['target'] }),
    ], {}, { grantsPath })
    // Reading the grants is an error, not the empty table.
    await expect(bridge.grants()).rejects.toThrow(/not valid JSON/)
    // With no grant, the peer call still asks the human instead of slipping
    // through; the unreadable table is reported separately by grants().
    const pending = runtime.call({ kind: 'app', appId: 'caller' }, 'target', 'echo', { text: 'x' })
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [question] = bridge.pendingConfirmations()
    expect(bridge.answerConfirmation(question!.id, 'denied')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    await dispose()
    rmSync(home, { recursive: true, force: true })
  })
})

describe('confirmation and standing grants', () => {
  it('allows the call once without recording a durable operation grant', async () => {
    const { runtime, bridge, dispose } = await host([secretApp('guarded')])
    const pending = runtime.call({ kind: 'ai', sessionId: 'session-1' }, 'guarded', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [question] = bridge.pendingConfirmations()
    expect(question).toMatchObject({ capability: 'guarded#secret' })

    expect(bridge.answerConfirmation(question!.id, 'allowed-once')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'success', result: { secret: 42 } })
    expect(bridge.pendingConfirmations()).toEqual([])
    expect(await bridge.grants()).toEqual([])

    // The next call asks again: a confirmation covers only the call it answered.
    const again = runtime.call({ kind: 'ai', sessionId: 'session-1' }, 'guarded', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [next] = bridge.pendingConfirmations()
    expect(bridge.answerConfirmation(next!.id, 'denied')).toBe(true)
    await expect(again).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    await dispose()
  })

  it('the panel grants a platform capability, and the application’s next use reads it', async () => {
    let uses = 0
    const { bridge, dispose } = await host([{
      ...demoApp('analyst', { capabilities: ['model'] }),
      ops: {
        ...demoApp('analyst').ops,
        describe: {
          description: 'uses the declared model capability',
          params: {},
          result: { type: 'json' },
          execute: async (_args, ctx) => await ctx.capabilities.use('model', () => { uses += 1; return { text: 'reading' } }),
        },
      },
    }])
    await expect(bridge.call('analyst', 'describe', {})).resolves.toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(uses).toBe(0)
    expect(bridge.pendingConfirmations()).toEqual([])

    await bridge.grant({ kind: 'app', appId: 'analyst' }, ['capability:model'])
    await expect(bridge.call('analyst', 'describe', {})).resolves.toMatchObject({ status: 'success', result: { text: 'reading' } })
    expect(uses).toBe(1)
    expect(await bridge.grants()).toMatchObject([{ caller: { kind: 'app', appId: 'analyst' }, capabilities: ['capability:model'] }])

    await bridge.revoke({ kind: 'app', appId: 'analyst' }, 'capability:model')
    await expect(bridge.call('analyst', 'describe', {})).resolves.toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(uses).toBe(1)
    await dispose()
  })

  it('asks again for a peer call after a one-off approval', async () => {
    const { runtime, bridge, dispose } = await host([callerApp('peer-caller', 'peer-target'), consentTarget()])
    const caller = { kind: 'app', appId: 'peer-caller' } as const
    const pending = runtime.call(caller, 'peer-target', 'bump', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [question] = bridge.pendingConfirmations()
    expect(question).toMatchObject({ caller: { kind: 'app', appId: 'peer-caller' }, capability: 'peer-target#bump' })
    expect(bridge.answerConfirmation(question!.id, 'allowed-once')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'success', result: { bumped: true } })
    expect(await bridge.grants()).toEqual([])

    const again = runtime.call(caller, 'peer-target', 'bump', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const [next] = bridge.pendingConfirmations()
    expect(bridge.answerConfirmation(next!.id, 'denied')).toBe(true)
    await expect(again).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    await dispose()
  })
})
