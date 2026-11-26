/**
 * The application area's management page: a page one level above the
 * application page, with its own header, its own persistent application list
 * and the four areas the target design names (status, permissions, data and
 * settings). It is not a second application page: the application tabs, the
 * conversation pane and the application's own menu belong to the app level,
 * and the page has its own navigation instead. The application frame stays
 * mounted underneath (hidden by the area), so drafts, selections and scroll
 * positions survive; selecting an application here only changes the subject of
 * the detail, never the application the area will return to.
 *
 * The page's list is the navigation: search, sort, the current application's
 * "in use" marker, and the cross-application queues for confirmations and
 * running work. The detail shows one application and its four areas. Nothing
 * here approves anything by itself: grants, revocations and confirmation
 * answers are the shell's commands, whose real results the page re-reads.
 * @module @matrix1001/dsh-application-harness-client-applications/client/ManagementPage
 */
import { createElement, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconGlobeOutlineRegular, Modal, Tooltip,
} from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AppDataBackup, AppDataExport, AppDataImportPreview, AppDataImportResult, AppDataInfo, AppDataPruneResult, AppDataRestorePreview, AppDataRestoreResult, AppInfo, Caller, ConfirmationDecision, DelegationInfo, OperationPolicy, TaskState } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type {
  ApplicationSettingsProps, ApplicationView, ApplicationViewProps, ManageRequest, ManageTab,
} from './contract.ts'
import type { AreaNotice } from './notices.ts'
import type { ApplicationsState } from './shell.ts'
import { StatusControl } from './StatusControl.tsx'
import { AppIcon } from './AppIcon.tsx'
import { StatusBadge } from './StatusBadge.tsx'
import { reasonLabel } from './reason.ts'
import { formatBytes } from './format.ts'
import { RUNTIME_KEYS, confirmationSentence, describeNeed, displayDescription, displayName,
  hasPage, hasSettings, historyInto, statusOf, statusView, type NeedDescription } from './model.ts'
import { ConfirmationsList, HistoryList, NeedsList, PoliciesList, ProcessList } from './Lists.tsx'
import { GenericCallForm } from './GenericCallForm.tsx'
import { NETWORK_SETTING_SCROLL_KEY, manageScrollKey, type ManageScrollMemory } from './manage.ts'
import { NETWORK_PROXY_INPUT_ID, NetworkSettings, type NetworkProxySection } from './NetworkSettings.tsx'
import { useSurfaceScroll } from './surface-scroll.ts'
import type { ApplicationsKey } from './locales.ts'
import css from './ApplicationsArea.module.css'
import listCss from './ApplicationsLists.module.css'

/** The four management areas, in render order (settings is dropped when the application has none). */
export const MANAGE_AREAS: readonly { readonly key: ManageTab; readonly label: ApplicationsKey }[] = [
  { key: 'status', label: 'area.status' },
  { key: 'permissions', label: 'area.permissions' },
  { key: 'data', label: 'area.data' },
  { key: 'settings', label: 'area.settings' },
]

/** The areas one application actually has (settings only when it registers any). */
export function areasOf(view: ApplicationView | undefined): readonly ManageTab[] {
  return MANAGE_AREAS.filter(area => area.key !== 'settings' || hasSettings(view)).map(area => area.key)
}

/** The area a detail opens at when the caller names none that exists. */
export function defaultTab(): ManageTab {
  return 'status'
}

/** The id the detail's area panel carries, and the tabs point at. */
const PANEL_ID = 'applications-manage-panel'

/** One area tab's element id (the tab/panel pair a screen reader reads together). */
function areaTabId(appId: string, area: ManageTab): string {
  return `applications-manage-${appId}-${area}`
}

/** One idempotency key per committed import/restore. */
function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** The order one attention-needing application sorts at (lower first). */
function attentionRank(app: AppInfo, t: TranslateNS<'applications'>): number {
  switch (statusView(app, t).tone) {
    case 'error': return 0
    case 'warn': return 1
    case 'idle': return 2
    default: return 3
  }
}

/** What the page renders from and every command it can run. */
export interface ManagementPageProps {
  readonly state: ApplicationsState
  readonly views: ReadonlyMap<string, ApplicationView>
  readonly request: ManageRequest
  /** Whether the area content width is narrow enough for list/detail pages (below WIDE). */
  readonly narrow: boolean
  /** The application the area would show after leaving this page. */
  readonly currentApp: AppInfo | undefined
  /** Its registration, for the current application's display name. */
  readonly currentView: ApplicationView | undefined
  /** The user's saved tab order, the default order of the list. */
  /** Move between the list and one application's detail, and between areas. */
  readonly onNavigate: (request: ManageRequest) => void
  /** Return to the current application page. */
  readonly onReturn: () => void
  /** The shell-level notices shown by the management header's status control. */
  readonly notices: readonly AreaNotice[]
  /** Open one application's page (a real application switch). */
  readonly onOpenApp: (appId: string) => void
  /** The application network proxy form; undefined when the platform settings client is not mounted. */
  readonly networkProxy: () => ConfigForm<NetworkProxySection> | undefined
  /** The props one application's settings page is rendered with. */
  readonly settingsProps: (appId: string) => ApplicationSettingsProps
  /** The props one application's page is rendered with (the debug form uses its call pair). */
  readonly viewProps: (appId: string) => ApplicationViewProps
  /** Where the page remembers its scroll positions (the framework instance owns it). */
  readonly scroll: ManageScrollMemory
  readonly loadHistory: (appId?: string) => void
  /** Read the host's background-task projections. */
  readonly loadTasks: () => void
  /** Read one application's unified-store data facts. */
  readonly loadDataInfo: (appId: string) => Promise<AppDataInfo>
  /** Preview restoring one application from a whole-database backup. */
  readonly restorePreview: (appId: string, backupPath: string) => Promise<AppDataRestorePreview>
  /** Restore one application from a backup. */
  readonly restoreData: (appId: string, planId: string, requestId: string) => Promise<AppDataRestoreResult>
  /** Export one application's unified-store namespace (JSON download). */
  readonly exportData: (appId: string) => Promise<AppDataExport>
  /** Validate one application JSON import before any write. */
  readonly previewDataImport: (appId: string, json: string) => Promise<AppDataImportPreview>
  /** Import one application JSON after a pre-import backup. */
  readonly importData: (appId: string, planId: string, requestId: string) => Promise<AppDataImportResult>
  /** Retry the reload an import could not complete (the app stays held). */
  readonly reloadImportedData?: (appId: string) => Promise<void>
  /** Delete old pre-import snapshots beyond the newest keep (explicit action). */
  readonly pruneBackups?: (keep: number) => Promise<AppDataPruneResult>
  readonly loadGrants: () => void
  readonly loadPolicies: () => void
  readonly loadConfirmations: () => void
  readonly setPolicy: (appId: string, op: string, policy: OperationPolicy) => Promise<boolean>
  readonly setActivation: (appId: string, activation: 'enabled' | 'disabled') => Promise<boolean>
  /** Run one application's declared health check now (the status area's check action). */
  readonly checkHealth: (appId: string) => Promise<boolean>
  readonly setAppModel: (appId: string, selection: { provider: string; model: string } | null) => Promise<boolean>
  readonly loadModelCatalog: () => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelCatalog>
  readonly loadModelUsage: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelUsageSummary>
  readonly loadModelLimits: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelLimits>
  readonly setModelLimits: (appId: string, limits: import('@matrix1001/dsh-application-harness-host-bridge/client').ModelLimits) => Promise<boolean>
  readonly grant: (caller: Caller, capabilities: readonly string[]) => Promise<boolean>
  readonly revoke: (caller: Caller, selector?: string) => Promise<boolean>
  readonly answer: (id: string, decision: ConfirmationDecision) => Promise<boolean>
  /** Withdraw a pending confirmation. */
  readonly cancelConfirmation: (id: string) => Promise<boolean>
  /** Subscribe to one application's change notices (a delegation state change re-reads its list). */
  readonly subscribeChanges?: (appId: string, listener: () => void) => () => void
  /** Read the host's delegation records (the permissions area). */
  readonly delegations: (appId?: string) => Promise<readonly DelegationInfo[]>
  /** End one delegation on the human's request. */
  readonly cancelDelegation: (id: string, appId?: string) => Promise<DelegationInfo>
  /** Show the Session that executes one delegation. */
  readonly openDelegation: (id: string, appId?: string) => Promise<boolean>
  readonly t: TranslateNS<'applications'>
}

/** What the page shows when a row is selected from the list. */
type QueueKind = 'confirmations' | 'running'

/**
 * Render the management page.
 * @param props - the state, the request, the application underneath and the commands.
 * @returns the page element.
 */
