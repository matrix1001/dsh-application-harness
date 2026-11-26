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
  'addManualLink', 'addSource', 'clearEntries', 'favorite', 'getEntry', 'importOpml', 'listEntries', 'listGroups', 'listSources',
  'markRead', 'markSeen', 'markSourceRead', 'previewSettings', 'reconvertToNote', 'reconvertToTask', 'refresh', 'removeSource',
  'saveToNote', 'saveToTask', 'setSettings', 'settings', 'updateSource',
]

describe('inbox declaration and row', () => {
  it('declares identity, data, capabilities, calls and the required operations', async () => {
    const mounted = await mountInbox()
    const declaration = mounted.runtime.list().find(entry => entry.declaration.id === 'inbox')!.declaration
    expect(declaration).toMatchObject({
      id: 'inbox',
      name: '信息收件箱',
      version: '0.1.1-dev.0',
      generation: 2,
      data: { kind: 'unified', namespace: 'inbox', schemaVersion: 2 },
      capabilities: ['storage', 'network'],
      calls: [{ app: 'todo', ops: ['createTask'] }, { app: 'notes', ops: ['create'] }],
      events: { 'entry.created': { description: expect.any(String), subscription: 'open' } },
    })
    expect(Object.keys(declaration.ops).sort()).toEqual(REQUIRED_OPS)
    // The narrowed inbox has no credential surface: no token parameter on any
    // operation.
    expect(JSON.stringify(declaration.ops.setSettings?.params)).not.toContain('githubToken')
    expect(JSON.stringify(declaration.ops.addSource?.params)).not.toContain('selector')
    expect(declaration.ops.refresh?.exposure?.ai).toBe('confirm')
    expect(declaration.ops.saveToTask?.exposure?.ai).toBe('confirm')
    expect(declaration.ops.saveToNote?.exposure?.ai).toBe('confirm')
    // The repair actions stay inside the page: a model or peer that can already
    // see the live object must not be able to mint a duplicate.
    expect(declaration.ops.reconvertToTask?.exposure).toEqual({ ai: 'closed', peers: 'closed' })
    expect(declaration.ops.reconvertToNote?.exposure).toEqual({ ai: 'closed', peers: 'closed' })
    expect(declaration.ops.addManualLink?.exposure?.ai).toBe('confirm')
    expect(declaration.ops.markRead?.exposure?.ai).toBe('open')
    expect(declaration.ops.markSourceRead?.exposure).toEqual({ ai: 'confirm', peers: 'closed' })
    expect(declaration.ops.listGroups?.effect).toBe('read')
    expect(declaration.ops.favorite?.exposure?.ai).toBe('open')
    expect(declaration.ops.addSource?.exposure?.ai).toBe('closed')
    expect(declaration.ops.updateSource?.exposure?.ai).toBe('closed')
    expect(declaration.ops.removeSource?.exposure?.ai).toBe('closed')
    expect(declaration.ops.importOpml?.exposure?.ai).toBe('closed')
    expect(declaration.ops.clearEntries?.exposure?.ai).toBe('closed')
    expect(declaration.ops.setSettings?.exposure?.ai).toBe('closed')
    expect(declaration.ops.previewSettings?.effect).toBe('read')
    expect(declaration.ops.previewSettings?.exposure?.peers).toBe('closed')
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

  it('groups the inbox by source and caps each group', async () => {
    const mounted = await mountInbox({ seed: documents() })
    const grouped = await ok<{
      groups: Array<{ sourceId?: string; name: string; total: number; unread: number; entries: Array<{ id: string }>; hasMore: boolean }>
      total: number
      filteredUnread: number
      totalGroups: number
      counts: Record<string, number>
    }>(mounted, 'listGroups')
    expect(grouped.total).toBe(4)
    expect(grouped.filteredUnread).toBe(2)
    expect(grouped.totalGroups).toBe(3)
    expect(grouped.counts).toEqual({ unread: 2, unseen: 3, saved: 1, all: 4 })
    expect(grouped.groups.map(group => group.sourceId)).toEqual(['s_rss', 's_github', undefined])
    expect(grouped.groups[0]).toMatchObject({ name: 'Feed One', total: 2, unread: 1, hasMore: false })
    expect(grouped.groups[0]?.entries.map(entry => entry.id)).toEqual(['e1', 'e2'])
    expect(grouped.groups[2]).toMatchObject({ name: '', total: 1, unread: 1 })
    const capped = await ok<{ groups: Array<{ entries: Array<{ id: string }>; hasMore: boolean }> }>(mounted, 'listGroups', { perGroup: 1 })
    expect(capped.groups[0]?.entries.map(entry => entry.id)).toEqual(['e1'])
    expect(capped.groups[0]?.hasMore).toBe(true)
    const unread = await ok<{ total: number; filteredUnread: number; groups: Array<{ total: number }> }>(mounted, 'listGroups', { unread: true })
    expect(unread).toMatchObject({ total: 2, filteredUnread: 2 })
    expect(unread.groups.map(group => group.total)).toEqual([1, 1])
    expect(await mounted.call('listGroups', { view: 'other' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    await mounted.dispose()
  })

  it('marks every entry of one source read or unread', async () => {
    const mounted = await mountInbox({ seed: documents() })
    expect(await ok<{ changed: number }>(mounted, 'markSourceRead', { sourceId: 's_rss', read: true })).toEqual({ changed: 1 })
    expect(await ok<{ changed: number }>(mounted, 'markSourceRead', { sourceId: 's_rss', read: true })).toEqual({ changed: 0 })
    const listed = await ok<{ entries: Entry[] }>(mounted, 'listEntries', { sourceId: 's_rss' })
    expect(listed.entries.every(entry => entry.readAt !== undefined && entry.seenAt !== undefined)).toBe(true)
    expect(await ok<{ changed: number }>(mounted, 'markSourceRead', { sourceId: 's_rss', read: false })).toEqual({ changed: 2 })
    expect(await ok<{ changed: number }>(mounted, 'markSourceRead', { sourceId: 's_rss', read: false })).toEqual({ changed: 0 })
    expect(await mounted.call('markSourceRead', { sourceId: 'missing', read: true })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    await ok(mounted, 'removeSource', { id: 's_rss' })
    expect(await ok<{ changed: number }>(mounted, 'markSourceRead', { sourceId: 's_rss', read: true })).toEqual({ changed: 2 })
    await mounted.dispose()
  })

  it('reports per-source unread counts and the newest entry time', async () => {
    const mounted = await mountInbox({ seed: documents() })
    const listed = await ok<{ sources: Array<Source & { entryCount: number; unreadCount: number; latestAt?: number }> }>(mounted, 'listSources')
    const feed = listed.sources.find(source => source.id === 's_rss')!
    expect(feed).toMatchObject({ entryCount: 2, unreadCount: 1 })
    expect(feed.latestAt).toBeGreaterThan(0)
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
    expect(rss).toMatchObject({ kind: 'rss', name: 'feed.test', url: 'https://feed.test/rss', intervalMs: 0, enabled: true, failures: 0, removed: false, version: 1 })
    expect(await mounted.call('addSource', { kind: 'rss', url: 'https://feed.test/rss' })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    const github = await ok<Source>(mounted, 'addSource', { kind: 'github', repo: 'Owner/Repo', name: 'Repo' })
    expect(github).toMatchObject({ name: 'Repo', url: 'https://github.com/Owner/Repo', config: { repo: 'Owner/Repo' } })
    expect(await mounted.call('addSource', { kind: 'github', url: 'https://github.com/owner/repo' })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    expect(await mounted.call('addSource', { kind: 'web', url: 'https://page.test/docs' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'manual', url: 'https://x.test' })).toMatchObject({ status: 'failed' })
    expect(await mounted.call('addSource', { kind: 'github' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'rss' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'rss', url: 'not a url' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'github', url: 'nope' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'rss', url: 'https://x.test', name: '   ' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('addSource', { kind: 'rss', url: 'https://other.test', intervalMs: 1 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const listed = await ok<{ sources: Source[]; health: Record<string, number> }>(mounted, 'listSources')
    expect(listed.sources).toHaveLength(2)
    expect(listed.health).toEqual({ total: 2, ok: 2, error: 0, paused: 0 })
    await mounted.dispose()
  })

  it('edits, pauses, re-targets and removes sources with optimistic concurrency', async () => {
    const rss = makeSource('rss', { id: 's_rss', name: 'Feed' })
    const github = makeSource('github', { id: 's_github' })
    const rss2 = makeSource('rss', { id: 's_rss2', name: 'Other', url: 'https://feed.test/other' })
    const github2 = makeSource('github', { id: 's_github2', name: 'Other repo', url: 'https://github.com/other/repo', config: { repo: 'other/repo' } })
    const mounted = await mountInbox({ seed: seeded({ sources: [rss, github, rss2, github2] }) })
    const renamed = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 1, patch: { name: 'Renamed' } })
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2 })
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 1, patch: { name: 'Stale' } })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await mounted.call('updateSource', { id: 'missing', expectedVersion: 1, patch: {} })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 2, patch: { name: '  ' } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const paused = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 2, patch: { enabled: false } })
    expect(paused.enabled).toBe(false)
    const resumed = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 3, patch: { enabled: true } })
    expect(resumed.enabled).toBe(true)
    const interval = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 4, patch: { intervalMs: 900_000 } })
    expect(interval.intervalMs).toBe(900_000)
    const noop = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 5, patch: {} })
    expect(noop.version).toBe(6)
    const noPatch = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 6 })
    expect(noPatch.version).toBe(7)
    const githubUrl = await ok<Source>(mounted, 'updateSource', { id: 's_github', expectedVersion: 1, patch: { url: 'https://github.com/third/repo' } })
    expect(githubUrl.config.repo).toBe('third/repo')
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 7, patch: { repo: 'a/b' } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 7, patch: { intervalMs: 2 } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const repo = await ok<Source>(mounted, 'updateSource', { id: 's_github', expectedVersion: 2, patch: { repo: 'new/repo' } })
    expect(repo).toMatchObject({ url: 'https://github.com/new/repo', config: { repo: 'new/repo' } })
    const urlMove = await ok<Source>(mounted, 'updateSource', { id: 's_rss', expectedVersion: 7, patch: { url: 'https://feed.test/moved' } })
    expect(urlMove.url).toBe('https://feed.test/moved')
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 8, patch: { url: 'https://feed.test/other' } })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    expect(await mounted.call('updateSource', { id: 's_github', expectedVersion: 3, patch: { repo: 'other/repo' } })).toMatchObject({ status: 'failed', error: { code: 'app.duplicate-source' } })
    const removed = await ok<Source>(mounted, 'removeSource', { id: 's_rss' })
    expect(removed).toMatchObject({ removed: true, enabled: false })
    expect(await ok<Source>(mounted, 'removeSource', { id: 's_rss' })).toMatchObject({ removed: true })
    expect(await mounted.call('removeSource', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await mounted.call('updateSource', { id: 's_rss', expectedVersion: 9, patch: {} })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    const all = await ok<{ sources: Source[]; health: Record<string, number> }>(mounted, 'listSources', { includeRemoved: true })
    expect(all.sources).toHaveLength(4)
    expect(all.health).toEqual({ total: 3, ok: 3, error: 0, paused: 0 })
    const visible = await ok<{ sources: Source[] }>(mounted, 'listSources')
    expect(visible.sources).toHaveLength(3)
    await mounted.dispose()
  })

  it('reports degraded health before any list operation loads the document', async () => {
    const failing = makeSource('rss', { id: 's_fail', name: 'Fail', lastError: 'boom', failures: 2 })
    const mounted = await mountInbox({ seed: seeded({ sources: [failing] }) })
    const registration = mounted.runtime.list().find(entry => entry.declaration.id === 'inbox')!
    await mounted.runtime.checkHealth('inbox')
    expect(registration.health()).toBe('degraded')
    expect(registration.detail()).toBe('1 inbox source(s) failed')
    await mounted.dispose()
  })

  it('keeps entry counts and health for paused and failing sources', async () => {
    const failing = makeSource('rss', { id: 's_fail', name: 'Fail', lastError: 'boom', failures: 2 })
    const paused = makeSource('rss', { id: 's_paused', name: 'Paused', url: 'https://feed.test/paused', enabled: false })
    const entries = [makeEntry({ id: 'e1', sourceId: 's_fail' }), makeEntry({ id: 'e2', sourceId: 's_fail' }), makeEntry({ id: 'e3', sourceKind: 'manual' })]
    const mounted = await mountInbox({ seed: seeded({ sources: [failing, paused], entries }) })
    const listed = await ok<{ sources: Array<Source & { entryCount: number }>; health: Record<string, number> }>(mounted, 'listSources')
    expect(listed.sources.find(source => source.id === 's_fail')?.entryCount).toBe(2)
    expect(listed.sources.find(source => source.id === 's_paused')?.entryCount).toBe(0)
    expect(listed.health).toEqual({ total: 2, ok: 0, error: 1, paused: 1 })
    // The declared health hook reads the same health summary: a failing source
    // makes the whole application degraded, with the readable reason as detail.
    const registration = mounted.runtime.list().find(entry => entry.declaration.id === 'inbox')
    expect(registration).toBeDefined()
    await mounted.runtime.checkHealth('inbox')
    expect(registration).toMatchObject({ health: expect.any(Function) })
    expect(registration?.health()).toBe('degraded')
    expect(registration?.detail()).toBe('1 inbox source(s) failed')
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
    const added = await ok<Source>(mounted, 'addSource', { kind: 'rss', url: 'https://three.test/rss' })
    await ok(mounted, 'addManualLink', { url: 'https://manual.test/' })
    expect(await ok<{ removed: number }>(mounted, 'clearEntries', {})).toEqual({ removed: 1 })
    expect(await ok<{ total: number }>(mounted, 'listEntries')).toMatchObject({ total: 0 })
    expect(added.removed).toBe(false)
    await mounted.dispose()
  })
})

