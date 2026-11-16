import { describe, expect, it } from 'vitest'
import { APPLICATIONS_TOOL, DRAFTS_TOOL, PAGES_TOOL } from '../src/index.ts'
import { demoApp, execution, host, runApplicationTool } from './harness.ts'

describe('the unified application tool', () => {
  it('registers exactly one application tool', async () => {
    const { tools } = await host()
    expect(tools.names()).toEqual([APPLICATIONS_TOOL, PAGES_TOOL, DRAFTS_TOOL])
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
    const draftsCollision = await host([DRAFTS_TOOL])
    expect(draftsCollision.tools.names()).toEqual([APPLICATIONS_TOOL, PAGES_TOOL])
    expect(draftsCollision.warnings.join('\n')).toContain(`the "${DRAFTS_TOOL}" tool could not be registered`)
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
  })

  it('is unavailable in an ordinary conversation, without a page, or without a Session', async () => {
    const { tools, mark, setPage } = await host()
    const tool = tools.get(PAGES_TOOL)!
    await expect(tool.execute({}, execution({ agent: { session: { id: 'ordinary' } } } as never))).rejects.toThrow(/application conversation/u)
    mark('s-app')
    await expect(tool.execute({}, execution({ agent: { session: { id: 's-app' } } } as never))).rejects.toThrow(/no application page/u)
    setPage('s-app', { appId: 'demo', label: 'Tasks' })
    expect(await tool.execute({}, execution({ agent: { session: { id: 's-app' } } } as never))).toMatchObject({ appId: 'demo', view: 'default' })
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
    expect(view.applications).toEqual([])
    await expect(runApplicationTool(tools, 's', { action: 'read', appId: 'missing' })).rejects.toThrow(/no application/u)

    mark('app')
    const tool = tools.get(APPLICATIONS_TOOL)!
    const cancelled = await tool.execute(
      { action: 'call', appId: 'demo', op: 'slow' },
      execution({ agent: { session: { id: 'app' } }, signal: AbortSignal.abort() } as never),
    ) as { status: string; error: { code: string } }
    expect(cancelled).toMatchObject({ status: 'cancelled', error: { code: 'platform.cancelled' } })
  })

  it('reports a registration collision instead of failing the whole row', async () => {
    const { tools, warnings } = await host([APPLICATIONS_TOOL])
    expect(tools.names()).toEqual([PAGES_TOOL, DRAFTS_TOOL])
    expect(warnings.join('\n')).toContain('could not be registered')
    const pagesCollision = await host([PAGES_TOOL])
    expect(pagesCollision.tools.names()).toEqual([APPLICATIONS_TOOL, DRAFTS_TOOL])
    expect(pagesCollision.warnings.join('\n')).toContain(`the "${PAGES_TOOL}" tool could not be registered`)
  })

  it('unmarks an application conversation and falls back to the turn scope', async () => {
    const { ctx, runtime, tools, mark } = await host()
    await runtime.register(demoApp())
    mark('s-app')
    expect(await runApplicationTool(tools, 's-app', { action: 'view' })).toMatchObject({ applications: [{ appId: 'demo' }] })
    ;(ctx.get('appTools') as { unmark(id: string): void } | undefined)?.unmark('s-app')
    await expect(runApplicationTool(tools, 's-app', { action: 'view' })).rejects.toThrow(/no application is referenced/u)
  })
})
