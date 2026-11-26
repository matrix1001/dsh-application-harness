/**
 * The host bridge's unary surface over the real runtime: the application rows,
 * the human call path with its cancellation handle, basic history, grants,
 * application stop, and the unload that stops everything.
 *
 * The tests drive the service methods the Remote face calls (the Typert
 * transport is the platform's own, exercised by its suites); everything
 * underneath — registration, checks, permission, execution, lifecycle — is the
 * production runtime.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ApplicationBridge from '../src/index.ts'
import { AppError, apply as applyRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { brokenApp, demoApp, host, openDemoApp, secretApp, settle, waitFor } from './harness.ts'

describe('the application rows', () => {
  it('lists every application with its ops, exposure, status and start failure', async () => {
    const { bridge } = await host([demoApp(), { ...demoApp('with-caller'), calls: [] }, brokenApp()])
    const rows = bridge.list()
    expect(rows.map((row) => row.id)).toEqual(['demo', 'with-caller', 'broken'])

    const demo = rows[0]!
    expect(demo).toMatchObject({
      name: 'demo',
      description: 'demo application',
      version: '1.2.3',
      runtime: 'ready',
      activation: 'enabled',
      health: 'ok',
    })
    expect(demo.detail).toBeUndefined()
    expect(demo.ops.map((op) => op.name)).toEqual(['echo', 'touch', 'tick', 'slow', 'boom'])
    // The declared schema travels verbatim, and an omitted exposure is the
    // declared "closed to every class" — not an invented default.
    expect(demo.ops[0]).toEqual({
      name: 'echo',
      description: 'returns its arguments',
      params: { text: { type: 'string', required: true } },
      exposure: {},
    })

    // A start failure stays visible and carries its reason.
    expect(rows[2]).toMatchObject({ runtime: 'stopped', activation: 'disabled', detail: 'no storage', reason: 'platform.start-failed' })
    expect(rows[2]?.health).toBeUndefined()
  })

  it('lists declared process commands for review', async () => {
    const { bridge } = await host([{
      ...demoApp('runner'),
      capabilities: ['process'],
      process: [{ executable: 'git', commands: ['status', 'diff'], purpose: 'read a repository' }],
    }])
    expect(bridge.list()[0]?.process).toEqual([
      { executable: 'git', commands: ['status', 'diff'], purpose: 'read a repository' },
    ])
  })

  it('lists what each application declares it needs, in the vocabulary a grant records', async () => {
    const { bridge } = await host([
      {
        ...demoApp('analyst', { capabilities: ['model'] }),
        calls: ['tasks'],
      },
      {
        ...demoApp('tasks'),
        ops: {
          ...demoApp('tasks').ops,
          create: {
            description: 'creates a task',
            params: { title: { type: 'string', required: true } },
            result: { type: 'json' },
            exposure: { peers: 'open' },
            execute: (args) => args,
          },
          private: {
            description: 'an operation no peer may reach',
            params: {},
            result: { type: 'json' },
            execute: () => ({}),
          },
        },
      },
    ])
    const rows = bridge.list()
    // Only platform capabilities are grantable needs; peer operations follow
    // the shared operation policy and are never a per-caller grant.
    expect(rows[0]!.needs).toEqual(['capability:model'])
    expect(rows[1]!.needs).toEqual([])
  })

  it('proposes no need for a declared call whose target is not mounted', async () => {
    // A declaration may name a peer this host does not run: there is nothing to
    // approve, so the row proposes nothing for it (an approval that could never
    // take effect would be a lie).
    const { bridge } = await host([{ ...demoApp('caller'), calls: ['ghost'] }])
    expect(bridge.list()[0]!.needs).toEqual([])
  })

  it('refuses to mount without the runtime it views', () => {
    expect(() => new ApplicationBridge(new Context(), {})).toThrow(/application runtime/u)
  })

  it('refuses to mount without the application store it manages', () => {
    const ctx = new Context()
    applyRuntime(ctx, {})
    expect(() => new ApplicationBridge(ctx, {})).toThrow(/application store/u)
  })
})

describe('the call path', () => {
  it('passes the arguments through untouched and uses the id only as the call name', async () => {
    const { bridge } = await host([demoApp()])
    await expect(bridge.call('demo', 'echo', { text: 'hi' })).resolves.toMatchObject({
      status: 'success',
      result: { text: 'hi' },
    })
    // The runtime has no request-id concept and the bridge does not invent one:
    // the id names the call for cancellation/progress, while an operation that
    // declares `requestId` reads it from the caller's own arguments.
    await expect(bridge.call('demo', 'echo', { text: 'hi' }, 'req-7')).resolves.toMatchObject({
      status: 'success',
      result: { text: 'hi' },
    })
    // An id already in the arguments is the operation's business, not the
    // bridge's: it is neither replaced nor duplicated.
    await expect(bridge.call('demo', 'echo', { text: 'hi', requestId: 'mine' }, 'req-8')).resolves.toMatchObject({
      result: { text: 'hi', requestId: 'mine' },
    })
    // A non-object argument is handed on untouched and refused against the
    // operation's own declaration.
    await expect(bridge.call('demo', 'echo', 'not-an-object', 'req-9')).resolves.toMatchObject({
      status: 'rejected', error: { code: 'platform.invalid-args' },
    })
  })

  it('distinguishes a rejection, a business failure and a cancellation', async () => {
    const { bridge } = await host([demoApp()])
    await expect(bridge.call('ghost', 'echo', { text: 'x' })).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.unknown-app' } })
    await expect(bridge.call('demo', 'nope', { text: 'x' })).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.unknown-op' } })
    await expect(bridge.call('demo', 'echo', {})).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.invalid-args' } })
    await expect(bridge.call('demo', 'boom', {})).resolves.toMatchObject({
      status: 'failed', error: { code: 'app.stale-version', message: 'the note changed' },
    })

    // The caller's own signal cancels a cooperative operation.
    const controller = new AbortController()
    const pending = bridge.call('demo', 'slow', {}, undefined, controller.signal)
    await settle()
    controller.abort()
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('records a cancellation when an operation throws the platform abort reason', async () => {
    const app = demoApp()
    const { bridge } = await host([{
      ...app,
      ops: {
        ...app.ops,
        cooperative: {
          description: 'waits for cancellation and throws the platform reason',
          params: {},
          result: { type: 'json' },
          execute: (_args, ctx) => new Promise((_resolve, reject) => {
            const stop = (): void => { reject(ctx.signal.reason) }
            if (ctx.signal.aborted) { stop(); return }
            ctx.signal.addEventListener('abort', stop, { once: true })
          }),
        },
      },
    }])
    const pending = bridge.call('demo', 'cooperative', {}, 'reason-1')
    await settle()
    expect(bridge.cancel('reason-1')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('keeps every call under one id and cancels them all', async () => {
    const { bridge } = await host([demoApp()])
    const first = bridge.call('demo', 'slow', {}, 'shared')
    const second = bridge.call('demo', 'slow', {}, 'shared')
    await settle()
    expect(bridge.cancel('shared')).toBe(true)
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'cancelled' }),
      expect.objectContaining({ status: 'cancelled' }),
    ])
    expect(bridge.cancel('shared')).toBe(false)
  })

  it('does not let a settled call erase a live one that shares its id', async () => {
    const { bridge } = await host([demoApp()])
    const slow = bridge.call('demo', 'slow', {}, 'shared')
    await settle()
    // The fast call settles first and removes only its OWN handle; the slow
    // call must still be cancellable under the same id.
    await expect(bridge.call('demo', 'echo', { text: 'x' }, 'shared')).resolves.toMatchObject({ status: 'success' })
    expect(bridge.cancel('shared')).toBe(true)
    await expect(slow).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('cancels an in-flight call by the id its caller named, and forgets it when it ends', async () => {
    const { bridge } = await host([demoApp()])
    const pending = bridge.call('demo', 'slow', {}, 'req-1')
    await settle()
    expect(bridge.cancel('req-1')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    // The entry lived exactly as long as its call: a settled call is not
    // cancelled again, and a call nobody named cannot be cancelled here.
    expect(bridge.cancel('req-1')).toBe(false)
    await expect(bridge.call('demo', 'echo', { text: 'x' })).resolves.toMatchObject({ status: 'success' })
    expect(bridge.cancel('never-started')).toBe(false)
  })
})

describe('history and grants', () => {
  it('answers the recent calls newest first from the durable file', async () => {
    const { bridge } = await host([demoApp()])
    expect(await bridge.history()).toEqual([])
    await bridge.call('demo', 'echo', { text: 'recorded' })
    expect((await bridge.history()).map((record) => record.op)).toEqual(['echo'])
    expect((await bridge.history())[0]).toMatchObject({ target: 'demo', caller: { kind: 'human' }, status: 'success' })
    await bridge.call('demo', 'echo', { text: 'one' })
    await bridge.call('demo', 'boom', {})
    expect((await bridge.history()).map((record) => record.status)).toEqual(['failed', 'success', 'success'])
    expect(await bridge.history(1)).toHaveLength(1)
    expect((await bridge.history())[0]).toMatchObject({ target: 'demo', op: 'boom', caller: { kind: 'human' }, code: 'app.stale-version' })
    // History is who/what/when/how-it-ended — never the arguments.
    expect(JSON.stringify(await bridge.history())).not.toContain('one')
    // A TARGET answers one application's calls out of the whole window (the
    // filter runs in the sink, before the limit): "nothing recorded of mine"
    // is not said about a window another application filled.
    expect((await bridge.history(50, 'demo')).map((record) => record.op)).toEqual(['boom', 'echo', 'echo'])
    expect(await bridge.history(50, 'other')).toEqual([])
    expect(await bridge.history(1, 'demo')).toHaveLength(1)
  })

  it('persists across a remount over the same history file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'application-harness-history-'))
    const historyPath = join(dir, 'history.jsonl')
    try {
      const first = await host([demoApp()], {}, { historyPath })
      await first.bridge.call('demo', 'echo', { text: 'persisted' })
      expect((await first.bridge.history()).map((record) => record.op)).toEqual(['echo'])
      await first.dispose()
      const second = await host([demoApp()], {}, { historyPath })
      expect((await second.bridge.history()).map((record) => record.op)).toEqual(['echo'])
      await second.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records a capability grant for an application that is not deployed yet', async () => {
    const { bridge } = await host()
    await bridge.grant({ kind: 'app', appId: 'ghost' }, ['capability:model'])
    expect(await bridge.grants()).toHaveLength(1)
  })

  it('rechecks a caller application health when its grant changes', async () => {
    let granted = false
    const app = {
      ...demoApp('gated'),
      capabilities: ['model'],
      health: async () => granted ? { status: 'ok' as const } : { status: 'degraded' as const, reason: 'model grant is missing' },
    }
    const { bridge } = await host([app])
    await waitFor(() => bridge.list()[0]?.runtime === 'ready')
    expect(bridge.list()[0]).toMatchObject({ health: 'degraded', detail: 'model grant is missing' })
    granted = true
    await bridge.grant({ kind: 'app', appId: 'gated' }, ['capability:model'])
    await waitFor(() => bridge.list()[0]?.health === 'ok')
    expect(bridge.list()[0]?.health).toBe('ok')
    expect(bridge.list()[0]?.detail).toBeUndefined()
    granted = false
    await bridge.revoke({ kind: 'app', appId: 'gated' }, 'capability:model')
    await waitFor(() => bridge.list()[0]?.health === 'degraded')
    expect(bridge.list()[0]).toMatchObject({ health: 'degraded', detail: 'model grant is missing' })
  })

  it('grants and revokes capabilities, stamping the approval time on the host', async () => {
    const { bridge } = await host([{ ...openDemoApp(), capabilities: ['model'] }])
    expect(await bridge.grants()).toEqual([])

    const grant = await bridge.grant({ kind: 'app', appId: 'demo' }, ['capability:model'])
    expect(grant.capabilities).toEqual(['capability:model'])
    expect(Number.isNaN(Date.parse(grant.grantedAt))).toBe(false)
    expect(await bridge.grants()).toMatchObject([{ caller: { kind: 'app', appId: 'demo' }, capabilities: ['capability:model'] }])

    await bridge.revoke({ kind: 'app', appId: 'demo' }, 'capability:model')
    expect(await bridge.grants()).toEqual([])
  })
})

describe('lifecycle', () => {
  it('stops one application and reports the final status', async () => {
    const { bridge, runtime } = await host([demoApp()])
    await expect(bridge.stopApp('demo')).resolves.toBe('stopped')
    expect(runtime.list()[0]?.status()).toBe('stopped')
    await expect(bridge.call('demo', 'echo', { text: 'x' })).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.stopping' } })
  })

  it('unloads by stopping every application and closing its streams', async () => {
    const { bridge, runtime, dispose } = await host([demoApp('one'), demoApp('two')])
    const stream = bridge.watch(undefined)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { kind: 'ready' } })
    // A read that is parked when the row unloads still ends (no leaked consumer).
    const parked = stream.next()

    await dispose()
    expect(await parked).toMatchObject({ done: true })
    expect(runtime.list().map((registration) => registration.status())).toEqual(['stopped', 'stopped'])
    await expect(runtime.call({ kind: 'human' }, 'one', 'echo', { text: 'x' })).resolves.toMatchObject({
      status: 'rejected', error: { code: 'platform.stopping' },
    })
  })
})

describe('application conversation linkage', () => {
  it('marks a Session only when a scoped bridge is mounted, and validates the page pointer', async () => {
    const { ctx, bridge } = await host()
    expect(await bridge.registerAppConversation('s-app')).toBe(false)
    expect(await bridge.setAppConversationContext('s-app', null)).toBe(false)

    const marks: string[] = []
    ctx.provide('appTools', { mark: (sessionId: string) => { marks.push(sessionId) } } as never)
    expect(await bridge.registerAppConversation('s-app')).toBe(true)
    expect(new Set(marks)).toEqual(new Set(['s-app']))
    const previousProfile = process.env.DSH_PROFILE
    try {
      delete process.env.DSH_PROFILE
      expect(await bridge.suggestedAppConversationPath()).toBe(join(homedir(), 'dsh-workspaces', 'app-conversation', 'application-harness'))
      process.env.DSH_PROFILE = 'custom'
      expect(await bridge.suggestedAppConversationPath()).toBe(join(homedir(), 'dsh-workspaces', 'app-conversation', 'custom'))
    } finally {
      if (previousProfile === undefined) delete process.env.DSH_PROFILE
      else process.env.DSH_PROFILE = previousProfile
    }

    const parent = mkdtempSync(join(tmpdir(), 'dsh-app-conversation-'))
    try {
      const existing = join(parent, 'existing', 'workspace')
      mkdirSync(existing, { recursive: true })
      await expect(bridge.prepareAppConversationWorkspace(existing)).resolves.toBe(existing)
      await expect(bridge.prepareAppConversationWorkspace(join(parent, 'missing', 'workspace'))).rejects.toThrow(/already exist/u)
      const link = join(parent, 'link')
      symlinkSync(existing, link)
      await expect(bridge.prepareAppConversationWorkspace(link)).rejects.toThrow(/symlink|real directory/u)
      await expect(bridge.prepareAppConversationWorkspace('relative/path')).rejects.toThrow(/absolute/u)
      await expect(bridge.prepareAppConversationWorkspace('   ')).rejects.toThrow(/empty/u)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }

    const previousHome = process.env.HOME
    try {
      process.env.HOME = parent
      const suggested = await bridge.suggestedAppConversationPath()
      await expect(bridge.prepareAppConversationWorkspace(suggested)).resolves.toBe(suggested)
      expect(statSync(suggested).mode & 0o777).toBe(0o700)
      // A second call sees the existing directory and keeps it private.
      await expect(bridge.prepareAppConversationWorkspace(suggested)).resolves.toBe(suggested)
      // A symlink at the suggested path is refused, not followed.
      rmSync(suggested, { recursive: true, force: true })
      const real = join(parent, 'real-workspace')
      mkdirSync(real, { recursive: true })
      symlinkSync(real, suggested)
      await expect(bridge.prepareAppConversationWorkspace(suggested)).rejects.toThrow(/real directory/u)
      rmSync(suggested, { force: true })
      // A symlinked HOME makes the resolved path differ from the requested one.
      const traverse = join(parent, 'traverse')
      mkdirSync(traverse, { recursive: true })
      const linkHome = join(parent, 'link-home')
      symlinkSync(traverse, linkHome)
      process.env.HOME = linkHome
      await expect(bridge.prepareAppConversationWorkspace(await bridge.suggestedAppConversationPath())).rejects.toThrow(/must not traverse/u)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }

    // The launcher's profile context wins over the process environment.
    ctx.provide('profileContext', { name: 'from-context' } as never)
    expect(await bridge.suggestedAppConversationPath()).toBe(join(homedir(), 'dsh-workspaces', 'app-conversation', 'from-context'))

    const pages: Array<{ sessionId: string; page: unknown }> = []
    ctx.provide('appConversationContext', {
      set: (sessionId: string, page: unknown) => { pages.push({ sessionId, page }) },
      get: (sessionId: string) => pages.filter(entry => entry.sessionId === sessionId).at(-1)?.page as never,
    } as never)
    expect(await bridge.setAppConversationContext('s-ordinary', null)).toBe(false)
    expect(await bridge.setAppConversationContext('s-app', null)).toBe(true)
    expect(pages.at(-1)).toEqual({ sessionId: 's-app', page: null })

    for (const bad of ['text', [], { appId: '', label: 'x' }, { appId: 'a' }, { appId: 'a', label: 'x', record: [] }, { appId: 'a', label: 'x', record: { kind: '', id: '1' } }, { appId: 'a', label: 'x', view: '' }, { appId: 'a', label: 'x', selection: {} }, { appId: 'a', label: 'x', selection: [null] }, { appId: 'a', label: 'x', selection: [{ kind: '', id: '1' }] }, { appId: 'a', label: 'x', hasUnsavedChanges: 'yes' }]) {
      expect(await bridge.setAppConversationContext('s-app', bad as never)).toBe(false)
    }
    expect(await bridge.setAppConversationContext('s-app', { appId: 'disk-analysis', label: '扫描结果' })).toBe(true)
    expect(pages.at(-1)).toMatchObject({
      sessionId: 's-app',
      page: { appId: 'disk-analysis', label: '扫描结果', pageId: expect.stringMatching(/^page-/u), snapshotId: expect.stringMatching(/^snapshot-/u) },
    })
    for (const bad of [{ appId: 'a', label: 'x', draftId: '' }, { appId: 'a', label: 'x', filters: [] }, { appId: 'a', label: 'x', filters: { status: {} } }, { appId: 'a', label: 'x', visibleRange: [] }, { appId: 'a', label: 'x', visibleRange: { from: 1 } }, { appId: 'a', label: 'x', visibleRange: { to: 1 } }]) {
      expect(await bridge.setAppConversationContext('s-app', bad as never)).toBe(false)
    }
    expect(await bridge.setAppConversationContext('s-app', { appId: 'a', label: 'x', visibleRange: {} })).toBe(true)
    expect(await bridge.setAppConversationContext('s-app', {
      appId: 'workbook', label: '笔记 n1', record: { appId: 'workbook', kind: 'note', id: 'n1' },
      selection: [{ appId: 'workbook', kind: 'note', id: 'n1' }], view: 'list', draftId: 'd1',
      filters: { status: 'open', pinned: true }, visibleRange: { from: '2026-01-01', to: '2026-01-31' },
      hasUnsavedChanges: true,
    })).toBe(true)
    expect(pages.at(-1)).toMatchObject({
      sessionId: 's-app',
      page: {
        appId: 'workbook', label: '笔记 n1', view: 'list', record: { appId: 'workbook', kind: 'note', id: 'n1' },
        draftId: 'd1', selection: [{ appId: 'workbook', kind: 'note', id: 'n1' }],
        filters: { status: 'open', pinned: true }, visibleRange: { from: '2026-01-01', to: '2026-01-31' },
        hasUnsavedChanges: true,
      },
    })
    const pageId = (pages.at(-1)!.page as { pageId: string }).pageId
    expect(await bridge.setAppConversationContext('s-app', { appId: 'workbook', label: '笔记 n1', view: 'list' })).toBe(true)
    expect((pages.at(-1)!.page as { pageId: string }).pageId).toBe(pageId)
    await ctx.fiber.dispose()
  })
})

describe('the durable application conversation identity', () => {
  it('clears an absent target and reports an unremovable record', async () => {
    const plain = await host()
    expect(await plain.bridge.clearAppConversation()).toBe(true)
    await plain.dispose()

    // An explicit missing path covers the no-file branch without relying on
    // the default home being empty in this process.
    const missingDir = mkdtempSync(join(tmpdir(), 'app-conversation-missing-'))
    try {
      const missing = await host([], {}, { conversationPath: join(missingDir, 'absent.json') })
      expect(await missing.bridge.clearAppConversation()).toBe(true)
      await missing.dispose()
    } finally {
      rmSync(missingDir, { recursive: true, force: true })
    }

    const dir = mkdtempSync(join(tmpdir(), 'app-conversation-dir-'))
    const path = join(dir, 'record-is-a-directory')
    mkdirSync(path)
    try {
      const stuck = await host([], {}, { conversationPath: path })
      expect(await stuck.bridge.clearAppConversation()).toBe(false)
      // A write to a path occupied by a directory fails closed: the in-memory
      // mark is rolled back and the caller must not report a saved Session.
      const marks: string[] = []
      const unmark = vi.fn((sessionId: string) => { const index = marks.indexOf(sessionId); if (index >= 0) marks.splice(index, 1) })
      stuck.ctx.provide('appTools', { mark: (sessionId: string) => { marks.push(sessionId) }, unmark } as never)
      await expect(stuck.bridge.registerAppConversation('session-1')).resolves.toBe(false)
      expect(unmark).toHaveBeenCalledWith('session-1')
      await stuck.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats empty, malformed and invalid records as a missing mapping, not a boot failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-conversation-bad-'))
    try {
      for (const body of ['', '{"schemaVersion":1}', '{"schemaVersion":1,"sessionId":42}', 'not json']) {
        const path = join(dir, `record-${String(body.length)}.json`)
        if (body === '') writeFileSync(path, '')
        else writeFileSync(path, body)
        const h = await host([], {}, { conversationPath: path })
        const marks: string[] = []
        h.ctx.provide('appTools', { mark: (sessionId: string) => { marks.push(sessionId) }, unmark: vi.fn() } as never)
        await settle()
        expect(marks).toEqual([])
        await h.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists the target, auto-marks it on a later host, and clears the mark with the record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-conversation-'))
    const conversationPath = join(dir, 'app-conversation.json')
    try {
      const first = await host([], {}, { conversationPath })
      const marks: string[] = []
      const unmarks: string[] = []
      first.ctx.provide('appTools', {
        mark: (sessionId: string) => { marks.push(sessionId) },
        unmark: (sessionId: string) => { unmarks.push(sessionId) },
      } as never)
      await expect.poll(() => marks.length).toBe(0)
      await first.bridge.registerAppConversation('session-1')
      expect(existsSync(conversationPath)).toBe(true)
      expect(marks).toEqual(['session-1'])
      await first.bridge.registerAppConversation('session-2')
      expect(unmarks).toEqual([])
      expect(marks).toEqual(['session-1', 'session-2'])
      expect(await first.bridge.appConversations()).toEqual(['session-1', 'session-2'])
      await first.dispose()

      const second = await host([], {}, { conversationPath })
      const restored: string[] = []
      second.ctx.provide('appTools', { mark: (sessionId: string) => { restored.push(sessionId) }, unmark: vi.fn() } as never)
      await expect.poll(() => restored).toContain('session-2')
      expect(restored).toEqual(expect.arrayContaining(['session-1', 'session-2']))
      expect(await second.bridge.appConversations()).toEqual(['session-1', 'session-2'])
      expect(await second.bridge.clearAppConversation()).toBe(true)
      expect(existsSync(conversationPath)).toBe(false)
      await second.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('needs projection', () => {
  it('keeps peer calls in connections, not in grantable needs', async () => {
    const target = demoApp('target', {
      ops: {
        read: { description: 'read', params: {}, result: { type: 'json' }, exposure: { peers: 'open' }, effect: 'read', execute: () => 1 },
        write: { description: 'write', params: {}, result: { type: 'json' }, exposure: { peers: 'closed' }, effect: 'write', execute: () => 1 },
      },
    })
    const caller = demoApp('caller', { calls: [{ app: 'target', ops: ['read'] }] })
    const legacy = demoApp('legacy', { calls: ['target'] })
    const excluded = demoApp('excluded', { calls: [{ app: 'target', ops: ['write'] }] })
    const { bridge, dispose } = await host([target, caller, legacy, excluded])
    try {
      const rows = bridge.list()
      expect(rows.find(row => row.id === 'caller')?.needs).toEqual([])
      expect(rows.find(row => row.id === 'legacy')?.needs).toEqual([])
      expect(rows.find(row => row.id === 'excluded')?.needs).toEqual([])
      expect(rows.find(row => row.id === 'caller')?.connections).toEqual([{ kind: 'call', target: 'target', ops: ['read'], available: true }])
      expect(rows.find(row => row.id === 'legacy')?.connections).toEqual([{ kind: 'call', target: 'target', ops: 'all', available: true }])
      expect(rows.find(row => row.id === 'excluded')?.connections).toEqual([{ kind: 'call', target: 'target', ops: ['write'], available: true }])
    } finally {
      await dispose()
    }
  })

  it('projects declared event subscriptions', async () => {
    const publisher = demoApp('publisher', { events: { changed: { description: 'changed', subscription: 'open' } } })
    const subscriber = demoApp('subscriber', { subscriptions: [{ appId: 'publisher', type: 'changed' }] })
    const { bridge, dispose } = await host([publisher, subscriber])
    try {
      expect(bridge.list().find(row => row.id === 'subscriber')?.connections).toEqual([
        { kind: 'subscription', publisher: 'publisher', event: 'changed', open: true, available: true },
      ])
    } finally { await dispose() }
  })
})

describe('operation policies', () => {
  it('sets, reads and applies one user policy per operation', async () => {
    const { bridge, runtime } = await host([{
      ...demoApp('open'),
      ops: {
        ...demoApp('open').ops,
        echo: { ...demoApp('open').ops.echo!, exposure: { ai: 'open' } },
      },
    }])
    expect(await bridge.policies()).toEqual([])
    expect((await runtime.call({ kind: 'ai', sessionId: 's' }, 'open', 'echo', { text: 'x' })).status).toBe('success')

    await bridge.setPolicy('open', 'echo', 'forbid')
    expect(await bridge.policies()).toMatchObject([{ appId: 'open', operation: 'echo', policy: 'forbid' }])
    expect((await runtime.call({ kind: 'ai', sessionId: 's' }, 'open', 'echo', { text: 'x' })).status).toBe('rejected')

    await bridge.setPolicy('open', 'echo', 'default')
    expect(await runtime.policiesOf()).toEqual([])
    expect((await runtime.call({ kind: 'ai', sessionId: 's' }, 'open', 'echo', { text: 'x' })).status).toBe('success')
  })
})

describe('event declarations', () => {
  it('offers an open event subscription as a grantable need', async () => {
    const { bridge } = await host([
      { ...demoApp('publisher'), events: { changed: { description: 'a task changed', subscription: 'open' }, private: { description: 'private' } } },
      { ...demoApp('subscriber'), subscriptions: [{ appId: 'publisher', type: 'changed' }, { appId: 'publisher', type: 'private' }, { appId: 'ghost', type: 'changed' }] },
    ])
    const publisherRow = bridge.list().find(row => row.id === 'publisher')!
    expect(publisherRow.events).toEqual([
      { type: 'changed', description: 'a task changed', subscription: 'open' },
      { type: 'private', description: 'private', subscription: 'closed' },
    ])
    const subscriber = bridge.list().find(row => row.id === 'subscriber')!
    expect(subscriber.needs).toContain('event:publisher#changed')
    expect(subscriber.needs).not.toContain('event:publisher#private')
    expect(subscriber.needs).not.toContain('event:ghost#changed')
    await bridge.grant({ kind: 'app', appId: 'subscriber' }, ['event:publisher#changed'])
    expect(await bridge.grants()).toMatchObject([{ capabilities: ['event:publisher#changed'] }])
  })
})

describe('object references', () => {
  it('resolves through the owning application read operation as the human', async () => {
    const app = demoApp('objects')
    const { bridge } = await host([{
      ...app,
      objectTypes: { task: { description: 'a task', resolveOperation: 'resolve' }, note: { resolveOperation: 'resolve' } },
      ops: {
        ...app.ops,
        resolve: {
          description: 'resolve a task', params: { id: { type: 'string', required: true } }, result: { type: 'json' },
          effect: 'read',
          execute: (args) => ({ ref: { appId: 'objects', type: 'task', id: (args as { id: string }).id }, title: 'Task 1' }),
        },
      },
    }])
    await expect(bridge.resolveObject({ appId: 'objects', type: 'task', id: '1' }))
      .resolves.toEqual({ ok: true, value: { ref: { appId: 'objects', type: 'task', id: '1' }, title: 'Task 1' } })
  })

  it('answers a failure as a value so the reason survives the wire', async () => {
    const app = demoApp('objects')
    const { bridge } = await host([{
      ...app,
      objectTypes: { task: { description: 'a task', resolveOperation: 'resolve' } },
      ops: {
        ...app.ops,
        resolve: {
          description: 'resolve a task', params: { id: { type: 'string', required: true } }, result: { type: 'json' },
          effect: 'read',
          execute: () => { throw new AppError('not-found', 'the task is gone') },
        },
      },
    }])
    // A thrown AppError would cross the transport as `gateway/internal`; the
    // bridge hands it back as the operation's own code instead.
    await expect(bridge.resolveObject({ appId: 'objects', type: 'task', id: '1' }))
      .resolves.toEqual({ ok: false, error: { code: 'app.not-found', message: 'the task is gone' } })
  })
})

describe('activation', () => {
  it('disables and re-enables an application, and persists the user setting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'application-harness-activation-'))
    const activationPath = join(home, 'activation.json')
    try {
      const first = await host([demoApp('demo')], {}, { activationPath })
      expect(first.bridge.list()[0]).toMatchObject({ activation: 'enabled', runtime: 'ready' })
      await first.bridge.setActivation('demo', 'disabled')
      expect(first.bridge.list()[0]).toMatchObject({ activation: 'disabled', runtime: 'stopped' })
      expect(JSON.parse(readFileSync(activationPath, 'utf8')).disabled).toEqual(['demo'])
      expect((await first.bridge.call('demo', 'echo', { text: 'x' })).status).toBe('rejected')
      await first.dispose()

      // Re-mount over the same table with a disabled record: the row is applied
      // once the application appears, and the application stays stopped.
      const second = await host([demoApp('demo')], {}, { activationPath, preActivation: true })
      await waitFor(() => second.bridge.list()[0]?.activation === 'disabled')
      expect(second.bridge.list()[0]).toMatchObject({ activation: 'disabled', runtime: 'stopped' })
      expect((await second.bridge.call('demo', 'echo', { text: 'x' })).status).toBe('rejected')
      await second.bridge.setActivation('demo', 'enabled')
      expect(second.bridge.list()[0]).toMatchObject({ activation: 'enabled', runtime: 'ready' })
      expect(JSON.parse(readFileSync(activationPath, 'utf8')).disabled).toEqual([])
      await second.dispose()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('development sessions', () => {
  it('binds one session, replaces it, clears it, and persists the binding', async () => {
    const home = mkdtempSync(join(tmpdir(), 'application-harness-development-'))
    const developmentPath = join(home, 'development.json')
    try {
      const mounted = await host([demoApp('demo')], {}, { developmentPath })
      const marks: string[] = []
      const unmarks: string[] = []
      mounted.ctx.provide('appTools', {
        mark: (sessionId: string) => { marks.push(sessionId) },
        unmark: (sessionId: string) => { unmarks.push(sessionId) },
        markDevelopment: (sessionId: string, appId: string) => { marks.push(`${sessionId}:${appId}`) },
      } as never)
      await settle()
      expect(await mounted.bridge.registerDevelopmentSession('', 'demo')).toBe(false)
      expect(await mounted.bridge.registerDevelopmentSession('s', 'missing')).toBe(false)
      expect(await mounted.bridge.registerDevelopmentSession('s-dev', 'demo')).toBe(true)
      expect(marks).toContain('s-dev:demo')
      expect(await mounted.bridge.developmentBindings()).toEqual([{ sessionId: 's-dev', appId: 'demo' }])
      expect(JSON.parse(readFileSync(developmentPath, 'utf8'))).toMatchObject({ sessions: [{ sessionId: 's-dev', appId: 'demo' }] })
      expect(await mounted.bridge.registerDevelopmentSession('s-dev-2', 'demo')).toBe(true)
      expect(unmarks).not.toContain('s-dev')
      expect(await mounted.bridge.developmentBindings()).toEqual([
        { sessionId: 's-dev', appId: 'demo' },
        { sessionId: 's-dev-2', appId: 'demo' },
      ])
      expect(await mounted.bridge.clearDevelopmentSession()).toBe(true)
      expect(await mounted.bridge.developmentBindings()).toEqual([])
      expect(await mounted.bridge.clearDevelopmentSession()).toBe(true)
      await mounted.dispose()

      const first = await host([demoApp('demo')], {}, { developmentPath })
      expect(await first.bridge.registerDevelopmentSession('saved', 'demo')).toBe(true)
      await first.dispose()
      const second = await host([demoApp('demo')], {}, { developmentPath })
      const restored: string[] = []
      second.ctx.provide('appTools', {
        mark: () => {},
        markDevelopment: (sessionId: string, appId: string) => { restored.push(`${sessionId}:${appId}`) },
      } as never)
      await waitFor(() => restored.includes('saved:demo'))
      expect(restored).toContain('saved:demo')
      await second.dispose()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('development session failures', () => {
  it('reports a corrupt record and a failed write instead of claiming success', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'application-harness-development-failure-'))
    const path = join(homeDir, 'development.json')
    try {
      writeFileSync(path, '{ not json')
      const corrupt = await host([demoApp('demo')], {}, { developmentPath: path })
      expect(corrupt.bridge.list()).toHaveLength(1)
      await corrupt.dispose()

      writeFileSync(path, JSON.stringify({ schemaVersion: 1, sessionId: 'only-session' }))
      const invalid = await host([demoApp('demo')], {}, { developmentPath: path })
      expect(invalid.bridge.list()).toHaveLength(1)
      await invalid.dispose()

      chmodSync(homeDir, 0o500)
      const blocked = await host([demoApp('demo')], {}, { developmentPath: path })
      chmodSync(homeDir, 0o500)
      expect(await blocked.bridge.registerDevelopmentSession('s-dev', 'demo')).toBe(false)
      chmodSync(homeDir, 0o700)
      // A failed replacement restores the previously saved binding.
      expect(await blocked.bridge.registerDevelopmentSession('old-dev', 'demo')).toBe(true)
      chmodSync(homeDir, 0o500)
      expect(await blocked.bridge.registerDevelopmentSession('new-dev', 'demo')).toBe(false)
      chmodSync(homeDir, 0o700)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ sessions: [{ sessionId: 'old-dev', appId: 'demo' }] })
      await blocked.dispose()

      // A directory at the record path cannot be unlinked as a file.
      rmSync(path, { force: true })
      mkdirSync(path)
      const unusable = await host([demoApp('demo')], {}, { developmentPath: path })
      expect(await unusable.bridge.clearDevelopmentSession()).toBe(false)
      await unusable.dispose()
    } finally {
      try { chmodSync(homeDir, 0o700) } catch { /* already restored */ }
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

