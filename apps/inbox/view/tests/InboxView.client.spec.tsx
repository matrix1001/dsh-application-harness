// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { InboxPage, InboxView, type InboxTranslate } from '../src/client/InboxView.tsx'
import { type InboxKey, zh } from '../src/client/locales.ts'

type Call = ApplicationViewProps['call']
type Outcome = Awaited<ReturnType<Call>>

const t: InboxTranslate = (key, params) => {
  const template = zh[key as InboxKey]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

function ok(value: unknown): Outcome { return { callId: 'c', status: 'success', result: value as never } }
function failed(message = 'failed'): Outcome { return { callId: 'c', status: 'failed', error: { code: 'failed', message } } }

interface EntryFixture {
  id: string; sourceId?: string; sourceKind: string; externalId: string; url: string; title: string
  summary: string; content: string; publishedAt?: number; fetchedAt: number; readAt?: number; seenAt?: number
  favorite: boolean; taskId?: string; noteId?: string
}
interface SourceFixture { id: string; kind: string; name: string; url: string; enabled: boolean; intervalMs: number; version: number; entryCount: number; unreadCount?: number; latestAt?: number; removed?: boolean; lastSuccessAt?: number; lastError?: string }

const baseEntry: EntryFixture = {
  id: 'e1', sourceId: 'rss:a', sourceKind: 'rss', externalId: 'x', url: 'https://example.test/a',
  title: 'One', summary: 'first', content: 'line one\nline two', publishedAt: 10, fetchedAt: 20, favorite: false,
}
const second: EntryFixture = { ...baseEntry, id: 'e2', title: 'Two', summary: 'second', favorite: true, readAt: 30 }
const sources: SourceFixture[] = [
  { id: 'rss:a', kind: 'rss', name: 'Feed A', url: 'https://example.test/feed', enabled: true, intervalMs: 0, version: 1, entryCount: 2, unreadCount: 1 },
  { id: 'rss:b', kind: 'rss', name: 'Feed B', url: 'https://example.test/b', enabled: false, intervalMs: 0, version: 2, entryCount: 0, unreadCount: 0, lastError: 'offline' },
]

function makeProps(call: Call, overrides: Partial<ApplicationViewProps> = {}): ApplicationViewProps {
  return {
    call,
    cancel: vi.fn(),
    claimProgress: vi.fn(() => () => undefined),
    onChanged: vi.fn(() => () => undefined),
    running: false,
    pageContext: { report: vi.fn(() => () => undefined) },
    openManagement: vi.fn(),
    viewport: { report: vi.fn(() => () => undefined) } as never,
    resolveObject: vi.fn(async () => ({ ok: false as const, error: { code: 'platform.object-unknown-app', message: 'unavailable' } })),
    ui: {} as never,
    ...overrides,
  }
}

function makeBackend(entriesIn: EntryFixture[] = [baseEntry, second], sourcesIn: SourceFixture[] = sources) {
  const entries = entriesIn.map(entry => ({ ...entry }))
  const knownSources = sourcesIn.map(source => ({ ...source }))
  const calls: Array<{ op: string; args: Record<string, unknown> }> = []
  const call = vi.fn(async (op: string, raw: unknown) => {
    const args = (raw ?? {}) as Record<string, unknown>
    calls.push({ op, args })
    switch (op) {
      case 'listEntries': {
        let list = entries.filter(entry => args.view === 'saved' ? entry.favorite : true)
        if (args.unread === true) list = list.filter(entry => entry.readAt === undefined)
        if (args.newOnly === true) list = list.filter(entry => entry.seenAt === undefined)
        if (typeof args.sourceId === 'string') list = list.filter(entry => entry.sourceId === args.sourceId)
        if (typeof args.kind === 'string') list = list.filter(entry => entry.sourceKind === args.kind)
        if (typeof args.search === 'string') list = list.filter(entry => entry.title.includes(args.search as string))
        const offset = typeof args.offset === 'number' ? args.offset : 0
        const limit = typeof args.limit === 'number' ? args.limit : 50
        return ok({ entries: list.slice(offset, offset + limit).map(({ content: _content, ...summary }) => summary), total: list.length, counts: { unread: entries.filter(entry => entry.readAt === undefined).length, unseen: entries.filter(entry => entry.seenAt === undefined).length, saved: entries.filter(entry => entry.favorite).length, all: entries.length } })
      }
      case 'listGroups': {
        let list = entries.filter(entry => args.view === 'saved' ? entry.favorite : true)
        if (args.unread === true) list = list.filter(entry => entry.readAt === undefined)
        if (args.newOnly === true) list = list.filter(entry => entry.seenAt === undefined)
        if (typeof args.sourceId === 'string') list = list.filter(entry => entry.sourceId === args.sourceId)
        if (typeof args.kind === 'string') list = list.filter(entry => entry.sourceKind === args.kind)
        if (typeof args.search === 'string') list = list.filter(entry => entry.title.includes(args.search as string))
        list = [...list].sort((left, right) => (right.publishedAt ?? right.fetchedAt) - (left.publishedAt ?? left.fetchedAt) || left.id.localeCompare(right.id))
        const perGroup = typeof args.perGroup === 'number' ? args.perGroup : 3
        const bySource = new Map<string, { sourceId?: string; name: string; kind: string; removed: boolean; enabled: boolean; total: number; unread: number; latestAt: number; entries: EntryFixture[] }>()
        for (const entry of list) {
          const key = entry.sourceId ?? 'manual'
          const source = knownSources.find(candidate => candidate.id === entry.sourceId)
          const group = bySource.get(key) ?? {
            ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
            name: source?.name ?? '',
            kind: entry.sourceKind,
            removed: source?.removed === true,
            enabled: source?.enabled !== false,
            total: 0,
            unread: 0,
            latestAt: entry.publishedAt ?? entry.fetchedAt,
            entries: [],
          }
          group.total += 1
          if (entry.readAt === undefined) group.unread += 1
          if (group.entries.length < perGroup) group.entries.push(entry)
          bySource.set(key, group)
        }
        const groups = [...bySource.values()].sort((left, right) => Number(left.removed) - Number(right.removed) || right.latestAt - left.latestAt)
        return ok({
          groups: groups.map(group => ({ ...group, hasMore: group.total > group.entries.length, entries: group.entries.map(({ content: _content, ...summary }) => summary) })),
          total: list.length,
          filteredUnread: list.filter(entry => entry.readAt === undefined).length,
          totalGroups: groups.length,
          counts: { unread: entries.filter(entry => entry.readAt === undefined).length, unseen: entries.filter(entry => entry.seenAt === undefined).length, saved: entries.filter(entry => entry.favorite).length, all: entries.length },
        })
      }
      case 'markSourceRead': {
        for (const entry of entries) {
          if (entry.sourceId !== args.sourceId) continue
          if (args.read === true) { entry.readAt = 41; entry.seenAt = 41 } else delete entry.readAt
        }
        return ok({ changed: 1 })
      }
      case 'clearEntries': {
        const removed = entries.filter(entry => entry.sourceId === args.sourceId).length
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index]?.sourceId === args.sourceId) entries.splice(index, 1)
        }
        return ok({ removed })
      }
      case 'markSeen': {
        for (const entry of entries) if ((args.ids as string[]).includes(entry.id)) entry.seenAt = 50
        return ok({ changed: 1 })
      }
      case 'getEntry': return ok(entries.find(entry => entry.id === args.id) ?? baseEntry)
      case 'markRead': {
        for (const entry of entries) if ((args.ids as string[]).includes(entry.id)) {
          if (args.read === true) { entry.readAt = 40; entry.seenAt = 40 } else delete entry.readAt
        }
        return ok({ changed: 1 })
      }
      case 'favorite': {
        const entry = entries.find(item => item.id === args.id)!
        entry.favorite = args.favorite === true
        return ok(entry)
      }
      case 'saveToTask': return ok({ taskId: 't1' })
      case 'saveToNote': return ok({ noteId: 'n2' })
      case 'reconvertToTask': return ok({ taskId: 't2' })
      case 'reconvertToNote': return ok({ noteId: 'n3' })
      case 'refresh': return ok({ started: true, sources: 1 })
      case 'listSources': return ok({ sources: knownSources, health: { total: knownSources.filter(source => !source.removed).length, ok: 1, error: 1, paused: 1 } })
      case 'settings': return ok({ retentionDays: 90, maxEntries: 2000, maxBytes: 50_000_000, githubRefreshMs: 3_600_000, feedRefreshMs: 900_000 })
      case 'addManualLink': entries.push({ ...baseEntry, id: 'e3', title: 'New link', url: String(args.url), summary: '' }); return ok(entries.at(-1))
      case 'addSource': return ok({ ...knownSources[0], id: 'rss:new', name: 'New' })
      case 'updateSource': return ok({ ...knownSources[0]!, enabled: !knownSources[0]!.enabled })
      case 'removeSource': return ok({ ...knownSources[0], removed: true })
      case 'importOpml': return ok({ added: 1, skipped: 2, invalid: 0 })
      case 'previewSettings': return ok({ settings: { retentionDays: 30, maxEntries: 100, maxBytes: 1000, githubRefreshMs: 60_000, feedRefreshMs: 60_000 }, removedEntries: 0, removedBytes: 0 })
      case 'setSettings': return ok({ retentionDays: 30, maxEntries: 100, maxBytes: 1000, githubRefreshMs: 60_000, feedRefreshMs: 60_000 })
      default: return failed(`unexpected ${op}`)
    }
  })
  return { call, entries, calls, sources: knownSources }
}

