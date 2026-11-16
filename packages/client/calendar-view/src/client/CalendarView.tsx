import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { EmptyState, TabBar, hasAppCode, useConfirm, useModalFocus, useUiChoice, useUiField } from '@matrix1001/dsh-application-harness-client-chrome'
import { type CalendarKey, NS } from './locales.ts'
import css from './CalendarView.module.css'

/** The translate face this page needs. */
export type CalendarTranslate = TranslateNS<'calendar'>

/** The props of the registered page. */
export interface CalendarPageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface CalendarViewProps extends ApplicationViewProps {
  t: CalendarTranslate
  /** Active locale id (`zh`, `en`, …), used for Intl formatting. */
  language?: string
  /** The client's local date; tests pin it, production reads the clock. */
  today?: string
}

type EventColor = 'blue' | 'green' | 'amber' | 'purple' | 'gray'

type EventTime =
  | { kind: 'timed'; start: string; end: string; timeZone: string }
  | { kind: 'allDay'; startDate: string; endDateExclusive: string }

interface CalendarEventRecord {
  id: string
  title: string
  description: string
  location: string
  time: EventTime
  color: EventColor
  version: number
}

interface TaskDeadline { id: string; title: string; dueDate: string }
interface TaskDeadlinesResult { tasks: TaskDeadline[]; available: boolean }

interface EditorDraft {
  id: string | undefined
  version: number
  title: string
  description: string
  location: string
  color: EventColor
  allDay: boolean
  start: string
  end: string
  timeZone: string
}

type Outcome = Awaited<ReturnType<ApplicationViewProps['call']>>
type Mode = 'month' | 'agenda'

const COLORS: readonly EventColor[] = ['blue', 'green', 'amber', 'purple', 'gray']
const COLOR_KEYS: Record<EventColor, CalendarKey> = {
  blue: 'view.color.blue',
  green: 'view.color.green',
  amber: 'view.color.amber',
  purple: 'view.color.purple',
  gray: 'view.color.gray',
}
const WEEKDAY_KEYS = [
  'view.weekdayShort.mon',
  'view.weekdayShort.tue',
  'view.weekdayShort.wed',
  'view.weekdayShort.thu',
  'view.weekdayShort.fri',
  'view.weekdayShort.sat',
  'view.weekdayShort.sun',
] as const

function valueOf<T>(outcome: Outcome): T | undefined {
  return outcome.status === 'success' ? outcome.result as T : undefined
}

function messageOf(outcome: Outcome): string | undefined {
  return outcome.status === 'success' || outcome.status === 'cancelled' ? undefined : outcome.error?.message
}

function pad(value: number): string { return String(value).padStart(2, '0') }

function dateKeyOf(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year!, month! - 1, day!, 12)
}

function addDays(key: string, days: number): string {
  const date = parseDateKey(key)
  date.setDate(date.getDate() + days)
  return dateKeyOf(date)
}

function startOfMonthGrid(anchor: string): string {
  const date = parseDateKey(anchor)
  const first = new Date(date.getFullYear(), date.getMonth(), 1, 12)
  const offset = (first.getDay() + 6) % 7
  return addDays(dateKeyOf(first), -offset)
}

function monthDays(anchor: string): string[] {
  const start = startOfMonthGrid(anchor)
  return Array.from({ length: 42 }, (_, index) => addDays(start, index))
}

function zonedDateKey(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: string): string => parts.find(candidate => candidate.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function zoneOffsetAt(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const part = (type: string): string => parts.find(candidate => candidate.type === type)!.value
  const local = Date.UTC(
    Number(part('year')), Number(part('month')) - 1, Number(part('day')),
    Number(part('hour')), Number(part('minute')), Number(part('second')),
  )
  return local - Math.floor(instant / 1000) * 1000
}

function zonedInputFromIso(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const part = (type: string): string => parts.find(candidate => candidate.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

function zonedInputToIso(value: string, timeZone: string): string {
  const [day, clock] = value.split('T')
  const [year, month, date] = day!.split('-').map(Number)
  const [hour, minute] = clock!.split(':').map(Number)
  const guess = Date.UTC(year!, month! - 1, date!, hour!, minute!)
  const first = guess - zoneOffsetAt(timeZone, guess)
  const second = guess - zoneOffsetAt(timeZone, first)
  return new Date(second).toISOString()
}

function formatDayLabel(key: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { month: 'long', day: 'numeric' }).format(parseDateKey(key))
}

function formatWeekday(key: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { weekday: 'short' }).format(parseDateKey(key))
}

function formatTime(instant: string, timeZone: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(instant))
}

