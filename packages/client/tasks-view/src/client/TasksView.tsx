import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { EmptyState, TabBar, hasAppCode, useConfirm, useModalFocus, useUiChoice, useUiField } from '@matrix1001/dsh-application-harness-client-chrome'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ObjectReference } from '@matrix1001/dsh-application-harness-client-object-reference'
import { NS } from './locales.ts'
import css from './TasksView.module.css'

/** The translate face this page needs. */
export type TasksTranslate = TranslateNS<'tasks'>

/** The props of the registered page. */
export interface TasksPageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface TasksViewProps extends ApplicationViewProps { t: TasksTranslate }

/** One task, as the host's listTasks/getTask return it. */
interface Task {
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

/** One project. The host has no color/description/archive fields. */
interface Project { id: string; name: string; version: number }

/** One note summary, either the raw array or the `{ notes }` proxy shape. */
interface NoteSummary { id: string; title: string }

/** The three top-level pages. */
type Page = 'today' | 'tasks' | 'projects'
/** How the task page lays its tasks out. */
type Layout = 'board' | 'list'
/** The priority filter value ('' means all). */
type PriorityFilter = '' | '1' | '2' | '3'
/** The undo window, in milliseconds. */
const UNDO_MS = 8000

type Outcome = Awaited<ReturnType<ApplicationViewProps['call']>>

function valueOf<T>(outcome: Outcome): T | undefined { return outcome.status === 'success' ? outcome.result as T : undefined }
function messageOf(outcome: Outcome): string | undefined { return outcome.status === 'success' || outcome.status === 'cancelled' ? undefined : outcome.error?.message }

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
function dateLabel(dueDate: string, todayIso: string, t: TasksTranslate): string {
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

/** The priority tone used by the row/card dot. */
function priorityClass(priority: Task['priority']): string {
  if (priority === 1) return css.priorityHigh ?? ''
  if (priority === 2) return css.priorityMedium ?? ''
  return css.priorityLow ?? ''
}

/** The localized priority label. */
function priorityLabel(t: TasksTranslate, priority: Task['priority']): string {
  if (priority === 1) return t('view.priorityHigh')
  if (priority === 2) return t('view.priorityMedium')
  return t('view.priorityLow')
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
function statusLabel(t: TasksTranslate, status: TaskStatus): string {
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

/** Project progress as a whole percentage (0 for an empty project). */
function percentOf(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100)
}

/** A stable presentation tone for a project, derived from its id. */
const PROJECT_TONES = ['blue', 'green', 'amber', 'red', 'gray'] as const
function projectTone(projectId: string): string {
  let hash = 0
  for (const character of projectId) hash = (hash + character.charCodeAt(0)) % PROJECT_TONES.length
  return PROJECT_TONES[hash]!
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
  t: TasksTranslate
  running: boolean
  onToggle: (task: Task) => void
}) {
  const done = task.completedAt !== null
  return (
    <button
      type="button"
      className={`${css.check} ${done ? css.checkDone : ''}`}
      data-task-toggle={task.id}
      aria-label={`${done ? t('view.reopen') : t('view.complete')}: ${task.title}`}
      disabled={running}
      onClick={() => { onToggle(task) }}
    >
      {done ? '✓' : ''}
    </button>
  )
}

/** Project chip with the derived tone dot; unassigned tasks say so. */
function ProjectChip({ project, t }: { project: Project | undefined; t: TasksTranslate }) {
  if (project === undefined) return <span className={css.projectChip} data-project-chip="none">{t('view.noProject')}</span>
  return (
    <span className={css.projectChip} data-project-chip={project.id}>
      <i className={css.projectDot} data-tone={projectTone(project.id)} aria-hidden="true" />
      {project.name}
    </span>
  )
}

/** Title + project + due + note-count line shared by rows and cards. */
function TaskMeta({ task, project, t, todayIso }: {
  task: Task
  project: Project | undefined
  t: TasksTranslate
  todayIso: string
}) {
  return (
    <span className={css.meta}>
      <ProjectChip project={project} t={t} />
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

/** Agent chip + priority dot at the trailing edge of a row or card. */
function TaskSide({ task, t }: { task: Task; t: TasksTranslate }) {
  return (
    <span className={css.side}>
      {task.assignee === 'agent' ? <span className={css.agentChip} data-assignee="agent">{t('view.agent')}</span> : null}
      <i
        className={`${css.priorityDot} ${priorityClass(task.priority)}`}
        data-priority={task.priority}
        role="img"
        aria-label={`${t('view.priority')} · ${priorityLabel(t, task.priority)}`}
        title={`${t('view.priority')} · ${priorityLabel(t, task.priority)}`}
      />
    </span>
  )
}

/** One row in a today section. */
function TaskRow({ task, project, t, todayIso, running, onOpen, onToggle }: {
  task: Task
  project: Project | undefined
  t: TasksTranslate
  todayIso: string
  running: boolean
  onOpen: (id: string) => void
  onToggle: (task: Task) => void
}) {
  const done = task.completedAt !== null
  return (
    <div className={`${css.taskRow} ${done ? css.taskDone : ''}`} data-task-row={task.id}>
      <TaskCheck task={task} t={t} running={running} onToggle={onToggle} />
      <button type="button" className={css.taskOpen} data-task-open={task.id} onClick={() => { onOpen(task.id) }}>
        <span className={css.taskTitle}>{task.title}</span>
        <TaskMeta task={task} project={project} t={t} todayIso={todayIso} />
      </button>
      <TaskSide task={task} t={t} />
    </div>
  )
}

/** One card in a board column. */
function BoardCard({ task, project, t, todayIso, running, onOpen, onToggle }: {
  task: Task
  project: Project | undefined
  t: TasksTranslate
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
        <button type="button" className={css.cardTitle} data-task-open={task.id} onClick={() => { onOpen(task.id) }}>
          {task.title}
        </button>
      </div>
      <div className={css.cardBottom}>
        <TaskMeta task={task} project={project} t={t} todayIso={todayIso} />
        <TaskSide task={task} t={t} />
      </div>
    </div>
  )
}

/** One row in the list layout. */
function TableRow({ task, project, t, todayIso, running, onOpen, onToggle }: {
  task: Task
  project: Project | undefined
  t: TasksTranslate
  todayIso: string
  running: boolean
  onOpen: (id: string) => void
  onToggle: (task: Task) => void
}) {
  const done = task.completedAt !== null
  const status = statusOf(task, todayIso)
  return (
    <div className={`${css.tableRow} ${done ? css.tableRowDone : ''}`} role="row" data-task-list-row={task.id}>
      <TaskCheck task={task} t={t} running={running} onToggle={onToggle} />
      <button type="button" className={css.tableTitle} data-task-open={task.id} onClick={() => { onOpen(task.id) }}>
        {task.title}
      </button>
      <span className={css.tableCell} data-cell="project">
        {project === undefined ? t('view.noProject') : project.name}
      </span>
      <span className={`${css.tableCell} ${dueClass(task, todayIso)}`} data-cell="due">
        {task.dueDate === null ? t('view.noDue') : dateLabel(task.dueDate, todayIso, t)}
      </span>
      <span className={css.tableCell} data-cell="status">
        <span className={css.statusChip} data-status={status}>{statusLabel(t, status)}</span>
      </span>
    </div>
  )
}

/** The registered page. */
export function TasksPage({ locale, ...props }: TasksPageProps) {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <TasksView {...props} t={locale.bind(NS)} />
}

/** The tasks page: today, all tasks, projects, and an explicit-save detail drawer. */
export function TasksView({ call, running, onChanged, pageContext, registerLeaveGuard, navigation, route, ui, t }: TasksViewProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loaded, setLoaded] = useState(false)
  const [page, setPage] = useUiChoice<Page>(ui, 'page', ['today', 'tasks', 'projects'], 'today')
  const [layout, setLayout] = useUiChoice<Layout>(ui, 'layout', ['board', 'list'], 'board')
  const [projectFilter, setProjectFilter] = useUiField<string>(ui, 'projectFilter', '', (value): value is string => typeof value === 'string')
  const [priorityFilter, setPriorityFilter] = useUiChoice<PriorityFilter>(ui, 'priorityFilter', ['', '1', '2', '3'], '')
  const [query, setQuery] = useUiField<string>(ui, 'query', '', (value): value is string => typeof value === 'string')
  const [quickTitle, setQuickTitle] = useState('')
  const [draft, setDraft] = useState<Task>()
  const [saved, setSaved] = useState<Task>()
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [deleted, setDeleted] = useState<{ id: string; title: string }>()
  const [conflict, setConflict] = useState<string>()
  const detailRef = useRef<HTMLElement>(null)
  const [noteTitles, setNoteTitles] = useState<Record<string, string>>({})
  const [notesUnavailable, setNotesUnavailable] = useState(false)
  const [noteQuery, setNoteQuery] = useState('')
  const [noteResults, setNoteResults] = useState<NoteSummary[]>([])
  const [noteSearchUnavailable, setNoteSearchUnavailable] = useState(false)
  const { confirm: confirmLeave, dialog: confirmDialog } = useConfirm()
  const [projectDialog, setProjectDialog] = useState<{ mode: 'create' } | { mode: 'rename'; project: Project }>()
  const [projectName, setProjectName] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState<string>()
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 720px)').matches
      : false
  ))
  const tRef = useRef(t)
  tRef.current = t