describe('public runtime states', () => {
  it('maps starting, stopping and stop-incomplete to the four public states', async () => {
    let releaseStart: (() => void) | undefined
    let releaseStop: (() => void) | undefined
    const mounted = await host([demoApp('ready')])
    expect(mounted.bridge.list()[0]).toMatchObject({ runtime: 'ready' })

    mounted.runtime.mount({
      ...demoApp('starting'),
      start: () => new Promise<void>((resolve) => { releaseStart = resolve }),
    })
    await settle()
    expect(mounted.bridge.list().find(row => row.id === 'starting')).toMatchObject({ runtime: 'starting' })
    releaseStart?.()
    await waitFor(() => mounted.runtime.list().find(row => row.declaration.id === 'starting')?.status() === 'available')

    mounted.runtime.mount({
      ...demoApp('stopping'),
      stop: () => new Promise<void>((resolve) => { releaseStop = resolve }),
    })
    await waitFor(() => mounted.runtime.list().find(row => row.declaration.id === 'stopping')?.status() === 'available')
    const stoppingDone = mounted.runtime.stop('stopping')
    await settle()
    expect(mounted.bridge.list().find(row => row.id === 'stopping')).toMatchObject({ runtime: 'stopping' })
    releaseStop?.()
    await stoppingDone

    mounted.runtime.mount({
      ...demoApp('incomplete'),
      stop: () => new Promise<void>(() => {}),
    })
    await waitFor(() => mounted.runtime.list().find(row => row.declaration.id === 'incomplete')?.status() === 'available')
    await mounted.runtime.stop('incomplete')
    expect(mounted.bridge.list().find(row => row.id === 'incomplete')).toMatchObject({ runtime: 'stopping' })
    await mounted.dispose()
  }, 10_000)
})


