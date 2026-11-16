// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { CalendarPage, CalendarView } from '../src/client/CalendarView.tsx'
import { apply as clientApply } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

interface FixtureEvent {
  id: string
  title: string
  description: string
  location: string
  time:
    | { kind: 'timed'; start: string; end: string; timeZone: string }
    | { kind: 'allDay'; startDate: string; endDateExclusive: string }
  color: 'blue' | 'green' | 'amber' | 'purple' | 'gray'
  version: number
}

const review: FixtureEvent = {
  id: 'e1',
  title: 'Review',
  description: 'Confirm the boundary',
  location: 'Room A',
  time: { kind: 'timed', start: '2026-11-05T01:00:00.000Z', end: '2026-11-05T02:00:00.000Z', timeZone: 'Asia/Shanghai' },
  color: 'blue',
  version: 3,
}

const offsite: FixtureEvent = {
  id: 'e2',
  title: 'Offsite',
  description: '',
  location: '',
  time: { kind: 'allDay', startDate: '2026-11-07', endDateExclusive: '2026-11-09' },
  color: 'green',
  version: 1,
}

const allDayToday: FixtureEvent = {
  id: 'e3',
  title: 'All day today',
  description: '',
  location: '',
  time: { kind: 'allDay', startDate: '2026-11-05', endDateExclusive: '2026-11-06' },
  color: 'gray',
  version: 1,
}

const busy: FixtureEvent[] = Array.from({ length: 4 }, (_, index) => ({
  id: `b${String(index + 1)}`,
  title: `Busy ${String(index + 1)}`,
  description: '',
  location: '',
  time: {
    kind: 'timed' as const,
    start: `2026-11-10T0${String(index + 1)}:00:00.000Z`,
    end: `2026-11-10T0${String(index + 2)}:00:00.000Z`,
    timeZone: 'Asia/Shanghai',
  },
  color: 'purple' as const,
  version: 1,
}))

const deadlines = [
  { id: 't1', title: 'Task A', dueDate: '2026-11-05' },
  { id: 't2', title: 'Task B', dueDate: '2026-11-06' },
]

function ok(value: unknown) {
  return { callId: 'c', status: 'success' as const, result: value }
}

function failed(message: string, code = 'failed') {
  return { callId: 'c', status: 'failed' as const, error: { code: `app.${code}`, message } }
}

function cancelled() {
  return { callId: 'c', status: 'cancelled' as const }
}

function defaultCall(events: FixtureEvent[] = [review, offsite, allDayToday, ...busy], tasks = deadlines, available = true) {
  return vi.fn(async (op: string, args?: Record<string, unknown>) => {
    if (op === 'listEvents') return ok({ events, total: events.length })
    if (op === 'listTaskDeadlines') return ok({ tasks, available })
    if (op === 'createEvent') return ok({ ...review, id: 'e_new', version: 1 })
    if (op === 'updateEvent') return ok({ ...(args as { id?: string }), version: 4 })
    if (op === 'deleteEvent') return ok({ ...review, deletedAt: 1 })
    if (op === 'restoreEvent') return ok(review)
    return ok({})
  }) as unknown as ApplicationViewProps['call']
}

function props(call: ApplicationViewProps['call'] = defaultCall(), overrides: Partial<ApplicationViewProps> = {}): ApplicationViewProps {
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

function translate(dictionary: Record<string, string>, key: string, params?: Record<string, unknown>): string {
  const template = dictionary[key] ?? key
  if (params === undefined) return template
  return Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), template)
}

const t = (key: string, params?: Record<string, unknown>): string => translate(zh, key, params)
const tEn = (key: string, params?: Record<string, unknown>): string => translate(en, key, params)

function renderView(p: ApplicationViewProps = props(), options: { language?: string; today?: string } = {}) {
  return render(<CalendarView {...p} t={t} today={options.today ?? '2026-11-05'} language={options.language ?? 'zh'} />)
}

function element<T extends Element>(container: HTMLElement, selector: string): T {
  const found = container.querySelector(selector)
  if (found === null) throw new Error(`missing ${selector}`)
  return found as T
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.innerWidth = 1024
})

