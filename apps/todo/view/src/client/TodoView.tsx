import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { EmptyState, LocalFailure, ReadFailure, TabBar, failureKindOf, hasAppCode, outcomeFailure, outcomeMessage, outcomeValue, useConfirm, useModalFocus, useUiChoice, useUiField, type FailureKind } from '@matrix1001/dsh-application-harness-client-chrome'
import { ObjectReference } from '@matrix1001/dsh-application-harness-client-object-reference'
import { NS } from './locales.ts'
import css from './TodoView.module.css'

/** The translate face this page needs. */
export type TodoTranslate = TranslateNS<'todo'>

/** The props of the registered page. */
export interface TodoPageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface TodoViewProps extends ApplicationViewProps { t: TodoTranslate }

/** One todo, as the host's listTasks/getTask return it. */
interface Task {
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

/** One delegation as the todo application's own read operation exposes it (no session handle). */
interface AppDelegation {
  id: string
  title: string
  instructions: string
  status: 'pending' | 'active' | 'needs-person' | 'ended'
  outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable'
  latestReport?: { outcome: 'completed' | 'blocked' | 'failed'; summary: string; question?: string }
  createdAt: string
  updatedAt: string
}

/** The localized state line for one delegation. */
function delegationStateLabel(t: TodoTranslate, delegation: AppDelegation): string {
  if (delegation.status === 'pending') return t('delegation.statePending')
  if (delegation.status === 'active') return t('delegation.stateActive')
  if (delegation.status === 'needs-person') return t('delegation.stateNeedsPerson')
  switch (delegation.outcome) {
    case 'completed': return t('delegation.stateCompleted')
    case 'failed': return t('delegation.stateFailed')
    case 'cancelled': return t('delegation.stateCancelled')
    case 'interrupted': return t('delegation.stateInterrupted')
    default: return t('delegation.stateUnavailable')
  }
}

/**
 * The localized elapsed time between the delegation's own timestamps. Missing,
 * unparsable or non-increasing timestamps yield no label: an invented duration
 * would be worse than none.
 */
function delegationDurationLabel(delegation: AppDelegation, t: TodoTranslate): string | undefined {
  const created = Date.parse(delegation.createdAt)
  const updated = Date.parse(delegation.updatedAt)
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated <= created) return undefined
  const seconds = Math.ceil((updated - created) / 1000)
  if (seconds < 60) return t('delegation.durationSeconds', { seconds })
  return t('delegation.durationMinutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
}

/** One note summary, either the raw array or the `{ notes }` proxy shape. */
interface NoteSummary { id: string; title: string }

/** The two top-level pages. */
type Page = 'today' | 'tasks'
/** How the todo page lays its todos out. */
type Layout = 'board' | 'list'
/** The priority filter value ('' means all). */
type PriorityFilter = '' | '1' | '2' | '3'
/** The undo window, in milliseconds. */
const UNDO_MS = 8000

type Outcome = Awaited<ReturnType<ApplicationViewProps['call']>>


function pad2(value: number): string { return String(value).padStart(2, '0') }
function isoDate(date: Date): string {
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}
/** The client-local civil date, the only date vocabulary the host uses. */
function today(): string { return isoDate(new Date()) }
/** The client-local civil date of one timestamp. */
function localDate(timestamp: number): string { return isoDate(new Date(timestamp)) }
/** Shift an ISO civil date by a whole number of days. */
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + days)
  return isoDate(value)
}

/** Format one due date the way the compact task rows show it. */
function dateLabel(dueDate: string, todayIso: string, t: TodoTranslate): string {
  if (dueDate === todayIso) return t('view.today')
  if (dueDate === addDays(todayIso, 1)) return t('view.tomorrow')
  return dueDate.slice(5).replace('-', '/')
}

/** The due-date tone: overdue is danger, today is accent, later is neutral. */
function dueClass(task: Task, todayIso: string): string {
  if (task.completedAt !== null || task.dueDate === null) return ''
  if (task.dueDate < todayIso) return css.overdue ?? ''
  if (task.dueDate === todayIso) return css.dueToday ?? ''
  return ''
}

/** The priority tone used by the row/card dot (kept as a secondary cue). */
function priorityClass(priority: Task['priority']): string {
  if (priority === 1) return css.priorityHigh ?? ''
  if (priority === 2) return css.priorityMedium ?? ''
  return css.priorityLow ?? ''
}

/** The tone of the visible priority badge; the label itself carries the meaning. */
function priorityBadgeClass(priority: Task['priority']): string {
  if (priority === 1) return css.priorityBadgeHigh ?? ''
  if (priority === 2) return css.priorityBadgeMedium ?? ''
  return css.priorityBadgeLow ?? ''
}

/** The localized priority label. */
function priorityLabel(t: TodoTranslate, priority: Task['priority']): string {
  if (priority === 1) return t('view.priorityHigh')
  if (priority === 2) return t('view.priorityMedium')
  return t('view.priorityLow')
}

/** The short visible tag; the full label stays in the tooltip/accessible dot. */
function priorityShortLabel(t: TodoTranslate, priority: Task['priority']): string {
  if (priority === 1) return t('view.priorityShortHigh')
  if (priority === 2) return t('view.priorityShortMedium')
  return t('view.priorityShortLow')
}

/** One read failure classified by the shared failure vocabulary. */
interface ReadFailureInfo {
  readonly kind: FailureKind
  readonly code?: string
  readonly message?: string
}

/** One failure raised inside the open detail drawer. */
interface DetailFailure {
  /** The localized headline shown to the human. */
  readonly title: string
  /** The host's raw message, disclosed as diagnostics only. */
  readonly message?: string
  /** Whether the failure is a grantable permission refusal. */
  readonly permission?: boolean
}

/**
 * The host has no status column. A live task is "doing" when it is due today,
 * "done" when completedAt is set, and "todo" otherwise (overdue included).
 */
type TaskStatus = 'todo' | 'doing' | 'done'
function statusOf(task: Task, todayIso: string): TaskStatus {
  if (task.completedAt !== null) return 'done'
  if (task.dueDate !== null && task.dueDate === todayIso) return 'doing'
  return 'todo'
}
function statusLabel(t: TodoTranslate, status: TaskStatus): string {
  if (status === 'done') return t('view.statusDone')
  if (status === 'doing') return t('view.statusDoing')
  return t('view.statusTodo')
}

/** Default task ordering: live before done, then due date, priority, creation. */
function compareTasks(a: Task, b: Task): number {
  const aDone = a.completedAt === null ? 0 : 1
  const bDone = b.completedAt === null ? 0 : 1
  if (aDone !== bDone) return aDone - bDone
  return (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31')
    || a.priority - b.priority
    || a.createdAt - b.createdAt
}

/** Narrow a raw note list (array or `{ notes }`) into summaries. */
function isNote(value: unknown): value is NoteSummary {
  if (typeof value !== 'object' || value === null) return false
  const note = value as { id?: unknown; title?: unknown }
  return typeof note.id === 'string' && typeof note.title === 'string'
}
function notesOf(value: unknown): NoteSummary[] {
  if (Array.isArray(value)) return value.filter(isNote)
  if (typeof value === 'object' && value !== null && Array.isArray((value as { notes?: unknown }).notes)) {
    return ((value as { notes: unknown[] }).notes).filter(isNote)
  }
  return []
}
function notesUnavailableOf(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { unavailable?: unknown }).unavailable === true
}