describe('object type declarations', () => {
  it('shows the resolvable types and their resolver operations', async () => {
    const { bridge } = await host([{
      ...demoApp('objects'),
      objectTypes: { task: { description: 'a task', resolveOperation: 'resolve' }, note: { resolveOperation: 'resolve' } },
      ops: {
        ...demoApp('objects').ops,
        resolve: { description: 'resolve', params: {}, result: { type: 'json' }, effect: 'read', execute: () => ({}) },
      },
    }])
    expect(bridge.list()[0]!.objectTypes).toEqual([{ type: 'task', description: 'a task', resolveOperation: 'resolve' }, { type: 'note', resolveOperation: 'resolve' }])
  })
})

describe('page commands', () => {
  it('sends an open command to the owner client and returns its answer', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', {
      get: () => ({ appId: 'demo', label: 'Demo', pageId: 'page-1' }),
      set: () => {},
    } as never)
    await bridge.registerAppConversation('s-app')
    const abort = new AbortController()
    const stream = bridge.watch(abort.signal)[Symbol.asyncIterator]()
    await stream.next() // ready
    const service = ctx.get('appPages') as { open(id: string, input: { view?: string; record?: { kind: string; id: string } }): Promise<{ status: string }> }
    const pending = service.open('s-app', { view: 'list' })
    const frame = await stream.next()
    expect(frame.value).toMatchObject({
      kind: 'page-command',
      command: { sessionId: 's-app', action: 'open', appId: 'demo', view: 'list' },
    })
    const command = (frame.value as { command: { commandId: string } }).command
    expect(bridge.completePageCommand(command.commandId, true)).toBe(true)
    expect(await pending).toMatchObject({ status: 'success' })
    expect(bridge.completePageCommand(command.commandId, true)).toBe(false)

    const withRecord = service.open('s-app', { record: { kind: 'task', id: '1' } })
    const recordFrame = await stream.next()
    const recordCommand = (recordFrame.value as { command: { commandId: string; record?: { kind: string; id: string } } }).command
    expect(recordCommand.record).toEqual({ kind: 'task', id: '1' })
    expect(bridge.completePageCommand(recordCommand.commandId, false)).toBe(true)
    expect(await withRecord).toMatchObject({ status: 'rejected', error: { code: 'platform.page-unavailable' } })

    const withReason = service.open('s-app', {})
    const reasonFrame = await stream.next()
    const reasonCommand = (reasonFrame.value as { command: { commandId: string } }).command
    expect(bridge.completePageCommand(reasonCommand.commandId, false, 'client refused')).toBe(true)
    expect(await withReason).toMatchObject({ status: 'rejected', error: { message: 'client refused' } })
    abort.abort()
  })

  it('fails closed without an owner, a page, valid input, or an answer', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    const service = ctx.get('appPages') as { open(id: string, input: Record<string, unknown>): Promise<{ status: string; error?: { code: string } }> }
    expect(await service.open('nobody', {})).toMatchObject({ status: 'rejected', error: { code: 'platform.page-unavailable' } })

    let page: { appId: string; label: string } | undefined
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', { get: () => page, set: () => {} } as never)
    await bridge.registerAppConversation('s-app')
    expect(await service.open('s-app', {})).toMatchObject({ status: 'rejected' })

    page = { appId: 'demo', label: 'Demo' }
    expect(await service.open('s-app', { view: '' })).toMatchObject({ status: 'rejected' })
    expect(await service.open('s-app', { record: [] })).toMatchObject({ status: 'rejected' })
    expect(await service.open('s-app', { record: { kind: '', id: '1' } })).toMatchObject({ status: 'rejected' })
    expect(await service.open('s-app', { record: { kind: 1, id: '1' } })).toMatchObject({ status: 'rejected' })
    expect(await service.open('s-app', { record: { kind: 'x', id: 1 } })).toMatchObject({ status: 'rejected' })
    expect(await service.open('s-app', { record: { kind: '', id: '' } })).toMatchObject({ status: 'rejected' })

    vi.useFakeTimers()
    try {
      const pending = service.open('s-app', {})
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toMatchObject({ status: 'rejected' })
    } finally { vi.useRealTimers() }
  })
})