describe('registration and locale binding', () => {
  it('registers the dictionary, the page and the host no-op plugin', () => {
    const registerDictionary = vi.fn(() => vi.fn())
    const unregister = vi.fn()
    const registerView = vi.fn((..._args: unknown[]) => unregister)
    const ctx = {
      locale: { register: registerDictionary, bind: () => t },
      applicationViews: { register: registerView },
      effect: (fn: () => unknown) => { fn(); return vi.fn() },
    } as never
    clientApply(ctx)
    expect(registerDictionary).toHaveBeenCalledWith('calendar', { zh, en: expect.any(Object) })
    expect(registerView).toHaveBeenCalledWith('calendar', expect.any(Object))
    const view = registerView.mock.calls[0]?.[1] as {
      contentLayout: string
      name: () => string
      description: () => string
      Component: (props: unknown) => unknown
    }
    expect(view.contentLayout).toBe('fill')
    expect(view.name()).toBe('日历')
    expect(view.description()).toBe('事件、月视图、议程与任务截止。')
    expect(view.Component({})).toBeTruthy()
    expect(hostApply()).toBeUndefined()
  })

  it('binds the locale in the registered page wrapper', async () => {
    const snapshot = { active: 'zh' }
    const subscribe = vi.fn(() => () => undefined)
    const getSnapshot = vi.fn(() => snapshot)
    const locale = { subscribe, getSnapshot, bind: () => t }
    const { container } = render(<CalendarPage {...props()} locale={locale as never} />)
    await waitFor(() => { expect(container.querySelector('[data-calendar-page]')).toBeTruthy() })
    expect(subscribe).toHaveBeenCalled()
    expect(getSnapshot).toHaveBeenCalled()
  })
})

describe('month view', () => {
  it('does not repeat a timed event on the day it ends at midnight', async () => {
    const late: FixtureEvent = {
      id: 'late', title: 'Late', description: '', location: '',
      time: { kind: 'timed', start: '2026-11-10T15:00:00.000Z', end: '2026-11-10T16:00:00.000Z', timeZone: 'Asia/Shanghai' },
      color: 'blue', version: 1,
    }
    const { container } = renderView(props(defaultCall([late])))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    expect(container.querySelector('[data-calendar-day="2026-11-10"] [data-calendar-event="late"]')).toBeTruthy()
    expect(container.querySelector('[data-calendar-day="2026-11-11"] [data-calendar-event="late"]')).toBeNull()
  })

  it('renders events, deadlines, overflow and the overlay switch', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    expect(container.querySelectorAll('[data-calendar-day]')).toHaveLength(42)
    expect(container.querySelector('[data-calendar-day="2026-11-05"] [data-calendar-event="e1"]')).toBeTruthy()
    expect(container.querySelector('[data-calendar-day="2026-11-05"] [data-calendar-task-chip="t1"]')).toBeTruthy()
    expect(container.querySelector('[data-calendar-day="2026-11-10"] [data-calendar-more]')).toBeTruthy()
    expect(container.querySelectorAll('[data-calendar-day="2026-11-10"] [data-calendar-event]')).toHaveLength(3)
    fireEvent.click(element(container, '[data-calendar-day="2026-11-10"] [data-calendar-more]'))
    expect(container.querySelector('[data-calendar-drawer]')).toBeNull()
    fireEvent.click(element(container, '[data-calendar-task-chip="t1"]'))
    expect(container.querySelector('[data-calendar-drawer]')).toBeNull()

    const toggle = element<HTMLButtonElement>(container, '[data-calendar-task-toggle]')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('[data-calendar-task-chip]')).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => { expect(container.querySelector('[data-calendar-task-chip="t1"]')).toBeTruthy() })
    expect(container.querySelector('[data-calendar-legend]')).toBeTruthy()
  })

  it('navigates months, returns today, switches views and reloads on change', async () => {
    const call = defaultCall()
    let listener: (() => void) | undefined
    const onChanged = vi.fn((fn: () => void) => { listener = fn; return () => undefined })
    const pageContext = { report: vi.fn(() => () => undefined) }
    const { container } = renderView(props(call, { onChanged, pageContext }))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    const listCalls = () => (call as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } }).mock.calls.filter(([op]) => op === 'listEvents')
    const first = listCalls().at(-1)![1]
    expect(first).toMatchObject({ fromDate: '2026-10-26', toDate: '2026-12-07' })
    expect(pageContext.report).toHaveBeenCalled()

    fireEvent.click(element(container, '[data-calendar-next]'))
    await waitFor(() => { expect(listCalls().at(-1)?.[1].fromDate).toBe('2026-11-30') })
    fireEvent.click(element(container, '[data-calendar-prev]'))
    await waitFor(() => { expect(listCalls().at(-1)?.[1].fromDate).toBe('2026-10-26') })
    fireEvent.click(element(container, '[data-calendar-next]'))
    await waitFor(() => { expect(listCalls().at(-1)?.[1].fromDate).toBe('2026-11-30') })
    fireEvent.click(element(container, '[data-calendar-today]'))
    await waitFor(() => { expect(listCalls().at(-1)?.[1].fromDate).toBe('2026-10-26') })

    fireEvent.click(screen.getByRole('tab', { name: '议程' }))
    await waitFor(() => { expect(container.querySelector('[data-calendar-agenda]')).toBeTruthy() })
    expect(container.querySelector('[data-calendar-agenda-day="2026-11-05"] [data-calendar-event="e1"]')).toBeTruthy()
    expect(container.querySelector('[data-calendar-agenda-day="2026-11-05"] [data-calendar-task-item="t1"]')).toBeTruthy()
    expect(container.querySelector('[data-calendar-agenda-day="2026-11-07"]')).toBeTruthy()
    fireEvent.click(element(container, '[data-calendar-agenda] [data-calendar-event="e1"]'))
    expect(container.querySelector('[data-calendar-drawer]')).toBeTruthy()
    fireEvent.click(element(container, '[data-calendar-cancel]'))
    fireEvent.click(screen.getByRole('tab', { name: '月' }))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })

    const before = listCalls().length
    listener?.()
    await waitFor(() => { expect(listCalls().length).toBeGreaterThan(before) })
  })

  it('shows an empty month and hides the read-only legend when the overlay is off', async () => {
    const call = defaultCall([], [], true)
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-empty]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-task-toggle]'))
    expect(container.querySelector('[data-calendar-legend]')).toBeTruthy()
  })

  it('renders English month labels and weekday headers', async () => {
    const { container } = render(
      <CalendarView {...props()} t={tEn} today="2026-11-05" language="en" />,
    )
    await waitFor(() => { expect(screen.getByText('November 2026')).toBeTruthy() })
    expect(screen.getByText('Mon')).toBeTruthy()
    expect(container.querySelector('[data-calendar-month]')).toBeTruthy()
  })
})

