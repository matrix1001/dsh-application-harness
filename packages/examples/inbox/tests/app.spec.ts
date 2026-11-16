import { Context, resolveConfig } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import * as InboxPlugin from '../src/index.ts'
import { InboxApp } from '../src/app.ts'
import { InboxRepository } from '../src/repository.ts'
import { DEFAULT_SETTINGS } from '../src/model.ts'
import type { Entry, InboxDocument, InboxSettings, Source } from '../src/model.ts'
import { latestTask, makeEntry, makeSource, mountInbox, ok, seeded, textResponse } from './harness.ts'
import type { Mounted } from './harness.ts'

/** Wait until `predicate` holds (task settlement is a real asynchronous step). */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => { setTimeout(resolve, 2) })
  }
}

/** Wait for the newest task of the application to settle. */
async function settled(mounted: Mounted): Promise<ReturnType<typeof latestTask>> {
  await waitFor(() => {
    const task = latestTask(mounted)
    return task !== undefined && task.state !== 'running' && task.state !== 'cancelling'
  })
  return latestTask(mounted)
}

const REQUIRED_OPS = [
  'addManualLink', 'addSource', 'clearEntries', 'favorite', 'getEntry', 'importOpml', 'listEntries', 'listSources',
  'markRead', 'markSeen', 'refresh', 'removeSource', 'saveToNote', 'saveToTask', 'setSettings', 'settings', 'updateSource',
]

describe('inbox declaration and row', () => {
  it('declares identity, data, capabilities, calls and the required operations', async () => {
    const mounted = await mountInbox()
    const declaration = mounted.runtime.list().find(entry => entry.declaration.id === 'inbox')!.declaration
    expect(declaration).toMatchObject({
      id: 'inbox',
      name: '信息收件箱',
      version: '0.2.0-rc.1',
      generation: 2,
      data: { kind: 'unified', namespace: 'inbox', schemaVersion: 1, secretFields: ['githubToken'] },
      capabilities: ['storage', 'network'],
      calls: [{ app: 'tasks', ops: ['createTask'] }, { app: 'notes', ops: ['create'] }],
    })
    expect(Object.keys(declaration.ops).sort()).toEqual(REQUIRED_OPS)
    expect(declaration.ops.refresh?.exposure?.ai).toBe('confirm')
    expect(declaration.ops.saveToTask?.exposure?.ai).toBe('confirm')
    expect(declaration.ops.saveToNote?.exposure?.ai).toBe('confirm')
    expect(declaration.ops.addManualLink?.exposure?.ai).toBe('confirm')
    expect(declaration.ops.markRead?.exposure?.ai).toBe('open')
    expect(declaration.ops.favorite?.exposure?.ai).toBe('open')
    expect(declaration.ops.addSource?.exposure?.ai).toBe('closed')
    expect(declaration.ops.updateSource?.exposure?.ai).toBe('closed')
    expect(declaration.ops.removeSource?.exposure?.ai).toBe('closed')
    expect(declaration.ops.importOpml?.exposure?.ai).toBe('closed')
    expect(declaration.ops.clearEntries?.exposure?.ai).toBe('closed')
    expect(declaration.ops.setSettings?.exposure?.ai).toBe('closed')
    expect(declaration.ops.listSources?.effect).toBe('read')
    await mounted.dispose()
  })

  it('publishes the plugin name, inject list and no default export', () => {
    expect(InboxPlugin.name).toBe('inbox')
    expect(InboxPlugin.inject).toEqual(['applications', 'applicationStore'])
    expect('default' in InboxPlugin).toBe(false)
  })

  it('validates the row config before the plugin runs', () => {
    expect(() => resolveConfig({ Config: InboxPlugin.Config } as never, { tickMs: 'soon' })).toThrow(/invalid config/)
    const validated = InboxPlugin.Config['~standard'].validate({ tickMs: 0 }) as { value: { tickMs: number } }
    expect(validated.value).toEqual({ tickMs: 0 })
  })

  it('refuses to mount without the application store', async () => {
    const ctx = new Context()
    ctx.reflect.provide('applications', new ApplicationRuntime())
    await expect(InboxPlugin.apply(ctx, {})).rejects.toThrow(/application store/)
  })

})