describe('page command shutdown', () => {
  it('fails an unanswered command when the host unloads', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', { get: () => ({ appId: 'demo', label: 'Demo' }), set: () => {} } as never)
    await bridge.registerAppConversation('s-app')
    const service = ctx.get('appPages') as { open(id: string, input: Record<string, unknown>): Promise<{ status: string }> }
    const pending = service.open('s-app', {})
    await Promise.resolve()
    await ctx.fiber.dispose()
    expect(await pending).toMatchObject({ status: 'rejected' })
  })
})

describe('page actions', () => {
  it('executes navigate through the owner client and rejects stale or unsupported actions', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    let page: { appId: string; label: string; pageId?: string; snapshotId?: string } | undefined = { appId: 'demo', label: 'Demo', pageId: 'page-1', snapshotId: 'snapshot-1' }
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', { get: () => page, set: () => {} } as never)
    await bridge.registerAppConversation('s-app')
    const service = ctx.get('appPages') as { act(id: string, input: { pageId: string; snapshotId: string; action: 'navigate' | 'set-filters' | 'select'; input?: unknown }): Promise<{ status: string; error?: { code: string }; message?: string }> }
    const abort = new AbortController()
    const stream = bridge.watch(abort.signal)[Symbol.asyncIterator]()
    await stream.next()

    const pending = service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: { view: 'list' } })
    const frame = await stream.next()
    expect(frame.value).toMatchObject({ kind: 'page-command', command: { action: 'navigate', appId: 'demo', view: 'list' } })
    bridge.completePageCommand((frame.value as { command: { commandId: string } }).command.commandId, true)
    expect(await pending).toMatchObject({ status: 'success' })

    expect(await service.act('s-app', { pageId: 'old', snapshotId: 'snapshot-1', action: 'navigate', input: {} }))
      .toMatchObject({ error: { code: 'platform.stale-snapshot' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'old', action: 'navigate', input: {} }))
      .toMatchObject({ error: { code: 'platform.stale-snapshot' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'set-filters', input: {} }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: [] }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: { view: '' } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: { record: [] } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: { record: { kind: '', id: '1' } } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: { record: { kind: 1, id: '1' } } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: { record: { kind: 'x', id: 1 } } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })

    const filtersPending = service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'set-filters', input: { filters: { status: 'open' } } })
    const filtersFrame = await stream.next()
    expect(filtersFrame.value).toMatchObject({ kind: 'page-command', command: { action: 'set-filters', input: { filters: { status: 'open' } } } })
    bridge.completePageCommand((filtersFrame.value as { command: { commandId: string } }).command.commandId, true)
    expect(await filtersPending).toMatchObject({ status: 'success' })

    const selectPending = service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'select', input: { selection: [{ kind: 'note', id: 'n1' }] } })
    const selectFrame = await stream.next()
    expect(selectFrame.value).toMatchObject({ kind: 'page-command', command: { action: 'select', input: { selection: [{ kind: 'note', id: 'n1' }] } } })
    bridge.completePageCommand((selectFrame.value as { command: { commandId: string } }).command.commandId, true)
    expect(await selectPending).toMatchObject({ status: 'success' })

    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'set-filters', input: { filters: [] } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'select', input: { selection: 'x' } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'select', input: { selection: [null] } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'select', input: { selection: [{ kind: '', id: '1' }] } }))
      .toMatchObject({ error: { code: 'platform.action-not-allowed' } })

    const refusedAction = service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'set-filters', input: { filters: {} } })
    const refusedActionFrame = await stream.next()
    bridge.completePageCommand((refusedActionFrame.value as { command: { commandId: string } }).command.commandId, false)
    expect(await refusedAction).toMatchObject({ error: { code: 'platform.action-not-allowed' } })

    const recordPending = service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: { record: { kind: 'note', id: 'n1' } } })
    const recordFrame = await stream.next()
    expect((recordFrame.value as { command: { record?: unknown } }).command.record).toEqual({ kind: 'note', id: 'n1' })
    bridge.completePageCommand((recordFrame.value as { command: { commandId: string } }).command.commandId, true)
    expect(await recordPending).toMatchObject({ status: 'success' })

    const refusedPending = service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: {} })
    const refusedFrame = await stream.next()
    bridge.completePageCommand((refusedFrame.value as { command: { commandId: string } }).command.commandId, false, 'owner refused')
    expect(await refusedPending).toMatchObject({ status: 'rejected', error: { message: 'owner refused' } })

    const silentPending = service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: {} })
    const silentFrame = await stream.next()
    bridge.completePageCommand((silentFrame.value as { command: { commandId: string } }).command.commandId, false)
    expect(await silentPending).toMatchObject({ status: 'rejected' })

    page = { appId: 'demo', label: 'Demo' }
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: {} }))
      .toMatchObject({ error: { code: 'platform.page-unavailable' } })
    page = undefined
    expect(await service.act('s-app', { pageId: 'page-1', snapshotId: 'snapshot-1', action: 'navigate', input: {} }))
      .toMatchObject({ error: { code: 'platform.page-unavailable' } })
    abort.abort()
  })

  it('rejects an action without an owner or a page', async () => {
    const { ctx } = await host([demoApp('demo')])
    const service = ctx.get('appPages') as { act(id: string, input: { pageId: string; snapshotId: string; action: 'navigate'; input?: unknown }): Promise<{ error?: { code: string } }> }
    expect(await service.act('nobody', { pageId: 'p', snapshotId: 's', action: 'navigate' })).toMatchObject({ error: { code: 'platform.page-unavailable' } })

    const mounted = await host([demoApp('demo')])
    mounted.ctx.provide('appTools', { mark: () => {} } as never)
    mounted.ctx.provide('appConversationContext', { get: () => ({ appId: 'demo', label: 'Demo', pageId: 'p', snapshotId: 's' }), set: () => {} } as never)
    await mounted.bridge.registerAppConversation('s-app')
    const live = mounted.ctx.get('appPages') as { act(id: string, input: { pageId: string; snapshotId: string; action: 'navigate'; input?: unknown }): Promise<{ status: string }> }
    vi.useFakeTimers()
    try {
      const pending = live.act('s-app', { pageId: 'p', snapshotId: 's', action: 'navigate', input: {} })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toMatchObject({ status: 'rejected' })
    } finally { vi.useRealTimers() }
    await mounted.dispose()
  })
})