describe('agenda and narrow layout', () => {
  it('groups the next 14 days and shows the empty state', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('tab', { name: '议程' }))
    await waitFor(() => { expect(container.querySelector('[data-calendar-agenda]')).toBeTruthy() })
    expect(container.querySelector('[data-calendar-agenda-day="2026-11-05"]')?.textContent).toContain('今天')
    expect(container.querySelector('[data-calendar-agenda-day="2026-11-06"]')?.textContent).not.toContain('今天')
    expect(container.querySelector('[data-calendar-agenda-day="2026-11-07"]')?.textContent).toContain('Offsite')
    expect(container.textContent).toContain('Task A')

    cleanup()
    const empty = defaultCall([], [], true)
    const rendered = renderView(props(empty))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-month]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('tab', { name: '议程' }))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-empty]')).toBeTruthy() })
    expect(rendered.container.textContent).toContain('接下来没有安排')
  })

  it('defaults to agenda on a narrow viewport and reacts to resize', async () => {
    window.innerWidth = 390
    const { container } = renderView(props())
    await waitFor(() => { expect(container.querySelector('[data-calendar-agenda]')).toBeTruthy() })
    expect(container.querySelector('[data-calendar-month]')).toBeNull()
    expect(screen.queryByRole('tab', { name: '月' })).toBeNull()

    window.innerWidth = 1024
    fireEvent(window, new Event('resize'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    expect(screen.getByRole('tab', { name: '月' })).toBeTruthy()
  })
})