/** The shared completion checkbox (list, board and today all use it). */
function TaskCheck({ task, t, running, onToggle }: {
  task: Task
  t: TodoTranslate
  running: boolean
  onToggle: (task: Task) => void
}) {
  const done = task.completedAt !== null
  return (
    <button
      type="button"
      className={`${css.check} ${done ? css.checkDone : ''}`}
      data-todo-toggle={task.id}
      aria-label={`${done ? t('view.reopen') : t('view.complete')}: ${task.title}`}
      disabled={running}
      onClick={() => { onToggle(task) }}
    >
      {done ? '✓' : ''}
    </button>
  )
}

/** Title + due + note-count line shared by rows and cards. */
function TaskMeta({ task, t, todayIso }: {
  task: Task
  t: TodoTranslate
  todayIso: string
}) {
  return (
    <span className={css.meta}>
      {task.dueDate === null ? null : (
        <span className={`${css.due} ${dueClass(task, todayIso)}`}>{dateLabel(task.dueDate, todayIso, t)}</span>
      )}
      {task.noteIds.length === 0 ? null : (
        <span className={css.noteCount} data-note-count={task.noteIds.length} title={t('view.linkedNotes')}>
          {`▤ ${String(task.noteIds.length)}`}
        </span>
      )}
    </span>
  )
}

/** The visible priority tag that keeps the meaning when color is unavailable. */
function PriorityBadge({ task, t }: { task: Task; t: TodoTranslate }) {
  const label = `${t('view.priority')} · ${priorityLabel(t, task.priority)}`
  return (
    <span
      className={`${css.priorityBadge} ${priorityBadgeClass(task.priority)}`}
      data-priority-badge={task.priority}
      role="img"
      aria-label={label}
      title={label}
    >
      {priorityShortLabel(t, task.priority)}
    </span>
  )
}

/** Agent chip + priority badge/dot at the trailing edge of a row or card. */
function TaskSide({ task, t }: { task: Task; t: TodoTranslate }) {
  return (
    <span className={css.side}>
      {task.assignee === 'agent' ? <span className={css.agentChip} data-assignee="agent">{t('view.agent')}</span> : null}
      <PriorityBadge task={task} t={t} />
      {/* The dot repeats the badge's meaning visually and is decorative. */}
      <i
        className={`${css.priorityDot} ${priorityClass(task.priority)}`}
        data-priority={task.priority}
        aria-hidden="true"
        title={`${t('view.priority')} · ${priorityLabel(t, task.priority)}`}
      />
    </span>
  )
}

/** One row in a today section. */
function TaskRow({ task, t, todayIso, running, onOpen, onToggle }: {
  task: Task
  t: TodoTranslate
  todayIso: string
  running: boolean
  onOpen: (id: string) => void
  onToggle: (task: Task) => void
}) {
  const done = task.completedAt !== null
  return (
    <div className={`${css.taskRow} ${done ? css.taskDone : ''}`} data-todo-row={task.id}>
      <TaskCheck task={task} t={t} running={running} onToggle={onToggle} />
      <button type="button" className={css.taskOpen} data-todo-open={task.id} onClick={() => { onOpen(task.id) }}>
        <span className={css.taskTitle}>{task.title}</span>
        <TaskMeta task={task} t={t} todayIso={todayIso} />
      </button>
      <TaskSide task={task} t={t} />
    </div>
  )
}

/** One card in a board column. */
function BoardCard({ task, t, todayIso, running, onOpen, onToggle }: {
  task: Task
  t: TodoTranslate
  todayIso: string
  running: boolean
  onOpen: (id: string) => void
  onToggle: (task: Task) => void
}) {
  const done = task.completedAt !== null
  return (
    <div className={`${css.card} ${done ? css.cardDone : ''}`} data-board-card={task.id}>
      <div className={css.cardTop}>
        <TaskCheck task={task} t={t} running={running} onToggle={onToggle} />
        <button type="button" className={css.cardTitle} data-todo-open={task.id} onClick={() => { onOpen(task.id) }}>
          {task.title}
        </button>
      </div>
      <div className={css.cardBottom}>
        <TaskMeta task={task} t={t} todayIso={todayIso} />
        <TaskSide task={task} t={t} />
      </div>
    </div>
  )
}

/** One row in the list layout. */
function TableRow({ task, t, todayIso, running, onOpen, onToggle }: {
  task: Task
  t: TodoTranslate
  todayIso: string
  running: boolean
  onOpen: (id: string) => void
  onToggle: (task: Task) => void
}) {
  const done = task.completedAt !== null
  const status = statusOf(task, todayIso)
  return (
    <div className={`${css.tableRow} ${done ? css.tableRowDone : ''}`} role="row" data-todo-list-row={task.id}>
      <span role="cell" className={css.checkCell}>
        <TaskCheck task={task} t={t} running={running} onToggle={onToggle} />
      </span>
      <span role="cell" className={css.titleCell}>
        <span className={css.titleLine}>
          <PriorityBadge task={task} t={t} />
          <button type="button" className={css.tableTitle} data-todo-open={task.id} onClick={() => { onOpen(task.id) }}>
            {task.title}
          </button>
        </span>
        {/* The narrow layout drops the separate due column; the date stays
            readable under the title instead of vanishing with its header. */}
        <span className={`${css.tableDueInline} ${dueClass(task, todayIso)}`} data-cell="due-inline">
          {task.dueDate === null ? t('view.noDue') : dateLabel(task.dueDate, todayIso, t)}
        </span>
      </span>
      <span role="cell" className={`${css.tableCell} ${dueClass(task, todayIso)}`} data-cell="due">
        {task.dueDate === null ? t('view.noDue') : dateLabel(task.dueDate, todayIso, t)}
      </span>
      <span role="cell" className={css.tableCell} data-cell="status">
        <span className={css.statusChip} data-status={status}>{statusLabel(t, status)}</span>
      </span>
    </div>
  )
}

/** The registered page. */
export function TodoPage({ locale, ...props }: TodoPageProps) {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <TodoView {...props} t={locale.bind(NS)} />
}