describe('shared drafts', () => {
  it('stores only metadata and reads values through the page controller', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    let page: unknown
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', {
      get: () => page,
      set: (_id: string, next: unknown) => { page = next },
    } as never)
    await bridge.registerAppConversation('s-app')
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo' })
    expect(await bridge.shareDraft('s-app', 'd1', ['/title'])).toBe(true)
    expect(await bridge.shareDraft('s-app', 'd1', [])).toBe(false)
    expect(await bridge.shareDraft('s-app', 'd1', ['x'])).toBe(false)
    expect(await bridge.shareDraft('nobody', 'd1')).toBe(false)

    const pageId = (page as { pageId: string }).pageId
    const service = ctx.get('appDrafts') as { read(id: string, input: { pageId: string; draftId: string; fields?: readonly string[] }): Promise<{ status: string; result?: unknown; error?: { code: string } }> }
    const abort = new AbortController()
    const stream = bridge.watch(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = service.read('s-app', { pageId, draftId: 'd1', fields: ['/title'] })
    const frame = await stream.next()
    expect(frame.value).toMatchObject({ kind: 'page-command', command: { action: 'draft-read', input: { draftId: 'd1', fields: ['/title'] } } })
    bridge.completePageCommand((frame.value as { command: { commandId: string } }).command.commandId, true, undefined, { revision: 'r1', values: { '/title': 'hello' } })
    expect(await pending).toMatchObject({ status: 'success', result: { draftId: 'd1', revision: 'r1', values: { '/title': 'hello' } } })

    expect(await service.read('s-app', { pageId, draftId: 'missing' })).toMatchObject({ error: { code: 'platform.draft-not-shared' } })
    expect(await service.read('s-app', { pageId, draftId: 'd1', fields: ['/body'] })).toMatchObject({ error: { code: 'platform.draft-scope' } })
    expect(await service.read('s-app', { pageId, draftId: 'd1' })).toMatchObject({ error: { code: 'platform.draft-scope' } })

    const filtered = service.read('s-app', { pageId, draftId: 'd1', fields: ['/title'] })
    const filteredFrame = await stream.next()
    bridge.completePageCommand((filteredFrame.value as { command: { commandId: string } }).command.commandId, true, undefined, { revision: 'r1', values: { '/title': 'hello', '/body': 'secret' } })
    expect(await filtered).toMatchObject({ status: 'success', result: { values: { '/title': 'hello' } } })

    const refused = service.read('s-app', { pageId, draftId: 'd1', fields: ['/title'] })
    const refusedFrame = await stream.next()
    bridge.completePageCommand((refusedFrame.value as { command: { commandId: string } }).command.commandId, false)
    expect(await refused).toMatchObject({ status: 'rejected' })
    const errored = service.read('s-app', { pageId, draftId: 'd1', fields: ['/title'] })
    const erroredFrame = await stream.next()
    bridge.completePageCommand((erroredFrame.value as { command: { commandId: string } }).command.commandId, false, 'client broke')
    expect(await errored).toMatchObject({ status: 'rejected', error: { message: 'client broke' } })

    const invalid = service.read('s-app', { pageId, draftId: 'd1', fields: ['/title'] })
    const invalidFrame = await stream.next()
    bridge.completePageCommand((invalidFrame.value as { command: { commandId: string } }).command.commandId, true, undefined, { revision: 'r1' })
    expect(await invalid).toMatchObject({ error: { code: 'platform.draft-invalid' } })

    // A new page instance invalidates the old share.
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo', view: 'other' })
    expect(await service.read('s-app', { pageId, draftId: 'd1' })).toMatchObject({ error: { code: 'platform.page-unavailable' } })
    abort.abort()
  })
})

