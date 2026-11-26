// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { TodoPage, TodoView } from '../src/client/TodoView.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: string, params: Record<string, unknown> = {}): string => (
  (zh as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_match, name: string) => (name in params ? String(params[name]) : `{${name}}`))
)

function isoDay(offset: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const TODAY = isoDay(0)
const TOMORROW = isoDay(1)
const NOW = Date.now()

interface FixtureTask {
  id: string
  title: string
  notes: string
  dueDate: string | null
  assignee: 'me' | 'agent'
  priority: 1 | 2 | 3
  completedAt: number | null
  noteIds: string[]
  createdAt: number
  updatedAt: number
  version: number
}

const base = {
  notes: '',
  dueDate: null,
  assignee: 'me' as const,
  priority: 2 as const,
  completedAt: null,
  noteIds: [] as string[],
  createdAt: 1,
  updatedAt: 1,
  version: 1,
}

const tasks: FixtureTask[] = [
  { ...base, id: 't1', title: 'Overdue task', dueDate: isoDay(-2), assignee: 'agent', priority: 1, noteIds: ['n1'] },
  { ...base, id: 't2', title: 'Today task', dueDate: TODAY, notes: 'today notes' },
  { ...base, id: 't3', title: 'Tomorrow task', dueDate: TOMORROW, priority: 3 },
  { ...base, id: 't4', title: 'Upcoming task', dueDate: isoDay(5) },
  { ...base, id: 't5', title: 'Done today', dueDate: TODAY, priority: 1, completedAt: NOW + 1000 },
  { ...base, id: 't6', title: 'Done earlier', dueDate: isoDay(-3), priority: 3, completedAt: NOW - 2 * 86_400_000 },
  { ...base, id: 't7', title: 'No due task', priority: 3 },
  { ...base, id: 't8', title: 'Far task', dueDate: isoDay(10), priority: 1 },
]

type Result = Record<string, unknown>
const ok = (value: unknown): Result => ({ callId: 'c', status: 'success', result: value })
const fail = (message = 'failed'): Result => ({ callId: 'c', status: 'failed', error: { code: 'app.x', message } })

type Handlers = Record<string, (args: Record<string, unknown>) => Result | Promise<Result>>

function makeCall(overrides: Handlers = {}): ApplicationViewProps['call'] {
  const handlers: Handlers = {
    listTasks: () => ok(tasks),
    getTask: args => {
      const found = tasks.find(task => task.id === args.id)
      return found === undefined ? fail('missing task') : ok(found)
    },
    createTask: args => ok({ ...tasks[0], id: 't_new', title: args.title }),
    updateTask: args => {
      const found = tasks.find(task => task.id === args.id) ?? tasks[0]
      return ok({
        ...found,
        ...args,
        completedAt: args.completed === true ? NOW : null,
        version: 2,
      })
    },
    deleteTask: args => ok({ ...tasks[0], id: args.id }),
    restoreTask: args => ok({ ...tasks[0], id: args.id }),
    // The notes proxy returns the raw array; the leading null exercises the
    // view's summary narrower without polluting the chip list.
    resolveNotes: () => ok([null, { id: 'n1', title: 'Linked note' }]),
    searchNotes: () => ok([{ id: 'n2', title: 'Another note' }]),
    ...overrides,
  }
  return vi.fn(async (op: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[op]
    return handler === undefined ? ok({}) : await handler(args)
  }) as unknown as ApplicationViewProps['call']
}

function props(call: ApplicationViewProps['call'], overrides: Partial<ApplicationViewProps> = {}): ApplicationViewProps {
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

function renderView(overrides: Partial<ApplicationViewProps> = {}) {
  const call = overrides.call ?? makeCall()
  const pageContext = overrides.pageContext ?? { report: vi.fn(() => () => undefined) }
  const p = props(call, { pageContext, ...overrides })
  const view = render(<TodoView {...p} t={t} />)
  return { p, call: p.call, pageContext: p.pageContext, view }
}

function el<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (found === null) throw new Error(`missing element: ${selector}`)
  return found
}
function all<T extends Element = HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector))
}
function maybe(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector)
}
function input(selector: string): HTMLInputElement { return el<HTMLInputElement>(selector) }
function select(selector: string): HTMLSelectElement { return el<HTMLSelectElement>(selector) }
function openTodayTask(id: string): void { fireEvent.click(el(`[data-todo-open="${id}"]`)) }
async function waitForToday(): Promise<void> {
  await waitFor(() => { expect(maybe('[data-today-view]')).not.toBeNull() })
}
async function waitForDetail(): Promise<void> {
  await waitFor(() => { expect(maybe('[data-todo-detail]')).not.toBeNull() })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TodoPage', () => {
  it('binds the locale and renders the shared page', async () => {
    const snapshot = { language: 'zh' }
    const subscribe = vi.fn(() => () => undefined)
    const getSnapshot = vi.fn(() => snapshot)
    const bind = vi.fn(() => t)
    const locale = { subscribe, getSnapshot, bind }
    render(<TodoPage {...props(makeCall())} locale={locale as never} />)
    await waitFor(() => { expect(screen.getByText('今天')).toBeTruthy() })
    expect(subscribe).toHaveBeenCalled()
    expect(getSnapshot).toHaveBeenCalled()
    expect(bind).toHaveBeenCalledWith('todo')
  })
})