describe('event detail', () => {
  it('edits and saves a timed event', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-event="e1"]'))
    expect(container.querySelector('[data-calendar-drawer]')).toBeTruthy()
    const title = element<HTMLInputElement>(container, '[data-calendar-field="title"]')
    expect(title.value).toBe('Review')
    fireEvent.change(title, { target: { value: 'Review 2' } })
    fireEvent.change(element(container, '[data-calendar-field="start"]'), { target: { value: '2026-11-05T10:00' } })
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '2026-11-05T11:00' } })
    fireEvent.change(element(container, '[data-calendar-field="timeZone"]'), { target: { value: 'UTC' } })
    fireEvent.change(element(container, '[data-calendar-field="location"]'), { target: { value: 'Room B' } })
    fireEvent.change(element(container, '[data-calendar-field="color"]'), { target: { value: 'amber' } })
    fireEvent.change(element(container, '[data-calendar-field="description"]'), { target: { value: 'Updated notes' } })
    fireEvent.click(element(container, '[data-calendar-save]'))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('updateEvent', expect.objectContaining({
        id: 'e1',
        expectedVersion: 3,
        title: 'Review 2',
        description: 'Updated notes',
        location: 'Room B',
        color: 'amber',
        time: { kind: 'timed', start: '2026-11-05T10:00:00.000Z', end: '2026-11-05T11:00:00.000Z', timeZone: 'UTC' },
      }))
    })
    await waitFor(() => { expect(container.querySelector('[data-calendar-drawer]')).toBeNull() })
  })

  it('refuses a local time that does not exist in the selected zone', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-new]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-new]'))
    fireEvent.change(element(container, '[data-calendar-field="title"]'), { target: { value: 'Gap' } })
    fireEvent.change(element(container, '[data-calendar-field="start"]'), { target: { value: '2026-03-08T02:30' } })
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '2026-03-08T04:00' } })
    fireEvent.change(element(container, '[data-calendar-field="timeZone"]'), { target: { value: 'America/New_York' } })
    fireEvent.click(element(container, '[data-calendar-save]'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-form-error]')).toBeTruthy() })
    expect(call).not.toHaveBeenCalledWith('createEvent', expect.anything())
  })

  it('edits an all-day event and toggles all-day on a new draft', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-event="e2"]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-event="e2"]'))
    const start = element<HTMLInputElement>(container, '[data-calendar-field="start"]')
    expect(start.type).toBe('date')
    const allDayToggle = element<HTMLInputElement>(container, '[data-calendar-field="allDay"]')
    fireEvent.click(allDayToggle)
    expect(element<HTMLInputElement>(container, '[data-calendar-field="start"]').type).toBe('datetime-local')
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '2026-11-09T10:00' } })
    fireEvent.click(allDayToggle)
    expect(element<HTMLInputElement>(container, '[data-calendar-field="start"]').type).toBe('date')
    expect(element<HTMLInputElement>(container, '[data-calendar-field="end"]').value).toBe('2026-11-09')
    fireEvent.change(element(container, '[data-calendar-field="start"]'), { target: { value: '2026-11-08' } })
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '2026-11-10' } })
    fireEvent.click(element(container, '[data-calendar-save]'))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('updateEvent', expect.objectContaining({
        id: 'e2',
        time: { kind: 'allDay', startDate: '2026-11-08', endDateExclusive: '2026-11-10' },
      }))
    })
    await waitFor(() => { expect(container.querySelector('[data-calendar-drawer]')).toBeNull() })

    fireEvent.click(element(container, '[data-calendar-new]'))
    const allDay = element<HTMLInputElement>(container, '[data-calendar-field="allDay"]')
    fireEvent.click(allDay)
    expect(element<HTMLInputElement>(container, '[data-calendar-field="start"]').type).toBe('date')
    expect(element<HTMLInputElement>(container, '[data-calendar-field="end"]').value).toBe('2026-11-06')
    fireEvent.click(allDay)
    expect(element<HTMLInputElement>(container, '[data-calendar-field="start"]').type).toBe('datetime-local')
  })

  it('validates new drafts and creates timed and all-day events', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-new]'))
    expect(element<HTMLInputElement>(container, '[data-calendar-field="start"]').value).toBe('2026-11-05T09:00')
    const save = element(container, '[data-calendar-save]')
    fireEvent.click(save)
    expect(container.querySelector('[data-calendar-form-error]')?.textContent).toContain('请填写标题')
    fireEvent.change(element(container, '[data-calendar-field="title"]'), { target: { value: 'New event' } })
    fireEvent.change(element(container, '[data-calendar-field="start"]'), { target: { value: '' } })
    fireEvent.click(save)
    expect(container.querySelector('[data-calendar-form-error]')?.textContent).toContain('结束时间必须晚于开始时间')
    fireEvent.change(element(container, '[data-calendar-field="start"]'), { target: { value: '2026-11-05T09:00' } })
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '' } })
    fireEvent.click(save)
    expect(container.querySelector('[data-calendar-form-error]')?.textContent).toContain('结束时间必须晚于开始时间')
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '2026-11-05T09:00' } })
    fireEvent.click(save)
    expect(container.querySelector('[data-calendar-form-error]')?.textContent).toContain('结束时间必须晚于开始时间')
    expect(call).not.toHaveBeenCalledWith('createEvent', expect.anything())
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '2026-11-05T10:00' } })
    fireEvent.click(save)
    await waitFor(() => { expect(call).toHaveBeenCalledWith('createEvent', expect.objectContaining({ title: 'New event', time: expect.objectContaining({ kind: 'timed' }) })) })

    fireEvent.click(element(container, '[data-calendar-new]'))
    fireEvent.click(element(container, '[data-calendar-field="allDay"]'))
    fireEvent.change(element(container, '[data-calendar-field="title"]'), { target: { value: 'All day' } })
    fireEvent.change(element(container, '[data-calendar-field="start"]'), { target: { value: '2026-11-12' } })
    fireEvent.change(element(container, '[data-calendar-field="end"]'), { target: { value: '2026-11-13' } })
    fireEvent.click(element(container, '[data-calendar-save]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('createEvent', expect.objectContaining({ title: 'All day', time: { kind: 'allDay', startDate: '2026-11-12', endDateExclusive: '2026-11-13' } })) })
  })

  it('opens a new event from a day cell and closes by cancel, close and backdrop', async () => {
    const { container } = renderView(props())
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-day-new="2026-11-12"]'))
    expect(element<HTMLInputElement>(container, '[data-calendar-field="start"]').value).toBe('2026-11-12T09:00')
    fireEvent.click(element(container, '[data-calendar-cancel]'))
    expect(container.querySelector('[data-calendar-drawer]')).toBeNull()

    fireEvent.click(element(container, '[data-calendar-new]'))
    fireEvent.click(element(container, '[data-calendar-close]'))
    expect(container.querySelector('[data-calendar-drawer]')).toBeNull()

    fireEvent.click(element(container, '[data-calendar-new]'))
    fireEvent.click(element(container, '[data-calendar-backdrop]'))
    expect(container.querySelector('[data-calendar-drawer]')).toBeNull()

    fireEvent.click(element(container, '[data-calendar-day="2026-11-12"]'))
    expect(element<HTMLInputElement>(container, '[data-calendar-field="start"]').value).toBe('2026-11-12T09:00')
    fireEvent.click(element(container, '[data-calendar-cancel]'))
  })

  it('reports stale-version and generic save failures', async () => {
    const call = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: [review], total: 1 })
      if (op === 'listTaskDeadlines') return ok({ tasks: [], available: true })
      if (op === 'updateEvent') return failed('changed', 'stale-version')
      return ok({})
    }) as unknown as ApplicationViewProps['call']
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-event="e1"]'))
    fireEvent.change(element(container, '[data-calendar-field="title"]'), { target: { value: 'Changed' } })
    fireEvent.click(element(container, '[data-calendar-save]'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-form-error]')?.textContent).toContain('事件已在别处修改') })
    fireEvent.click(element(container, '[data-calendar-cancel]'))

    const genericCall = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: [review], total: 1 })
      if (op === 'listTaskDeadlines') return ok({ tasks: [], available: true })
      if (op === 'updateEvent') return failed('boom')
      return ok({})
    }) as unknown as ApplicationViewProps['call']
    const rendered = renderView(props(genericCall))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(rendered.container, '[data-calendar-event="e1"]'))
    fireEvent.change(element(rendered.container, '[data-calendar-field="title"]'), { target: { value: 'Changed' } })
    fireEvent.click(element(rendered.container, '[data-calendar-save]'))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-form-error]')?.textContent).toContain('boom') })
  })

  it('falls back to the generic failure copy when a failure carries no message', async () => {
    const noMessage = () => ({ callId: 'c', status: 'failed' as const, error: { code: 'app.x', message: undefined as never } })
    const call = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: [review], total: 1 })
      if (op === 'listTaskDeadlines') return ok({ tasks: [], available: true })
      if (op === 'updateEvent' || op === 'deleteEvent' || op === 'restoreEvent') return noMessage()
      return ok({})
    }) as unknown as ApplicationViewProps['call']
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-event="e1"]'))
    fireEvent.change(element(container, '[data-calendar-field="title"]'), { target: { value: 'Changed' } })
    fireEvent.click(element(container, '[data-calendar-save]'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-form-error]')?.textContent).toContain('保存失败') })
    fireEvent.click(element(container, '[data-calendar-cancel]'))

    fireEvent.click(element(container, '[data-calendar-event="e1"]'))
    fireEvent.click(element(container, '[data-calendar-delete]'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-form-error]')?.textContent).toContain('保存失败') })

    cleanup()
    const restoreFailure = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: [review], total: 1 })
      if (op === 'listTaskDeadlines') return ok({ tasks: [], available: true })
      if (op === 'deleteEvent') return ok({ ...review, deletedAt: 1 })
      if (op === 'restoreEvent') return noMessage()
      return ok({})
    }) as unknown as ApplicationViewProps['call']
    const rendered = renderView(props(restoreFailure))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(rendered.container, '[data-calendar-event="e1"]'))
    fireEvent.click(element(rendered.container, '[data-calendar-delete]'))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-undo-button]')).toBeTruthy() })
    fireEvent.click(element(rendered.container, '[data-calendar-undo-button]'))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-update-error]')?.textContent).toContain('保存失败') })
  })

  it('deletes with undo, handles failures, and dismisses the toast', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-event="e1"]'))
    fireEvent.click(element(container, '[data-calendar-delete]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('deleteEvent', { id: 'e1' }) })
    await waitFor(() => { expect(container.querySelector('[data-calendar-undo]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-undo-dismiss]'))
    expect(container.querySelector('[data-calendar-undo]')).toBeNull()

    const failing = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: [review], total: 1 })
      if (op === 'listTaskDeadlines') return ok({ tasks: [], available: true })
      if (op === 'deleteEvent') return failed('delete failed')
      return ok({})
    }) as unknown as ApplicationViewProps['call']
    const rendered = renderView(props(failing))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(rendered.container, '[data-calendar-event="e1"]'))
    fireEvent.click(element(rendered.container, '[data-calendar-delete]'))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-form-error]')?.textContent).toContain('delete failed') })
    expect(rendered.container.querySelector('[data-calendar-drawer]')).toBeTruthy()
  })

  it('restores a deleted event and surfaces a restore failure', async () => {
    const call = defaultCall()
    const { container } = renderView(props(call))
    await waitFor(() => { expect(container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-event="e1"]'))
    fireEvent.click(element(container, '[data-calendar-delete]'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-undo]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-undo-button]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('restoreEvent', { id: 'e1' }) })
    await waitFor(() => { expect(container.querySelector('[data-calendar-undo]')).toBeNull() })

    const failing = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: [review], total: 1 })
      if (op === 'listTaskDeadlines') return ok({ tasks: [], available: true })
      if (op === 'deleteEvent') return ok({ ...review, deletedAt: 1 })
      if (op === 'restoreEvent') return failed('restore failed')
      return ok({})
    }) as unknown as ApplicationViewProps['call']
    const rendered = renderView(props(failing))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-event="e1"]')).toBeTruthy() })
    fireEvent.click(element(rendered.container, '[data-calendar-event="e1"]'))
    fireEvent.click(element(rendered.container, '[data-calendar-delete]'))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-undo-button]')).toBeTruthy() })
    fireEvent.click(element(rendered.container, '[data-calendar-undo-button]'))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-update-error]')?.textContent).toContain('restore failed') })
  })
})