describe('inbox entries', () => {
  function documents(): InboxDocument {
    const now = Date.now()
    const sources = [
      makeSource('rss', { name: 'Feed One' }),
      makeSource('github', { id: 's_github' }),
      makeSource('rss', { id: 's_rss2', name: 'Other feed', url: 'https://feed.test/other' }),
      makeSource('github', { id: 's_github2', name: 'Other repo', url: 'https://github.com/other/repo', config: { repo: 'other/repo' } }),
    ]
    const entries: Entry[] = [
      makeEntry({ id: 'e1', title: 'Alpha', publishedAt: now - 10_000 }),
      makeEntry({ id: 'e2', title: 'Beta', readAt: now - 5000, seenAt: now - 5000, content: 'needle here', fetchedAt: now - 20_000 }),
      makeEntry({ id: 'e3', title: 'Gamma', sourceKind: 'manual', favorite: true, fetchedAt: now - 15_000 }),
      makeEntry({ id: 'e4', title: 'Delta', sourceId: 's_github', sourceKind: 'github', readAt: now - 4000, fetchedAt: now - 12_000 }),
    ]
    return seeded({ sources, entries })
  }

  it('lists, filters, searches and reads entries', async () => {
    const mounted = await mountInbox({ seed: documents() })
    const all = await ok<{ entries: Array<{ id: string }>; total: number; counts: Record<string, number> }>(mounted, 'listEntries')
    expect(all.total).toBe(4)
    expect(all.entries.map(entry => entry.id)).toEqual(['e1', 'e4', 'e3', 'e2'])
    expect(all.counts).toEqual({ unread: 2, unseen: 3, saved: 1, all: 4 })
    expect(await ok<unknown>(mounted, 'listEntries', { view: 'saved' })).toMatchObject({ total: 1 })
    expect(await ok<unknown>(mounted, 'listEntries', { unread: true })).toMatchObject({ total: 2 })
    expect(await ok<unknown>(mounted, 'listEntries', { newOnly: true })).toMatchObject({ total: 3 })
    expect(await ok<unknown>(mounted, 'listEntries', { kind: 'manual' })).toMatchObject({ total: 1 })
    expect(await ok<unknown>(mounted, 'listEntries', { sourceId: 's_rss' })).toMatchObject({ total: 2 })
    expect(await ok<unknown>(mounted, 'listEntries', { search: 'NEEDLE' })).toMatchObject({ total: 1 })
    expect(await ok<unknown>(mounted, 'listEntries', { search: '   ' })).toMatchObject({ total: 4 })
    expect(await ok<unknown>(mounted, 'listEntries', { view: 'inbox', offset: 1, limit: 2 })).toMatchObject({ total: 4 })
    expect(await mounted.call('listEntries', { view: 'other' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('listEntries', { kind: 'other' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await ok<Entry>(mounted, 'getEntry', { id: 'e1' })).toMatchObject({ id: 'e1', content: 'Body one' })
    expect(await mounted.call('getEntry', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    await mounted.dispose()
  })

  it('marks read/unread, clears new and favorites entries', async () => {
    const mounted = await mountInbox({ seed: documents() })
    expect(await ok<{ changed: number }>(mounted, 'markRead', { ids: ['e1', 'e2', 'e4', 'missing'], read: true })).toEqual({ changed: 2 })
    expect(await ok<{ changed: number }>(mounted, 'markRead', { ids: ['e1', 'e2', 'e4'], read: true })).toEqual({ changed: 0 })
    let entries = await ok<{ entries: Entry[] }>(mounted, 'listEntries')
    expect(entries.entries.find(entry => entry.id === 'e1')?.readAt).toBeTypeOf('number')
    expect(await ok<{ changed: number }>(mounted, 'markRead', { ids: ['e1', 'e2', 'e4'], read: false })).toEqual({ changed: 3 })
    expect(await ok<{ changed: number }>(mounted, 'markRead', { ids: ['e1'], read: false })).toEqual({ changed: 0 })
    expect(await ok<{ changed: number }>(mounted, 'markSeen', { ids: ['e1', 'e3'] })).toEqual({ changed: 1 })
    expect(await ok<{ changed: number }>(mounted, 'markSeen', { ids: ['e1', 'e3'] })).toEqual({ changed: 0 })
    expect(await ok<Entry>(mounted, 'favorite', { id: 'e1', favorite: true })).toMatchObject({ favorite: true })
    expect(await ok<Entry>(mounted, 'favorite', { id: 'e1', favorite: true })).toMatchObject({ favorite: true })
    expect(await ok<Entry>(mounted, 'favorite', { id: 'e1', favorite: false })).toMatchObject({ favorite: false })
    expect(await mounted.call('favorite', { id: 'missing', favorite: true })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    entries = await ok<{ entries: Entry[] }>(mounted, 'listEntries')
    expect(entries.entries.find(entry => entry.id === 'e1')?.seenAt).toBeTypeOf('number')
    await mounted.dispose()
  })
})

describe('inbox sources', () => {
  it('adds, validates and refuses duplicate sources', async () => {
    const mounted = await mountInbox()
    const rss = await ok<Source>(mounted, 'addSource', { kind: 'rss', url: 'https://feed.test/rss/' })
    expect(rss).toMatchObject({ kind: 'rss', name: 'feed.test', url: 'https://feed.test/rss', intervalMs: DEFAULT_SETTINGS.feedRefreshMs, enabled: true, failures: 0, removed: false, version: 1 })
    expect(await mounted.call('addSource', { kind: 'rss', url: 'https://feed.test/rss' })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    const github = await ok<Source>(mounted, 'addSource', { kind: 'github', repo: 'Owner/Repo', name: 'Repo' })
    expect(github).toMatchObject({ name: 'Repo', url: 'https://github.com/Owner/Repo', config: { repo: 'Owner/Repo' } })
    expect(await mounted.call('addSource', { kind: 'github', url: 'https://github.com/owner/repo' })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    const web = await ok<Source>(mounted, 'addSource', { kind: 'web', url: 'https://page.test/docs', selector: ' #main ', intervalMs: 600_000 })
    expect(web).toMatchObject({ kind: 'web', name: 'page.test', config: { selector: '#main' }, intervalMs: 600_000 })
    expect(await mounted.call('addSource', { kind: 'manual', url: 'https://x.test' })).toMatchObject({ status: 'failed' })
    expect(await mounted.call('addSource', { kind: 'github' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'rss' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'rss', url: 'not a url' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'github', url: 'nope' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'web', url: 'https://x.test', name: '   ' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'web', url: 'https://x.test', selector: 'x'.repeat(201) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'rss', url: 'https://other.test', intervalMs: 1 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const listed = await ok<{ sources: Source[]; health: Record<string, number> }>(mounted, 'listSources')
    expect(listed.sources).toHaveLength(3)
    expect(listed.health).toEqual({ total: 3, ok: 3, error: 0, paused: 0 })
    await mounted.dispose()
  })

  it('edits, pauses, re-targets and removes sources with optimistic concurrency', async () => {
    const web = makeSource('web', { id: 's_web', name: 'Page', config: { selector: '#old', snapshotHash: 'h', snapshotText: 'old' } })
    const rss = makeSource('rss', { id: 's_rss', name: 'Feed' })
    const github = makeSource('github', { id: 's_github' })
    const rss2 = makeSource('rss', { id: 's_rss2', name: 'Other', url: 'https://feed.test/other' })
    const github2 = makeSource('github', { id: 's_github2', name: 'Other repo', url: 'https://github.com/other/repo', config: { repo: 'other/repo' } })
    const mounted = await mountInbox({ seed: seeded({ sources: [web, rss, github, rss2, github2] }) })
    const renamed = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 1, patch: { name: 'Renamed' } })
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2 })
    expect(await mounted.call('updateSource', { id: 's_web', expectedVersion: 1, patch: { name: 'Stale' } })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await mounted.call('updateSource', { id: 'missing', expectedVersion: 1, patch: {} })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await mounted.call('updateSource', { id: 's_web', expectedVersion: 2, patch: { name: '  ' } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const paused = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 2, patch: { enabled: false } })
    expect(paused.enabled).toBe(false)
    const resumed = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 3, patch: { enabled: true } })
    expect(resumed.enabled).toBe(true)
    const interval = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 4, patch: { intervalMs: 900_000 } })
    expect(interval.intervalMs).toBe(900_000)
    const resnap = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 5, patch: { url: 'https://page.test/new' } })
    expect(resnap.url).toBe('https://page.test/new')
    expect(resnap.config.snapshotHash).toBeUndefined()
    const selected = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 6, patch: { selector: '#new' } })
    expect(selected.config.selector).toBe('#new')
    const cleared = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 7, patch: { selector: '' } })
    expect(cleared.config.selector).toBeUndefined()
    const noop = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 8, patch: {} })
    expect(noop.version).toBe(9)
    const sameSelector = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 9, patch: { selector: '' } })
    expect(sameSelector.version).toBe(10)
    const noPatch = await ok<Source>(mounted, 'updateSource', { id: 's_web', expectedVersion: 10 })
    expect(noPatch.version).toBe(11)
    const githubUrl = await ok<Source>(mounted, 'updateSource', { id: 's_github', expectedVersion: 1, patch: { url: 'https://github.com/third/repo' } })
    expect(githubUrl.config.repo).toBe('third/repo')
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 1, patch: { selector: '#x' } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 1, patch: { repo: 'a/b' } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 1, patch: { intervalMs: 2 } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const repo = await ok<Source>(mounted, 'updateSource', { id: 's_github', expectedVersion: 2, patch: { repo: 'new/repo' } })
    expect(repo).toMatchObject({ url: 'https://github.com/new/repo', config: { repo: 'new/repo' } })
    const urlMove = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 1, patch: { url: 'https://feed.test/moved' } })
    expect(urlMove.url).toBe('https://feed.test/moved')
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 2, patch: { url: 'https://feed.test/other' } })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    expect(await mounted.call('updateSource', { id: 's_github', expectedVersion: 3, patch: { repo: 'other/repo' } })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    const removed = await ok<Source>(mounted, 'removeSource', { id: 's_web' })
    expect(removed).toMatchObject({ removed: true, enabled: false })
    expect(await ok<Source>(mounted, 'removeSource', { id: 's_web' })).toMatchObject({ removed: true })
    expect(await mounted.call('removeSource', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await mounted.call('updateSource', { id: 's_web', expectedVersion: 9, patch: {} })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    const all = await ok<{ sources: Source[] }>(mounted, 'listSources', { includeRemoved: true })
    expect(all.sources).toHaveLength(5)
    const visible = await ok<{ sources: Source[] }>(mounted, 'listSources')
    expect(visible.sources).toHaveLength(4)
    await mounted.dispose()
  })

  it('keeps entry counts and health for paused and failing sources', async () => {
    const failing = makeSource('rss', { id: 's_fail', name: 'Fail', lastError: 'boom', failures: 2 })
    const paused = makeSource('web', { id: 's_paused', name: 'Paused', enabled: false })
    const entries = [makeEntry({ id: 'e1', sourceId: 's_fail' }), makeEntry({ id: 'e2', sourceId: 's_fail' }), makeEntry({ id: 'e3', sourceKind: 'manual' })]
    const mounted = await mountInbox({ seed: seeded({ sources: [failing, paused], entries }) })
    const listed = await ok<{ sources: Array<Source & { entryCount: number }>; health: Record<string, number> }>(mounted, 'listSources')
    expect(listed.sources.find(source => source.id === 's_fail')?.entryCount).toBe(2)
    expect(listed.sources.find(source => source.id === 's_paused')?.entryCount).toBe(0)
    expect(listed.health).toEqual({ total: 2, ok: 0, error: 1, paused: 1 })
    await mounted.dispose()
  })

  it('imports OPML and clears entries', async () => {
    const existing = makeSource('rss', { id: 's_rss', name: 'Existing', url: 'https://one.test/rss' })
    const mounted = await mountInbox({ seed: seeded({ sources: [existing], entries: [makeEntry({ id: 'e1' })] }) })
    const xml = `<opml><body>
      <outline type="rss" text="One again" xmlUrl="https://one.test/rss" />
      <outline type="rss" text="Two" xmlUrl="https://two.test/rss" />
      <outline type="rss" text="Broken" xmlUrl="ftp://bad.test/rss" />
      <outline type="rss" text="No url" />
    </body></opml>`
    expect(await ok<{ added: number; skipped: number; invalid: number }>(mounted, 'importOpml', { xml })).toEqual({ added: 1, skipped: 1, invalid: 2 })
    expect(await mounted.call('importOpml', { xml: 'x'.repeat(1_000_001) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const sources = await ok<{ sources: Source[] }>(mounted, 'listSources')
    expect(sources.sources.map(source => source.name).sort()).toEqual(['Existing', 'Two'])
    expect(await ok<{ removed: number }>(mounted, 'clearEntries', { sourceId: 's_rss' })).toEqual({ removed: 1 })
    expect(await mounted.call('clearEntries', { sourceId: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    const added = await ok<Source>(mounted, 'addSource', { kind: 'web', url: 'https://page.test/' })
    await ok(mounted, 'addManualLink', { url: 'https://manual.test/' })
    expect(await ok<{ removed: number }>(mounted, 'clearEntries', {})).toEqual({ removed: 1 })
    expect(await ok<{ total: number }>(mounted, 'listEntries')).toMatchObject({ total: 0 })
    expect(added.removed).toBe(false)
    await mounted.dispose()
  })
})

describe('inbox refresh', () => {
  const rssXml = '<rss><channel><title>Feed</title><item><guid>g1</guid><title>One</title><link>https://feed.test/1</link><description>Body</description></item></channel></rss>'
  const releases = JSON.stringify([{ id: 1, tag_name: 'v1', name: 'One', body: 'Notes', html_url: 'https://gh.test/1', published_at: '2026-01-01T00:00:00Z' }])
  const page = '<html><head><title>Page</title></head><body><p>Version one</p></body></html>'

  it('refreshes every enabled source, dedupes and keeps health', async () => {
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('github', { id: 's_github' }), makeSource('web', { id: 's_web', name: 'Page' }), makeSource('rss', { id: 's_gone', name: 'Gone', removed: true, enabled: false })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    mounted.router.route('https://feed.test/rss', rssXml)
    mounted.router.route('https://api.github.com/', releases)
    mounted.router.route('https://page.test/', page)
    const started = await ok<{ taskId?: string; started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })
    expect(started).toMatchObject({ started: true, sources: 3 })
    const task = await settled(mounted)
    expect(task?.state).toBe('succeeded')
    expect(task?.resultSummary).toEqual({ sources: 3, added: 2, updated: 0, failed: 0, removed: 0 })
    const listed = await ok<{ total: number }>(mounted, 'listEntries')
    expect(listed.total).toBe(2)
    const after = await ok<{ sources: Source[]; health: Record<string, number> }>(mounted, 'listSources')
    expect(after.health).toEqual({ total: 3, ok: 3, error: 0, paused: 0 })
    expect(after.sources.every(source => source.lastSuccessAt !== undefined && source.failures === 0)).toBe(true)
    expect(after.sources.find(source => source.id === 's_web')?.config.snapshotHash).toBeDefined()
    expect(await ok<{ started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })).toMatchObject({ started: true, sources: 3 })
    await settled(mounted)
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(2)
    mounted.router.route('https://page.test/', '<html><head><title>Page</title></head><body><p>Version two</p></body></html>')
    await ok(mounted, 'refresh', { sourceId: 's_web' })
    await settled(mounted)
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(3)
    expect(await ok<{ started: boolean; sources: number }>(mounted, 'refresh', { scope: 'due' })).toMatchObject({ started: false, sources: 0 })
    await mounted.dispose()
  })

  it('records per-source failures, backs off and retries a manual read', async () => {
    const sources = [makeSource('rss', { id: 's_rss', name: 'Broken', intervalMs: 0 })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    mounted.router.routeFetch('https://feed.test/rss', async () => { throw new Error('network down') })
    await ok(mounted, 'refresh', { scope: 'all' })
    let task = await settled(mounted)
    expect(task?.state).toBe('succeeded')
    expect(task?.resultSummary).toMatchObject({ failed: 1, added: 0 })
    let source = (await ok<{ sources: Source[] }>(mounted, 'listSources')).sources[0]!
    expect(source.lastError).toBe('network down')
    expect(source.failures).toBe(1)
    expect(source.backoffUntil).toBeGreaterThan(source.lastCheckedAt ?? 0)
    await ok(mounted, 'refresh', { scope: 'all' })
    task = await settled(mounted)
    source = (await ok<{ sources: Source[] }>(mounted, 'listSources')).sources[0]!
    expect(source.failures).toBe(2)
    const listed = await ok<{ health: Record<string, number> }>(mounted, 'listSources')
    expect(listed.health.error).toBe(1)
    mounted.router.routeFetch('https://feed.test/rss', async () => { throw new Error('') })
    await ok(mounted, 'refresh', { scope: 'all' })
    await settled(mounted)
    expect((await ok<{ sources: Source[] }>(mounted, 'listSources')).sources[0]?.lastError).toBe('the read failed')
    await mounted.dispose()
  })

  it('ignores an emptied refresh scope, an unknown source and a removed source', async () => {
    const mounted = await mountInbox()
    expect(await ok(mounted, 'refresh', { scope: 'all' })).toEqual({ started: false, sources: 0 })
    expect(await mounted.call('refresh', { scope: 'other' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('refresh', { sourceId: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    const source = await ok<Source>(mounted, 'addSource', { kind: 'rss', url: 'https://feed.test/rss' })
    await ok(mounted, 'removeSource', { id: source.id })
    expect(await ok<{ started: boolean }>(mounted, 'refresh', { sourceId: source.id })).toEqual({ started: false, sources: 0 })
    await mounted.dispose()
  })

  it('joins the running refresh and cancels the task on request', async () => {
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('web', { id: 's_web' })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mounted.router.routeFetch('https://feed.test/rss', async () => { await held; return textResponse(rssXml) })
    mounted.router.route('https://page.test/', page)
    const first = await ok<{ taskId?: string; started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })
    expect(first.started).toBe(true)
    const joined = await ok<{ taskId?: string; started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })
    expect(joined).toEqual({ taskId: first.taskId, started: false, sources: 0 })
    release()
    expect((await settled(mounted))?.state).toBe('succeeded')
    await mounted.dispose()
  })

  it('cancels a refresh and stops the remaining sources', async () => {
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('web', { id: 's_web' })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    mounted.router.routeFetch('https://feed.test/rss', async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    }))
    mounted.router.route('https://page.test/', page)
    const started = await ok<{ taskId?: string; started: boolean }>(mounted, 'refresh', { scope: 'all' })
    await waitFor(() => mounted.router.calls.length === 1)
    expect(mounted.runtime.cancelTask('inbox', started.taskId!)).toBe('accepted')
    const task = await settled(mounted)
    expect(task?.state).toBe('cancelled')
    expect(mounted.router.calls).toHaveLength(1)
    expect((await ok<{ sources: Source[] }>(mounted, 'listSources')).sources.every(source => source.lastError === undefined)).toBe(true)
    await mounted.dispose()
  })

  it('cancels between two sources after the first one completed', async () => {
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('web', { id: 's_web' })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mounted.router.routeFetch('https://feed.test/rss', async () => { await held; return textResponse(rssXml) })
    mounted.router.route('https://page.test/', page)
    const started = await ok<{ taskId?: string }>(mounted, 'refresh', { scope: 'all' })
    await waitFor(() => mounted.router.calls.length === 1)
    expect(mounted.runtime.cancelTask('inbox', started.taskId!)).toBe('accepted')
    release()
    const task = await settled(mounted)
    expect(task?.state).toBe('cancelled')
    expect(mounted.router.calls).toHaveLength(1)
    await mounted.dispose()
  })

  it('skips a timer tick while a refresh is running', async () => {
    const source = makeSource('rss', { id: 's_rss', lastCheckedAt: Date.now(), intervalMs: 300_000 })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }), tickMs: 20 })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mounted.router.routeFetch('https://feed.test/rss', async () => { await held; return textResponse(rssXml) })
    await ok(mounted, 'refresh', { scope: 'all' })
    await waitFor(() => mounted.router.calls.length === 1)
    await new Promise<void>(resolve => { setTimeout(resolve, 80) })
    expect(mounted.router.calls).toHaveLength(1)
    release()
    await settled(mounted)
    await mounted.dispose()
  })

  it('drops a source read that was removed while it was in flight', async () => {
    const source = makeSource('rss', { id: 's_rss', name: 'Feed' })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }) })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mounted.router.routeFetch('https://feed.test/rss', async () => { await held; return textResponse(rssXml) })
    await ok(mounted, 'refresh', { scope: 'all' })
    await waitFor(() => mounted.router.calls.length === 1)
    await ok(mounted, 'removeSource', { id: source.id })
    release()
    expect((await settled(mounted))?.resultSummary).toMatchObject({ added: 0, failed: 0 })
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(0)
    await mounted.dispose()
  })

  it('records no failure for a source removed while its read failed', async () => {
    const source = makeSource('rss', { id: 's_rss', name: 'Feed' })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }) })
    let fail!: (error: Error) => void
    mounted.router.routeFetch('https://feed.test/rss', async () => await new Promise((_resolve, reject) => { fail = reject }))
    await ok(mounted, 'refresh', { scope: 'all' })
    await waitFor(() => mounted.router.calls.length === 1)
    await ok(mounted, 'removeSource', { id: source.id })
    fail(new Error('late failure'))
    await settled(mounted)
    const sourceAfter = (await ok<{ sources: Source[] }>(mounted, 'listSources', { includeRemoved: true })).sources[0]!
    expect(sourceAfter.lastError).toBeUndefined()
    await mounted.dispose()
  })

  it('refreshes a paused source on an explicit request and sends the GitHub token', async () => {
    const source = makeSource('github', { id: 's_github', enabled: false })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }) })
    mounted.router.route('https://api.github.com/', releases)
    await ok(mounted, 'setSettings', { githubToken: 'tok_123' })
    const result = await ok<{ started: boolean; sources: number }>(mounted, 'refresh', { sourceId: source.id })
    expect(result).toEqual({ started: true, sources: 1, taskId: expect.any(String) })
    await settled(mounted)
    expect(mounted.router.calls[0]?.headers.authorization).toBe('Bearer tok_123')
    await mounted.dispose()
  })

  it('runs the automatic timer, pauses and resumes it', async () => {
    const source = makeSource('rss', { id: 's_rss', lastCheckedAt: 1, intervalMs: 300_000 })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }), tickMs: 20 })
    mounted.router.route('https://feed.test/rss', rssXml)
    mounted.router.route('https://feed.test/second', rssXml)
    await waitFor(() => mounted.router.calls.length === 1)
    const lease = await mounted.runtime.beginMaintenance('inbox')
    await new Promise<void>(resolve => { setTimeout(resolve, 80) })
    expect(mounted.router.calls).toHaveLength(1)
    await lease.release()
    await ok(mounted, 'addSource', { kind: 'rss', url: 'https://feed.test/second' })
    await waitFor(() => mounted.router.calls.length >= 2)
    await mounted.dispose()
  })

  it('does not arm the scheduler when the tick is disabled', async () => {
    const source = makeSource('rss', { id: 's_rss', lastCheckedAt: 1 })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }), tickMs: 0 })
    await new Promise<void>(resolve => { setTimeout(resolve, 80) })
    expect(mounted.router.calls).toHaveLength(0)
    await mounted.dispose()
  })
})