function eventOnDay(event: CalendarEventRecord, key: string): boolean {
  if (event.time.kind === 'allDay') return event.time.startDate <= key && key < event.time.endDateExclusive
  const startKey = zonedDateKey(event.time.start, event.time.timeZone)
  const endKey = zonedDateKey(event.time.end, event.time.timeZone)
  if (key < startKey || key > endKey) return false
  // A timed event that ends at exactly 00:00 occupies the previous day only.
  if (key === endKey && endKey !== startKey) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: event.time.timeZone }).format(new Date(event.time.end)) !== '00:00'
  }
  return true
}

/** The `datetime-local` value one instant has in the event timezone. */
function zonedInputOf(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  }).formatToParts(new Date(iso))
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

function sortKey(event: CalendarEventRecord): string {
  return event.time.kind === 'allDay'
    ? `0|${event.time.startDate}|${event.time.endDateExclusive}|${event.id}`
    : `1|${event.time.start}|${event.time.end}|${event.id}`
}

function compareEvents(a: CalendarEventRecord, b: CalendarEventRecord): number {
  return sortKey(a).localeCompare(sortKey(b))
}

function whenLabel(event: CalendarEventRecord, t: CalendarTranslate, intlLocale: string): string {
  if (event.time.kind === 'allDay') return t('view.allDay')
  return `${formatTime(event.time.start, event.time.timeZone, intlLocale)}–${formatTime(event.time.end, event.time.timeZone, intlLocale)}`
}

function draftOf(event: CalendarEventRecord, localZone: string): EditorDraft {
  if (event.time.kind === 'allDay') {
    return {
      id: event.id,
      version: event.version,
      title: event.title,
      description: event.description,
      location: event.location,
      color: event.color,
      allDay: true,
      start: event.time.startDate,
      end: event.time.endDateExclusive,
      timeZone: localZone,
    }
  }
  return {
    id: event.id,
    version: event.version,
    title: event.title,
    description: event.description,
    location: event.location,
    color: event.color,
    allDay: false,
    start: zonedInputFromIso(event.time.start, event.time.timeZone),
    end: zonedInputFromIso(event.time.end, event.time.timeZone),
    timeZone: event.time.timeZone,
  }
}

function newDraft(day: string, localZone: string): EditorDraft {
  return {
    id: undefined,
    version: 0,
    title: '',
    description: '',
    location: '',
    color: 'blue',
    allDay: false,
    start: `${day}T09:00`,
    end: `${day}T10:00`,
    timeZone: localZone,
  }
}

function withAllDay(draft: EditorDraft, allDay: boolean): EditorDraft {
  if (allDay) {
    const start = draft.start.slice(0, 10)
    const end = draft.end.slice(0, 10)
    return { ...draft, allDay, start, end: start >= end ? addDays(start, 1) : end }
  }
  return { ...draft, allDay, start: `${draft.start.slice(0, 10)}T09:00`, end: `${draft.start.slice(0, 10)}T10:00` }
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 760)
  useEffect(() => {
    const update = (): void => { setNarrow(window.innerWidth <= 760) }
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('resize', update) }
  }, [])
  return narrow
}

/** The registered page: bind the dictionary and render the calendar body. */
export function CalendarPage({ locale, ...props }: CalendarPageProps) {
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <CalendarView {...props} t={locale.bind(NS)} language={snapshot.active} />
}

/**
 * The calendar page: a month grid (desktop) or a 14-day agenda (narrow), with a
 * read-only task-deadline overlay. The page speaks only through the shell's
 * `call` face; all writes are explicit and version-checked.
 */