describe('loading, failures and the task overlay', () => {
  it('shows loading before the first result arrives', async () => {
    let resolveEvents: ((value: unknown) => void) | undefined
    const call = vi.fn((op: string) => {
      if (op === 'listEvents') return new Promise(resolve => { resolveEvents = resolve })
      return Promise.resolve(ok({ tasks: [], available: true }))
    }) as unknown as ApplicationViewProps['call']
    const { container } = renderView(props(call))
    expect(container.querySelector('[data-calendar-loading]')).toBeTruthy()
    await act(async () => { resolveEvents?.(ok({ events: [], total: 0 })) })
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
  })

  it('separates read failures from empty calendars and retries', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(failed('calendar down'))
      .mockResolvedValueOnce(ok({ tasks: [], available: true }))
      .mockResolvedValueOnce(ok({ events: [], total: 0 }))
      .mockResolvedValueOnce(ok({ tasks: [], available: true }))
    const { container } = renderView(props(call as unknown as ApplicationViewProps['call']))
    await waitFor(() => { expect(container.querySelector('[data-calendar-error]')?.textContent).toContain('calendar down') })
    fireEvent.click(element(container, '[data-calendar-retry]'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })

    const malformed = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: 'nope' })
      return ok({ tasks: [], available: true })
    }) as unknown as ApplicationViewProps['call']
    const rendered = renderView(props(malformed))
    await waitFor(() => { expect(rendered.container.querySelector('[data-calendar-error]')?.textContent).toContain('读取日历失败') })

    const cancelledCall = vi.fn(async (op: string) => {
      if (op === 'listEvents') return cancelled()
      return ok({ tasks: [], available: true })
    }) as unknown as ApplicationViewProps['call']
    const cancelledView = renderView(props(cancelledCall))
    await waitFor(() => { expect(cancelledView.container.querySelector('[data-calendar-error]')?.textContent).toContain('读取日历失败') })
  })

  it('disables the deadline switch when tasks fail or report unavailable', async () => {
    const failingTasks = vi.fn(async (op: string) => {
      if (op === 'listEvents') return ok({ events: [review], total: 1 })
      return failed('tasks down')
    }) as unknown as ApplicationViewProps['call']
    const first = renderView(props(failingTasks))
    await waitFor(() => { expect(first.container.querySelector('[data-calendar-task-unavailable]')).toBeTruthy() })
    expect(element<HTMLButtonElement>(first.container, '[data-calendar-task-toggle]').disabled).toBe(true)
    expect(first.container.querySelector('[data-calendar-task-chip]')).toBeNull()

    cleanup()
    const unavailable = defaultCall([review], [], false)
    const second = renderView(props(unavailable))
    await waitFor(() => { expect(second.container.querySelector('[data-calendar-task-unavailable]')).toBeTruthy() })
    expect(element<HTMLButtonElement>(second.container, '[data-calendar-task-toggle]').disabled).toBe(true)
  })

  it('keeps the month when a refresh fails and retries from the update notice', async () => {
    let fail = false
    let notify!: () => void
    const call = vi.fn(async (op: string) => {
      if (op === 'listEvents') return fail ? failed('refresh down') : ok({ events: [review], total: 1 })
      return ok({ tasks: [], available: true })
    }) as unknown as ApplicationViewProps['call']
    const { container } = renderView(props(call, { onChanged: (listener) => { notify = listener; return () => undefined } }))
    await waitFor(() => { expect(element(container, '[data-calendar-month]')).toBeTruthy() })
    fail = true
    act(() => { notify() })
    await waitFor(() => { expect(container.querySelector('[data-calendar-update-error]')?.textContent).toContain('refresh down') })
    expect(container.querySelector('[data-calendar-month]')).toBeTruthy()
    fail = false
    fireEvent.click(element(container, '[data-calendar-update-error] [data-calendar-retry]'))
    await waitFor(() => { expect(container.querySelector('[data-calendar-update-error]')).toBeNull() })
  })

  it('asks before discarding a dirty event and honors stay or discard', async () => {
    const { container } = renderView()
    await waitFor(() => { expect(container.querySelector('[data-calendar-month]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-new]'))
    fireEvent.change(element(container, '[data-calendar-field="title"]'), { target: { value: 'Dirty event' } })
    fireEvent.click(element(container, '[data-calendar-cancel]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(document.querySelector('[data-confirm-dialog]')?.textContent).toContain('关闭后本次修改会丢失')
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-calendar-drawer]')).toBeTruthy() })
    fireEvent.click(element(container, '[data-calendar-cancel]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-calendar-drawer]')).toBeNull() })
  })
})