describe('inbox settings', () => {
  it('reads and writes settings without storing the token in the document', async () => {
    const mounted = await mountInbox()
    const initial = await ok<{ retentionDays: number; githubTokenSet: boolean }>(mounted, 'settings')
    expect(initial).toMatchObject({ ...DEFAULT_SETTINGS, githubTokenSet: false })
    const updated = await ok<InboxSettings & { githubTokenSet: boolean }>(mounted, 'setSettings', { patch: { retentionDays: 30, maxEntries: 100 } })
    expect(updated).toMatchObject({ retentionDays: 30, maxEntries: 100, githubTokenSet: false })
    expect(await mounted.call('setSettings', { patch: { retentionDays: -1 } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const withToken = await ok<{ githubTokenSet: boolean }>(mounted, 'setSettings', { githubToken: ' secret ' })
    expect(withToken.githubTokenSet).toBe(true)
    expect([...mounted.secretValues.values()]).toEqual(['secret'])
    await ok(mounted, 'setSettings', { githubToken: '' })
    expect((await ok<{ githubTokenSet: boolean }>(mounted, 'settings')).githubTokenSet).toBe(true)
    await ok(mounted, 'setSettings', { githubToken: null })
    expect((await ok<{ githubTokenSet: boolean }>(mounted, 'settings')).githubTokenSet).toBe(false)
    await ok(mounted, 'setSettings', { patch: {} })
    const stored = await mounted.gated.documents.get<InboxDocument>('document')
    expect(JSON.stringify(stored?.value)).not.toContain('secret')
    await mounted.dispose()
  })

  it('prunes on start and after a settings shrink', async () => {
    const now = Date.now()
    const expired = makeEntry({ id: 'e_old', readAt: now - 200 * 24 * 60 * 60_000 })
    const fresh = makeEntry({ id: 'e_fresh', readAt: now })
    const mounted = await mountInbox({ seed: seeded({ entries: [expired, fresh, makeEntry({ id: 'e_third', readAt: now - 1 })], settings: { retentionDays: 90 } }) })
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(2)
    await ok(mounted, 'setSettings', { patch: { maxEntries: 1 } })
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(1)
    await mounted.dispose()
  })

  it('reloads the document after an external write', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }) })
    const next = seeded({ entries: [makeEntry({ id: 'e2' }), makeEntry({ id: 'e3' })] })
    await mounted.gated.documents.put('document', next, { schemaVersion: 1 })
    await mounted.runtime.reload('inbox')
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(2)
    await mounted.dispose()
  })
})

