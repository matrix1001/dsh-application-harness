import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { EmptyState, LocalFailure, ReadFailure, TabBar, failureKindOf, hasAppCode, outcomeMessage, outcomeValue, safeHrefForExternal, renderMarkdown, useConfirm, useModalFocus, useUiChoice, useUiField, type FailureKind } from '@matrix1001/dsh-application-harness-client-chrome'
import { ObjectReference } from '@matrix1001/dsh-application-harness-client-object-reference'
import { Button, FenceCodeBlock, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconEllipsisOutlineRegular, IconQueueOutlineRegular, Menu, MenuItemButton, Modal } from '@matrix1001/dsh-application-harness-client-chrome'
import { NS } from './locales.ts'
import css from './InboxView.module.css'

/** The translate face this page needs. */
export type InboxTranslate = TranslateNS<'inbox'>

/** The props of the registered page. */
export interface InboxPageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface InboxViewProps extends ApplicationViewProps { t: InboxTranslate }

type Tab = 'inbox' | 'saved' | 'sources'
type Filter = 'all' | 'unread'
type Layout = 'source' | 'time'
type DialogKind = 'link' | 'source' | 'sourceEdit' | 'opml' | 'settings'
/** Which one of the empty states the list shows. */
type EmptyKind = 'first' | 'ready' | 'paused' | 'filtered' | 'search' | 'saved'

interface Entry {
  id: string
  sourceId?: string
  sourceKind: string
  externalId: string
  url: string
  title: string
  summary: string
  content: string
  publishedAt?: number
  fetchedAt: number
  readAt?: number
  seenAt?: number
  favorite: boolean
  taskId?: string
  noteId?: string
}

/** How one stored cross-application reference currently reads. */
type LinkState = 'alive' | 'missing' | 'unknown'
interface LinkInfo { state: LinkState; title?: string }
/** One reference as the page's resolve face expects it. */
type ObjectRefValue = Parameters<NonNullable<ApplicationViewProps['resolveObject']>>[0]

interface Source {
  id: string
  kind: string
  name: string
  url: string
  enabled: boolean
  intervalMs: number
  repo?: string
  removed: boolean
  lastCheckedAt?: number
  lastSuccessAt?: number
  lastError?: string
  version: number
  entryCount: number
  unreadCount: number
  latestAt?: number
}

interface Settings {
  retentionDays: number
  maxEntries: number
  maxBytes: number
  githubRefreshMs: number
  feedRefreshMs: number
}

interface Counts { unread: number; unseen: number; saved: number; all: number }
interface ListResult { entries: Entry[]; total: number; filteredUnread?: number; counts: Counts }
interface Group {
  sourceId?: string
  name: string
  kind: string
  removed: boolean
  enabled: boolean
  total: number
  unread: number
  latestAt: number
  entries: Entry[]
  hasMore: boolean
}
interface GroupsResult { groups: Group[]; total: number; filteredUnread?: number; totalGroups: number; counts: Counts }
interface SourcesResult { sources: Source[]; health: { total: number; ok: number; error: number; paused: number } }

type Outcome = Awaited<ReturnType<ApplicationViewProps['call']>>

