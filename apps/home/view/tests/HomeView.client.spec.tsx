// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { HomeView, type HomeTranslate } from '../src/client/HomeView.tsx'
import { type HomeKey, zh } from '../src/client/locales.ts'

type Call = ApplicationViewProps['call']
type Outcome = Awaited<ReturnType<Call>>

const t: HomeTranslate = (key, params) => {
  const template = zh[key as HomeKey]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

function ok(value: unknown): Outcome { return { callId: 'c', status: 'success', result: value as never } }
function failed(message = 'failed'): Outcome { return { callId: 'c', status: 'failed', error: { code: 'failed', message } } }

const overview = {
  generatedAt: 1,
  inbox: { available: true, unseen: 12, unread: 14, saved: 2, recent: [{ id: 'e1', title: 'Entry one' }] },
  todo: { available: true, open: 3, today: 1, overdue: 1, recent: [{ id: 't1', title: 'Task one' }] },
  notes: { available: false },
}

const activity = {
  activities: [{ id: 'event-1', appId: 'inbox', type: 'entry.created', at: Date.now() - 60_000, count: 3, refs: [] }],
  limit: 5,
}

function makeBackend(options: { overview?: unknown; activity?: unknown } = {}): { call: Call; calls: string[] } {
  const calls: string[] = []
  const call = vi.fn(async (op: string) => {
    calls.push(op)
    if (op === 'overview') return ok(options.overview ?? overview)
    if (op === 'activity') return ok(options.activity ?? { activities: [], limit: 5 })
    return failed(`unexpected ${op}`)
  })
  return { call: call as unknown as Call, calls }
}

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

function node(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${selector}`)
  return found
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('home view', () => {
  it('renders the three cards with their counts and previews', async () => {
    const backend = makeBackend()
    const view = render(<HomeView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card="inbox"]')).toBeTruthy() })
    expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('14 条未读')
    expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('Entry one')
    expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('2 条收藏')
    expect(node(view.container, '[data-home-card="todo"]').textContent).toContain('3 未完成 · 1 今天到期')
    expect(node(view.container, '[data-home-card="todo"]').textContent).toContain('1 条逾期')
    // A refused section degrades to its own unavailable label.
    expect(node(view.container, '[data-home-card="notes"]').getAttribute('data-home-card-state')).toBe('unavailable')
    expect(node(view.container, '[data-home-card="notes"]').textContent).toContain('暂不可用')
  })

  it('shows a received notice with its own count', async () => {
    const backend = makeBackend({ activity })
    const view = render(<HomeView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-activity-row="event-1"]')).toBeTruthy() })
    expect(node(view.container, '[data-home-activity-row="event-1"]').textContent).toContain('信息收件箱 · 3 条新内容')
  })

  it('shows the empty activity state when nothing arrived', async () => {
    const backend = makeBackend()
    const view = render(<HomeView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-activity-empty]')).toBeTruthy() })
    expect(node(view.container, '[data-home-activity-empty]').textContent).toContain('暂时没有新的变化')
  })

  it('opens the owning application from a card and from a notice', async () => {
    const backend = makeBackend({ activity })
    const open = vi.fn()
    const view = render(<HomeView {...makeProps(backend.call, { navigation: { open, back: vi.fn(), canBack: () => false } })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card="todo"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-home-card-open="todo"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'todo' })
    fireEvent.click(node(view.container, '[data-home-item="e1"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'inbox', record: { appId: 'inbox', kind: 'entry', id: 'e1' } })
    await waitFor(() => { expect(node(view.container, '[data-home-activity-row="event-1"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-home-activity-row="event-1"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'inbox' })
  })

  it('re-reads on a change notice', async () => {
    let listener: (() => void) | undefined
    const backend = makeBackend()
    const onChanged = (next: () => void): (() => void) => { listener = next; return () => { listener = undefined } }
    const props = makeProps(backend.call, { onChanged })
    render(<HomeView {...props} t={t} />)
    await waitFor(() => { expect(backend.calls.filter(op => op === 'overview')).toHaveLength(1) })
    listener?.()
    await waitFor(() => { expect(backend.calls.filter(op => op === 'overview')).toHaveLength(2) })
  })

  it('flags only the overview when the activity still read successfully', async () => {
    const call = vi.fn(async (op: string) => op === 'overview' ? failed('overview down') : ok(activity)) as unknown as Call
    const view = render(<HomeView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-overview-failure]')).toBeTruthy() })
    expect(view.container.querySelector('[data-home-read-failure]')).toBeNull()
    expect(node(view.container, '[data-home-activity-row="event-1"]')).toBeTruthy()
    expect(node(view.container, '[data-home-card="inbox"]').getAttribute('data-home-card-state')).toBe('unread')
  })

  it('flags only the activity when the overview still read successfully', async () => {
    const call = vi.fn(async (op: string) => op === 'activity' ? failed('activity down') : ok(overview)) as unknown as Call
    const view = render(<HomeView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-activity-failure]')).toBeTruthy() })
    expect(view.container.querySelector('[data-home-read-failure]')).toBeNull()
    expect(view.container.querySelector('[data-home-overview-failure]')).toBeNull()
    expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('14')
  })

  it('keeps the last successful snapshot when a later refresh fails', async () => {
    let reads = 0
    let listener: (() => void) | undefined
    const call = vi.fn(async (op: string) => {
      if (reads < 2) {
        reads += 1
        return op === 'overview' ? ok(overview) : ok(activity)
      }
      return failed('refresh down')
    }) as unknown as Call
    const onChanged = (next: () => void): (() => void) => { listener = next; return () => { listener = undefined } }
    const view = render(<HomeView {...makeProps(call, { onChanged })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('14 条未读') })
    listener?.()
    await waitFor(() => { expect(node(view.container, '[data-home-overview-failure]')).toBeTruthy() })
    expect(view.container.querySelector('[data-home-read-failure]')).toBeNull()
    expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('14 条未读')
    expect(node(view.container, '[data-home-card="inbox"]').getAttribute('data-home-card-state')).toBe('ready')
    expect(node(view.container, '[data-home-activity-stale]')).toBeTruthy()
    expect(node(view.container, '[data-home-activity-row="event-1"]')).toBeTruthy()
    // The stale strip can ask for another read on its own.
    fireEvent.click(node(view.container, '[data-home-activity-retry]'))
    await waitFor(() => { expect(call).toHaveBeenCalledTimes(6) })
  })

  it('surfaces a read failure instead of an empty dashboard', async () => {
    const call = vi.fn(async () => failed('read failed')) as unknown as Call
    const view = render(<HomeView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-read-failure]').textContent).toContain('read failed') })
    expect(node(view.container, '[data-home-card="inbox"]').getAttribute('data-home-card-state')).toBe('unread')
    expect(view.container.textContent).not.toContain('暂不可用')
  })

  it('shows when the snapshot was read and refreshes on demand', async () => {
    const generatedAt = Date.parse('2026-01-15T10:00:00Z')
    const backend = makeBackend({ overview: { ...overview, generatedAt } })
    const view = render(<HomeView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-updated]')).toBeTruthy() })
    const time = new Intl.DateTimeFormat('zh', { timeStyle: 'short' }).format(new Date(generatedAt))
    expect(node(view.container, '[data-home-updated]').textContent).toBe(t('view.updatedAt', { time }))
    fireEvent.click(node(view.container, '[data-home-refresh]'))
    await waitFor(() => { expect(backend.calls.filter(op => op === 'overview')).toHaveLength(2) })
  })

  it('disables the refresh control and labels it busy while a read is in flight', async () => {
    let release: ((value: Outcome) => void) | undefined
    let overviewReads = 0
    const call = vi.fn(async (op: string) => {
      if (op === 'activity') return ok(activity)
      overviewReads += 1
      if (overviewReads === 1) return ok(overview)
      return await new Promise<Outcome>((resolve) => { release = resolve })
    }) as unknown as Call
    const view = render(<HomeView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card="inbox"]').getAttribute('data-home-card-state')).toBe('ready') })
    fireEvent.click(node(view.container, '[data-home-refresh]'))
    await waitFor(() => { expect(node(view.container, '[data-home-refresh]').getAttribute('aria-busy')).toBe('true') })
    expect(node(view.container, '[data-home-refresh]').hasAttribute('disabled')).toBe(true)
    expect(node(view.container, '[data-home-refresh]').textContent).toBe(t('view.refreshing'))
    await act(async () => { release?.(ok(overview)); await Promise.resolve() })
    await waitFor(() => { expect(node(view.container, '[data-home-refresh]').hasAttribute('disabled')).toBe(false) })
  })

  it('drops an older response when a newer read has already answered', async () => {
    const pending: Array<(value: Outcome) => void> = []
    const call = vi.fn(async (op: string) => {
      if (op === 'activity') return ok({ activities: [], limit: 5 })
      return await new Promise<Outcome>((resolve) => { pending.push(resolve) })
    }) as unknown as Call
    let listener: (() => void) | undefined
    const onChanged = (next: () => void): (() => void) => { listener = next; return () => { listener = undefined } }
    const view = render(<HomeView {...makeProps(call, { onChanged })} t={t} />)
    const readTime = (value: number): string => t('view.updatedAt', { time: new Intl.DateTimeFormat('zh', { timeStyle: 'short' }).format(new Date(value)) })
    await waitFor(() => { expect(pending).toHaveLength(1) })
    await act(async () => { pending[0]?.(ok({ ...overview, generatedAt: 1_000 })); await Promise.resolve() })
    await waitFor(() => { expect(node(view.container, '[data-home-updated]').textContent).toBe(readTime(1_000)) })
    // Two overlapping reads (a change notice and a manual refresh): the first
    // answers last and must not replace the newer snapshot.
    listener?.()
    listener?.()
    await waitFor(() => { expect(pending).toHaveLength(3) })
    await act(async () => { pending[2]?.(ok({ ...overview, generatedAt: 3_000 })); await Promise.resolve() })
    await waitFor(() => { expect(node(view.container, '[data-home-updated]').textContent).toBe(readTime(3_000)) })
    await act(async () => { pending[1]?.(ok({ ...overview, generatedAt: 2_000 })); await Promise.resolve() })
    expect(node(view.container, '[data-home-updated]').textContent).toBe(readTime(3_000))
  })

  it('reports why a card is unavailable and retries only the transient kinds', async () => {
    const broken = {
      ...overview,
      inbox: { available: false, failure: { kind: 'not-approved', code: 'app.capability-not-approved', message: 'the user has not approved storage for inbox' } },
      todo: { available: false, failure: { kind: 'other', code: 'platform.unknown-app', message: 'no application todo' } },
      notes: { available: true, total: 2, recent: [] },
    }
    const backend = makeBackend({ overview: broken })
    const view = render(<HomeView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card="inbox"]')).toBeTruthy() })
    const inbox = node(view.container, '[data-home-card="inbox"]')
    expect(inbox.getAttribute('data-home-card-state')).toBe('unavailable')
    expect(inbox.textContent).toContain('暂不可用')
    expect(inbox.textContent).toContain(t('view.cardFailureNotApproved'))
    expect(inbox.querySelector('[data-home-card-failure="not-approved"]')).toBeTruthy()
    expect(inbox.querySelector('[data-home-card-retry="inbox"]')).toBeNull()
    expect(inbox.textContent).toContain(t('view.cardStatus'))
    expect(inbox.textContent).toContain('app.capability-not-approved')
    const todo = node(view.container, '[data-home-card="todo"]')
    expect(todo.textContent).toContain(t('view.cardFailureOther'))
    expect(todo.textContent).toContain('no application todo')
    fireEvent.click(node(view.container, '[data-home-card-retry="todo"]'))
    await waitFor(() => { expect(backend.calls.filter(op => op === 'overview')).toHaveLength(2) })
  })

  it('offers an explicit open entry at the foot of every card', async () => {
    const backend = makeBackend()
    const open = vi.fn()
    const view = render(<HomeView {...makeProps(backend.call, { navigation: { open, back: vi.fn(), canBack: () => false } })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card-footer-open="inbox"]')).toBeTruthy() })
    fireEvent.click(node(view.container, '[data-home-card-footer-open="inbox"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'inbox' })
    fireEvent.click(node(view.container, '[data-home-card-footer-open="todo"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'todo' })
    fireEvent.click(node(view.container, '[data-home-card-footer-open="notes"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'notes' })
    // A preview row is still its own target, not the card-wide one.
    fireEvent.click(node(view.container, '[data-home-item="e1"]'))
    expect(open).toHaveBeenCalledWith({ appId: 'inbox', record: { appId: 'inbox', kind: 'entry', id: 'e1' } })
  })

  it('names each failure kind its own way', async () => {
    const cases: Array<[string, HomeKey]> = [
      ['undeclared', 'view.cardFailureUndeclared'],
      ['not-open', 'view.cardFailureClosed'],
      ['caller-not-declared', 'view.cardFailureClosed'],
      ['denied', 'view.cardFailureDenied'],
      ['confirmation', 'view.cardFailureConfirmation'],
      ['transport', 'view.cardFailureTransport'],
    ]
    for (const [kind, key] of cases) {
      const backend = makeBackend({
        overview: { ...overview, inbox: { available: false, failure: { kind } }, notes: { available: true, total: 0, recent: [] } },
      })
      const view = render(<HomeView {...makeProps(backend.call)} t={t} />)
      await waitFor(() => { expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain(t(key)) })
      view.unmount()
    }
  })

  it('turns a rejected carrier into a transport failure on the first read', async () => {
    const call = vi.fn(async () => { throw new Error('carrier broke') }) as unknown as Call
    const view = render(<HomeView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-read-failure]').getAttribute('data-home-read-failure')).toBe('transport') })
    expect(node(view.container, '[data-home-card="inbox"]').getAttribute('data-home-card-state')).toBe('unread')
  })

  it('keeps the last snapshot when a later read rejects', async () => {
    let fail = false
    let listener: (() => void) | undefined
    const call = vi.fn(async (op: string) => {
      if (fail) throw new Error('carrier broke')
      return op === 'overview' ? ok(overview) : ok(activity)
    }) as unknown as Call
    const onChanged = (next: () => void): (() => void) => { listener = next; return () => { listener = undefined } }
    const view = render(<HomeView {...makeProps(call, { onChanged })} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('14 条未读') })
    fail = true
    listener?.()
    await waitFor(() => { expect(node(view.container, '[data-home-overview-failure]')).toBeTruthy() })
    expect(node(view.container, '[data-home-card="inbox"]').getAttribute('data-home-card-state')).toBe('ready')
    expect(node(view.container, '[data-home-card="inbox"]').textContent).toContain('14 条未读')
  })

  it('keeps the overdue count in the primary count line with the danger token', async () => {
    const backend = makeBackend()
    const view = render(<HomeView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(node(view.container, '[data-home-card="todo"]')).toBeTruthy() })
    const counts = node(view.container, '#home-todo-counts')
    expect(counts.textContent).toContain('3 未完成 · 1 今天到期')
    const overdue = node(view.container, '[data-home-todo-overdue]')
    expect(counts.contains(overdue)).toBe(true)
    expect(overdue.textContent).toContain('1 条逾期')
    const sheet = readFileSync(join(process.cwd(), 'apps/home/view/src/client/HomeView.module.css'), 'utf8')
    expect(sheet).toMatch(/\.overdue \{[^}]*color:\s*var\(--app-danger/u)
    const source = readFileSync(join(process.cwd(), 'apps/home/view/src/client/HomeView.tsx'), 'utf8')
    expect(source).toContain('data-home-refresh')
    expect(source).toContain('data-home-card-footer-open')
    expect(source).toContain('data-home-todo-overdue')
  })
})