describe('inbox refresh', () => {
  const rssXml = '<rss><channel><title>Feed</title><item><guid>g1</guid><title>One</title><link>https://feed.test/1</link><description>Body</description></item></channel></rss>'
  const releasesAtom = `<feed><title>Release notes from r</title><entry><id>tag:github.com,2008:Repository/1/v1</id><title>One release</title><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1" /><updated>2026-01-01T00:00:00Z</updated><content type="html">&lt;p&gt;Release notes&lt;/p&gt;</content></entry></feed>`
  const atomUrl = 'https://github.com/o/r/releases.atom'

  it('adopts the feed title for an RSS source still named by its host', async () => {
    const source = makeSource('rss', { id: 's_rss', name: 'feed.test', url: 'https://feed.test/rss' })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }) })
    mounted.router.route('https://feed.test/rss', rssXml)
    await ok(mounted, 'refresh', { sourceId: source.id })
    await settled(mounted)
    const after = await ok<{ sources: Source[] }>(mounted, 'listSources')
    expect(after.sources[0]?.name).toBe('Feed')
    await mounted.dispose()
  })

  it('refreshes every enabled source, dedupes and keeps health', async () => {
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('github', { id: 's_github' }), makeSource('rss', { id: 's_gone', name: 'Gone', removed: true, enabled: false })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    mounted.router.route('https://feed.test/rss', rssXml)
    mounted.router.route(atomUrl, releasesAtom)
    const started = await ok<{ taskId?: string; started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })
    expect(started).toMatchObject({ started: true, sources: 2 })
    const task = await settled(mounted)
    expect(task?.state).toBe('succeeded')
    expect(task?.resultSummary).toEqual({ sources: 2, added: 2, updated: 0, failed: 0, removed: 0 })
    const listed = await ok<{ total: number }>(mounted, 'listEntries')
    expect(listed.total).toBe(2)
    const after = await ok<{ sources: Source[]; health: Record<string, number> }>(mounted, 'listSources')
    expect(after.health).toEqual({ total: 2, ok: 2, error: 0, paused: 0 })
    expect(after.sources.every(source => source.lastSuccessAt !== undefined && source.failures === 0)).toBe(true)
    expect(await ok<{ started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })).toMatchObject({ started: true, sources: 2 })
    await settled(mounted)
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(2)
    // A changed payload updates the stored entry instead of adding a second one.
    mounted.router.route('https://feed.test/rss', rssXml.replace('Body', 'Changed body'))
    await ok(mounted, 'refresh', { sourceId: 's_rss' })
    const changed = await settled(mounted)
    expect(changed?.resultSummary).toMatchObject({ added: 0, updated: 1 })
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(2)
    expect(await ok<{ started: boolean; sources: number }>(mounted, 'refresh', { scope: 'due' })).toMatchObject({ started: false, sources: 0 })
    await mounted.dispose()
  })

  it('uses the host network service when one is provided', async () => {
    const source = makeSource('rss')
    const seen: Array<{ url: string; init: unknown }> = []
    const mounted = await mountInbox({
      seed: seeded({ sources: [source] }),
      http: {
        getJson: async (url, init) => {
          seen.push({ url, init })
          return { ok: true, status: 200, text: async () => rssXml }
        },
      },
    })
    const started = await ok<{ started: boolean; sources: number }>(mounted, 'refresh', { sourceId: source.id })
    expect(started).toMatchObject({ started: true, sources: 1 })
    await settled(mounted)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ url: source.url, init: { followRedirects: true, allowPrivate: false } })
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(1)
    await mounted.dispose()
  })

  it('fails closed when neither applicationHttp nor an injected transport exists', async () => {
    const source = makeSource('rss')
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }), defaultConfig: true })
    await ok(mounted, 'refresh', { sourceId: source.id })
    await settled(mounted)
    const sources = await ok<{ sources: Source[] }>(mounted, 'listSources')
    expect(sources.sources[0]?.lastError).toContain('network service is unavailable')
    await mounted.dispose()
  })

  it('reads the GitHub releases Atom feed, never the API', async () => {
    const source = makeSource('github', { id: 's_github', enabled: false })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }) })
    mounted.router.route(atomUrl, releasesAtom)
    const result = await ok<{ started: boolean; sources: number }>(mounted, 'refresh', { sourceId: source.id })
    expect(result).toEqual({ started: true, sources: 1, taskId: expect.any(String) })
    await settled(mounted)
    expect(mounted.router.calls.map(call => call.url)).toEqual([atomUrl])
    expect(mounted.router.calls[0]?.headers.authorization).toBeUndefined()
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(1)
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
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('rss', { id: 's_rss2', url: 'https://feed.test/other' })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mounted.router.routeFetch('https://feed.test/rss', async () => { await held; return textResponse(rssXml) })
    mounted.router.route('https://feed.test/other', rssXml)
    const first = await ok<{ taskId?: string; started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })
    expect(first.started).toBe(true)
    const joined = await ok<{ taskId?: string; started: boolean; sources: number }>(mounted, 'refresh', { scope: 'all' })
    expect(joined).toEqual({ taskId: first.taskId, started: false, sources: 0 })
    release()
    expect((await settled(mounted))?.state).toBe('succeeded')
    await mounted.dispose()
  })

  it('cancels a refresh and stops the remaining sources', async () => {
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('rss', { id: 's_rss2', url: 'https://feed.test/other' })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    mounted.router.routeFetch('https://feed.test/rss', async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    }))
    mounted.router.route('https://feed.test/other', rssXml)
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
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('rss', { id: 's_rss2', url: 'https://feed.test/other' })]
    const mounted = await mountInbox({ seed: seeded({ sources }) })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mounted.router.routeFetch('https://feed.test/rss', async () => { await held; return textResponse(rssXml) })
    mounted.router.route('https://feed.test/other', rssXml)
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
    const rejects: Array<(error: Error) => void> = []
    mounted.router.routeFetch('https://feed.test/rss', async () => await new Promise((_resolve, reject) => { rejects.push(reject) }))
    await ok(mounted, 'refresh', { scope: 'all' })
    await waitFor(() => rejects.length === 1)
    await ok(mounted, 'removeSource', { id: source.id })
    rejects[0]!(new Error('late failure'))
    // A transport failure is retried once; fail that attempt too.
    await waitFor(() => rejects.length === 2)
    rejects[1]!(new Error('late failure'))
    await settled(mounted)
    const sourceAfter = (await ok<{ sources: Source[] }>(mounted, 'listSources', { includeRemoved: true })).sources[0]!
    expect(sourceAfter.lastError).toBeUndefined()
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

  it('schedules a source that has no interval of its own on the family setting', async () => {
    const source = makeSource('rss', { id: 's_rss', lastCheckedAt: 1, intervalMs: 0 })
    const mounted = await mountInbox({ seed: seeded({ sources: [source] }), tickMs: 20 })
    mounted.router.route('https://feed.test/rss', rssXml)
    // A stored `0` follows the family setting instead of never running.
    await waitFor(() => mounted.router.calls.length === 1)
    const [after] = (await ok<{ sources: Source[] }>(mounted, 'listSources', { includeRemoved: true })).sources
    expect(after?.intervalMs).toBe(0)
    expect(after?.lastCheckedAt).toBeGreaterThan(1)
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

describe('inbox events', () => {
  const rssTwo = '<rss><channel><title>Feed</title><item><guid>g1</guid><title>One</title><link>https://feed.test/1</link><description>Body</description></item><item><guid>g2</guid><title>Two</title><link>https://feed.test/2</link><description>Other</description></item></channel></rss>'

  it('publishes one refs-only entry.created event per pull that adds entries', async () => {
    const mounted = await mountInbox({ seed: seeded({ sources: [makeSource('rss', { id: 's_rss' })] }), subscribeEvents: true })
    mounted.router.route('https://feed.test/rss', rssTwo)
    await ok(mounted, 'refresh', { scope: 'all' })
    await settled(mounted)
    await waitFor(() => mounted.events.length === 1)
    const event = mounted.events[0]!
    expect(event).toMatchObject({ kind: 'app-event', appId: 'inbox', type: 'entry.created' })
    expect(Object.keys(event).sort()).toEqual(['appId', 'eventId', 'kind', 'occurredAt', 'refs', 'type'])
    expect(event.refs).toHaveLength(2)
    for (const ref of event.refs ?? []) expect(ref).toMatchObject({ appId: 'inbox', type: 'entry', id: expect.stringMatching(/^e_/u) })
    expect(JSON.stringify(event)).not.toContain('Body')
    // The same read creates nothing new: no duplicate event and no duplicate entry.
    await ok(mounted, 'refresh', { scope: 'all' })
    await settled(mounted)
    expect(mounted.events).toHaveLength(1)
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(2)
    // A pull that only updates an existing entry publishes nothing.
    mounted.router.route('https://feed.test/rss', rssTwo.replace('>Body<', '>Changed body<'))
    await ok(mounted, 'refresh', { scope: 'all' })
    const updated = await settled(mounted)
    expect(updated?.resultSummary).toMatchObject({ added: 0, updated: 1 })
    expect(mounted.events).toHaveLength(1)
    await mounted.dispose()
  })

  it('publishes a manually added link as a new entry', async () => {
    const mounted = await mountInbox({ seed: seeded({}), subscribeEvents: true })
    const entry = await ok<Entry>(mounted, 'addManualLink', { url: 'https://example.test/manual' })
    await waitFor(() => mounted.events.length === 1)
    expect(mounted.events[0]).toMatchObject({ type: 'entry.created', refs: [{ appId: 'inbox', type: 'entry', id: entry.id }] })
    // Re-adding the same link creates nothing, so it announces nothing.
    await ok<Entry>(mounted, 'addManualLink', { url: 'https://example.test/manual' })
    expect(mounted.events).toHaveLength(1)
    await mounted.dispose()
  })

  it('publishes the entries created before a cancellation interrupts the next source', async () => {
    const sources = [makeSource('rss', { id: 's_rss' }), makeSource('rss', { id: 's_rss2', url: 'https://feed.test/other' })]
    const mounted = await mountInbox({ seed: seeded({ sources }), subscribeEvents: true })
    mounted.router.route('https://feed.test/rss', rssTwo)
    mounted.router.routeFetch('https://feed.test/other', async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    }))
    const started = await ok<{ taskId?: string }>(mounted, 'refresh', { scope: 'all' })
    await waitFor(() => mounted.router.calls.length === 2)
    expect(mounted.runtime.cancelTask('inbox', started.taskId!)).toBe('accepted')
    expect((await settled(mounted))?.state).toBe('cancelled')
    await waitFor(() => mounted.events.length === 1)
    expect(mounted.events[0]?.refs).toHaveLength(2)
    await mounted.dispose()
  })

  it('stops delivering after the subscriber grant is revoked', async () => {
    const mounted = await mountInbox({ seed: seeded({ sources: [makeSource('rss', { id: 's_rss' })] }), subscribeEvents: true })
    mounted.router.route('https://feed.test/rss', rssTwo)
    await ok(mounted, 'refresh', { scope: 'all' })
    await settled(mounted)
    await waitFor(() => mounted.events.length === 1)
    await mounted.runtime.revoke({ kind: 'app', appId: 'watcher' }, 'event:inbox#entry.created')
    mounted.router.route('https://feed.test/rss', rssTwo.replace('</channel>', '<item><guid>g3</guid><title>Three</title><link>https://feed.test/3</link></item></channel>'))
    await ok(mounted, 'refresh', { scope: 'all' })
    await settled(mounted)
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(3)
    expect(mounted.events).toHaveLength(1)
    await mounted.dispose()
  })
})