describe('shared draft validation', () => {
  it('validates share/revoke, owner, page and result shape', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    let page: unknown
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', { get: () => page, set: (_id: string, next: unknown) => { page = next } } as never)
    await bridge.registerAppConversation('s-app')
    expect(await bridge.shareDraft('s-app', 'd1')).toBe(false) // no page
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo' })
    const pageId = (page as { pageId: string }).pageId
    expect(await bridge.shareDraft('s-app', '')).toBe(false)
    expect(await bridge.shareDraft('s-app', 'd1')).toBe(true)
    expect(await bridge.shareDraft('s-app', 'd2')).toBe(true)
    expect(await bridge.revokeDraftShare('s-app', 'd2')).toBe(true)
    expect(await bridge.revokeDraftShare('s-app', 'd2')).toBe(false)
    expect(await bridge.revokeDraftShare('nobody', 'd2')).toBe(false)

    const service = ctx.get('appDrafts') as { read(id: string, input: { pageId: string; draftId: string; fields?: readonly string[] }): Promise<{ status: string; error?: { code: string } }> }
    expect(await service.read('nobody', { pageId, draftId: 'd1' })).toMatchObject({ error: { code: 'platform.draft-not-shared' } })

    const abort = new AbortController()
    const stream = bridge.watch(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    // A full share returns the whole values object, not a filtered copy.
    const full = service.read('s-app', { pageId, draftId: 'd1' })
    const fullFrame = await stream.next()
    bridge.completePageCommand((fullFrame.value as { command: { commandId: string } }).command.commandId, true, undefined, { revision: 'r', values: { '/title': 'hello', '/body': 'secret' } })
    expect(await full).toMatchObject({ status: 'success', result: { values: { '/title': 'hello', '/body': 'secret' } } })
    for (const result of [null, [], { revision: '', values: {} }, { revision: 'r' }]) {
      const pending = service.read('s-app', { pageId, draftId: 'd1', fields: ['/title'] })
      const frame = await stream.next()
      bridge.completePageCommand((frame.value as { command: { commandId: string } }).command.commandId, true, undefined, result as never)
      expect(await pending).toMatchObject({ error: { code: 'platform.draft-invalid' } })
    }

    vi.useFakeTimers()
    try {
      const timed = service.read('s-app', { pageId, draftId: 'd1', fields: ['/title'] })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await timed).toMatchObject({ status: 'rejected' })
    } finally { vi.useRealTimers() }

    await bridge.setAppConversationContext('s-app', null)
    expect(await bridge.shareDraft('s-app', 'd3')).toBe(false)
    abort.abort()
  })
})