describe('inbox hand-over', () => {
  it('creates one task per entry and replays the stored id', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1', title: 'Title' })] }) })
    const first = await ok<{ taskId: string }>(mounted, 'saveToTask', { id: 'e1', projectId: 'p1' })
    expect(first.taskId).toBe('t_1')
    expect(mounted.taskCalls).toHaveLength(1)
    expect(mounted.taskCalls[0]).toMatchObject({
      title: 'Title',
      projectId: 'p1',
      requestId: 'inbox:e1:task',
      source: { app: 'inbox', id: 'e1', url: 'https://feed.test/1', title: 'Title' },
    })
    expect(await ok<{ taskId: string }>(mounted, 'saveToTask', { id: 'e1' })).toEqual({ taskId: 't_1' })
    expect(mounted.taskCalls).toHaveLength(1)
    expect((await ok<Entry>(mounted, 'getEntry', { id: 'e1' })).taskId).toBe('t_1')
    await mounted.dispose()
  })

  it('creates one note per entry and replays the stored id', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1', title: 'Title', summary: 'Summary', content: 'Body' })] }) })
    expect(await ok<{ noteId: string }>(mounted, 'saveToNote', { id: 'e1' })).toEqual({ noteId: 'n_1' })
    expect(mounted.noteCalls[0]).toMatchObject({
      body: 'Title\n\nSummary\n\nBody\n\nhttps://feed.test/1',
      tags: ['inbox:rss'],
      source: { app: 'inbox', id: 'e1' },
      requestId: 'inbox:e1:note',
    })
    expect(await ok<{ noteId: string }>(mounted, 'saveToNote', { id: 'e1' })).toEqual({ noteId: 'n_1' })
    expect(mounted.noteCalls).toHaveLength(1)
    await mounted.dispose()
  })

  it('reports the unavailable peer and a cancelled hand-over', async () => {
    const missing = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }), withTasks: false, withNotes: false })
    expect(await missing.call('saveToTask', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-unavailable' } })
    expect(await missing.call('saveToNote', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-unavailable' } })
    await missing.dispose()
    const cancelled = await mountInbox({
      seed: seeded({ entries: [makeEntry({ id: 'e1' })] }),
      tasksReply: () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) },
    })
    expect(await cancelled.call('saveToTask', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-unavailable', message: expect.stringContaining('cancelled')  }})
    await cancelled.dispose()
  })

  it('refuses a peer result it cannot read', async () => {
    const empty = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }), tasksReply: () => [] as never })
    expect(await empty.call('saveToTask', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-invalid-result' } })
    await empty.dispose()
    const noId = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }), notesReply: () => ({ body: 'x' }) })
    expect(await noId.call('saveToNote', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-invalid-result' } })
    await noId.dispose()
  })

  it('keeps one taskId when two hand-overs overlap, and survives a pruned entry', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })] }) })
    const [first, second] = await Promise.all([
      mounted.call('saveToTask', { id: 'e1' }),
      mounted.call('saveToTask', { id: 'e1' }),
    ])
    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    expect((first as unknown as { result: { taskId: string } }).result.taskId).toBe((second as unknown as { result: { taskId: string } }).result.taskId)
    expect((await ok<Entry>(mounted, 'getEntry', { id: 'e1' })).taskId).toBe('t_1')
    await mounted.dispose()

    let late: Mounted
    late = await mountInbox({
      seed: seeded({ entries: [makeEntry({ id: 'e1' })] }),
      tasksReply: async () => {
        await late.call('clearEntries', {})
        return { id: 't_late' }
      },
    })
    expect(await ok<{ taskId: string }>(late, 'saveToTask', { id: 'e1' })).toEqual({ taskId: 't_late' })
    expect((await ok<{ total: number }>(late, 'listEntries')).total).toBe(0)
    await late.dispose()
  })

  it('keeps one noteId when two note hand-overs overlap and survives a pruned entry', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }) })
    const [first, second] = await Promise.all([
      mounted.call('saveToNote', { id: 'e1' }),
      mounted.call('saveToNote', { id: 'e1' }),
    ])
    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    expect((first as unknown as { result: { noteId: string } }).result.noteId).toBe((second as unknown as { result: { noteId: string } }).result.noteId)
    expect((await ok<Entry>(mounted, 'getEntry', { id: 'e1' })).noteId).toBe('n_1')
    await mounted.dispose()

    let late: Mounted
    late = await mountInbox({
      seed: seeded({ entries: [makeEntry({ id: 'e1' })] }),
      notesReply: async () => {
        await late.call('clearEntries', {})
        return { id: 'n_late' }
      },
    })
    expect(await ok<{ noteId: string }>(late, 'saveToNote', { id: 'e1' })).toEqual({ noteId: 'n_late' })
    await late.dispose()
  })
})