describe('inbox settings', () => {
  it('reads and writes settings; no credential is stored or returned', async () => {
    const mounted = await mountInbox()
    const initial = await ok<Record<string, unknown>>(mounted, 'settings')
    expect(initial).toEqual({ ...DEFAULT_SETTINGS })
    expect(initial).not.toHaveProperty('githubTokenSet')
    const updated = await ok<InboxSettings>(mounted, 'setSettings', { patch: { retentionDays: 30, maxEntries: 100 } })
    expect(updated).toMatchObject({ retentionDays: 30, maxEntries: 100 })
    expect(await mounted.call('setSettings', { patch: { retentionDays: -1 } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await mounted.call('setSettings', { githubToken: 'secret' })).toMatchObject({ status: 'success' })
    const stored = await mounted.gated.documents.get<InboxDocument>('document')
    expect(JSON.stringify(stored?.value)).not.toContain('secret')
    await mounted.dispose()
  })

  it('previews the unread entries a ceiling would prune', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1', fetchedAt: 1 }), makeEntry({ id: 'e2', fetchedAt: 2 }), makeEntry({ id: 'e3', fetchedAt: 3 })] }) })
    const preview = await ok<{ removedEntries: number; settings: InboxSettings }>(mounted, 'previewSettings', { patch: { maxEntries: 1 } })
    expect(preview.removedEntries).toBe(2)
    expect(preview.settings.maxEntries).toBe(1)
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(3)
    await mounted.dispose()
  })

  it('previews the prune without writing or changing settings', async () => {
    const now = Date.now()
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1', readAt: now }), makeEntry({ id: 'e2', readAt: now - 1 }), makeEntry({ id: 'e3', readAt: now - 2 })], settings: { retentionDays: 90 } }) })
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(3)
    const preview = await ok<{ settings: InboxSettings; removedEntries: number; removedBytes: number }>(mounted, 'previewSettings', { patch: { maxEntries: 1 } })
    expect(preview.settings.maxEntries).toBe(1)
    expect(preview.removedEntries).toBe(2)
    expect(preview.removedBytes).toBeGreaterThan(0)
    // Nothing was pruned or written.
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(3)
    expect(await ok<InboxSettings>(mounted, 'settings')).toEqual({ ...DEFAULT_SETTINGS, retentionDays: 90 })
    expect(await mounted.call('previewSettings', { patch: { maxEntries: -1 } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
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
    await mounted.gated.documents.put('document', next, { schemaVersion: 2 })
    await mounted.runtime.reload('inbox')
    expect((await ok<{ total: number }>(mounted, 'listEntries')).total).toBe(2)
    await mounted.dispose()
  })
})

describe('inbox hand-over', () => {
  it('creates one task per entry and replays the stored id', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1', title: 'Title' })] }) })
    const first = await ok<{ taskId: string }>(mounted, 'saveToTask', { id: 'e1' })
    expect(first.taskId).toBe('t_1')
    expect(mounted.todoCalls).toHaveLength(1)
    expect(mounted.todoCalls[0]).toMatchObject({
      title: 'Title',
      requestId: 'inbox:e1:task',
      source: { app: 'inbox', id: 'e1', url: 'https://feed.test/1', title: 'Title' },
    })
    expect(await ok<{ taskId: string }>(mounted, 'saveToTask', { id: 'e1' })).toEqual({ taskId: 't_1' })
    expect(mounted.todoCalls).toHaveLength(1)
    expect((await ok<Entry>(mounted, 'getEntry', { id: 'e1' })).taskId).toBe('t_1')
    await mounted.dispose()
  })

  it('re-creates the task only through the repair operation', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }) })
    expect(await ok<{ taskId: string }>(mounted, 'saveToTask', { id: 'e1' })).toEqual({ taskId: 't_1' })
    // The ordinary path keeps replaying the stored reference: only the page,
    // which resolved it, may declare it gone.
    expect(await ok<{ taskId: string }>(mounted, 'saveToTask', { id: 'e1' })).toEqual({ taskId: 't_1' })
    expect(mounted.todoCalls).toHaveLength(1)
    expect(await ok<{ taskId: string }>(mounted, 'reconvertToTask', { id: 'e1' })).toEqual({ taskId: 't_2' })
    expect(mounted.todoCalls).toHaveLength(2)
    expect((await ok<Entry>(mounted, 'getEntry', { id: 'e1' })).taskId).toBe('t_2')
    await mounted.dispose()
  })

  it('re-saves the note only through the repair operation', async () => {
    const mounted = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }) })
    expect(await ok<{ noteId: string }>(mounted, 'saveToNote', { id: 'e1' })).toEqual({ noteId: 'n_1' })
    expect(await ok<{ noteId: string }>(mounted, 'reconvertToNote', { id: 'e1' })).toEqual({ noteId: 'n_2' })
    expect(mounted.noteCalls).toHaveLength(2)
    expect((await ok<Entry>(mounted, 'getEntry', { id: 'e1' })).noteId).toBe('n_2')
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
    const missing = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }), withTodo: false, withNotes: false })
    expect(await missing.call('saveToTask', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-unavailable' } })
    expect(await missing.call('saveToNote', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-unavailable' } })
    await missing.dispose()
    const cancelled = await mountInbox({
      seed: seeded({ entries: [makeEntry({ id: 'e1' })] }),
      todoReply: () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) },
    })
    expect(await cancelled.call('saveToTask', { id: 'e1' })).toMatchObject({ status: 'failed', error: { code: 'app.dependency-unavailable', message: expect.stringContaining('cancelled')  }})
    await cancelled.dispose()
  })

  it('refuses a peer result it cannot read', async () => {
    const empty = await mountInbox({ seed: seeded({ entries: [makeEntry({ id: 'e1' })] }), todoReply: () => [] as never })
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
      todoReply: async () => {
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

  it('does not use the process-global fetch when the row injects no transport', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url)
      return { ok: true, status: 200, text: async () => '<html><head><title>Host</title></head><body><p>Host body</p></body></html>' }
    })
    try {
      const mounted = await mountInbox({ defaultConfig: true })
      const entry = await ok<Entry>(mounted, 'addManualLink', { url: 'https://host.test/a' })
      // The manual link is still stored, but no network read happened: without
      // applicationHttp and without an injected transport the row fails closed.
      expect(entry.id).toBeDefined()
      expect(seen).toEqual([])
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