function plainSummary(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/\*\*|__|`|~~/gu, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}
function permissionRefusal(outcome: Outcome): boolean {
  return outcome.status === 'failed' && hasAppCode(outcome, 'app.capability-not-approved')
}
function errorText(outcome: Outcome, fallback: string, t: InboxTranslate): string {
  return permissionRefusal(outcome) ? t('view.saveNoPermission') : (outcomeMessage(outcome) ?? fallback)
}

function when(value: number | undefined, locale: string): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/**
 * Whether one entry still belongs to the list of the given tab and filter.
 * Writes never change the source-kind or search filters, so only these facts
 * decide whether a written entry has to leave the visible list.
 * @param target - the entry after the write.
 * @param tab - the active tab.
 * @param filter - the active filter chip.
 * @returns whether the entry still matches.
 */
/** The host of one source URL, used when a stored name is only an auto-generated number. */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** A source's display name; an empty name falls back to its host. */
function displaySourceName(source: Source): string {
  return source.name === '' ? hostOfUrl(source.url) : source.name
}

/** The stable key one source group uses in the page's view state. */
function groupKeyOf(group: Group): string {
  return group.sourceId ?? 'manual'
}

function entryMatchesView(target: Pick<Entry, 'favorite' | 'readAt'>, tab: Tab, filter: Filter): boolean {
  if (tab === 'saved' && !target.favorite) return false
  if (filter === 'unread' && target.readAt !== undefined) return false
  return true
}

/** The registered page: bind the dictionary and render the inbox body. */
export function InboxPage({ locale, ...props }: InboxPageProps) {
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <InboxView {...props} t={locale.bind(NS)} language={snapshot.active} />
}

/** The inbox page: inbox / saved / sources, a reader and the small management dialogs. */
export function InboxView({ call, running, onChanged, pageContext, registerLeaveGuard, route, ui, t, language = 'zh', navigation, resolveObject, openManagement }: InboxViewProps & { language?: string }) {
  const [tab, setTab] = useUiChoice<Tab>(ui, 'tab', ['inbox', 'saved', 'sources'], 'inbox')
  const [filter, setFilter] = useUiChoice<Filter>(ui, 'filter', ['all', 'unread'], 'all')
  const [layout, setLayout] = useUiChoice<Layout>(ui, 'layout', ['source', 'time'], 'source')
  const [sourceFilter, setSourceFilter] = useUiField<string>(ui, 'sourceFilter', '', (value): value is string => typeof value === 'string')
  const [collapsedGroups, setCollapsedGroups] = useUiField<Record<string, boolean>>(ui, 'collapsedGroups', {}, (value): value is Record<string, boolean> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    return Object.values(value).every(item => typeof item === 'boolean')
  })
  const [kind, setKind] = useUiField<string>(ui, 'kind', '', (value): value is string => typeof value === 'string')
  const [query, setQuery] = useUiField<string>(ui, 'query', '', (value): value is string => typeof value === 'string')
  const [search, setSearch] = useState(query)
  const [entries, setEntries] = useState<Entry[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [entriesLoaded, setEntriesLoaded] = useState(false)
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [readFailure, setReadFailure] = useState<{ readonly kind: FailureKind; readonly code?: string; readonly message?: string }>()
  const [listFailure, setListFailure] = useState<{ readonly code?: string; readonly message?: string }>()
  const entriesLoadedRef = useRef(false)
  entriesLoadedRef.current = entriesLoaded
  const entriesRef = useRef<Entry[]>([])
  entriesRef.current = entries
  const [total, setTotal] = useState(0)
  const [filteredUnread, setFilteredUnread] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const requestEpoch = useRef(0)
  const [counts, setCounts] = useState<Counts>({ unread: 0, unseen: 0, saved: 0, all: 0 })
  const [selected, setSelected] = useState<string>()
  const readerRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  /** The next successful first open asks for focus in the reader. */
  const focusReader = useRef(false)
  /** The list row a reader close should return focus to. */
  const returnFocus = useRef<string>()
  const [groupMenu, setGroupMenu] = useState<string>()
  const searchActive = search.trim() !== ''
  const grouped = tab === 'inbox' && layout === 'source' && !searchActive
  const allCollapsed = groups.length > 0 && groups.every(group => collapsedGroups[groupKeyOf(group)] === true)
  /** The latest tab/filter/layout, for write handlers that reconcile the list. */
  const viewRef = useRef({ tab, filter, grouped })
  viewRef.current = { tab, filter, grouped }
  const [entry, setEntry] = useState<Entry>()
  const [readerError, setReaderError] = useState<string>()
  const [sources, setSources] = useState<Source[]>([])
  const [health, setHealth] = useState({ total: 0, ok: 0, error: 0, paused: 0 })
  const [settings, setSettings] = useState<Settings>()
  const [settingsError, setSettingsError] = useState<string>()
  const [error, setError] = useState<string>()
  const [sourceError, setSourceError] = useState<string>()
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [taskLink, setTaskLink] = useState<LinkInfo>()
  const [noteLink, setNoteLink] = useState<LinkInfo>()
  const [linking, setLinking] = useState(false)
  const linkTicket = useRef(0)
  const entryRef = useRef<Entry>()
  entryRef.current = entry
  const [dialog, setDialog] = useState<DialogKind>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeDialog = useCallback(() => { setDialog(undefined) }, [])
  useModalFocus(dialog !== undefined, dialogRef, closeDialog)
  const [draft, setDraft] = useState({ url: '', title: '', kind: 'rss', name: '', repo: '', interval: '', opml: '' })
  const [dialogError, setDialogError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Source>()
  const [editTarget, setEditTarget] = useState<Source>()
  const [editDraft, setEditDraft] = useState({ name: '', interval: '' })
  const { confirm, dialog: confirmDialog } = useConfirm()
  const tRef = useRef(t)
  tRef.current = t
  const contextRef = useRef(pageContext)
  contextRef.current = pageContext

  // Success feedback is transient: a full-width banner that never leaves pushed
  // the list down and made an old result look like the current state.
  useEffect(() => {
    if (notice === undefined) return undefined
    const timer = window.setTimeout(() => { setNotice(undefined) }, 4000)
    return () => { window.clearTimeout(timer) }
  }, [notice])

  interface ListOverrides {
    tab?: Tab
    filter?: Filter
    kind?: string
    search?: string
    sourceFilter?: string
    layout?: Layout
  }

  const listArgs = useCallback((overrides: ListOverrides = {}) => {
    const nextTab = overrides.tab ?? tab
    const nextFilter = overrides.filter ?? filter
    const nextKind = overrides.kind ?? kind
    const nextSearch = overrides.search ?? search
    const nextSource = overrides.sourceFilter ?? sourceFilter
    const args: Record<string, unknown> = { view: nextTab === 'saved' ? 'saved' : 'inbox' }
    if (nextFilter === 'unread') args.unread = true
    if (nextSource === 'manual') args.kind = 'manual'
    else {
      if (nextSource.startsWith('source:')) {
        const sourceId = nextSource.slice('source:'.length)
        if (sourceId !== '') args.sourceId = sourceId
      }
      if (nextKind !== '') args.kind = nextKind
    }
    if (nextSearch.trim() !== '') args.search = nextSearch.trim()
    return args
  }, [tab, filter, kind, search, sourceFilter])

  const usesGroups = useCallback((overrides: ListOverrides = {}): boolean => {
    const nextTab = overrides.tab ?? tab
    const nextLayout = overrides.layout ?? layout
    const nextSearch = overrides.search ?? search
    return nextTab === 'inbox' && nextLayout === 'source' && nextSearch.trim() === ''
  }, [tab, layout, search])

  const loadCurrent = useCallback(async (overrides: ListOverrides = {}, append = false) => {
    const useGroups = usesGroups(overrides)
    const request: Record<string, unknown> = listArgs(overrides)
    if (useGroups) request.perGroup = 3
    else if (append) request.offset = entriesRef.current.length
    const epoch = ++requestEpoch.current
    const outcome = await call(useGroups ? 'listGroups' : 'listEntries', request as never)
    if (epoch !== requestEpoch.current) return
    const failure = failureKindOf(outcome)
    const failed = outcome !== undefined && outcome.status !== 'success' && outcome.status !== 'cancelled'
    const code = failed ? outcome.error?.code : undefined
    const message = failed ? outcome.error?.message : undefined
    const result = outcomeValue<ListResult | GroupsResult>(outcome)
    if (result === undefined) {
      // A refresh that cannot answer keeps the entries already read: the list
      // only becomes a ReadFailure when this page has never loaded entries.
      // The stale list gets its own local failure line with a retry.
      if (entriesLoadedRef.current) {
        setListFailure({
          ...(code === undefined ? {} : { code }),
          ...(message === undefined ? {} : { message }),
        })
        return
      }
      setReadFailure({
        kind: failure,
        ...(code === undefined ? {} : { code }),
        ...(message === undefined ? {} : { message }),
      })
      setError(undefined)
      return
    }
    if (useGroups) {
      const groupedResult = result as GroupsResult
      if (!Array.isArray(groupedResult.groups)) {
        if (entriesLoadedRef.current) setListFailure({ message: 'inbox: listGroups returned no groups' })
        else setReadFailure({ kind: 'other', message: 'inbox: listGroups returned no groups' })
        return
      }
      setGroups(groupedResult.groups)
      setEntries([])
      setTotal(groupedResult.total)
      setFilteredUnread(groupedResult.filteredUnread ?? groupedResult.groups.reduce((sum, group) => sum + group.unread, 0))
      setCounts(groupedResult.counts)
    } else {
      const flat = result as ListResult
      if (append) {
        setEntries((current) => {
          const known = new Set(current.map(item => item.id))
          return [...current, ...flat.entries.filter(item => !known.has(item.id))]
        })
      } else {
        setEntries(flat.entries)
      }
      setGroups([])
      setTotal(flat.total)
      setFilteredUnread(flat.filteredUnread ?? flat.counts.unread)
      setCounts(flat.counts)
    }
    setEntriesLoaded(true)
    setReadFailure(undefined)
    setListFailure(undefined)
    setError(undefined)
  }, [call, listArgs, usesGroups])

  const loadMore = useCallback(async () => {
    /* v8 ignore next -- the button is hidden once the last page is loaded; this guards a double click */
    if (loadingMore || grouped || entries.length >= total) return
    setLoadingMore(true)
    try { await loadCurrent({}, true) } finally { setLoadingMore(false) }
  }, [entries.length, grouped, loadCurrent, loadingMore, total])

  const loadSources = useCallback(async () => {
    const outcome = await call('listSources', { includeRemoved: true })
    const value = outcomeValue<SourcesResult>(outcome)
    setSourcesLoaded(true)
    if (value === undefined) {
      if (failureKindOf(outcome) === 'not-approved') { setSourceError(undefined); return }
      setSourceError(outcomeMessage(outcome) ?? tRef.current('view.loadFailed'))
      return
    }
    setSources(value.sources)
    setHealth(value.health)
    setSourceError(undefined)
  }, [call])

  const loadSettings = useCallback(async () => {
    const outcome = await call('settings', {})
    const value = outcomeValue<Settings>(outcome)
    if (value === undefined) {
      if (failureKindOf(outcome) === 'not-approved') { setSettingsError(undefined); return }
      setSettingsError(outcomeMessage(outcome) ?? tRef.current('view.loadFailed'))
      return
    }
    setSettings(value)
    setSettingsError(undefined)
  }, [call])

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query) }, 250)
    return () => { clearTimeout(timer) }
  }, [query])

  useEffect(() => {
    if (tab !== 'sources') void loadCurrent()
  }, [tab, loadCurrent])
  useEffect(() => { void loadSources() }, [loadSources])
  useEffect(() => { void loadSettings() }, [loadSettings])
  useEffect(() => onChanged(() => {
    if (viewRef.current.tab !== 'sources') void loadCurrent()
    void loadSources()
  }), [onChanged, loadCurrent, loadSources])
  // A new filter or search is a new list: showing the previous scroll offset
  // would land the reader in the middle (or the end) of the new result set.
  useEffect(() => {
    if (rowsRef.current !== null) rowsRef.current.scrollTop = 0
  }, [tab, filter, kind, search, sourceFilter, layout])
  useEffect(() => {
    if (entry === undefined) { contextRef.current.report({ label: tRef.current('view.inbox') }); return undefined }
    return contextRef.current.report({
      label: entry.title,
      record: { appId: 'inbox', kind: 'entry', id: entry.id },
      view: tab,
      filters: { view: tab, read: entry.readAt === undefined ? 'unread' : 'read' },
    })
  }, [entry, tab])
  useEffect(() => {
    if (registerLeaveGuard === undefined) return undefined
    return registerLeaveGuard(() => true)
  }, [registerLeaveGuard])

  const patchEntry = useCallback((id: string, patch: Partial<Entry>) => {
    setEntry(current => current !== undefined && current.id === id ? { ...current, ...patch } : current)
    setEntries(current => current.map(item => item.id === id ? { ...item, ...patch } : item))
    setGroups(current => current.map(group => ({
      ...group,
      entries: group.entries.map(item => item.id === id ? { ...item, ...patch } : item),
    })))
  }, [])

  const replaceEntry = useCallback((next: Entry) => {
    setEntry(next)
    setEntries(current => current.map(item => item.id === next.id ? next : item))
    setGroups(current => current.map(group => ({
      ...group,
      entries: group.entries.map(item => item.id === next.id ? next : item),
    })))
  }, [])

  /**
   * Reconcile a written entry with the list's tab/filter. A write that moves
   * the entry out of view drops the row and its total; a write that moves an
   * unlisted entry back into view re-reads the list. The reader keeps its own
   * copy either way, so the open entry never blanks out under the user.
   */
  const syncEntryVisibility = useCallback((next: Entry): void => {
    if (viewRef.current.grouped) {
      void loadCurrent()
      return
    }
    const visible = entryMatchesView(next, viewRef.current.tab, viewRef.current.filter)
    const listed = entriesRef.current.some(item => item.id === next.id)
    if (visible) {
      if (!listed) void loadCurrent()
      return
    }
    if (!listed) return
    setEntries(current => current.filter(item => item.id !== next.id))
    setTotal(current => Math.max(0, current - 1))
  }, [loadCurrent])
  // Opening stays stable for the route effect; the handlers below only need the
  // latest reconciliation, never a new callback identity.
  const syncEntryRef = useRef(syncEntryVisibility)
  syncEntryRef.current = syncEntryVisibility

  const opening = useRef<string>()
  const open = useCallback(async (id: string, moveFocus = true): Promise<{ readonly ok: boolean; readonly missing: boolean }> => {
    opening.current = id
    setSelected(id)
    setEntry(undefined)
    setReaderError(undefined)
    try {
      const outcome = await call('getEntry', { id })
      const value = outcomeValue<Entry>(outcome)
      if (value === undefined) {
        setReaderError(outcomeMessage(outcome) ?? tRef.current('view.loadFailed'))
        return { ok: false, missing: hasAppCode(outcome, 'not-found') }
      }
      setEntry(value)
      // Opening takes focus: on a narrow screen the list is hidden, so the
      // reader must become the active element. A refresh of an entry that is
      // already open moves nothing.
      if (moveFocus) focusReader.current = true
      setError(undefined)
      // Opening an entry is reading it: the unread count and the filter react
      // immediately, while the reader keeps its copy of the entry.
      if (value.readAt === undefined) {
        const read = await call('markRead', { ids: [id], read: true })
        if (read.status === 'success') {
          const readAt = Date.now()
          const next = { ...value, readAt, seenAt: value.seenAt ?? readAt }
          patchEntry(id, { readAt, seenAt: next.seenAt })
          setCounts(current => ({ ...current, unread: Math.max(0, current.unread - 1) }))
          setFilteredUnread(current => Math.max(0, current - 1))
          if (viewRef.current.grouped) void loadCurrent()
          else syncEntryRef.current(next)
        }
      }
      return { ok: true, missing: false }
    } finally {
      if (opening.current === id) opening.current = undefined
    }
  }, [call, loadCurrent, patchEntry])

  useEffect(() => {
    if (selected === undefined || entry !== undefined || readerError !== undefined) return
    // A row click already opened this entry; opening it again here would fetch
    // and resolve the same entry twice.
    if (opening.current === selected) return
    void open(selected)
  }, [entry, open, readerError, selected])

  // A return from another application lands here with the origin record. The
  // page is master of its own reader: consume the route by opening the entry,
  // and fall back to the list when the record is gone.
  useEffect(() => {
    const target = route?.record
    if (route?.appId !== 'inbox' || target === undefined || target.kind !== 'entry') return
    if (target.appId !== undefined && target.appId !== 'inbox') return
    if (route.view === 'inbox' || route.view === 'saved' || route.view === 'sources') setTab(route.view)
    setNotice(undefined)
    void open(target.id).then((result) => {
      if (result.ok || !result.missing) return
      setReaderError(undefined)
      setEntry(undefined)
      setSelected(undefined)
      setNotice(tRef.current('view.recordGone'))
    })
  }, [route, open])

  // Opening moves focus into the reader; a failed open keeps the list focus.
  useEffect(() => {
    if (entry === undefined || !focusReader.current) return
    focusReader.current = false
    readerRef.current?.focus()
  }, [entry])

  // Closing the reader returns focus to the row that opened it. When that row
  // was dropped from the filtered list, the list pane takes the focus instead.
  useEffect(() => {
    const id = returnFocus.current
    if (id === undefined || entry !== undefined || selected !== undefined) return
    returnFocus.current = undefined
    const row = rowRefs.current.get(id)
    if (row?.isConnected === true) {
      row.focus()
      return
    }
    listRef.current?.focus()
  }, [entry, readerError, selected])

  /** Close the reader and hand focus back to the entry's list row. */
  const closeReader = (): void => {
    returnFocus.current = entry?.id ?? selected
    setSelected(undefined)
    setEntry(undefined)
    setReaderError(undefined)
  }

  const resolveLink = useCallback(async (ref: ObjectRefValue): Promise<LinkInfo> => {
    if (resolveObject === undefined) return { state: 'unknown' }
    try {
      const result = await resolveObject(ref)
      if (result.ok) return { state: 'alive', title: result.value.title }
      // `app.not-found` is the owning application saying the object is gone.
      // Every other code means the reference could not be checked, which is a
      // different fact and must never be read as a deletion.
      return { state: result.error.code === 'app.not-found' ? 'missing' : 'unknown' }
    } catch {
      return { state: 'unknown' }
    }
  }, [resolveObject])

  const refreshLinks = useCallback(async (target: Entry): Promise<void> => {
    const ticket = ++linkTicket.current
    const [task, note] = await Promise.all([
      target.taskId === undefined ? Promise.resolve(undefined) : resolveLink({ appId: 'todo', type: 'task', id: target.taskId }),
      target.noteId === undefined ? Promise.resolve(undefined) : resolveLink({ appId: 'notes', type: 'note', id: target.noteId }),
    ])
    if (linkTicket.current !== ticket) return
    setTaskLink(task)
    setNoteLink(note)
  }, [resolveLink])

  // Resolution follows the two REFERENCE IDS, not the entry object: marking the
  // entry read replaces that object and must not trigger another cross-app read.
  const linkKey = entry === undefined ? '' : `${entry.taskId ?? ''}|${entry.noteId ?? ''}`
  useEffect(() => {
    const current = entryRef.current
    if (current === undefined) {
      linkTicket.current += 1
      setTaskLink(undefined)
      setNoteLink(undefined)
      return
    }
    void refreshLinks(current)
  }, [linkKey, refreshLinks])

  // The owner may delete the object while this page stays open; the two
  // applications share no change notice, so regaining focus is the cheap recheck.
  useEffect(() => {
    const recheck = (): void => {
      const current = entryRef.current
      if (current !== undefined) void refreshLinks(current)
    }
    window.addEventListener('focus', recheck)
    return () => { window.removeEventListener('focus', recheck) }
  }, [refreshLinks])

  const changeTab = (next: string): void => {
    const value = next as Tab
    setTab(value)
    setSelected(undefined)
    setEntry(undefined)
    setReaderError(undefined)
    setGroupMenu(undefined)
    setFilter('all')
    setKind('')
    setSourceFilter('')
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    const outcome = await call('refresh', { scope: 'all' })
    const value = outcomeValue<{ started: boolean; sources: number; taskId?: string }>(outcome)
    setBusy(false)
    if (outcome.status !== 'success') { setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, tRef.current('view.failedGeneric'), tRef.current)); return }
    setNotice(value?.started === true
      ? t('view.refreshStarted', { count: String(value.sources) })
      : value?.taskId !== undefined ? t('view.refreshRunning') : t('view.noRefreshableSources'))
    await loadCurrent()
    await loadSources()
  }

  const toggleRead = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined) return
    const read = entry.readAt === undefined
    const outcome = await call('markRead', { ids: [entry.id], read })
    if (outcome.status !== 'success') { setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, t('view.failedGeneric'), t)); return }
    const next = { ...entry }
    if (read) {
      const now = Date.now()
      next.readAt = now
      next.seenAt = next.seenAt ?? now
    } else delete next.readAt
    replaceEntry(next)
    const delta = read ? -1 : 1
    setCounts(current => ({ ...current, unread: Math.max(0, current.unread + delta) }))
    setFilteredUnread(current => Math.max(0, current + delta))
    if (viewRef.current.grouped) void loadCurrent()
    else syncEntryRef.current(next)
  }

  const favorite = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined) return
    const favoriteNext = !entry.favorite
    const outcome = await call('favorite', { id: entry.id, favorite: favoriteNext })
    if (outcome.status !== 'success') { setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, t('view.failedGeneric'), t)); return }
    const next = { ...entry, favorite: favoriteNext }
    patchEntry(entry.id, { favorite: favoriteNext })
    setCounts(current => ({ ...current, saved: Math.max(0, current.saved + (next.favorite ? 1 : -1)) }))
    if (!viewRef.current.grouped) syncEntryRef.current(next)
  }

  /** The label one source filter/group uses, with a safe fallback for a removed row. */
  const sourceLabel = useCallback((sourceId: string | undefined, fallback = ''): string => {
    if (sourceId === undefined) return t('view.sourceManual')
    const source = sources.find(candidate => candidate.id === sourceId)
    return source === undefined ? (fallback !== '' ? fallback : t('view.sourceUnknown')) : displaySourceName(source)
  }, [sources, t])

  const groupLabel = (group: Group): string => group.sourceId === undefined ? t('view.sourceManual') : sourceLabel(group.sourceId, group.name)

  const toggleGroup = (group: Group): void => {
    const key = groupKeyOf(group)
    setCollapsedGroups({ ...collapsedGroups, [key]: collapsedGroups[key] !== true })
  }

  const toggleAllGroups = (): void => {
    if (groups.length === 0) return
    if (allCollapsed) {
      setCollapsedGroups({})
      return
    }
    const next: Record<string, boolean> = { ...collapsedGroups }
    for (const group of groups) next[groupKeyOf(group)] = true
    setCollapsedGroups(next)
  }

  /** Show one source (or the manual links) as a flat, chronological list. */
  const openSourceEntries = (sourceId: string | undefined): void => {
    setTab('inbox')
    setLayout('time')
    setFilter('all')
    setKind('')
    setSourceFilter(sourceId === undefined ? 'manual' : `source:${sourceId}`)
    setQuery('')
    setSearch('')
    setSelected(undefined)
    setEntry(undefined)
    setReaderError(undefined)
    setGroupMenu(undefined)
  }

  /** A bulk action can remove the focused group header; keep focus in the list. */
  const focusListIfLost = (): void => {
    window.setTimeout(() => {
      if (document.activeElement === null || document.activeElement === document.body) listRef.current?.focus()
    }, 0)
  }

  const markSourceEntriesRead = async (sourceId: string, name: string, unread: number): Promise<void> => {
    if (unread <= 0) return
    const confirmed = await confirm({
      title: t('view.markSourceReadTitle'),
      body: t('view.markSourceReadBody', { name, count: String(unread) }),
      confirmLabel: t('view.markSourceReadConfirm'),
      cancelLabel: t('view.cancel'),
    })
    if (!confirmed) return
    const outcome = await call('markSourceRead', { sourceId, read: true })
    if (outcome.status !== 'success') {
      setPermissionDenied(permissionRefusal(outcome))
      setError(errorText(outcome, t('view.failedGeneric'), t))
      return
    }
    const changed = outcomeValue<{ changed: number }>(outcome)?.changed ?? unread
    setNotice(t('view.markedSourceRead', { count: String(changed) }))
    if (entryRef.current?.sourceId === sourceId && entryRef.current.readAt === undefined) {
      const now = Date.now()
      patchEntry(entryRef.current.id, { readAt: now, seenAt: entryRef.current.seenAt ?? now })
    }
    if (viewRef.current.tab !== 'sources') {
      await loadCurrent()
      focusListIfLost()
    }
    await loadSources()
  }

  const clearSourceEntries = async (sourceId: string, name: string, total: number): Promise<void> => {
    if (total <= 0) return
    const confirmed = await confirm({
      title: t('view.clearSourceTitle'),
      body: t('view.clearSourceBody', { name, count: String(total) }),
      confirmLabel: t('view.clearSourceConfirm'),
      cancelLabel: t('view.cancel'),
      danger: true,
    })
    if (!confirmed) return
    const outcome = await call('clearEntries', { sourceId })
    if (outcome.status !== 'success') {
      setPermissionDenied(permissionRefusal(outcome))
      setError(errorText(outcome, t('view.failedGeneric'), t))
      return
    }
    const removed = outcomeValue<{ removed: number }>(outcome)?.removed ?? total
    setNotice(t('view.clearedEntries', { count: String(removed) }))
    if (entryRef.current?.sourceId === sourceId) {
      setSelected(undefined)
      setEntry(undefined)
      setReaderError(undefined)
    }
    if (viewRef.current.tab !== 'sources') {
      await loadCurrent()
      focusListIfLost()
    }
    await loadSources()
  }

  const markGroupRead = async (group: Group): Promise<void> => {
    if (group.sourceId === undefined) return
    await markSourceEntriesRead(group.sourceId, groupLabel(group), group.unread)
  }

  const clearGroup = async (group: Group): Promise<void> => {
    if (group.sourceId === undefined) return
    // The group total is filtered (a view may hide read entries); clearing the
    // source removes every entry it owns, so the confirmation uses that total.
    const total = sources.find(source => source.id === group.sourceId)?.entryCount ?? group.total
    await clearSourceEntries(group.sourceId, groupLabel(group), total)
  }

  const markSourceReadFromCard = async (source: Source): Promise<void> => {
    await markSourceEntriesRead(source.id, displaySourceName(source), source.unreadCount ?? 0)
  }

  const clearSourceFromCard = async (source: Source): Promise<void> => {
    await clearSourceEntries(source.id, displaySourceName(source), source.entryCount)
  }

  /**
   * Create the task an entry owns, after proving the stored reference is gone.
   * A reference that cannot be checked must never mint a second task, so an
   * `unknown` result stops here instead of creating anything.
   */
  const convertToTask = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined || linking) return
    setLinking(true)
    try {
      const target = entry
      let replace = false
      if (target.taskId !== undefined) {
        const wasMissing = taskLink?.state === 'missing'
        const fresh = await resolveLink({ appId: 'todo', type: 'task', id: target.taskId })
        setTaskLink(fresh)
        if (fresh.state === 'unknown') { setError(t('view.linkUnconfirmed')); return }
        if (fresh.state === 'alive') return
        // The button said "check the task", so a fresh check that only now finds
        // it gone stops here: the next click creates, and says so.
        if (!wasMissing) return
        replace = true
      }
      const outcome = await call(replace ? 'reconvertToTask' : 'saveToTask', { id: target.id })
      if (outcome.status !== 'success') { setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, t('view.taskFailed'), t)); return }
      setNotice(t('view.taskDone'))
      await open(target.id, false)
    } finally { setLinking(false) }
  }

  /** Save the note an entry owns; the same proof rule as {@link convertToTask}. */
  const convertToNote = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined || linking) return
    setLinking(true)
    try {
      const target = entry
      let replace = false
      if (target.noteId !== undefined) {
        const wasMissing = noteLink?.state === 'missing'
        const fresh = await resolveLink({ appId: 'notes', type: 'note', id: target.noteId })
        setNoteLink(fresh)
        if (fresh.state === 'unknown') { setError(t('view.linkUnconfirmed')); return }
        if (fresh.state === 'alive') return
        // Same rule as the task side: a check alone never creates.
        if (!wasMissing) return
        replace = true
      }
      const outcome = await call(replace ? 'reconvertToNote' : 'saveToNote', { id: target.id })
      if (outcome.status !== 'success') { setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, t('view.noteFailed'), t)); return }
      setNotice(t('view.noteDone'))
      await open(target.id, false)
    } finally { setLinking(false) }
  }

  const taskRef: ObjectRefValue | undefined = entry === undefined || entry.taskId === undefined
    ? undefined
    : { appId: 'todo', type: 'task', id: entry.taskId }
  const noteRef: ObjectRefValue | undefined = entry === undefined || entry.noteId === undefined
    ? undefined
    : { appId: 'notes', type: 'note', id: entry.noteId }

  const submitLink = async (): Promise<void> => {
    setBusy(true)
    const outcome = await call('addManualLink', { url: draft.url.trim(), title: draft.title.trim() || undefined } as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(errorText(outcome, t('view.failedGeneric'), t)); return }
    setDialog(undefined)
    setNotice(t('view.linkAdded'))
    setDraft(current => ({ ...current, url: '', title: '' }))
    await loadCurrent()
  }

  const submitSource = async (): Promise<void> => {
    setBusy(true)
    const kindValue = draft.kind
    const outcome = await call('addSource', {
      kind: kindValue,
      url: draft.url.trim() || undefined,
      name: draft.name.trim() || undefined,
      repo: draft.repo.trim() || undefined,
      ...(draft.interval.trim() === '' ? {} : { intervalMs: Number(draft.interval) * 60_000 }),
    } as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(errorText(outcome, t('view.failedGeneric'), t)); return }
    const created = outcomeValue<Source>(outcome)
    setDialog(undefined)
    setNotice(t('view.addedSource'))
    setDraft(current => ({ ...current, url: '', name: '', repo: '', interval: '' }))
    await loadSources()
    if (created !== undefined) {
      const started = await call('refresh', { sourceId: created.id })
      if (started.status !== 'success') setError(errorText(started, t('view.failedGeneric'), t))
    }
  }

  /** Open one source's edit dialog; an empty interval field means "follow the settings". */
  const openSourceEdit = (source: Source): void => {
    setEditTarget(source)
    setEditDraft({ name: source.name, interval: source.intervalMs > 0 ? String(Math.round(source.intervalMs / 60_000)) : '' })
    setDialogError(undefined)
    setDialog('sourceEdit')
  }

  const submitSourceEdit = async (): Promise<void> => {
    /* v8 ignore next -- the dialog renders only with a target */
    if (editTarget === undefined) return
    setBusy(true)
    const outcome = await call('updateSource', {
      id: editTarget.id,
      expectedVersion: editTarget.version,
      patch: {
        name: editDraft.name.trim(),
        // Empty clears the override (`0`), so the source returns to the family
        // setting instead of being pinned to whatever it was created with.
        intervalMs: editDraft.interval.trim() === '' ? 0 : Number(editDraft.interval) * 60_000,
      },
    } as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(errorText(outcome, t('view.failedGeneric'), t)); return }
    setDialog(undefined)
    setEditTarget(undefined)
    setNotice(t('view.updatedSource'))
    await loadSources()
    if (viewRef.current.tab !== 'sources') await loadCurrent()
  }

  const toggleSource = async (source: Source): Promise<void> => {
    const outcome = await call('updateSource', { id: source.id, expectedVersion: source.version, patch: { enabled: !source.enabled } })
    if (outcome.status !== 'success') { setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, t('view.failedGeneric'), t)); return }
    setNotice(t('view.updatedSource'))
    await loadSources()
    if (viewRef.current.tab !== 'sources') await loadCurrent()
  }

  const removeSource = async (source: Source): Promise<void> => {
    const outcome = await call('removeSource', { id: source.id })
    if (outcome.status !== 'success') {
      setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, t('view.failedGeneric'), t))
      setRemoveTarget(undefined)
      return
    }
    setRemoveTarget(undefined)
    setNotice(t('view.removedSource'))
    await loadSources()
    if (viewRef.current.tab !== 'sources') await loadCurrent()
  }

  const refreshSource = async (source: Source): Promise<void> => {
    const outcome = await call('refresh', { sourceId: source.id })
    if (outcome.status !== 'success') { setPermissionDenied(permissionRefusal(outcome)); setError(errorText(outcome, t('view.failedGeneric'), t)); return }
    setNotice(t('view.sourceRefreshed'))
    await loadSources()
  }

  const submitOpml = async (): Promise<void> => {
    setBusy(true)
    const outcome = await call('importOpml', { xml: draft.opml })
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(errorText(outcome, t('view.failedGeneric'), t)); return }
    const value = outcomeValue<{ added: number; skipped: number; invalid: number }>(outcome)!
    setDialog(undefined)
    setNotice(t('view.opmlDone', { added: String(value.added), skipped: String(value.skipped), invalid: String(value.invalid) }))
    await loadSources()
    // Imported sources start due; collecting immediately avoids an empty inbox
    // that looks broken until the next scheduler tick.
    await call('refresh', { scope: 'due' })
  }

  const submitSettings = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (settings === undefined) return
    const patch: Record<string, unknown> = {
      retentionDays: settings.retentionDays,
      maxEntries: settings.maxEntries,
      maxBytes: settings.maxBytes,
      githubRefreshMs: settings.githubRefreshMs,
      feedRefreshMs: settings.feedRefreshMs,
    }
    setDialogError(undefined)
    setBusy(true)
    const previewOutcome = await call('previewSettings', { patch } as never)
    setBusy(false)
    const preview = outcomeValue<{ removedEntries: number; removedBytes: number }>(previewOutcome)
    if (preview === undefined) { setDialogError(errorText(previewOutcome, t('view.settingsFailed'), t)); return }
    if (preview.removedEntries > 0) {
      const confirmed = await confirm({
        title: t('view.settingsPruneTitle'),
        body: t('view.settingsPruneBody', { count: String(preview.removedEntries) }),
        confirmLabel: t('view.settingsPruneConfirm'),
        cancelLabel: t('view.cancel'),
        danger: true,
      })
      if (!confirmed) return
    }
    setBusy(true)
    const outcome = await call('setSettings', { patch } as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(errorText(outcome, t('view.settingsFailed'), t)); return }
    setDialog(undefined)
    setSettings(outcomeValue<Settings>(outcome))
    setNotice(preview.removedEntries > 0
      ? t('view.settingsPruned', { count: String(preview.removedEntries) })
      : t('view.settingsSaved'))
    if (viewRef.current.tab !== 'sources') await loadCurrent()
  }

  const visibleSources = useMemo(() => new Map(sources.map(source => [source.id, source])), [sources])
  const sourceName = (id: string | undefined): string => {
    if (id === undefined) return t('view.sourceManual')
    const source = visibleSources.get(id)
    return source === undefined ? t('view.sourceUnknown') : displaySourceName(source)
  }
  const sourceFilterName = sourceFilter === 'manual'
    ? t('view.sourceManual')
    : sourceFilter.startsWith('source:') ? sourceName(sourceFilter.slice('source:'.length)) : ''
  const externalHref = entry === undefined ? undefined : safeHrefForExternal(entry.url)
  const tabs = [
    { id: 'inbox', label: t('view.inbox'), suffix: counts.unread > 0 ? <span className={css.badge}>{counts.unread}</span> : undefined },
    { id: 'saved', label: t('view.saved'), suffix: counts.saved > 0 ? <span className={css.badge}>{counts.saved}</span> : undefined },
    { id: 'sources', label: t('view.sources'), suffix: health.error > 0 ? <span className={`${css.badge} ${css.errorBadge}`} data-inbox-source-errors>{health.error}</span> : undefined },
  ]

  const activeSources = sources.filter(source => !source.removed)
  const removedSources = sources.filter(source => source.removed)
  // Different empty states: a first run, sources that have not collected yet,
  // sources all paused, a filter that matches nothing, a search that matches
  // nothing, and an empty saved shelf. Each action recovers in that context.
  const emptyKind: EmptyKind = search.trim() !== ''
    ? 'search'
    : filter !== 'all' || kind !== '' || sourceFilter !== ''
      ? 'filtered'
      : tab === 'saved'
        ? 'saved'
        : activeSources.length === 0
          ? 'first'
          : activeSources.every(source => !source.enabled) ? 'paused' : 'ready'
  const emptyCopy = emptyKind === 'search'
    ? { title: t('view.emptySearchTitle'), body: t('view.emptySearchBody') }
    : emptyKind === 'filtered'
      ? { title: t('view.emptyFiltered'), body: t('view.emptyFilteredHint') }
      : emptyKind === 'saved'
        ? { title: t('view.emptySavedTitle'), body: t('view.emptySavedBody') }
        : emptyKind === 'ready'
          ? { title: t('view.emptyReadyTitle'), body: t('view.emptyReadyBody') }
          : emptyKind === 'paused'
            ? { title: t('view.emptyPausedTitle'), body: t('view.emptyPausedBody') }
            : { title: t('view.emptyFirstTitle'), body: t('view.emptyFirstBody') }

  /** Clear both the input and the applied query, so the list reloads at once. */
  const clearSearch = (): void => {
    setQuery('')
    setSearch('')
  }

  const renderEntry = (item: Entry, compact: boolean) => (
    <button
      key={item.id}
      type="button"
      ref={(element) => {
        if (element === null) rowRefs.current.delete(item.id)
        else rowRefs.current.set(item.id, element)
      }}
      className={`${css.entry} ${compact ? css.entryCompact : ''} ${item.id === selected ? css.entryActive : ''}`}
      onClick={() => { void open(item.id) }}
      aria-current={item.id === selected ? 'true' : undefined}
      data-inbox-entry={item.id}
      data-inbox-entry-compact={compact ? 'true' : undefined}
    >
      {compact ? null : (
        <span className={css.entryTop}>
          {sourceFilter === '' ? <span className={css.sourceSmall}>{sourceName(item.sourceId)}</span> : null}
          <span className={css.spacer} />
          <span className={css.meta}>{when(item.publishedAt ?? item.fetchedAt, language)}</span>
        </span>
      )}
      <span className={css.entryTitle}>{item.title}</span>
      {compact ? null : <span className={css.entrySummary}>{plainSummary(item.summary)}</span>}
      <span className={css.entryFoot}>
        {item.readAt === undefined ? <><span className={css.unreadDot} aria-hidden="true" /><span className={css.srOnly}>{t('view.unreadLabel')}</span></> : null}
        {item.favorite ? <><span className={css.star} aria-hidden="true">★</span><span className={css.srOnly}>{t('view.favorite')}</span></> : null}
        {compact ? <><span className={css.spacer} /><span className={css.meta}>{when(item.publishedAt ?? item.fetchedAt, language)}</span></> : null}
      </span>
    </button>
  )

  const renderSource = (source: Source) => {
    const statusTone = source.removed ? 'removed' : !source.enabled ? 'paused' : source.lastError !== undefined ? 'error' : 'ok'
    const status = source.removed
      ? t('view.sourceRemovedTag')
      : !source.enabled ? t('view.healthPaused') : source.lastError !== undefined ? t('view.healthError') : t('view.healthOk')
    const stamp = (value: number | undefined): string => value === undefined ? t('view.never') : when(value, language)
    return (
      <article
        key={source.id}
        className={css.sourceCard}
        data-inbox-source={source.id}
        data-source-enabled={source.enabled ? 'true' : 'false'}
        data-source-removed={source.removed ? 'true' : undefined}
        data-source-health={statusTone}
      >
        <div className={css.sourceHead}>
          <div className={css.sourceIdentity}>
            <strong className={css.sourceName} title={displaySourceName(source)}>{displaySourceName(source)}</strong>
            <span className={css.tag}>{source.kind}</span>
          </div>
          <span className={css.sourceStatus} data-tone={statusTone}>{status}</span>
        </div>
        <div className={css.sourceUrl}>{source.url}</div>
        <div className={css.sourceStats} data-inbox-source-counts={source.id}>
          <span><strong>{source.entryCount}</strong> {t('view.entriesUnit')}</span>
          <span className={css.sourceStatDot}>{' · '}</span>
          <span data-tone={(source.unreadCount ?? 0) > 0 ? 'unread' : 'quiet'}><strong>{source.unreadCount ?? 0}</strong> {t('view.unreadUnit')}</span>
        </div>
        <div className={css.sourceFacts}>
          <div className={css.sourceFact}>
            <span className={css.sourceFactLabel}>{t('view.sourceInterval')}</span>
            <span className={css.sourceFactValue}>{source.intervalMs > 0 ? t('view.sourceIntervalEvery', { minutes: String(Math.round(source.intervalMs / 60_000)) }) : t('view.sourceIntervalFollow')}</span>
          </div>
          <div className={css.sourceFact}>
            <span className={css.sourceFactLabel}>{t('view.lastChecked')}</span>
            <span className={css.sourceFactValue}>{stamp(source.lastCheckedAt ?? source.lastSuccessAt)}</span>
          </div>
          <div className={css.sourceFact}>
            <span className={css.sourceFactLabel}>{t('view.lastSuccess')}</span>
            <span className={css.sourceFactValue}>{stamp(source.lastSuccessAt)}</span>
          </div>
          <div className={css.sourceFact}>
            <span className={css.sourceFactLabel}>{t('view.latestEntry')}</span>
            <span className={css.sourceFactValue}>{stamp(source.latestAt)}</span>
          </div>
        </div>
        {source.lastError !== undefined ? (
          <details className={css.sourceError} data-inbox-source-error={source.id}>
            <summary><span className={css.disclosure} aria-hidden="true"><IconChevronRightOutlineRegular size={12} /></span><span>{t('view.sourceFailed')}</span><span>{t('view.diagnostic')}</span></summary>
            <p>{source.lastError}</p>
          </details>
        ) : null}
        <div className={css.sourceActions}>
          <div className={css.actionGroup}>
            <button type="button" className={`${css.button} ${css.buttonAccent}`} onClick={() => { openSourceEntries(source.id) }} data-inbox-source-view={source.id}>{t('view.sourceViewEntries')}</button>
            {source.removed ? null : <button type="button" className={css.button} onClick={() => { void refreshSource(source) }} data-inbox-source-refresh={source.id}>{t('view.sourceRefresh')}</button>}
            {(source.unreadCount ?? 0) > 0 ? <button type="button" className={css.button} onClick={() => { void markSourceReadFromCard(source) }} data-inbox-source-read={source.id}>{t('view.sourceMarkRead')}</button> : null}
          </div>
          <span className={css.spacer} />
          <div className={css.actionGroup}>
            {source.removed ? null : (
              <>
                <button type="button" className={css.button} onClick={() => { openSourceEdit(source) }} data-inbox-source-edit={source.id}>{t('view.sourceEdit')}</button>
                <button type="button" className={css.button} onClick={() => { void toggleSource(source) }} data-inbox-source-toggle={source.id}>{source.enabled ? t('view.sourcePause') : t('view.sourceResume')}</button>
              </>
            )}
            <button type="button" className={`${css.button} ${css.buttonDanger}`} onClick={() => { void clearSourceFromCard(source) }} disabled={source.entryCount === 0} data-inbox-source-clear={source.id}>{t('view.sourceClear')}</button>
            {source.removed ? null : <button type="button" className={`${css.button} ${css.buttonDanger}`} onClick={() => { setRemoveTarget(source) }} data-inbox-source-remove={source.id}>{t('view.sourceRemove')}</button>}
          </div>
        </div>
      </article>
    )
  }

  const renderGroup = (group: Group) => {
    const key = groupKeyOf(group)
    const collapsed = collapsedGroups[key] === true
    const contentId = `inbox-group-${key.replace(/[^A-Za-z0-9_-]/gu, '-')}`
    return (
      <section key={key} className={css.group} data-inbox-group={key} data-inbox-group-removed={group.removed ? 'true' : undefined}>
        <div className={css.groupHeader}>
          <div className={css.groupHead}>
            <button
              type="button"
              className={css.groupToggle}
              title={groupLabel(group)}
              aria-expanded={!collapsed}
              aria-controls={contentId}
              onClick={() => { toggleGroup(group) }}
              data-inbox-group-toggle={key}
            >
              <span className={css.chevron} aria-hidden="true">
                {collapsed ? <IconChevronRightOutlineRegular size={13} /> : <IconChevronDownOutlineRegular size={13} />}
              </span>
              <span className={css.groupName}>{groupLabel(group)}</span>
              {group.removed ? <span className={css.tag}>{t('view.sourceRemovedTag')}</span> : !group.enabled ? <span className={css.tag}>{t('view.healthPaused')}</span> : null}
              <span className={css.groupCount}>{group.unread > 0 ? t('view.groupUnread', { count: String(group.unread) }) : t('view.groupTotal', { count: String(group.total) })}</span>
            </button>
            {group.sourceId === undefined ? null : (
              <Menu
                open={groupMenu === key}
                align="end"
                portal
                onClose={() => { setGroupMenu(undefined) }}
                anchor={(
                  <button
                    type="button"
                    className={css.groupMenu}
                    aria-haspopup="menu"
                    aria-expanded={groupMenu === key}
                    aria-label={t('view.groupActions')}
                    onClick={() => { setGroupMenu(groupMenu === key ? undefined : key) }}
                    data-inbox-group-menu={key}
                  >
                    <IconEllipsisOutlineRegular size={16} />
                  </button>
                )}
              >
                {group.unread > 0 ? (
                  <MenuItemButton onSelect={() => { setGroupMenu(undefined); void markGroupRead(group) }}>{t('view.markSourceRead')}</MenuItemButton>
                ) : null}
                <MenuItemButton danger onSelect={() => { setGroupMenu(undefined); void clearGroup(group) }}>{t('view.clearSourceEntries')}</MenuItemButton>
              </Menu>
            )}
          </div>
          <div className={css.groupMeta}>
            <span>{t('view.groupLatest', { time: when(group.latestAt, language) })}</span>
            <span>·</span>
            <span>{t('view.groupTotal', { count: String(group.total) })}</span>
            <span className={css.spacer} />
            <button type="button" className={css.groupAction} onClick={() => { openSourceEntries(group.sourceId) }} data-inbox-group-view={key}>{t('view.viewAllEntries')}</button>
          </div>
        </div>
        {collapsed ? null : (
          <div className={css.groupEntries} id={contentId}>
            {group.entries.map(item => renderEntry(item, true))}
          </div>
        )}
      </section>
    )
  }

  return (
    <div className={css.page} data-inbox-page>
      <TabBar
        tabs={tabs}
        active={tab}
        onSelect={changeTab}
        tools={(
          <div className={css.tools} data-inbox-tools>
            {tab !== 'sources' && (
              <span className={css.searchWrap}>
                <input
                  type="search"
                  className={css.search}
                  value={query}
                  onChange={event => { setQuery(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    const next = query
                    setSearch(next)
                    void loadCurrent({ search: next })
                  }}
                  placeholder={t('view.search')}
                  aria-label={t('view.search')}
                />
                {query !== '' && (
                  <button type="button" className={css.searchClear} onClick={clearSearch} aria-label={t('view.clearSearch')} data-inbox-search-clear>×</button>
                )}
              </span>
            )}
            {tab !== 'sources' && <button type="button" className={css.button} onClick={() => { setDialog('link'); setDialogError(undefined) }}>{t('view.addLink')}</button>}
            {tab === 'inbox' && <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void refresh() }} disabled={busy || running}>{t('view.refresh')}</button>}
            {tab === 'sources' && <button type="button" className={css.button} onClick={() => { setDialog('opml'); setDialogError(undefined) }}>{t('view.importOpml')}</button>}
            {tab === 'sources' && <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { setDialog('source'); setDialogError(undefined) }}>{t('view.addSource')}</button>}
            <button type="button" className={css.button} onClick={() => { setDialog('settings'); setDialogError(undefined) }}>{t('view.settings')}</button>
          </div>
        )}
      />
      {(error ?? sourceError) !== undefined && (
        <div className={css.errorRow}>
          <LocalFailure title={t('view.failedGeneric')} message={(error ?? sourceError) as string} detailLabel={t('view.diagnostic')} data-inbox-error />
          {permissionDenied && <button type="button" className={css.button} data-inbox-error-manage onClick={() => { openManagement('permissions') }}>{t('view.managePermissions')}</button>}
        </div>
      )}
      {tab !== 'sources' && listFailure !== undefined && (
        <div className={css.errorRow} data-inbox-list-stale>
          <LocalFailure
            title={t('view.loadFailed')}
            detailLabel={t('view.diagnostic')}
            data-inbox-error
            {...(listFailure.code === undefined ? {} : { code: listFailure.code })}
            {...(listFailure.message === undefined ? {} : { message: listFailure.message })}
            action={<button type="button" className={css.button} onClick={() => { void loadCurrent() }} data-inbox-list-retry>{t('view.retry')}</button>}
          />
        </div>
      )}
      {notice !== undefined && <div className={css.notice} role="status" data-inbox-notice>{notice}</div>}
      {tab === 'sources' ? (
        <div className={css.sources} data-inbox-sources>
          <div className={css.sourcesSummary} data-inbox-sources-summary>
            <span className={css.sourcesTotal}>{t('view.sourcesSummary', { total: String(health.total) })}</span>
            <span className={css.healthPill} data-tone="ok">{t('view.healthOk')} {health.ok}</span>
            <span className={css.healthPill} data-tone="error">{t('view.healthError')} {health.error}</span>
            <span className={css.healthPill} data-tone="paused">{t('view.healthPaused')} {health.paused}</span>
          </div>
          {activeSources.map(source => renderSource(source))}
          {removedSources.length > 0 ? (
            <section className={css.removedSection} data-inbox-removed-sources>
              <h2 className={css.sectionTitle}>{t('view.removedSources')}</h2>
              <p className={css.sourcesHint}>{t('view.removedSourcesHint')}</p>
              {removedSources.map(source => renderSource(source))}
            </section>
          ) : null}
        </div>
      ) : (
        <div className={css.body} data-inbox-body>
          <aside ref={listRef} tabIndex={-1} className={`${css.list} ${selected !== undefined ? css.listHidden : ''}`} data-inbox-list>
            <div className={css.filters}>
              {(['all', 'unread'] as const).map(value => (
                <button key={value} type="button" className={`${css.chip} ${filter === value ? css.chipActive : ''}`} aria-pressed={filter === value} onClick={() => { setFilter(value) }} data-inbox-filter={value}>
                  {value === 'all' ? t('view.all') : t('view.unread')}
                </button>
              ))}
              <span className={css.spacer} />
              <select className={css.select} value={kind} onChange={event => { setSourceFilter(''); setKind(event.target.value) }} aria-label={t('view.kindAll')}>
                <option value="">{t('view.kindAll')}</option>
                <option value="github">{t('view.kindGithub')}</option>
                <option value="rss">{t('view.kindRss')}</option>
                <option value="manual">{t('view.kindManual')}</option>
              </select>
            </div>
            {sourceFilter !== '' ? (
              <div className={css.sourceFilter} data-inbox-source-filter>
                <span>{t('view.sourceFilter', { name: sourceFilterName })}</span>
                <button type="button" className={css.sourceFilterClear} onClick={() => { setSourceFilter(''); setKind('') }} aria-label={t('view.clearFilters')} data-inbox-source-filter-clear>×</button>
              </div>
            ) : null}
            <div className={css.listSummary} data-inbox-summary>
              <span className={css.listSummaryText}>{readFailure !== undefined
                ? t('view.notReadSummary')
                : tab === 'inbox'
                  ? <>{t('view.listSummary', { total: String(total), unread: String(filteredUnread) })}{searchActive && layout === 'source' ? ` · ${t('view.searchTimeOrder')}` : ''}</>
                  : t('view.listSummaryPlain', { total: String(total) })}</span>
              <span className={css.listActions}>
                {grouped && groups.length > 0 ? (
                  <button type="button" className={css.collapseAll} onClick={toggleAllGroups} data-inbox-collapse-all>
                    {allCollapsed ? t('view.expandAll') : t('view.collapseAll')}
                  </button>
                ) : null}
                {tab === 'inbox' ? (
                  <span className={css.layoutSwitch} role="group" aria-label={t('view.layout')}>
                    <button type="button" className={`${css.layoutButton} ${layout === 'source' ? css.layoutActive : ''}`} aria-pressed={layout === 'source'} onClick={() => { setLayout('source') }} data-inbox-layout="source">{t('view.bySource')}</button>
                    <button type="button" className={`${css.layoutButton} ${layout === 'time' ? css.layoutActive : ''}`} aria-pressed={layout === 'time'} onClick={() => { setLayout('time') }} data-inbox-layout="time">{t('view.byTime')}</button>
                  </span>
                ) : null}
              </span>
            </div>
            <div className={css.entries} ref={rowsRef}>
              {readFailure !== undefined ? (
                readFailure.kind === 'not-approved' || readFailure.kind === 'undeclared'
                  ? (
                    <EmptyState
                      title={readFailure.kind === 'undeclared' ? t('view.notReadUndeclaredTitle') : t('view.notReadTitle')}
                      body={readFailure.kind === 'undeclared' ? t('view.notReadUndeclaredBody') : t('view.notReadBody')}
                      data-inbox-read-failure={readFailure.kind}
                    />
                  )
                  : (
                    <ReadFailure
                      kind={readFailure.kind}
                      title={t('view.loadFailed')}
                      detailLabel={t('view.diagnostic')}
                      {...(readFailure.code === undefined ? {} : { code: readFailure.code })}
                      {...(readFailure.message === undefined ? {} : { message: readFailure.message })}
                      data-inbox-read-failure={readFailure.kind}
                      retry={<button type="button" className={css.button} onClick={() => { void loadCurrent() }} data-inbox-read-retry>{t('view.retry')}</button>}
                    />
                  )
              ) : !entriesLoaded || !sourcesLoaded ? <EmptyState title={t('view.loading')} data-inbox-loading /> : entries.length === 0 && groups.length === 0 ? (
                <EmptyState
                  title={emptyCopy.title}
                  body={emptyCopy.body}
                  action={emptyKind === 'first' ? (
                    <div className={css.actions}>
                      <button type="button" className={css.button} onClick={() => { changeTab('sources') }} data-inbox-empty-sources>{t('view.emptyAddSource')}</button>
                      <button type="button" className={css.button} onClick={() => { setDialog('link'); setDialogError(undefined) }} data-inbox-empty-add-link>{t('view.addLink')}</button>
                    </div>
                  ) : emptyKind === 'ready' ? (
                    <div className={css.actions}>
                      <button type="button" className={css.button} onClick={() => { void refresh() }} disabled={busy || running} data-inbox-empty-refresh>{t('view.refreshNow')}</button>
                      <button type="button" className={css.button} onClick={() => { changeTab('sources') }} data-inbox-empty-sources>{t('view.manageSources')}</button>
                    </div>
                  ) : emptyKind === 'paused' ? (
                    <button type="button" className={css.button} onClick={() => { changeTab('sources') }} data-inbox-empty-sources>{t('view.manageSources')}</button>
                  ) : emptyKind === 'filtered' ? (
                    <button type="button" className={css.button} onClick={() => { setFilter('all'); setKind(''); setSourceFilter('') }} data-inbox-clear-filters>{t('view.clearFilters')}</button>
                  ) : emptyKind === 'search' ? (
                    <button type="button" className={css.button} onClick={clearSearch} data-inbox-clear-search>{t('view.clearSearch')}</button>
                  ) : (
                    <div className={css.actions}>
                      <button type="button" className={css.button} onClick={() => { changeTab('inbox') }} data-inbox-empty-inbox>{t('view.emptySavedInbox')}</button>
                      <button type="button" className={css.button} onClick={() => { setDialog('link'); setDialogError(undefined) }} data-inbox-empty-add-link>{t('view.addLink')}</button>
                    </div>
                  )}
                  data-inbox-empty={emptyKind}
                />
              ) : grouped ? groups.map(group => renderGroup(group)) : entries.map(item => renderEntry(item, false))}
              {!grouped && entries.length > 0 && entries.length < total ? (
                <button type="button" className={css.button} onClick={() => { void loadMore() }} disabled={loadingMore} data-inbox-load-more>
                  {loadingMore ? t('view.loadingMore') : t('view.loadMore')}
                </button>
              ) : null}
            </div>
          </aside>
          <section
            ref={readerRef}
            tabIndex={-1}
            className={`${css.reader} ${selected === undefined ? css.readerEmpty : ''}`}
            data-inbox-reader
            aria-label={entry?.title ?? t('view.selectEntry')}
          >
            {selected === undefined ? (
              <div className={css.readerWelcome} data-inbox-reader-empty>
                <IconQueueOutlineRegular size={28} className={css.readerWelcomeIcon} />
                <p className={css.readerWelcomeTitle}>{t('view.selectEntry')}</p>
                <p className={css.readerWelcomeBody}>{t('view.selectHint')}</p>
              </div>
            ) : readerError !== undefined ? (
              <EmptyState
                title={t('view.readerFailed')}
                body={readerError}
                action={(
                  <div className={css.actions}>
                    <button type="button" className={css.button} onClick={() => { void open(selected) }} data-inbox-reader-retry>{t('view.retry')}</button>
                    <button type="button" className={css.button} onClick={closeReader} data-inbox-reader-back>{t('view.back')}</button>
                  </div>
                )}
                data-inbox-reader-error
              />
            ) : entry === undefined ? (
              <EmptyState title={t('view.loading')} data-inbox-reader-loading />
            ) : (
              <>
                <div className={css.readerHead}>
                  <button type="button" className={css.back} onClick={closeReader} data-inbox-back>{t('view.back')}</button>
                  <span className={css.sourceSmall}>{sourceName(entry.sourceId)}</span>
                  <span className={css.spacer} />
                  {entry.favorite ? <span className={css.readerFavorite} data-inbox-favorite>★ {t('view.favorite')}</span> : null}
                  <span className={css.meta}>{when(entry.publishedAt ?? entry.fetchedAt, language)}</span>
                </div>
                <h1 className={css.readerTitle}>{entry.title}</h1>
                <div className={css.readerMeta}>
                  {taskRef === undefined ? null : taskLink?.state === 'alive'
                    ? <ObjectReference object={taskRef} typeLabel={t('view.taskRef')} title={taskLink.title ?? taskRef.id} onOpen={() => { navigation?.open({ appId: 'todo', record: { appId: 'todo', kind: 'task', id: taskRef.id }, view: 'detail' }) }} attrs={{ 'data-inbox-task-ref': taskRef.id }} />
                    : <span className={css.tag} data-inbox-task-link={taskLink?.state ?? 'checking'}>{taskLink === undefined ? t('view.taskChecking') : taskLink.state === 'missing' ? t('view.taskMissing') : t('view.linkUnknown')}</span>}
                  {noteRef === undefined ? null : noteLink?.state === 'alive'
                    ? <ObjectReference object={noteRef} typeLabel={t('view.noteRef')} title={noteLink.title ?? noteRef.id} onOpen={() => { navigation?.open({ appId: 'notes', record: { appId: 'notes', kind: 'note', id: noteRef.id }, view: 'editor' }) }} attrs={{ 'data-inbox-note-ref': noteRef.id }} />
                    : <span className={css.tag} data-inbox-note-link={noteLink?.state ?? 'checking'}>{noteLink === undefined ? t('view.noteChecking') : noteLink.state === 'missing' ? t('view.noteMissing') : t('view.linkUnknown')}</span>}
                </div>
                {(taskRef !== undefined || noteRef !== undefined) && (
                  <details className={css.objectIds} data-inbox-object-ids>
                    <summary>{t('view.objectIds')}</summary>
                    {taskRef === undefined ? null : <code>{`${taskRef.appId}/${taskRef.type}/${taskRef.id}`}</code>}
                    {noteRef === undefined ? null : <code>{`${noteRef.appId}/${noteRef.type}/${noteRef.id}`}</code>}
                  </details>
                )}
                <div className={css.actions}>
                  <div className={css.actionGroup}>
                    {externalHref !== undefined && <a className={css.button} href={externalHref} target="_blank" rel="noreferrer">{t('view.open')} ↗</a>}
                    <button type="button" className={css.button} onClick={() => { void toggleRead() }}>{entry.readAt === undefined ? t('view.markRead') : t('view.markUnread')}</button>
                    <button type="button" className={css.button} onClick={() => { void favorite() }}>{entry.favorite ? t('view.unfavorite') : t('view.favorite')}</button>
                  </div>
                  <span className={css.spacer} />
                  <div className={css.actionGroup}>
                    <button type="button" className={css.button} onClick={() => { void convertToTask() }} disabled={linking || (taskRef !== undefined && taskLink === undefined) || taskLink?.state === 'alive'}>{taskRef === undefined ? t('view.task') : taskLink === undefined ? t('view.taskChecking') : taskLink.state === 'alive' ? t('view.taskDone') : taskLink.state === 'missing' ? t('view.taskReconvert') : t('view.taskRecheck')}</button>
                    <button type="button" className={css.button} onClick={() => { void convertToNote() }} disabled={linking || (noteRef !== undefined && noteLink === undefined) || noteLink?.state === 'alive'}>{noteRef === undefined ? t('view.note') : noteLink === undefined ? t('view.noteChecking') : noteLink.state === 'alive' ? t('view.noteDone') : noteLink.state === 'missing' ? t('view.noteReconvert') : t('view.noteRecheck')}</button>
                  </div>
                </div>
                <div className={css.content} data-inbox-reader-content>{renderMarkdown(entry.content, {
                    externalLinks: true,
                    renderCodeBlock: block => (
                      <FenceCodeBlock lang={block.lang} code={block.code} streaming={false} labels={{ copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') }} />
                    ),
                  })}</div>
              </>
            )}
          </section>
        </div>
      )}
      <Modal
        open={removeTarget !== undefined}
        onClose={() => { if (!busy) setRemoveTarget(undefined) }}
        title={t('view.sourceRemove')}
        tone="warning"
        closeLabel={t('view.close')}
        footer={(
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRemoveTarget(undefined) }}>{t('view.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { if (removeTarget !== undefined) void removeSource(removeTarget) }} data-inbox-source-remove-confirm>{t('view.sourceRemove')}</Button>
          </>
        )}
      >
        <p>{t('view.confirmRemoveSource', { name: removeTarget === undefined ? '' : displaySourceName(removeTarget) })}</p>
      </Modal>
      {dialog !== undefined && (
        <div className={css.backdrop} role="presentation" onClick={closeDialog}>
          <div ref={dialogRef} className={css.modal} role="dialog" aria-modal="true" aria-labelledby="inbox-dialog-title" tabIndex={-1} data-inbox-dialog={dialog} onClick={event => { event.stopPropagation() }}>
            <div className={css.modalHead}><h2 id="inbox-dialog-title">{dialog === 'link' ? t('view.addLinkTitle') : dialog === 'source' ? t('view.addSourceTitle') : dialog === 'sourceEdit' ? t('view.editSourceTitle') : dialog === 'opml' ? t('view.opmlTitle') : t('view.settings')}</h2><button type="button" className={css.close} onClick={closeDialog} aria-label={t('view.close')}>×</button></div>
            {dialog === 'link' && (
              <div className={css.form}>
                <label>{t('view.url')}<input autoFocus value={draft.url} onChange={event => { setDraft({ ...draft, url: event.target.value }) }} /></label>
                <label>{t('view.title')}<input value={draft.title} onChange={event => { setDraft({ ...draft, title: event.target.value }) }} placeholder={t('view.titleHint')} /></label>
                <div className={css.formActions}><button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button><button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitLink() }} disabled={busy || !/^https?:\/\//u.test(draft.url.trim())}>{t('view.add')}</button></div>
              </div>
            )}
            {dialog === 'source' && (
              <div className={css.form}>
                <label>{t('view.kind')}<select value={draft.kind} onChange={event => { setDraft({ ...draft, kind: event.target.value }) }}><option value="rss">RSS</option><option value="github">GitHub</option></select></label>
                <label>{t('view.url')}<input autoFocus value={draft.url} onChange={event => { setDraft({ ...draft, url: event.target.value }) }} /></label>
                <label>{t('view.name')}<input value={draft.name} onChange={event => { setDraft({ ...draft, name: event.target.value }) }} /></label>
                {draft.kind === 'github' && <label>{t('view.repo')}<input value={draft.repo} onChange={event => { setDraft({ ...draft, repo: event.target.value }) }} placeholder="owner/repo" /></label>}
                <label>{t('view.interval')}<input type="number" min="0" value={draft.interval} onChange={event => { setDraft({ ...draft, interval: event.target.value }) }} /></label>
                <div className={css.formActions}><button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button><button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitSource() }} disabled={busy}>{t('view.add')}</button></div>
              </div>
            )}
            {dialog === 'sourceEdit' && editTarget !== undefined && (
              <div className={css.form}>
                <label>{t('view.name')}<input autoFocus value={editDraft.name} onChange={event => { setEditDraft({ ...editDraft, name: event.target.value }) }} /></label>
                <label>{t('view.interval')}<input type="number" min="0" value={editDraft.interval} onChange={event => { setEditDraft({ ...editDraft, interval: event.target.value }) }} /></label>
                <div className={css.formActions}><button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button><button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitSourceEdit() }} disabled={busy}>{t('view.save')}</button></div>
              </div>
            )}
            {dialog === 'opml' && (
              <div className={css.form}>
                <label>{t('view.opmlLabel')}<textarea autoFocus rows={8} value={draft.opml} onChange={event => { setDraft({ ...draft, opml: event.target.value }) }} placeholder={t('view.opmlPlaceholder')} /></label>
                <div className={css.formActions}><button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button><button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitOpml() }} disabled={busy || draft.opml.trim() === ''}>{t('view.import')}</button></div>
              </div>
            )}
            {dialog === 'settings' && settings !== undefined && (
              <div className={css.form}>
                <label>{t('view.retentionDays')}<input type="number" value={settings.retentionDays} onChange={event => { setSettings({ ...settings, retentionDays: Number(event.target.value) }) }} /></label>
                <label>{t('view.maxEntries')}<input type="number" value={settings.maxEntries} onChange={event => { setSettings({ ...settings, maxEntries: Number(event.target.value) }) }} /></label>
                <label>{t('view.maxBytes')}<input type="number" value={settings.maxBytes} onChange={event => { setSettings({ ...settings, maxBytes: Number(event.target.value) }) }} /></label>
                <label>{t('view.githubInterval')}<input type="number" value={Math.round(settings.githubRefreshMs / 60_000)} onChange={event => { setSettings({ ...settings, githubRefreshMs: Number(event.target.value) * 60_000 }) }} /></label>
                <label>{t('view.feedInterval')}<input type="number" value={Math.round(settings.feedRefreshMs / 60_000)} onChange={event => { setSettings({ ...settings, feedRefreshMs: Number(event.target.value) * 60_000 }) }} /></label>
                <div className={css.formActions}>
                  <button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button>
                  <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitSettings() }} disabled={busy}>{t('view.saveSettings')}</button>
                </div>
              </div>
            )}
            {dialog === 'settings' && settings === undefined ? (
              settingsError === undefined
                ? <div className={css.form} data-inbox-settings-loading><p>{t('view.loading')}</p></div>
                : (
                  <LocalFailure
                    title={t('view.settingsLoadFailed')}
                    message={settingsError}
                    detailLabel={t('view.diagnostic')}
                    data-inbox-settings-error
                    action={<button type="button" className={css.button} onClick={() => { void loadSettings() }}>{t('view.retry')}</button>}
                  />
                )
            ) : null}
            {dialogError !== undefined && <LocalFailure title={t('view.failedGeneric')} message={dialogError} detailLabel={t('view.diagnostic')} data-inbox-dialog-error />}
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}