export function CalendarView({
  call,
  running,
  onChanged,
  pageContext,
  t,
  language = 'zh',
  today = dateKeyOf(new Date()),
  ui,
}: CalendarViewProps) {
  const intlLocale = language.startsWith('en') ? 'en-US' : 'zh-CN'
  const localZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const narrow = useNarrow()
  const [view, setView] = useUiChoice<Mode>(ui, 'view', ['month', 'agenda'], 'month')
  const [anchor, setAnchor] = useUiField<string>(ui, 'anchor', today, (value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value))
  const [overlay, setOverlay] = useUiField<boolean>(ui, 'overlay', true, (value): value is boolean => typeof value === 'boolean')
  const [events, setEvents] = useState<CalendarEventRecord[]>([])
  const [deadlines, setDeadlines] = useState<TaskDeadline[]>([])
  const [tasksAvailable, setTasksAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [editor, setEditor] = useState<EditorDraft>()
  const [expandedDay, setExpandedDay] = useState<string>()
  const editorBaseline = useRef<string>()
  const [formError, setFormError] = useState<string>()
  const { confirm: confirmDiscard, dialog: confirmDialog } = useConfirm()
  const drawerRef = useRef<HTMLElement>(null)
  const [saving, setSaving] = useState(false)
  const [deleted, setDeleted] = useState<{ id: string; title: string }>()
  const [reloadToken, setReloadToken] = useState(0)
  const tRef = useRef(t)
  tRef.current = t

  const mode: Mode = narrow ? 'agenda' : view
  const monthStart = useMemo(() => startOfMonthGrid(anchor), [anchor])
  const range = useMemo(() => mode === 'month'
    ? { fromDate: monthStart, toDate: addDays(monthStart, 42), taskTo: addDays(monthStart, 41) }
    : { fromDate: today, toDate: addDays(today, 14), taskTo: addDays(today, 13) }, [mode, monthStart, today])
  const calendarDays = useMemo(() => monthDays(anchor), [anchor])
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { year: 'numeric', month: 'long' }).format(parseDateKey(anchor)),
    [anchor, intlLocale],
  )

  useEffect(() => {
    const run = async (): Promise<void> => {
      setLoading(true)
      const [eventOutcome, taskOutcome] = await Promise.all([
        call('listEvents', { fromDate: range.fromDate, toDate: range.toDate, timeZone: localZone }),
        call('listTaskDeadlines', { fromDate: range.fromDate, toDate: range.taskTo }),
      ])
      const result = valueOf<{ events?: CalendarEventRecord[] }>(eventOutcome)
      if (result === undefined || !Array.isArray(result.events)) {
        setError(messageOf(eventOutcome) ?? tRef.current('view.loadFailed'))
        setLoading(false)
        return
      }
      const overlayResult = valueOf<TaskDeadlinesResult>(taskOutcome)
      setEvents(result.events)
      setDeadlines(overlayResult?.tasks ?? [])
      setTasksAvailable(overlayResult?.available ?? false)
      setError(undefined)
      setLoading(false)
    }
    void run()
  }, [call, localZone, range.fromDate, range.toDate, range.taskTo, reloadToken])

  useEffect(() => onChanged(() => { setReloadToken(token => token + 1) }), [onChanged])

  useEffect(() => pageContext.report({
    label: t('app.name'),
    view: mode,
    visibleRange: { from: range.fromDate, to: addDays(range.toDate, -1) },
  }), [pageContext, t, mode, range.fromDate, range.toDate])

  const agendaDays = useMemo(() => {
    const days: Array<{ key: string; events: CalendarEventRecord[]; tasks: TaskDeadline[] }> = []
    for (let offset = 0; offset < 14; offset += 1) {
      const key = addDays(today, offset)
      const dayEvents = events.filter(event => eventOnDay(event, key)).sort(compareEvents)
      const dayTasks = overlay ? deadlines.filter(task => task.dueDate === key) : []
      if (dayEvents.length > 0 || dayTasks.length > 0) days.push({ key, events: dayEvents, tasks: dayTasks })
    }
    return days
  }, [deadlines, events, overlay, today])

  const shiftMonth = useCallback((delta: number) => {
    const date = parseDateKey(anchor)
    date.setDate(1)
    date.setMonth(date.getMonth() + delta)
    setAnchor(dateKeyOf(date))
  }, [anchor])

  const defaultNewDay = anchor.slice(0, 7) === today.slice(0, 7) ? today : anchor

  const openNew = useCallback((day: string) => {
    setDeleted(undefined)
    setFormError(undefined)
    const next = newDraft(day, localZone)
    editorBaseline.current = JSON.stringify(next)
    setEditor(next)
  }, [localZone])

  const openEvent = useCallback((event: CalendarEventRecord) => {
    setDeleted(undefined)
    setFormError(undefined)
    const next = draftOf(event, localZone)
    editorBaseline.current = JSON.stringify(next)
    setEditor(next)
  }, [localZone])

  const closeEditor = useCallback(() => {
    setEditor(undefined)
    editorBaseline.current = undefined
    setFormError(undefined)
  }, [])

  const requestCloseEditor = useCallback(() => {
    if (editor === undefined || editorBaseline.current === JSON.stringify(editor)) { closeEditor(); return }
    void confirmDiscard({
      title: t('view.confirmDiscard'),
      body: t('view.discardBody'),
      confirmLabel: t('view.discardConfirm'),
      cancelLabel: t('view.discardStay'),
      danger: true,
    }).then((discard) => { if (discard) closeEditor() })
  }, [closeEditor, confirmDiscard, editor, t])

  useModalFocus(editor !== undefined, drawerRef, requestCloseEditor)

  const save = useCallback(async (draft: EditorDraft) => {
    const title = draft.title.trim()
    if (title === '') { setFormError(t('view.titleRequired')); return }
    if (draft.start === '' || draft.end === '') { setFormError(t('view.timeInvalid')); return }
    if (draft.end <= draft.start) { setFormError(t('view.timeInvalid')); return }
    const startIso = draft.allDay ? undefined : zonedInputToIso(draft.start, draft.timeZone)
    const endIso = draft.allDay ? undefined : zonedInputToIso(draft.end, draft.timeZone)
    // A local time that does not exist (a DST spring-forward gap) would be
    // silently moved by the conversion. Refuse it instead of saving a
    // different moment than the one the user typed.
    if (!draft.allDay && (zonedInputOf(startIso!, draft.timeZone) !== draft.start.slice(0, 16) || zonedInputOf(endIso!, draft.timeZone) !== draft.end.slice(0, 16))) {
      setFormError(t('view.localTimeInvalid'))
      return
    }
    const time: EventTime = draft.allDay
      ? { kind: 'allDay', startDate: draft.start, endDateExclusive: draft.end }
      : {
        kind: 'timed',
        start: startIso!,
        end: endIso!,
        timeZone: draft.timeZone,
      }
    setFormError(undefined)
    setSaving(true)
    const outcome = draft.id === undefined
      ? await call('createEvent', {
        title, description: draft.description, location: draft.location, color: draft.color, time,
      })
      : await call('updateEvent', {
        id: draft.id, expectedVersion: draft.version,
        title, description: draft.description, location: draft.location, color: draft.color, time,
      })
    setSaving(false)
    if (valueOf<CalendarEventRecord>(outcome) === undefined) {
      if (hasAppCode(outcome, 'stale-version')) setFormError(t('view.staleVersion'))
      else setFormError(messageOf(outcome) ?? t('view.saveFailed'))
      return
    }
    setEditor(undefined)
    setReloadToken(token => token + 1)
  }, [call, t])

  const remove = useCallback(async (id: string, title: string) => {
    const outcome = await call('deleteEvent', { id })
    if (outcome.status !== 'success') { setFormError(messageOf(outcome) ?? t('view.saveFailed')); return }
    setEditor(undefined)
    setDeleted({ id, title })
    setReloadToken(token => token + 1)
  }, [call, t])

  const undo = useCallback(async (id: string) => {
    const outcome = await call('restoreEvent', { id })
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? t('view.saveFailed')); return }
    setDeleted(undefined)
    setReloadToken(token => token + 1)
  }, [call, t])

  const zoneOptions = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
    return [...new Set([localZone, ...(editor?.timeZone === undefined ? [] : [editor.timeZone]), ...supported, 'UTC'])]
  }, [editor?.timeZone, localZone])
  const anchorDate = parseDateKey(anchor)

  return (
    <div className={css.page} data-calendar-page>
      <div className={css.header}>
      <TabBar
        tabs={narrow
          ? [{ id: 'agenda', label: t('view.agenda'), anchor: { 'data-calendar-tab': 'agenda' } }]
          : [
            { id: 'month', label: t('view.month'), anchor: { 'data-calendar-tab': 'month' } },
            { id: 'agenda', label: t('view.agenda'), anchor: { 'data-calendar-tab': 'agenda' } },
          ]}
        active={mode}
        onSelect={id => { setView(id as Mode) }}
        className={css.tabs}
        data-calendar-tabs
        tools={(
          <>
            {mode === 'month' ? (
              <div className={css.monthNav} data-calendar-month-nav>
                <button type="button" className={css.iconButton} onClick={() => { shiftMonth(-1) }} aria-label={t('view.prevMonth')} data-calendar-prev>‹</button>
                <span className={css.monthTitle} data-calendar-month-label>{monthLabel}</span>
                <button type="button" className={css.iconButton} onClick={() => { shiftMonth(1) }} aria-label={t('view.nextMonth')} data-calendar-next>›</button>
                <button type="button" className={css.button} onClick={() => { setAnchor(today) }} data-calendar-today>{t('view.today')}</button>
              </div>
            ) : null}
            <button
              type="button"
              role="switch"
              aria-checked={overlay}
              aria-label={t('view.taskDeadlines')}
              className={`${css.switch} ${overlay ? css.switchOn : ''}`}
              onClick={() => { setOverlay(!overlay) }}
              disabled={!tasksAvailable}
              data-calendar-task-toggle
            >
              <span className={css.switchTrack} aria-hidden="true"><span className={css.switchThumb} /></span>
              <span>{t('view.taskDeadlines')}</span>
            </button>
            <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { openNew(defaultNewDay) }} data-calendar-new>{t('view.newEvent')}</button>
          </>
        )}
      />
      </div>
      <div className={css.content}>
      <div className={css.body}>
        {tasksAvailable ? null : <div className={css.notice} data-calendar-task-unavailable>{t('view.taskUnavailable')}</div>}
        {error === undefined || (events.length === 0 && deadlines.length === 0) ? null : (
          <div className={css.notice} role="status" data-calendar-update-error>
            <span>{error}</span>
            <button type="button" className={css.button} onClick={() => { setReloadToken(token => token + 1) }} data-calendar-retry>{t('view.retry')}</button>
          </div>
        )}
        {loading && events.length === 0 && deadlines.length === 0 ? (
          <div className={css.state} data-calendar-loading>{t('view.loading')}</div>
        ) : error !== undefined && events.length === 0 && deadlines.length === 0 ? (
          <div className={css.state} data-calendar-error>
            <strong>{error}</strong>
            <button type="button" className={css.button} onClick={() => { setReloadToken(token => token + 1) }} data-calendar-retry>{t('view.retry')}</button>
          </div>
        ) : mode === 'month' ? (
          <div className={css.monthWrap} data-calendar-month>
            <div className={css.weekdays}>
              {WEEKDAY_KEYS.map(key => <span key={key}>{t(key)}</span>)}
            </div>
            <div className={css.monthGrid} role="grid" aria-label={monthLabel}>
              {calendarDays.map(key => {
                const date = parseDateKey(key)
                const other = date.getFullYear() !== anchorDate.getFullYear() || date.getMonth() !== anchorDate.getMonth()
                const weekend = date.getDay() === 0 || date.getDay() === 6
                const dayEvents = events.filter(event => eventOnDay(event, key)).sort(compareEvents)
                const dayTasks = overlay ? deadlines.filter(task => task.dueDate === key) : []
                const items = [
                  ...dayEvents.map(event => ({ kind: 'event' as const, event })),
                  ...dayTasks.map(task => ({ kind: 'task' as const, task })),
                ]
                return (
                  <div
                    key={key}
                    className={`${css.day} ${other ? css.otherMonth : ''} ${weekend ? css.weekend : ''} ${key === today ? css.today : ''}`}
                    data-calendar-day={key}
                    role="gridcell"
                    onClick={() => { openNew(key) }}
                  >
                    <div className={css.dayHead}>
                      <button
                        type="button"
                        className={css.dayNumber}
                        aria-label={t('view.createOnDay', { date: key })}
                        onClick={(click) => { click.stopPropagation(); openNew(key) }}
                        data-calendar-day-new={key}
                      >
                        {date.getDate()}
                      </button>
                    </div>
                    {(expandedDay === key ? items : items.slice(0, 3)).map(item => item.kind === 'event' ? (
                      <button
                        key={`event-${item.event.id}`}
                        type="button"
                        className={`${css.chip} ${css.eventChip} ${css[`event_${item.event.color}`]}`}
                        title={item.event.title}
                        onClick={(click) => { click.stopPropagation(); openEvent(item.event) }}
                        data-calendar-event={item.event.id}
                      >
                        <span className={css.chipTime}>{item.event.time.kind === 'allDay' ? t('view.allDay') : formatTime(item.event.time.start, item.event.time.timeZone, intlLocale)}</span>
                        <span className={css.chipLabel}>{item.event.title}</span>
                      </button>
                    ) : (
                      <span
                        key={`task-${item.task.id}`}
                        className={`${css.chip} ${css.taskChip}`}
                        title={t('view.taskChipTitle', { title: item.task.title })}
                        onClick={(click) => { click.stopPropagation() }}
                        data-calendar-task-chip={item.task.id}
                        data-readonly="true"
                      >
                        <span className={css.taskBox} aria-hidden="true" />
                        <span className={css.chipLabel}>{item.task.title}</span>
                      </span>
                    ))}
                    {items.length > 3 ? (
                      <button
                        type="button"
                        className={css.more}
                        data-calendar-more
                        aria-expanded={expandedDay === key}
                        onClick={(click) => { click.stopPropagation(); setExpandedDay(current => current === key ? undefined : key) }}
                      >
                        {expandedDay === key ? t('view.fewerItems') : t('view.moreItems', { count: items.length - 3 })}
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
            <div className={css.legend} data-calendar-legend>
              <span className={css.legendItem}><i className={`${css.swatch} ${css.swatchEvent}`} />{t('view.legendEvent')}</span>
              {overlay ? <span className={css.legendItem}><i className={`${css.swatch} ${css.swatchTask}`} />{t('view.legendTask')}</span> : null}
            </div>
            {events.length === 0 && (!overlay || deadlines.length === 0)
              ? <EmptyState compact title={t('view.monthEmpty')} data-calendar-empty />
              : null}
          </div>
        ) : (
          <div className={css.agenda} data-calendar-agenda>
            <div className={css.agendaHead}>
              <h2>{t('view.next14')}</h2>
              <span className={css.caption}>{t('view.agendaFrom', { date: formatDayLabel(today, intlLocale) })}</span>
            </div>
            {agendaDays.length === 0 ? (
              <EmptyState title={t('view.agendaEmptyTitle')} body={t('view.agendaEmptyHint')} data-calendar-empty />
            ) : (
              <div className={css.agendaList}>
                {agendaDays.map(day => (
                  <section key={day.key} className={css.agendaDay} data-calendar-agenda-day={day.key}>
                    <div className={`${css.agendaDate} ${day.key === today ? css.agendaToday : ''}`}>
                      <strong>{formatDayLabel(day.key, intlLocale)}</strong>
                      <span>{day.key === today ? t('view.today') : formatWeekday(day.key, intlLocale)}</span>
                    </div>
                    <div className={css.agendaItems}>
                      {day.events.map(event => (
                        <button key={event.id} type="button" className={css.agendaItem} onClick={() => { openEvent(event) }} data-calendar-event={event.id}>
                          <span className={css.when}>{whenLabel(event, t, intlLocale)}</span>
                          <span className={css.what}>
                            <span className={css.itemTitle}>{event.title}</span>
                            {event.location === '' ? null : <span className={css.where}>{event.location}</span>}
                          </span>
                        </button>
                      ))}
                      {day.tasks.map(task => (
                        <div key={task.id} className={`${css.agendaItem} ${css.agendaTask}`} data-calendar-task-item={task.id}>
                          <span className={css.taskBox} aria-hidden="true" />
                          <span className={css.when}>{t('view.dueShort')}</span>
                          <span className={css.what}><span className={css.itemTitle}>{task.title}</span></span>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {deleted === undefined ? null : (
        <div className={css.undo} data-calendar-undo>
          <span>{t('view.deletedToast', { title: deleted.title })}</span>
          <button type="button" className={css.button} onClick={() => { void undo(deleted.id) }} data-calendar-undo-button>{t('view.undo')}</button>
          <button type="button" className={css.iconButton} onClick={() => { setDeleted(undefined) }} aria-label={t('view.dismiss')} data-calendar-undo-dismiss>×</button>
        </div>
      )}
      {editor === undefined ? null : (
        <>
          <div className={css.backdrop} onClick={requestCloseEditor} data-calendar-backdrop />
          <aside ref={drawerRef} className={css.drawer} role="dialog" aria-modal="true" tabIndex={-1} aria-label={editor.id === undefined ? t('view.createEvent') : t('view.eventDetails')} data-calendar-drawer>
            <div className={css.drawerHead}>
              <h2>{editor.id === undefined ? t('view.createEvent') : t('view.eventDetails')}</h2>
              <button type="button" className={css.iconButton} onClick={requestCloseEditor} data-calendar-close>{t('view.close')}</button>
            </div>
            <div className={css.drawerBody}>
              <div className={css.field}>
                <label htmlFor="calendar-title">{t('view.title')}</label>
                <input
                  id="calendar-title"
                  type="text"
                  maxLength={200}
                  value={editor.title}
                  placeholder={t('view.titlePlaceholder')}
                  onChange={event => { setEditor({ ...editor, title: event.target.value }) }}
                  data-calendar-field="title"
                />
              </div>
              <label className={css.checkLine}>
                <input
                  type="checkbox"
                  checked={editor.allDay}
                  onChange={event => { setEditor(withAllDay(editor, event.target.checked)) }}
                  data-calendar-field="allDay"
                />
                {t('view.allDayToggle')}
              </label>
              <div className={css.fieldRow}>
                <div className={css.field}>
                  <label htmlFor="calendar-start">{t('view.start')}</label>
                  <input
                    id="calendar-start"
                    type={editor.allDay ? 'date' : 'datetime-local'}
                    value={editor.start}
                    onChange={event => { setEditor({ ...editor, start: event.target.value }) }}
                    data-calendar-field="start"
                  />
                </div>
                <div className={css.field}>
                  <label htmlFor="calendar-end">{t('view.end')}</label>
                  <input
                    id="calendar-end"
                    type={editor.allDay ? 'date' : 'datetime-local'}
                    value={editor.end}
                    onChange={event => { setEditor({ ...editor, end: event.target.value }) }}
                    data-calendar-field="end"
                  />
                  {editor.allDay ? <span className={css.fieldHint}>{t('view.allDayEndHint')}</span> : null}
                </div>
              </div>
              {editor.allDay ? null : (
                <div className={css.field}>
                  <label htmlFor="calendar-zone">{t('view.timeZone')}</label>
                  <select
                    id="calendar-zone"
                    value={editor.timeZone}
                    onChange={event => { setEditor({ ...editor, timeZone: event.target.value }) }}
                    data-calendar-field="timeZone"
                  >
                    {zoneOptions.map(zone => <option key={zone} value={zone}>{zone}</option>)}
                  </select>
                </div>
              )}
              <div className={css.field}>
                <label htmlFor="calendar-location">{t('view.location')}</label>
                <input
                  id="calendar-location"
                  type="text"
                  maxLength={200}
                  value={editor.location}
                  placeholder={t('view.locationPlaceholder')}
                  onChange={event => { setEditor({ ...editor, location: event.target.value }) }}
                  data-calendar-field="location"
                />
              </div>
              <div className={css.field}>
                <label htmlFor="calendar-color">{t('view.color')}</label>
                <select
                  id="calendar-color"
                  value={editor.color}
                  onChange={event => { setEditor({ ...editor, color: event.target.value as EventColor }) }}
                  data-calendar-field="color"
                >
                  {COLORS.map(color => <option key={color} value={color}>{t(COLOR_KEYS[color])}</option>)}
                </select>
              </div>
              <div className={css.field}>
                <label htmlFor="calendar-description">{t('view.description')}</label>
                <textarea
                  id="calendar-description"
                  maxLength={10_000}
                  value={editor.description}
                  placeholder={t('view.descriptionPlaceholder')}
                  onChange={event => { setEditor({ ...editor, description: event.target.value }) }}
                  data-calendar-field="description"
                />
              </div>
              {formError === undefined ? null : <div className={css.formError} data-calendar-form-error>{formError}</div>}
            </div>
            <div className={css.drawerFoot}>
              {editor.id === undefined ? null : (
                <button type="button" className={`${css.button} ${css.danger}`} onClick={() => { void remove(editor.id!, editor.title) }} disabled={saving || running} data-calendar-delete>{t('view.delete')}</button>
              )}
              <span className={css.spacer} />
              <button type="button" className={css.button} onClick={requestCloseEditor} data-calendar-cancel>{t('view.cancel')}</button>
              <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void save(editor) }} disabled={saving || running} data-calendar-save>{t('view.save')}</button>
            </div>
          </aside>
        </>
      )}
      </div>
      {confirmDialog}
    </div>
  )
}