describe('draft update', () => {
  it('applies shared-field updates and reports revision conflicts', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    let page: unknown
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', { get: () => page, set: (_id: string, next: unknown) => { page = next } } as never)
    await bridge.registerAppConversation('s-app')
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo' })
    const pageId = (page as { pageId: string }).pageId
    await bridge.shareDraft('s-app', 'd1', ['/title'])
    const service = ctx.get('appDrafts') as { update(id: string, input: { pageId: string; draftId: string; revision: string; values: JsonValue }): Promise<{ status: string; error?: { code: string }; result?: unknown }> }
    const abort = new AbortController()
    const stream = bridge.watch(abort.signal)[Symbol.asyncIterator]()
    await stream.next()

    const pending = service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: { '/title': 'new' } })
    const frame = await stream.next()
    expect(frame.value).toMatchObject({ kind: 'page-command', command: { action: 'draft-update', input: { draftId: 'd1', revision: 'r1', values: { '/title': 'new' } } } })
    bridge.completePageCommand((frame.value as { command: { commandId: string } }).command.commandId, true, undefined, { revision: 'r2', values: { '/title': 'new' } })
    expect(await pending).toMatchObject({ status: 'success', result: { revision: 'r2', values: { '/title': 'new' } } })

    const conflict = service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: { '/title': 'x' } })
    const conflictFrame = await stream.next()
    bridge.completePageCommand((conflictFrame.value as { command: { commandId: string } }).command.commandId, true, undefined, { conflict: true })
    expect(await conflict).toMatchObject({ error: { code: 'platform.draft-conflict' } })

    expect(await service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: { '/body': 'x' } })).toMatchObject({ error: { code: 'platform.draft-scope' } })
    expect(await service.update('s-app', { pageId, draftId: 'd1', revision: '', values: {} })).toMatchObject({ error: { code: 'platform.draft-invalid' } })
    expect(await service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: [] as never })).toMatchObject({ error: { code: 'platform.draft-invalid' } })
    expect(await service.update('nobody', { pageId, draftId: 'd1', revision: 'r1', values: {} })).toMatchObject({ error: { code: 'platform.draft-not-shared' } })
    expect(await service.update('s-app', { pageId: 'old', draftId: 'd1', revision: 'r1', values: {} })).toMatchObject({ error: { code: 'platform.page-unavailable' } })
    expect(await service.update('s-app', { pageId, draftId: 'missing', revision: 'r1', values: {} })).toMatchObject({ error: { code: 'platform.draft-not-shared' } })

    const refused = service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: {} })
    const refusedFrame = await stream.next()
    bridge.completePageCommand((refusedFrame.value as { command: { commandId: string } }).command.commandId, false)
    expect(await refused).toMatchObject({ status: 'rejected' })
    const errored = service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: {} })
    const erroredFrame = await stream.next()
    bridge.completePageCommand((erroredFrame.value as { command: { commandId: string } }).command.commandId, false, 'client broke')
    expect(await errored).toMatchObject({ status: 'rejected', error: { message: 'client broke' } })
    const missing = service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: {} })
    const missingFrame = await stream.next()
    bridge.completePageCommand((missingFrame.value as { command: { commandId: string } }).command.commandId, true)
    expect(await missing).toMatchObject({ status: 'rejected' })

    for (const result of [null, [], { revision: '', values: {} }, { revision: 'r' }]) {
      const pendingBad = service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: {} })
      const badFrame = await stream.next()
      bridge.completePageCommand((badFrame.value as { command: { commandId: string } }).command.commandId, true, undefined, result as never)
      expect(await pendingBad).toMatchObject({ error: { code: 'platform.draft-invalid' } })
    }

    vi.useFakeTimers()
    try {
      const timed = service.update('s-app', { pageId, draftId: 'd1', revision: 'r1', values: {} })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await timed).toMatchObject({ status: 'rejected' })
    } finally { vi.useRealTimers() }
    abort.abort()
  })
})