describe('inbox manual links', () => {
  it('fetches a page title/description and falls back when the fetch fails', async () => {
    const mounted = await mountInbox()
    mounted.router.route('https://x.test/a', '<html><head><title>Page A</title><meta name="description" content="About A"></head><body><p>Body A</p></body></html>')
    const fetched = await ok<Entry>(mounted, 'addManualLink', { url: 'https://x.test/a#frag' })
    expect(fetched).toMatchObject({ sourceKind: 'manual', url: 'https://x.test/a', title: 'Page A', summary: 'About A', content: 'Body A', favorite: false })
    expect(await ok<Entry>(mounted, 'addManualLink', { url: 'https://x.test/a' })).toEqual(fetched)
    expect(mounted.router.calls).toHaveLength(1)
    const titled = await ok<Entry>(mounted, 'addManualLink', { url: 'https://x.test/b', title: ' Mine ' })
    expect(titled.title).toBe('Mine')
    mounted.router.route('https://x.test/blank', '<html></html>')
    const blank = await ok<Entry>(mounted, 'addManualLink', { url: 'https://x.test/blank' })
    expect(blank).toMatchObject({ title: 'https://x.test/blank', summary: 'https://x.test/blank', content: 'https://x.test/blank' })
    const fallback = await ok<Entry>(mounted, 'addManualLink', { url: 'https://x.test/c' })
    expect(fallback).toMatchObject({ title: 'https://x.test/c', summary: 'https://x.test/c', content: 'https://x.test/c' })
    expect(await mounted.call('addManualLink', { url: 'not a url' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addManualLink', { url: 'ftp://x.test/' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    await mounted.dispose()
  })

  it('falls back without the network capability and collapses an empty page', async () => {
    const mounted = await mountInbox({ capabilities: ['storage'] })
    mounted.router.route('https://x.test/empty', '<html></html>')
    const entry = await ok<Entry>(mounted, 'addManualLink', { url: 'https://x.test/empty' })
    expect(entry).toMatchObject({ title: 'https://x.test/empty', summary: 'https://x.test/empty', content: 'https://x.test/empty' })
    await mounted.dispose()
  })

  it('keeps one entry when two identical links are added at once', async () => {
    const mounted = await mountInbox()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mounted.router.routeFetch('https://x.test/race', async () => { await held; return textResponse('<title>Race</title>') })
    const first = mounted.call('addManualLink', { url: 'https://x.test/race' })
    const second = mounted.call('addManualLink', { url: 'https://x.test/race' })
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe('success')
    expect(b.status).toBe('success')
    expect((a as unknown as { result: Entry }).result.id).toBe((b as unknown as { result: Entry }).result.id)
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(1)
    await mounted.dispose()
  })

  it('uses the host fetch when the row injects no transport', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url)
      return { ok: true, status: 200, text: async () => '<html><head><title>Host</title></head><body><p>Host body</p></body></html>' }
    })
    try {
      const mounted = await mountInbox({ defaultConfig: true })
      const entry = await ok<Entry>(mounted, 'addManualLink', { url: 'https://host.test/a' })
      expect(entry).toMatchObject({ title: 'Host', content: 'Host body' })
      expect(seen).toContain('https://host.test/a')
      await mounted.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('inbox app class guards', () => {
  it('does nothing when the scheduler is resumed before start or stopped twice', () => {
    const app = new InboxApp({ repository: new InboxRepository({ documents: { get: async () => undefined, put: async () => { throw new Error('no') } } }) })
    app.resume()
    app.pause()
    app.stop()
    expect(true).toBe(true)
  })

  it('re-arms only once', async () => {
    const mounted = await mountInbox({ tickMs: 60_000 })
    const registration = mounted.runtime.list().find(entry => entry.declaration.id === 'inbox')!
    await registration.declaration.resume?.({} as never)
    await registration.declaration.resume?.({} as never)
    await mounted.dispose()
  })
})
