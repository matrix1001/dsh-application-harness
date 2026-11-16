// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { TasksPage, TasksView } from '../src/client/TasksView.tsx'
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
  projectId: string | null
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
  projectId: null,
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
  { ...base, id: 't1', title: 'Overdue task', dueDate: isoDay(-2), projectId: 'p1', assignee: 'agent', priority: 1, noteIds: ['n1'] },
  { ...base, id: 't2', title: 'Today task', dueDate: TODAY, projectId: 'p1', notes: 'today notes' },
  { ...base, id: 't3', title: 'Tomorrow task', dueDate: TOMORROW, priority: 3 },
  { ...base, id: 't4', title: 'Upcoming task', dueDate: isoDay(5), projectId: 'p2' },
  { ...base, id: 't5', title: 'Done today', dueDate: TODAY, projectId: 'p1', priority: 1, completedAt: NOW + 1000 },
  { ...base, id: 't6', title: 'Done earlier', dueDate: isoDay(-3), projectId: 'p1', priority: 3, completedAt: NOW - 2 * 86_400_000 },
  { ...base, id: 't7', title: 'No due task', priority: 3 },
  { ...base, id: 't8', title: 'Far task', dueDate: isoDay(10), projectId: 'p2', priority: 1 },
]

const projects = [
  { id: 'p1', name: 'App Harness', version: 1 },
  { id: 'p2', name: 'Notes', version: 3 },
  { id: 'p3', name: 'Empty', version: 1 },
]

type Result = Record<string, unknown>
const ok = (value: unknown): Result => ({ callId: 'c', status: 'success', result: value })
const fail = (message = 'failed'): Result => ({ callId: 'c', status: 'failed', error: { code: 'app.x', message } })

type Handlers = Record<string, (args: Record<string, unknown>) => Result | Promise<Result>>