describe('per-application model selection', () => {
  it('sets, reports and clears a fixed route', async () => {
    const { bridge, ctx } = await host([demoApp('demo')])
    expect(await bridge.setAppModel('missing', { provider: 'p', model: 'm' })).toBe(false)
    expect(await bridge.setAppModel('demo', { provider: 'provider', model: 'model' })).toBe(true)
    expect(bridge.list()[0]!.model).toEqual({ provider: 'provider', model: 'model' })
    expect((ctx.get('applicationModelSettings') as { selection(id: string): unknown }).selection('demo')).toEqual({ provider: 'provider', model: 'model' })
    expect(await bridge.setAppModel('demo', null)).toBe(true)
    expect(bridge.list()[0]!.model).toBeUndefined()
    expect(await bridge.modelCatalog()).toEqual({ providers: [] })

    const rich = await host([demoApp('demo')])
    rich.ctx.provide('llm', {
      listProviders: () => [{ id: 'p', name: 'Provider' }],
      listModels: async () => [{ id: 'm', name: 'Model' }],
    } as never)
    expect(await rich.bridge.modelCatalog()).toEqual({ providers: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }] })
    await rich.dispose()

    const usageHost = await host([demoApp('demo')])
    const usageService = usageHost.ctx.get('applicationModelUsage') as { record(id: string, record: unknown): Promise<void> }
    await usageService.record('demo', { status: 'success', durationMs: 7, model: { provider: 'p', model: 'm' }, inputTokens: 2, outputTokens: 3 })
    expect(await usageHost.bridge.modelUsage('demo')).toMatchObject({ calls: 1, succeeded: 1, inputTokens: 2, outputTokens: 3 })
    expect(await usageHost.bridge.modelUsage('missing')).toMatchObject({ calls: 0 })
    await usageHost.dispose()

    const badDir = mkdtempSync(join(tmpdir(), 'dsh-usage-bridge-'))
    const badPath = join(badDir, 'table')
    mkdirSync(badPath)
    const badUsage = await host([demoApp('demo')], {}, { modelUsagePath: badPath })
    const badService = badUsage.ctx.get('applicationModelUsage') as { record(id: string, record: unknown): Promise<void> }
    await expect(badService.record('demo', { status: 'success', durationMs: 1 })).resolves.toBeUndefined()
    await badUsage.dispose()
    rmSync(badDir, { recursive: true, force: true })

    const limitsHost = await host([demoApp('demo')])
    expect(await limitsHost.bridge.modelLimits('demo')).toEqual({ background: true })
    expect(await limitsHost.bridge.setModelLimits('demo', { background: false, maxConcurrent: 2 })).toBe(true)
    expect(await limitsHost.bridge.modelLimits('demo')).toEqual({ background: false, maxConcurrent: 2 })
    expect(await limitsHost.bridge.setModelLimits('missing', { background: true })).toBe(false)
    expect(await limitsHost.bridge.setModelLimits('demo', { background: true, maxConcurrent: 0 })).toBe(false)
    const limitsService = limitsHost.ctx.get('applicationModelLimits') as { get(id: string): Promise<unknown>; begin(id: string, background: boolean): Promise<() => void> }
    expect(await limitsService.get('demo')).toEqual({ background: false, maxConcurrent: 2 })
    const release = await limitsService.begin('demo', false)
    release()
    await limitsHost.dispose()

    const badLimitsDir = mkdtempSync(join(tmpdir(), 'dsh-limits-bridge-'))
    const badLimitsPath = join(badLimitsDir, 'table')
    mkdirSync(badLimitsPath)
    const badLimits = await host([demoApp('demo')], {}, { modelLimitsPath: badLimitsPath })
    expect(await badLimits.bridge.modelLimits('demo')).toEqual({ background: true })
    await badLimits.dispose()
    rmSync(badLimitsDir, { recursive: true, force: true })

    const dir = mkdtempSync(join(tmpdir(), 'dsh-models-bridge-'))
    const blocked = join(dir, 'table')
    mkdirSync(blocked)
    const failing = await host([demoApp('demo')], {}, { modelSelectionsPath: blocked })
    expect(await failing.bridge.setAppModel('demo', { provider: 'p', model: 'm' })).toBe(false)
    await failing.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('page command invalidation', () => {
  it('fails a pending command when the page instance changes', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    let page: unknown = { appId: 'demo', label: 'Demo', pageId: 'page-1', snapshotId: 'snap-1' }
    ctx.provide('appTools', { mark: () => {} } as never)
    ctx.provide('appConversationContext', { get: () => page, set: (_id: string, next: unknown) => { page = next } } as never)
    await bridge.registerAppConversation('s-app')
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo' })
    const service = ctx.get('appPages') as { open(id: string, input: { view?: string }): Promise<{ status: string; message?: string }> }
    const abort = new AbortController()
    const stream = bridge.watch(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = service.open('s-app', { view: 'list' })
    const frame = await stream.next()
    const commandId = (frame.value as { command: { commandId: string } }).command.commandId
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo', view: 'editor' })
    expect(await pending).toMatchObject({ status: 'rejected', error: { message: 'the page changed before the command was answered' } })
    expect(bridge.completePageCommand(commandId, true)).toBe(false)
    abort.abort()
  })
})

describe('page command invalidation across owners', () => {
  it('leaves another owner pending while failing only the old page', async () => {
    const { ctx, bridge } = await host([demoApp('demo')])
    const pages: Record<string, unknown> = {}
    ctx.provide('appTools', { mark: () => {}, unmark: () => {}, markDevelopment: () => {} } as never)
    ctx.provide('appConversationContext', {
      get: (id: string) => pages[id],
      set: (id: string, next: unknown) => { pages[id] = next },
    } as never)
    await bridge.registerAppConversation('s-app')
    await bridge.registerDevelopmentSession('s-dev', 'demo')
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo', view: 'one' })
    await bridge.setAppConversationContext('s-dev', { appId: 'demo', label: 'Demo', view: 'two' })
    const service = ctx.get('appPages') as { open(id: string, input: { view?: string }): Promise<{ status: string }> }
    const abort = new AbortController()
    const stream = bridge.watch(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const first = service.open('s-app', { view: 'a' })
    const firstFrame = await stream.next()
    const second = service.open('s-dev', { view: 'b' })
    const secondFrame = await stream.next()
    await bridge.setAppConversationContext('s-app', { appId: 'demo', label: 'Demo', view: 'changed' })
    expect(await first).toMatchObject({ status: 'rejected' })
    const secondCommand = (secondFrame.value as { command: { commandId: string } }).command.commandId
    bridge.completePageCommand(secondCommand, true)
    expect(await second).toMatchObject({ status: 'success' })
    expect(bridge.completePageCommand((firstFrame.value as { command: { commandId: string } }).command.commandId, true)).toBe(false)
    abort.abort()
  })
})

describe('the turn application scope', () => {
  it('reads the current scope and revokes it', async () => {
    const { ctx, bridge, runtime } = await host([secretApp()])
    const pending = runtime.call({ kind: 'ai', sessionId: 's-1' }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    const revoked: string[] = []
    ctx.provide('appReadScope', {
      list: (sessionId: string) => (sessionId === 's-1' ? ['demo', 'notes'] : []),
      revoke: (sessionId: string) => { revoked.push(sessionId) },
    } as never)
    expect(await bridge.appScope('s-1')).toEqual({ apps: ['demo', 'notes'] })
    expect(await bridge.appScope('s-2')).toEqual({ apps: [] })
    // A non-matching Session revokes only its own scope; the parked question stays.
    expect(await bridge.cancelAppScope('s-none')).toBe(true)
    expect(await bridge.cancelAppScope('s-1')).toBe(true)
    // Revoking the turn scope does not retract a confirmation the human can
    // already see; the human still decides it.
    expect(bridge.pendingConfirmations()).toHaveLength(1)
    const question = bridge.pendingConfirmations()[0]!
    expect(bridge.answerConfirmation(question.id, 'denied')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    expect(revoked).toEqual(['s-none', 's-1'])
  })
})

describe('the turn scope service edge cases', () => {
  it('keeps a parked confirmation after the scope is revoked and answers empty without a scope service', async () => {
    const { ctx, bridge, runtime } = await host([secretApp()])
    const pending = runtime.call({ kind: 'ai', sessionId: 's-1' }, 'secret-app', 'secret', {})
    await waitFor(() => bridge.pendingConfirmations().length === 1)
    ctx.provide('appReadScope', { list: () => ['secret-app'], revoke: () => {} } as never)
    expect(await bridge.cancelAppScope('s-1')).toBe(true)
    expect(bridge.pendingConfirmations()).toHaveLength(1)
    const question = bridge.pendingConfirmations()[0]!
    expect(bridge.answerConfirmation(question.id, 'denied')).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'rejected' })
  })
})