export function ManagementPage(props: ManagementPageProps): ReactNode {
  const { state, views, request, narrow, currentApp, currentView, t } = props
  const apps = state.apps
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'order' | 'name' | 'status'>('order')
  const [queue, setQueue] = useState<QueueKind>()
  const [developerOpen, setDeveloperOpen] = useState(request.focus === 'debug')
  const [healthRun, setHealthRun] = useState<{ readonly appId: string; readonly failed: boolean }>()
  const searchRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const previousApp = useRef<string | undefined>(request.appId)
  const opened = useRef(false)

  const runningTasks = state.tasks.filter(task => task.state === 'running' || task.state === 'cancelling')
  const counts = {
    confirmations: state.confirmations.length,
    running: state.runningCalls.length + runningTasks.length,
  }
  // A failed queue read is itself a reason to open the queue: its retry lives there.
  const attention = {
    confirmations: state.confirmationsFailed,
    running: state.tasksFailed,
  }

  // A queue that empties while it is open must not keep an empty page.
  useEffect(() => {
    if (queue === 'confirmations' && counts.confirmations === 0 && !attention.confirmations) setQueue(undefined)
    if (queue === 'running' && counts.running === 0 && !attention.running) setQueue(undefined)
  }, [queue, counts.confirmations, counts.running, attention.confirmations, attention.running])

  // The page reads the cross-application queues and the chosen application's
  // detail facts; every read is the shell's own command.
  useEffect(() => { props.loadConfirmations() }, [props.loadConfirmations])
  useEffect(() => { props.loadTasks() }, [props.loadTasks])

  const networkForm = props.networkProxy()
  const setting = request.setting
  const explicit = request.appId === undefined ? undefined : apps?.find(app => app.id === request.appId)
  const selected = setting !== undefined ? undefined : explicit ?? (request.appId === undefined && !narrow ? currentApp : undefined)
  const selectedView = selected === undefined ? undefined : views.get(selected.id)
  const areas = areasOf(selectedView)
  const area = request.tab !== undefined && areas.includes(request.tab) ? request.tab : defaultTab()
  const view: 'list' | 'detail' | 'split' = narrow
    ? (queue !== undefined || setting !== undefined || explicit !== undefined ? 'detail' : 'list')
    : 'split'

  // The requested sub-section (the header's history/debug shortcuts) is a
  // property of the entry, not of the area selection; opening another app
  // resets the developer fold.
  useEffect(() => { setDeveloperOpen(request.focus === 'debug') }, [request.appId, request.focus])

  // Each area reads what it shows when it opens.
  useEffect(() => {
    if (selected === undefined) return
    if (area === 'permissions') props.loadGrants()
    if (area === 'data') props.loadHistory(selected.id)
  }, [selected?.id, area, props.loadGrants, props.loadHistory])

  // A new page (or a new application) moves focus into the page; a later area
  // click keeps focus on the tab the human used. The application frame is
  // hidden underneath, so the element that opened the page is not a stable
  // focus target: the page's own search, back action or area tab is.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (setting !== undefined) {
        // The area-level settings page is the one detail with a text control of
        // its own: focus the proxy field (or the back action when it is not
        // rendered) instead of the application search.
        const control = document.getElementById(NETWORK_PROXY_INPUT_ID)
        if (control !== null) control.focus()
        else backRef.current?.focus()
        opened.current = true
      } else if (!opened.current) {
        opened.current = true
        if (narrow && request.appId !== undefined) backRef.current?.focus()
        else if (!narrow && request.appId !== undefined) {
          const tab = document.getElementById(areaTabId(request.appId, area))
          ;(tab ?? searchRef.current)?.focus()
        } else searchRef.current?.focus()
      } else if (narrow && view === 'detail' && request.appId !== previousApp.current) {
        backRef.current?.focus()
      }
      previousApp.current = request.appId
    }, 0)
    return () => { clearTimeout(timer) }
  }, [view, narrow, queue, request.appId, setting, area])

  // The page is not a modal: Escape is its own "back one level" action.
  // Menus, open nested dialogs and text fields keep the key they already own.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const element = event.target instanceof Element ? event.target : undefined
      if (element !== undefined
        && element.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]') !== null) return
      event.preventDefault()
      if (narrow && view === 'detail') {
        setQueue(undefined)
        props.onNavigate({ tab: defaultTab() })
      } else {
        props.onReturn()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [narrow, view, props])

  const rows = useMemo(() => {
    const ordered = apps ?? []
    const needle = query.trim().toLocaleLowerCase()
    const matched = needle === ''
      ? ordered
      : ordered.filter((app) => {
        const name = displayName(app, views.get(app.id))
        const description = displayDescription(app, views.get(app.id))
        return `${name}\n${description}\n${app.id}`.toLocaleLowerCase().includes(needle)
      })
    if (sort === 'order') return matched
    const sorted = [...matched]
    if (sort === 'name') {
      sorted.sort((left, right) => displayName(left, views.get(left.id)).localeCompare(displayName(right, views.get(right.id)), undefined, { sensitivity: 'base' }))
    } else {
      sorted.sort((left, right) => attentionRank(left, t) - attentionRank(right, t)
        || displayName(left, views.get(left.id)).localeCompare(displayName(right, views.get(right.id)), undefined, { sensitivity: 'base' }))
    }
    return sorted
  }, [apps, query, sort, views, t])

  const selectedId = explicit?.id ?? (queue === undefined && setting === undefined && !narrow ? currentApp?.id : undefined)

  const selectApp = (appId: string): void => {
    setQueue(undefined)
    props.onNavigate({ appId, tab: defaultTab() })
  }
  const selectQueue = (kind: QueueKind): void => {
    setQueue(kind)
  }
  const backToList = (): void => {
    setQueue(undefined)
    props.onNavigate({ tab: defaultTab() })
  }
  const selectArea = (next: ManageTab): void => {
    if (selected === undefined) return
    props.onNavigate({ appId: selected.id, tab: next })
  }
  const runHealthCheck = (appId: string): void => {
    setHealthRun({ appId, failed: false })
    void props.checkHealth(appId).then((ok) => {
      setHealthRun(ok ? undefined : { appId, failed: true })
    }).catch(() => { setHealthRun({ appId, failed: true }) })
  }
  const currentName = currentApp === undefined ? undefined : displayName(currentApp, currentView)
  const headerSubject = setting === 'network' ? t('manage.network') : currentName

  return (
    <section
      className={css.managePage}
      data-manage-page
      data-narrow={narrow ? 'true' : undefined}
      data-view={view}
      aria-label={t('manage.title')}
    >
      <header className={css.manageHeader} data-manage-header>
        <Tooltip label={t('manage.returnApp', { name: currentName ?? currentApp?.id ?? '' })} delayMs={500}>
          <button
            type="button"
            className={css.manageHeaderIcon}
            data-manage-return
            aria-label={t('manage.returnApp', { name: currentName ?? currentApp?.id ?? '' })}
            onClick={props.onReturn}
          >
            <IconChevronLeftOutlineRegular size={16} />
          </button>
        </Tooltip>
        <h1 className={css.manageHeaderTitle} data-manage-page-title>
          {t('manage.title')}
          {headerSubject !== undefined && <span className={css.manageHeaderCurrent} data-manage-current-name>{` / ${headerSubject}`}</span>}
        </h1>
        <span className={css.manageHeaderSpacer} />
        <StatusControl notices={props.notices} panelId="app-status-panel-manage" t={t} />
      </header>

      {state.error !== undefined && (
        <FailureNote title={t('manage.errorTitle')} detail={state.error} detailLabel={t('manage.diagnostic')} data-manage-error />
      )}

      <div className={css.manageMain}>
        <ManageAppList
          loading={apps === undefined}
          rows={rows}
          total={apps?.length ?? 0}
          views={views}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          selectedId={selectedId}
          currentId={currentApp?.id}
          queue={queue}
          counts={counts}
          attention={attention}
          onSelect={selectApp}
          onQueue={selectQueue}
          setting={setting}
          onSetting={() => { setQueue(undefined); props.onNavigate({ setting: 'network' }) }}
          searchRef={searchRef}
          scroll={props.scroll}
          t={t}
        />
        {view !== 'list' && (
          <div className={css.manageDetailPane} data-manage-detail-pane>
            {setting !== undefined ? (
              <ManageNetworkSetting
                form={networkForm}
                narrow={narrow}
                onBackToList={backToList}
                backRef={backRef}
                scroll={props.scroll}
                t={t}
              />
            ) : queue !== undefined ? (
              <ManageQueue
                {...props}
                kind={queue}
                narrow={narrow}
                onBackToList={backToList}
                backRef={backRef}
              />
            ) : selected !== undefined ? (
              <ManageDetail
                {...props}
                app={selected}
                view={selectedView}
                area={area}
                areas={areas}
                current={selected.id === currentApp?.id}
                focus={request.focus}
                developerOpen={developerOpen}
                onDeveloperToggle={setDeveloperOpen}
                narrow={narrow}
                onBackToList={backToList}
                onArea={selectArea}
                onOpenApp={props.onOpenApp}
                healthRun={healthRun}
                runHealthCheck={runHealthCheck}
                backRef={backRef}
                t={t}
              />
            ) : (
              <p className={css.manageEmpty} data-manage-empty>{t('manage.noSelection')}</p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** The persistent application list: the page's own navigation. */
function ManageAppList({
  loading, rows, total, views, query, onQuery, sort, onSort, selectedId, currentId, queue, counts,
  setting, onSetting, onSelect, onQueue, searchRef, scroll, t, attention,
}: {
  readonly loading: boolean
  readonly rows: readonly AppInfo[]
  readonly total: number
  readonly views: ReadonlyMap<string, ApplicationView>
  readonly query: string
  readonly onQuery: (value: string) => void
  readonly sort: 'order' | 'name' | 'status'
  readonly onSort: (value: 'order' | 'name' | 'status') => void
  readonly selectedId: string | undefined
  readonly currentId: string | undefined
  readonly queue: QueueKind | undefined
  readonly counts: { readonly confirmations: number; readonly running: number }
  readonly attention: { readonly confirmations: boolean; readonly running: boolean }
  /** Which area-level settings page the list's fixed entry currently shows. */
  readonly setting: 'network' | undefined
  /** Open the area-level settings page. */
  readonly onSetting: () => void
  readonly onSelect: (appId: string) => void
  readonly onQueue: (kind: QueueKind) => void
  readonly searchRef: RefObject<HTMLInputElement>
  readonly scroll: ManageScrollMemory
  readonly t: TranslateNS<'applications'>
}): ReactNode {
  const list = useRef<HTMLDivElement>(null)
  useSurfaceScroll(list, { key: 'list', ready: true, memory: scroll })
  return (
    <aside className={css.manageListPane} data-manage-list-pane aria-label={t('area.list')}>
      <div className={css.manageListTools}>
        <div className={css.manageSearchRow}>
          <input
            ref={searchRef}
            className={css.manageSearch}
            data-manage-search
            type="search"
            value={query}
            placeholder={t('manage.search')}
            aria-label={t('manage.search')}
            onChange={(event) => { onQuery(event.target.value) }}
          />
          {query !== '' && (
            <button type="button" className={css.manageSearchClear} data-manage-search-clear aria-label={t('manage.clear')} onClick={() => { onQuery('') }}>×</button>
          )}
        </div>
        <label className={css.manageSortRow}>
          <span>{t('manage.sort')}</span>
          <select data-manage-sort aria-label={t('manage.sort')} value={sort} onChange={(event) => { onSort(event.target.value as 'order' | 'name' | 'status') }}>
            <option value="order">{t('manage.sortOrder')}</option>
            <option value="name">{t('manage.sortName')}</option>
            <option value="status">{t('manage.sortStatus')}</option>
          </select>
        </label>
      </div>
      <div className={css.manageListScroll} ref={list} data-manage-list-scroll>
        {(counts.confirmations > 0 || attention.confirmations) && (
          <button
            type="button"
            className={css.manageQueueEntry}
            data-manage-queue="confirmations"
            aria-pressed={queue === 'confirmations'}
            onClick={() => { onQueue('confirmations') }}
          >
            <span>{t('manage.pending')}</span>
            <span className={css.manageQueueCount}>{counts.confirmations}</span>
          </button>
        )}
        {(counts.running > 0 || attention.running) && (
          <button
            type="button"
            className={css.manageQueueEntry}
            data-manage-queue="running"
            aria-pressed={queue === 'running'}
            onClick={() => { onQueue('running') }}
          >
            <span>{t('manage.running')}</span>
            <span className={css.manageQueueCount}>{counts.running}</span>
          </button>
        )}
        <p className={listCss.sectionTitle} data-manage-list-title>{t('manage.apps', { count: String(total) })}</p>
        {loading
          ? <p className={listCss.hint} data-manage-loading>{t('loading')}</p>
          : rows.length === 0
            ? <p className={listCss.hint} data-manage-search-empty>{query === '' ? t('state.empty') : t('manage.searchEmpty')}</p>
            : (
              <ul className={css.manageRows} data-manage-list>
                {rows.map((app) => {
                  const view = views.get(app.id)
                  const name = displayName(app, view)
                  const current = app.id === currentId
                  return (
                    <li key={app.id}>
                      <button
                        type="button"
                        className={css.manageRow}
                        data-manage-row={app.id}
                        data-status={statusOf(app)}
                        data-selected={selectedId === app.id ? 'true' : undefined}
                        aria-current={selectedId === app.id ? 'true' : undefined}
                        onClick={() => { onSelect(app.id) }}
                      >
                        <AppIcon view={view} size={20} />
                        <span className={css.manageRowMain}>
                          <span className={css.manageRowName}>{name}</span>
                          <span className={css.manageRowDesc}>{displayDescription(app, view)}</span>
                        </span>
                        {current && <span className={css.manageCurrent}>{t('manage.current')}</span>}
                        {!hasPage(view) && <span className={css.manageRowHint}>{t('manage.noPage')}</span>}
                        <StatusBadge compact runtime={app.runtime} status={statusOf(app)} {...(app.health === undefined ? {} : { health: app.health })} activation={app.activation} {...(app.reason === undefined ? {} : { reason: app.reason })} t={t} />
                        <IconChevronRightOutlineRegular size={16} className={css.manageRowChevron} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
      </div>
      <div className={css.manageListFoot} data-manage-list-foot>
        <button
          type="button"
          className={css.manageListSetting}
          data-manage-setting="network"
          aria-current={setting === 'network' ? 'true' : undefined}
          onClick={onSetting}
        >
          <IconGlobeOutlineRegular size={16} />
          <span>{t('manage.network')}</span>
        </button>
      </div>
    </aside>
  )
}

/** The cross-application queue the fixed list entries open. */
function ManageQueue(props: ManagementPageProps & {
  readonly kind: QueueKind
  readonly narrow: boolean
  readonly onBackToList: () => void
  readonly backRef: RefObject<HTMLButtonElement>
}): ReactNode {
  const { kind, state, views, answer, cancelConfirmation, viewProps, loadTasks, loadConfirmations, scroll, narrow, onBackToList, backRef, t } = props
  const body = useRef<HTMLDivElement>(null)
  useSurfaceScroll(body, { key: `queue:${kind}`, ready: true, memory: scroll })
  const runningTasks = state.tasks.filter(task => task.state === 'running' || task.state === 'cancelling')
  return (
    <section className={css.manageQueue} data-manage-queue-view={kind}>
      <header className={css.manageQueueHead}>
        {narrow && (
          <button type="button" className={css.manageBack} data-manage-back ref={backRef} onClick={onBackToList}>
            <IconChevronLeftOutlineRegular size={14} /> {t('manage.backToList')}
          </button>
        )}
        <h2 className={css.manageQueueTitle}>{kind === 'confirmations' ? t('manage.queue.confirmations') : t('manage.queue.running')}</h2>
      </header>
      <div className={css.manageQueueBody} ref={body} data-manage-queue-body>
        {kind === 'confirmations' && (
          <section data-manage-confirmations>
          <ConfirmationsList
            confirmations={state.confirmations}
            answer={answer}
            cancelConfirmation={cancelConfirmation}
            sentence={request => confirmationSentence(request, state.apps ?? [], views, t)}
            loaded={state.confirmationsLoaded}
            reading={state.confirmationsReading}
            failed={state.confirmationsFailed}
            onRetry={loadConfirmations}
            t={t}
          />
          </section>
        )}
        {kind === 'running' && (
          <>
            <section className={css.manageSection} data-manage-active-tasks>
              <p className={listCss.sectionTitle}>{t('tasks.all')}</p>
              <ul className={listCss.records}>
                {state.runningCalls.map(call => {
                  const app = state.apps?.find(candidate => candidate.id === call.appId)
                  const name = app === undefined ? call.appId : displayName(app, views.get(app.id))
                  return (
                    <li key={call.requestId} className={listCss.record} data-manage-active-task={call.requestId}>
                      <p className={listCss.recordMessage}><code>{call.op}</code> · {name}</p>
                      <p className={css.caption}>{t('tasks.started', { time: new Date(call.startedAt).toLocaleTimeString() })}</p>
                      <button type="button" className={css.debugToggle} data-manage-active-task-cancel onClick={() => { viewProps(call.appId).cancel(call.requestId) }}>{t('tasks.cancel')}</button>
                    </li>
                  )
                })}
              </ul>
              {state.runningCalls.length === 0 && <p className={listCss.hint}>{t('tasks.empty')}</p>}
            </section>
            <section className={css.manageSection} data-manage-background-tasks>
              <p className={listCss.sectionTitle}>{t('tasks.background')}</p>
              {state.tasksFailed && (
                <button type="button" className={css.debugToggle} data-manage-tasks-retry onClick={loadTasks}>{t('tasks.retry')}</button>
              )}
              {state.tasksReading && <p className={css.caption} data-manage-tasks-reading>{t('tasks.loading')}</p>}
              <ul className={listCss.records}>
                {runningTasks.map(task => {
                  const app = state.apps?.find(candidate => candidate.id === task.appId)
                  const name = app === undefined ? task.appId : displayName(app, views.get(app.id))
                  return (
                    <li key={task.taskId} className={listCss.record} data-manage-background-task={task.taskId}>
                      <p className={listCss.recordMessage}>{task.title} · {name}</p>
                      <p className={css.caption}>{taskStateLabel(t, task.state)}{task.progress === undefined ? '' : ` · ${task.progress.message}`}</p>
                      <button type="button" className={css.debugToggle} data-manage-background-task-cancel onClick={() => { viewProps(task.appId).cancelTask?.(task.taskId) }}>{t('tasks.cancel')}</button>
                    </li>
                  )
                })}
              </ul>
              {runningTasks.length === 0 && <p className={listCss.hint}>{t('tasks.none')}</p>}
            </section>
          </>
        )}
      </div>
    </section>
  )
}

/** The area-level settings page: the application network proxy. */
function ManageNetworkSetting(props: {
  readonly form: ConfigForm<NetworkProxySection> | undefined
  readonly narrow: boolean
  readonly onBackToList: () => void
  readonly backRef: RefObject<HTMLButtonElement>
  readonly scroll: ManageScrollMemory
  readonly t: TranslateNS<'applications'>
}): ReactNode {
  const body = useRef<HTMLDivElement>(null)
  useSurfaceScroll(body, { key: NETWORK_SETTING_SCROLL_KEY, ready: true, memory: props.scroll })
  return (
    <section className={css.manageDetail} data-manage-setting-detail="network">
      {props.narrow && (
        <div className={css.manageBackRow}>
          <button type="button" className={css.manageBack} data-manage-back ref={props.backRef} onClick={props.onBackToList}>
            <IconChevronLeftOutlineRegular size={14} /> {props.t('manage.backToList')}
          </button>
        </div>
      )}
      <div className={css.manageDetailHead}>
        <span className={css.manageSettingIcon} aria-hidden="true"><IconGlobeOutlineRegular size={24} /></span>
        <div className={css.manageDetailMain}>
          <h2 className={css.manageDetailTitle} data-manage-setting-title>{props.t('manage.network')}</h2>
          <p className={css.manageDetailDesc}>{props.t('manage.networkDesc')}</p>
        </div>
      </div>
      <div className={css.manageSettingBody} ref={body} data-manage-setting-body>
        <NetworkSettings form={props.form} t={props.t} />
      </div>
    </section>
  )
}

/** One application's detail: identity, status facts, the four areas and the settings host. */
function ManageDetail(props: ManagementPageProps & {
  readonly app: AppInfo
  readonly view: ApplicationView | undefined
  readonly area: ManageTab
  readonly areas: readonly ManageTab[]
  readonly current: boolean
  readonly focus: ManageRequest['focus']
  readonly developerOpen: boolean
  readonly onDeveloperToggle: (open: boolean) => void
  readonly narrow: boolean
  readonly onBackToList: () => void
  readonly onArea: (area: ManageTab) => void
  readonly onOpenApp: (appId: string) => void
  readonly healthRun: { readonly appId: string; readonly failed: boolean } | undefined
  readonly runHealthCheck: (appId: string) => void
  readonly backRef: RefObject<HTMLButtonElement>
}): ReactNode {
  const {
    app, view, area, areas, current, focus, developerOpen, onDeveloperToggle, narrow, onBackToList,
    onArea, onOpenApp, healthRun, runHealthCheck, backRef, settingsProps, t,
  } = props
  const body = useRef<HTMLDivElement>(null)
  useSurfaceScroll(body, {
    key: area === 'settings' ? undefined : manageScrollKey(app.id, area),
    ready: true,
    memory: props.scroll,
  })
  // The header's "Call history" shortcut lands on the data area's history
  // section; the read may still be in flight, so the section exists (loading)
  // and is scrolled into view after this area paints.
  useEffect(() => {
    if (area !== 'data' || focus !== 'history') return undefined
    const timer = setTimeout(() => {
      body.current?.querySelector<HTMLElement>('[data-manage-history]')?.scrollIntoView?.({ block: 'start' })
    }, 0)
    return () => { clearTimeout(timer) }
  }, [area, focus, app.id])
  return (
    <section className={css.manageDetail} data-manage-detail data-app-id={app.id}>
      {narrow && (
        <div className={css.manageBackRow}>
          <button type="button" className={css.manageBack} data-manage-back ref={backRef} onClick={onBackToList}>
            <IconChevronLeftOutlineRegular size={14} /> {t('manage.backToList')}
          </button>
        </div>
      )}
      <div className={css.manageDetailHead}>
        <AppIcon view={view} size={24} />
        <div className={css.manageDetailMain}>
          <h2 className={css.manageDetailTitle} data-manage-detail-name>{displayName(app, view)}</h2>
          <p className={css.manageDetailDesc}>{displayDescription(app, view)}</p>
        </div>
        {current && <span className={css.manageCurrent}>{t('manage.current')}</span>}
        <StatusBadge runtime={app.runtime} status={statusOf(app)} {...(app.health === undefined ? {} : { health: app.health })} activation={app.activation} {...(app.reason === undefined ? {} : { reason: app.reason })} t={t} />
        {!current && hasPage(view) && (
          <Button size="sm" variant="outline" data-manage-open-app onClick={() => { onOpenApp(app.id) }}>
            {t('manage.openApp')}
          </Button>
        )}
        {!hasPage(view) && <span className={css.manageRowHint}>{t('manage.noPage')}</span>}
      </div>

      <div
        className={css.manageHealth}
        data-manage-health
        data-runtime={app.runtime}
        data-health={app.health}
        data-activation={app.activation}
        {...(app.reason === undefined ? {} : { 'data-reason': app.reason })}
      >
        {app.reason !== undefined && <span className={css.manageHealthReason} data-health-reason>{reasonLabel(app.reason, t)}</span>}
        {(app.reason !== undefined || app.detail !== undefined) && (
          <details className={css.manageDiagnostic} data-manage-diagnostic>
            <summary>{t('manage.diagnostic')}</summary>
            {app.reason !== undefined && <code data-health-reason-code>{app.reason}</code>}
            {app.detail !== undefined && <span data-health-detail>{app.detail}</span>}
          </details>
        )}
        <span className={css.manageHealthActions}>
          <Button
            size="sm"
            variant="outline"
            data-health-check
            disabled={healthRun?.appId === app.id && !healthRun.failed}
            onClick={() => { runHealthCheck(app.id) }}
          >
            {healthRun?.appId === app.id && !healthRun.failed ? t('health.checking') : t('health.check')}
          </Button>
        </span>
        {healthRun?.appId === app.id && healthRun.failed && (
          <span className={css.manageHealthError} role="alert" data-health-error>{t('health.checkFailed')}</span>
        )}
      </div>

      <nav className={css.manageTabs} role="tablist" aria-label={t('area.list')}>
        {MANAGE_AREAS.filter(entry => areas.includes(entry.key)).map(entry => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={areaTabId(app.id, entry.key)}
            data-manage-tab={entry.key}
            tabIndex={entry.key === area ? 0 : -1}
            aria-selected={entry.key === area}
            aria-controls={PANEL_ID}
            onClick={() => { onArea(entry.key) }}
            onKeyDown={(event) => { onAreaKey(event, areas, area, app.id, onArea) }}
          >
            {t(entry.label)}
          </button>
        ))}
      </nav>

      <div
        className={css.manageBody}
        ref={body}
        data-manage-body
        data-manage-tab={area}
        role="tabpanel"
        id={PANEL_ID}
        aria-labelledby={areaTabId(app.id, area)}
      >
        {area === 'status' && (
          <StatusArea
            {...props}
            app={app}
            view={view}
            developerOpen={developerOpen}
            onDeveloperToggle={onDeveloperToggle}
            t={t}
          />
        )}
        {area === 'permissions' && <PermissionsArea {...props} app={app} view={view} t={t} />}
        {area === 'data' && <DataArea {...props} app={app} view={view} focus={focus} t={t} />}
        {view?.Settings !== undefined && (
          <div className={css.settingsHost} data-manage-settings style={{ display: area === 'settings' ? 'flex' : 'none' }}>
            {createElement(view.Settings, { ...settingsProps(app.id), key: app.id })}
          </div>
        )}
      </div>
    </section>
  )
}

/** Status and version: facts, activation and the developer's folded declarations. */
/** One local action failure: localized headline, raw wire detail behind a disclosure. */
function FailureNote({ title, detail, detailLabel, action, ...rest }: {
  readonly title: string
  readonly detail: string
  readonly detailLabel: string
  readonly action?: ReactNode
  readonly [dataAttr: `data-${string}`]: unknown
}): ReactNode {
  return (
    <div className={css.failureNote} role="alert" {...rest}>
      <span className={css.failureNoteTitle}>{title}</span>
      {action}
      {detail !== title && <details className={css.failureNoteDetail}>
        <summary>{detailLabel}</summary>
        <span>{detail}</span>
      </details>}
    </div>
  )
}

function StatusArea(props: ManagementPageProps & {
  readonly app: AppInfo
  readonly view: ApplicationView | undefined
  readonly developerOpen: boolean
  readonly onDeveloperToggle: (open: boolean) => void
}): ReactNode {
  return (
    <>
      <InfoTab {...props} section="status" />
      <details
        className={css.manageDeveloper}
        data-manage-developer
        open={props.developerOpen}
        onToggle={(event) => { props.onDeveloperToggle(event.currentTarget.open) }}
      >
        <summary>{props.t('manage.developer')}</summary>
        <InfoTab {...props} section="developer" />
      </details>
    </>
  )
}

/** Permissions and connections: needs, policies, model and delegations. */
function PermissionsArea(props: ManagementPageProps & { readonly app: AppInfo; readonly view: ApplicationView | undefined }): ReactNode {
  const { app, view } = props
  return (
    <>
      <PermissionsTab {...props} app={app} />
      <InfoTab {...props} app={app} view={view} section="model" />
      <DelegationsTab {...props} app={app} />
    </>
  )
}

/** Data and records: the store facts, exports, background tasks and call history. */
function DataArea(props: ManagementPageProps & {
  readonly app: AppInfo
  readonly view: ApplicationView | undefined
  readonly focus: ManageRequest['focus']
}): ReactNode {
  return (
    <>
      <InfoTab {...props} section="data" />
      <TasksTab state={props.state} app={props.app} viewProps={props.viewProps} loadTasks={props.loadTasks} t={props.t} />
      <HistoryTab {...props} app={props.app} />
    </>
  )
}

/** Area keyboard navigation (the WAI-ARIA tablist model), with the DOM focus following the selection. */
function onAreaKey(
  event: KeyboardEvent<HTMLButtonElement>,
  areas: readonly ManageTab[],
  current: ManageTab,
  appId: string,
  onArea: (area: ManageTab) => void,
): void {
  const index = areas.indexOf(current)
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  const next = step !== 0
    ? areas[(index + step + areas.length) % areas.length]
    : event.key === 'Home' ? areas[0]
      : event.key === 'End' ? areas[areas.length - 1]
        : undefined
  if (next === undefined) return
  event.preventDefault()
  onArea(next)
  const target = event.currentTarget.ownerDocument.getElementById(areaTabId(appId, next))
  target?.focus()
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

/** 权限: what this application may use, whom it may call, and who may reach it. */
function PermissionsTab(props: ManagementPageProps & { readonly app: AppInfo }): ReactNode {
  const { app, state, views, grant, revoke, setPolicy, t } = props
  const caller: Caller = { kind: 'app', appId: app.id }
  const describe = (need: string): NeedDescription => describeNeed(need, state.apps ?? [], views, t)
  return (
    <>
      <NeedsList
        title={t('perm.capabilities')}
        empty={t('perm.noCapabilities')}
        caller={caller}
        needs={app.needs}
        grants={state.grants}
        describe={describe}
        grant={grant}
        revoke={revoke}
        loaded={state.grantsLoaded}
        reading={state.grantsReading}
        failed={state.grantsFailed}
        onRetry={props.loadGrants}
        t={t}
      />
      {app.process === undefined ? null : <ProcessList process={app.process} t={t} />}
      <PoliciesList
        app={app}
        policies={state.policies}
        setPolicy={setPolicy}
        loaded={state.policiesLoaded}
        reading={state.policiesReading}
        failed={state.policiesFailed}
        onRetry={props.loadPolicies}
        t={t}
      />
    </>
  )
}

/** 历史: the calls whose TARGET is this application (never a global window presented as its own). */
function HistoryTab(props: ManagementPageProps & { readonly app: AppInfo }): ReactNode {
  const { app, state, t } = props
  // The shell loads history FOR THIS TARGET and drops a late answer for a
  // target the page left; the list still guards the old array so a switch
  // never paints A's records under B's name.
  const current = state.historyTarget === app.id
  const records = current ? historyInto(state.history, app.id) : []
  return (
    <section className={css.manageSection} data-manage-history>
      <p className={listCss.sectionTitle}>{t('history.title')}</p>
      <p className={css.caption}>{t('history.scope', { count: records.length })}</p>
      <HistoryList
        records={records}
        loaded={current && state.historyLoaded}
        reading={state.historyReading && state.historyTarget === app.id}
        failed={state.historyFailed && current}
        onRetry={() => { props.loadHistory(app.id) }}
        t={t}
      />
    </section>
  )
}

const TASK_STATE_KEYS: Record<TaskState, ApplicationsKey> = {
  running: 'tasks.state.running',
  cancelling: 'tasks.state.cancelling',
  succeeded: 'tasks.state.succeeded',
  failed: 'tasks.state.failed',
  cancelled: 'tasks.state.cancelled',
  interrupted: 'tasks.state.interrupted',
}

function taskStateLabel(t: TranslateNS<'applications'>, state: TaskState): string {
  return t(TASK_STATE_KEYS[state])
}

/** 任务: the calls this application has in flight and the latest progress they reported. */
/** The label the management list shows for one delegation state. */
function delegationStateLabel(t: TranslateNS<'applications'>, record: DelegationInfo): string {
  if (record.status === 'pending') return t('delegation.state.pending')
  if (record.status === 'active') return t('delegation.state.active')
  if (record.status === 'needs-person') return t('delegation.state.needsPerson')
  switch (record.outcome) {
    case 'completed': return t('delegation.state.completed')
    case 'failed': return t('delegation.state.failed')
    case 'cancelled': return t('delegation.state.cancelled')
    case 'interrupted': return t('delegation.state.interrupted')
    default: return t('delegation.state.unavailable')
  }
}

/**
 * 委托: the host's delegation records for THIS application. The list is read
 * when the tab opens (the platform record is the source of truth; a page never
 * caches outcomes), and the actions are the platform's own — open the bound
 * execution Session, or end the delegation. The page does not show the
 * Session transcript, and the report content is untrusted application data.
 */
function DelegationsTab(props: ManagementPageProps & { readonly app: AppInfo }): ReactNode {
  const { app, delegations, cancelDelegation, openDelegation, t } = props
  const [records, setRecords] = useState<readonly DelegationInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const load = (): void => {
    setFailed(false)
    void delegations(app.id).then((value) => {
      setRecords(value)
      setLoaded(true)
    }).catch(() => { setFailed(true); setLoaded(true) })
  }
  useEffect(() => {
    setLoaded(false)
    load()
    // The application identity is the load key; a newer read supersedes the old list.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the read is keyed by the app alone
  }, [app.id])
  useEffect(() => props.subscribeChanges?.(app.id, load), [app.id, props.subscribeChanges])
  const act = (id: string, action: () => Promise<unknown>): void => {
    setBusyId(id)
    setError(undefined)
    void action().then(() => {
      setBusyId(undefined)
      load()
    }).catch((reason: unknown) => {
      setBusyId(undefined)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <section className={css.manageSection} data-manage-delegations>
      {!loaded && <p className={css.caption} data-manage-delegations-loading>{t('delegation.loading')}</p>}
      {loaded && failed && (
        <button type="button" className={css.debugToggle} data-manage-delegations-retry onClick={load}>{t('delegation.retry')}</button>
      )}
      {error === undefined ? null : <FailureNote title={t('manage.delegationsFailed')} detail={error} detailLabel={t('manage.diagnostic')} data-manage-delegations-error />}
      {loaded && !failed && records.length === 0 && (
        <p className={css.caption} data-manage-delegations-empty>{t('delegation.empty')}</p>
      )}
      {records.length === 0 ? null : (
        <ul className={listCss.records}>
          {records.map(record => (
            <li key={record.id} className={listCss.record} data-manage-delegation={record.id}>
              <p className={listCss.recordMessage}>{record.title}</p>
              <p className={css.caption} data-manage-delegation-state={record.status}>
                {delegationStateLabel(t, record)}
                {record.latestReport === undefined ? '' : ` · ${record.latestReport.summary}`}
              </p>
              {record.latestReport?.question === undefined ? null : (
                <p className={css.caption} data-manage-delegation-question>
                  {t('delegation.question')} {record.latestReport.question}
                </p>
              )}
              {record.sessionId === undefined ? null : (
                <p className={css.caption} data-manage-delegation-session>{record.sessionId}</p>
              )}
              {record.status === 'pending'
                ? <p className={css.caption} data-manage-delegation-pending>{t('delegation.pendingHint')}</p>
                : null}
              <div className={css.developActions}>
                {record.sessionId === undefined ? null : (
                  <button
                    type="button"
                    className={css.debugToggle}
                    data-manage-delegation-open
                    disabled={busyId === record.id}
                    onClick={() => { act(record.id, async () => { await openDelegation(record.id, app.id) }) }}
                  >
                    {t('delegation.open')}
                  </button>
                )}
                {record.status === 'ended' ? null : (
                  <button
                    type="button"
                    className={css.debugToggle}
                    data-manage-delegation-cancel
                    disabled={busyId === record.id}
                    onClick={() => { act(record.id, async () => { await cancelDelegation(record.id, app.id) }) }}
                  >
                    {t('delegation.cancel')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function TasksTab({ state, app, viewProps, loadTasks, t }: {
  readonly state: ApplicationsState
  readonly app: AppInfo
  readonly viewProps: (appId: string) => ApplicationViewProps
  readonly loadTasks: () => void
  readonly t: TranslateNS<'applications'>
}): ReactNode {
  const calls = state.runningCalls.filter(call => call.appId === app.id)
  const tasks = state.tasks.filter(task => task.appId === app.id)
  const notices = state.progress.filter(notice => notice.appId === app.id).slice(0, 5)
  const outcome = state.outcomes.get(app.id)
  const code = outcome !== undefined && 'code' in outcome ? outcome.code : undefined
  return (
    <section className={css.manageSection} data-manage-tasks>
      <p className={listCss.sectionTitle}>{t('tasks.background')}</p>
      {state.tasksReading && <p className={css.caption} data-manage-tasks-reading>{t('tasks.loading')}</p>}
      {state.tasksFailed && (
        <>
          <button type="button" className={css.debugToggle} data-manage-tasks-retry onClick={loadTasks}>{t('tasks.retry')}</button>
          <p className={css.caption} data-manage-tasks-error>{state.error ?? ''}</p>
        </>
      )}
      {tasks.length === 0
        ? (state.tasksLoaded && !state.tasksFailed ? <p className={css.caption} data-manage-background-tasks-empty>{t('tasks.none')}</p> : null)
        : (
          <ul className={listCss.records}>
            {tasks.map(task => (
              <li key={task.taskId} className={listCss.record} data-manage-background-task={task.taskId}>
                <p className={listCss.recordMessage}>{task.title} <code>{task.kind}</code></p>
                <p className={css.caption}>{taskStateLabel(t, task.state)}{task.progress === undefined ? '' : ` · ${task.progress.message}`}</p>
                {(task.state === 'running' || task.state === 'cancelling') && (
                  <button type="button" className={css.debugToggle} data-manage-background-task-cancel onClick={() => { viewProps(app.id).cancelTask?.(task.taskId) }}>{t('tasks.cancel')}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      <p className={listCss.sectionTitle}>{t('tasks.title')}</p>
      {calls.length === 0
        ? <p className={css.caption} data-manage-tasks-empty>{t('tasks.empty')}</p>
        : (
          <ul className={listCss.records}>
            {calls.map(call => (
              <li key={call.requestId} className={listCss.record} data-manage-task={call.requestId}>
                <p className={listCss.recordMessage}><code>{call.op}</code></p>
                <p className={css.caption}>{t('tasks.started', { time: new Date(call.startedAt).toLocaleTimeString() })}</p>
                <button type="button" className={css.debugToggle} data-manage-task-cancel onClick={() => { viewProps(app.id).cancel(call.requestId) }}>{t('tasks.cancel')}</button>
              </li>
            ))}
          </ul>
        )}
      {notices.length > 0 && (
        <div data-manage-task-progress>
          <p className={listCss.sectionTitle}>{t('tasks.progress')}</p>
          <ul className={listCss.records}>
            {notices.map(notice => (
              <li key={`${notice.callId}:${notice.message}`} className={listCss.record}>
                <p className={listCss.recordMessage}><code>{notice.op}</code> {notice.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {outcome !== undefined && (
        <p className={css.caption} data-manage-task-outcome>
          {t('tasks.last')}: {outcome.status}{code === undefined ? '' : ` · ${code}`}
        </p>
      )}
    </section>
  )
}

/** Download one JSON answer without a server route. */
function downloadJson(fileName: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 信息: identity, state, declared operations, and the explicit debug surface. */
function InfoTab(props: ManagementPageProps & {
  readonly app: AppInfo
  readonly view: ApplicationView | undefined
  readonly section: 'status' | 'model' | 'data' | 'developer'
}): ReactNode {
  const { app, view, viewProps, t, section } = props
  const [activationBusy, setActivationBusy] = useState(false)
  const [activationError, setActivationError] = useState<string>()
  const [modelProvider, setModelProvider] = useState(app.model?.provider ?? '')
  const [modelName, setModelName] = useState(app.model?.model ?? '')
  const [modelBusy, setModelBusy] = useState(false)
  const [modelError, setModelError] = useState<string>()
  const [catalog, setCatalog] = useState<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelCatalog>()
  const [usage, setUsage] = useState<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelUsageSummary>()
  const [limits, setLimits] = useState<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelLimits>()
  const [limitsBusy, setLimitsBusy] = useState(false)
  const [limitsError, setLimitsError] = useState<string>()
  const [debugOpen, setDebugOpen] = useState(false)
  const [data, setData] = useState<AppDataInfo>()
  const [dataError, setDataError] = useState<string>()
  const [importText, setImportText] = useState<string>()
  const [importPreview, setImportPreview] = useState<AppDataImportPreview>()
  const [importResult, setImportResult] = useState<AppDataImportResult>()
  // The import is one sequence — reading → preview → committing — and the
  // controls show exactly the phase it is in. Without this, a slow confirm
  // stayed clickable with a fresh request id on every click, so the second
  // click could commit against a spent plan and paint success, error and a new
  // preview at once.
  const [importPhase, setImportPhase] = useState<'idle' | 'reading' | 'preview' | 'committing'>('idle')
  const [importFileName, setImportFileName] = useState<string>()
  const [importRequestId, setImportRequestId] = useState<string>()
  /** The file/preview generation: a response for an older file never paints. */
  const [dataConfirm, setDataConfirm] = useState<'restore' | 'import' | 'prune'>()
  const [pruned, setPruned] = useState<number>()
  const [restoreSource, setRestoreSource] = useState<AppDataBackup>()
  const [restorePreview, setRestorePreview] = useState<AppDataRestorePreview>()
  const [restoreResult, setRestoreResult] = useState<AppDataRestoreResult>()
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string>()
  useEffect(() => {
    if (section !== 'data') return undefined
    let cancelled = false
    setData(undefined)
    setDataError(undefined)
    void props.loadDataInfo(app.id).then((value) => { if (!cancelled) setData(value) }).catch((cause: unknown) => {
      if (!cancelled) setDataError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [app.id, section, props.loadDataInfo])
  useEffect(() => {
    if (section !== 'model') return undefined
    let cancelled = false
    void props.loadModelCatalog().then((value) => { if (!cancelled) setCatalog(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [section, props.loadModelCatalog])
  useEffect(() => {
    if (section !== 'model') return undefined
    let cancelled = false
    void props.loadModelUsage(app.id).then((value) => { if (!cancelled) setUsage(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [app.id, section, props.loadModelUsage])
  useEffect(() => {
    if (section !== 'model') return undefined
    let cancelled = false
    void props.loadModelLimits(app.id).then((value) => { if (!cancelled) setLimits(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [app.id, section, props.loadModelLimits])
  const pageProps = viewProps(app.id)
  const exportData = (): void => {
    void props.exportData(app.id).then((value) => { downloadJson(value.fileName, value.json) }).catch((cause: unknown) => {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const reloadData = (): void => {
    void props.loadDataInfo(app.id).then((value) => { setData(value) }).catch((cause: unknown) => {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  /** Abandon the current file/preview (a stale in-flight read is ignored). */
  const resetImport = (): void => {
    setImportPhase('idle')
    setImportFileName(undefined)
    setImportText(undefined)
    setImportPreview(undefined)
    setImportRequestId(undefined)
  }

  const chooseImport = (file: File | undefined): void => {
    if (file === undefined) return
    setImportResult(undefined)
    setImportPreview(undefined)
    setImportText(undefined)
    setImportRequestId(undefined)
    setImportFileName(file.name)
    setImportPhase('reading')
    setDataError(undefined)
    void (async () => {
      try {
        const text = await file.text()
        setImportText(text)
        const preview = await props.previewDataImport(app.id, text)
        setImportPreview(preview)
        // The request id belongs to THIS preview/plan: a retry of the same
        // confirm reuses it, and a new file mints its own.
        setImportRequestId(newRequestId())
        setImportPhase('preview')
      } catch (cause: unknown) {
        setImportPhase('idle')
        setDataError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }

  const cancelImport = (): void => {
    resetImport()
    setDataError(undefined)
  }

  /**
   * Commit the previewed import. The commit carries the preview's one-shot plan
   * and the request id minted with that preview: without them the host has no
   * baseline to compare, so a write that landed after the preview would be
   * silently overwritten (the import path used to drop both while restore
   * passed them). One confirm at a time — a second click while the commit runs
   * is ignored (and the control is disabled), so success, error and a fresh
   * preview can never describe the same action at once. A refusal spends the
   * plan, so the preview is re-read instead of retrying a dead token.
   */
  const confirmImport = (preview: AppDataImportPreview, text: string): void => {
    const planId = preview.planId
    const requestId = importRequestId ?? newRequestId()
    setImportPhase('committing')
    setDataError(undefined)
    void props.importData(app.id, planId, requestId).then((result) => {
      setImportResult(result)
      setImportPreview(undefined)
      setImportText(undefined)
      setImportRequestId(undefined)
      setImportFileName(undefined)
      setImportPhase('idle')
      reloadData()
    }).catch((cause: unknown) => {
      setDataError(cause instanceof Error ? cause.message : String(cause))
      // The plan was spent (or its base moved): show the CURRENT diff so the
      // user can compare and confirm again, rather than retry a stale token.
      void props.previewDataImport(app.id, text).then((preview) => {
        setImportPreview(preview)
        setImportRequestId(newRequestId())
        setImportPhase('preview')
      }).catch(() => {
        setImportPreview(undefined)
        setImportText(undefined)
        setImportRequestId(undefined)
        setImportPhase('idle')
      })
    })
  }
  const retryReload = (): void => {
    /* v8 ignore next -- the retry control renders only when the prop is set */
    if (props.reloadImportedData === undefined) return
    void props.reloadImportedData(app.id).then(() => {
      // The application is callable again and its cache now holds the imported
      // document; clear the failed-import/restore notice and re-read the data facts.
      setImportResult(undefined)
      setRestoreResult(undefined)
      setDataError(undefined)
      reloadData()
    }).catch((cause: unknown) => {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const startRestore = (backup: AppDataBackup): void => {
    setRestoreSource(backup)
    setRestorePreview(undefined)
    setRestoreResult(undefined)
    setRestoreError(undefined)
    setRestoreBusy(true)
    void props.restorePreview(app.id, backup.path).then((preview) => {
      setRestorePreview(preview)
    }).catch((cause: unknown) => {
      setRestoreError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setRestoreBusy(false) })
  }
  const confirmRestore = (): void => {
    /* v8 ignore next -- the confirm control renders only after a preview */
    if (restorePreview === undefined) return
    setRestoreBusy(true)
    setRestoreError(undefined)
    void props.restoreData(app.id, restorePreview.planId, newRequestId()).then((result) => {
      setRestoreResult(result)
      setRestorePreview(undefined)
      setRestoreSource(undefined)
      reloadData()
    }).catch((cause: unknown) => {
      setRestoreError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setRestoreBusy(false) })
  }
  const cancelRestore = (): void => {
    setRestoreSource(undefined)
    setRestorePreview(undefined)
    setRestoreError(undefined)
  }
  const pruneBackups = (): void => {
    /* v8 ignore next -- the prune control renders only when the prop is set */
    if (props.pruneBackups === undefined) return
    void props.pruneBackups(5).then((result) => {
      setPruned(result.removed)
      setDataError(undefined)
      reloadData()
    }).catch((cause: unknown) => {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const tokenTotal = usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined)
    ? undefined
    : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  const rows: readonly { readonly key: ApplicationsKey; readonly value: string }[] = [
    { key: 'info.id', value: app.id },
    { key: 'info.version', value: app.version },
    { key: 'info.runtime', value: t(RUNTIME_KEYS[app.runtime]) },
    ...(app.health === undefined ? [] : [{ key: 'info.health' as const, value: t(app.health === 'ok' ? 'health.ok' : 'health.degraded') }]),
    { key: 'info.activation', value: t(app.activation === 'enabled' ? 'activation.enabled' : 'activation.disabled') },
    ...(app.reason === undefined ? [] : [{ key: 'info.reason' as const, value: reasonLabel(app.reason, t) }]),
  ]
  const namespaceData = app.data === undefined || app.data.kind === 'unified'
  // A health-failed instance is stopped while the user's activation stays
  // enabled: an explicit enable is the recovery action, so that is what the
  // control offers (the platform itself never restarts it).
  const healthFailed = app.reason === 'platform.health-failed'
  const activationLabel = healthFailed && app.activation === 'enabled'
    ? t('activation.enable')
    : app.activation === 'enabled' ? t('activation.disable') : t('activation.enable')
  return (
    <section className={css.manageSection} data-manage-info>
      {(section === 'status' || section === 'model') && (<>
      {section === 'status' && (<>
      <dl className={css.infoRows}>
        {rows.map(row => (
          <div key={row.key} className={css.infoRow}>
            <dt>{t(row.key)}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className={css.infoActivation} data-manage-activation data-activation={app.activation}>
        <Button
          size="sm"
          variant={app.activation === 'enabled' && !healthFailed ? 'outline' : 'primary'}
          disabled={activationBusy}
          onClick={() => {
            setActivationBusy(true)
            setActivationError(undefined)
            // An explicit enable of a health-failed instance is its restart:
            // the runtime keeps the user setting and this command starts it.
            const next = healthFailed && app.activation === 'enabled'
              ? 'enabled'
              : app.activation === 'enabled' ? 'disabled' : 'enabled'
            void props.setActivation(app.id, next).then((ok) => {
              if (!ok) setActivationError(t('activation.failed'))
            }).finally(() => { setActivationBusy(false) })
          }}
        >
          {activationLabel}
        </Button>
      </div>
      {activationError === undefined ? null : <FailureNote title={t('info.activationFailed')} detail={activationError} detailLabel={t('manage.diagnostic')} data-manage-activation-error />}
      </>)}
      {section === 'model' && (<>
      <section data-manage-model>
        <p className={listCss.sectionTitle}>{t('model.title')}</p>
        <p className={css.caption}>{t('model.hint')}</p>
        <div className={css.infoRow}>
          <span>{t('model.provider')}</span>
          {catalog !== undefined && catalog.providers.length > 0 ? (
            <select data-model-provider aria-label={t('model.provider')} value={modelProvider} onChange={(event) => {
              const provider = event.target.value
              setModelProvider(provider)
              setModelName(catalog.providers.find(entry => entry.id === provider)?.models[0]?.id ?? '')
            }}>
              <option value="">{t('model.followDefault')}</option>
              {catalog.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          ) : (
            <input data-model-provider aria-label={t('model.provider')} value={modelProvider} onChange={(event) => { setModelProvider(event.target.value) }} />
          )}
        </div>
        <div className={css.infoRow}>
          <span>{t('model.name')}</span>
          {catalog !== undefined && catalog.providers.length > 0 ? (
            <select data-model-name aria-label={t('model.name')} value={modelName} onChange={(event) => { setModelName(event.target.value) }}>
              <option value="">{t('model.followDefault')}</option>
              {(catalog.providers.find(entry => entry.id === modelProvider)?.models ?? []).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          ) : (
            <input data-model-name aria-label={t('model.name')} value={modelName} onChange={(event) => { setModelName(event.target.value) }} />
          )}
        </div>
        {modelError !== undefined && <FailureNote title={t('info.modelFailed')} detail={modelError} detailLabel={t('manage.diagnostic')} data-manage-model-error />}
        <div className={css.developActions}>
          <Button data-model-reset disabled={modelBusy} onClick={() => {
            setModelBusy(true)
            setModelError(undefined)
            void props.setAppModel(app.id, null).then((ok) => {
              if (!ok) { setModelError(t('model.saveFailed')); return }
              setModelProvider('')
              setModelName('')
            }).finally(() => { setModelBusy(false) })
          }}>{t('model.followDefault')}</Button>
          <Button data-model-save variant="primary" disabled={modelBusy} onClick={() => {
            setModelBusy(true)
            setModelError(undefined)
            void props.setAppModel(app.id, modelProvider.trim() === '' || modelName.trim() === '' ? null : { provider: modelProvider.trim(), model: modelName.trim() }).then((ok) => {
              if (!ok) setModelError(t('model.saveFailed'))
            }).finally(() => { setModelBusy(false) })
          }}>{t('model.save')}</Button>
        </div>
        {usage !== undefined && (
          <>
            <p className={css.caption} data-model-usage data-model-tokens={tokenTotal === undefined ? 'unknown' : String(tokenTotal)}>
              {t('model.usage', {
                calls: String(usage.calls),
                succeeded: String(usage.succeeded),
                failed: String(usage.failed),
                cancelled: String(usage.cancelled),
                duration: String(usage.totalDurationMs),
                tokens: tokenTotal === undefined ? t('model.unknown') : String(tokenTotal),
                missing: String(usage.usageMissing),
              })}
            </p>
            {(usage.lastModel !== undefined || usage.lastStatus !== undefined) && (
              <p
                className={css.caption}
                data-model-last
                data-model-last-model={usage.lastModel === undefined ? undefined : `${usage.lastModel.provider}/${usage.lastModel.model}`}
                data-model-last-status={usage.lastStatus}
              >
                {t('model.last', {
                  model: usage.lastModel === undefined ? t('model.unknown') : `${usage.lastModel.provider}/${usage.lastModel.model}`,
                  status: usage.lastStatus === undefined
                    ? t('model.unknown')
                    : t(usage.lastStatus === 'success' ? 'model.status.success' : usage.lastStatus === 'failed' ? 'model.status.failed' : 'model.status.cancelled'),
                })}
              </p>
            )}
          </>
        )}
        {limits !== undefined && (
          <div data-model-limits>
            <p className={listCss.sectionTitle}>{t('limits.title')}</p>
            <label className={css.infoRow}>
              <input type="checkbox" data-limits-background checked={limits.background} onChange={(event) => { setLimits({ ...limits, background: event.target.checked }) }} />
              <span>{t('limits.background')}</span>
            </label>
            <div className={css.infoRow}>
              <span>{t('limits.concurrent')}</span>
              <input type="number" min="1" aria-label={t('limits.concurrent')} data-limits-concurrent value={limits.maxConcurrent ?? ''} onChange={(event) => {
                const { maxConcurrent: _previous, ...rest } = limits
                setLimits(event.target.value === '' ? rest : { ...rest, maxConcurrent: Number(event.target.value) })
              }} />
            </div>
            <div className={css.infoRow}>
              <span>{t('limits.perMinute')}</span>
              <input type="number" min="1" aria-label={t('limits.perMinute')} data-limits-per-minute value={limits.maxCallsPerMinute ?? ''} onChange={(event) => {
                const { maxCallsPerMinute: _previous, ...rest } = limits
                setLimits(event.target.value === '' ? rest : { ...rest, maxCallsPerMinute: Number(event.target.value) })
              }} />
            </div>
            {limitsError !== undefined && <FailureNote title={t('info.limitsFailed')} detail={limitsError} detailLabel={t('manage.diagnostic')} data-manage-limits-error />}
            <div className={css.developActions}>
              <Button data-limits-save variant="primary" disabled={limitsBusy} onClick={() => {
                setLimitsBusy(true)
                setLimitsError(undefined)
                void props.setModelLimits(app.id, limits).then((ok) => { if (!ok) setLimitsError(t('limits.saveFailed')) }).finally(() => { setLimitsBusy(false) })
              }}>{t('limits.save')}</Button>
            </div>
          </div>
        )}
      </section>
      </>)}
      {section === 'status' && (<>
      <p className={css.caption}>{app.description}</p>
      {app.objectTypes !== undefined && app.objectTypes.length > 0 && (
        <section data-manage-object-types>
          <p className={listCss.sectionTitle}>{t('info.objectTypes.title')}</p>
          <ul className={listCss.needList}>
            {app.objectTypes.map(objectType => (
              <li className={listCss.need} key={objectType.type} data-object-type={objectType.type}>
                <div className={listCss.needHead}><span className={listCss.needName}>{objectType.type}</span></div>
                {objectType.description !== undefined && <p className={listCss.needPurpose}>{objectType.description}</p>}
                <code>{objectType.resolveOperation}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      </>)}
      </>)}
      {section === 'data' && (<>
      <p className={listCss.sectionTitle}>{t('info.data.title')}</p>
      {app.data !== undefined && (
        <dl className={css.infoRows} data-manage-data-declared>
          <div className={css.infoRow}><dt>{t('info.data.declaredKind')}</dt><dd><code>{app.data.kind}</code></dd></div>
          {(app.data.namespace !== undefined || app.data.path !== undefined) && (
            <div className={css.infoRow}><dt>{t('info.data.declaredLocation')}</dt><dd><code>{app.data.namespace ?? app.data.path}</code></dd></div>
          )}
          {app.data.schemaVersion !== undefined && (
            <div className={css.infoRow}><dt>{t('info.data.declaredSchema')}</dt><dd>{String(app.data.schemaVersion)}</dd></div>
          )}
        </dl>
      )}
      {dataError !== undefined && (
        <FailureNote
          title={t('info.data.failed')}
          detail={dataError}
          detailLabel={t('info.data.diagnostic')}
          data-manage-data-error
          action={<Button size="sm" variant="ghost" onClick={reloadData} data-manage-data-retry>{t('reads.retry')}</Button>}
        />
      )}
      {data === undefined ? (dataError === undefined ? <p className={css.caption} data-manage-data-loading>{t('info.data.loading')}</p> : null) : (
        <div data-manage-data>
          <p className={css.caption} data-manage-data-boundary>{t('info.data.boundary')}</p>
          <dl className={css.infoRows}>
            <div className={css.infoRow}><dt>{t('info.data.path')}</dt><dd><code>{data.path}</code></dd></div>
            <div className={css.infoRow}>
              <dt>{t('info.data.size')}</dt>
              <dd>
                {data.byteSize === undefined ? '—' : formatBytes(data.totalByteSize ?? data.byteSize)}
                {data.walByteSize !== undefined && ` (${t('info.data.sizeWal', { size: formatBytes(data.walByteSize) })})`}
              </dd>
            </div>
            <div className={css.infoRow}><dt>{t('info.data.schema')}</dt><dd>{String(data.schemaVersion)}</dd></div>
            <div className={css.infoRow}><dt>{t('info.data.documents')}</dt><dd>{String(data.documentCount)}</dd></div>
            <div className={css.infoRow}>
              <dt>{t('info.data.collections')}</dt>
              <dd>{Object.entries(data.collections).map(([name, count]) => `${name}: ${String(count)}`).join(', ') || t('info.data.empty')}</dd>
            </div>
          </dl>
          {namespaceData && (<>
          <div data-manage-data-backups>
            <p className={listCss.sectionTitle}>{t('info.data.backups')}</p>
            {data.backups.length === 0
              ? <p className={css.caption} data-manage-data-backups-empty>{t('info.data.backupsEmpty')}</p>
              : (
                  <ul className={css.dataList}>
                    {data.backups.map(backup => (
                      <li key={backup.path} className={css.dataItem} data-manage-data-backup={backup.path}>
                        <span>{new Date(backup.modifiedAt).toLocaleString()}</span>
                        <span>{formatBytes(backup.byteSize)}</span>
                        <code className={css.dataPath}>{backup.path}</code>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-manage-data-restore={backup.path}
                          disabled={restoreBusy}
                          onClick={() => { startRestore(backup) }}
                        >
                          {t('info.data.restore')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
            {data.backupCount > data.backups.length && (
              <p className={css.caption} data-manage-data-backup-more>
                {t('info.data.backupMore', { count: String(data.backupCount - data.backups.length) })}
              </p>
            )}
          </div>
          {restoreBusy && <p className={css.caption} data-manage-data-restore-loading>{t('info.data.restoring')}</p>}
          {restoreError !== undefined && <FailureNote title={t('info.data.restoreFailed')} detail={restoreError} detailLabel={t('info.data.diagnostic')} data-manage-data-restore-error />}
          {restorePreview !== undefined && restoreSource !== undefined && (
            <div className={css.dataRestore} data-manage-data-restore-preview>
              <p className={listCss.sectionTitle}>{t('info.data.restorePreview')}</p>
              <p className={css.caption} data-manage-data-restore-documents>
                {t('info.data.restoreDocuments', {
                  backupOnly: String(restorePreview.documents.backupOnly),
                  currentOnly: String(restorePreview.documents.currentOnly),
                  modified: String(restorePreview.documents.modified),
                  unchanged: String(restorePreview.documents.unchanged),
                })}
              </p>
              <p className={css.caption} data-manage-data-restore-collections>
                {t('info.data.restoreCollections', {
                  backupOnly: String(restorePreview.collections.backupOnly),
                  currentOnly: String(restorePreview.collections.currentOnly),
                  modified: String(restorePreview.collections.modified),
                  unchanged: String(restorePreview.collections.unchanged),
                })}
              </p>
              {restorePreview.conflicts.length > 0 && (
                <div data-manage-data-restore-conflicts>
                  <p className={listCss.sectionTitle}>{t('info.data.restoreConflicts')}</p>
                  <ul className={css.dataList}>
                    {restorePreview.conflicts.map(conflict => (
                      <li key={`${conflict.kind}:${conflict.name}:${conflict.key ?? ''}`} className={css.dataItem} data-manage-data-restore-conflict>
                        <span>{conflict.kind === 'document' ? t('info.data.restoreDocument') : t('info.data.restoreCollection')}</span>
                        <code className={css.dataPath}>{conflict.name}{conflict.key === undefined ? '' : ` / ${conflict.key}`}</code>
                      </li>
                    ))}
                  </ul>
                  {restorePreview.truncated && (
                    <p className={css.caption} data-manage-data-restore-truncated>{t('info.data.restoreTruncated', { count: String(restorePreview.conflictCount - restorePreview.conflicts.length) })}</p>
                  )}
                </div>
              )}
              {restorePreview.metaChanged.length > 0 && (
                <p className={css.caption} data-manage-data-restore-meta>{t('info.data.restoreMeta', { count: String(restorePreview.metaChanged.length) })}</p>
              )}
              <p className={css.caption} data-manage-data-restore-warning>{t('info.data.restoreWarning')}</p>
              <div className={css.actions}>
                <Button size="sm" data-manage-data-restore-confirm disabled={restoreBusy} onClick={() => { setDataConfirm('restore') }}>{t('info.data.restoreConfirm')}</Button>
                <Button size="sm" variant="ghost" data-manage-data-restore-cancel disabled={restoreBusy} onClick={cancelRestore}>{t('info.data.restoreCancel')}</Button>
              </div>
            </div>
          )}
          {restoreResult !== undefined && (
            <div data-manage-data-restore-result>
              <span role="status">{t('info.data.restored', { backup: restoreResult.backupPath })}</span>
              {restoreResult.reload === 'failed' && (
                <span role="alert" data-manage-data-restore-reload-failed>
                  {t('info.data.restoreReloadFailed', { reason: restoreResult.reloadError ?? '' })}
                  {props.reloadImportedData !== undefined && (
                    <button type="button" className={css.debugToggle} data-manage-data-restore-reload-retry onClick={retryReload}>{t('info.data.reloadRetry')}</button>
                  )}
                </span>
              )}
            </div>
          )}
          <div className={css.dataActions}>
            <button type="button" className={css.debugToggle} data-manage-data-export onClick={exportData}>{t('info.data.export')}</button>
            <input
              id={`data-import-${app.id}`} type="file" accept="application/json,.json"
              className={css.hiddenFile} data-manage-data-file
              disabled={importPhase === 'reading' || importPhase === 'committing'}
              onChange={(event) => { chooseImport(event.target.files?.[0]) }}
            />
            <label className={css.debugToggle} htmlFor={`data-import-${app.id}`} data-manage-data-import>{t('info.data.import')}</label>
            {importFileName !== undefined && (
              <span className={css.meta} data-manage-data-file-name>
                {t('info.data.importFile', { name: importFileName })}
              </span>
            )}
            {importPhase === 'reading' && (
              <span className={css.meta} role="status" data-manage-data-reading>{t('info.data.importReading')}</span>
            )}
            {importPreview !== undefined && (
              <span data-manage-data-preview data-import-phase={importPhase}>
                {t('info.data.preview', {
                  documents: String(importPreview.documents),
                  collections: String(importPreview.collections),
                  newDocuments: String(importPreview.newDocuments),
                  overwrittenDocuments: String(importPreview.overwrittenDocuments),
                  removedDocuments: String(importPreview.removedDocuments),
                  newCollectionItems: String(importPreview.newCollectionItems),
                  overwrittenCollectionItems: String(importPreview.overwrittenCollectionItems),
                  removedCollectionItems: String(importPreview.removedCollectionItems),
                })}
                <Button
                  size="sm"
                  data-manage-data-confirm
                  disabled={importPhase === 'committing'}
                  onClick={() => { setDataConfirm('import') }}
                >{importPhase === 'committing' ? t('info.data.importing') : t('info.data.confirm')}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-manage-data-cancel
                  disabled={importPhase === 'committing'}
                  onClick={cancelImport}
                >{t('info.data.importCancel')}</Button>
              </span>
            )}
            {importResult !== undefined && (
              <span role="status" data-manage-data-result>
                {t('info.data.imported', { backup: importResult.backupPath })}
                {importResult.reload === 'failed' && (
                  <span role="alert" data-manage-data-reload-failed>
                    {t('info.data.reloadFailed', { reason: importResult.reloadError ?? '' })}
                    {props.reloadImportedData !== undefined && (
                      <button type="button" className={css.debugToggle} data-manage-data-reload-retry onClick={retryReload}>{t('info.data.reloadRetry')}</button>
                    )}
                  </span>
                )}
              </span>
            )}
            {props.pruneBackups !== undefined && (
              <Button size="sm" variant="ghost" data-manage-data-prune onClick={() => { setDataConfirm('prune') }}>{t('info.data.prune')}</Button>
            )}
            {pruned !== undefined && (
              <span role="status" data-manage-data-pruned>{t('info.data.pruned', { count: String(pruned) })}</span>
            )}
          </div>

          {dataConfirm === undefined ? null : (
            <Modal
              open
              onClose={() => { setDataConfirm(undefined) }}
              title={dataConfirm === 'restore' ? t('info.data.restoreDialogTitle') : dataConfirm === 'import' ? t('info.data.importDialogTitle') : t('info.data.pruneDialogTitle')}
              closeLabel={t('info.data.dialogClose')}
              tone="warning"
              description={dataConfirm === 'restore'
                ? t('info.data.restoreDialogBody', { backup: restoreSource?.path ?? '' })
                : dataConfirm === 'import'
                  ? t('info.data.importDialogBody', { name: importFileName ?? '' })
                  : t('info.data.pruneDialogBody')}
              footer={(
                <>
                  <Button data-modal-autofocus data-data-confirm-no onClick={() => { setDataConfirm(undefined) }}>{t('info.data.dialogCancel')}</Button>
                  <Button
                    variant="primary"
                    data-data-confirm-yes
                    onClick={() => {
                      const kind = dataConfirm
                      setDataConfirm(undefined)
                      if (kind === 'restore') confirmRestore()
                      else if (kind === 'import' && importPreview !== undefined) confirmImport(importPreview, importText ?? '')
                      else if (kind === 'prune') pruneBackups()
                    }}
                  >{dataConfirm === 'restore' ? t('info.data.restoreYes') : dataConfirm === 'import' ? t('info.data.importYes') : t('info.data.pruneYes')}</Button>
                </>
              )}
            >
              <div data-data-confirm-dialog data-confirm-kind={dataConfirm}>
                {dataConfirm === 'restore' && restorePreview !== undefined && (
                  <>
                    <p>{t('info.data.restoreDocuments', {
                      backupOnly: String(restorePreview.documents.backupOnly),
                      currentOnly: String(restorePreview.documents.currentOnly),
                      modified: String(restorePreview.documents.modified),
                      unchanged: String(restorePreview.documents.unchanged),
                    })}</p>
                    <p>{t('info.data.restoreCollections', {
                      backupOnly: String(restorePreview.collections.backupOnly),
                      currentOnly: String(restorePreview.collections.currentOnly),
                      modified: String(restorePreview.collections.modified),
                      unchanged: String(restorePreview.collections.unchanged),
                    })}</p>
                  </>
                )}
                {dataConfirm === 'import' && importPreview !== undefined && (
                  <p>{t('info.data.preview', {
                    documents: String(importPreview.documents),
                    collections: String(importPreview.collections),
                    newDocuments: String(importPreview.newDocuments),
                    overwrittenDocuments: String(importPreview.overwrittenDocuments),
                    removedDocuments: String(importPreview.removedDocuments),
                    newCollectionItems: String(importPreview.newCollectionItems),
                    overwrittenCollectionItems: String(importPreview.overwrittenCollectionItems),
                    removedCollectionItems: String(importPreview.removedCollectionItems),
                  })}</p>
                )}
              </div>
            </Modal>
          )}
          </>)}
        </div>
      )}
      </>)}
      {section === 'developer' && (<>
      {app.connections !== undefined && app.connections.length > 0 && (
        <section data-manage-connections>
          <p className={listCss.sectionTitle}>{t('info.chains.title')}</p>
          <ul className={listCss.needList}>
            {app.connections.map(connection => (
              <li className={listCss.need} key={connection.kind === 'call' ? `call:${connection.target}` : `sub:${connection.publisher}:${connection.event}`} data-connection={connection.kind === 'call' ? connection.target : `${connection.publisher}#${connection.event}`}>
                <div className={listCss.needHead}>
                  <span className={listCss.needName}>{connection.kind === 'call' ? connection.target : `${connection.publisher}#${connection.event}`}</span>
                </div>
                <p className={listCss.needPurpose}>
                  {connection.kind === 'call'
                    ? t('info.chains.call', { ops: connection.ops === 'all' ? t('info.chains.all') : connection.ops.join(', '), state: connection.available ? t('info.chains.available') : t('info.chains.missing') })
                    : t('info.chains.subscription', { state: connection.available ? (connection.open ? t('info.chains.open') : t('info.chains.closed')) : t('info.chains.missing') })}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {app.needs.some(need => need.startsWith('capability:')) && (
        <section data-manage-connections>
          <p className={listCss.sectionTitle}>{t('info.connections.title')}</p>
          <p className={css.caption}>{t('info.connections.hint')}</p>
          <ul className={listCss.needList}>
            {app.needs.filter(need => need.startsWith('capability:')).map(need => (
              <li className={listCss.need} key={need} data-capability={need}>
                <div className={listCss.needHead}><span className={listCss.needName}>{need.slice('capability:'.length)}</span></div>
                <p className={listCss.needPurpose}>{t('info.connections.capability')}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className={listCss.sectionTitle}>{t('info.ops')}</p>
      <ul className={listCss.records} data-app-ops>
        {app.ops.map(op => (
          <li key={op.name} className={listCss.record}>
            <div className={listCss.recordHead}>
              <code className={listCss.code}>{op.name}</code>
              {op.exposure.ai !== undefined && <code className={listCss.code}>ai:{op.exposure.ai}</code>}
              {op.exposure.peers !== undefined && <code className={listCss.code}>peers:{op.exposure.peers}</code>}
            </div>
            <p className={listCss.recordMessage}>{op.description}</p>
          </li>
        ))}
      </ul>
      <div className={css.debug}>
        <button
          type="button"
          className={css.debugToggle}
          data-manage-debug-toggle
          aria-expanded={debugOpen}
          onClick={() => { setDebugOpen(open => !open) }}
        >
          {t('menu.debug')}
        </button>
        {debugOpen && (
          // Keyed by application: switching which application is managed must
          // not carry the previous one's arguments or result into this form.
          <GenericCallForm
            key={app.id}
            app={app}
            call={pageProps.call}
            cancel={pageProps.cancel}
            t={t}
          />
        )}
      </div>
      {view !== undefined && hasSettings(view) && (
        <p className={css.caption}>{t('info.settingsHint')}</p>
      )}
      </>)}
    </section>
  )
}

