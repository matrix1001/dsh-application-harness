/**
 * The disk-space page: the scan toolbar (path, directory picker, start,
 * history), the four summary cards, the CSS-flex treemap, the largest
 * directory/file tables, duplicate groups and the reversible trash.
 *
 * The page owns only presentation and its own request state. Every read and
 * write goes through the shell's single `call` face; a scan keeps running
 * after `startScan` returns, so the page polls `readScan` while the row says
 * `running`/`cancelling` and cancels through the application's own operation.
 *
 * If the deployment serves no directory picker the picker affordance reports
 * that fact and leaves the path input as the only route — the page never
 * fabricates a path or calls the browser's own `showDirectoryPicker`.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EmptyState, TabBar, Toolbar, type AppTab } from '@matrix1001/dsh-application-harness-client-chrome'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import css from './DiskSpaceView.module.css'
import { NS, type DiskSpaceKey } from './locales.ts'

/** The polling interval while a heavy run is in flight. */
const POLL_MS = 400

/** The translate face this package's dictionary provides. */
export type DiskSpaceTranslate = (key: DiskSpaceKey, params?: Record<string, unknown>) => string

interface StagePlan {
  readonly scan: Scan
  readonly paths: string[]
  readonly groups: number
  readonly bytes: number
  readonly keep: string[]
}

/** One scan's lifecycle (mirrors the host's wire state). */
export type ScanState = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'

/** One duplicate analysis's lifecycle. */
export type DuplicateState = 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'

/** The scan's latest progress. */
export interface ScanProgress {
  files: number
  dirs: number
  bytes: number
  skipped: number
  currentPath: string | null
}

/** The summary of a completed duplicate analysis. */
export interface DuplicateSummary {
  groups: number
  wastedBytes: number
  hashedFiles: number
  skippedFiles: number
  completedAt: number
}

/** One scan as the host's operations return it. */
export interface Scan {
  scanId: string
  root: string
  state: ScanState
  startedAt: number
  endedAt: number | null
  progress: ScanProgress
  files: number
  dirs: number
  bytes: number
  excludes: string[]
  crossFileSystems: boolean
  error: { code: string; message: string } | null
  duplicateState: DuplicateState
  duplicate: DuplicateSummary | null
}

/** One indexed file or directory. */
export interface BrowseEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
}

/** One duplicate group. */
export interface DuplicateGroup {
  groupId: string
  hash: string
  size: number
  paths: string[]
  wastedBytes: number
}

/** One trashed entry. */
export interface TrashEntry {
  id: string
  scanId: string
  root: string
  sourcePath: string
  trashPath: string
  size: number
  movedAt: number
}

/** The props of the registered page (the shell's face plus the locale service). */
export interface DiskSpacePageProps extends ApplicationViewProps {
  /** The client locale service. */
  locale: LocaleRuntime
  /** Ask the host for a directory; undefined = no picker in this deployment. */
  pickDirectory?: () => Promise<string | undefined>
}

/** The props of the page implementation (the shell's face plus this package's translate). */
export interface DiskSpaceViewProps extends ApplicationViewProps {
  /** The bound translate face of this package's dictionary. */
  t: DiskSpaceTranslate
  /** Ask the host for a directory; undefined = no picker in this deployment. */
  pickDirectory?: () => Promise<string | undefined>
}

/** One call's usable outcome. */
type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

/** The dictionary keys for the five scan states. */
const SCAN_STATE_KEY: Record<ScanState, DiskSpaceKey> = {
  running: 'view.scan.state.running',
  cancelling: 'view.scan.state.cancelling',
  completed: 'view.scan.state.completed',
  cancelled: 'view.scan.state.cancelled',
  failed: 'view.scan.state.failed',
}

/** The accepted page tabs. */
type TabId = 'browse' | 'duplicates' | 'trash'

/** Format one byte count for display. */
export function formatBytes(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = safe
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  const rounded = amount >= 100 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)
  return `${rounded} ${units[unit]}`
}

/** Format one share of a total. */
export function formatPercent(part: number, total: number): string {
  if (total <= 0) return '—'
  return `${((part / total) * 100).toFixed(1)}%`
}

/** Format one epoch-ms instant with the browser locale. */
export function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