/** The todo page: today, all todos, and an explicit-save detail drawer. */
export function TodoView({ call, running, onChanged, pageContext, registerLeaveGuard, navigation, route, ui, delegation: delegationFace, openManagement, t }: TodoViewProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loaded, setLoaded] = useState(false)
  const [page, setPage] = useUiChoice<Page>(ui, 'page', ['today', 'tasks'], 'today')
  const [layout, setLayout] = useUiChoice<Layout>(ui, 'layout', ['board', 'list'], 'board')
  const [layoutExplicit, setLayoutExplicit] = useUiField<boolean>(ui, 'layoutExplicit', false, (value): value is boolean => typeof value === 'boolean')
  const [priorityFilter, setPriorityFilter] = useUiChoice<PriorityFilter>(ui, 'priorityFilter', ['', '1', '2', '3'], '')
  const [query, setQuery] = useUiField<string>(ui, 'query', '', (value): value is string => typeof value === 'string')
  const [quickTitle, setQuickTitle] = useState('')
  const [draft, setDraft] = useState<Task>()
  const [saved, setSaved] = useState<Task>()
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const [errorPermission, setErrorPermission] = useState(false)
  const fail = (outcome: Outcome, fallback: string): void => {
    if (failureKindOf(outcome) === 'not-approved') {
      setErrorPermission(true)
      setError(t('view.noStoragePermission'))
      return
    }
    setErrorPermission(false)
    setError(outcomeMessage(outcome) ?? fallback)
  }
  /**
   * A failure raised from the detail drawer belongs in that drawer: on a narrow
   * layout the drawer covers the page, so the page-level error line would be
   * out of sight exactly when the human pressed Save or Delete.
   */
  const failInDetail = (outcome: Outcome, title: string): void => {
    if (failureKindOf(outcome) === 'not-approved') {
      setDetailError({ title: t('view.noStoragePermission'), permission: true })
      return
    }
    const message = outcomeMessage(outcome)
    setDetailError({
      title,
      ...(message === undefined ? {} : { message }),
    })
  }
  const [readFailure, setReadFailure] = useState<ReadFailureInfo>()
  const [refreshFailure, setRefreshFailure] = useState<ReadFailureInfo>()
  const [detailError, setDetailError] = useState<DetailFailure>()
  const [deleted, setDeleted] = useState<{ id: string; title: string }>()
  const [conflict, setConflict] = useState<string>()
  const detailRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  /** Whether a successful read has ever populated the workspace. */
  const hasSnapshot = useRef(false)
  const [noteTitles, setNoteTitles] = useState<Record<string, string>>({})
  const [notesUnavailable, setNotesUnavailable] = useState(false)
  const [delegation, setDelegation] = useState<AppDelegation | null>()
  const [delegationApplied, setDelegationApplied] = useState(false)
  const [delegationBusy, setDelegationBusy] = useState(false)
  const [delegationError, setDelegationError] = useState<string>()
  const [reportExpanded, setReportExpanded] = useState(false)
  /** The task whose delegation the detail drawer currently shows (for change re-reads). */
  const detailTaskId = useRef('')
  const [noteQuery, setNoteQuery] = useState('')
  const [noteResults, setNoteResults] = useState<NoteSummary[]>([])
  const [noteSearchUnavailable, setNoteSearchUnavailable] = useState(false)
  const { confirm: confirmLeave, dialog: confirmDialog } = useConfirm()
  const [narrow, setNarrow] = useState(false)
  const pageRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const quickBusy = useRef(false)
  const columnRefs = useRef<Record<string, HTMLElement | null>>({})
  const tRef = useRef(t)
  tRef.current = t

  const todayIso = today()

  const load = useCallback(async () => {
    const taskOutcome = await call('listTasks', { includeCompleted: true })
    const list = outcomeValue<Task[]>(taskOutcome)
    if (list === undefined) {
      const detail = outcomeFailure(taskOutcome)
      const failure: ReadFailureInfo = {
        kind: detail.kind,
        ...(detail.code === undefined ? {} : { code: detail.code }),
        ...(detail.message === undefined ? {} : { message: detail.message }),
      }
      // A failed first read replaces the workspace; a failed refresh after a
      // successful read keeps the list and the open drawer, and only shows a
      // local notice with its own retry.
      if (hasSnapshot.current) setRefreshFailure(failure)
      else setReadFailure(failure)
      setLoaded(true)
      return
    }
    hasSnapshot.current = true
    setTasks(list)
    setReadFailure(undefined)
    setRefreshFailure(undefined)
    setError(undefined)
    setLoaded(true)
  }, [call])

  useEffect(() => { void load() }, [load])
  /** Read one task's delegation through the todo application's own operation. */
  const loadDelegation = useCallback(async (taskId: string) => {
    if (taskId === '') { setDelegation(null); setDelegationApplied(false); return }
    const outcome = await call('taskDelegation', { taskId })
    if (outcome.status !== 'success') { setDelegation(null); setDelegationApplied(false); return }
    const value = outcome.result as { delegation?: AppDelegation | null; applied?: boolean } | null
    setDelegation(value?.delegation ?? null)
    setDelegationApplied(value?.applied === true)
  }, [call])
  useEffect(() => onChanged(() => {
    void load()
    if (detailTaskId.current !== '') void loadDelegation(detailTaskId.current)
  }), [onChanged, load, loadDelegation])

  // The narrow state mirrors the page's own content width (not the window):
  // the shell's sidebars can change the width the page actually gets. The
  // layout itself is pure CSS @container; this mirror only feeds the data
  // attributes used by the detail drawer.
  useEffect(() => {
    const element = pageRef.current
    if (element === null) return undefined
    if (typeof ResizeObserver === 'undefined') {
      setNarrow(element.clientWidth > 0 && element.clientWidth < 720)
      return undefined
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth
      setNarrow(width > 0 && width < 720)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // A first narrow visit opens the list; a board choice the human made is kept.
  useEffect(() => {
    if (narrow && !layoutExplicit && layout === 'board') setLayout('list')
  }, [narrow, layoutExplicit, layout, setLayout])

  // The undo offer is short-lived; deleting again replaces it.
  useEffect(() => {
    if (deleted === undefined) return undefined
    const timer = window.setTimeout(() => { setDeleted(undefined) }, UNDO_MS)
    return () => { window.clearTimeout(timer) }
  }, [deleted])

  const closeDetail = useCallback(() => {
    setDraft(undefined)
    setSaved(undefined)
    detailTaskId.current = ''
    setDetailError(undefined)
    setDelegation(undefined)
    setDelegationApplied(false)
    setDelegationError(undefined)
    setReportExpanded(false)
    setNoteQuery('')
    setNoteResults([])
    setNoteSearchUnavailable(false)
  }, [])

  const dirty = draft !== undefined && saved !== undefined && JSON.stringify(draft) !== JSON.stringify(saved)

  // Opening another task, creating one, or following a route all replace the
  // open draft; ask before throwing unsaved edits away (the topbar used to
  // overwrite them silently).
  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true
    return await confirmLeave({
      title: t('view.leaveUnsaved'),
      body: t('view.leaveBody'),
      confirmLabel: t('view.leaveConfirm'),
      cancelLabel: t('view.leaveStay'),
      danger: true,
    })
  }, [confirmLeave, dirty, t])

  const openTask = useCallback(async (id: string) => {
    if (!(await confirmDiscard())) return
    const outcome = await call('getTask', { id })
    const task = outcomeValue<Task>(outcome)
    if (task === undefined) {
      setDraft(undefined)
      setSaved(undefined)
      setDetailError(undefined)
      fail(outcome, tRef.current('view.loadFailed'))
      return
    }
    setDraft(task)
    setSaved(task)
    setConflict(undefined)
    setStatus(undefined)
    setError(undefined)
    setDetailError(undefined)
    detailTaskId.current = task.id
    setDelegationError(undefined)
    setReportExpanded(false)
    void loadDelegation(task.id)
    setNoteQuery('')
    setNoteResults([])
    setNoteSearchUnavailable(false)
  }, [call, confirmDiscard])

  const openNew = useCallback(async () => {
    if (!(await confirmDiscard())) return
    const initial: Task = {
      id: '',
      title: '',
      notes: '',
      dueDate: todayIso,
      assignee: 'me',
      priority: 2,
      completedAt: null,
      noteIds: [],
      createdAt: 0,
      updatedAt: 0,
      version: 0,
    }
    setDraft(initial)
    setSaved(initial)
    setConflict(undefined)
    setStatus(undefined)
    setError(undefined)
    setDetailError(undefined)
    detailTaskId.current = ''
    setDelegation(undefined)
    setDelegationApplied(false)
    setDelegationError(undefined)
    setReportExpanded(false)
    setNoteQuery('')
    setNoteResults([])
    setNoteSearchUnavailable(false)
  }, [confirmDiscard, todayIso])

  // The route is the trigger, not the draft state: depending on openTask would
  // re-run this on every keystroke now that opening consults the dirty guard.
  const openTaskRef = useRef(openTask)
  openTaskRef.current = openTask
  useEffect(() => {
    if (route?.appId === 'todo' && route.record?.kind === 'task') void openTaskRef.current(route.record.id)
  }, [route])

  const requestCloseDetail = useCallback(() => {
    if (!dirty) { closeDetail(); return }
    void confirmLeave({
      title: t('view.leaveUnsaved'),
      body: t('view.leaveBody'),
      confirmLabel: t('view.leaveConfirm'),
      cancelLabel: t('view.leaveStay'),
      danger: true,
    }).then((leave) => { if (leave) closeDetail() })
  }, [closeDetail, confirmLeave, dirty, t])

  useModalFocus(draft !== undefined, detailRef, requestCloseDetail, titleRef)

  useEffect(() => {
    if (draft === undefined) return pageContext.report({ label: t('app.name'), view: page })
    const label = draft.title.trim() === '' ? t('view.newTask') : draft.title
    if (draft.id === '') return pageContext.report({ label, view: 'detail', dirty })
    return pageContext.report({
      label,
      record: { appId: 'todo', kind: 'task', id: draft.id },
      view: 'detail',
      dirty,
    })
  }, [draft, dirty, page, pageContext, t])

  useEffect(() => {
    if (registerLeaveGuard === undefined) return undefined
    return registerLeaveGuard(() => !dirty || confirmLeave({
      title: t('view.leaveUnsaved'),
      body: t('view.leaveBody'),
      confirmLabel: t('view.leaveConfirm'),
      cancelLabel: t('view.leaveStay'),
      danger: true,
    }))
  }, [confirmLeave, dirty, registerLeaveGuard, t])

  const noteIdsKey = draft?.noteIds.join(',') ?? ''
  useEffect(() => {
    const ids = draft?.noteIds ?? []
    if (ids.length === 0) {
      setNoteTitles({})
      setNotesUnavailable(false)
      return
    }
    void (async () => {
      const outcome = await call('resolveNotes', { ids })
      const value = outcomeValue<unknown>(outcome)
      const notes = notesOf(value)
      const next: Record<string, string> = {}
      for (const note of notes) next[note.id] = note.title
      setNoteTitles(next)
      setNotesUnavailable(outcome.status !== 'success' || notesUnavailableOf(value))
    })()
  }, [call, noteIdsKey])

  const createQuick = useCallback(async () => {
    const title = quickTitle.trim()
    if (title === '' || quickBusy.current) return
    quickBusy.current = true
    try {
      const outcome = await call('createTask', { title, dueDate: todayIso, priority: 2, assignee: 'me' })
      if (outcome.status !== 'success') {
        fail(outcome, t('view.saveFailed'))
        return
      }
      setQuickTitle('')
      setError(undefined)
      await load()
    } finally {
      quickBusy.current = false
    }
  }, [call, load, quickTitle, t, todayIso])

  const toggleTask = useCallback(async (task: Task) => {
    const outcome = await call('updateTask', {
      id: task.id,
      expectedVersion: task.version,
      completed: task.completedAt === null,
    })
    if (outcome.status !== 'success') {
      if (hasAppCode(outcome, 'stale-version')) { setConflict(t('view.conflict')); return }
      fail(outcome, t('view.saveFailed'))
      return
    }
    setError(undefined)
    await load()
  }, [call, load, t])

  /** Create a pending delegation and offer it to the human's send dialog. */
  const startDelegation = useCallback(async (taskId: string) => {
    setDelegationBusy(true)
    setDelegationError(undefined)
    const outcome = await call('createDelegation', { taskId })
    setDelegationBusy(false)
    const value = outcomeValue<{ delegation: AppDelegation }>(outcome)
    if (value === undefined) {
      setDelegationError(outcomeMessage(outcome) ?? t('delegation.failed'))
      return
    }
    setDelegation(value.delegation)
    setDelegationApplied(false)
    setReportExpanded(false)
    if (delegationFace === undefined) { setDelegationError(t('delegation.failed')); return }
    try {
      await delegationFace.requestSend(value.delegation.id)
    } catch (error) {
      setDelegationError(error instanceof Error ? error.message : String(error))
    }
  }, [call, delegationFace, t])

  /** Re-open the send dialog for a delegation that is still pending. */
  const offerDelegation = useCallback(async () => {
    if (delegation === undefined || delegation === null || delegationFace === undefined) return
    try {
      await delegationFace.requestSend(delegation.id)
    } catch (error) {
      setDelegationError(error instanceof Error ? error.message : String(error))
    }
  }, [delegation, delegationFace])

  const cancelDelegation = useCallback(async (taskId: string, delegationId: string) => {
    if (delegationFace === undefined) return
    setDelegationBusy(true)
    setDelegationError(undefined)
    const ok = await delegationFace.cancel(delegationId)
    setDelegationBusy(false)
    if (!ok) { setDelegationError(t('delegation.failed')); return }
    await loadDelegation(taskId)
  }, [delegationFace, loadDelegation, t])

  const openDelegation = useCallback(async () => {
    if (delegation === undefined || delegation === null || delegationFace === undefined) return
    const opened = await delegationFace.open(delegation.id)
    if (!opened) setDelegationError(t('delegation.failed'))
  }, [delegation, delegationFace, t])

  /** Append the ended delegation's report at the human's request; never completes the todo. */
  const applyDelegationResult = useCallback(async (taskId: string, expectedVersion: number, delegationId: string) => {
    setDelegationBusy(true)
    setDelegationError(undefined)
    const outcome = await call('applyDelegationResult', {
      taskId,
      expectedVersion,
      delegationId,
    })
    setDelegationBusy(false)
    const task = outcomeValue<Task>(outcome)
    if (task === undefined) {
      if (hasAppCode(outcome, 'stale-version')) setConflict(t('view.conflict'))
      else setDelegationError(outcomeMessage(outcome) ?? t('delegation.failed'))
      return
    }
    setDraft(task)
    setSaved(task)
    setDelegationApplied(true)
    setStatus(t('delegation.applied'))
  }, [call, t])

  const save = useCallback(async () => {
    /* v8 ignore next -- the save button only exists while a draft is open */
    if (draft === undefined) return
    const title = draft.title.trim()
    if (title === '') {
      setDetailError({ title: t('view.titleRequired') })
      return
    }
    setDetailError(undefined)
    const patch = {
      title,
      notes: draft.notes,
      dueDate: draft.dueDate,
      assignee: draft.assignee,
      priority: draft.priority,
      noteIds: draft.noteIds,
    }
    const outcome = draft.id === ''
      ? await call('createTask', patch)
      : await call('updateTask', {
          id: draft.id,
          expectedVersion: draft.version,
          ...patch,
          completed: draft.completedAt !== null,
        })
    const task = outcomeValue<Task>(outcome)
    if (task === undefined) {
      if (hasAppCode(outcome, 'stale-version')) { setConflict(t('view.conflict')); return }
      failInDetail(outcome, t('view.saveFailed'))
      return
    }
    setConflict(undefined)
    closeDetail()
    setStatus(t('view.saved'))
    setError(undefined)
    await load()
  }, [call, closeDetail, draft, load, t])

  const remove = useCallback(async () => {
    /* v8 ignore next -- delete is only rendered for a saved task */
    if (draft === undefined || draft.id === '') return
    setDetailError(undefined)
    const outcome = await call('deleteTask', { id: draft.id })
    if (outcome.status !== 'success') {
      failInDetail(outcome, t('view.deleteFailed'))
      return
    }
    setDeleted({ id: draft.id, title: draft.title })
    setStatus(undefined)
    setError(undefined)
    closeDetail()
    await load()
  }, [call, closeDetail, draft, load, t])

  const undoRemove = useCallback(async () => {
    /* v8 ignore next -- undo is only rendered while an offer exists */
    if (deleted === undefined) return
    const outcome = await call('restoreTask', { id: deleted.id })
    if (outcome.status !== 'success') {
      fail(outcome, t('view.saveFailed'))
      return
    }
    setDeleted(undefined)
    setError(undefined)
    setStatus(t('view.restored'))
    await load()
  }, [call, deleted, load, t])

  const findNotes = useCallback(async () => {
    const needle = noteQuery.trim()
    if (needle === '') {
      setNoteResults([])
      return
    }
    const outcome = await call('searchNotes', { query: needle })
    const value = outcomeValue<unknown>(outcome)
    setNoteResults(notesOf(value).slice(0, 6))
    setNoteSearchUnavailable(outcome.status !== 'success' || notesUnavailableOf(value))
  }, [call, noteQuery])

  const addNote = useCallback((note: NoteSummary) => {
    setDraft(current => (
      current === undefined || current.noteIds.includes(note.id)
        ? current
        : { ...current, noteIds: [...current.noteIds, note.id] }
    ))
    setNoteTitles(current => ({ ...current, [note.id]: note.title }))
    setNoteQuery('')
    setNoteResults([])
  }, [])

  const removeNote = useCallback((id: string) => {
    setDraft(current => (
      current === undefined ? current : { ...current, noteIds: current.noteIds.filter(noteId => noteId !== id) }
    ))
  }, [])

  const needle = query.trim().toLocaleLowerCase()
  const visibleTasks = useMemo(() => tasks.filter(task => {
    if (priorityFilter !== '' && task.priority !== Number(priorityFilter)) return false
    if (needle === '') return true
    if (task.title.toLocaleLowerCase().includes(needle)) return true
    return task.notes.toLocaleLowerCase().includes(needle)
  }).sort(compareTasks), [needle, priorityFilter, tasks])

  const todayGroups = useMemo(() => {
    const upcomingEnd = addDays(todayIso, 7)
    return {
      overdue: visibleTasks.filter(task => task.completedAt === null && task.dueDate !== null && task.dueDate < todayIso),
      today: visibleTasks.filter(task => task.completedAt === null && task.dueDate === todayIso),
      upcoming: visibleTasks.filter(task => (
        task.completedAt === null && task.dueDate !== null && task.dueDate > todayIso && task.dueDate <= upcomingEnd
      )),
      completed: visibleTasks
        .filter(task => task.completedAt !== null && localDate(task.completedAt) === todayIso)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
    }
  }, [todayIso, visibleTasks])

  const todaySections = [
    { id: 'overdue', title: t('view.overdue'), tasks: todayGroups.overdue },
    { id: 'today', title: t('view.today'), tasks: todayGroups.today },
    { id: 'upcoming', title: t('view.upcoming'), tasks: todayGroups.upcoming },
    { id: 'completed', title: t('view.completedToday'), tasks: todayGroups.completed },
  ]
  const todayEmpty = todaySections.every(section => section.tasks.length === 0)
  const filtersActive = query.trim() !== '' || priorityFilter !== ''
  const boardColumns = [
    { id: 'todo', title: t('view.statusTodo'), tasks: visibleTasks.filter(task => statusOf(task, todayIso) === 'todo') },
    { id: 'doing', title: t('view.statusDoing'), tasks: visibleTasks.filter(task => statusOf(task, todayIso) === 'doing') },
    { id: 'done', title: t('view.statusDone'), tasks: visibleTasks.filter(task => statusOf(task, todayIso) === 'done') },
  ]
  const isNew = draft !== undefined && draft.id === ''
  const detailTitle = isNew ? t('view.newTask') : t('view.detail')
  const delegationDuration = delegation === undefined || delegation === null ? undefined : delegationDurationLabel(delegation, t)

  return (
    <div
      ref={pageRef}
      className={css.page}
      data-todo-page
      data-page={page}
      data-narrow={narrow ? 'true' : 'false'}
      data-detail={draft === undefined ? 'false' : 'true'}
    >
      <div className={css.topBar} data-todo-topbar>
        <TabBar
          tabs={[
            { id: 'today', label: t('view.today'), anchor: { 'data-todo-tab': 'today' } },
            { id: 'tasks', label: t('view.tasks'), anchor: { 'data-todo-tab': 'tasks' } },
          ]}
          active={page}
          onSelect={id => {
            setPage(id as Page)
            setPriorityFilter('')
            setQuery('')
            setStatus(undefined)
          }}
          tools={(
            <>
              <input
                className={css.topSearch}
                type="search"
                value={query}
                onChange={event => { setQuery(event.target.value) }}
                placeholder={t('view.search')}
                aria-label={t('view.search')}
                data-todo-search
              />
              <button
                type="button"
                className={`${css.button} ${css.primary}`}
                onClick={openNew}
                disabled={running}
                data-todo-new-task
              >
                {t('view.newTask')}
              </button>
            </>
          )}
        />
      </div>

      {error === undefined || draft !== undefined ? null : (
        <LocalFailure
          title={t('view.operationFailed')}
          message={error}
          detailLabel={t('view.diagnostic')}
          data-todo-error
          {...(errorPermission ? {
            action: <button type="button" className={css.button} data-todo-manage-permissions onClick={() => { openManagement('permissions') }}>{t('view.managePermissions')}</button>,
          } : {})}
        />
      )}
      {conflict === undefined || draft !== undefined ? null : (
        <LocalFailure
          title={t('view.conflictTitle')}
          message={conflict}
          detailLabel={t('view.diagnostic')}
          data-todo-conflict-page
          action={<button type="button" className={css.button} onClick={() => { setConflict(undefined); void load() }} data-todo-reload-page>{t('view.reload')}</button>}
        />
      )}
      {refreshFailure === undefined || draft !== undefined ? null : (
        <LocalFailure
          className={css.pageNotice}
          title={t('view.refreshFailed')}
          detailLabel={t('view.diagnostic')}
          {...(refreshFailure.code === undefined ? {} : { code: refreshFailure.code })}
          {...(refreshFailure.message === undefined ? {} : { message: refreshFailure.message })}
          data-todo-refresh-error
          action={<button type="button" className={css.button} onClick={() => { void load() }} data-todo-refresh-retry>{t('view.retry')}</button>}
        />
      )}

      {!loaded ? (
        <div className={css.centerState} data-todo-loading>{t('view.loading')}</div>
      ) : readFailure !== undefined ? (
        readFailure.kind === 'not-approved' || readFailure.kind === 'undeclared'
          ? (
            <div className={css.centerState} data-todo-read-failure={readFailure.kind}>
              <EmptyState
                title={readFailure.kind === 'undeclared' ? t('view.notReadUndeclaredTitle') : t('view.notReadTitle')}
                body={readFailure.kind === 'undeclared' ? t('view.notReadUndeclaredBody') : t('view.notReadBody')}
              />
            </div>
          )
          : (
            <div className={css.centerState} data-todo-error-state>
              <ReadFailure
                kind={readFailure.kind}
                title={t('view.loadFailed')}
                detailLabel={t('view.diagnostic')}
                {...(readFailure.code === undefined ? {} : { code: readFailure.code })}
                {...(readFailure.message === undefined ? {} : { message: readFailure.message })}
                data-todo-read-failure={readFailure.kind}
                retry={<button type="button" className={css.button} onClick={() => { void load() }} data-todo-retry>{t('view.retry')}</button>}
              />
            </div>
          )
      ) : (
        <div className={css.workspace}>
          {page === 'today' ? (
            <div className={css.scroll} data-today-view>
              <div className={css.inner}>
                <header className={css.pageHead}>
                  <div className={css.headLine}>
                    <h1 className={css.pageTitle}>{t('view.today')}</h1>
                    <span className={css.caption}>{new Date(`${todayIso}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric', weekday: 'long' })}</span>
                  </div>
                  <div className={css.summary} data-today-summary>
                    {t('view.todaySummary', { overdue: todayGroups.overdue.length, due: todayGroups.today.length })}
                  </div>
                </header>

                <div className={css.quickAdd} data-today-quick-add>
                  <span className={css.quickPlus} aria-hidden="true">＋</span>
                  <input
                    className={css.quickInput}
                    value={quickTitle}
                    onChange={event => { setQuickTitle(event.target.value) }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                      event.preventDefault()
                      if (!running) void createQuick()
                    }}
                    placeholder={t('view.quickAdd')}
                    aria-label={t('view.quickAdd')}
                  />
                  <button
                    type="button"
                    className={`${css.button} ${css.quickButton}`}
                    onClick={() => { void createQuick() }}
                    disabled={running}
                    data-today-quick-submit
                  >
                    {t('view.add')}
                  </button>
                </div>

                {todayEmpty ? (
                  <EmptyState
                    title={filtersActive ? t('view.noMatching') : t('view.todayEmpty')}
                    body={filtersActive ? t('view.noMatchingHint') : t('view.todayEmptyHint')}
                    action={filtersActive ? (
                      <button type="button" className={css.button} onClick={() => { setQuery(''); setPriorityFilter('') }} data-today-clear-filters>{t('view.clearFilters')}</button>
                    ) : undefined}
                    data-today-empty
                  />
                ) : todaySections.filter(section => section.tasks.length > 0).map(section => (
                  <section key={section.id} className={css.section} data-today-section={section.id}>
                    <header className={css.sectionHead}>
                      <span className={`${css.sectionDot} ${section.id === 'overdue' ? css.sectionDotOverdue : ''}`} aria-hidden="true" />
                      <h2 className={css.sectionTitle}>{section.title}</h2>
                      <span className={css.sectionCount}>{section.tasks.length}</span>
                    </header>
                    <div className={css.sectionPanel}>
                      {section.tasks.map(task => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          t={t}
                          todayIso={todayIso}
                          running={running}
                          onOpen={id => { void openTask(id) }}
                          onToggle={taskToToggle => { void toggleTask(taskToToggle) }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          ) : (
            <div className={css.scroll} data-todo-view>
              <div className={`${css.inner} ${css.innerWide}`}>
                <header className={css.pageHead}>
                  <div>
                    <h1 className={css.pageTitle}>{t('view.tasks')}</h1>
                    <div className={css.caption} data-todo-count>{t('view.taskCount', { count: visibleTasks.length })}</div>
                  </div>
                </header>

                <div className={css.toolbar} data-todo-toolbar>
                  <select
                    className={css.select}
                    value={priorityFilter}
                    onChange={event => { setPriorityFilter(event.target.value as PriorityFilter) }}
                    aria-label={t('view.filterPriority')}
                    data-todo-filter-priority
                  >
                    <option value="">{t('view.allPriorities')}</option>
                    <option value="1">{t('view.priorityHigh')}</option>
                    <option value="2">{t('view.priorityMedium')}</option>
                    <option value="3">{t('view.priorityLow')}</option>
                  </select>
                  <span className={css.toolbarSpacer} />
                  <div className={css.seg} data-todo-layout-group>
                    <button
                      type="button"
                      className={`${css.segButton} ${layout === 'board' ? css.segActive : ''}`}
                      aria-pressed={layout === 'board'}
                      onClick={() => { setLayout('board'); setLayoutExplicit(true) }}
                      data-todo-layout="board"
                    >
                      {t('view.board')}
                    </button>
                    <button
                      type="button"
                      className={`${css.segButton} ${layout === 'list' ? css.segActive : ''}`}
                      aria-pressed={layout === 'list'}
                      onClick={() => { setLayout('list'); setLayoutExplicit(true) }}
                      data-todo-layout="list"
                    >
                      {t('view.list')}
                    </button>
                  </div>
                </div>

                {layout === 'list' ? (
                  <div className={css.table} role="table" data-todo-list>
                    <div className={css.tableHead} role="row">
                      <span role="columnheader" />
                      <span role="columnheader">{t('view.columnTask')}</span>
                      <span role="columnheader">{t('view.columnDue')}</span>
                      <span role="columnheader">{t('view.columnStatus')}</span>
                    </div>
                    {visibleTasks.length === 0 ? (
                      <EmptyState compact title={t('view.noMatching')} body={t('view.noMatchingHint')} data-todo-list-empty />
                    ) : visibleTasks.map(task => (
                      <TableRow
                        key={task.id}
                        task={task}
                        t={t}
                        todayIso={todayIso}
                        running={running}
                        onOpen={id => { void openTask(id) }}
                        onToggle={taskToToggle => { void toggleTask(taskToToggle) }}
                      />
                    ))}
                  </div>
                ) : (
                  <div ref={boardRef} className={css.board} data-todo-board>
                    {boardColumns.map(column => (
                      <section
                        key={column.id}
                        ref={(element) => { columnRefs.current[column.id] = element }}
                        className={css.column}
                        data-board-column={column.id}
                      >
                        <button
                          type="button"
                          className={css.columnHead}
                          data-board-column-head={column.id}
                          onClick={() => {
                            const target = columnRefs.current[column.id]
                            if (target !== null && target !== undefined) boardRef.current?.scrollTo({ left: target.offsetLeft, behavior: 'smooth' })
                          }}
                        >
                          <span className={css.columnTitle}>{column.title}</span>
                          <span className={css.columnCount}>{column.tasks.length}</span>
                        </button>
                        <div className={css.cards}>
                          {column.tasks.length === 0 ? (
                            <EmptyState compact title={t('view.columnEmpty')} data-board-empty={column.id} />
                          ) : column.tasks.map(task => (
                            <BoardCard
                              key={task.id}
                              task={task}
                              t={t}
                              todayIso={todayIso}
                              running={running}
                              onOpen={id => { void openTask(id) }}
                              onToggle={taskToToggle => { void toggleTask(taskToToggle) }}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {draft === undefined ? null : (
            <>
              <div className={css.scrim} data-todo-scrim onClick={requestCloseDetail} />
              <aside
                ref={detailRef}
                className={css.detail}
                data-todo-detail
                data-todo-detail-full={narrow ? 'true' : 'false'}
                role="dialog"
                aria-modal="true"
                tabIndex={-1}
                aria-label={detailTitle}
              >
                <header className={css.detailHead}>
                  <h2 className={css.detailTitle}>{detailTitle}</h2>
                  <span className={css.detailState} data-todo-dirty={dirty ? 'true' : 'false'}>
                    {dirty ? t('view.unsaved') : ''}
                  </span>
                  <button type="button" className={css.closeButton} onClick={requestCloseDetail} aria-label={t('view.close')} data-todo-close>
                    ×
                  </button>
                </header>

                <div className={css.detailBody}>
                  {conflict === undefined ? null : (
                    <div className={css.errorBar} role="alert" data-todo-conflict>
                      <span>{conflict}</span>
                      <button type="button" className={css.button} onClick={() => { if (draft.id !== '') void openTask(draft.id) }} data-todo-reload>
                        {t('view.reload')}
                      </button>
                    </div>
                  )}
                  <div className={css.field}>
                    <label htmlFor="task-title">{t('view.title')}</label>
                    <input
                      id="task-title"
                      ref={titleRef}
                      value={draft.title}
                      onChange={event => { setDraft({ ...draft, title: event.target.value }) }}
                      placeholder={t('view.titlePlaceholder')}
                      data-todo-title
                    />
                  </div>

                  <div className={css.fieldRow}>
                    <div className={css.field}>
                      <label htmlFor="task-priority">{t('view.priority')}</label>
                      <select
                        id="task-priority"
                        value={draft.priority}
                        onChange={event => { setDraft({ ...draft, priority: Number(event.target.value) as Task['priority'] }) }}
                        data-todo-priority
                      >
                        <option value="1">{t('view.priorityHigh')}</option>
                        <option value="2">{t('view.priorityMedium')}</option>
                        <option value="3">{t('view.priorityLow')}</option>
                      </select>
                    </div>
                    <div className={css.field}>
                      <label htmlFor="task-due">{t('view.due')}</label>
                      <input
                        id="task-due"
                        type="date"
                        value={draft.dueDate ?? ''}
                        onChange={event => { setDraft({ ...draft, dueDate: event.target.value === '' ? null : event.target.value }) }}
                        data-todo-due
                      />
                    </div>
                  </div>

                  <div className={css.field}>
                    <label htmlFor="task-assignee">{t('view.assignee')}</label>
                    <select
                      id="task-assignee"
                      value={draft.assignee}
                      onChange={event => { setDraft({ ...draft, assignee: event.target.value as Task['assignee'] }) }}
                      data-todo-assignee
                    >
                      <option value="me">{t('view.me')}</option>
                      <option value="agent">{t('view.agent')}</option>
                    </select>
                  </div>

                  <div className={css.field}>
                    <label htmlFor="task-notes">{t('view.description')}</label>
                    <textarea
                      id="task-notes"
                      value={draft.notes}
                      onChange={event => { setDraft({ ...draft, notes: event.target.value }) }}
                      placeholder={t('view.descriptionPlaceholder')}
                      data-todo-description
                    />
                  </div>

                  <div className={css.field}>
                    <span className={css.fieldLabel}>{t('view.linkedNotes')}</span>
                    <div className={css.noteLinks} data-note-links>
                      {draft.noteIds.length === 0 ? (
                        <span className={css.noteEmpty}>{t('view.noLinkedNotes')}</span>
                      ) : draft.noteIds.map(id => {
                        const title = noteTitles[id]
                        return title === undefined ? (
                          <span key={id} className={css.noteUnavailable} data-note-unavailable={id}>
                            {t('view.noteUnavailable')}
                            <button
                              type="button"
                              className={css.noteRemove}
                              onClick={() => { removeNote(id) }}
                              aria-label={t('view.removeNote')}
                              data-note-remove={id}
                            >
                              ×
                            </button>
                          </span>
                        ) : (
                          <span key={id} className={css.noteChip} data-note-chip={id}>
                            <ObjectReference
                              object={{ appId: 'notes', type: 'note', id }}
                              title={title}
                              attrs={{ 'data-note-open': id }}
                              onOpen={() => {
                                navigation?.open({ appId: 'notes', record: { appId: 'notes', kind: 'note', id }, view: 'editor' })
                              }}
                            />
                            <button
                              type="button"
                              className={css.noteRemove}
                              onClick={() => { removeNote(id) }}
                              aria-label={t('view.removeNote')}
                              data-note-remove={id}
                            >
                              ×
                            </button>
                          </span>
                        )
                      })}
                    </div>

                    <div className={css.noteSearchRow}>
                      <input
                        value={noteQuery}
                        onChange={event => { setNoteQuery(event.target.value) }}
                        onKeyDown={event => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void findNotes()
                          }
                        }}
                        placeholder={t('view.searchNotes')}
                        aria-label={t('view.searchNotes')}
                        disabled={notesUnavailable}
                        data-note-search
                      />
                      <button
                        type="button"
                        className={css.button}
                        onClick={() => { void findNotes() }}
                        disabled={notesUnavailable || running}
                        data-note-find
                      >
                        {t('view.find')}
                      </button>
                    </div>
                    {notesUnavailable ? <div className={css.noteHint} data-notes-unavailable>{t('view.notesUnavailable')}</div> : null}
                    {noteSearchUnavailable ? <div className={css.noteHint} data-note-search-unavailable>{t('view.searchNotesUnavailable')}</div> : null}
                    {noteResults.length === 0 ? null : (
                      <div className={css.noteResults}>
                        {noteResults.map(note => (
                          <button
                            key={note.id}
                            type="button"
                            className={css.noteResult}
                            onClick={() => { addNote(note) }}
                            data-note-result={note.id}
                          >
                            {note.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {isNew ? null : (
                    <div className={css.field} data-todo-delegation>
                      <span className={css.fieldLabel}>{t('delegation.title')}</span>
                      {delegationError === undefined ? null : (
                        <LocalFailure title={t('delegation.failed')} message={delegationError} detailLabel={t('view.diagnostic')} data-todo-delegation-error />
                      )}
                      {delegation === undefined ? (
                        <span className={css.noteEmpty}>{t('delegation.loading')}</span>
                      ) : delegation === null ? (
                        <button
                          type="button"
                          className={css.button}
                          data-todo-delegation-create
                          disabled={running || delegationBusy}
                          onClick={() => { void startDelegation(draft.id) }}
                        >
                          {t('delegation.create')}
                        </button>
                      ) : (
                        <div data-todo-delegation-card data-status={delegation.status}>
                          <div className={css.delegationMeta} data-todo-delegation-meta>
                            <strong data-todo-delegation-state={delegation.status}>{delegationStateLabel(t, delegation)}</strong>
                            {delegationDuration === undefined ? null : (
                              <span className={css.noteHint} data-todo-delegation-duration>{delegationDuration}</span>
                            )}
                          </div>
                          {delegation.status === 'pending' ? (
                            <p className={css.noteHint} data-todo-delegation-pending>{t('delegation.pendingHint')}</p>
                          ) : null}
                          {delegation.latestReport === undefined ? null : (
                            <div
                              className={css.delegationReport}
                              data-todo-delegation-report
                              data-expanded={reportExpanded ? 'true' : 'false'}
                            >
                              <p
                                className={`${css.noteHint} ${css.delegationSummary} ${reportExpanded ? css.delegationSummaryExpanded : ''}`}
                                data-todo-delegation-summary
                              >
                                {delegation.latestReport.summary}
                              </p>
                              <button
                                type="button"
                                className={css.delegationToggle}
                                data-todo-delegation-expand
                                aria-expanded={reportExpanded}
                                onClick={() => { setReportExpanded(current => !current) }}
                              >
                                {reportExpanded ? t('delegation.collapse') : t('delegation.expand')}
                              </button>
                            </div>
                          )}
                          {delegation.latestReport?.question === undefined ? null : (
                            <p className={css.noteHint} data-todo-delegation-question>
                              {t('delegation.needQuestion')} {delegation.latestReport.question}
                            </p>
                          )}
                          <div className={css.noteSearchRow} data-todo-delegation-actions>
                            {delegation.status === 'pending' ? (
                              <button type="button" className={css.button} data-todo-delegation-send disabled={delegationBusy} onClick={() => { void offerDelegation() }}>
                                {t('delegation.send')}
                              </button>
                            ) : null}
                            {delegation.status === 'pending' ? null : (
                              <button type="button" className={css.button} data-todo-delegation-open onClick={() => { void openDelegation() }}>
                                {t('delegation.open')}
                              </button>
                            )}
                            {delegation.status === 'ended' && delegation.latestReport !== undefined && !delegationApplied ? (
                              <button
                                type="button"
                                className={css.button}
                                data-todo-delegation-apply
                                disabled={delegationBusy || dirty}
                                onClick={() => { void applyDelegationResult(draft.id, draft.version, delegation.id) }}
                              >
                                {t('delegation.apply')}
                              </button>
                            ) : null}
                            {delegationApplied ? <span className={css.noteHint} data-todo-delegation-applied>{t('delegation.applied')}</span> : null}
                            {delegation.status === 'ended' ? (
                              <button type="button" className={css.button} data-todo-delegation-retry disabled={running || delegationBusy} onClick={() => { void startDelegation(draft.id) }}>
                                {t('delegation.retry')}
                              </button>
                            ) : (
                              <button type="button" className={css.button} data-todo-delegation-cancel disabled={delegationBusy} onClick={() => { void cancelDelegation(draft.id, delegation.id) }}>
                                {t('delegation.cancel')}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {refreshFailure === undefined ? null : (
                  <div className={css.detailNotice} data-todo-refresh-notice>
                    <LocalFailure
                      title={t('view.refreshFailed')}
                      detailLabel={t('view.diagnostic')}
                      {...(refreshFailure.code === undefined ? {} : { code: refreshFailure.code })}
                      {...(refreshFailure.message === undefined ? {} : { message: refreshFailure.message })}
                      data-todo-refresh-error
                      action={<button type="button" className={css.button} onClick={() => { void load() }} data-todo-refresh-retry>{t('view.retry')}</button>}
                    />
                  </div>
                )}

                {detailError === undefined ? null : (
                  <LocalFailure
                    className={css.detailError}
                    title={detailError.title}
                    detailLabel={t('view.diagnostic')}
                    {...(detailError.message === undefined ? {} : { message: detailError.message })}
                    data-todo-detail-error
                    {...(detailError.permission ? {
                      action: <button type="button" className={css.button} data-todo-detail-manage-permissions onClick={() => { openManagement('permissions') }}>{t('view.managePermissions')}</button>,
                    } : {})}
                  />
                )}

                <footer className={css.footer}>
                  {isNew ? null : (
                    <button
                      type="button"
                      className={`${css.button} ${css.danger}`}
                      onClick={() => { void remove() }}
                      disabled={running}
                      data-todo-delete
                    >
                      {t('view.delete')}
                    </button>
                  )}
                  {isNew ? null : (
                    <button
                      type="button"
                      className={css.button}
                      onClick={() => {
                        setDraft({ ...draft, completedAt: draft.completedAt === null ? Date.now() : null })
                      }}
                      data-todo-complete
                    >
                      {draft.completedAt === null ? t('view.complete') : t('view.reopen')}
                    </button>
                  )}
                  <span className={css.footerSpacer} />
                  <button type="button" className={css.button} onClick={requestCloseDetail} data-todo-cancel>
                    {t('view.cancel')}
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.primary}`}
                    onClick={() => { void save() }}
                    disabled={running || !dirty || conflict !== undefined}
                    data-todo-save
                  >
                    {t('view.save')}
                  </button>
                </footer>
              </aside>
            </>
          )}
        </div>
      )}

      {confirmDialog}
      {status === undefined ? null : <div className={css.toast} role="status" data-todo-status>{status}</div>}
      {deleted === undefined ? null : (
        <div className={css.undo} role="status" data-todo-undo>
          <span>{t('view.deletedNotice', { title: deleted.title })}</span>
          <button type="button" onClick={() => { void undoRemove() }} data-todo-undo-action>{t('view.undo')}</button>
        </div>
      )}
    </div>
  )
}