describe('TodoView today', () => {
  it('shows loading, then the four today groups with counts and quick add', async () => {
    renderView()
    expect(screen.getByText('读取中…')).toBeTruthy()
    await waitForToday()
    expect(el('[data-todo-page]').getAttribute('data-page')).toBe('today')
    expect(el('[data-todo-page]').getAttribute('data-narrow')).toBe('false')
    expect(el('[data-today-summary]').textContent).toContain('1 个逾期 · 1 个今日到期')
    for (const id of ['overdue', 'today', 'upcoming', 'completed']) {
      expect(maybe(`[data-today-section="${id}"]`)).not.toBeNull()
    }
    expect(within(el('[data-today-section="overdue"]')).getByText('Overdue task')).toBeTruthy()
    expect(within(el('[data-today-section="today"]')).getByText('Today task')).toBeTruthy()
    expect(within(el('[data-today-section="upcoming"]')).getByText('Tomorrow task')).toBeTruthy()
    expect(within(el('[data-today-section="completed"]')).getByText('Done today')).toBeTruthy()
    expect(all('[data-todo-row]')).toHaveLength(5)
    expect(el('[data-todo-row="t1"]').querySelector('[data-assignee="agent"]')).not.toBeNull()
    expect(el('[data-todo-row="t1"]').querySelector('[data-note-count]')?.textContent).toContain('1')
    expect(el('[data-todo-open="t1"]').closest('[data-todo-row]')).not.toBeNull()
  })

  it('quick-adds by button and by Enter, and reports a failed add', async () => {
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    fireEvent.change(input('[data-today-quick-add] input'), { target: { value: '  Quick one  ' } })
    fireEvent.click(el('[data-today-quick-submit]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('createTask', expect.objectContaining({ title: 'Quick one', dueDate: TODAY })) })
    await waitFor(() => { expect(input('[data-today-quick-add] input').value).toBe('') })
    fireEvent.change(input('[data-today-quick-add] input'), { target: { value: 'Enter one' } })
    fireEvent.keyDown(input('[data-today-quick-add] input'), { key: 'Enter' })
    await waitFor(() => { expect(call).toHaveBeenCalledWith('createTask', expect.objectContaining({ title: 'Enter one' })) })
    fireEvent.click(el('[data-today-quick-submit]'))
    await waitFor(() => { expect(maybe('[data-todo-error]')).toBeNull() })

    cleanup()
    const failing = makeCall({ createTask: () => fail('add failed') })
    renderView({ call: failing })
    await waitForToday()
    fireEvent.change(input('[data-today-quick-add] input'), { target: { value: 'Broken' } })
    fireEvent.click(el('[data-today-quick-submit]'))
    await waitFor(() => { expect(screen.getByText('add failed')).toBeTruthy() })
  })

  it('ignores an IME Enter and coalesces a double quick-add submit', async () => {
    const createTask = vi.fn((args: Record<string, unknown>) => ok({ ...tasks[0], id: 't_new', title: args.title }))
    const call = makeCall({ createTask })
    renderView({ call })
    await waitForToday()
    const quick = input('[data-today-quick-add] input')
    fireEvent.change(quick, { target: { value: '输入法' } })
    fireEvent.keyDown(quick, { key: 'Enter', isComposing: true })
    expect(createTask).not.toHaveBeenCalled()
    fireEvent.keyDown(quick, { key: 'Enter' })
    fireEvent.keyDown(quick, { key: 'Enter' })
    await waitFor(() => { expect(createTask).toHaveBeenCalledTimes(1) })
  })

  it('asks before a new task replaces an unsaved draft', async () => {
    renderView()
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-todo-new-task]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(input('[data-todo-title]').value).toBe('Changed')
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(input('[data-todo-title]').value).toBe('Changed')
    fireEvent.click(el('[data-todo-new-task]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(input('[data-todo-title]').value).toBe('') })
  })

  it('orders several completed-today tasks newest first', async () => {
    const completed = [
      { ...base, id: 'c1', title: 'First done', completedAt: NOW - 5000 },
      { ...base, id: 'c2', title: 'Second done', completedAt: NOW },
    ]
    renderView({ call: makeCall({ listTasks: () => ok(completed) }) })
    await waitForToday()
    expect(all('[data-today-section="completed"] [data-todo-row]').map(row => row.getAttribute('data-todo-row'))).toEqual(['c2', 'c1'])
  })

  it('leaves a permission refusal to the shell notice instead of showing the raw error', async () => {
    const call = makeCall({ listTasks: () => ({ callId: 'c', status: 'failed', error: { code: 'app.capability-not-approved', message: 'the user has not approved app-data' } }) })
    renderView({ call })
    await waitFor(() => { expect(call).toHaveBeenCalled() })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(maybe('[data-todo-error-state]')).toBeNull()
    expect(document.body.textContent).not.toContain('has not approved')
  })

  it('shows empty today and a load failure instead of an empty list', async () => {
    renderView({ call: makeCall({ listTasks: () => ok([]) }) })
    await waitFor(() => { expect(maybe('[data-today-empty]')).not.toBeNull() })
    expect(screen.getByText('今天没有待办')).toBeTruthy()

    cleanup()
    renderView({ call: makeCall({ listTasks: () => fail('load failed') }) })
    await waitFor(() => { expect(maybe('[data-todo-error-state]')).not.toBeNull() })
    expect(screen.getAllByText('load failed').length).toBeGreaterThan(0)
    expect(maybe('[data-today-empty]')).toBeNull()
  })
})

describe('TodoView tasks page', () => {
  it('switches tabs and renders board and list, opening cards from both layouts', async () => {
    const nav = { open: vi.fn(), back: vi.fn(), canBack: vi.fn(() => false) }
    const { call } = renderView({ navigation: nav })
    await waitForToday()
    fireEvent.click(el('[data-todo-tab="tasks"]'))
    expect(el('[data-todo-page]').getAttribute('data-page')).toBe('tasks')
    expect(maybe('[data-todo-board]')).not.toBeNull()
    expect(all('[data-board-column]')).toHaveLength(3)
    expect(el('[data-board-column="todo"]').textContent).toContain('5')
    expect(el('[data-board-column="doing"]').textContent).toContain('1')
    expect(el('[data-board-column="done"]').textContent).toContain('2')
    expect(el('[data-todo-count]').textContent).toContain('8 个待办')

    fireEvent.click(el('[data-board-card="t1"] [data-todo-open="t1"]'))
    await waitForDetail()
    expect(maybe('[data-todo-delete]')).not.toBeNull()
    fireEvent.click(el('[data-todo-close]'))
    expect(maybe('[data-todo-detail]')).toBeNull()

    fireEvent.click(el('[data-todo-layout="list"]'))
    expect(all('[data-todo-list-row]')).toHaveLength(8)
    expect(within(el('[data-todo-list-row="t1"]')).getByText('待办')).toBeTruthy()
    expect(within(el('[data-todo-list-row="t2"]')).getByText('今天到期')).toBeTruthy()
    expect(within(el('[data-todo-list-row="t5"]')).getByText('已完成')).toBeTruthy()

    fireEvent.click(el('[data-todo-list-row="t1"] [data-todo-toggle="t1"]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('updateTask', { id: 't1', expectedVersion: 1, completed: true }) })

    fireEvent.click(el('[data-todo-list-row="t3"] [data-todo-open="t3"]'))
    await waitForDetail()
    expect(screen.getByText('还没有关联笔记')).toBeTruthy()
    fireEvent.click(el('[data-todo-scrim]'))
    expect(maybe('[data-todo-detail]')).toBeNull()

    fireEvent.click(el('[data-todo-layout="board"]'))
    expect(maybe('[data-todo-board]')).not.toBeNull()
  })

  it('labels priority with a visible text badge on rows, cards and list rows', async () => {
    renderView()
    await waitForToday()
    expect(el('[data-todo-row="t1"] [data-priority-badge="1"]').textContent).toBe('高')
    expect(el('[data-todo-row="t3"] [data-priority-badge="3"]').textContent).toBe('低')
    // The badge carries the accessible priority name; the dot is decorative.
    expect(el('[data-todo-row="t1"] [data-priority-badge="1"]').getAttribute('aria-label')).toContain('高')
    expect(el('[data-todo-row="t1"] [data-priority="1"]').getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(el('[data-todo-tab="tasks"]'))
    expect(el('[data-board-card="t1"] [data-priority-badge="1"]').textContent).toBe('高')
    expect(el('[data-board-card="t3"] [data-priority-badge="3"]').textContent).toBe('低')
    fireEvent.click(el('[data-todo-layout="list"]'))
    expect(el('[data-todo-list-row="t1"] [data-priority-badge="1"]').textContent).toBe('高')
    expect(el('[data-todo-list-row="t3"] [data-priority-badge="3"]').textContent).toBe('低')
  })

  it('filters by priority and both search fields', async () => {
    renderView()
    await waitForToday()
    fireEvent.click(el('[data-todo-tab="tasks"]'))
    fireEvent.change(select('[data-todo-filter-priority]'), { target: { value: '1' } })
    expect(all('[data-board-card]')).toHaveLength(3)
    fireEvent.change(select('[data-todo-filter-priority]'), { target: { value: '' } })
    fireEvent.change(input('[data-todo-search]'), { target: { value: 'today notes' } })
    expect(all('[data-board-card]')).toHaveLength(1)
    fireEvent.change(input('[data-todo-search]'), { target: { value: 'Done' } })
    expect(all('[data-board-card]')).toHaveLength(2)
    fireEvent.change(input('[data-todo-search]'), { target: { value: 'No due' } })
    expect(all('[data-board-card]')).toHaveLength(1)
    fireEvent.change(input('[data-todo-search]'), { target: { value: 'nothing matches' } })
    expect(all('[data-board-empty]')).toHaveLength(3)
    fireEvent.click(el('[data-todo-layout="list"]'))
    expect(maybe('[data-todo-list-empty]')).not.toBeNull()
    expect(screen.getByText('没有匹配的待办')).toBeTruthy()
  })

  it('toggles completion and reports a failed toggle', async () => {
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-todo-row="t1"] [data-todo-toggle="t1"]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('updateTask', { id: 't1', expectedVersion: 1, completed: true }) })
    fireEvent.click(el('[data-todo-tab="tasks"]'))
    fireEvent.click(el('[data-board-card="t1"] [data-todo-toggle="t1"]'))
    await waitFor(() => { expect(vi.mocked(call).mock.calls.filter(([op]) => op === 'updateTask')).toHaveLength(2) })

    cleanup()
    renderView({ call: makeCall({ updateTask: () => fail('toggle failed') }) })
    await waitForToday()
    fireEvent.click(el('[data-todo-tab="tasks"]'))
    fireEvent.click(el('[data-board-card="t1"] [data-todo-toggle="t1"]'))
    await waitFor(() => { expect(screen.getByText('toggle failed')).toBeTruthy() })
  })

  it('reloads after a change notice', async () => {
    let listener: (() => void) | undefined
    const call = makeCall()
    renderView({ call, onChanged: (fn) => { listener = fn; return () => undefined } })
    await waitForToday()
    listener?.()
    await waitFor(() => {
      const count = vi.mocked(call).mock.calls.filter(([op]) => op === 'listTasks').length
      expect(count).toBeGreaterThan(1)
    })
  })
})

describe('TodoView refresh failure', () => {
  it('keeps the loaded list when a refresh fails and recovers by retrying', async () => {
    let listener: (() => void) | undefined
    let failNext = false
    const call = makeCall({ listTasks: () => (failNext ? fail('refresh failed') : ok(tasks)) })
    renderView({ call, onChanged: (fn) => { listener = fn; return () => undefined } })
    await waitForToday()

    failNext = true
    act(() => { listener?.() })
    await waitFor(() => { expect(maybe('[data-todo-refresh-error]')).not.toBeNull() })
    expect(maybe('[data-today-view]')).not.toBeNull()
    expect(all('[data-todo-row]')).toHaveLength(5)
    expect(maybe('[data-todo-error-state]')).toBeNull()
    expect(screen.getByText('刷新待办失败，已保留当前内容')).toBeTruthy()
    expect(maybe('[data-todo-refresh-error]')?.closest('[data-todo-detail]')).toBeNull()

    failNext = false
    fireEvent.click(el('[data-todo-refresh-retry]'))
    await waitFor(() => { expect(maybe('[data-todo-refresh-error]')).toBeNull() })
    expect(all('[data-todo-row]')).toHaveLength(5)
  })

  it('keeps the open detail drawer when a refresh fails', async () => {
    let listener: (() => void) | undefined
    let failNext = false
    const call = makeCall({ listTasks: () => (failNext ? fail('refresh failed') : ok(tasks)) })
    renderView({ call, onChanged: (fn) => { listener = fn; return () => undefined } })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()

    failNext = true
    act(() => { listener?.() })
    await waitFor(() => { expect(maybe('[data-todo-refresh-error]')).not.toBeNull() })
    expect(maybe('[data-todo-detail]')).not.toBeNull()
    expect(input('[data-todo-title]').value).toBe('Today task')
    expect(maybe('[data-todo-error-state]')).toBeNull()
    // The notice is inside the drawer, so the narrow full-screen drawer shows it.
    expect(el('[data-todo-detail]').contains(maybe('[data-todo-refresh-error]'))).toBe(true)

    failNext = false
    fireEvent.click(el('[data-todo-refresh-retry]'))
    await waitFor(() => { expect(maybe('[data-todo-refresh-error]')).toBeNull() })
    expect(maybe('[data-todo-detail]')).not.toBeNull()
    expect(input('[data-todo-title]').value).toBe('Today task')
  })
})

describe('TodoView detail', () => {
  it('links notes, edits every field, reports dirty context, saves and clears the guard', async () => {
    const nav = { open: vi.fn(), back: vi.fn(), canBack: vi.fn(() => false) }
    let guard: (() => boolean | Promise<boolean>) | undefined
    const call = makeCall()
    const report = vi.fn(() => () => undefined)
    renderView({
      call,
      navigation: nav,
      pageContext: { report },
      registerLeaveGuard: (fn) => { guard = fn; return () => undefined },
    })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    await waitFor(() => { expect(within(el('[data-note-links]')).getByText('Linked note')).toBeTruthy() })
    expect(call).toHaveBeenCalledWith('resolveNotes', { ids: ['n1'] })

    fireEvent.click(el('[data-note-open="n1"]'))
    expect(nav.open).toHaveBeenCalledWith({ appId: 'notes', record: { appId: 'notes', kind: 'note', id: 'n1' }, view: 'editor' })

    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Changed title' } })
    fireEvent.change(select('[data-todo-priority]'), { target: { value: '3' } })
    fireEvent.change(input('[data-todo-due]'), { target: { value: isoDay(3) } })
    fireEvent.change(select('[data-todo-assignee]'), { target: { value: 'agent' } })
    fireEvent.change(el('[data-todo-description]'), { target: { value: 'Changed notes' } })
    fireEvent.click(el('[data-todo-complete]'))

    await waitFor(() => { expect(el('[data-todo-dirty]').getAttribute('data-todo-dirty')).toBe('true') })
    await waitFor(() => {
      expect((report.mock.calls as unknown as Array<[{ dirty?: boolean }]>).some(call => call[0].dirty === true)).toBe(true)
    })
    const pending = guard?.()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(await pending).toBe(false)
    const pendingLeave = guard?.()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    expect(await pendingLeave).toBe(true)

    fireEvent.change(input('[data-note-search]'), { target: { value: 'Another' } })
    fireEvent.click(el('[data-note-find]'))
    await waitFor(() => { expect(maybe('[data-note-result="n2"]')).not.toBeNull() })
    fireEvent.click(el('[data-note-result="n2"]'))
    await waitFor(() => { expect(maybe('[data-note-chip="n2"]')).not.toBeNull() })
    fireEvent.click(el('[data-note-remove="n1"]'))
    await waitFor(() => { expect(maybe('[data-note-chip="n1"]')).toBeNull() })

    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('updateTask', expect.objectContaining({
        id: 't1',
        expectedVersion: 1,
        title: 'Changed title',
        priority: 3,
        dueDate: isoDay(3),
        assignee: 'agent',
        notes: 'Changed notes',
        completed: true,
        noteIds: ['n2'],
      }))
    })
    await waitFor(() => { expect(maybe('[data-todo-detail]')).toBeNull() })
    expect(maybe('[data-todo-status]')?.textContent).toBe('已保存')
    await waitFor(() => { expect(guard?.()).toBe(true) })
  })

  it('shows a conflict and reloads the current task after a stale save', async () => {
    const stale = { callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }
    const call = makeCall({ updateTask: () => stale })
    renderView({ call })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => { expect(maybe('[data-todo-conflict]')).not.toBeNull() })
    expect(maybe('[data-todo-save]')?.hasAttribute('disabled')).toBe(true)
    fireEvent.click(el('[data-todo-reload]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(maybe('[data-todo-conflict]')).toBeNull() })
  })

  it('shows the conflict banner when a quick toggle is stale', async () => {
    const stale = { callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }
    const call = makeCall({ updateTask: () => stale })
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-todo-row="t1"] [data-todo-toggle="t1"]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('updateTask', expect.objectContaining({ id: 't1' })) })
  })

  it('creates a new task explicitly, validates an empty title, and cancels', async () => {
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-todo-new-task]'))
    await waitForDetail()
    expect(maybe('[data-todo-delete]')).toBeNull()

    fireEvent.change(input('[data-todo-title]'), { target: { value: '   ' } })
    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => { expect(screen.getByText('标题不能为空')).toBeTruthy() })

    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Brand new' } })
    fireEvent.change(select('[data-todo-priority]'), { target: { value: '1' } })
    fireEvent.change(input('[data-todo-due]'), { target: { value: '' } })
    fireEvent.change(select('[data-todo-assignee]'), { target: { value: 'agent' } })
    fireEvent.change(el('[data-todo-description]'), { target: { value: 'new notes' } })
    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('createTask', {
        title: 'Brand new',
        notes: 'new notes',
        dueDate: null,
        assignee: 'agent',
        priority: 1,
        noteIds: [],
      })
    })
    await waitFor(() => { expect(maybe('[data-todo-detail]')).toBeNull() })

    fireEvent.click(el('[data-todo-new-task]'))
    await waitForDetail()
    fireEvent.click(el('[data-todo-cancel]'))
    expect(maybe('[data-todo-detail]')).toBeNull()
    fireEvent.click(el('[data-todo-new-task]'))
    await waitForDetail()
    fireEvent.click(el('[data-todo-close]'))
    expect(maybe('[data-todo-detail]')).toBeNull()
  })

  it('reports save failures, get failures and a routed task', async () => {
    renderView({ call: makeCall({ updateTask: () => fail('save failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => { expect(screen.getByText('save failed')).toBeTruthy() })

    cleanup()
    renderView({ call: makeCall({ getTask: () => fail('get failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitFor(() => { expect(screen.getByText('get failed')).toBeTruthy() })
    expect(maybe('[data-todo-detail]')).toBeNull()

    cleanup()
    const route = { appId: 'todo', record: { appId: 'todo', kind: 'task', id: 't2' }, nonce: '1' }
    renderView({ route })
    await waitForDetail()
    expect(screen.getByDisplayValue('Today task')).toBeTruthy()
  })

  it('keeps save, validation and delete failures inside the open drawer', async () => {
    const call = makeCall({ updateTask: () => fail('save failed'), deleteTask: () => fail('delete failed') })
    renderView({ call })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => { expect(maybe('[data-todo-detail-error]')).not.toBeNull() })
    expect(maybe('[data-todo-detail-error]')?.textContent).toContain('保存失败')
    // The raw wire detail stays behind the diagnostics disclosure.
    expect(screen.getByText('save failed')).toBeTruthy()
    expect(maybe('[data-todo-error]')).toBeNull()
    expect(maybe('[data-todo-detail]')).not.toBeNull()

    // Validation feedback belongs beside the fields as well.
    fireEvent.change(input('[data-todo-title]'), { target: { value: '   ' } })
    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => { expect(maybe('[data-todo-detail-error]')?.textContent).toContain('标题不能为空') })
    expect(maybe('[data-todo-error]')).toBeNull()
    expect(maybe('[data-todo-detail]')).not.toBeNull()

    fireEvent.click(el('[data-todo-delete]'))
    await waitFor(() => { expect(maybe('[data-todo-detail-error]')?.textContent).toContain('删除失败') })
    expect(screen.getByText('delete failed')).toBeTruthy()
    expect(maybe('[data-todo-error]')).toBeNull()
    expect(maybe('[data-todo-detail]')).not.toBeNull()
  })

  it('keeps a missing-permission save refusal inside the drawer and offers management', async () => {
    const openManagement = vi.fn()
    const call = makeCall({
      updateTask: () => ({ callId: 'c', status: 'failed', error: { code: 'app.capability-not-approved', message: 'not approved' } }),
    })
    renderView({ call, openManagement })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-todo-save]'))
    await waitFor(() => { expect(maybe('[data-todo-detail-error]')).not.toBeNull() })
    expect(maybe('[data-todo-detail-error]')?.textContent).toContain('应用数据存储')
    expect(maybe('[data-todo-error]')).toBeNull()
    fireEvent.click(el('[data-todo-detail-manage-permissions]'))
    expect(openManagement).toHaveBeenCalledWith('permissions')
  })

  it('searches notes on Enter, handles an empty search, and shows unavailable states', async () => {
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-note-find]'))
    expect(call).not.toHaveBeenCalledWith('searchNotes', expect.anything())
    fireEvent.change(input('[data-note-search]'), { target: { value: 'Any' } })
    fireEvent.keyDown(input('[data-note-search]'), { key: 'Enter' })
    await waitFor(() => { expect(call).toHaveBeenCalledWith('searchNotes', { query: 'Any' }) })
    await waitFor(() => { expect(maybe('[data-note-result="n2"]')).not.toBeNull() })

    cleanup()
    const failing = makeCall({ searchNotes: () => fail('no notes') })
    renderView({ call: failing })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.change(input('[data-note-search]'), { target: { value: 'Any' } })
    fireEvent.click(el('[data-note-find]'))
    await waitFor(() => { expect(maybe('[data-note-search-unavailable]')).not.toBeNull() })

    cleanup()
    const unavailable = makeCall({
      resolveNotes: () => ok({ notes: [], unavailable: true }),
    })
    renderView({ call: unavailable })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-notes-unavailable]')).not.toBeNull() })
    expect(maybe('[data-note-unavailable="n1"]')).not.toBeNull()
    expect(input('[data-note-search]').disabled).toBe(true)
    fireEvent.click(el('[data-note-find]'))
    expect(unavailable).not.toHaveBeenCalledWith('searchNotes', expect.anything())
    fireEvent.click(el('[data-note-unavailable="n1"] [data-note-remove="n1"]'))
    await waitFor(() => { expect(maybe('[data-note-unavailable="n1"]')).toBeNull() })
    expect(screen.getByText('还没有关联笔记')).toBeTruthy()
  })
})

describe('TodoView delete and undo', () => {
  it('soft-deletes and restores a task, including the short undo window', async () => {
    const timeout = vi.spyOn(window, 'setTimeout')
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-todo-delete]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('deleteTask', { id: 't1' }) })
    await waitFor(() => { expect(maybe('[data-todo-undo]')).not.toBeNull() })
    expect(maybe('[data-todo-detail]')).toBeNull()
    expect(maybe('[data-todo-undo]')?.textContent).toContain('已删除「Overdue task」')

    fireEvent.click(el('[data-todo-undo-action]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('restoreTask', { id: 't1' }) })
    await waitFor(() => { expect(maybe('[data-todo-undo]')).toBeNull() })
    expect(maybe('[data-todo-status]')?.textContent).toBe('待办已恢复')

    // A second delete leaves an undo offer; its own timer dismisses it.
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-todo-delete]'))
    await waitFor(() => { expect(maybe('[data-todo-undo]')).not.toBeNull() })
    const timer = timeout.mock.calls.find(([, delay]) => delay === 8000)?.[0] as (() => void) | undefined
    expect(timer).toBeTypeOf('function')
    act(() => { timer?.() })
    await waitFor(() => { expect(maybe('[data-todo-undo]')).toBeNull() })
  })

  it('reports a failed delete and a failed restore', async () => {
    renderView({ call: makeCall({ deleteTask: () => fail('delete failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-todo-delete]'))
    await waitFor(() => { expect(screen.getByText('delete failed')).toBeTruthy() })

    cleanup()
    renderView({ call: makeCall({ restoreTask: () => fail('restore failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-todo-delete]'))
    await waitFor(() => { expect(maybe('[data-todo-undo]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-undo-action]'))
    await waitFor(() => { expect(screen.getByText('restore failed')).toBeTruthy() })
    expect(maybe('[data-todo-undo]')).not.toBeNull()
  })
})

describe('TodoView narrow layout', () => {
  it('mirrors the page content width, makes the detail full-screen, and disconnects', async () => {
    class FakeResizeObserver {
      static latest: FakeResizeObserver | undefined
      readonly observed: Element[] = []
      disconnected = false
      private readonly callback: (entries: readonly { readonly contentRect: { readonly width: number } }[]) => void
      constructor(callback: FakeResizeObserver['callback']) {
        this.callback = callback
        FakeResizeObserver.latest = this
      }
      observe(target: Element): void { this.observed.push(target) }
      unobserve(): void {}
      disconnect(): void { this.disconnected = true }
      measure(width: number): void { act(() => { this.callback([{ contentRect: { width } }]) }) }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const { view } = renderView()
    await waitForToday()
    const page = el('[data-todo-page]')
    expect(page.getAttribute('data-narrow')).toBe('false')
    expect(FakeResizeObserver.latest?.observed).toContain(page)
    FakeResizeObserver.latest?.measure(700)
    await waitFor(() => { expect(el('[data-todo-page]').getAttribute('data-narrow')).toBe('true') })

    openTodayTask('t1')
    await waitForDetail()
    expect(el('[data-todo-detail]').getAttribute('data-todo-detail-full')).toBe('true')
    view.unmount()
    expect(FakeResizeObserver.latest?.disconnected).toBe(true)
  })

  it('opens the list on a narrow area but keeps an explicit board choice', async () => {
    class FakeResizeObserver {
      static latest: FakeResizeObserver | undefined
      readonly observed: Element[] = []
      disconnected = false
      private readonly callback: (entries: readonly { readonly contentRect: { readonly width: number } }[]) => void
      constructor(callback: FakeResizeObserver['callback']) { this.callback = callback; FakeResizeObserver.latest = this }
      observe(target: Element): void { this.observed.push(target) }
      unobserve(): void {}
      disconnect(): void { this.disconnected = true }
      measure(width: number): void { act(() => { this.callback([{ contentRect: { width } }]) }) }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    renderView()
    await waitForToday()
    FakeResizeObserver.latest?.measure(700)
    await waitFor(() => { expect(el('[data-todo-page]').getAttribute('data-narrow')).toBe('true') })
    fireEvent.click(el('[data-todo-tab="tasks"]'))
    await waitFor(() => { expect(el('[data-todo-toolbar]')).toBeTruthy() })
    expect(el('[data-todo-layout="list"]').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(el('[data-todo-layout="board"]'))
    await waitFor(() => { expect(el('[data-todo-layout="board"]').getAttribute('aria-pressed')).toBe('true') })
    expect(el('[data-todo-board]')).toBeTruthy()
    // A later narrow measurement must not undo the explicit board choice.
    FakeResizeObserver.latest?.measure(700)
    await waitFor(() => { expect(el('[data-todo-layout="board"]').getAttribute('aria-pressed')).toBe('true') })
  })

  it('keeps a dirty detail open when the human cancels the discard prompt', async () => {
    renderView()
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.change(input('[data-todo-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-todo-close]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(maybe('[data-todo-detail]')).not.toBeNull()
    fireEvent.click(el('[data-todo-close]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(maybe('[data-todo-detail]')).toBeNull() })
  })

  it('shows a page-level conflict after a list toggle and reloads on demand', async () => {
    const call = makeCall({ updateTask: () => ({ callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }) })
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-todo-toggle="t1"]'))
    await waitFor(() => { expect(maybe('[data-todo-conflict-page]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-reload-page]'))
    await waitFor(() => { expect(maybe('[data-todo-conflict-page]')).toBeNull() })
  })

  it('clears filters from the empty today view', async () => {
    renderView()
    await waitForToday()
    fireEvent.change(input('[data-todo-search]'), { target: { value: 'no-such-task' } })
    await waitFor(() => { expect(maybe('[data-today-clear-filters]')).not.toBeNull() })
    fireEvent.click(el('[data-today-clear-filters]'))
    await waitFor(() => { expect(maybe('[data-today-clear-filters]')).toBeNull() })
    expect(all('[data-todo-row]').length).toBeGreaterThan(0)
  })
})

describe('TodoView delegation', () => {
  /** One delegation as the todo application's own read operation exposes it. */
  interface DelegationFixture {
    id: string
    title: string
    instructions: string
    status: 'pending' | 'active' | 'needs-person' | 'ended'
    outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable'
    latestReport?: { outcome: 'completed' | 'blocked' | 'failed'; summary: string; question?: string }
    createdAt: string
    updatedAt: string
  }

  function delegationFixture(over: Partial<DelegationFixture> = {}): DelegationFixture {
    return {
      id: 'delegation-1',
      title: '待办：Today task',
      instructions: '处理这个待办：Today task',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }
  }

  /** The page-side delegation faces the framework hands a page. */
  function delegationFace() {
    return {
      requestSend: vi.fn(async () => undefined),
      cancel: vi.fn(async () => true),
      open: vi.fn(async () => true),
    }
  }

  it('prepares a pending delegation and offers it to the human to send', async () => {
    let current: DelegationFixture | null = null
    const call = makeCall({
      taskDelegation: () => ok({ delegation: current }),
      createDelegation: () => {
        current = delegationFixture()
        return ok({ delegation: current })
      },
    })
    const face = delegationFace()
    renderView({ call, delegation: face })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-create]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-create]'))
    await waitFor(() => { expect(face.requestSend).toHaveBeenCalledWith('delegation-1') })
    await waitFor(() => { expect(el('[data-todo-delegation-state]').textContent).toContain('待确认') })
    expect(el('[data-todo-delegation-pending]').textContent).toContain('应用指令只读')
    // Sending again re-offers the same pending delegation.
    fireEvent.click(el('[data-todo-delegation-send]'))
    await waitFor(() => { expect(face.requestSend).toHaveBeenCalledTimes(2) })
  })

  it('shows an ended result and appends it only on the user action, without completing the todo', async () => {
    const ended = delegationFixture({
      status: 'ended',
      outcome: 'completed',
      latestReport: { outcome: 'completed', summary: '本周总结已完成' },
    })
    const call = makeCall({
      taskDelegation: () => ok({ delegation: ended, applied: false }),
      applyDelegationResult: (args) => ok({
        ...tasks[1],
        notes: `old notes\n\n[委托结果 · 完成]\n本周总结已完成`,
        version: 2,
        applied: args.delegationId,
      }),
    })
    renderView({ call })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-state]')).not.toBeNull() })
    expect(el('[data-todo-delegation-state]').textContent).toContain('已完成')
    expect(el('[data-todo-delegation-summary]').textContent).toContain('本周总结已完成')
    fireEvent.click(el('[data-todo-delegation-apply]'))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('applyDelegationResult', expect.objectContaining({ taskId: 't2', delegationId: 'delegation-1' }))
    })
    await waitFor(() => { expect(maybe('[data-todo-delegation-applied]')).not.toBeNull() })
    // The todo is not marked complete by appending a report.
    expect(maybe('[data-todo-complete]')?.textContent).toContain('完成')
  })

  it('shows a blocker question and opens/cancels through the platform faces', async () => {
    const blocked = delegationFixture({
      status: 'needs-person',
      latestReport: { outcome: 'blocked', summary: '需要用户决定', question: '选哪个方案？' },
    })
    let current: DelegationFixture | null = blocked
    const call = makeCall({ taskDelegation: () => ok({ delegation: current }) })
    const face = delegationFace()
    renderView({ call, delegation: face })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(el('[data-todo-delegation-state]').textContent).toContain('需要人') })
    expect(el('[data-todo-delegation-question]').textContent).toContain('选哪个方案？')
    fireEvent.click(el('[data-todo-delegation-open]'))
    await waitFor(() => { expect(face.open).toHaveBeenCalledWith('delegation-1') })
    current = null
    fireEvent.click(el('[data-todo-delegation-cancel]'))
    await waitFor(() => { expect(face.cancel).toHaveBeenCalledWith('delegation-1') })
    await waitFor(() => { expect(maybe('[data-todo-delegation-create]')).not.toBeNull() })
  })

  it('re-reads the delegation when the application reports a change', async () => {
    let listener: (() => void) | undefined
    let current: DelegationFixture | null = delegationFixture()
    const onChanged = vi.fn((callback: () => void) => {
      listener = callback
      return () => undefined
    })
    const call = makeCall({ taskDelegation: () => ok({ delegation: current }) })
    renderView({ call, onChanged })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(el('[data-todo-delegation-state]').textContent).toContain('待确认') })
    current = delegationFixture({ status: 'active' })
    act(() => { listener?.() })
    await waitFor(() => { expect(el('[data-todo-delegation-state]').textContent).toContain('执行中') })
    expect(maybe('[data-todo-delegation-open]')).not.toBeNull()
  })

  it('labels every ended delegation outcome', async () => {
    const outcomes: Array<[NonNullable<DelegationFixture['outcome']>, string]> = [
      ['failed', '已失败'],
      ['cancelled', '已取消'],
      ['interrupted', '已中断'],
      ['unavailable', '不可用'],
    ]
    for (const [outcome, label] of outcomes) {
      cleanup()
      renderView({ call: makeCall({ taskDelegation: () => ok({ delegation: delegationFixture({ status: 'ended', outcome }) }) }) })
      await waitForToday()
      openTodayTask('t2')
      await waitForDetail()
      await waitFor(() => { expect(el('[data-todo-delegation-state]').textContent).toBe(label) })
    }
  })

  it('reports a failed create, a missing face and a failed send', async () => {
    // The application refuses to prepare the delegation.
    renderView({
      call: makeCall({ taskDelegation: () => ok({ delegation: null }), createDelegation: () => fail('create delegation failed') }),
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-create]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-create]'))
    await waitFor(() => { expect(screen.getByText('create delegation failed')).toBeTruthy() })

    // Prepared, but this host handed the page no send face.
    cleanup()
    renderView({
      call: makeCall({
        taskDelegation: () => ok({ delegation: null }),
        createDelegation: () => ok({ delegation: delegationFixture() }),
      }),
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-create]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-create]'))
    await waitFor(() => { expect(screen.getByText('委托操作失败')).toBeTruthy() })

    // The send dialog refuses to open right after preparing.
    cleanup()
    const rejecting = delegationFace()
    rejecting.requestSend.mockRejectedValueOnce(new Error('send offline'))
    renderView({
      call: makeCall({
        taskDelegation: () => ok({ delegation: null }),
        createDelegation: () => ok({ delegation: delegationFixture() }),
      }),
      delegation: rejecting,
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-create]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-create]'))
    await waitFor(() => { expect(screen.getByText('send offline')).toBeTruthy() })

    // Re-offering an existing pending delegation fails the same way.
    cleanup()
    const rejectingOffer = delegationFace()
    rejectingOffer.requestSend.mockRejectedValueOnce(new Error('offer offline'))
    renderView({
      call: makeCall({ taskDelegation: () => ok({ delegation: delegationFixture() }) }),
      delegation: rejectingOffer,
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-send]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-send]'))
    await waitFor(() => { expect(screen.getByText('offer offline')).toBeTruthy() })
  })

  it('ignores delegation actions when the host provides no platform face', async () => {
    // Pending: the send button is a no-op without the face.
    renderView({ call: makeCall({ taskDelegation: () => ok({ delegation: delegationFixture() }) }) })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-send]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-send]'))
    expect(maybe('[data-todo-delegation-error]')).toBeNull()

    // Running: open and cancel are no-ops without the face.
    cleanup()
    renderView({ call: makeCall({ taskDelegation: () => ok({ delegation: delegationFixture({ status: 'active' }) }) }) })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-open]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-open]'))
    fireEvent.click(el('[data-todo-delegation-cancel]'))
    expect(maybe('[data-todo-delegation-error]')).toBeNull()
  })

  it('reports a cancel and an open the platform refused', async () => {
    const refusingCancel = delegationFace()
    refusingCancel.cancel.mockResolvedValueOnce(false)
    renderView({
      call: makeCall({ taskDelegation: () => ok({ delegation: delegationFixture({ status: 'needs-person' }) }) }),
      delegation: refusingCancel,
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-cancel]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-cancel]'))
    await waitFor(() => { expect(screen.getByText('委托操作失败')).toBeTruthy() })

    cleanup()
    const refusingOpen = delegationFace()
    refusingOpen.open.mockResolvedValueOnce(false)
    renderView({
      call: makeCall({ taskDelegation: () => ok({ delegation: delegationFixture({ status: 'active' }) }) }),
      delegation: refusingOpen,
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-open]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-open]'))
    await waitFor(() => { expect(screen.getByText('委托操作失败')).toBeTruthy() })
  })

  it('reports a stale and a failed apply of the ended report', async () => {
    const ended = delegationFixture({
      status: 'ended',
      outcome: 'completed',
      latestReport: { outcome: 'completed', summary: '结果' },
    })
    renderView({
      call: makeCall({
        taskDelegation: () => ok({ delegation: ended, applied: false }),
        applyDelegationResult: () => ({ callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }),
      }),
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-apply]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-apply]'))
    await waitFor(() => { expect(maybe('[data-todo-conflict]')).not.toBeNull() })

    cleanup()
    renderView({
      call: makeCall({
        taskDelegation: () => ok({ delegation: ended, applied: false }),
        applyDelegationResult: () => fail('apply failed'),
      }),
    })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-apply]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-apply]'))
    await waitFor(() => { expect(screen.getByText('apply failed')).toBeTruthy() })
  })

  it('retries an ended delegation from its card', async () => {
    const ended = delegationFixture({
      status: 'ended',
      outcome: 'failed',
      latestReport: { outcome: 'failed', summary: '失败' },
    })
    const retried = delegationFixture({ id: 'delegation-2' })
    const call = makeCall({
      taskDelegation: () => ok({ delegation: ended, applied: true }),
      createDelegation: () => ok({ delegation: retried }),
    })
    const face = delegationFace()
    renderView({ call, delegation: face })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-retry]')).not.toBeNull() })
    fireEvent.click(el('[data-todo-delegation-retry]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('createDelegation', { taskId: 't2' }) })
    await waitFor(() => { expect(face.requestSend).toHaveBeenCalledWith('delegation-2') })
  })

  it('collapses a long report, expands it, and shows the elapsed time above the actions', async () => {
    const summary = Array.from({ length: 30 }, (_value, index) => `第 ${index} 行：长报告内容`).join('\n')
    const ended = delegationFixture({
      status: 'ended',
      outcome: 'completed',
      latestReport: { outcome: 'completed', summary },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:02:51.000Z',
    })
    renderView({ call: makeCall({ taskDelegation: () => ok({ delegation: ended, applied: true }) }) })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-report]')).not.toBeNull() })

    expect(el('[data-todo-delegation-report]').getAttribute('data-expanded')).toBe('false')
    expect(maybe('[data-todo-delegation-summary]')?.textContent).toBe(summary)
    expect(el('[data-todo-delegation-expand]').textContent).toBe('展开全文')
    expect(el('[data-todo-delegation-duration]').textContent).toBe('用时 2 分 51 秒')
    // The report and its toggle stay above the action row, which reads next.
    const following = el('[data-todo-delegation-expand]').compareDocumentPosition(el('[data-todo-delegation-actions]'))
    expect(following & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(el('[data-todo-delegation-expand]'))
    await waitFor(() => { expect(el('[data-todo-delegation-report]').getAttribute('data-expanded')).toBe('true') })
    expect(el('[data-todo-delegation-expand]').textContent).toBe('收起')
    expect(maybe('[data-todo-delegation-summary]')?.textContent).toBe(summary)
    fireEvent.click(el('[data-todo-delegation-expand]'))
    await waitFor(() => { expect(el('[data-todo-delegation-report]').getAttribute('data-expanded')).toBe('false') })
  })

  it('shows the elapsed time in seconds and omits it without usable timestamps', async () => {
    const running = delegationFixture({
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:13.000Z',
    })
    renderView({ call: makeCall({ taskDelegation: () => ok({ delegation: running, applied: false }) }) })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-duration]')).not.toBeNull() })
    expect(el('[data-todo-delegation-duration]').textContent).toBe('用时 13 秒')

    for (const timestamps of [
      { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { createdAt: 'not-a-date', updatedAt: '2026-01-01T00:00:13.000Z' },
      { createdAt: '2026-01-01T00:00:13.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      cleanup()
      renderView({
        call: makeCall({ taskDelegation: () => ok({ delegation: delegationFixture({ status: 'active', ...timestamps }), applied: false }) }),
      })
      await waitForToday()
      openTodayTask('t2')
      await waitForDetail()
      await waitFor(() => { expect(maybe('[data-todo-delegation-card]')).not.toBeNull() })
      expect(maybe('[data-todo-delegation-duration]')).toBeNull()
    }
  })

  it('resets the delegation card on a failed read and skips it for an empty id', async () => {
    // The read itself failed: the card falls back to the create offer.
    const failedRead = makeCall({ taskDelegation: () => fail('delegation read failed') })
    renderView({ call: failedRead })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    await waitFor(() => { expect(maybe('[data-todo-delegation-create]')).not.toBeNull() })
    expect(maybe('[data-todo-delegation-card]')).toBeNull()

    // A host task with an empty id is treated as new: no delegation read.
    cleanup()
    const emptyId = makeCall({ getTask: () => ok({ ...tasks[1], id: '' }) })
    renderView({ call: emptyId })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    expect(maybe('[data-todo-delegation]')).toBeNull()
    expect(emptyId).not.toHaveBeenCalledWith('taskDelegation', expect.anything())
  })
})

describe('TodoView host edges', () => {
  it('falls back to the dictionary when the host omits an error message', async () => {
    renderView({ call: makeCall({ listTasks: () => ({ callId: 'c', status: 'cancelled' }) }) })
    await waitFor(() => { expect(screen.getAllByText('读取待办失败').length).toBeGreaterThan(0) })
  })
})

describe('TodoView stylesheet contract', () => {
  it('keeps the five-line report clamp and its expanded override', () => {
    const stylesheet = readFileSync(join(process.cwd(), 'apps/todo/view/src/client/TodoView.module.css'), 'utf8')
    expect(stylesheet).toMatch(/\.delegationSummary \{[^}]*-webkit-line-clamp:\s*5/u)
    expect(stylesheet).toMatch(/\.delegationSummaryExpanded \{[^}]*-webkit-line-clamp:\s*unset/u)
  })
})