/**
 * Narrow one `{ scan }` response onto the page's scan shape; `null` means the
 * result was malformed (a host/view version skew).
 */
export function scanOf(value: unknown): Scan | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = (value as { scan?: unknown }).scan
  if (typeof candidate !== 'object' || candidate === null) return null
  const scan = candidate as Partial<Scan>
  if (typeof scan.scanId !== 'string' || typeof scan.root !== 'string' || typeof scan.state !== 'string') return null
  return scan as Scan
}

/**
 * The registered page: bind the locale dictionaries, then render the view.
 * @param props - the shell's view face, the locale service and the picker.
 * @returns the page.
 */
export function DiskSpacePage({ locale, ...props }: DiskSpacePageProps) {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <DiskSpaceView {...props} t={locale.bind(NS) as DiskSpaceTranslate} />
}

/**
 * The page implementation.
 * @param props - the shell's view face and this package's translate.
 * @returns the page.
 */
export function DiskSpaceView({ call, onChanged, running, t, pickDirectory }: DiskSpaceViewProps) {
  const [tab, setTab] = useState<TabId>('browse')
  const [scans, setScans] = useState<Scan[]>([])
  const [scan, setScan] = useState<Scan | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [files, setFiles] = useState<BrowseEntry[]>([])
  const [groups, setGroups] = useState<DuplicateGroup[]>([])
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [path, setPath] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [stagePlan, setStagePlan] = useState<StagePlan>()
  const [pollFailed, setPollFailed] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [excludeCommon, setExcludeCommon] = useState(true)
  const [crossFileSystems, setCrossFileSystems] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState<string | undefined>(undefined)

  const translate = t

  /** Call one operation and turn the shell's four-way outcome into two. */
  const callOp = async <T,>(op: string, args: Record<string, unknown>): Promise<Outcome<T>> => {
    try {
      const outcome = await call(op, args as unknown as JsonValue)
      if (outcome.status === 'success') return { ok: true, value: outcome.result as T }
      if (outcome.status === 'cancelled') return { ok: false, message: translate('view.error.cancelled') }
      return { ok: false, message: translate('view.error.failed', { message: outcome.error?.message ?? 'failed' }) }
    } catch (caught) {
      return { ok: false, message: translate('view.error.failed', { message: caught instanceof Error ? caught.message : String(caught) }) }
    }
  }

  /** Load the browse, large-file, duplicate and trash faces of one scan. */
  const loadDetails = async (scanId: string): Promise<void> => {
    const browseOutcome = await callOp<{ entries: BrowseEntry[] }>('browseDirectory', { scanId, path: '' })
    if (!browseOutcome.ok) { setError(browseOutcome.message); return }
    const filesOutcome = await callOp<{ files: BrowseEntry[] }>('listLargeFiles', { scanId, limit: 8 })
    if (!filesOutcome.ok) { setError(filesOutcome.message); return }
    const groupsOutcome = await callOp<{ groups: DuplicateGroup[] }>('listDuplicateGroups', { scanId, limit: 50 })
    if (!groupsOutcome.ok) { setError(groupsOutcome.message); return }
    const trashOutcome = await callOp<{ entries: TrashEntry[] }>('listTrash', {})
    setEntries(Array.isArray(browseOutcome.value.entries) ? browseOutcome.value.entries : [])
    setFiles(Array.isArray(filesOutcome.value.files) ? filesOutcome.value.files : [])
    setGroups(Array.isArray(groupsOutcome.value.groups) ? groupsOutcome.value.groups : [])
    if (trashOutcome.ok) setTrash(Array.isArray(trashOutcome.value.entries) ? trashOutcome.value.entries : [])
    setCurrentPath('')
    setSelected([])
  }

  /** Apply one scan row and load its detail when it has already settled. */
  const applyScan = async (next: Scan): Promise<void> => {
    setScan(next)
    setPath(next.root)
    setEntries([])
    setFiles([])
    setGroups([])
    setCurrentPath('')
    if (next.state === 'completed') await loadDetails(next.scanId)
  }

  /** The first read: history, trash and the newest scan's details. */
  const bootstrap = async (): Promise<void> => {
    setBusy('load')
    const scansOutcome = await callOp<{ scans: Scan[] }>('listScans', { limit: 20 })
    if (!scansOutcome.ok) setError(scansOutcome.message)
    else {
      const history = Array.isArray(scansOutcome.value.scans) ? scansOutcome.value.scans : []
      setScans(history)
      if (history[0] !== undefined) await applyScan(history[0])
    }
    const trashOutcome = await callOp<{ entries: TrashEntry[] }>('listTrash', {})
    if (trashOutcome.ok) setTrash(Array.isArray(trashOutcome.value.entries) ? trashOutcome.value.entries : [])
    setBusy(undefined)
  }

  /** Read the live scan row once and refresh the page when it settled. */
  const poll = async (scanId: string): Promise<void> => {
    const outcome = await callOp<{ scan: unknown }>('readScan', { scanId })
    if (!outcome.ok) { setError(outcome.message); setPollFailed(true); return }
    setPollFailed(false)
    const next = scanOf(outcome.value)
    if (next === null) { setError(translate('view.error.malformed')); return }
    setScan(next)
    setScans(previous => {
      const exists = previous.some(item => item.scanId === next.scanId)
      return exists ? previous.map(item => (item.scanId === next.scanId ? next : item)) : [next, ...previous]
    })
    if (next.state === 'completed') await loadDetails(next.scanId)
  }

  /** Start one scan of the typed path. */
  const startScan = async (): Promise<void> => {
    const directory = path.trim()
    if (directory === '') { setError(translate('view.notice.emptyPath')); return }
    setBusy('scan')
    setError(undefined)
    setNotice(undefined)
    const excludes = excludeCommon ? ['node_modules', '.git'] : []
    const outcome = await callOp<{ scan: unknown }>('startScan', {
      dir: directory,
      ...(excludes.length === 0 ? {} : { excludes }),
      ...(crossFileSystems ? { crossFileSystems: true } : {}),
    })
    const next = outcome.ok ? scanOf(outcome.value) : null
    if (!outcome.ok) setError(outcome.message)
    else if (next === null) setError(translate('view.error.malformed'))
    else {
      setScan(next)
      setPath(next.root)
      setEntries([])
      setFiles([])
      setGroups([])
      setCurrentPath('')
      setScans(previous => [next, ...previous.filter(item => item.scanId !== next.scanId)])
      setSelected([])
      if (next.state === 'completed') await loadDetails(next.scanId)
    }
    setBusy(undefined)
  }

  /** Ask the running scan or analysis to stop. */
  const cancelCurrent = async (target: Scan): Promise<void> => {
    setBusy('cancel')
    const outcome = await callOp<{ scan: unknown }>('cancelScan', { scanId: target.scanId })
    const next = outcome.ok ? scanOf(outcome.value) : null
    if (!outcome.ok) setError(outcome.message)
    else if (next !== null) setScan(next)
    setBusy(undefined)
  }

  /** Start duplicate analysis on the current scan. */
  const startDuplicates = async (target: Scan): Promise<void> => {
    setBusy('duplicates')
    setError(undefined)
    const outcome = await callOp<{ scan: unknown }>('startDuplicateAnalysis', { scanId: target.scanId })
    const next = outcome.ok ? scanOf(outcome.value) : null
    if (!outcome.ok) setError(outcome.message)
    else if (next === null) setError(translate('view.error.malformed'))
    else setScan(next)
    setBusy(undefined)
  }

  /** Open one root-relative directory in the browse table. */
  const openDirectory = async (target: Scan, relative: string): Promise<void> => {
    setBusy('browse')
    const outcome = await callOp<{ entries: BrowseEntry[] }>('browseDirectory', { scanId: target.scanId, path: relative })
    if (!outcome.ok) setError(outcome.message)
    else {
      setEntries(Array.isArray(outcome.value.entries) ? outcome.value.entries : [])
      setCurrentPath(relative)
      setNotice(translate('view.browse.drill', { path: relative }))
      setError(undefined)
    }
    setBusy(undefined)
  }

  /** Open one history row. */
  const openScan = async (scanId: string): Promise<void> => {
    setBusy('history')
    setHistoryOpen(false)
    const outcome = await callOp<{ scan: unknown }>('readScan', { scanId })
    const next = outcome.ok ? scanOf(outcome.value) : null
    if (!outcome.ok) setError(outcome.message)
    else if (next === null) setError(translate('view.error.malformed'))
    else await applyScan(next)
    setBusy(undefined)
  }

  /** Toggle one duplicate group's selection. */
  const toggleGroup = (groupId: string): void => {
    setSelected(previous => previous.includes(groupId) ? previous.filter(id => id !== groupId) : [...previous, groupId])
  }

  /** Ask for confirmation before moving every selected group's redundant copies. */
  const requestStage = (target: Scan): void => {
    const chosen = groups.filter(group => selected.includes(group.groupId))
    const paths = chosen.flatMap(group => group.paths.slice(1))
    if (paths.length === 0) { setNotice(translate('view.duplicates.noneSelected')); return }
    setStagePlan({
      scan: target,
      paths,
      groups: chosen.length,
      bytes: chosen.reduce((sum, group) => sum + group.wastedBytes, 0),
      keep: chosen.map(group => group.paths[0] ?? ''),
    })
  }

  /** Move the confirmed redundant copies into the trash, then re-read the result. */
  const stageSelected = async (plan: StagePlan): Promise<void> => {
    setBusy('stage')
    const outcome = await callOp<{ staged: TrashEntry[] }>('stageEntries', { scanId: plan.scan.scanId, paths: plan.paths })
    if (!outcome.ok) setError(outcome.message)
    else {
      setNotice(translate('view.notice.staged', { count: outcome.value.staged.length }))
      setSelected([])
      setStagePlan(undefined)
      const trashOutcome = await callOp<{ entries: TrashEntry[] }>('listTrash', {})
      if (trashOutcome.ok) setTrash(Array.isArray(trashOutcome.value.entries) ? trashOutcome.value.entries : [])
      await poll(plan.scan.scanId)
    }
    setBusy(undefined)
  }

  /** Refresh the trash list after one trash write. */
  const refreshTrash = async (): Promise<void> => {
    const outcome = await callOp<{ entries: TrashEntry[] }>('listTrash', {})
    if (outcome.ok) setTrash(Array.isArray(outcome.value.entries) ? outcome.value.entries : [])
  }

  /** Restore one trashed entry. */
  const restore = async (id: string): Promise<void> => {
    setBusy('trash')
    const outcome = await callOp<{ restored: { path: string } }>('restoreTrash', { id })
    if (!outcome.ok) setError(outcome.message)
    else {
      setNotice(translate('view.notice.restored', { path: outcome.value.restored.path }))
      await refreshTrash()
    }
    setBusy(undefined)
  }

  /** The two-step purge: the first click arms, the second one deletes. */
  const requestPurge = (id: string): void => {
    if (confirmPurge !== id) { setConfirmPurge(id); return }
    setConfirmPurge(undefined)
    void purge(id)
  }

  /** Permanently delete one trashed entry. */
  const purge = async (id: string): Promise<void> => {
    setBusy('trash')
    const outcome = await callOp<{ purged: boolean }>('purgeTrash', { id })
    if (!outcome.ok) setError(outcome.message)
    else {
      setNotice(translate('view.notice.purged'))
      await refreshTrash()
    }
    setBusy(undefined)
  }

  /** Ask the host for a directory; keep the path input when there is no picker. */
  const pick = async (): Promise<void> => {
    setNotice(undefined)
    if (pickDirectory === undefined) { setNotice(translate('view.notice.pickerUnavailable')); return }
    setBusy('pick')
    try {
      const chosen = await pickDirectory()
      if (chosen === undefined) setNotice(translate('view.notice.pickerUnavailable'))
      else setPath(chosen)
    } catch (caught) {
      setError(translate('view.error.failed', { message: caught instanceof Error ? caught.message : String(caught) }))
    }
    setBusy(undefined)
  }

  // Mount read and the change subscription. The subscription is re-bound only
  // when the shell hands a different callback; the refresh reads the newest
  // scan through a ref so it never resurrects an old closure.
  useEffect(() => { void bootstrap() }, [])
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined)
  refreshRef.current = async () => { if (scan !== null) await poll(scan.scanId) }
  useEffect(() => onChanged(() => { void refreshRef.current?.() }), [onChanged])

  // Poll only while a heavy run is in flight; the effect re-arms on each
  // snapshot and clears its timer on unmount.
  const polling = scan !== null && (scan.state === 'running' || scan.state === 'cancelling'
    || scan.duplicateState === 'running' || scan.duplicateState === 'cancelling')
  useEffect(() => {
    if (!polling) return
    const timer = setTimeout(() => { void poll(scan.scanId) }, POLL_MS)
    return () => { clearTimeout(timer) }
  }, [scan])

  const browsedBytes = entries.reduce((sum, entry) => sum + entry.size, 0) || scan?.bytes || 1
  const dirs = entries.filter(entry => entry.kind === 'dir').sort((a, b) => b.size - a.size)
  const largest = dirs[0]
  const blocks = (dirs.length > 0 ? dirs : entries).slice(0, 8)
  const totalTrashBytes = trash.reduce((sum, item) => sum + item.size, 0)
  const duplicateBytes = scan?.duplicate?.wastedBytes ?? 0
  const duplicateGroups = scan?.duplicate?.groups ?? groups.length
  const scanning = scan !== null && (scan.state === 'running' || scan.state === 'cancelling')
  const anyBusy = busy !== undefined || running || scanning
  const tabs: AppTab[] = [
    { id: 'browse', label: t('view.tab.browse'), suffix: <span className={css.tabCount}>{entries.length}</span>, anchor: { 'data-disk-tab': 'browse' } },
    { id: 'duplicates', label: t('view.tab.duplicates'), suffix: <span className={css.tabCount}>{groups.length}</span>, anchor: { 'data-disk-tab': 'duplicates' } },
    { id: 'trash', label: t('view.tab.trash'), suffix: <span className={css.tabCount}>{trash.length}</span>, anchor: { 'data-disk-tab': 'trash' } },
  ]

  return (
    <div className={css.view} data-disk-view data-disk-busy={anyBusy ? 'true' : 'false'}>
      <Toolbar className={css.toolbar} data-disk-toolbar>
        <input
          className={css.pathInput}
          type="text"
          value={path}
          placeholder={t('view.path.placeholder')}
          aria-label={t('view.path.label')}
          onChange={event => { setPath(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter') void startScan() }}
          data-disk-path-input
        />
        <button type="button" className={css.button} disabled={anyBusy} onClick={() => { void pick() }} data-disk-pick>
          {t('view.pick')}
        </button>
        <button type="button" className={css.primary} disabled={anyBusy} onClick={() => { void startScan() }} data-disk-scan>
          {scan !== null && (scan.state === 'running' || scan.state === 'cancelling') ? t('view.scanning') : t('view.scan')}
        </button>
        <button type="button" className={css.ghost} onClick={() => { setHistoryOpen(value => !value) }} data-disk-history>
          {t('view.history')}
        </button>
        <button type="button" className={css.ghost} aria-expanded={optionsOpen} onClick={() => { setOptionsOpen(value => !value) }} data-disk-options-toggle>
          {t('view.options')}
        </button>
      </Toolbar>

      {optionsOpen ? (
        <section className={css.options} data-disk-options>
          <label>
            <input type="checkbox" checked={excludeCommon} onChange={event => { setExcludeCommon(event.target.checked) }} data-disk-exclude-common />
            {t('view.options.excludeCommon')}
          </label>
          <label>
            <input type="checkbox" checked={crossFileSystems} onChange={event => { setCrossFileSystems(event.target.checked) }} data-disk-cross-filesystems />
            {t('view.options.crossFileSystems')}
          </label>
        </section>
      ) : null}

      {notice !== undefined && <p className={css.notice} data-disk-notice>{notice}</p>}
      {error !== undefined && <p className={css.error} role="alert" data-disk-error>{error}</p>}

      {historyOpen && (
        <section className={css.history} data-disk-history-panel>
          <h2 className={css.historyTitle}>{t('view.history.title')}</h2>
          {scans.length === 0
            ? <p className={css.meta} data-disk-history-empty>{t('view.history.empty')}</p>
            : scans.map(item => (
              <button key={item.scanId} type="button" className={css.historyRow} onClick={() => { void openScan(item.scanId) }} data-disk-history-item={item.scanId}>
                <code className={css.historyPath}>{item.root}</code>
                <span>{formatTime(item.startedAt)}</span>
                <span className={css.meta}>{t(SCAN_STATE_KEY[item.state])}</span>
              </button>
            ))}
        </section>
      )}

      {scan === null
        ? (busy === 'load' ? <EmptyState title={t('view.loading')} data-disk-loading /> : <EmptyState title={t('view.empty')} data-disk-empty />)
        : (
          <>
            {pollFailed ? (
              <p className={css.notice} role="alert" data-disk-poll-failed>
                {t('view.pollFailed')}
                <button type="button" className={css.button} onClick={() => { void poll(scan.scanId) }} data-disk-poll-retry>{t('view.retry')}</button>
              </p>
            ) : null}
            {scan.state === 'cancelled' ? <p className={css.notice} data-disk-cancelled>{t('view.scan.cancelledPartial')}</p> : null}
            {(scan.state === 'running' || scan.state === 'cancelling') && (
              <section className={css.progress} data-disk-scan-progress data-disk-state={scan.state}>
                <div className={css.progressText}>
                  <span>{t('view.progress', { files: scan.progress.files, dirs: scan.progress.dirs, size: formatBytes(scan.progress.bytes) })}</span>
                  {scan.progress.currentPath !== null && <span className={css.meta} data-disk-progress-path>{t('view.progress.path', { path: scan.progress.currentPath })}</span>}
                </div>
                <button type="button" className={css.button} disabled={scan.state === 'cancelling'} onClick={() => { void cancelCurrent(scan) }} data-disk-cancel>
                  {scan.state === 'cancelling' ? t('view.cancelling') : t('view.cancel')}
                </button>
              </section>
            )}

            {scan.state === 'failed' && scan.error !== null && (
              <p className={css.error} data-disk-scan-error>{t('view.scan.failed', { message: scan.error.message })}</p>
            )}

            <section className={css.cards} data-disk-summary>
              <article className={css.card} data-disk-summary-total>
                <span className={css.cardLabel}>{t('view.summary.total.label')}</span>
                <strong className={css.cardValue}>{formatBytes(scan.bytes)}</strong>
                <span className={css.cardSub}>{t('view.summary.total.sub', { files: scan.files, dirs: scan.dirs })}</span>
              </article>
              <article className={css.card} data-disk-summary-largest>
                <span className={css.cardLabel}>{t('view.summary.largest.label')}</span>
                <strong className={css.cardValue}>{largest?.name ?? t('view.summary.none')}</strong>
                <span className={css.cardSub}>
                  {largest === undefined ? t('view.summary.none') : t('view.summary.largest.sub', { size: formatBytes(largest.size), percent: formatPercent(largest.size, scan.bytes) })}
                </span>
              </article>
              <article className={`${css.card} ${css.warn}`} data-disk-summary-duplicates>
                <span className={css.cardLabel}>{t('view.summary.duplicates.label')}</span>
                <strong className={css.cardValue}>{formatBytes(duplicateBytes)}</strong>
                <span className={css.cardSub}>{t('view.summary.duplicates.sub', { groups: duplicateGroups })}</span>
              </article>
              <article className={css.card} data-disk-summary-trash>
                <span className={css.cardLabel}>{t('view.summary.trash.label')}</span>
                <strong className={css.cardValue}>{formatBytes(totalTrashBytes)}</strong>
                <span className={css.cardSub}>{t('view.summary.trash.sub', { count: trash.length, size: formatBytes(totalTrashBytes) })}</span>
              </article>
            </section>

            <TabBar
              tabs={tabs}
              active={tab}
              onSelect={id => { setTab(id === 'duplicates' ? 'duplicates' : id === 'trash' ? 'trash' : 'browse') }}
              data-disk-tabs
            />

            {tab === 'browse' && (
              <div data-disk-tab-panel="browse">
                <section className={css.panel} data-disk-browse>
                  <div className={css.panelHead}>
                    <h2>{t('view.browse.treemap')}</h2>
                    <span className={css.meta} data-disk-root>{scan.root}</span>
                    {currentPath !== '' && (
                      <button type="button" className={css.link} onClick={() => { void openDirectory(scan, '') }} data-disk-breadcrumb>
                        {t('view.browse.root')}
                      </button>
                    )}
                  </div>
                  {blocks.length === 0
                    ? <p className={css.meta} data-disk-treemap-empty>{t('view.browse.empty')}</p>
                    : (
                      <div className={css.treemap} data-disk-treemap>
                        {blocks.map(block => (
                          <button
                            key={block.path}
                            type="button"
                            className={css.block}
                            style={{ flexGrow: Math.max(block.size, 1), flexBasis: formatPercent(block.size, browsedBytes) }}
                            disabled={block.kind !== 'dir'}
                            onClick={() => { if (block.kind === 'dir') void openDirectory(scan, block.path) }}
                            data-disk-block={block.path}
                            data-disk-block-kind={block.kind}
                          >
                            <span className={css.blockName}>{block.name}</span>
                            <span className={css.blockSize}>{formatBytes(block.size)}</span>
                            <span className={css.blockShare}>{formatPercent(block.size, browsedBytes)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  {blocks.length > 0 && entries.length > blocks.length ? <p className={css.meta} data-disk-treemap-more>{t('view.browse.moreBlocks', { shown: blocks.length, total: entries.length })}</p> : null}
                </section>

                <section className={css.panel} data-disk-largest-table>
                  <div className={css.panelHead}>
                    <h2>{t('view.browse.largest')}</h2>
                    <code className={css.meta}>{currentPath === '' ? scan.root : `${scan.root}/${currentPath}`}</code>
                  </div>
                  {dirs.length === 0
                    ? <p className={css.meta} data-disk-dirs-empty>{t('view.browse.noDirs')}</p>
                    : (
                      <table className={css.table}>
                        <thead>
                          <tr>
                            <th>{t('view.browse.directory')}</th>
                            <th className={css.num}>{t('view.browse.size')}</th>
                            <th className={css.num}>{t('view.browse.share')}</th>
                            <th>{t('view.browse.modified')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dirs.slice(0, 10).map(entry => (
                            <tr
                              key={entry.path}
                              tabIndex={0}
                              onClick={() => { void openDirectory(scan, entry.path) }}
                              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openDirectory(scan, entry.path) } }}
                              data-disk-row={entry.path}
                            >
                              <td><code>{entry.name}/</code></td>
                              <td className={css.num}>{formatBytes(entry.size)}</td>
                              <td className={css.num}>{formatPercent(entry.size, browsedBytes)}</td>
                              <td className={css.meta}>{formatTime(entry.mtime)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  {dirs.length > 10 ? <p className={css.meta} data-disk-dirs-more>{t('view.browse.moreDirs', { shown: 10, total: dirs.length })}</p> : null}
                </section>

                <section className={css.panel} data-disk-largest-files>
                  <div className={css.panelHead}><h2>{t('view.browse.largestFiles')}</h2></div>
                  {files.length === 0
                    ? <p className={css.meta} data-disk-files-empty>{t('view.browse.noFiles')}</p>
                    : (
                      <ul className={css.fileList}>
                        {files.map(file => (
                          <li key={file.path} data-disk-file-row={file.path}>
                            <code>{file.path}</code>
                            <span>{formatBytes(file.size)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  {files.length >= 8 ? <p className={css.meta} data-disk-files-more>{t('view.browse.moreFiles', { shown: files.length })}</p> : null}
                </section>
              </div>
            )}

            {tab === 'duplicates' && (
              <div data-disk-tab-panel="duplicates">
                <section className={css.panel} data-disk-duplicates>
                  <div className={css.panelHead}>
                    <h2>{t('view.tab.duplicates')}</h2>
                    <button
                      type="button"
                      className={css.button}
                      disabled={anyBusy || scan.state !== 'completed'}
                      onClick={() => { void startDuplicates(scan) }}
                      data-disk-analyze
                    >
                      {t('view.duplicates.start')}
                    </button>
                  </div>
                  {scan.duplicateState === 'running' || scan.duplicateState === 'cancelling' ? (
                    <div className={css.progress} data-disk-dup-running>
                      <span>{t('view.duplicates.running')}</span>
                      <button type="button" className={css.button} onClick={() => { void cancelCurrent(scan) }} data-disk-dup-cancel>
                        {t('view.duplicates.cancel')}
                      </button>
                    </div>
                  ) : null}
                  {scan.duplicateState === 'failed' && <p className={css.error} data-disk-dup-failed>{t('view.duplicates.state.failed')}</p>}
                  {scan.duplicateState === 'cancelled' && <p className={css.meta} data-disk-dup-cancelled>{t('view.duplicates.state.cancelled')}</p>}
                  <p className={css.dupSummary}>{t('view.duplicates.summary', { groups: duplicateGroups, size: formatBytes(duplicateBytes) })}</p>
                  {groups.length === 0
                    ? <p className={css.meta} data-disk-duplicates-empty>{t('view.duplicates.empty')}</p>
                    : (
                      <>
                        <p className={css.meta}>{t('view.duplicates.stageHint')}</p>
                        {groups.map(group => (
                          <div key={group.groupId} className={css.dupGroup} data-disk-dup-group={group.groupId}>
                            <input
                              type="checkbox"
                              checked={selected.includes(group.groupId)}
                              onChange={() => { toggleGroup(group.groupId) }}
                              aria-label={t('view.duplicates.select')}
                              data-disk-dup-checkbox={group.groupId}
                            />
                            <div className={css.dupMain}>
                              <strong>{t('view.duplicates.copies', { count: group.paths.length })}</strong>
                              <ul className={css.dupPaths}>
                                {group.paths.map(item => <li key={item} data-disk-dup-path={item}><code>{item}</code></li>)}
                              </ul>
                            </div>
                            <span>{formatBytes(group.size)}</span>
                            <span className={css.warnText}>{t('view.duplicates.wasted', { size: formatBytes(group.wastedBytes) })}</span>
                          </div>
                        ))}
                        <div className={css.actions}>
                          <button type="button" className={css.primary} disabled={anyBusy || selected.length === 0} onClick={() => { requestStage(scan) }} data-disk-stage>
                            {t('view.duplicates.stage')}
                          </button>
                        </div>
                      </>
                    )}
                </section>
              </div>
            )}

            {tab === 'trash' && (
              <div data-disk-tab-panel="trash">
                <section className={css.panel} data-disk-trash>
                  <div className={css.panelHead}>
                    <h2>{t('view.tab.trash')}</h2>
                    <span className={css.meta} data-disk-trash-summary>{t('view.trash.summary', { count: trash.length, size: formatBytes(totalTrashBytes) })}</span>
                  </div>
                  <p className={css.meta}>{t('view.trash.hint')}</p>
                  {trash.length === 0
                    ? <p className={css.empty} data-disk-trash-empty>{t('view.trash.empty')}</p>
                    : trash.map(item => (
                      <div key={item.id} className={css.trashRow} data-disk-trash-row={item.id}>
                        <div className={css.trashMain}>
                          <code data-disk-trash-path>{item.sourcePath}</code>
                          <span className={css.meta}>{formatTime(item.movedAt)}</span>
                        </div>
                        <span>{formatBytes(item.size)}</span>
                        <button type="button" className={css.button} onClick={() => { void restore(item.id) }} data-disk-restore={item.id}>
                          {t('view.trash.restore')}
                        </button>
                        <button type="button" className={css.danger} onClick={() => { requestPurge(item.id) }} data-disk-purge={item.id}>
                          {confirmPurge === item.id ? t('view.trash.confirm') : t('view.trash.purge')}
                        </button>
                      </div>
                    ))}
                </section>
              </div>
            )}
          </>
        )}
      <Modal
        open={stagePlan !== undefined}
        onClose={() => { if (busy === undefined) setStagePlan(undefined) }}
        title={t('view.duplicates.confirmTitle')}
        tone="warning"
        closeLabel={t('view.close')}
        footer={stagePlan === undefined ? undefined : (
          <>
            <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { setStagePlan(undefined) }}>{t('view.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={busy !== undefined} onClick={() => { if (stagePlan !== undefined) void stageSelected(stagePlan) }} data-disk-stage-confirm>
              {t('view.duplicates.confirmAction')}
            </Button>
          </>
        )}
      >
        {stagePlan === undefined ? null : (
          <div data-disk-stage-plan>
            <p>{t('view.duplicates.confirmBody', { groups: stagePlan.groups, files: stagePlan.paths.length, size: formatBytes(stagePlan.bytes) })}</p>
            <p className={css.meta}>{t('view.duplicates.keepHint')}</p>
            <ul className={css.dupPaths}>
              {stagePlan.keep.map(path => <li key={path}><code>{path}</code></li>)}
            </ul>
          </div>
        )}
      </Modal>
    </div>
  )
}
