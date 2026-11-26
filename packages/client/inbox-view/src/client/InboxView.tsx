import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { EmptyState, TabBar, safeHrefForExternal, renderMarkdown, useModalFocus, useUiChoice, useUiField } from '@matrix1001/dsh-application-harness-client-chrome'
import { Button, FenceCodeBlock, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import css from './InboxView.module.css'

/** The translate face this page needs. */
export type InboxTranslate = TranslateNS<'inbox'>

/** The props of the registered page. */
export interface InboxPageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface InboxViewProps extends ApplicationViewProps { t: InboxTranslate }

type Tab = 'inbox' | 'saved' | 'sources'
type Filter = 'all' | 'unread' | 'new'
type DialogKind = 'link' | 'source' | 'opml' | 'settings'

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

interface Source {
  id: string
  kind: string
  name: string
  url: string
  enabled: boolean
  intervalMs: number
  selector?: string
  repo?: string
  lastCheckedAt?: number
  lastSuccessAt?: number
  lastError?: string
  version: number
  entryCount: number
}

interface Settings {
  retentionDays: number
  maxEntries: number
  maxBytes: number
  githubRefreshMs: number
  feedRefreshMs: number
  watchRefreshMs: number
  githubTokenSet: boolean
}

interface Counts { unread: number; unseen: number; saved: number; all: number }
interface ListResult { entries: Entry[]; total: number; counts: Counts }
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
function valueOf<T>(outcome: Outcome): T | undefined { return outcome.status === 'success' ? outcome.result as T : undefined }
function messageOf(outcome: Outcome): string | undefined {
  return outcome.status === 'success' || outcome.status === 'cancelled' ? undefined : outcome.error?.message
}

function when(value: number | undefined, locale: string): string {
  if (value === undefined) return '—'
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
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
export function InboxView({ call, running, onChanged, pageContext, registerLeaveGuard, ui, t, language = 'zh' }: InboxViewProps & { language?: string }) {
  const [tab, setTab] = useUiChoice<Tab>(ui, 'tab', ['inbox', 'saved', 'sources'], 'inbox')
  const [filter, setFilter] = useUiChoice<Filter>(ui, 'filter', ['all', 'unread', 'new'], 'all')
  const [kind, setKind] = useUiField<string>(ui, 'kind', '', (value): value is string => typeof value === 'string')
  const [query, setQuery] = useUiField<string>(ui, 'query', '', (value): value is string => typeof value === 'string')
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [entriesLoaded, setEntriesLoaded] = useState(false)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const requestEpoch = useRef(0)
  const [counts, setCounts] = useState<Counts>({ unread: 0, unseen: 0, saved: 0, all: 0 })
  const [selected, setSelected] = useState<string>()
  const [entry, setEntry] = useState<Entry>()
  const [readerError, setReaderError] = useState<string>()
  const [sources, setSources] = useState<Source[]>([])
  const [health, setHealth] = useState({ total: 0, ok: 0, error: 0, paused: 0 })
  const [settings, setSettings] = useState<Settings>()
  const [settingsError, setSettingsError] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [dialog, setDialog] = useState<DialogKind>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeDialog = useCallback(() => { setDialog(undefined) }, [])
  useModalFocus(dialog !== undefined, dialogRef, closeDialog)
  const [draft, setDraft] = useState({ url: '', title: '', kind: 'rss', name: '', repo: '', selector: '', interval: '', opml: '', token: '' })
  const [dialogError, setDialogError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Source>()
  const [clearTokenOpen, setClearTokenOpen] = useState(false)
  const tRef = useRef(t)
  tRef.current = t
  const contextRef = useRef(pageContext)
  contextRef.current = pageContext

  const listArgs = useCallback((nextTab: Tab = tab, nextFilter: Filter = filter, nextKind: string = kind, nextQuery: string = search) => {
    const args: Record<string, unknown> = { view: nextTab === 'saved' ? 'saved' : 'inbox' }
    if (nextFilter === 'unread') args.unread = true
    if (nextFilter === 'new') args.newOnly = true
    if (nextKind !== '') args.kind = nextKind
    if (nextQuery.trim() !== '') args.search = nextQuery.trim()
    return args
  }, [tab, filter, kind, search])

  const loadEntries = useCallback(async (args?: Record<string, unknown>, append = false) => {
    const epoch = ++requestEpoch.current
    const request = args ?? listArgs()
    const outcome = await call('listEntries', request as never)
    if (epoch !== requestEpoch.current) return
    const value = valueOf<ListResult>(outcome)
    if (value === undefined) {
      setError(messageOf(outcome) ?? tRef.current('view.loadFailed'))
      return
    }
    if (append) {
      setEntries(current => [...current, ...value.entries])
    } else {
      setEntries(value.entries)
    }
    setTotal(value.total)
    setCounts(value.counts)
    setEntriesLoaded(true)
    setError(undefined)
  }, [call, listArgs])

  const loadMore = useCallback(async () => {
    /* v8 ignore next -- the button is hidden once the last page is loaded; this guards a double click */
    if (loadingMore || entries.length >= total) return
    setLoadingMore(true)
    try { await loadEntries({ ...listArgs(), offset: entries.length }, true) } finally { setLoadingMore(false) }
  }, [entries.length, listArgs, loadEntries, loadingMore, total])

  const loadSources = useCallback(async () => {
    const outcome = await call('listSources', {})
    const value = valueOf<SourcesResult>(outcome)
    if (value === undefined) { setError(messageOf(outcome) ?? tRef.current('view.loadFailed')); return }
    setSources(value.sources)
    setHealth(value.health)
  }, [call])

  const loadSettings = useCallback(async () => {
    const outcome = await call('settings', {})
    const value = valueOf<Settings>(outcome)
    if (value === undefined) { setSettingsError(messageOf(outcome) ?? tRef.current('view.loadFailed')); return }
    setSettings(value)
    setSettingsError(undefined)
  }, [call])

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query) }, 250)
    return () => { clearTimeout(timer) }
  }, [query])

  const reload = useCallback(async () => {
    if (tab === 'sources') await loadSources()
    else {
      // Sources are needed beside the entries too: the rows label an entry
      // by its source's display name, not by the raw source id.
      await loadEntries()
      await loadSources()
    }
    await loadSettings()
  }, [tab, loadEntries, loadSources, loadSettings])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => onChanged(() => { void reload() }), [onChanged, reload])
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
  }, [])

  const replaceEntry = useCallback((next: Entry) => {
    setEntry(next)
    setEntries(current => current.map(item => item.id === next.id ? next : item))
  }, [])

  const open = useCallback(async (id: string) => {
    setSelected(id)
    setEntry(undefined)
    setReaderError(undefined)
    const outcome = await call('getEntry', { id })
    const value = valueOf<Entry>(outcome)
    if (value === undefined) {
      setReaderError(messageOf(outcome) ?? tRef.current('view.loadFailed'))
      return
    }
    setEntry(value)
    setError(undefined)
    if (value.seenAt === undefined) {
      const seen = await call('markSeen', { ids: [id] })
      if (seen.status === 'success') {
        patchEntry(id, { seenAt: Date.now() })
        setCounts(current => ({ ...current, unseen: Math.max(0, current.unseen - 1) }))
      }
    }
  }, [call, patchEntry])

  useEffect(() => {
    if (selected === undefined || entry !== undefined || readerError !== undefined) return
    void open(selected)
  }, [entry, open, readerError, selected])

  const changeTab = (next: string): void => {
    const value = next as Tab
    setTab(value)
    setSelected(undefined)
    setEntry(undefined)
    setReaderError(undefined)
    setFilter('all')
    setKind('')
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    const outcome = await call('refresh', { scope: 'all' })
    const value = valueOf<{ started: boolean; sources: number }>(outcome)
    setBusy(false)
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? tRef.current('view.failedGeneric')); return }
    setNotice(value?.started === true ? t('view.refreshStarted', { count: String(value.sources) }) : t('view.nothingDue'))
    await reload()
  }

  const toggleRead = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined) return
    const outcome = await call('markRead', { ids: [entry.id], read: entry.readAt === undefined })
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? t('view.failedGeneric')); return }
    const read = entry.readAt === undefined
    const next = { ...entry }
    if (read) next.readAt = Date.now()
    else delete next.readAt
    replaceEntry(next)
    setCounts(current => ({ ...current, unread: Math.max(0, current.unread + (read ? -1 : 1)) }))
  }

  const favorite = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined) return
    const outcome = await call('favorite', { id: entry.id, favorite: !entry.favorite })
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? t('view.failedGeneric')); return }
    const next = !entry.favorite
    patchEntry(entry.id, { favorite: next })
    setCounts(current => ({ ...current, saved: Math.max(0, current.saved + (next ? 1 : -1)) }))
  }

  const saveToTask = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined) return
    const outcome = await call('saveToTask', { id: entry.id })
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? t('view.taskFailed')); return }
    setNotice(t('view.taskDone'))
    await open(entry.id)
  }

  const saveToNote = async (): Promise<void> => {
    /* v8 ignore next -- these handlers render only for an open entry/dialog */
    if (entry === undefined) return
    const outcome = await call('saveToNote', { id: entry.id })
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? t('view.noteFailed')); return }
    setNotice(t('view.noteDone'))
    await open(entry.id)
  }

  const submitLink = async (): Promise<void> => {
    setBusy(true)
    const outcome = await call('addManualLink', { url: draft.url.trim(), title: draft.title.trim() || undefined } as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(messageOf(outcome) ?? t('view.failedGeneric')); return }
    setDialog(undefined)
    setNotice(t('view.linkAdded'))
    setDraft(current => ({ ...current, url: '', title: '' }))
    await loadEntries()
  }

  const submitSource = async (): Promise<void> => {
    setBusy(true)
    const kindValue = draft.kind
    const outcome = await call('addSource', {
      kind: kindValue,
      url: draft.url.trim() || undefined,
      name: draft.name.trim() || undefined,
      repo: draft.repo.trim() || undefined,
      selector: draft.selector.trim() || undefined,
      ...(draft.interval.trim() === '' ? {} : { intervalMs: Number(draft.interval) * 60_000 }),
    } as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(messageOf(outcome) ?? t('view.failedGeneric')); return }
    setDialog(undefined)
    setNotice(t('view.addedSource'))
    setDraft(current => ({ ...current, url: '', name: '', repo: '', selector: '', interval: '' }))
    await loadSources()
  }

  const toggleSource = async (source: Source): Promise<void> => {
    const outcome = await call('updateSource', { id: source.id, expectedVersion: source.version, patch: { enabled: !source.enabled } })
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? t('view.failedGeneric')); return }
    setNotice(t('view.updatedSource'))
    await loadSources()
  }

  const removeSource = async (source: Source): Promise<void> => {
    const outcome = await call('removeSource', { id: source.id })
    if (outcome.status !== 'success') {
      setError(messageOf(outcome) ?? t('view.failedGeneric'))
      setRemoveTarget(undefined)
      return
    }
    setRemoveTarget(undefined)
    setNotice(t('view.removedSource'))
    await loadSources()
  }

  const refreshSource = async (source: Source): Promise<void> => {
    const outcome = await call('refresh', { sourceId: source.id })
    if (outcome.status !== 'success') { setError(messageOf(outcome) ?? t('view.failedGeneric')); return }
    setNotice(t('view.sourceRefreshed'))
    await loadSources()
  }

  const clearGithubToken = async (): Promise<void> => {
    setBusy(true)
    setClearTokenOpen(false)
    const outcome = await call('setSettings', { githubToken: null } as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(messageOf(outcome) ?? t('view.settingsFailed')); return }
    setSettings(valueOf<Settings>(outcome))
    setNotice(t('view.tokenCleared'))
  }

  const submitOpml = async (): Promise<void> => {
    setBusy(true)
    const outcome = await call('importOpml', { xml: draft.opml })
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(messageOf(outcome) ?? t('view.failedGeneric')); return }
    const value = valueOf<{ added: number; skipped: number; invalid: number }>(outcome)!
    setDialog(undefined)
    setNotice(t('view.opmlDone', { added: String(value.added), skipped: String(value.skipped), invalid: String(value.invalid) }))
    await loadSources()
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
      watchRefreshMs: settings.watchRefreshMs,
    }
    const args: Record<string, unknown> = { patch }
    if (draft.token.trim() !== '') args.githubToken = draft.token.trim()
    setBusy(true)
    const outcome = await call('setSettings', args as never)
    setBusy(false)
    if (outcome.status !== 'success') { setDialogError(messageOf(outcome) ?? t('view.settingsFailed')); return }
    setDialog(undefined)
    setSettings(valueOf<Settings>(outcome))
    setNotice(t('view.settingsSaved'))
    setDraft(current => ({ ...current, token: '' }))
  }

  const visibleSources = useMemo(() => new Map(sources.map(source => [source.id, source])), [sources])
  const sourceName = (id: string | undefined): string => id === undefined ? t('view.sourceManual') : (visibleSources.get(id)?.name ?? id)
  const externalHref = entry === undefined ? undefined : safeHrefForExternal(entry.url)
  const tabs = [
    { id: 'inbox', label: t('view.inbox'), suffix: counts.unread > 0 ? <span className={css.badge}>{counts.unread}</span> : undefined },
    { id: 'saved', label: t('view.saved'), suffix: counts.saved > 0 ? <span className={css.badge}>{counts.saved}</span> : undefined },
    { id: 'sources', label: t('view.sources') },
  ]

  return (
    <div className={css.page} data-inbox-page>
      <TabBar
        tabs={tabs}
        active={tab}
        onSelect={changeTab}
        tools={(
          <div className={css.tools} data-inbox-tools>
            {tab !== 'sources' && <input className={css.search} value={query} onChange={event => { setQuery(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void loadEntries() }} placeholder={t('view.search')} aria-label={t('view.search')} />}
            {tab !== 'sources' && <button type="button" className={css.button} onClick={() => { setDialog('link'); setDialogError(undefined) }}>{t('view.addLink')}</button>}
            {tab === 'inbox' && <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void refresh() }} disabled={busy || running}>{t('view.refresh')}</button>}
            {tab === 'sources' && <button type="button" className={css.button} onClick={() => { setDialog('opml'); setDialogError(undefined) }}>{t('view.importOpml')}</button>}
            {tab === 'sources' && <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { setDialog('source'); setDialogError(undefined) }}>{t('view.addSource')}</button>}
            <button type="button" className={css.button} onClick={() => { setDialog('settings'); setDialogError(undefined) }}>{t('view.settings')}</button>
          </div>
        )}
      />
      {error !== undefined && <div className={css.error} role="alert" data-inbox-error>{error}</div>}
      {notice !== undefined && <div className={css.notice} role="status" data-inbox-notice>{notice}</div>}
      {tab === 'sources' ? (
        <div className={css.sources} data-inbox-sources>
          <p className={css.sourcesSummary}>{t('view.sourcesSummary', { total: String(health.total) })} · {t('view.healthOk')} {health.ok} · {t('view.healthError')} {health.error} · {t('view.healthPaused')} {health.paused}</p>
          {sources.map(source => (
            <article key={source.id} className={css.sourceCard} data-inbox-source={source.id} data-source-enabled={source.enabled ? 'true' : 'false'}>
              <div className={css.sourceHead}><strong>{source.name}</strong><span className={css.tag}>{source.kind}</span><span className={css.spacer} /><span className={css.meta}>{source.enabled ? (source.lastError === undefined ? t('view.healthOk') : t('view.healthError')) : t('view.healthPaused')}</span></div>
              <div className={css.sourceMeta}>{source.url} · {source.entryCount} {t('view.listSummaryPlain', { total: '' }).trim()}</div>
              <div className={css.sourceMeta}>{t('view.lastChecked')}: {when(source.lastCheckedAt ?? source.lastSuccessAt, language)}</div>
              {source.lastError !== undefined && <div className={css.error}>{source.lastError}</div>}
              <div className={css.actions}>
                <button type="button" className={css.button} onClick={() => { void refreshSource(source) }}>{t('view.sourceRefresh')}</button>
                <button type="button" className={css.button} onClick={() => { void toggleSource(source) }} data-inbox-source-toggle={source.id}>{source.enabled ? t('view.sourcePause') : t('view.sourceResume')}</button>
                <button type="button" className={css.button} onClick={() => { setRemoveTarget(source) }} data-inbox-source-remove={source.id}>{t('view.sourceRemove')}</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className={css.body} data-inbox-body>
          <aside className={`${css.list} ${selected !== undefined ? css.listHidden : ''}`} data-inbox-list>
            <div className={css.filters}>
              {(['all', 'unread', 'new'] as const).map(value => (
                <button key={value} type="button" className={`${css.chip} ${filter === value ? css.chipActive : ''}`} onClick={() => { setFilter(value) }} data-inbox-filter={value}>
                  {value === 'all' ? t('view.all') : value === 'unread' ? t('view.unread') : t('view.new')}
                </button>
              ))}
              <span className={css.spacer} />
              <select className={css.select} value={kind} onChange={event => { setKind(event.target.value) }} aria-label={t('view.kindAll')}>
                <option value="">{t('view.kindAll')}</option>
                <option value="github">{t('view.kindGithub')}</option>
                <option value="rss">{t('view.kindRss')}</option>
                <option value="web">{t('view.kindWeb')}</option>
                <option value="manual">{t('view.kindManual')}</option>
              </select>
            </div>
            <div className={css.listSummary}>{tab === 'inbox' ? t('view.listSummary', { total: String(counts.all), unread: String(counts.unread) }) : t('view.listSummaryPlain', { total: String(counts.saved) })}</div>
            <div className={css.entries}>
              {!entriesLoaded && error !== undefined ? (
                <div className={css.error} role="alert" data-inbox-list-error>
                  <span>{error}</span>
                  <button type="button" className={css.button} onClick={() => { void loadEntries() }} data-inbox-list-retry>{t('view.retry')}</button>
                </div>
              ) : !entriesLoaded ? <EmptyState title={t('view.loading')} data-inbox-loading /> : entries.length === 0 ? (
                <EmptyState
                  title={filter === 'all' && kind === '' ? t('view.empty') : t('view.emptyFiltered')}
                  body={filter === 'all' && kind === '' ? t('view.emptyHint') : t('view.emptyFilteredHint')}
                  action={filter === 'all' && kind === '' ? (
                    <button type="button" className={css.button} onClick={() => { changeTab('sources') }} data-inbox-empty-sources>{t('view.emptyAddSource')}</button>
                  ) : (
                    <button type="button" className={css.button} onClick={() => { setFilter('all'); setKind('') }} data-inbox-clear-filters>{t('view.clearFilters')}</button>
                  )}
                  data-inbox-empty
                />
              ) : entries.map(item => (
                <button key={item.id} type="button" className={`${css.entry} ${item.id === selected ? css.entryActive : ''}`} onClick={() => { void open(item.id) }} data-inbox-entry={item.id}>
                  <span className={css.entryTop}><span className={css.sourceSmall}>{sourceName(item.sourceId)}</span><span className={css.spacer} /><span className={css.meta}>{when(item.publishedAt ?? item.fetchedAt, language)}</span></span>
                  <span className={css.entryTitle}>{item.title}</span>
                  <span className={css.entrySummary}>{plainSummary(item.summary)}</span>
                  <span className={css.entryFoot}>{item.readAt === undefined ? <span className={css.unreadDot} /> : null}{item.seenAt === undefined ? <span className={css.tag}>{t('view.newBadge')}</span> : null}{item.favorite ? <span className={css.star}>★</span> : null}</span>
                </button>
              ))}
              {entries.length > 0 && entries.length < total ? (
                <button type="button" className={css.button} onClick={() => { void loadMore() }} disabled={loadingMore} data-inbox-load-more>
                  {loadingMore ? t('view.loadingMore') : t('view.loadMore')}
                </button>
              ) : null}
            </div>
          </aside>
          <section className={`${css.reader} ${selected === undefined ? css.readerEmpty : ''}`} data-inbox-reader>
            {selected === undefined ? <EmptyState title={t('view.selectEntry')} body={t('view.selectHint')} /> : readerError !== undefined ? (
              <EmptyState
                title={t('view.readerFailed')}
                body={readerError}
                action={(
                  <div className={css.actions}>
                    <button type="button" className={css.button} onClick={() => { void open(selected) }} data-inbox-reader-retry>{t('view.retry')}</button>
                    <button type="button" className={css.button} onClick={() => { setSelected(undefined); setReaderError(undefined); setEntry(undefined) }} data-inbox-reader-back>{t('view.back')}</button>
                  </div>
                )}
                data-inbox-reader-error
              />
            ) : entry === undefined ? (
              <EmptyState title={t('view.loading')} data-inbox-reader-loading />
            ) : (
              <>
                <div className={css.readerHead}>
                  <button type="button" className={css.back} onClick={() => { setSelected(undefined); setEntry(undefined) }} data-inbox-back>{t('view.back')}</button>
                  <span className={css.sourceSmall}>{sourceName(entry.sourceId)}</span>
                  <span className={css.spacer} />
                  <span className={css.meta}>{when(entry.publishedAt ?? entry.fetchedAt, language)}</span>
                </div>
                <h1 className={css.readerTitle}>{entry.title}</h1>
                <div className={css.readerMeta}>{entry.favorite ? <span className={css.tag}>★ {t('view.favorite')}</span> : null}{entry.taskId !== undefined ? <span className={css.tag}>{t('view.taskDone')}</span> : null}{entry.noteId !== undefined ? <span className={css.tag}>{t('view.noteDone')}</span> : null}</div>
                <div className={css.external}>△ {t('view.external')}</div>
                <div className={css.actions}>
                  {externalHref !== undefined && <a className={css.button} href={externalHref} target="_blank" rel="noreferrer">{t('view.open')} ↗</a>}
                  <button type="button" className={css.button} onClick={() => { void toggleRead() }}>{entry.readAt === undefined ? t('view.markRead') : t('view.markUnread')}</button>
                  <button type="button" className={css.button} onClick={() => { void favorite() }}>{entry.favorite ? t('view.unfavorite') : t('view.favorite')}</button>
                  <span className={css.spacer} />
                  <button type="button" className={css.button} onClick={() => { void saveToTask() }} disabled={entry.taskId !== undefined}>{entry.taskId === undefined ? t('view.task') : t('view.taskDone')}</button>
                  <button type="button" className={css.button} onClick={() => { void saveToNote() }} disabled={entry.noteId !== undefined}>{entry.noteId === undefined ? t('view.note') : t('view.noteDone')}</button>
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
        open={clearTokenOpen}
        onClose={() => { if (!busy) setClearTokenOpen(false) }}
        title={t('view.tokenClear')}
        tone="warning"
        closeLabel={t('view.close')}
        footer={(
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setClearTokenOpen(false) }}>{t('view.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { void clearGithubToken() }} data-inbox-token-clear-confirm>{t('view.tokenClear')}</Button>
          </>
        )}
      >
        <p>{t('view.tokenClearConfirm')}</p>
      </Modal>
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
        <p>{t('view.confirmRemoveSource', { name: removeTarget?.name ?? '' })}</p>
      </Modal>
      {dialog !== undefined && (
        <div className={css.backdrop} role="presentation" onClick={closeDialog}>
          <div ref={dialogRef} className={css.modal} role="dialog" aria-modal="true" aria-labelledby="inbox-dialog-title" tabIndex={-1} data-inbox-dialog={dialog} onClick={event => { event.stopPropagation() }}>
            <div className={css.modalHead}><h2 id="inbox-dialog-title">{dialog === 'link' ? t('view.addLinkTitle') : dialog === 'source' ? t('view.addSourceTitle') : dialog === 'opml' ? t('view.opmlTitle') : t('view.settings')}</h2><button type="button" className={css.close} onClick={closeDialog} aria-label={t('view.close')}>×</button></div>
            {dialog === 'link' && (
              <div className={css.form}>
                <label>{t('view.url')}<input autoFocus value={draft.url} onChange={event => { setDraft({ ...draft, url: event.target.value }) }} /></label>
                <label>{t('view.title')}<input value={draft.title} onChange={event => { setDraft({ ...draft, title: event.target.value }) }} placeholder={t('view.titleHint')} /></label>
                <div className={css.formActions}><button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button><button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitLink() }} disabled={busy || !/^https?:\/\//u.test(draft.url.trim())}>{t('view.add')}</button></div>
              </div>
            )}
            {dialog === 'source' && (
              <div className={css.form}>
                <label>{t('view.kind')}<select value={draft.kind} onChange={event => { setDraft({ ...draft, kind: event.target.value }) }}><option value="rss">RSS</option><option value="github">GitHub</option><option value="web">{t('view.kindWeb')}</option></select></label>
                <label>{t('view.url')}<input autoFocus value={draft.url} onChange={event => { setDraft({ ...draft, url: event.target.value }) }} /></label>
                <label>{t('view.name')}<input value={draft.name} onChange={event => { setDraft({ ...draft, name: event.target.value }) }} /></label>
                {draft.kind === 'github' && <label>{t('view.repo')}<input value={draft.repo} onChange={event => { setDraft({ ...draft, repo: event.target.value }) }} placeholder="owner/repo" /></label>}
                {draft.kind === 'web' && <label>{t('view.selector')}<input value={draft.selector} onChange={event => { setDraft({ ...draft, selector: event.target.value }) }} /></label>}
                <label>{t('view.interval')}<input type="number" min="0" value={draft.interval} onChange={event => { setDraft({ ...draft, interval: event.target.value }) }} /></label>
                <div className={css.formActions}><button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button><button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitSource() }} disabled={busy}>{t('view.add')}</button></div>
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
                <label>{t('view.watchInterval')}<input type="number" value={Math.round(settings.watchRefreshMs / 60_000)} onChange={event => { setSettings({ ...settings, watchRefreshMs: Number(event.target.value) * 60_000 }) }} /></label>
                <label>{t('view.githubToken')} <span className={css.tag}>{settings.githubTokenSet ? t('view.tokenSet') : t('view.tokenUnset')}</span><input type="password" value={draft.token} onChange={event => { setDraft({ ...draft, token: event.target.value }) }} placeholder={t('view.tokenHint')} /></label>
                <div className={css.formActions}>
                  {settings.githubTokenSet ? <button type="button" className={css.button} disabled={busy} onClick={() => { setClearTokenOpen(true) }} data-inbox-token-clear>{t('view.tokenClear')}</button> : null}
                  <button type="button" className={css.button} onClick={() => { setDialog(undefined) }}>{t('view.cancel')}</button>
                  <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { void submitSettings() }} disabled={busy}>{t('view.saveSettings')}</button>
                </div>
              </div>
            )}
            {dialog === 'settings' && settings === undefined ? (
              <div className={css.form} data-inbox-settings-loading>
                <p>{settingsError ?? t('view.loading')}</p>
                {settingsError === undefined ? null : <button type="button" className={css.button} onClick={() => { void loadSettings() }}>{t('view.retry')}</button>}
              </div>
            ) : null}
            {dialogError !== undefined && <div className={css.error} role="alert" data-inbox-dialog-error>{dialogError}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
