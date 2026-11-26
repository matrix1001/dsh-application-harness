import { describe, expect, it } from 'vitest'
import { APPLICATIONS_TOOL, DELEGATION_REPORT_TOOL, DRAFTS_TOOL, PAGES_TOOL } from '../src/index.ts'
import { demoApp, execution, host, runApplicationTool } from './harness.ts'

describe('the unified application tool', () => {
  it('registers exactly one application tool', async () => {
    const { tools } = await host()
    expect(tools.names()).toEqual([APPLICATIONS_TOOL, PAGES_TOOL, DRAFTS_TOOL, DELEGATION_REPORT_TOOL])
  })

  it('gives an ordinary Session only the applications referenced in its turn', async () => {
    const { runtime, tools, allow } = await host()
    await runtime.register(demoApp())
    allow('s-ord', ['demo'])

    const view = await runApplicationTool(tools, 's-ord', { action: 'view' }) as { applications: Array<{ appId: string }> }
    expect(view.applications.map(app => app.appId)).toEqual(['demo'])

    const read = await runApplicationTool(tools, 's-ord', { action: 'read', appId: 'demo' }) as { ops: Array<{ op: string }> }
    expect(read.ops.map(op => op.op)).toEqual(['echo', 'secret', 'boom', 'slow'])

    expect(await runApplicationTool(tools, 's-ord', { action: 'call', appId: 'demo', op: 'echo', args: { text: 'hi' } }))
      .toMatchObject({ status: 'success', result: { text: 'hi' } })
  })

  it('refuses view without a scope and refuses an application outside the scope', async () => {
    const { runtime, tools } = await host()
    await runtime.register(demoApp())
    await expect(runApplicationTool(tools, 's-empty', { action: 'view' })).rejects.toThrow(/no application is referenced/u)
    await expect(runApplicationTool(tools, 's-empty', { action: 'call', appId: 'demo', op: 'echo', args: {} }))
      .rejects.toThrow(/not in this turn's @ scope/u)
  })

  it('gives a marked application conversation every application', async () => {
    const { runtime, tools, mark } = await host()
    await runtime.register(demoApp())
    mark('s-app')
    const view = await runApplicationTool(tools, 's-app', { action: 'view' }) as { applications: Array<{ appId: string }> }
    expect(view.applications.map(app => app.appId)).toEqual(['demo'])
    expect(await runApplicationTool(tools, 's-app', { action: 'call', appId: 'demo', op: 'echo', args: { text: 'app' } }))
      .toMatchObject({ status: 'success', result: { text: 'app' } })
  })

  it('preserves business failures and confirmation state', async () => {
    const { runtime, tools, mark } = await host()
    await runtime.register(demoApp())
    mark('s-app')
    expect(await runApplicationTool(tools, 's-app', { action: 'call', appId: 'demo', op: 'boom' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await runApplicationTool(tools, 's-app', { action: 'call', appId: 'demo', op: 'secret' }))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    await runtime.setPolicy('demo', 'secret', 'allow')
    expect(await runApplicationTool(tools, 's-app', { action: 'call', appId: 'demo', op: 'secret' }))
      .toMatchObject({ status: 'success', result: { secret: 42 } })
  })

  it('reports a policy-store failure as an authorization error, not a host path', async () => {
    const { runtime, tools, allow } = await host()
    await runtime.register(demoApp())
    allow('s-app', ['demo'])
    const original = runtime.policyOf
    runtime.policyOf = (async () => { throw new Error('/home/secret/policies.json') }) as typeof runtime.policyOf
    try {
      await expect(runApplicationTool(tools, 's-app', { action: 'read', appId: 'demo' }))
        .rejects.toMatchObject({ code: 'applications/authorization-unavailable' })
    } finally {
      runtime.policyOf = original
    }
  })

  it('does not expose a write or a closed operation in the read declaration', async () => {
    const { runtime, tools, mark } = await host()
    await runtime.register(demoApp())
    mark('s-app')
    const read = await runApplicationTool(tools, 's-app', { action: 'read', appId: 'demo' }) as { ops: Array<{ op: string; effect: string }> }
    expect(read.ops.map(op => op.op)).not.toContain('hidden')
    expect(read.ops.map(op => op.op)).not.toContain('closedRead')
    expect(read.ops.find(op => op.op === 'echo')?.effect).toBe('read')
  })
})


describe('development sessions', () => {
  it('scopes the tool to the bound application and keeps pages of other applications unavailable', async () => {
    const { runtime, tools, markDevelopment, setPage } = await host()
    await runtime.register(demoApp('bound'))
    await runtime.register(demoApp('other'))
    markDevelopment('dev', 'bound')
    const view = await runApplicationTool(tools, 'dev', { action: 'view' }) as { applications: Array<{ appId: string }> }
    expect(view.applications.map(app => app.appId)).toEqual(['bound'])
    expect(await runApplicationTool(tools, 'dev', { action: 'call', appId: 'bound', op: 'echo', args: { text: 'dev' } }))
      .toMatchObject({ status: 'success', result: { text: 'dev' } })
    await expect(runApplicationTool(tools, 'dev', { action: 'call', appId: 'other', op: 'echo', args: {} }))
      .rejects.toThrow(/@ scope/u)
    setPage('dev', { appId: 'other', label: 'Other' })
    await expect(tools.get(PAGES_TOOL)!.execute({}, execution({ agent: { session: { id: 'dev' } } } as never)))
      .rejects.toThrow(/bound to another application/u)
  })
})

describe('the delegation report tool', () => {
  /** The fake host delegation service the report tool calls, plus what it recorded. */
  function delegationService(): {
    provide: (ctx: { provide(name: string, value: unknown): void }) => void
    calls: Array<{ sessionId: string; input: Record<string, unknown> }>
    setActive: (record: { readonly id: string } | undefined) => void
  } {
    let active: { readonly id: string } | undefined
    const calls: Array<{ sessionId: string; input: Record<string, unknown> }> = []
    return {
      calls,
      setActive: (record) => { active = record },
      provide: (ctx) => {
        ctx.provide('appDelegations', {
          active: async () => active,
          report: async (sessionId: string, input: Record<string, unknown>) => {
            calls.push({ sessionId, input })
            return { delegationId: 'delegation-1', status: 'ended' }
          },
        })
      },
    }
  }

  it('reports the result for the Session bound to the live delegation only', async () => {
    const { ctx, tools } = await host()
    const service = delegationService()
    service.provide(ctx)
    const tool = tools.get(DELEGATION_REPORT_TOOL)!
    const exec = execution({ agent: { session: { id: 'area-1' } } } as never)

    // No Session at all (a detached tool call).
    await expect(tool.execute({ outcome: 'completed', summary: '完成' }, execution())).rejects.toThrow(/require a Session/u)
    // A Session with no live delegation.
    await expect(tool.execute({ outcome: 'completed', summary: '完成' }, exec)).rejects.toThrow(/not executing a delegation/u)

    service.setActive({ id: 'delegation-1' })
    expect(await tool.execute(
      { outcome: 'completed', summary: ' 完成 ', details: { ref: 'note-1' } },
      exec,
    )).toMatchObject({ delegationId: 'delegation-1', status: 'ended' })
    // The Service receives the platform-shaped envelope (the question/details
    // keys are omitted when the caller did not supply them).
    expect(service.calls.at(-1)).toEqual({
      sessionId: 'area-1',
      input: { outcome: 'completed', summary: ' 完成 ', details: { ref: 'note-1' } },
    })
    expect(await tool.execute({ outcome: 'blocked', summary: '需要回答', question: '选哪个？' }, exec))
      .toMatchObject({ delegationId: 'delegation-1' })
    expect(service.calls.at(-1)).toEqual({
      sessionId: 'area-1',
      input: { outcome: 'blocked', summary: '需要回答', question: '选哪个？' },
    })
    expect(tool.output.render({}, { delegationId: 'delegation-1', status: 'ended' }))
      .toEqual([{ type: 'text', text: JSON.stringify({ delegationId: 'delegation-1', status: 'ended' }, null, 2) }])
  })

  it('validates the report envelope before writing anything', async () => {
    const { ctx, tools } = await host()
    const service = delegationService()
    service.provide(ctx)
    service.setActive({ id: 'delegation-1' })
    const tool = tools.get(DELEGATION_REPORT_TOOL)!
    const exec = execution({ agent: { session: { id: 'area-1' } } } as never)
    await expect(tool.execute({ outcome: 'done', summary: 'x' }, exec)).rejects.toThrow(/outcome must be completed, blocked or failed/u)
    await expect(tool.execute({ outcome: 'completed' }, exec)).rejects.toThrow(/needs a non-empty summary/u)
    await expect(tool.execute({ outcome: 'completed', summary: '   ' }, exec)).rejects.toThrow(/needs a non-empty summary/u)
    await expect(tool.execute({ outcome: 'blocked', summary: 'need' }, exec)).rejects.toThrow(/blocked report needs the concrete question/u)
    await expect(tool.execute({ outcome: 'blocked', summary: 'need', question: '   ' }, exec)).rejects.toThrow(/concrete question/u)
    expect(service.calls).toEqual([])
  })

  it('fails closed when the composition has no delegation store', async () => {
    const { tools } = await host()
    await expect(tools.get(DELEGATION_REPORT_TOOL)!.execute(
      { outcome: 'completed', summary: '完成' },
      execution({ agent: { session: { id: 'area-1' } } } as never),
    )).rejects.toThrow(/no delegation store/u)
  })

  it('fails the row when its tool name is already taken', async () => {
    await expect(host([DELEGATION_REPORT_TOOL])).rejects.toThrow(/already registered/u)
  })
})

describe('the application row state projection', () => {
  it('maps the starting and stopping statuses onto the public runtime axis', async () => {
    const { runtime, tools, mark } = await host()
    const startGate = Promise.withResolvers<void>()
    runtime.mount(demoApp('booting', { start: () => startGate.promise }))
    const blocker = Promise.withResolvers<void>()
    const base = demoApp('draining')
    await runtime.register({
      ...base,
      ops: {
        ...base.ops,
        hold: {
          description: 'holds until released', params: {}, result: { type: 'json' },
          execute: async () => { await blocker.promise; return null },
        },
      },
    })
    const held = runtime.call({ kind: 'human' }, 'draining', 'hold', {})
    const stopping = runtime.stop('draining')
    mark('s-app')
    const view = await runApplicationTool(tools, 's-app', { action: 'view' }) as {
      applications: Array<{ appId: string; runtime: string; health?: string }>
    }
    expect(Object.fromEntries(view.applications.map(row => [row.appId, row.runtime]))).toEqual({
      booting: 'starting',
      draining: 'stopping',
    })
    expect(view.applications.every(row => row.health === undefined)).toBe(true)
    startGate.resolve()
    blocker.resolve(undefined)
    await held
    await stopping
  })

  it('carries the reason and detail of a failed application into the view', async () => {
    const { runtime, tools, mark } = await host()
    await runtime.register(demoApp('bad', { start: () => { throw new Error('the storage is missing') } }))
    mark('s-app')
    const view = await runApplicationTool(tools, 's-app', { action: 'view' }) as {
      applications: Array<{ appId: string; runtime: string; reason?: string; detail?: string; health?: string }>
    }
    expect(view.applications[0]?.health).toBeUndefined()
    expect(view.applications).toEqual([expect.objectContaining({
      appId: 'bad',
      runtime: 'stopped',
      reason: 'platform.start-failed',
      detail: 'the storage is missing',
    })])
  })
})

describe('page open action', () => {
  it('delegates to the host page service and rejects an invalid action', async () => {
    const { ctx, tools, mark } = await host()
    mark('s-app')
    const opened: Array<{ sessionId: string; input: unknown }> = []
    const acted: Array<{ sessionId: string; input: unknown }> = []
    ctx.provide('appPages', {
      open: async (sessionId: string, input: unknown) => {
        opened.push({ sessionId, input })
        return { callId: 'page-1', status: 'success', result: { accepted: true }, value: { accepted: true } }
      },
      act: async (sessionId: string, input: unknown) => {
        acted.push({ sessionId, input })
        return { callId: 'page-2', status: 'success', result: { accepted: true }, value: { accepted: true } }
      },
    } as never)
    const tool = tools.get(PAGES_TOOL)!
    const executionCtx = execution({ agent: { session: { id: 's-app' } } } as never)
    expect(await tool.execute({ action: 'open', view: 'list', record: { kind: 'task', id: '1' } }, executionCtx))
      .toMatchObject({ status: 'success', result: { accepted: true } })
    expect(opened).toEqual([{ sessionId: 's-app', input: { view: 'list', record: { kind: 'task', id: '1' } } }])
    await tool.execute({ action: 'open' }, executionCtx)
    expect(opened.at(-1)).toEqual({ sessionId: 's-app', input: {} })
    expect(await tool.execute({ action: 'act', pageId: 'page-1', snapshotId: 'snap-1', pageAction: 'navigate', input: { view: 'list' } }, executionCtx))
      .toMatchObject({ status: 'success' })
    expect(acted.at(-1)).toEqual({ sessionId: 's-app', input: { pageId: 'page-1', snapshotId: 'snap-1', action: 'navigate', input: { view: 'list' } } })
    await expect(tool.execute({ action: 'act', pageId: 'page-1', pageAction: 'navigate' }, executionCtx))
      .rejects.toThrow(/needs pageId and snapshotId/u)
    await expect(tool.execute({ action: 'act', pageAction: 'navigate' }, executionCtx)).rejects.toThrow(/needs pageId/u)
    await expect(tool.execute({ action: 'act', pageId: 'p', snapshotId: 's', pageAction: 'bad' }, executionCtx)).rejects.toThrow(/pageAction/u)
    await expect(tool.execute({ action: 'act', pageId: 'p', snapshotId: 's', pageAction: 'navigate' }, executionCtx))
      .resolves.toMatchObject({ status: 'success' })
    await expect(tool.execute({ action: 'bad' }, executionCtx)).rejects.toThrow(/read, open or act/u)
  })

  it('fails closed when the composition has no page service', async () => {
    const { tools, mark } = await host()
    mark('s-app')
    await expect(tools.get(PAGES_TOOL)!.execute({ action: 'open' }, execution({ agent: { session: { id: 's-app' } } } as never)))
      .rejects.toThrow(/no page service/u)
    await expect(tools.get(PAGES_TOOL)!.execute({ action: 'act', pageId: 'p', snapshotId: 's', pageAction: 'navigate' }, execution({ agent: { session: { id: 's-app' } } } as never)))
      .rejects.toThrow(/no page service/u)
  })
})

describe('draft read tool', () => {
  it('reads only a shared draft through the page service', async () => {
    const { ctx, tools, mark } = await host()
    mark('s-app')
    const calls: Array<{ sessionId: string; input: unknown }> = []
    ctx.provide('appDrafts', {
      read: async (sessionId: string, input: unknown) => {
        calls.push({ sessionId, input })
        return { callId: 'draft-1', status: 'success', result: { draftId: 'd1', revision: 'r1', values: { '/title': 'x' } }, value: { draftId: 'd1', revision: 'r1', values: { '/title': 'x' } } }
      },
      update: async (sessionId: string, input: unknown) => {
        calls.push({ sessionId, input })
        return { callId: 'draft-2', status: 'success', result: { draftId: 'd1', revision: 'r2', values: { '/title': 'y' } }, value: { draftId: 'd1', revision: 'r2', values: { '/title': 'y' } } }
      },
    } as never)
    const tool = tools.get(DRAFTS_TOOL)!
    expect(tool.output.render({}, { kind: 'draft' })).toEqual([{ type: 'text', text: JSON.stringify({ kind: 'draft' }, null, 2) }])
    const executionCtx = execution({ agent: { session: { id: 's-app' } } } as never)
    expect(await tool.execute({ action: 'read', pageId: 'p', draftId: 'd1', fields: ['/title'] }, executionCtx))
      .toMatchObject({ status: 'success', result: { draftId: 'd1' } })
    expect(calls).toEqual([{ sessionId: 's-app', input: { pageId: 'p', draftId: 'd1', fields: ['/title'] } }])
    await tool.execute({ action: 'read', pageId: 'p', draftId: 'd1' }, executionCtx)
    expect(calls.at(-1)).toEqual({ sessionId: 's-app', input: { pageId: 'p', draftId: 'd1' } })
    expect(await tool.execute({ action: 'update', pageId: 'p', draftId: 'd1', revision: 'r1', values: { '/title': 'y' } }, executionCtx))
      .toMatchObject({ status: 'success', result: { revision: 'r2' } })
    expect(calls.at(-1)).toEqual({ sessionId: 's-app', input: { pageId: 'p', draftId: 'd1', revision: 'r1', values: { '/title': 'y' } } })
    await expect(tool.execute({ action: 'update', pageId: 'p', draftId: 'd1', revision: '', values: {} }, executionCtx)).rejects.toThrow(/needs revision/u)
    await expect(tool.execute({ action: 'update', pageId: 'p', draftId: 'd1', revision: 'r1', values: [] }, executionCtx)).rejects.toThrow(/values object/u)
    await expect(tool.execute({ action: 'read', pageId: 'p', draftId: 'd1', fields: 'x' }, executionCtx)).rejects.toThrow(/string array/u)
    await expect(tool.execute({ action: 'write', pageId: 'p', draftId: 'd1' }, executionCtx)).rejects.toThrow(/must be read/u)
    await expect(tool.execute({ action: 'read', pageId: 'p', draftId: '' }, executionCtx)).rejects.toThrow(/needs pageId/u)
    await expect(tool.execute({ action: 'read', pageId: 'p', draftId: 'd1' }, execution())).rejects.toThrow(/require a Session/u)
    const ordinary = execution({ agent: { session: { id: 'ordinary' } } } as never)
    await expect(tool.execute({ action: 'read', pageId: 'p', draftId: 'd1' }, ordinary)).rejects.toThrow(/application conversation/u)
  })

  it('fails closed without a draft service', async () => {
    const { tools, mark } = await host()
    mark('s-app')
    await expect(tools.get(DRAFTS_TOOL)!.execute({ action: 'read', pageId: 'p', draftId: 'd1' }, execution({ agent: { session: { id: 's-app' } } } as never)))
      .rejects.toThrow(/no draft service/u)
    await expect(host([DRAFTS_TOOL])).rejects.toThrow(/already registered/u)
  })
})

describe('page context tool', () => {
  it('reads the owner session page with platform ids and refs only', async () => {
    const { tools, mark, setPage } = await host()
    mark('s-app')
    setPage('s-app', {
      pageId: 'page-1', snapshotId: 'snapshot-2', appId: 'demo', label: 'Tasks', view: 'list', draftId: 'draft-1',
      record: { kind: 'task', id: 't1' }, selection: [{ kind: 'task', id: 't1' }],
      filters: { status: 'open' }, visibleRange: { from: '2026-01-01' }, hasUnsavedChanges: true,
    })
    const tool = tools.get(PAGES_TOOL)!
    expect(tool.output.render({}, { kind: 'page-context' })).toEqual([{ type: 'text', text: JSON.stringify({ kind: 'page-context' }, null, 2) }])
    const read = await tool.execute({}, execution({ agent: { session: { id: 's-app' } } } as never)) as Record<string, unknown>
    expect(read).toMatchObject({
      kind: 'page-context', pageId: 'page-1', snapshotId: 'snapshot-2', appId: 'demo', view: 'list', draftId: 'draft-1', label: 'Tasks',
      record: { appId: 'demo', type: 'task', id: 't1' },
      selection: [{ appId: 'demo', type: 'task', id: 't1' }],
      filters: { status: 'open' }, visibleRange: { from: '2026-01-01' }, hasUnsavedChanges: true,
    })
    expect(read).not.toHaveProperty('body')
    // The page id is an optional fence on read: the current page passes, a
    // stale or malformed id is refused instead of reading another page.
    expect(await tool.execute({ pageId: 'page-1' }, execution({ agent: { session: { id: 's-app' } } } as never)))
      .toMatchObject({ pageId: 'page-1', snapshotId: 'snapshot-2' })
    await expect(tool.execute({ pageId: 'page-old' }, execution({ agent: { session: { id: 's-app' } } } as never)))
      .rejects.toThrow(/no longer visible/u)
    await expect(tool.execute({ pageId: 7 }, execution({ agent: { session: { id: 's-app' } } } as never)))
      .rejects.toThrow(/non-empty string/u)
  })

  it('is unavailable in an ordinary conversation, without a page, or without a Session', async () => {
    const { tools, mark, setPage } = await host()
    const tool = tools.get(PAGES_TOOL)!
    await expect(tool.execute({}, execution({ agent: { session: { id: 'ordinary' } } } as never))).rejects.toThrow(/application conversation/u)
    mark('s-app')
    await expect(tool.execute({}, execution({ agent: { session: { id: 's-app' } } } as never))).rejects.toThrow(/no application page/u)
    setPage('s-app', { appId: 'demo', label: 'Tasks' })
    expect(await tool.execute({}, execution({ agent: { session: { id: 's-app' } } } as never))).toMatchObject({ appId: 'demo', view: 'default' })
    await expect(tool.execute({ pageId: 'page-without-id' }, execution({ agent: { session: { id: 's-app' } } } as never)))
      .rejects.toThrow(/no longer visible/u)
    await expect(tool.execute({}, execution())).rejects.toThrow(/requires a Session/u)
  })
})

describe('unified tool edge cases', () => {
  it('renders its output as JSON text and validates required inputs', async () => {
    const { runtime, tools, mark } = await host()
    await runtime.register(demoApp())
    mark('s')
    const tool = tools.get(APPLICATIONS_TOOL)!
    expect(tool.output.render({}, { applications: [] })).toEqual([{ type: 'text', text: JSON.stringify({ applications: [] }, null, 2) }])
    await expect(tool.execute({ action: 'call' }, execution({ agent: { session: { id: 's' } } } as never)))
      .rejects.toThrow(/non-empty appId/u)
    await expect(tool.execute({ action: 'call', appId: 'demo' }, execution({ agent: { session: { id: 's' } } } as never)))
      .rejects.toThrow(/non-empty op/u)
    await expect(tool.execute({ action: 'nope', appId: 'demo' }, execution({ agent: { session: { id: 's' } } } as never)))
      .rejects.toThrow(/view, read or call/u)
    await expect(tool.execute({ action: 'view' }, execution())).rejects.toThrow(/requires a Session/u)
  })

  it('reports an unknown application and a cancelled call without inventing success', async () => {
    const { runtime, tools, allow, mark } = await host()
    await runtime.register(demoApp())
    allow('s', ['missing'])
    const view = await runApplicationTool(tools, 's', { action: 'view' }) as { applications: unknown[] }
    expect(view.applications).toEqual([{ appId: 'missing', status: 'unavailable', reason: 'not-registered' }])
    await expect(runApplicationTool(tools, 's', { action: 'read', appId: 'missing' })).rejects.toThrow(/no application/u)

    mark('app')
    const tool = tools.get(APPLICATIONS_TOOL)!
    const cancelled = await tool.execute(
      { action: 'call', appId: 'demo', op: 'slow' },
      execution({ agent: { session: { id: 'app' } }, signal: AbortSignal.abort() } as never),
    ) as { status: string; error: { code: string } }
    expect(cancelled).toMatchObject({ status: 'cancelled', error: { code: 'platform.cancelled' } })
  })

  it('fails the row when a tool name is already taken', async () => {
    await expect(host([APPLICATIONS_TOOL])).rejects.toThrow(/already registered/u)
    await expect(host([PAGES_TOOL])).rejects.toThrow(/already registered/u)
  })

  it('unmarks an application conversation and falls back to the turn scope', async () => {
    const { ctx, runtime, tools, mark } = await host()
    await runtime.register(demoApp())
    mark('s-app')
    expect(await runApplicationTool(tools, 's-app', { action: 'view' })).toMatchObject({ applications: [{ appId: 'demo' }] })
    ;(ctx.get('appTools') as { unmark(id: string): void } | undefined)?.unmark('s-app')
    await expect(runApplicationTool(tools, 's-app', { action: 'view' })).rejects.toThrow(/no application is referenced/u)
  })

  it('advertises the owner-session tools only in an application conversation', async () => {
    const { tools, mark } = await host()
    expect(tools.options.get(APPLICATIONS_TOOL)).toBeUndefined()
    const whenPages = tools.options.get(PAGES_TOOL)?.when
    const whenDrafts = tools.options.get(DRAFTS_TOOL)?.when
    expect(whenPages).toBeTypeOf('function')
    expect(whenDrafts).toBeTypeOf('function')
    const context = { agent: { session: { id: 's-app' } } } as never
    expect(await whenPages!(context)).toBe(false)
    expect(await whenDrafts!(context)).toBe(false)
    mark('s-app')
    expect(await whenPages!(context)).toBe(true)
    expect(await whenDrafts!(context)).toBe(true)
  })

  it('advertises the delegation report only while a live delegation is bound', async () => {
    const { ctx, tools } = await host()
    const when = tools.options.get(DELEGATION_REPORT_TOOL)?.when
    expect(when).toBeTypeOf('function')
    const bound = { agent: { session: { id: 's-delegated' } } } as never
    const other = { agent: { session: { id: 's-other' } } } as never
    expect(await when!(bound)).toBe(false)
    ctx.provide('appDelegations', { active: async (id: string) => id === 's-delegated' ? { id: 'd-1' } : undefined } as never)
    expect(await when!(bound)).toBe(true)
    expect(await when!(other)).toBe(false)
  })

  it('hides the delegation report when the delegation table cannot be read', async () => {
    const { ctx, tools } = await host()
    const when = tools.options.get(DELEGATION_REPORT_TOOL)?.when
    ctx.provide('appDelegations', { active: async () => { throw new Error('corrupt table') } } as never)
    expect(await when!({ agent: { session: { id: 's-delegated' } } } as never)).toBe(false)
  })
})
