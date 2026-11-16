// @vitest-environment jsdom
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
interface SourceFixture { id: string; kind: string; name: string; url: string; enabled: boolean; intervalMs: number; version: number; entryCount: number; lastSuccessAt?: number; lastError?: string }

const baseEntry: EntryFixture = {
  id: 'e1', sourceId: 'rss:a', sourceKind: 'rss', externalId: 'x', url: 'https://example.test/a',
  title: 'One', summary: 'first', content: 'line one\nline two', publishedAt: 10, fetchedAt: 20, favorite: false,
}
const second: EntryFixture = { ...baseEntry, id: 'e2', title: 'Two', summary: 'second', favorite: true, readAt: 30 }
const sources: SourceFixture[] = [
  { id: 'rss:a', kind: 'rss', name: 'Feed A', url: 'https://example.test/feed', enabled: true, intervalMs: 0, version: 1, entryCount: 2 },
  { id: 'rss:b', kind: 'rss', name: 'Feed B', url: 'https://example.test/b', enabled: false, intervalMs: 0, version: 2, entryCount: 0, lastError: 'offline' },
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
    ui: {} as never,
    ...overrides,
  }
}

function makeBackend(entriesIn: EntryFixture[] = [baseEntry, second]) {
  const entries = entriesIn.map(entry => ({ ...entry }))
  const calls: Array<{ op: string; args: Record<string, unknown> }> = []
  const call = vi.fn(async (op: string, raw: unknown) => {
    const args = (raw ?? {}) as Record<string, unknown>
    calls.push({ op, args })
    switch (op) {
      case 'listEntries': {
        let list = entries.filter(entry => args.view === 'saved' ? entry.favorite : true)
        if (args.unread === true) list = list.filter(entry => entry.readAt === undefined)
        if (args.newOnly === true) list = list.filter(entry => entry.seenAt === undefined)
        if (typeof args.kind === 'string') list = list.filter(entry => entry.sourceKind === args.kind)
        if (typeof args.search === 'string') list = list.filter(entry => entry.title.includes(args.search as string))
        const offset = typeof args.offset === 'number' ? args.offset : 0
        const limit = typeof args.limit === 'number' ? args.limit : 50
        return ok({ entries: list.slice(offset, offset + limit).map(({ content: _content, ...summary }) => summary), total: list.length, counts: { unread: entries.filter(entry => entry.readAt === undefined).length, unseen: entries.filter(entry => entry.seenAt === undefined).length, saved: entries.filter(entry => entry.favorite).length, all: entries.length } })
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
      case 'refresh': return ok({ started: true, sources: 1 })
      case 'listSources': return ok({ sources, health: { total: 2, ok: 1, error: 1, paused: 1 } })
      case 'settings': return ok({ retentionDays: 90, maxEntries: 2000, maxBytes: 50_000_000, githubRefreshMs: 3_600_000, feedRefreshMs: 900_000, watchRefreshMs: 1_800_000, githubTokenSet: false })
      case 'addManualLink': entries.push({ ...baseEntry, id: 'e3', title: 'New link', url: String(args.url), summary: '' }); return ok(entries.at(-1))
      case 'addSource': return ok({ ...sources[0], id: 'rss:new', name: 'New' })
      case 'updateSource': return ok({ ...sources[0]!, enabled: !sources[0]!.enabled })
      case 'removeSource': return ok({ ...sources[0], removed: true })
      case 'importOpml': return ok({ added: 1, skipped: 2, invalid: 0 })
      case 'setSettings': return ok({ retentionDays: 30, maxEntries: 100, maxBytes: 1000, githubRefreshMs: 60_000, feedRefreshMs: 60_000, watchRefreshMs: 60_000, githubTokenSet: true })
      default: return failed(`unexpected ${op}`)
    }
  })
  return { call, entries, calls }
}

function confirmSourceRemove(): void {
  fireEvent.click(document.querySelector('[data-inbox-source-remove-confirm]') as HTMLButtonElement)
}

function node(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${selector}`)
  return found
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('inbox view', () => {
  it('renders the inbox, filters, opens an entry and marks it read', async () => {
    const backend = makeBackend()
    const props = makeProps(backend.call)
    const view = render(<InboxView {...props} t={t} language="en" />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="unread"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries' && call.args.unread === true)).toBe(true) })
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(node(view.container, '[data-inbox-reader]').textContent).toContain('line one') })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '标为已读')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'markRead')).toBe(true) })
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

  it('searches, toggles favorite, saves to task/note and shows notices', async () => {
    const backend = makeBackend()
    const props = makeProps(backend.call)
    const view = render(<InboxView {...props} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    const search = node(view.container, 'input[aria-label="搜索标题、摘要、正文"]')
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

  it('adds a manual link and renders the empty state', async () => {
    const backend = makeBackend([])
    const props = makeProps(backend.call)
    const view = render(<InboxView {...props} t={t} />)
    await waitFor(() => { expect(view.container.textContent).toContain('没有符合条件的条目') })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '添加链接')!)
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

  it('shows a failed list read instead of pretending the inbox is empty', async () => {
    const call = vi.fn(async () => failed('read failed'))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain('read failed') })
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
    for (const [index, value] of ['30', '100', '60000', '60', '60', '60'].entries()) fireEvent.change(settingsInputs[index]!, { target: { value } })
    fireEvent.change(node(view.container, '[data-inbox-dialog="settings"] input[type="password"]'), { target: { value: 'token' } })
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
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '导入 OPML')!)
    fireEvent.change(node(view.container, '[data-inbox-dialog="opml"] textarea'), { target: { value: '<opml/>' } })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-dialog="opml"] button')).find(button => button.textContent === '导入')!)
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'importOpml')).toBe(true) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(node(view.container, '[data-inbox-source-remove="rss:a"]'))
    confirmSourceRemove()
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'removeSource')).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('收件箱') === true)!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-filter="new"]'))
    fireEvent.change(node(view.container, 'select[aria-label="全部来源"]'), { target: { value: 'rss' } })
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'listEntries' && call.args.kind === 'rss')).toBe(true) })
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
    await waitFor(() => { expect(backend.calls.filter(call => call.op === 'listEntries').length).toBeGreaterThan(1) })
    expect(guard).not.toHaveBeenCalled()
    expect(await leave?.()).toBe(true)
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(report).toHaveBeenCalledWith(expect.objectContaining({ record: expect.objectContaining({ appId: 'inbox', kind: 'entry' }) })) })
  })

  it.each([
    ['listEntries', 'list failed'],
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
    if (op === 'listEntries') { await waitFor(() => { expect(node(view.container, '[data-inbox-error]').textContent).toContain(message) }); return }
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

    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '来源')!)
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
    fireEvent.change(node(view.container, '[data-inbox-dialog="source"] select'), { target: { value: 'web' } })
    fireEvent.change(Array.from(view.container.querySelectorAll('[data-inbox-dialog="source"] input'))[2]!, { target: { value: 'main' } })
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
  it('loads the next page and marks an opened entry seen', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...baseEntry, id: `e${String(index)}`, externalId: `x${String(index)}`, title: `Entry ${String(index)}`, ...(index === 0 ? { seenAt: 1 } : {}),
    }))
    const backend = makeBackend(many)
    const view = render(<InboxView {...makeProps(backend.call as Call)} t={t} />)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(50) })
    fireEvent.click(node(view.container, '[data-inbox-load-more]'))
    await waitFor(() => { expect(view.container.querySelectorAll('[data-inbox-entry]')).toHaveLength(60) })
    expect(view.container.querySelector('[data-inbox-load-more]')).toBeNull()
    fireEvent.click(node(view.container, '[data-inbox-entry="e1"]'))
    await waitFor(() => { expect(backend.calls.some(call => call.op === 'markSeen')).toBe(true) })
  })

  it('shows a retry instead of an empty list when the first read fails', async () => {
    let first = true
    const call = vi.fn(async (op: string) => {
      if (op === 'listEntries' && first) { first = false; return failed('offline') }
      if (op === 'listEntries') return ok({ entries: [baseEntry], total: 1, counts: { unread: 1, unseen: 1, saved: 0, all: 1 } })
      if (op === 'listSources') return ok({ sources, health: { total: 2, ok: 1, error: 1, paused: 1 } })
      if (op === 'settings') return ok({ retentionDays: 90, maxEntries: 2000, maxBytes: 50000000, githubRefreshMs: 3600000, feedRefreshMs: 900000, watchRefreshMs: 1800000, githubTokenSet: false })
      return ok({})
    }) as unknown as Call
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-list-error]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-list-retry]'))
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
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '标为已读')!)
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'markRead' && entry.args.read === true)).toBe(true) })
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-reader] button')).find(button => button.textContent === '标为未读')!)
    await waitFor(() => { expect(backend.calls.some(entry => entry.op === 'markRead' && entry.args.read === false)).toBe(true) })
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
    const backend = makeBackend([])
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

  it('clears the GitHub token only after confirmation and reports a failure', async () => {
    const backend = makeBackend()
    let clearFails = false
    const base = backend.call
    const call = vi.fn(async (op: string, args: unknown) => {
      if (op === 'settings') return ok({ ...(await base(op, args) as { result: Record<string, unknown> }).result, githubTokenSet: true })
      if (op === 'setSettings' && (args as { githubToken?: unknown }).githubToken === null) {
        return clearFails ? failed('clear failed') : ok({ retentionDays: 30, maxEntries: 100, maxBytes: 1000, githubRefreshMs: 60_000, feedRefreshMs: 60_000, watchRefreshMs: 60_000, githubTokenSet: false })
      }
      return base(op, args)
    })
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-token-clear]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-inbox-token-clear]'))
    await waitFor(() => { expect(document.querySelector('[data-inbox-token-clear-confirm]')).toBeTruthy() })
    const clearDialog = document.querySelector('[data-inbox-token-clear-confirm]')!.closest('[role="dialog"]')!
    fireEvent.click(Array.from(clearDialog.querySelectorAll('button')).find(button => button.textContent === '取消')!)
    expect(call.mock.calls.some(([op, args]) => op === 'setSettings' && (args as { githubToken?: unknown }).githubToken === null)).toBe(false)
    fireEvent.click(node(view.container, '[data-inbox-token-clear]'))
    await waitFor(() => { expect(document.querySelector('[data-inbox-token-clear-confirm]')).toBeTruthy() })
    const closeDialog = document.querySelector('[data-inbox-token-clear-confirm]')!.closest('[role="dialog"]')!
    fireEvent.click(closeDialog.querySelector('button[aria-label="关闭"]')!)
    await waitFor(() => { expect(document.querySelector('[data-inbox-token-clear-confirm]')).toBeNull() })
    clearFails = true
    fireEvent.click(node(view.container, '[data-inbox-token-clear]'))
    await waitFor(() => { expect(document.querySelector('[data-inbox-token-clear-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-inbox-token-clear-confirm]') as HTMLButtonElement)
    await waitFor(() => { expect(node(view.container, '[data-inbox-dialog-error]').textContent).toContain('clear failed') })
    clearFails = false
    fireEvent.click(node(view.container, '[data-inbox-token-clear]'))
    await waitFor(() => { expect(document.querySelector('[data-inbox-token-clear-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-inbox-token-clear-confirm]') as HTMLButtonElement)
    await waitFor(() => { expect(node(view.container, '[data-inbox-notice]').textContent).toContain('Token 已清除') })
  })

  it('retries a failed settings read inside the open dialog', async () => {
    const backend = makeBackend()
    let fail = true
    const base = backend.call
    const call = vi.fn(async (op: string, args: unknown) => op === 'settings' && fail ? failed('settings down') : base(op, args))
    const view = render(<InboxView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-inbox-entry="e1"]')).toBeTruthy() })
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === '设置')!)
    await waitFor(() => { expect(node(view.container, '[data-inbox-settings-loading]').textContent).toContain('settings down') })
    fail = false
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-inbox-settings-loading] button')).find(button => button.textContent === '重试')!)
    await waitFor(() => { expect(view.container.querySelector('[data-inbox-dialog="settings"] input')).toBeTruthy() })
  })
})