function confirmSourceRemove(): void {
  fireEvent.click(document.querySelector('[data-inbox-source-remove-confirm]') as HTMLButtonElement)
}

function node(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${selector}`)
  return found
}

function readerButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing reader button ${label}`)
  return found
}

function tabButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.startsWith(label) === true)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing tab ${label}`)
  return found
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('inbox view', () => {
  it('renders the grouped inbox, filters, opens an entry and marks it read', async () => {
    const backend = makeBackend()
    const props = makeProps(backend.call)
    const view = render(<InboxView {...props} t={t} language="en" />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-group]').textContent).toContain('Feed A')
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listGroups' && call.args.unread === true)).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'markRead' && call.args.read === true)).toBe(true) })
    expect(props.pageContext.report).toHaveBeenCalled()
  })

  it('renders a fenced code block through the platform fence', async () => {
    const coded = { ...baseEntry, id: 'e3', title: 'Code', content: '```ts\nconst x = 1\n```' }
    const backend = makeBackend([coded])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} language="en" />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e3"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e3"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader] pre').textContent).toContain('const x = 1') })
  })

  it('keeps Markdown headings, bold and lists in the reader', async () => {
    const markdown = { ...baseEntry, id: 'md1', title: 'Markdown', content: '## The short version\n\n**Bold:** text\n\n- one\n- two\n' }
    const backend = makeBackend([markdown])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="md1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="md1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader-content] h2').textContent).toBe('The short version') })
    expect(node(view.container, '[data-inbox-reader-content] strong').textContent).toBe('Bold:')
    expect(view.container.querySelectorAll('[data-inbox-reader-content] li')).toHaveLength(2)
  })

  it('searches, toggles favorite, saves to task/note and shows notices', async () => {
    const backend = makeBackend()
    const props = makeProps(backend.call)
    const view = render(<InboxView {...props} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    const search = node(view.container, 'input[aria-label="搜索标题、摘要、正文、来源"]')
    fireEvent.change(search, { target: { value: 'Two' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries' && call.args.search === 'Two')).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-entry="e2"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('Two') })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '取消收藏' || button.textContent === '收藏')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'favorite')).toBe(true) })
    const buttons = Array.from(view.container.querySelectorAll('[data-inbox-reader] button'))
    fireEvent.click(buttons.find(button => button.textContent === '转任务')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-notice]').textContent).toContain('已转任务') })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '存笔记')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-notice]').textContent).toContain('已存笔记') })
  })

  it('shows a live reference as a chip that opens the owning application', async () => {
    const linked = { ...baseEntry, id: 'e9', title: 'Linked', taskId: 't9' }
    const backend = makeBackend([linked])
    const open = vi.fn()
    const resolveObject = vi.fn(async () => ({
      ok: true as const,
      value: { ref: { appId: 'todo', type: 'task', id: 't9' }, title: 'Write the thing' },
    }))
    const view = render(<InboxView {...makeProps(backend.call, { resolveObject, navigation: { open, back: vi.fn(), canBack: () => false } })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e9"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e9"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-task-ref="t9"]').textContent).toContain('Write the thing') })
    fireEvent.click(node(view.container, '[data-inbox-task-ref="t9"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'todo', record: { appId: 'todo', kind: 'task', id: 't9' }, view: 'detail' })
    const done = Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '已转任务')
    expect((done as HTMLButtonElement).disabled).toBe(true)
  })

  it('lets the user convert again once the reference is gone', async () => {
    const linked = { ...baseEntry, id: 'e9', title: 'Linked', taskId: 't9' }
    const backend = makeBackend([linked])
    const resolveObject = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'app.not-found', message: 'todo: no live task t9' },
    }))
    const view = render(<InboxView {...makeProps(backend.call, { resolveObject })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e9"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e9"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-task-link="missing"]').textContent).toContain('任务已删除') })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '重新转任务')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'reconvertToTask')).toBe(true) })
  })

  it('turns a check into a create only on the next click', async () => {
    const linked = { ...baseEntry, id: 'e9', title: 'Linked', taskId: 't9' }
    const backend = makeBackend([linked])
    const resolveObject = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'gateway/internal', message: 'unavailable' } })
      .mockResolvedValue({ ok: false as const, error: { code: 'app.not-found', message: 'todo: no live task t9' } })
    const view = render(<InboxView {...makeProps(backend.call, { resolveObject })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e9"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e9"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-task-link="unknown"]')).toBeTruthy() })
    const check = () => Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '检查任务状态')
    fireEvent.click(check()!)
    // The recheck proves the task is gone, but the button promised a check, so
    // nothing is created until the user asks for the conversion it now offers.
    await waitFor(() => { expect(node(view.container, '[data-inbox-task-link="missing"]').textContent).toContain('任务已删除') })
    expect(backend.calls.some(call => call.op === 'reconvertToTask')).toBe(false)
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '重新转任务')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'reconvertToTask')).toBe(true) })
  })

  it('never creates a duplicate when the reference cannot be checked', async () => {
    const linked = { ...baseEntry, id: 'e9', title: 'Linked', taskId: 't9' }
    const backend = makeBackend([linked])
    const resolveObject = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'gateway/internal', message: 'the carrier is gone' },
    }))
    const view = render(<InboxView {...makeProps(backend.call, { resolveObject })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e9"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e9"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-task-link="unknown"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '检查任务状态')!)
    // An uncheckable reference is not a deleted one: nothing may be created.
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('无法确认') })
    expect(backend.calls.some(call => call.op === 'reconvertToTask' || call.op === 'saveToTask')).toBe(false)
  })

  it('adds a manual link and renders the first-empty inbox state', async () => {
    const backend = makeBackend([], [])
    const props = makeProps(backend.call)
    const view = render(<InboxView {...props} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-empty="first"]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-empty="first"]').textContent).toContain('收件箱还没有内容')
    fireEvent.click(node(view.container, '[data-inbox-empty-add-link]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-dialog="link"]')).toBeTruthy() })
    fireEvent.change(node(view.container, '[data-inbox-dialog="link"] input'), { target: { value: 'https://example.test/new' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="link"] button')).find(button => button.textContent === '添加')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'addManualLink')).toBe(true) })
    expect(backend.entries.some(entry => entry.url === 'https://example.test/new')).toBe(true)
  })

  it('switches to sources, toggles, removes, imports OPML and adds a source', async () => {
    const backend = makeBackend()
    const props = makeProps(backend.call)
    const view = render(<InboxView {...props} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-source-toggle="rss:a"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'updateSource')).toBe(true) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(node(view.container, '[data-inbox-source-remove="rss:a"]'))
    confirmSourceRemove()
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'removeSource')).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '导入 OPML')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-dialog="opml"]')).toBeTruthy() })
    fireEvent.change(node(view.container, '[data-inbox-dialog="opml"] textarea'), { target: { value: '<opml/>' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="opml"] button')).find(button => button.textContent === '导入')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'importOpml')).toBe(true) })
  })

  it('shows the effective interval and edits it through the source dialog', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    // No override: the card says the source follows the settings.
    expect(node(view.container, '[data-inbox-source="rss:a"]').textContent).toContain('跟随设置')
    fireEvent.click(node(view.container, '[data-inbox-source-edit="rss:a"]'))
    const dialog = node(view.container, '[data-inbox-dialog="sourceEdit"]')
    fireEvent.change(dialog.querySelectorAll('input')[1]!, { target: { value: '15' } })
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === '保存')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'updateSource' && (call.args.patch as { intervalMs?: number }).intervalMs === 900_000)).toBe(true) })
  })

  it('clears a source override back to the settings', async () => {
    const backend = makeBackend()
    const baseCall = backend.call
    const call = vi.fn(async (op: string, raw: unknown) => op === 'listSources'
      ? ok({ sources: [{ ...sources[0]!, intervalMs: 900_000 }], health: { total: 1, ok: 1, error: 0, paused: 0 } })
      : baseCall(op, raw))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-source="rss:a"]').textContent).toContain('每 15 分钟')
    fireEvent.click(node(view.container, '[data-inbox-source-edit="rss:a"]'))
    const dialog = node(view.container, '[data-inbox-dialog="sourceEdit"]')
    fireEvent.change(dialog.querySelectorAll('input')[1]!, { target: { value: '' } })
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === '保存')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'updateSource' && (call.args.patch as { intervalMs?: number }).intervalMs === 0)).toBe(true) })
  })

  it('saves settings, refreshes and handles a refresh failure', async () => {
    const backend = makeBackend()
    const baseCall = backend.call
    const call = vi.fn(async (op: string, raw: unknown) => op === 'refresh' ? failed('refresh failed') : baseCall(op, raw))
    const props = makeProps(call)
    const view = render(<InboxView {...props} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '刷新')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('refresh failed') })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-dialog="settings"]')).toBeTruthy() })
    fireEvent.change(node(view.container, '[data-inbox-dialog="settings"] input'), { target: { value: '30' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] button')).find(button => button.textContent === '保存设置')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'setSettings')).toBe(true) })
    const saved = backend.calls.find(call => call.op === 'setSettings')!
    expect((saved.args as { patch: { githubRefreshMs: number } }).patch.githubRefreshMs).toBe(3_600_000)
    expect(node(view.container, '[data-inbox-notice]').textContent).toContain('设置已保存')
  })

  it('confirms before a settings change prunes entries', async () => {
    const backend = makeBackend()
    const call = vi.fn(async (op: string, args: unknown) => op === 'previewSettings'
      ? ok({ settings: { retentionDays: 30, maxEntries: 100, maxBytes: 1000, githubRefreshMs: 60_000, feedRefreshMs: 60_000 }, removedEntries: 2, removedBytes: 1234 })
      : backend.call(op, args as never) as never) as unknown as Call
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-dialog="settings"]')).toBeTruthy() })
    const save = (): void => {
      fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] button')).find(button => button.textContent === '保存设置')!)
    }
    save()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(document.querySelector('[data-confirm-dialog]')?.textContent).toContain('2 条')
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(backend.calls.some(entry => entry.op === 'setSettings')).toBe(false)

    save()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'setSettings')).toBe(true) })
    expect(node(view.container, '[data-inbox-notice]').textContent).toContain('已清理 2 条')
  })

  it('localizes a write permission refusal and offers the permission page', async () => {
    const backend = makeBackend()
    const call = vi.fn(async (op: string, raw: unknown) => op === 'markRead'
      ? { callId: 'c', status: 'failed' as const, error: { code: 'app.capability-not-approved', message: 'the user has not approved app-storage' } }
      : backend.call(op, raw)) as unknown as Call
    const openManagement = vi.fn()
    const view = render(<InboxView {...makeProps(call, { openManagement })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '标为已读')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('没有获得') })
    expect(node(view.container, '[data-inbox-error]').textContent).not.toContain('the user has not approved')
    fireEvent.click(node(view.container, '[data-inbox-error-manage]'))
    expect(openManagement).toHaveBeenCalledWith('permissions')
  })

  it('shows the permission refusal as a light page state without a second action', async () => {
    const permission = { callId: 'c', status: 'failed', error: { code: 'app.capability-not-approved', message: 'the user has not approved app-storage' } }
    const call = vi.fn(async () => permission) as unknown as Call
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-read-failure]')).not.toBeNull() })
    expect(view.container.querySelector('[data-inbox-read-failure]')?.textContent).toContain('尚未读取收件箱')
    expect(view.container.querySelector('[data-inbox-read-failure]')?.textContent).toContain('右上角')
    expect(view.container.querySelector('[data-inbox-read-manage]')).toBeNull()
    expect(view.container.querySelector('[data-inbox-read-failure] details')).toBeNull()
    expect(view.container.querySelector('[data-inbox-error]')).toBeNull()
  })

  it('shows a failed list read instead of pretending the inbox is empty', async () => {
    const call = vi.fn(async () => failed('read failed'))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-read-failure]').textContent).toContain('read failed') })
  })

  it('keeps the page context clearing and leave guard disposable', async () => {
    const backend = makeBackend()
    const report = vi.fn(() => vi.fn())
    const guard = vi.fn(() => true)
    const props = makeProps(backend.call, { pageContext: { report }, registerLeaveGuard: vi.fn(() => () => undefined) })
    const view = render(<InboxView {...props} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(report).toHaveBeenCalled() })
    expect(guard).not.toHaveBeenCalled()
  })
})

describe('inbox view management and failure paths', () => {
  it('opens every dialog, saves settings/sources/OPML and uses every filter', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    const settingsInputs = Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] input'))
    for (const [index, value] of ['30', '100', '60000', '60', '60'].entries()) fireEvent.change(settingsInputs[index]!, { target: { value } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] button')).find(button => button.textContent === '保存设置')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'setSettings')).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加链接')!)
    fireEvent.click(node(view.container, '[data-inbox-dialog="link"] [aria-label="关闭"]'))
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-source-toggle="rss:a"]'))
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '刷新')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'refresh')).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加来源')!)
    fireEvent.change(node(view.container, '[data-inbox-dialog="source"] input'), { target: { value: 'https://example.test/feed' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="source"] button')).find(button => button.textContent === '添加')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'addSource')).toBe(true) })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'refresh' && call.args.sourceId === 'rss:new')).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '导入 OPML')!)
    fireEvent.change(node(view.container, '[data-inbox-dialog="opml"] textarea'), { target: { value: '<opml/>' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="opml"] button')).find(button => button.textContent === '导入')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'importOpml')).toBe(true) })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'refresh' && call.args.scope === 'due')).toBe(true) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(node(view.container, '[data-inbox-source-remove="rss:a"]'))
    confirmSourceRemove()
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'removeSource')).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('收件箱') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    fireEvent.change(node(view.container, 'select[aria-label="全部类型"]'), { target: { value: 'rss' } })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listGroups' && call.args.kind === 'rss')).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('One') })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '返回列表')!)
    expect(view.container.querySelector('[data-inbox-reader]')?.textContent).toContain('选择一条内容')
  })

  it('covers the page wrapper, changed subscription, leave guard and context lifecycle', async () => {
    const backend = makeBackend()
    let localeChanged: (() => void) | undefined
    let dataChanged: (() => void) | undefined
    let leave: (() => boolean | Promise<boolean>) | undefined
    const guard = vi.fn(() => true)
    const report = vi.fn(() => vi.fn())
    const snapshot = { active: 'en' }
    const locale = {
      subscribe: (listener: () => void) => { localeChanged = listener; return () => undefined },
      getSnapshot: () => snapshot,
      bind: () => t,
    }
    const props = makeProps(backend.call, { onChanged: (listener) => { dataChanged = listener; return () => undefined }, pageContext: { report }, registerLeaveGuard: (fn) => { leave = fn; return () => undefined } })
    const view = render(<InboxPage {...props} locale={locale as never} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    localeChanged?.()
    dataChanged?.()
    await waitFor(() => { expect(backend.calls.filter(call => call.op === 'listGroups').length).toBeGreaterThan(1) })
    expect(guard).not.toHaveBeenCalled()
    expect(await leave?.()).toBe(true)
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(report).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({ appId: 'inbox', kind: 'entry' }) })) })
  })

  it.each([
    ['listGroups', 'list failed'],
    ['getEntry', 'entry failed'],
    ['markRead', 'mark failed'],
    ['favorite', 'favorite failed'],
    ['saveToTask', 'task failed'],
    ['saveToNote', 'note failed'],
    ['refresh', 'refresh failed'],
    ['addManualLink', 'link failed'],
    ['addSource', 'source failed'],
    ['updateSource', 'update failed'],
    ['removeSource', 'remove failed'],
    ['importOpml', 'opml failed'],
    ['setSettings', 'settings failed'],
  ])('surfaces a failed %s without crashing', async (op, message) => {
    const backend = makeBackend()
    const base = backend.call
    const call = vi.fn(async (name: string, args: unknown) => name === op ? failed(message) : base(name, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    if (op === 'listGroups') { await waitFor(() => { expect(node(view.container, '[data-inbox-read-failure]').textContent).toContain(message) }); return }
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    if (op === 'getEntry') { fireEvent.click(node(view.container, '[data-inbox-entry="e1"]')); await waitFor(() => { expect(node(view.container, '[data-inbox-reader-error]').textContent).toContain(message) }); return }
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('One') })
    if (op === 'markRead' || op === 'favorite' || op === 'saveToTask' || op === 'saveToNote') {
      const label = op === 'markRead' ? '标为已读' : op === 'favorite' ? '收藏' : op === 'saveToTask' ? '转任务' : '存笔记'
      fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === label)!)
      await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain(message) })
      return
    }
    if (op === 'addManualLink') {
      fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加链接')!)
      fireEvent.change(node(view.container, '[data-inbox-dialog="link"] input'), { target: { value: 'https://example.test/new' } })
      fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="link"] button')).find(button => button.textContent === '添加')!)
      await waitFor(() => { expect(node(view.container, '[data-inbox-dialog-error]').textContent).toContain(message) }); return
    }
    if (op === 'refresh') {
      fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '刷新')!)
      await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain(message) }); return
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    if (op === 'updateSource') { fireEvent.click(node(view.container, '[data-inbox-source-toggle="rss:a"]')); await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain(message) }); return }
    if (op === 'removeSource') { fireEvent.click(node(view.container, '[data-inbox-source-remove="rss:a"]'))
    confirmSourceRemove(); await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain(message) }); return }
    if (op === 'addSource') {
      fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加来源')!)
      fireEvent.change(node(view.container, '[data-inbox-dialog="source"] input'), { target: { value: 'https://example.test/feed' } })
      fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="source"] button')).find(button => button.textContent === '添加')!)
      await waitFor(() => { expect(node(view.container, '[data-inbox-dialog-error]').textContent).toContain(message) }); return
    }
    if (op === 'importOpml') {
      fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '导入 OPML')!)
      fireEvent.change(node(view.container, '[data-inbox-dialog="opml"] textarea'), { target: { value: '<opml/>' } })
      fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="opml"] button')).find(button => button.textContent === '导入')!)
      await waitFor(() => { expect(node(view.container, '[data-inbox-dialog-error]').textContent).toContain(message) }); return
    }
    if (op === 'setSettings') {
      fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
      fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] button')).find(button => button.textContent === '保存设置')!)
      await waitFor(() => { expect(node(view.container, '[data-inbox-dialog-error]').textContent).toContain(message) })
    }
  })
})

describe('inbox view remaining controls', () => {
  it('covers refresh notice, dialog cancel/backdrop, source variants, settings cancel and confirm refusal', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '刷新')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-notice]').textContent).toContain('正在刷新') })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加链接')!)
    fireEvent.change(Array.from(view.container.querySelectorAll('[data-inbox-dialog="link"] input'))[1]!, { target: { value: 'Title' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="link"] button')).find(button => button.textContent === '取消')!)
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加链接')!)
    fireEvent.click(node(view.container, '[data-inbox-dialog="link"]')!.parentElement!)
    expect(view.container.querySelector('[data-inbox-dialog="link"]')).toBeNull()

    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-source-remove="rss:a"]'))
    fireEvent.click(document.querySelector('[role="dialog"] button[aria-label="关闭"]')!)
    expect(backend.calls.some(call => call.op === 'removeSource')).toBe(false)
    fireEvent.click(node(view.container, '[data-inbox-source-remove="rss:a"]'))
    fireEvent.click(Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === '取消')!)
    expect(backend.calls.some(call => call.op === 'removeSource')).toBe(false)
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加来源')!)
    fireEvent.change(node(view.container, '[data-inbox-dialog="source"] select'), { target: { value: 'github' } })
    const githubInputs = Array.from(view.container.querySelectorAll('[data-inbox-dialog="source"] input'))
    fireEvent.change(githubInputs[1]!, { target: { value: 'Name' } })
    fireEvent.change(githubInputs[2]!, { target: { value: 'o/r' } })
    fireEvent.change(githubInputs[3]!, { target: { value: '15' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="source"] button')).find(button => button.textContent === '取消')!)
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '导入 OPML')!)
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="opml"] button')).find(button => button.textContent === '取消')!)
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-dialog="settings"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] button')).find(button => button.textContent === '取消')!)
    expect(view.container.querySelector('[data-inbox-dialog="settings"]')).toBeNull()
  })
})

describe('inbox view final gaps', () => {
  it('reports a failed source list', async () => {
    const backend = makeBackend()
    const base = backend.call
    const call = vi.fn(async (name: string, args: unknown) => name === 'listSources' ? failed('sources failed') : base(name, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('sources failed') })
  })

  it('changes each settings interval', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-dialog="settings"]')).toBeTruthy() })
    const inputs = Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] input'))
    expect(inputs.length).toBeGreaterThanOrEqual(5)
    for (const [index, input] of inputs.slice(0, 5).entries()) fireEvent.change(input, { target: { value: String(60 + index) } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="settings"] button')).find(button => button.textContent === '取消')!)
  })
})

describe('paging and first-read failure', () => {
  it('loads the next page and marks an opened entry read', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...baseEntry, id: `e${String(index)}`, externalId: `x${String(index)}`, title: `Entry ${String(index)}`, ...(index === 0 ? { seenAt: 1 } : {}),
    }))
    const backend = makeBackend(many)
    const view = render(<InboxView {...makeProps(backend.call as Call)} t={t} />)
    fireEvent.click(node(view.container, '[data-inbox-layout="time"]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(50) })
    fireEvent.click(node(view.container, '[data-inbox-load-more]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(60) })
    expect(view.container.querySelector('[data-inbox-load-more]')).toBeNull()
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'markRead' && call.args.read === true)).toBe(true) })
  })

  it('shows a retry instead of an empty list when the first read fails', async () => {
    const backend = makeBackend()
    let first = true
    const call = vi.fn(async (op: string, args: unknown) => {
      if (op === 'listGroups' && first) { first = false; return failed('offline') }
      return backend.call(op, args)
    }) as unknown as Call
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-read-failure]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-read-retry]'))
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-entry="e1"]')).toBeTruthy() })
  })

  it('marks a read entry unread and refreshes one source with its own failure', async () => {
    const backend = makeBackend()
    const base = backend.call
    let failSource = false
    const call = vi.fn(async (op: string, args: unknown) => {
      if (op === 'refresh' && (args as { sourceId?: string }).sourceId !== undefined) return failSource ? failed('source down') : base(op, args)
      return base(op, args)
    })
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('One') })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '标为未读')!)
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'markRead' && entry.args.read === false)).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '标为已读')!)
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'markRead' && entry.args.read === true)).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('来源') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-source="rss:a"] button')).find(button => button.textContent === '刷新')!)
    await waitFor(() => { expect(call.mock.calls.some(([op, args]) => op === 'refresh' && (args as { sourceId?: string }).sourceId === 'rss:a')).toBe(true) })
    failSource = true
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-source="rss:a"] button')).find(button => button.textContent === '刷新')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('source down') })
  })

  it('retries and leaves a failed reader with both actions', async () => {
    const backend = makeBackend()
    let fail = true
    const call = vi.fn(async (op: string, args: unknown) => op === 'getEntry' && fail ? failed('entry down') : backend.call(op, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader-error]').textContent).toContain('entry down') })
    fireEvent.click(node(view.container, '[data-inbox-reader-back]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('选择一条内容') })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader-error]')).toBeTruthy() })
    fail = false
    fireEvent.click(node(view.container, '[data-inbox-reader-retry]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('One') })
    fireEvent.click(node(view.container, '[data-inbox-back]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('选择一条内容') })
  })

  it('offers add-source and clear-filter actions from the empty list', async () => {
    const backend = makeBackend([], [])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-empty-sources]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-empty-sources]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-sources]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('收件箱') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-empty-sources]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-clear-filters]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-clear-filters]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-empty-sources]')).toBeTruthy() })
  })

  it('restores the routed entry, tab and reader focus after a cross-application return', async () => {
    const backend = makeBackend()
    const pageContext = { report: vi.fn(() => () => undefined) }
    const route = { appId: 'inbox', record: { appId: 'inbox', kind: 'entry', id: 'e1' }, view: 'saved', nonce: 'return-1' }
    const view = render(<InboxView {...makeProps(backend.call, { pageContext, route })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    expect(view.getByRole('tab', { name: /稍后读/ }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() => { expect(document.activeElement).toBe(node(view.container, '[data-inbox-reader]')) })
    expect(node(view.container, '[data-inbox-reader]').getAttribute('aria-label')).toBe('One')
  })

  it('returns to the list with a notice when the routed entry is gone', async () => {
    const backend = makeBackend()
    const missing = { callId: 'c', status: 'failed' as const, error: { code: 'app.not-found', message: 'gone' } }
    const call = vi.fn(async (op: string, args: unknown) => op === 'getEntry' ? missing : backend.call(op, args))
    const route = { appId: 'inbox', record: { appId: 'inbox', kind: 'entry', id: 'e1' }, nonce: 'return-2' }
    const view = render(<InboxView {...makeProps(call, { route })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-notice]').textContent).toContain('记录已不存在') })
    expect(view.container.querySelector('[data-inbox-reader]')?.textContent).toContain(t('view.selectEntry'))
    expect(view.container.querySelector('[data-inbox-error]')).toBeNull()
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e2"]')).toBeTruthy() })
  })

  it('retries a failed settings read inside the open dialog', async () => {
    const backend = makeBackend()
    let fail = true
    const base = backend.call
    const call = vi.fn(async (op: string, args: unknown) => op === 'settings' && fail ? failed('settings down') : base(op, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-settings-error]').textContent).toContain('settings down') })
    expect(node(view.container, '[data-inbox-settings-error]').textContent).toContain('设置读取失败')
    fail = false
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-settings-error] button')).find(button => button.textContent === '重试')!)
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-dialog="settings"] input')).toBeTruthy() })
  })
})

describe('list reconciliation after writes', () => {
  it('drops an entry from the unread filter once opening reads it and brings it back when unread', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listGroups' && call.args.unread === true)).toBe(true) })
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-entry="e2"]')).toBeNull() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    // Opening reads the entry, so the row leaves the unread list; the reader
    // keeps its own copy. Marking it unread puts the row back.
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-entry="e1"]')).toBeNull() })
    expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one')
    fireEvent.click(readerButton(view.container, '标为未读'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
  })

  it('drops an unfavorited entry from the saved view', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(tabButton(view.container, '稍后读'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e2"]')).toBeTruthy() })
    expect(view.container.querySelector('[data-inbox-entry="e1"]')).toBeNull()
    fireEvent.click(node(view.container, '[data-inbox-entry="e2"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('Two') })
    fireEvent.click(readerButton(view.container, '取消收藏'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'favorite')).toBe(true) })
    expect(backend.calls.find(call => call.op === 'favorite')?.args).toEqual({ id: 'e2', favorite: false })
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-entry="e2"]')).toBeNull() })
    expect(node(view.container, '[data-inbox-reader]').textContent).toContain('Two')
    // The list is now empty and must say why (the saved shelf, not a filter).
    expect(node(view.container, '[data-inbox-empty="saved"]')).toBeTruthy()
  })

  it('marks every entry of a group read from its menu', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-group-toggle="rss:a"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-group-menu="rss:a"]'))
    fireEvent.click(Array.from(document.querySelectorAll('[role="menuitem"]')).find(button => button.textContent === '全部标为已读')!)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'markSourceRead' && call.args.sourceId === 'rss:a')).toBe(true) })
  })
})

describe('stale list reads', () => {
  it('keeps the loaded list when a filter read fails and retries inside the row', async () => {
    const backend = makeBackend()
    const base = backend.call
    let fail = false
    const call = vi.fn(async (op: string, args: unknown) => op === 'listGroups' && fail ? failed('list down') : base(op, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fail = true
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-list-stale]').textContent).toContain('list down') })
    // A refresh that cannot answer does not clear what was already read.
    expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy()
    expect(node(view.container, '[data-inbox-entry="e2"]')).toBeTruthy()
    expect(view.container.querySelector('[data-inbox-read-failure]')).toBeNull()
    fail = false
    fireEvent.click(node(view.container, '[data-inbox-list-retry]'))
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-list-stale]')).toBeNull() })
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-entry="e2"]')).toBeNull() })
    expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy()
  })
})

describe('empty states', () => {
  it('separates first-empty, filtered, search and saved empty states', async () => {
    const empty = makeBackend([], [])
    const first = render(<InboxView {...makeProps(empty.call)} t={t} />)
    await waitFor(() => { expect(node(first.container, '[data-inbox-empty="first"]')).toBeTruthy() })
    expect(node(first.container, '[data-inbox-empty="first"]').textContent).toContain('收件箱还没有内容')
    fireEvent.click(node(first.container, '[data-inbox-empty-sources]'))
    await waitFor(() => { expect(node(first.container, '[data-inbox-sources]')).toBeTruthy() })
    fireEvent.click(tabButton(first.container, '收件箱'))
    await waitFor(() => { expect(node(first.container, '[data-inbox-empty="first"]')).toBeTruthy() })
    fireEvent.click(tabButton(first.container, '稍后读'))
    await waitFor(() => { expect(node(first.container, '[data-inbox-empty="saved"]')).toBeTruthy() })
    fireEvent.click(node(first.container, '[data-inbox-empty-add-link]'))
    await waitFor(() => { expect(node(first.container, '[data-inbox-dialog="link"]')).toBeTruthy() })
    fireEvent.click(node(first.container, '[data-inbox-dialog="link"] [aria-label="关闭"]'))
    fireEvent.click(node(first.container, '[data-inbox-empty-inbox]'))
    await waitFor(() => { expect(node(first.container, '[data-inbox-empty="first"]')).toBeTruthy() })
    first.unmount()

    const backend = makeBackend([second])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e2"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-empty="filtered"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-clear-filters]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e2"]')).toBeTruthy() })
    const search = node(view.container, 'input[aria-label="搜索标题、摘要、正文、来源"]')
    fireEvent.change(search, { target: { value: 'nothing-matches' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => { expect(node(view.container, '[data-inbox-empty="search"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-clear-search]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e2"]')).toBeTruthy() })
  })
})

describe('focus and row semantics', () => {
  it('moves focus into the reader on open and returns it to the row', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(document.activeElement).toBe(node(view.container, '[data-inbox-reader]')) })
    fireEvent.click(node(view.container, '[data-inbox-back]'))
    await waitFor(() => { expect(document.activeElement).toBe(node(view.container, '[data-inbox-entry="e1"]')) })
  })

  it('falls back to the list when the returned row was filtered out', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listGroups' && call.args.unread === true)).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-entry="e1"]')).toBeNull() })
    fireEvent.click(node(view.container, '[data-inbox-back]'))
    await waitFor(() => { expect(document.activeElement).toBe(node(view.container, '[data-inbox-list]')) })
  })

  it('marks the active filter and exposes the row markers to assistive technology', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-filter="all"]').getAttribute('aria-pressed')).toBe('true')
    expect(node(view.container, '[data-inbox-filter="unread"]').getAttribute('aria-pressed')).toBe('false')
    expect(node(view.container, '[data-inbox-entry="e1"]').textContent).toContain('未读')
    expect(node(view.container, '[data-inbox-entry="e2"]').textContent).toContain('收藏')
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-filter="unread"]').getAttribute('aria-pressed')).toBe('true') })
    expect(node(view.container, '[data-inbox-filter="all"]').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('grouped inbox and source actions', () => {
  const many = Array.from({ length: 5 }, (_, index) => ({
    ...baseEntry,
    id: `m${String(index)}`,
    externalId: `mx${String(index)}`,
    title: `Many ${String(index)}`,
    publishedAt: 100 - index,
  }))
  const other = { ...baseEntry, id: 'o1', sourceId: 'rss:b', externalId: 'ox1', title: 'Other feed entry' }

  it('caps a group, collapses it and preserves the state through a reload', async () => {
    const backend = makeBackend(many)
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-group="rss:a"]')).toBeTruthy() })
    const group = node(view.container, '[data-inbox-group="rss:a"]')
    expect(group.querySelectorAll('[data-inbox-entry]')).toHaveLength(3)
    expect(group.textContent).toContain('5 未读')
    expect(node(view.container, '[data-inbox-summary]').textContent).toContain('5 条 · 5 未读')
    expect(group.querySelector('[data-inbox-group-toggle="rss:a"]')?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(node(view.container, '[data-inbox-group-toggle="rss:a"]'))
    expect(node(view.container, '[data-inbox-group-toggle="rss:a"]').getAttribute('aria-expanded')).toBe('false')
    expect(group.querySelectorAll('[data-inbox-entry]')).toHaveLength(0)
    fireEvent.click(node(view.container, '[data-inbox-group-toggle="rss:a"]'))
    expect(group.querySelectorAll('[data-inbox-entry]')).toHaveLength(3)
  })

  it('switches between source and time layouts and filters one source', async () => {
    const backend = makeBackend([...many, other])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-group="rss:a"]')).toBeTruthy() })
    expect(view.container.querySelectorAll('[data-inbox-group]')).toHaveLength(2)
    fireEvent.click(node(view.container, '[data-inbox-layout="time"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries')).toBe(true) })
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(6) })
    fireEvent.click(node(view.container, '[data-inbox-layout="source"]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-group]')).toHaveLength(2) })
    fireEvent.click(node(view.container, '[data-inbox-group-view="rss:a"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-source-filter]').textContent).toContain('Feed A') })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries' && call.args.sourceId === 'rss:a')).toBe(true) })
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(5) })
    fireEvent.click(node(view.container, '[data-inbox-source-filter-clear]'))
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-source-filter]')).toBeNull() })
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(6) })
  })

  it('keeps source failures in the shell status and the sources tab badge', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    expect(view.container.querySelector('[data-inbox-health-warning]')).toBeNull()
    expect(node(view.container, '[data-inbox-source-errors]').textContent).toContain('1')
    fireEvent.click(tabButton(view.container, '来源'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-sources]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-source-error="rss:b"]')).toBeTruthy()
  })

  it('renders the ready and paused empty states', async () => {
    const ready = makeBackend([], sources)
    const readyView = render(<InboxView {...makeProps(ready.call)} t={t} />)
    await waitFor(() => { expect(node(readyView.container, '[data-inbox-empty="ready"]')).toBeTruthy() })
    fireEvent.click(node(readyView.container, '[data-inbox-empty-refresh]'))
    await waitFor(() => { expect(ready.calls.some(call => call.op === 'refresh')).toBe(true) })
    readyView.unmount()

    const paused = makeBackend([], sources.map(source => ({ ...source, enabled: false })))
    const pausedView = render(<InboxView {...makeProps(paused.call)} t={t} />)
    await waitFor(() => { expect(node(pausedView.container, '[data-inbox-empty="paused"]')).toBeTruthy() })
    fireEvent.click(node(pausedView.container, '[data-inbox-empty-sources]'))
    await waitFor(() => { expect(node(pausedView.container, '[data-inbox-sources]')).toBeTruthy() })
  })

  it('shows removed sources and opens their entries', async () => {
    const gone = { ...baseEntry, id: 'g1', sourceId: 'rss:gone', title: 'Gone entry' }
    const removedSource = { ...sources[0]!, id: 'rss:gone', name: 'Gone feed', removed: true, entryCount: 1, unreadCount: 1 }
    const backend = makeBackend([gone], [removedSource])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-group="rss:gone"]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-group="rss:gone"]').textContent).toContain('已移除')
    fireEvent.click(tabButton(view.container, '来源'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-removed-sources]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-removed-sources]').textContent).toContain('Gone feed')
    fireEvent.click(node(view.container, '[data-inbox-source-view="rss:gone"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries' && call.args.sourceId === 'rss:gone')).toBe(true) })
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="g1"]')).toBeTruthy() })
  })

  it('marks a source read and clears its entries from the source page', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(tabButton(view.container, '来源'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-source-counts="rss:a"]').textContent).toContain('2 条 · 1 未读') })
    fireEvent.click(node(view.container, '[data-inbox-source-read="rss:a"]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'markSourceRead' && call.args.sourceId === 'rss:a')).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-source-clear="rss:a"]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'clearEntries' && call.args.sourceId === 'rss:a')).toBe(true) })
  })

  it('clears one source from the group menu', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-group-menu="rss:a"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listGroups' && call.args.unread === true)).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-group-menu="rss:a"]'))
    fireEvent.click(Array.from(document.querySelectorAll('[role="menuitem"]')).find(button => button.textContent === '清空本来源条目')!)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(document.querySelector('[data-confirm-dialog]')?.textContent).toContain('2 条')
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'clearEntries' && call.args.sourceId === 'rss:a')).toBe(true) })
  })

  it('clears the search field with its button', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.change(node(view.container, 'input[aria-label="搜索标题、摘要、正文、来源"]'), { target: { value: 'One' } })
    fireEvent.keyDown(node(view.container, 'input[aria-label="搜索标题、摘要、正文、来源"]'), { key: 'Enter' })
    await waitFor(() => { expect(node(view.container, '[data-inbox-search-clear]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-search-clear]'))
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-search-clear]')).toBeNull() })
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-group="rss:a"]')).toBeTruthy() })
  })
})

describe('group fallbacks and source action failures', () => {
  it('renders a manual group without source actions and opens its flat list', async () => {
    const manual = { ...baseEntry, id: 'man1', sourceId: undefined, sourceKind: 'manual', title: 'Manual one', readAt: 1, seenAt: 1, publishedAt: undefined, fetchedAt: 5 }
    const backend = makeBackend([baseEntry, manual])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-group="manual"]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-group="manual"]').textContent).toContain('手动添加')
    expect(node(view.container, '[data-inbox-group="manual"]').textContent).toContain('共 1 条')
    expect(view.container.querySelector('[data-inbox-group-menu="manual"]')).toBeNull()
    fireEvent.click(node(view.container, '[data-inbox-group-view="manual"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-source-filter]').textContent).toContain('手动添加') })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries' && call.args.kind === 'manual')).toBe(true) })
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="man1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-source-filter-clear]'))
    fireEvent.click(node(view.container, '[data-inbox-layout="source"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-group="manual"]')).toBeTruthy() })
  })

  it('falls back to the visible counts when the optional filtered total is absent', async () => {
    const backend = makeBackend()
    const base = backend.call
    const call = vi.fn(async (op: string, args: unknown) => {
      const outcome = await base(op, args)
      if ((op === 'listGroups' || op === 'listEntries') && outcome.status === 'success') {
        const result = outcome.result as Record<string, unknown>
        delete result.filteredUnread
        return { ...outcome, result: result as never }
      }
      return outcome
    })
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-summary]').textContent).toContain('2 条 · 1 未读') })
    fireEvent.click(node(view.container, '[data-inbox-layout="time"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-summary]').textContent).toContain('2 条 · 1 未读') })
  })

  it('rejects a malformed grouped result before and after the first successful read', async () => {
    const backend = makeBackend()
    const base = backend.call
    let malformed = true
    const call = vi.fn(async (op: string, args: unknown) => op === 'listGroups' && malformed ? ok({}) : base(op, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-read-failure]').textContent).toContain('listGroups returned no groups') })
    malformed = false
    fireEvent.click(node(view.container, '[data-inbox-read-retry]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    malformed = true
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-list-stale]').textContent).toContain('listGroups returned no groups') })
  })

  it('keeps the entry unread when the automatic read fails', async () => {
    const backend = makeBackend()
    const base = backend.call
    const call = vi.fn(async (op: string, args: unknown) => op === 'markRead' ? failed('read refused') : base(op, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    expect(readerButton(view.container, '标为已读')).toBeTruthy()
  })

  it('handles cancelled confirmations, failed source actions and refresh variants', async () => {
    const backend = makeBackend()
    const base = backend.call
    let failMark = true
    let failClear = true
    let refreshMode: 'running' | 'none' | 'normal' = 'running'
    const call = vi.fn(async (op: string, args: unknown) => {
      if (op === 'markSourceRead') return failMark ? failed('mark failed') : base(op, args)
      if (op === 'clearEntries') return failClear ? failed('clear failed') : base(op, args)
      if (op === 'refresh') {
        if (refreshMode === 'running') return ok({ started: false, sources: 0, taskId: 'task-1' })
        if (refreshMode === 'none') return ok({ started: false, sources: 0 })
      }
      return base(op, args)
    })
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '刷新')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-notice]').textContent).toContain('刷新已在进行') })
    refreshMode = 'none'
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '刷新')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-notice]').textContent).toContain('没有可刷新的来源') })
    fireEvent.click(tabButton(view.container, '来源'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-source-read="rss:a"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-source-read="rss:a"]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(call.mock.calls.some(([op]) => op === 'markSourceRead')).toBe(false)
    fireEvent.click(node(view.container, '[data-inbox-source-read="rss:a"]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('mark failed') })
    fireEvent.click(node(view.container, '[data-inbox-source-clear="rss:a"]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(call.mock.calls.some(([op]) => op === 'clearEntries')).toBe(false)
    failMark = false
    fireEvent.click(node(view.container, '[data-inbox-source-clear="rss:a"]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('clear failed') })
  })

  it('dedupes a repeated page and toggles read/favorite in the flat layout', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...baseEntry, id: `p${String(index)}`, externalId: `px${String(index)}`, title: `Page ${String(index)}`,
    }))
    const backend = makeBackend(many)
    const base = backend.call
    const call = vi.fn(async (op: string, args: unknown) => {
      const outcome = await base(op, args)
      if (op === 'listEntries' && (args as { offset?: number }).offset === 50 && outcome.status === 'success') {
        const result = outcome.result as { entries: EntryFixture[] }
        result.entries = [backend.entries[0]!, ...result.entries]
      }
      return outcome
    })
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    fireEvent.click(node(view.container, '[data-inbox-layout="time"]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(50) })
    fireEvent.click(node(view.container, '[data-inbox-load-more]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(60) })
    fireEvent.click(node(view.container, '[data-inbox-entry="p0"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    fireEvent.click(readerButton(view.container, '标为未读'))
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'markRead' && entry.args.read === false)).toBe(true) })
    fireEvent.click(readerButton(view.container, '标为已读'))
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'markRead' && entry.args.read === true)).toBe(true) })
    fireEvent.click(readerButton(view.container, '收藏'))
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'favorite')).toBe(true) })
  })
})

  it('labels a paused unnamed source by its host and shows its latest timing', async () => {
    const paused = {
      ...sources[0]!,
      name: '',
      url: 'https://paused.example.test/rss',
      enabled: false,
      lastCheckedAt: 1_000,
      lastSuccessAt: 2_000,
      latestAt: 3_000,
    }
    const empty = { ...sources[1]!, id: 'rss:empty', name: 'Empty feed', entryCount: 0, unreadCount: 0, latestAt: undefined }
    const backend = makeBackend([baseEntry], [paused, empty])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-group="rss:a"]')).toBeTruthy() })
    expect(node(view.container, '[data-inbox-group="rss:a"]').textContent).toContain('paused.example.test')
    expect(node(view.container, '[data-inbox-group="rss:a"]').textContent).toContain('已暂停')
    fireEvent.click(tabButton(view.container, '来源'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-source="rss:a"]')).toBeTruthy() })
    const card = node(view.container, '[data-inbox-source="rss:a"]')
    expect(card.textContent).toContain('paused.example.test')
    expect(card.textContent).toContain('已暂停')
    expect(card.textContent).toContain('最近条目')
    expect(card.textContent).toContain('最近成功')
    expect(node(view.container, '[data-inbox-source="rss:empty"]').textContent).toContain('最近条目')
    expect(node(view.container, '[data-inbox-source="rss:empty"]').textContent).toContain('从未')
  })

  it('collapses and expands every group from the summary control', async () => {
    const other = { ...baseEntry, id: 'x1', sourceId: 'rss:b', externalId: 'xx1', title: 'Other' }
    const backend = makeBackend([baseEntry, second, other])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-group]')).toHaveLength(2) })
    expect(node(view.container, '[data-inbox-collapse-all]').textContent).toBe('全部收起')
    fireEvent.click(node(view.container, '[data-inbox-collapse-all]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(0) })
    expect(node(view.container, '[data-inbox-collapse-all]').textContent).toBe('全部展开')
    fireEvent.click(node(view.container, '[data-inbox-collapse-all]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(3) })
  })

  it('formats a current-year entry without repeating the year', async () => {
    const current = { ...baseEntry, id: 'now1', title: 'Now', publishedAt: Date.now(), fetchedAt: Date.now() }
    const backend = makeBackend([current])
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="now1"]')).toBeTruthy() })
    const text = node(view.container, '[data-inbox-entry="now1"]').textContent ?? ''
    expect(text).not.toContain(String(new Date().getFullYear()))
  })

  it('drops a read row from an unread flat list without a reload', async () => {
    const backend = makeBackend()
    const view = render(<InboxView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listGroups' && call.args.unread === true)).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-layout="time"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries' && call.args.unread === true)).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-entry="e1"]')).toBeNull() })
    expect(node(view.container, '[data-inbox-empty="filtered"]')).toBeTruthy()
  })

describe('responsive container', () => {
  it('switches to one pane below a 1040 content width and keeps the narrow tuning', () => {
    const stylesheet = readFileSync(join(process.cwd(), 'apps/inbox/view/src/client/InboxView.module.css'), 'utf8')
    const singlePaneAt = stylesheet.indexOf('@container (max-width: 1040px)')
    const narrowAt = stylesheet.indexOf('@container (max-width: 720px)')
    expect(singlePaneAt).toBeGreaterThanOrEqual(0)
    expect(narrowAt).toBeGreaterThan(singlePaneAt)
    const singlePane = stylesheet.slice(singlePaneAt, narrowAt)
    expect(singlePane).toMatch(/\.body\s*\{[^}]*flex-direction:\s*column/u)
    expect(singlePane).toMatch(/\.listHidden\s*\{\s*display:\s*none/u)
    expect(singlePane).toMatch(/\.readerEmpty\s*\{\s*display:\s*none/u)
    expect(singlePane).toMatch(/\.back\s*\{\s*display:\s*inline-flex/u)
    const narrow = stylesheet.slice(narrowAt)
    expect(narrow).toMatch(/\.tools\s*\{[^}]*flex-wrap:\s*nowrap/u)
    expect(narrow).toMatch(/\.listSummary\s*\{\s*display:\s*flex/u)
    expect(narrow).toMatch(/\.listSummaryText\s*\{\s*display:\s*none/u)
  })
})