  const todayIso = today()

  const load = useCallback(async () => {
    const [taskOutcome, projectOutcome] = await Promise.all([
      call('listTasks', { includeCompleted: true }),
      call('listProjects', {}),
    ])
    const list = valueOf<Task[]>(taskOutcome)
    if (list === undefined) {
      setLoadError(messageOf(taskOutcome) ?? tRef.current('view.loadFailed'))
      setLoaded(true)
      return
    }
    const projectList = valueOf<Project[]>(projectOutcome)
    setTasks(list)
    if (projectList !== undefined) setProjects(projectList)
    setLoadError(undefined)
    setError(undefined)
    setLoaded(true)
  }, [call])

  useEffect(() => { void load() }, [load])
  useEffect(() => onChanged(() => { void load() }), [onChanged, load])

  // The narrow state is a locator-friendly mirror of the css breakpoint; the
  // layout itself is pure css so no measurement is needed.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia('(max-width: 720px)')
    const update = () => { setNarrow(media.matches) }
    update()
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update) }
  }, [])

  // The undo offer is short-lived; deleting again replaces it.
  useEffect(() => {
    if (deleted === undefined) return undefined
    const timer = window.setTimeout(() => { setDeleted(undefined) }, UNDO_MS)
    return () => { window.clearTimeout(timer) }
  }, [deleted])

  const closeDetail = useCallback(() => {
    setDraft(undefined)
    setSaved(undefined)
    setNoteQuery('')
    setNoteResults([])
    setNoteSearchUnavailable(false)
  }, [])

  const openTask = useCallback(async (id: string) => {
    const outcome = await call('getTask', { id })
    const task = valueOf<Task>(outcome)
    if (task === undefined) {
      setDraft(undefined)
      setSaved(undefined)
      setError(messageOf(outcome) ?? tRef.current('view.loadFailed'))
      return
    }
    setDraft(task)
    setSaved(task)
    setConflict(undefined)
    setStatus(undefined)
    setError(undefined)
    setNoteQuery('')
    setNoteResults([])
    setNoteSearchUnavailable(false)
  }, [call])

  const openNew = useCallback(() => {
    const initial: Task = {
      id: '',
      title: '',
      notes: '',
      projectId: projectFilter === '' ? null : projectFilter,
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
    setNoteQuery('')
    setNoteResults([])
    setNoteSearchUnavailable(false)
  }, [projectFilter, todayIso])

  useEffect(() => {
    if (route?.appId === 'tasks' && route.record?.kind === 'task') void openTask(route.record.id)
  }, [openTask, route])

  const dirty = draft !== undefined && saved !== undefined && JSON.stringify(draft) !== JSON.stringify(saved)

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

  useModalFocus(draft !== undefined, detailRef, requestCloseDetail)

  useEffect(() => {
    if (draft === undefined) return pageContext.report({ label: t('app.name'), view: page })
    const label = draft.title.trim() === '' ? t('view.newTask') : draft.title
    if (draft.id === '') return pageContext.report({ label, view: 'detail', dirty })
    return pageContext.report({
      label,
      record: { appId: 'tasks', kind: 'task', id: draft.id },
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
      const value = valueOf<unknown>(outcome)
      const notes = notesOf(value)
      const next: Record<string, string> = {}
      for (const note of notes) next[note.id] = note.title
      setNoteTitles(next)
      setNotesUnavailable(outcome.status !== 'success' || notesUnavailableOf(value))
    })()
  }, [call, noteIdsKey])

  const createQuick = useCallback(async () => {
    const title = quickTitle.trim()
    if (title === '') return
    const outcome = await call('createTask', { title, dueDate: todayIso, priority: 2, assignee: 'me' })
    if (outcome.status !== 'success') {
      setError(messageOf(outcome) ?? t('view.saveFailed'))
      return
    }
    setQuickTitle('')
    setError(undefined)
    await load()
  }, [call, load, quickTitle, t, todayIso])

  const openCreateProject = useCallback(() => {
    setProjectName('')
    setProjectError(undefined)
    setProjectDialog({ mode: 'create' })
  }, [])

  const openRenameProject = useCallback((project: Project) => {
    setProjectName(project.name)
    setProjectError(undefined)
    setProjectDialog({ mode: 'rename', project })
  }, [])

  const submitProject = useCallback(async () => {
    /* v8 ignore next -- the submit control only renders with an open dialog */
    if (projectDialog === undefined) return
    const name = projectName.trim()
    if (name === '') { setProjectError(t('view.projectName')); return }
    if (projectDialog.mode === 'rename' && name === projectDialog.project.name) { setProjectDialog(undefined); return }
    setProjectBusy(true)
    setProjectError(undefined)
    const outcome = projectDialog.mode === 'create'
      ? await call('createProject', { name })
      : await call('updateProject', { id: projectDialog.project.id, expectedVersion: projectDialog.project.version, name })
    setProjectBusy(false)
    if (outcome.status !== 'success') { setProjectError(messageOf(outcome) ?? t('view.saveFailed')); return }
    setProjectDialog(undefined)
    setStatus(projectDialog.mode === 'create' ? t('view.projectCreated') : t('view.projectRenamed'))
    await load()
  }, [call, load, projectDialog, projectName, t])

  const toggleTask = useCallback(async (task: Task) => {
    const outcome = await call('updateTask', {
      id: task.id,
      expectedVersion: task.version,
      completed: task.completedAt === null,
    })
    if (outcome.status !== 'success') {
      if (hasAppCode(outcome, 'stale-version')) { setConflict(t('view.conflict')); return }
      setError(messageOf(outcome) ?? t('view.saveFailed'))
      return
    }
    setError(undefined)
    await load()
  }, [call, load, t])

  const save = useCallback(async () => {
    /* v8 ignore next -- the save button only exists while a draft is open */
    if (draft === undefined) return
    const title = draft.title.trim()
    if (title === '') {
      setError(t('view.titleRequired'))
      return
    }
    const patch = {
      title,
      notes: draft.notes,
      projectId: draft.projectId,
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
    const task = valueOf<Task>(outcome)
    if (task === undefined) {
      if (hasAppCode(outcome, 'stale-version')) { setConflict(t('view.conflict')); return }
      setError(messageOf(outcome) ?? t('view.saveFailed'))
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
    const outcome = await call('deleteTask', { id: draft.id })
    if (outcome.status !== 'success') {
      setError(messageOf(outcome) ?? t('view.saveFailed'))
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
      setError(messageOf(outcome) ?? t('view.saveFailed'))
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
    const value = valueOf<unknown>(outcome)
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

  const projectsById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects])
  const needle = query.trim().toLocaleLowerCase()
  const visibleTasks = useMemo(() => tasks.filter(task => {
    if (projectFilter !== '' && task.projectId !== projectFilter) return false
    if (priorityFilter !== '' && task.priority !== Number(priorityFilter)) return false
    if (needle === '') return true
    if (task.title.toLocaleLowerCase().includes(needle)) return true
    if (task.notes.toLocaleLowerCase().includes(needle)) return true
    const projectName = task.projectId === null ? '' : (projectsById.get(task.projectId)?.name ?? '')
    return projectName.toLocaleLowerCase().includes(needle)
  }).sort(compareTasks), [needle, priorityFilter, projectFilter, projectsById, tasks])

  const visibleProjects = useMemo(() => projects.filter(project => (
    needle === '' || project.name.toLocaleLowerCase().includes(needle)
  )), [needle, projects])

  const projectStats = useMemo(() => {
    const counts = new Map<string, { open: number; done: number; total: number }>()
    for (const task of tasks) {
      if (task.projectId === null) continue
      const current = counts.get(task.projectId) ?? { open: 0, done: 0, total: 0 }
      if (task.completedAt === null) current.open += 1
      else current.done += 1
      current.total += 1
      counts.set(task.projectId, current)
    }
    return counts
  }, [tasks])

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
  const filtersActive = query.trim() !== '' || projectFilter !== '' || priorityFilter !== ''
  const boardColumns = [
    { id: 'todo', title: t('view.statusTodo'), tasks: visibleTasks.filter(task => statusOf(task, todayIso) === 'todo') },
    { id: 'doing', title: t('view.statusDoing'), tasks: visibleTasks.filter(task => statusOf(task, todayIso) === 'doing') },
    { id: 'done', title: t('view.statusDone'), tasks: visibleTasks.filter(task => statusOf(task, todayIso) === 'done') },
  ]
  const shownError = error ?? loadError
  const isNew = draft !== undefined && draft.id === ''
  const detailTitle = isNew ? t('view.newTask') : t('view.detail')

  return (
    <div
      className={css.page}
      data-tasks-page
      data-page={page}
      data-narrow={narrow ? 'true' : 'false'}
      data-detail={draft === undefined ? 'false' : 'true'}
    >
      <div className={css.topBar} data-tasks-topbar>
        <TabBar
          tabs={[
            { id: 'today', label: t('view.today'), anchor: { 'data-tasks-tab': 'today' } },
            { id: 'tasks', label: t('view.tasks'), anchor: { 'data-tasks-tab': 'tasks' } },
            { id: 'projects', label: t('view.projects'), anchor: { 'data-tasks-tab': 'projects' } },
          ]}
          active={page}
          onSelect={id => {
            setPage(id as Page)
            setProjectFilter('')
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
                placeholder={page === 'projects' ? t('view.searchProjects') : t('view.search')}
                aria-label={page === 'projects' ? t('view.searchProjects') : t('view.search')}
                data-tasks-search
              />
              <button
                type="button"
                className={`${css.button} ${css.topProjectButton}`}
                onClick={() => { openCreateProject() }}
                disabled={running}
                data-tasks-new-project
              >
                {t('view.newProject')}
              </button>
              <button
                type="button"
                className={`${css.button} ${css.primary}`}
                onClick={openNew}
                disabled={running}
                data-tasks-new-task
              >
                {t('view.newTask')}
              </button>
            </>
          )}
        />
      </div>

      {shownError === undefined ? null : (
        <div className={css.errorBar} role="alert" data-tasks-error>{shownError}</div>
      )}
      {conflict === undefined || draft !== undefined ? null : (
        <div className={css.errorBar} role="alert" data-task-conflict-page>
          <span>{conflict}</span>
          <button type="button" className={css.button} onClick={() => { setConflict(undefined); void load() }} data-task-reload-page>
            {t('view.reload')}
          </button>
        </div>
      )}

      {!loaded ? (
        <div className={css.centerState} data-tasks-loading>{t('view.loading')}</div>
      ) : loadError !== undefined && tasks.length === 0 ? (
        <div className={css.centerState} data-tasks-error-state>{loadError}</div>
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
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void createQuick()
                      }
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
                      <button type="button" className={css.button} onClick={() => { setQuery(''); setProjectFilter(''); setPriorityFilter('') }} data-today-clear-filters>{t('view.clearFilters')}</button>
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
                          project={task.projectId === null ? undefined : projectsById.get(task.projectId)}
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
          ) : page === 'tasks' ? (
            <div className={css.scroll} data-tasks-view>
              <div className={`${css.inner} ${css.innerWide}`}>
                <header className={css.pageHead}>
                  <div>
                    <h1 className={css.pageTitle}>{t('view.tasks')}</h1>
                    <div className={css.caption} data-tasks-count>{t('view.taskCount', { count: visibleTasks.length })}</div>
                  </div>
                </header>

                <div className={css.toolbar} data-tasks-toolbar>
                  <select
                    className={css.select}
                    value={projectFilter}
                    onChange={event => { setProjectFilter(event.target.value) }}
                    aria-label={t('view.filterProject')}
                    data-task-filter-project
                  >
                    <option value="">{t('view.allProjects')}</option>
                    {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                  <select
                    className={css.select}
                    value={priorityFilter}
                    onChange={event => { setPriorityFilter(event.target.value as PriorityFilter) }}
                    aria-label={t('view.filterPriority')}
                    data-task-filter-priority
                  >
                    <option value="">{t('view.allPriorities')}</option>
                    <option value="1">{t('view.priorityHigh')}</option>
                    <option value="2">{t('view.priorityMedium')}</option>
                    <option value="3">{t('view.priorityLow')}</option>
                  </select>
                  <span className={css.toolbarSpacer} />
                  <div className={css.seg} data-tasks-layout-group>
                    <button
                      type="button"
                      className={`${css.segButton} ${layout === 'board' ? css.segActive : ''}`}
                      aria-pressed={layout === 'board'}
                      onClick={() => { setLayout('board') }}
                      data-tasks-layout="board"
                    >
                      {t('view.board')}
                    </button>
                    <button
                      type="button"
                      className={`${css.segButton} ${layout === 'list' ? css.segActive : ''}`}
                      aria-pressed={layout === 'list'}
                      onClick={() => { setLayout('list') }}
                      data-tasks-layout="list"
                    >
                      {t('view.list')}
                    </button>
                  </div>
                </div>

                {layout === 'list' ? (
                  <div className={css.table} role="table" data-task-list>
                    <div className={css.tableHead} role="row">
                      <span role="columnheader" aria-label={t('view.columnStatus')} />
                      <span role="columnheader">{t('view.columnTask')}</span>
                      <span role="columnheader">{t('view.columnProject')}</span>
                      <span role="columnheader">{t('view.columnDue')}</span>
                      <span role="columnheader">{t('view.columnStatus')}</span>
                    </div>
                    {visibleTasks.length === 0 ? (
                      <EmptyState compact title={t('view.noMatching')} body={t('view.noMatchingHint')} data-task-list-empty />
                    ) : visibleTasks.map(task => (
                      <TableRow
                        key={task.id}
                        task={task}
                        project={task.projectId === null ? undefined : projectsById.get(task.projectId)}
                        t={t}
                        todayIso={todayIso}
                        running={running}
                        onOpen={id => { void openTask(id) }}
                        onToggle={taskToToggle => { void toggleTask(taskToToggle) }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={css.board} data-task-board>
                    {boardColumns.map(column => (
                      <section key={column.id} className={css.column} data-board-column={column.id}>
                        <header className={css.columnHead}>
                          <h2 className={css.columnTitle}>{column.title}</h2>
                          <span className={css.columnCount}>{column.tasks.length}</span>
                        </header>
                        <div className={css.cards}>
                          {column.tasks.length === 0 ? (
                            <EmptyState compact title={t('view.columnEmpty')} data-board-empty={column.id} />
                          ) : column.tasks.map(task => (
                            <BoardCard
                              key={task.id}
                              task={task}
                              project={task.projectId === null ? undefined : projectsById.get(task.projectId)}
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
          ) : (
            <div className={css.scroll} data-projects-view>
              <div className={css.inner}>
                <header className={css.pageHead}>
                  <div>
                    <h1 className={css.pageTitle}>{t('view.projects')}</h1>
                    <div className={css.caption} data-projects-count>{t('view.projectCount', { count: visibleProjects.length })}</div>
                  </div>
                  <button
                    type="button"
                    className={css.button}
                    onClick={() => { openCreateProject() }}
                    disabled={running}
                    data-projects-new
                  >
                    {t('view.newProject')}
                  </button>
                </header>

                {visibleProjects.length === 0 ? (
                  <EmptyState title={t('view.projectsEmpty')} body={t('view.projectsEmptyHint')} data-projects-empty />
                ) : (
                  <div className={css.projectsGrid}>
                    {visibleProjects.map(project => {
                      const stats = projectStats.get(project.id) ?? { open: 0, done: 0, total: 0 }
                      const percent = percentOf(stats.done, stats.total)
                      return (
                        <article key={project.id} className={css.projectCard} data-project-card={project.id}>
                          <div className={css.projectTop}>
                            <i className={css.projectDotLarge} data-tone={projectTone(project.id)} aria-hidden="true" />
                            <button
                              type="button"
                              className={css.projectName}
                              onClick={() => {
                                setProjectFilter(project.id)
                                setPriorityFilter('')
                                setQuery('')
                                setPage('tasks')
                              }}
                              data-project-open={project.id}
                            >
                              {project.name}
                            </button>
                            <button
                              type="button"
                              className={css.projectRename}
                              onClick={() => { openRenameProject(project) }}
                              disabled={running}
                              data-project-rename={project.id}
                            >
                              {t('view.rename')}
                            </button>
                          </div>
                          <div className={css.progressTrack} data-project-progress>
                            <i className={css.progressFill} data-tone={projectTone(project.id)} style={{ width: `${String(percent)}%` }} />
                          </div>
                          <div className={css.projectFoot}>
                            <span>{t('view.projectOpen', { count: stats.open })}</span>
                            <span aria-hidden="true">·</span>
                            <span>{t('view.projectDone', { count: stats.done })}</span>
                            <span className={css.projectPercent} data-project-percent>{`${String(percent)}%`}</span>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {draft === undefined ? null : (
            <>
              <div className={css.scrim} data-task-scrim onClick={requestCloseDetail} />
              <aside
                ref={detailRef}
                className={css.detail}
                data-task-detail
                data-task-detail-full={narrow ? 'true' : 'false'}
                role="dialog"
                aria-modal="true"
                tabIndex={-1}
                aria-label={detailTitle}
              >
                <header className={css.detailHead}>
                  <h2 className={css.detailTitle}>{detailTitle}</h2>
                  <span className={css.detailState} data-task-dirty={dirty ? 'true' : 'false'}>
                    {dirty ? t('view.unsaved') : ''}
                  </span>
                  <button type="button" className={css.closeButton} onClick={requestCloseDetail} aria-label={t('view.close')} data-task-close>
                    ×
                  </button>
                </header>

                <div className={css.detailBody}>
                  {conflict === undefined ? null : (
                    <div className={css.errorBar} role="alert" data-task-conflict>
                      <span>{conflict}</span>
                      <button type="button" className={css.button} onClick={() => { if (draft.id !== '') void openTask(draft.id) }} data-task-reload>
                        {t('view.reload')}
                      </button>
                    </div>
                  )}
                  <div className={css.field}>
                    <label htmlFor="task-title">{t('view.title')}</label>
                    <input
                      id="task-title"
                      value={draft.title}
                      onChange={event => { setDraft({ ...draft, title: event.target.value }) }}
                      placeholder={t('view.titlePlaceholder')}
                      data-task-title
                    />
                  </div>

                  <div className={css.fieldRow}>
                    <div className={css.field}>
                      <label htmlFor="task-priority">{t('view.priority')}</label>
                      <select
                        id="task-priority"
                        value={draft.priority}
                        onChange={event => { setDraft({ ...draft, priority: Number(event.target.value) as Task['priority'] }) }}
                        data-task-priority
                      >
                        <option value="1">{t('view.priorityHigh')}</option>
                        <option value="2">{t('view.priorityMedium')}</option>
                        <option value="3">{t('view.priorityLow')}</option>
                      </select>
                    </div>
                    <div className={css.field}>
                      <label htmlFor="task-project">{t('view.project')}</label>
                      <select
                        id="task-project"
                        value={draft.projectId ?? ''}
                        onChange={event => { setDraft({ ...draft, projectId: event.target.value === '' ? null : event.target.value }) }}
                        data-task-project
                      >
                        <option value="">{t('view.noProject')}</option>
                        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className={css.fieldRow}>
                    <div className={css.field}>
                      <label htmlFor="task-due">{t('view.due')}</label>
                      <input
                        id="task-due"
                        type="date"
                        value={draft.dueDate ?? ''}
                        onChange={event => { setDraft({ ...draft, dueDate: event.target.value === '' ? null : event.target.value }) }}
                        data-task-due
                      />
                    </div>
                    <div className={css.field}>
                      <label htmlFor="task-assignee">{t('view.assignee')}</label>
                      <select
                        id="task-assignee"
                        value={draft.assignee}
                        onChange={event => { setDraft({ ...draft, assignee: event.target.value as Task['assignee'] }) }}
                        data-task-assignee
                      >
                        <option value="me">{t('view.me')}</option>
                        <option value="agent">{t('view.agent')}</option>
                      </select>
                    </div>
                  </div>

                  <div className={css.field}>
                    <label htmlFor="task-notes">{t('view.description')}</label>
                    <textarea
                      id="task-notes"
                      value={draft.notes}
                      onChange={event => { setDraft({ ...draft, notes: event.target.value }) }}
                      placeholder={t('view.descriptionPlaceholder')}
                      data-task-description
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
                </div>

                <footer className={css.footer}>
                  {isNew ? null : (
                    <button
                      type="button"
                      className={`${css.button} ${css.danger}`}
                      onClick={() => { void remove() }}
                      disabled={running}
                      data-task-delete
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
                      data-task-complete
                    >
                      {draft.completedAt === null ? t('view.complete') : t('view.reopen')}
                    </button>
                  )}
                  <span className={css.footerSpacer} />
                  <button type="button" className={css.button} onClick={requestCloseDetail} data-task-cancel>
                    {t('view.cancel')}
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.primary}`}
                    onClick={() => { void save() }}
                    disabled={running || !dirty || conflict !== undefined}
                    data-task-save
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
      <Modal
        open={projectDialog !== undefined}
        onClose={() => { if (!projectBusy) setProjectDialog(undefined) }}
        title={projectDialog?.mode === 'rename' ? t('view.rename') : t('view.newProject')}
        closeLabel={t('view.close')}
        footer={(
          <>
            <Button size="sm" variant="ghost" disabled={projectBusy} onClick={() => { setProjectDialog(undefined) }}>{t('view.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={projectBusy} onClick={() => { void submitProject() }} data-task-project-submit>{t('view.save')}</Button>
          </>
        )}
      >
        <label className={css.projectField}>
          <span>{projectDialog?.mode === 'rename' ? t('view.renameProject') : t('view.projectName')}</span>
          <input autoFocus value={projectName} onChange={event => { setProjectName(event.target.value) }} data-task-project-name />
        </label>
        {projectError === undefined ? null : <p className={css.inlineError} role="alert" data-task-project-error>{projectError}</p>}
      </Modal>
      {status === undefined ? null : <div className={css.toast} role="status" data-tasks-status>{status}</div>}
      {deleted === undefined ? null : (
        <div className={css.undo} role="status" data-tasks-undo>
          <span>{t('view.deletedNotice', { title: deleted.title })}</span>
          <button type="button" onClick={() => { void undoRemove() }} data-tasks-undo-action>{t('view.undo')}</button>
        </div>
      )}
    </div>
  )
}