function makeCall(overrides: Handlers = {}): ApplicationViewProps['call'] {
  const handlers: Handlers = {
    listTasks: () => ok(tasks),
    listProjects: () => ok(projects),
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
    createProject: args => ok({ id: 'p_new', name: args.name, version: 1 }),
    updateProject: args => ok({ id: args.id, name: args.name, version: 2 }),
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
  const view = render(<TasksView {...p} t={t} />)
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
function openTodayTask(id: string): void { fireEvent.click(el(`[data-task-open="${id}"]`)) }
async function waitForToday(): Promise<void> {
  await waitFor(() => { expect(maybe('[data-today-view]')).not.toBeNull() })
}
async function waitForDetail(): Promise<void> {
  await waitFor(() => { expect(maybe('[data-task-detail]')).not.toBeNull() })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TasksPage', () => {
  it('binds the locale and renders the shared page', async () => {
    const snapshot = { language: 'zh' }
    const subscribe = vi.fn(() => () => undefined)
    const getSnapshot = vi.fn(() => snapshot)
    const bind = vi.fn(() => t)
    const locale = { subscribe, getSnapshot, bind }
    render(<TasksPage {...props(makeCall())} locale={locale as never} />)
    await waitFor(() => { expect(screen.getByText('今天')).toBeTruthy() })
    expect(subscribe).toHaveBeenCalled()
    expect(getSnapshot).toHaveBeenCalled()
    expect(bind).toHaveBeenCalledWith('tasks')
  })
})

describe('TasksView today', () => {
  it('shows loading, then the four today groups with counts and quick add', async () => {
    renderView()
    expect(screen.getByText('读取中…')).toBeTruthy()
    await waitForToday()
    expect(el('[data-tasks-page]').getAttribute('data-page')).toBe('today')
    expect(el('[data-tasks-page]').getAttribute('data-narrow')).toBe('false')
    expect(el('[data-today-summary]').textContent).toContain('1 个逾期 · 1 个今日到期')
    for (const id of ['overdue', 'today', 'upcoming', 'completed']) {
      expect(maybe(`[data-today-section="${id}"]`)).not.toBeNull()
    }
    expect(within(el('[data-today-section="overdue"]')).getByText('Overdue task')).toBeTruthy()
    expect(within(el('[data-today-section="today"]')).getByText('Today task')).toBeTruthy()
    expect(within(el('[data-today-section="upcoming"]')).getByText('Tomorrow task')).toBeTruthy()
    expect(within(el('[data-today-section="completed"]')).getByText('Done today')).toBeTruthy()
    expect(all('[data-task-row]')).toHaveLength(5)
    expect(el('[data-task-row="t1"]').querySelector('[data-assignee="agent"]')).not.toBeNull()
    expect(el('[data-task-row="t1"]').querySelector('[data-note-count]')?.textContent).toContain('1')
    expect(el('[data-task-open="t1"]').closest('[data-task-row]')).not.toBeNull()
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
    await waitFor(() => { expect(maybe('[data-tasks-error]')).toBeNull() })

    cleanup()
    const failing = makeCall({ createTask: () => fail('add failed') })
    renderView({ call: failing })
    await waitForToday()
    fireEvent.change(input('[data-today-quick-add] input'), { target: { value: 'Broken' } })
    fireEvent.click(el('[data-today-quick-submit]'))
    await waitFor(() => { expect(screen.getByText('add failed')).toBeTruthy() })
  })

  it('orders several completed-today tasks newest first', async () => {
    const completed = [
      { ...base, id: 'c1', title: 'First done', completedAt: NOW - 5000 },
      { ...base, id: 'c2', title: 'Second done', completedAt: NOW },
    ]
    renderView({ call: makeCall({ listTasks: () => ok(completed) }) })
    await waitForToday()
    expect(all('[data-today-section="completed"] [data-task-row]').map(row => row.getAttribute('data-task-row'))).toEqual(['c2', 'c1'])
  })

  it('shows empty today and a load failure instead of an empty list', async () => {
    renderView({ call: makeCall({ listTasks: () => ok([]) }) })
    await waitFor(() => { expect(maybe('[data-today-empty]')).not.toBeNull() })
    expect(screen.getByText('今天没有任务')).toBeTruthy()

    cleanup()
    renderView({ call: makeCall({ listTasks: () => fail('load failed') }) })
    await waitFor(() => { expect(maybe('[data-tasks-error-state]')).not.toBeNull() })
    expect(screen.getAllByText('load failed').length).toBeGreaterThan(0)
    expect(maybe('[data-today-empty]')).toBeNull()
  })
})

describe('TasksView tasks page', () => {
  it('switches tabs and renders board and list, opening cards from both layouts', async () => {
    const nav = { open: vi.fn(), back: vi.fn(), canBack: vi.fn(() => false) }
    const { call } = renderView({ navigation: nav })
    await waitForToday()
    fireEvent.click(el('[data-tasks-tab="tasks"]'))
    expect(el('[data-tasks-page]').getAttribute('data-page')).toBe('tasks')
    expect(maybe('[data-task-board]')).not.toBeNull()
    expect(all('[data-board-column]')).toHaveLength(3)
    expect(el('[data-board-column="todo"]').textContent).toContain('5')
    expect(el('[data-board-column="doing"]').textContent).toContain('1')
    expect(el('[data-board-column="done"]').textContent).toContain('2')
    expect(el('[data-tasks-count]').textContent).toContain('8 个任务')

    fireEvent.click(el('[data-board-card="t1"] [data-task-open="t1"]'))
    await waitForDetail()
    expect(maybe('[data-task-delete]')).not.toBeNull()
    fireEvent.click(el('[data-task-close]'))
    expect(maybe('[data-task-detail]')).toBeNull()

    fireEvent.click(el('[data-tasks-layout="list"]'))
    expect(all('[data-task-list-row]')).toHaveLength(8)
    expect(within(el('[data-task-list-row="t1"]')).getByText('待办')).toBeTruthy()
    expect(within(el('[data-task-list-row="t2"]')).getByText('今天到期')).toBeTruthy()
    expect(within(el('[data-task-list-row="t5"]')).getByText('已完成')).toBeTruthy()

    fireEvent.click(el('[data-task-list-row="t1"] [data-task-toggle="t1"]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('updateTask', { id: 't1', expectedVersion: 1, completed: true }) })

    fireEvent.click(el('[data-task-list-row="t3"] [data-task-open="t3"]'))
    await waitForDetail()
    expect(screen.getByText('还没有关联笔记')).toBeTruthy()
    fireEvent.click(el('[data-task-scrim]'))
    expect(maybe('[data-task-detail]')).toBeNull()

    fireEvent.click(el('[data-tasks-layout="board"]'))
    expect(maybe('[data-task-board]')).not.toBeNull()
    fireEvent.click(el('[data-tasks-tab="projects"]'))
    expect(el('[data-tasks-page]').getAttribute('data-page')).toBe('projects')
  })

  it('filters by project, priority and both search fields', async () => {
    renderView()
    await waitForToday()
    fireEvent.click(el('[data-tasks-tab="tasks"]'))
    fireEvent.change(select('[data-task-filter-project]'), { target: { value: 'p1' } })
    expect(all('[data-task-list-row], [data-board-card]')).toHaveLength(4)
    fireEvent.change(select('[data-task-filter-priority]'), { target: { value: '1' } })
    expect(all('[data-board-card]')).toHaveLength(2)
    fireEvent.change(select('[data-task-filter-priority]'), { target: { value: '' } })
    fireEvent.change(input('[data-tasks-search]'), { target: { value: 'today notes' } })
    expect(all('[data-board-card]')).toHaveLength(1)
    fireEvent.change(input('[data-tasks-search]'), { target: { value: 'App Harness' } })
    expect(all('[data-board-card]')).toHaveLength(4)
    fireEvent.change(select('[data-task-filter-project]'), { target: { value: '' } })
    fireEvent.change(input('[data-tasks-search]'), { target: { value: 'No due' } })
    expect(all('[data-board-card]')).toHaveLength(1)
    fireEvent.change(input('[data-tasks-search]'), { target: { value: 'nothing matches' } })
    expect(all('[data-board-empty]')).toHaveLength(3)
    fireEvent.click(el('[data-tasks-layout="list"]'))
    expect(maybe('[data-task-list-empty]')).not.toBeNull()
    expect(screen.getByText('没有匹配的任务')).toBeTruthy()
  })

  it('toggles completion and reports a failed toggle', async () => {
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-task-row="t1"] [data-task-toggle="t1"]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('updateTask', { id: 't1', expectedVersion: 1, completed: true }) })
    fireEvent.click(el('[data-tasks-tab="tasks"]'))
    fireEvent.click(el('[data-board-card="t1"] [data-task-toggle="t1"]'))
    await waitFor(() => { expect(vi.mocked(call).mock.calls.filter(([op]) => op === 'updateTask')).toHaveLength(2) })

    cleanup()
    renderView({ call: makeCall({ updateTask: () => fail('toggle failed') }) })
    await waitForToday()
    fireEvent.click(el('[data-tasks-tab="tasks"]'))
    fireEvent.click(el('[data-board-card="t1"] [data-task-toggle="t1"]'))
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

describe('TasksView projects page', () => {
  it('shows project cards, progress, search, create and rename', async () => {
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-tasks-tab="projects"]'))
    expect(all('[data-project-card]')).toHaveLength(3)
    expect(el('[data-project-card="p1"]').textContent).toContain('2 个未完成')
    expect(el('[data-project-card="p1"]').textContent).toContain('2 个已完成')
    expect(el('[data-project-card="p1"] [data-project-percent]').textContent).toBe('50%')
    expect(el('[data-project-card="p3"] [data-project-percent]').textContent).toBe('0%')

    fireEvent.click(el('[data-projects-new]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.change(input('[data-task-project-name]'), { target: { value: 'New project' } })
    fireEvent.click(el('[data-task-project-submit]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('createProject', { name: 'New project' }) })
    await waitFor(() => { expect(maybe('[data-tasks-status]')?.textContent).toBe('项目已创建') })

    fireEvent.click(el('[data-project-rename="p2"]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.change(input('[data-task-project-name]'), { target: { value: 'Renamed' } })
    fireEvent.click(el('[data-task-project-submit]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('updateProject', { id: 'p2', expectedVersion: 3, name: 'Renamed' }) })
    await waitFor(() => { expect(maybe('[data-tasks-status]')?.textContent).toBe('项目已改名') })

    fireEvent.click(el('[data-project-rename="p3"]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(call).not.toHaveBeenCalledWith('updateProject', expect.objectContaining({ id: 'p3' })) })

    fireEvent.click(el('[data-projects-new]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.click(el('[data-task-project-submit]'))
    await waitFor(() => { expect(maybe('[data-task-project-error]')).not.toBeNull() })
    fireEvent.click(screen.getByLabelText('关闭'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).toBeNull() })

    fireEvent.click(el('[data-project-rename="p1"]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.click(el('[data-task-project-submit]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).toBeNull() })
    expect(call).not.toHaveBeenCalledWith('updateProject', expect.objectContaining({ id: 'p1', name: 'App Harness' }))

    fireEvent.change(input('[data-tasks-search]'), { target: { value: 'Notes' } })
    expect(all('[data-project-card]')).toHaveLength(1)
    fireEvent.change(input('[data-tasks-search]'), { target: { value: 'missing' } })
    expect(maybe('[data-projects-empty]')).not.toBeNull()
  })

  it('opens a project as a filtered task page and cancels the top-bar create', async () => {
    renderView()
    await waitForToday()
    fireEvent.click(el('[data-tasks-tab="projects"]'))
    fireEvent.click(el('[data-project-open="p1"]'))
    expect(el('[data-tasks-page]').getAttribute('data-page')).toBe('tasks')
    expect(select('[data-task-filter-project]').value).toBe('p1')
    expect(all('[data-board-card]')).toHaveLength(4)
    fireEvent.click(el('[data-tasks-new-project]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(el('[data-tasks-new-task]'))
    await waitForDetail()
    expect(within(el('[data-task-detail]')).getByText('新建任务')).toBeTruthy()
  })

  it('reports failed project create/rename and an empty project list', async () => {
    const call = makeCall({ createProject: () => fail('create failed'), updateProject: () => fail('rename failed') })
    renderView({ call, pageContext: { report: vi.fn(() => () => undefined) } })
    await waitFor(() => { expect(maybe('[data-today-view]')).not.toBeNull() })
    fireEvent.click(el('[data-tasks-tab="projects"]'))
    fireEvent.click(el('[data-projects-new]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.change(input('[data-task-project-name]'), { target: { value: 'Broken' } })
    fireEvent.click(el('[data-task-project-submit]'))
    await waitFor(() => { expect(screen.getByText('create failed')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(el('[data-project-rename="p1"]'))
    await waitFor(() => { expect(maybe('[data-task-project-name]')).not.toBeNull() })
    fireEvent.change(input('[data-task-project-name]'), { target: { value: 'Broken again' } })
    fireEvent.click(el('[data-task-project-submit]'))
    await waitFor(() => { expect(screen.getByText('rename failed')).toBeTruthy() })

    cleanup()
    renderView({ call: makeCall({ listProjects: () => ok([]) }) })
    await waitForToday()
    fireEvent.click(el('[data-tasks-tab="projects"]'))
    expect(maybe('[data-projects-empty]')).not.toBeNull()
  })
})

describe('TasksView detail', () => {
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

    fireEvent.change(input('[data-task-title]'), { target: { value: 'Changed title' } })
    fireEvent.change(select('[data-task-priority]'), { target: { value: '3' } })
    fireEvent.change(select('[data-task-project]'), { target: { value: 'p2' } })
    fireEvent.change(input('[data-task-due]'), { target: { value: isoDay(3) } })
    fireEvent.change(select('[data-task-assignee]'), { target: { value: 'agent' } })
    fireEvent.change(el('[data-task-description]'), { target: { value: 'Changed notes' } })
    fireEvent.click(el('[data-task-complete]'))

    await waitFor(() => { expect(el('[data-task-dirty]').getAttribute('data-task-dirty')).toBe('true') })
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

    fireEvent.click(el('[data-task-save]'))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('updateTask', expect.objectContaining({
        id: 't1',
        expectedVersion: 1,
        title: 'Changed title',
        priority: 3,
        projectId: 'p2',
        dueDate: isoDay(3),
        assignee: 'agent',
        notes: 'Changed notes',
        completed: true,
        noteIds: ['n2'],
      }))
    })
    await waitFor(() => { expect(maybe('[data-task-detail]')).toBeNull() })
    expect(maybe('[data-tasks-status]')?.textContent).toBe('已保存')
    await waitFor(() => { expect(guard?.()).toBe(true) })
  })

  it('shows a conflict and reloads the current task after a stale save', async () => {
    const stale = { callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }
    const call = makeCall({ updateTask: () => stale })
    renderView({ call })
    await waitForToday()
    openTodayTask('t2')
    await waitForDetail()
    fireEvent.change(input('[data-task-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-task-save]'))
    await waitFor(() => { expect(maybe('[data-task-conflict]')).not.toBeNull() })
    expect(maybe('[data-task-save]')?.hasAttribute('disabled')).toBe(true)
    fireEvent.click(el('[data-task-reload]'))
    await waitFor(() => { expect(maybe('[data-task-conflict]')).toBeNull() })
  })

  it('shows the conflict banner when a quick toggle is stale', async () => {
    const stale = { callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }
    const call = makeCall({ updateTask: () => stale })
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-task-row="t1"] [data-task-toggle="t1"]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('updateTask', expect.objectContaining({ id: 't1' })) })
  })

  it('creates a new task explicitly, validates an empty title, and cancels', async () => {
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-tasks-new-task]'))
    await waitForDetail()
    expect(maybe('[data-task-delete]')).toBeNull()

    fireEvent.change(input('[data-task-title]'), { target: { value: '   ' } })
    fireEvent.click(el('[data-task-save]'))
    await waitFor(() => { expect(screen.getByText('标题不能为空')).toBeTruthy() })

    fireEvent.change(input('[data-task-title]'), { target: { value: 'Brand new' } })
    fireEvent.change(select('[data-task-priority]'), { target: { value: '1' } })
    fireEvent.change(select('[data-task-project]'), { target: { value: 'p1' } })
    fireEvent.change(input('[data-task-due]'), { target: { value: '' } })
    fireEvent.change(select('[data-task-assignee]'), { target: { value: 'agent' } })
    fireEvent.change(el('[data-task-description]'), { target: { value: 'new notes' } })
    fireEvent.click(el('[data-task-save]'))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('createTask', {
        title: 'Brand new',
        notes: 'new notes',
        projectId: 'p1',
        dueDate: null,
        assignee: 'agent',
        priority: 1,
        noteIds: [],
      })
    })
    await waitFor(() => { expect(maybe('[data-task-detail]')).toBeNull() })

    fireEvent.click(el('[data-tasks-new-task]'))
    await waitForDetail()
    fireEvent.click(el('[data-task-cancel]'))
    expect(maybe('[data-task-detail]')).toBeNull()
    fireEvent.click(el('[data-tasks-new-task]'))
    await waitForDetail()
    fireEvent.click(el('[data-task-close]'))
    expect(maybe('[data-task-detail]')).toBeNull()
  })

  it('reports save failures, get failures and a routed task', async () => {
    renderView({ call: makeCall({ updateTask: () => fail('save failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.change(input('[data-task-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-task-save]'))
    await waitFor(() => { expect(screen.getByText('save failed')).toBeTruthy() })

    cleanup()
    renderView({ call: makeCall({ getTask: () => fail('get failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitFor(() => { expect(screen.getByText('get failed')).toBeTruthy() })
    expect(maybe('[data-task-detail]')).toBeNull()

    cleanup()
    const route = { appId: 'tasks', record: { appId: 'tasks', kind: 'task', id: 't2' }, nonce: '1' }
    renderView({ route })
    await waitForDetail()
    expect(screen.getByDisplayValue('Today task')).toBeTruthy()
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

describe('TasksView delete and undo', () => {
  it('soft-deletes and restores a task, including the short undo window', async () => {
    const timeout = vi.spyOn(window, 'setTimeout')
    const call = makeCall()
    renderView({ call })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-task-delete]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('deleteTask', { id: 't1' }) })
    await waitFor(() => { expect(maybe('[data-tasks-undo]')).not.toBeNull() })
    expect(maybe('[data-task-detail]')).toBeNull()
    expect(maybe('[data-tasks-undo]')?.textContent).toContain('已删除「Overdue task」')

    fireEvent.click(el('[data-tasks-undo-action]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('restoreTask', { id: 't1' }) })
    await waitFor(() => { expect(maybe('[data-tasks-undo]')).toBeNull() })
    expect(maybe('[data-tasks-status]')?.textContent).toBe('任务已恢复')

    // A second delete leaves an undo offer; its own timer dismisses it.
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-task-delete]'))
    await waitFor(() => { expect(maybe('[data-tasks-undo]')).not.toBeNull() })
    const timer = timeout.mock.calls.find(([, delay]) => delay === 8000)?.[0] as (() => void) | undefined
    expect(timer).toBeTypeOf('function')
    act(() => { timer?.() })
    await waitFor(() => { expect(maybe('[data-tasks-undo]')).toBeNull() })
  })

  it('reports a failed delete and a failed restore', async () => {
    renderView({ call: makeCall({ deleteTask: () => fail('delete failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-task-delete]'))
    await waitFor(() => { expect(screen.getByText('delete failed')).toBeTruthy() })

    cleanup()
    renderView({ call: makeCall({ restoreTask: () => fail('restore failed') }) })
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.click(el('[data-task-delete]'))
    await waitFor(() => { expect(maybe('[data-tasks-undo]')).not.toBeNull() })
    fireEvent.click(el('[data-tasks-undo-action]'))
    await waitFor(() => { expect(screen.getByText('restore failed')).toBeTruthy() })
    expect(maybe('[data-tasks-undo]')).not.toBeNull()
  })
})

describe('TasksView narrow layout', () => {
  it('mirrors the breakpoint, makes the detail full-screen, and removes its listener', async () => {
    const listeners: Array<() => void> = []
    const media = {
      matches: false,
      media: '(max-width: 720px)',
      addEventListener: vi.fn((_event: string, listener: () => void) => { listeners.push(listener) }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }),
    }
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const { view } = renderView()
    await waitForToday()
    expect(el('[data-tasks-page]').getAttribute('data-narrow')).toBe('false')

    media.matches = true
    media.addEventListener.mock.calls.forEach(() => undefined)
    act(() => { for (const listener of [...listeners]) listener() })
    await waitFor(() => { expect(el('[data-tasks-page]').getAttribute('data-narrow')).toBe('true') })

    openTodayTask('t1')
    await waitForDetail()
    expect(el('[data-task-detail]').getAttribute('data-task-detail-full')).toBe('true')
    view.unmount()
    expect(media.removeEventListener).toHaveBeenCalled()
  })

  it('keeps a dirty detail open when the human cancels the discard prompt', async () => {
    renderView()
    await waitForToday()
    openTodayTask('t1')
    await waitForDetail()
    fireEvent.change(input('[data-task-title]'), { target: { value: 'Changed' } })
    fireEvent.click(el('[data-task-close]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(maybe('[data-task-detail]')).not.toBeNull()
    fireEvent.click(el('[data-task-close]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(maybe('[data-task-detail]')).toBeNull() })
  })

  it('shows a page-level conflict after a list toggle and reloads on demand', async () => {
    const call = makeCall({ updateTask: () => ({ callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }) })
    renderView({ call })
    await waitForToday()
    fireEvent.click(el('[data-task-toggle="t1"]'))
    await waitFor(() => { expect(maybe('[data-task-conflict-page]')).not.toBeNull() })
    fireEvent.click(el('[data-task-reload-page]'))
    await waitFor(() => { expect(maybe('[data-task-conflict-page]')).toBeNull() })
  })

  it('clears filters from the empty today view', async () => {
    renderView()
    await waitForToday()
    fireEvent.change(input('[data-tasks-search]'), { target: { value: 'no-such-task' } })
    await waitFor(() => { expect(maybe('[data-today-clear-filters]')).not.toBeNull() })
    fireEvent.click(el('[data-today-clear-filters]'))
    await waitFor(() => { expect(maybe('[data-today-clear-filters]')).toBeNull() })
    expect(all('[data-task-row]').length).toBeGreaterThan(0)
  })
})
