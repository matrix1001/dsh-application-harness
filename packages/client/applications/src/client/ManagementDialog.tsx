/**
 * The management surface: one centered dialog, opened either at the list of
 * every application the host runs (the global entry) or directly at one
 * application's detail (the header's entry, or a row of the list).
 *
 * It is deliberately a MODAL — managing an application must not switch the
 * business page underneath, and closing it must give the page back exactly as
 * it was. The platform's own Modal owns the mask, the focus trap and Escape;
 * this module owns what the dialog shows. Nothing here approves anything by
 * itself: grants, revocations and confirmation answers are the shell's
 * commands, whose real results the dialog re-reads.
 * @module @matrix1001/dsh-application-harness-client-applications/client/ManagementDialog
 */
import { createElement, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppDataBackup, AppDataExport, AppDataImportPreview, AppDataImportResult, AppDataInfo, AppDataPruneResult, AppDataRestorePreview, AppDataRestoreResult, AppInfo, Caller, ConfirmationDecision, OperationPolicy, TaskState } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type {
  ApplicationSettingsProps, ApplicationView, ApplicationViewProps, ManageRequest, ManageTab,
} from './contract.ts'
import type { ApplicationsState } from './shell.ts'
import { AppIcon } from './AppIcon.tsx'
import { StatusBadge } from './StatusBadge.tsx'
import {
  STATUS_KEYS, capabilityNeeds, confirmationSentence, describeNeed, displayDescription, displayName, grantsInto, hasPage,
  hasSettings, historyInto, type NeedDescription,
} from './model.ts'
import { ConfirmationsList, GrantsIntoList, HistoryList, NeedsList, PoliciesList } from './Lists.tsx'
import { GenericCallForm } from './GenericCallForm.tsx'
import { manageScrollKey, type ManageScrollMemory } from './manage.ts'
import { useSurfaceScroll } from './surface-scroll.ts'
import type { ApplicationsKey } from './locales.ts'
import css from './ApplicationsArea.module.css'
import listCss from './ApplicationsLists.module.css'

/** The detail tabs, in render order (settings is dropped when the application has none). */
export const MANAGE_TABS: readonly { readonly key: ManageTab; readonly label: ApplicationsKey }[] = [
  { key: 'settings', label: 'tab.settings' },
  { key: 'permissions', label: 'tab.permissions' },
  { key: 'info', label: 'tab.info' },
  { key: 'data', label: 'tab.data' },
  { key: 'tasks', label: 'tab.tasks' },
  { key: 'history', label: 'tab.history' },
  { key: 'developer', label: 'tab.developer' },
]

/** What the dialog renders from and every command it can run. */
/** One idempotency key per committed import/restore. */
function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface ManagementDialogProps {
  readonly state: ApplicationsState
  readonly views: ReadonlyMap<string, ApplicationView>
  readonly request: ManageRequest
  /** Move between the list and one application's detail. */
  readonly onNavigate: (request: ManageRequest) => void
  readonly onClose: () => void
  /** The props one application's settings page is rendered with. */
  readonly settingsProps: (appId: string) => ApplicationSettingsProps
  /** The props one application's page is rendered with (the debug form uses its call pair). */
  readonly viewProps: (appId: string) => ApplicationViewProps
  /** Where the dialog remembers its scroll positions (the framework instance owns it). */
  readonly scroll: ManageScrollMemory
  readonly loadHistory: (appId?: string) => void
  /** Read the host's background-task projections. */
  readonly loadTasks: () => void
  /** Read one application's unified-store data facts. */
  readonly loadDataInfo: (appId: string) => Promise<AppDataInfo>
  /** Preview restoring one application from a whole-database backup. */
  readonly restorePreview: (appId: string, backupPath: string) => Promise<AppDataRestorePreview>
  /** Restore one application from a backup. */
  readonly restoreData: (appId: string, backupPath: string, previewFingerprint?: string, planId?: string, requestId?: string) => Promise<AppDataRestoreResult>
  /** Export one application's unified-store namespace (JSON download). */
  readonly exportData: (appId: string) => Promise<AppDataExport>
  /** Validate one application JSON import before any write. */
  readonly previewDataImport: (appId: string, json: string) => Promise<AppDataImportPreview>
  /** Import one application JSON after a pre-import backup. */
  readonly importData: (appId: string, json: string, planId?: string, requestId?: string) => Promise<AppDataImportResult>
  /** Retry the reload an import could not complete (the app stays held). */
  readonly reloadImportedData?: (appId: string) => Promise<void>
  /** Delete old pre-import snapshots beyond the newest keep (explicit action). */
  readonly pruneBackups?: (keep: number) => Promise<AppDataPruneResult>
  readonly loadGrants: () => void
  readonly loadPolicies: () => void
  readonly loadConfirmations: () => void
  readonly setPolicy: (appId: string, op: string, policy: OperationPolicy) => Promise<boolean>
  readonly setActivation: (appId: string, activation: 'enabled' | 'disabled') => Promise<boolean>
  readonly setAppModel: (appId: string, selection: { provider: string; model: string } | null) => Promise<boolean>
  readonly loadModelCatalog: () => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelCatalog>
  readonly loadModelUsage: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelUsageSummary>
  readonly loadModelLimits: (appId: string) => Promise<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelLimits>
  readonly loadCredentials: (appId: string) => Promise<readonly import('@matrix1001/dsh-application-harness-host-bridge/client').AppCredentialStatus[]>
  readonly setCredential: (appId: string, name: string, value: string) => Promise<boolean>
  readonly deleteCredential: (appId: string, name: string) => Promise<boolean>
  readonly setModelLimits: (appId: string, limits: import('@matrix1001/dsh-application-harness-host-bridge/client').ModelLimits) => Promise<boolean>
  readonly grant: (caller: Caller, capabilities: readonly string[]) => Promise<boolean>
  readonly revoke: (caller: Caller, selector?: string) => Promise<boolean>
  readonly answer: (id: string, decision: ConfirmationDecision) => Promise<boolean>
  /** Withdraw a pending confirmation. */
  readonly cancelConfirmation: (id: string) => Promise<boolean>
  readonly t: TranslateNS<'applications'>
}

/** The tabs one application actually has (settings only when it registers any). */
export function tabsOf(view: ApplicationView | undefined): readonly ManageTab[] {
  return MANAGE_TABS.filter(tab => tab.key !== 'settings' || hasSettings(view)).map(tab => tab.key)
}

/** The tab a detail opens at when the caller names none that exists. */
export function defaultTab(view: ApplicationView | undefined): ManageTab {
  return hasSettings(view) ? 'settings' : 'permissions'
}

/** The id the detail's tab panels carry, and the tabs point at. */
const PANEL_ID = 'applications-manage-panel'

/** One tab's element id (the tab/pane pair a screen reader reads together). */
function tabId(appId: string, tab: ManageTab): string {
  return `applications-manage-${appId}-${tab}`
}

/**
 * Render the management dialog.
 * @param props - the state, the request and the commands.
 * @returns the modal element.
 */
export function ManagementDialog(props: ManagementDialogProps): ReactNode {
  // The task tab/list shows durable projections (including interrupted tasks),
  // not only whatever live watch frames happened to arrive since mount.
  const loadTasks = props.loadTasks
  useEffect(() => { loadTasks() }, [loadTasks])
  const { state, views, request, onNavigate, onClose, settingsProps, t } = props
  const apps = state.apps
  const app = apps?.find(candidate => candidate.id === request.appId)
  const view = app === undefined ? undefined : views.get(app.id)
  const tabs = tabsOf(view)
  const tab = tabs.includes(request.tab) ? request.tab : defaultTab(view)

  // The dialog reads what it shows: the grants behind the permission lists and
  // the confirmations behind the waiting section. History is per TARGET, so it
  // is read for the application on screen — never filtered out of a global
  // window and presented as "this application's history".
  useEffect(() => { props.loadConfirmations() }, [props.loadConfirmations])
  useEffect(() => {
    if (tab === 'permissions') props.loadGrants()
    if (tab === 'history' && request.appId !== undefined) props.loadHistory(request.appId)
  }, [tab, request.appId, props.loadGrants, props.loadHistory])

  const title = app === undefined ? t('manage.title') : displayName(app, view)

  // The dialog body remembers where it was, per surface: the list, and each
  // application's each tab. Not the settings tab — that one owns its own
  // scrolling inside the application's settings layout (and keeps its position
  // in the application's own view state), so the dialog's scroller is not the
  // element that moves there.
  const body = useRef<HTMLDivElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const previousAppId = useRef<string | undefined>(undefined)
  useEffect(() => {
    // Navigating between the list and one application's detail replaces the
    // element that had focus. Move focus to the destination after the modal's
    // own focus trap has run, instead of letting it fall to document.body.
    const timer = setTimeout(() => {
      if (previousAppId.current !== undefined && request.appId === undefined) {
        body.current?.querySelector<HTMLElement>('[data-manage-row]')?.focus()
      } else if (request.appId !== undefined && request.appId !== previousAppId.current) {
        backButton.current?.focus()
      }
      previousAppId.current = request.appId
    }, 0)
    return () => { clearTimeout(timer) }
  }, [request.appId])
  useSurfaceScroll(body, {
    key: tab === 'settings' ? undefined : manageScrollKey(request.appId, tab),
    // The body's content can arrive late (grants, history): the memory's own
    // growth watcher is the retry, so this reports ready from the start.
    ready: true,
    memory: props.scroll,
  })

  return (
    <Modal
      open
      headless
      onClose={onClose}
      title={t('manage.title')}
      className={css.dialog as string}
    >
      <div className={css.manage} data-manage-dialog>
        <div className={css.manageHead}>
          {app !== undefined && (
            <button
              type="button"
              className={css.manageIconButton}
              data-manage-back
              ref={backButton}
              aria-label={t('manage.back')}
              onClick={() => { onNavigate({ tab: defaultTab(undefined) }) }}
            >
              <IconChevronLeftOutlineRegular size={16} />
            </button>
          )}
          {app !== undefined && <AppIcon view={view} size={20} />}
          <div className={css.manageHeading}>
            <h2 className={css.manageTitle}>{title}</h2>
            {/* The application's own short line; its id and version live in the
                info tab, where they are read on purpose instead of here. */}
            {app !== undefined && <span className={css.manageSub}>{displayDescription(app, view)}</span>}
          </div>
          <button
            type="button"
            className={css.manageIconButton}
            data-manage-close
            aria-label={t('manage.close')}
            onClick={onClose}
          >
            <IconCloseOutlineRegular size={16} />
          </button>
        </div>

        {app !== undefined && (
          <nav className={css.manageTabs} role="tablist" aria-label={t('tab.list')}>
            {MANAGE_TABS.filter(entry => tabs.includes(entry.key)).map(entry => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                id={tabId(app.id, entry.key)}
                data-manage-tab={entry.key}
                tabIndex={entry.key === tab ? 0 : -1}
                aria-selected={entry.key === tab}
                aria-controls={PANEL_ID}
                onClick={() => { onNavigate({ appId: app.id, tab: entry.key }) }}
                onKeyDown={(event) => { onTabKey(event, tabs, tab, app.id, onNavigate) }}
              >
                {t(entry.label)}
              </button>
            ))}
          </nav>
        )}

        <div
          className={css.manageBody}
          ref={body}
          data-manage-body
          data-manage-tab={tab}
          {...(app === undefined ? {} : { role: 'tabpanel', id: PANEL_ID, 'aria-labelledby': tabId(app.id, tab) })}
        >
          {/* The dialog is modal: a failure line left behind it would be
              invisible, and a command that failed without a row of its own to
              report into (a confirmation answer) lands here. */}
          {state.error !== undefined && (
            <p className={css.error} role="alert" data-manage-error>{t('error.title')}: {state.error}</p>
          )}
          {app === undefined
            ? <ManageList {...props} />
            : (
              <>
                {tab === 'permissions' && <PermissionsTab {...props} app={app} />}
                {tab === 'history' && <HistoryTab {...props} app={app} />}
                {tab === 'info' && <InfoTab {...props} app={app} view={view} section="all" />}
                {tab === 'data' && <InfoTab {...props} app={app} view={view} section="data" />}
                {tab === 'developer' && <InfoTab {...props} app={app} view={view} section="developer" />}
                {tab === 'tasks' && <TasksTab state={state} app={app} viewProps={props.viewProps} loadTasks={props.loadTasks} t={t} />}
                {view?.Settings !== undefined && (
                  // Kept mounted across tab switches so an unfinished settings
                  // draft is not silently discarded (the dialog hides it with
                  // display:none, which the flex host cannot do via [hidden]).
                  // Keyed by application: managing B after A must give B's
                  // settings a fresh mount, never reuse A's read state.
                  <div className={css.settingsHost} data-manage-settings style={{ display: tab === 'settings' ? 'flex' : 'none' }}>
                    {createElement(view.Settings, { ...settingsProps(app.id), key: app.id })}
                  </div>
                )}
              </>
            )}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Keyboard navigation across the detail tabs (the WAI-ARIA tablist model): the
 * arrows wrap, Home and End jump to the ends, and the SELECTION and the DOM
 * focus move together — a roving tabindex that only moved the selection would
 * leave the keyboard user's focus behind on a tab that no longer owns it. A
 * narrow dialog scrolls horizontally, so the newly focused tab is brought into
 * view.
 */
function onTabKey(
  event: KeyboardEvent<HTMLButtonElement>,
  tabs: readonly ManageTab[],
  current: ManageTab,
  appId: string,
  onNavigate: (request: ManageRequest) => void,
): void {
  const index = tabs.indexOf(current)
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  const next = step !== 0
    ? tabs[(index + step + tabs.length) % tabs.length]
    : event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs[tabs.length - 1]
        : undefined
  if (next === undefined) return
  event.preventDefault()
  onNavigate({ appId, tab: next })
  const target = event.currentTarget.ownerDocument.getElementById(tabId(appId, next))
  target?.focus()
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

/** The list: every application the host runs, plus whatever waits for an answer. */
function ManageList(props: ManagementDialogProps): ReactNode {
  const { state, views, onNavigate, answer, t } = props
  const apps = state.apps ?? []
  return (
    <>
      {state.runningCalls.length > 0 && (
        <section className={css.manageSection} data-manage-active-tasks>
          <p className={listCss.sectionTitle}>{t('tasks.all')}</p>
          <ul className={listCss.records}>
            {state.runningCalls.map(call => {
              const app = apps.find(candidate => candidate.id === call.appId)
              const name = app === undefined ? call.appId : displayName(app, views.get(app.id))
              return (
                <li key={call.requestId} className={listCss.record} data-manage-active-task={call.requestId}>
                  <p className={listCss.recordMessage}><code>{call.op}</code> · {name}</p>
                  <p className={css.caption}>{t('tasks.started', { time: new Date(call.startedAt).toLocaleTimeString() })}</p>
                  <button type="button" className={css.debugToggle} data-manage-active-task-cancel onClick={() => { props.viewProps(call.appId).cancel(call.requestId) }}>{t('tasks.cancel')}</button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {(state.tasks.some(task => task.state === 'running' || task.state === 'cancelling') || state.tasksFailed) && (
        <section className={css.manageSection} data-manage-background-tasks>
          <p className={listCss.sectionTitle}>{t('tasks.background')}</p>
          {state.tasksFailed && (
            <button type="button" className={css.debugToggle} data-manage-tasks-retry onClick={() => { props.loadTasks() }}>{t('tasks.retry')}</button>
          )}
          <ul className={listCss.records}>
            {state.tasks
              .filter(task => task.state === 'running' || task.state === 'cancelling')
              .map(task => {
                const app = apps.find(candidate => candidate.id === task.appId)
                const name = app === undefined ? task.appId : displayName(app, views.get(app.id))
                return (
                  <li key={task.taskId} className={listCss.record} data-manage-background-task={task.taskId}>
                    <p className={listCss.recordMessage}>{task.title} · {name}</p>
                    <p className={css.caption}>{taskStateLabel(t, task.state)}{task.progress === undefined ? '' : ` · ${task.progress.message}`}</p>
                    <button type="button" className={css.debugToggle} data-manage-background-task-cancel onClick={() => { props.viewProps(task.appId).cancelTask?.(task.taskId) }}>{t('tasks.cancel')}</button>
                  </li>
                )
              })}
          </ul>
        </section>
      )}
      {(state.confirmations.length > 0 || !state.confirmationsLoaded || state.confirmationsReading || state.confirmationsFailed) && (
        <section className={css.manageSection} data-manage-confirmations>
          <p className={listCss.sectionTitle}>{t('confirm.title')}</p>
          <ConfirmationsList
            confirmations={state.confirmations}
            answer={answer}
            cancelConfirmation={props.cancelConfirmation}
            sentence={request => confirmationSentence(request, apps, views, t)}
            loaded={state.confirmationsLoaded}
            reading={state.confirmationsReading}
            failed={state.confirmationsFailed}
            onRetry={props.loadConfirmations}
            t={t}
          />
        </section>
      )}
      {state.apps === undefined
        ? <p className={listCss.hint} data-manage-loading>{t('loading')}</p>
        : apps.length === 0
          ? <p className={listCss.hint}>{t('state.empty')}</p>
          : (
            <ul className={css.manageRows} data-manage-list>
            {apps.map(app => {
              const view = views.get(app.id)
              const name = displayName(app, view)
              return (
                <li key={app.id}>
                  <button
                    type="button"
                    className={css.manageRow}
                    data-manage-row={app.id}
                    data-status={app.status}
                    aria-label={t('manage.rowOpen', { name })}
                    onClick={() => { onNavigate({ appId: app.id, tab: defaultTab(view) }) }}
                  >
                    <AppIcon view={view} size={20} />
                    {/* The prototype's row: the real name over the real
                        description (the host's own words), the real status, and
                        the way in. Nothing here is invented to fill the row. */}
                    <span className={css.manageRowMain}>
                      <span className={css.manageRowName}>{name}</span>
                      <span className={css.manageRowDesc}>{displayDescription(app, view)}</span>
                    </span>
                    {!hasPage(view) && <span className={css.manageRowHint}>{t('manage.noPage')}</span>}
                    <StatusBadge runtime={app.runtime} status={app.status} health={app.health} activation={app.activation} t={t} />
                    <IconChevronRightOutlineRegular size={16} className={css.manageRowChevron} />
                  </button>
                </li>
              )
            })}
            </ul>
          )}
    </>
  )
}

/** 权限: what this application may use, whom it may call, and who may reach it. */
function PermissionsTab(props: ManagementDialogProps & { readonly app: AppInfo }): ReactNode {
  const { app, state, views, grant, revoke, setPolicy, t } = props
  const into = grantsInto(state.grants, app.id)
  const caller: Caller = { kind: 'app', appId: app.id }
  const describe = (need: string): NeedDescription => describeNeed(need, state.apps ?? [], views, t)
  return (
    <>
      <NeedsList
        title={t('perm.capabilities')}
        empty={t('perm.noCapabilities')}
        caller={caller}
        needs={capabilityNeeds(app)}
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
      {app.events !== undefined && app.events.length > 0 && (
        <section data-manage-events>
          <h3 className={listCss.needTitle}>{t('perm.events')}</h3>
          <ul className={listCss.needList}>
            {app.events.map(event => (
              <li className={listCss.need} key={event.type} data-app-event={event.type}>
                <div className={listCss.needHead}>
                  <span className={listCss.needName}>{event.type}</span>
                  <span className={listCss.needPurpose}>{t(event.subscription === 'open' ? 'event.open' : 'event.closed')}</span>
                </div>
                <p className={listCss.needPurpose}>{event.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <GrantsIntoList
        title={t('perm.into')}
        empty={t('perm.noInto')}
        entries={into}
        describe={describe}
        revoke={revoke}
        loaded={state.grantsLoaded}
        reading={state.grantsReading}
        failed={state.grantsFailed}
        onRetry={props.loadGrants}
        t={t}
      />
    </>
  )
}

/** 历史: the calls whose TARGET is this application (never a global window presented as its own). */
function HistoryTab(props: ManagementDialogProps & { readonly app: AppInfo }): ReactNode {
  const { app, state, t } = props
  // The shell loads history FOR THIS TARGET and drops a late answer for a
  // target the dialog left; the tab still guards the old array so a switch
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
function InfoTab(props: ManagementDialogProps & {
  readonly app: AppInfo
  readonly view: ApplicationView | undefined
  readonly section: 'all' | 'data' | 'developer'
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
  const [credentials, setCredentials] = useState<readonly import('@matrix1001/dsh-application-harness-host-bridge/client').AppCredentialStatus[]>([])
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
  const [credentialBusy, setCredentialBusy] = useState<string>()
  const [credentialError, setCredentialError] = useState<string>()
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
  const [pruneArmed, setPruneArmed] = useState(false)
  const [pruned, setPruned] = useState<number>()
  const [restoreSource, setRestoreSource] = useState<AppDataBackup>()
  const [restorePreview, setRestorePreview] = useState<AppDataRestorePreview>()
  const [restoreResult, setRestoreResult] = useState<AppDataRestoreResult>()
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    setData(undefined)
    setDataError(undefined)
    void props.loadDataInfo(app.id).then((value) => { if (!cancelled) setData(value) }).catch((cause: unknown) => {
      if (!cancelled) setDataError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [app.id, props.loadDataInfo])
  useEffect(() => {
    let cancelled = false
    void props.loadModelCatalog().then((value) => { if (!cancelled) setCatalog(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [props.loadModelCatalog])
  useEffect(() => {
    let cancelled = false
    void props.loadModelUsage(app.id).then((value) => { if (!cancelled) setUsage(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [app.id, props.loadModelUsage])
  useEffect(() => {
    let cancelled = false
    void props.loadModelLimits(app.id).then((value) => { if (!cancelled) setLimits(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [app.id, props.loadModelLimits])
  useEffect(() => {
    let cancelled = false
    void props.loadCredentials(app.id).then((value) => { if (!cancelled) setCredentials(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [app.id, props.loadCredentials])
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
    void props.importData(app.id, text, planId, planId === undefined ? undefined : requestId).then((result) => {
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
    if (restoreSource === undefined || restorePreview === undefined) return
    setRestoreBusy(true)
    setRestoreError(undefined)
    void props.restoreData(app.id, restoreSource.path, restorePreview.previewFingerprint, restorePreview.planId, newRequestId()).then((result) => {
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
      setPruneArmed(false)
      setPruned(result.removed)
      setDataError(undefined)
      reloadData()
    }).catch((cause: unknown) => {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const legacyLabel = (key: string): string => {
    const known: Record<string, ApplicationsKey> = {
      'legacy-settings-imported': 'info.data.legacySettings',
      'legacy-inbox-imported': 'info.data.legacyInbox',
      'legacy-workbook-imported': 'info.data.legacyWorkbook',
      'legacy-filters-imported': 'info.data.legacyFilters',
    }
    const label = known[key]
    return label === undefined ? key : t(label)
  }
  const rows: readonly { readonly key: ApplicationsKey; readonly value: string }[] = [
    { key: 'info.id', value: app.id },
    { key: 'info.version', value: app.version },
    { key: 'info.status', value: t(STATUS_KEYS[app.status]) },
    { key: 'info.activation', value: t(app.activation === 'enabled' ? 'activation.enabled' : 'activation.disabled') },
    { key: 'info.model', value: app.model === undefined ? t('model.followDefault') : `${app.model.provider} / ${app.model.model}` },
  ]
  const namespaceData = app.data === undefined || app.data.kind === 'unified'
  return (
    <section className={css.manageSection} data-manage-info>
      {section !== 'data' && section !== 'developer' && (<>
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
          variant={app.activation === 'enabled' ? 'outline' : 'primary'}
          disabled={activationBusy}
          onClick={() => {
            setActivationBusy(true)
            setActivationError(undefined)
            void props.setActivation(app.id, app.activation === 'enabled' ? 'disabled' : 'enabled').then((ok) => {
              if (!ok) setActivationError(t('activation.failed'))
            }).finally(() => { setActivationBusy(false) })
          }}
        >
          {app.activation === 'enabled' ? t('activation.disable') : t('activation.enable')}
        </Button>
      </div>
      {activationError === undefined ? null : <p className={css.error} role="alert" data-manage-activation-error>{activationError}</p>}
      {app.failure !== undefined && <p className={css.error} role="alert">{app.failure}</p>}
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
        {modelError !== undefined && <p className={css.error} role="alert">{modelError}</p>}
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
          <p className={css.caption} data-model-usage>
            {t('model.usage', {
              calls: String(usage.calls),
              failed: String(usage.failed + usage.cancelled),
              tokens: String((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
              missing: String(usage.usageMissing),
            })}
          </p>
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
            {limitsError !== undefined && <p className={css.error} role="alert">{limitsError}</p>}
            <div className={css.developActions}>
              <Button data-limits-save variant="primary" disabled={limitsBusy} onClick={() => {
                setLimitsBusy(true)
                setLimitsError(undefined)
                void props.setModelLimits(app.id, limits).then((ok) => { if (!ok) setLimitsError(t('limits.saveFailed')) }).finally(() => { setLimitsBusy(false) })
              }}>{t('limits.save')}</Button>
            </div>
          </div>
        )}
        {credentials.length > 0 && (
          <div data-credentials>
            <p className={listCss.sectionTitle}>{t('credentials.title')}</p>
            {credentials.map(credential => (
              <div className={css.infoRow} key={credential.name} data-credential={credential.name}>
                <code className={listCss.code}>{credential.name}</code>
                <span data-credential-status>{credential.set ? t('credentials.set') : t('credentials.unset')}</span>
                <input
                  type="password"
                  aria-label={`${t('credentials.title')} · ${credential.name}`}
                  data-credential-input={credential.name}
                  value={credentialValues[credential.name] ?? ''}
                  onChange={(event) => { setCredentialValues({ ...credentialValues, [credential.name]: event.target.value }) }}
                />
                <Button data-credential-save={credential.name} disabled={credentialBusy !== undefined} onClick={() => {
                  const value = credentialValues[credential.name] ?? ''
                  if (value === '') return
                  setCredentialBusy(credential.name)
                  setCredentialError(undefined)
                  void props.setCredential(app.id, credential.name, value).then((ok) => {
                    if (!ok) { setCredentialError(t('credentials.saveFailed')); return }
                    setCredentialValues({ ...credentialValues, [credential.name]: '' })
                    setCredentials(current => current.map(entry => entry.name === credential.name ? { ...entry, set: true } : entry))
                  }).finally(() => { setCredentialBusy(undefined) })
                }}>{t('credentials.save')}</Button>
                {credential.set && (
                  <Button data-credential-delete={credential.name} disabled={credentialBusy !== undefined} onClick={() => {
                    setCredentialBusy(credential.name)
                    setCredentialError(undefined)
                    void props.deleteCredential(app.id, credential.name).then((ok) => {
                      if (!ok) { setCredentialError(t('credentials.deleteFailed')); return }
                      setCredentials(current => current.map(entry => entry.name === credential.name ? { ...entry, set: false } : entry))
                    }).finally(() => { setCredentialBusy(undefined) })
                  }}>{t('credentials.delete')}</Button>
                )}
              </div>
            ))}
            {credentialError !== undefined && <p className={css.error} role="alert">{credentialError}</p>}
          </div>
        )}
      </section>
      <p className={css.caption}>{app.description}</p>
      {app.pages !== undefined && app.pages.length > 0 && (
        <section data-manage-pages>
          <p className={listCss.sectionTitle}>{t('info.pages.title')}</p>
          <ul className={listCss.needList}>
            {app.pages.map(page => (
              <li className={listCss.need} key={page.view} data-app-page={page.view}>
                <div className={listCss.needHead}><span className={listCss.needName}>{page.view}</span></div>
                <p className={listCss.needPurpose}>{page.description}</p>
                <code>{page.actions.join(', ')}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
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
      {app.process !== undefined && app.process.length > 0 && (
        <section data-manage-process>
          <p className={listCss.sectionTitle}>{t('info.process.title')}</p>
          <ul className={listCss.needList}>
            {app.process.map(command => (
              <li className={listCss.need} key={command.name} data-process-command={command.name}>
                <div className={listCss.needHead}><span className={listCss.needName}>{command.name}</span></div>
                <p className={listCss.needPurpose}>{command.description}</p>
                {command.argv !== undefined && <code>{command.argv.join(' ')}</code>}
              </li>
            ))}
          </ul>
        </section>
      )}
      </>)}
      {section !== 'developer' && (<>
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
          {app.data.backup !== undefined && (
            <div className={css.infoRow}><dt>{t('info.data.declaredBackup')}</dt><dd>{app.data.backup}</dd></div>
          )}
          {(app.data.exportOp !== undefined || app.data.importOp !== undefined) && (
            <div className={css.infoRow}><dt>{t('info.data.declaredOps')}</dt><dd>{[app.data.exportOp, app.data.importOp].filter(Boolean).join(' / ') || '—'}</dd></div>
          )}
          {(app.data.secretFields?.length ?? 0) > 0 && (
            <div className={css.infoRow}><dt>{t('info.data.declaredSecrets')}</dt><dd>{app.data.secretFields!.join(', ')}</dd></div>
          )}
        </dl>
      )}
      {dataError !== undefined && (
        <p className={css.error} role="alert" data-manage-data-error>
          {dataError}
          <Button size="sm" variant="ghost" onClick={reloadData} data-manage-data-retry>{t('reads.retry')}</Button>
        </p>
      )}
      {data === undefined ? (dataError === undefined ? <p className={css.caption} data-manage-data-loading>{t('info.data.loading')}</p> : null) : (
        <div data-manage-data>
          <dl className={css.infoRows}>
            <div className={css.infoRow}><dt>{t('info.data.path')}</dt><dd><code>{data.path}</code></dd></div>
            <div className={css.infoRow}><dt>{t('info.data.size')}</dt><dd>{data.byteSize === undefined ? '—' : `${String(data.byteSize)} B`}</dd></div>
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
                        <span>{`${String(backup.byteSize)} B`}</span>
                        <code className={css.dataPath}>{backup.path}</code>
                        <button
                          type="button"
                          className={css.debugToggle}
                          data-manage-data-restore={backup.path}
                          disabled={restoreBusy}
                          onClick={() => { startRestore(backup) }}
                        >
                          {t('info.data.restore')}
                        </button>
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
          {restoreError !== undefined && <p className={css.error} role="alert" data-manage-data-restore-error>{restoreError}</p>}
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
                <button type="button" className={css.debugToggle} data-manage-data-restore-confirm disabled={restoreBusy} onClick={confirmRestore}>{t('info.data.restoreConfirm')}</button>
                <button type="button" className={css.debugToggle} data-manage-data-restore-cancel disabled={restoreBusy} onClick={cancelRestore}>{t('info.data.restoreCancel')}</button>
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
          <div data-manage-data-migrations>
            <p className={listCss.sectionTitle}>{t('info.data.migrations')}</p>
            {Object.keys(data.legacyImports).length === 0
              ? <p className={css.caption} data-manage-data-migrations-empty>{t('info.data.migrationsEmpty')}</p>
              : (
                  <ul className={css.dataList}>
                    {Object.entries(data.legacyImports).map(([key, when]) => (
                      <li key={key} className={css.dataItem} data-manage-data-migration={key}>
                        <span>{legacyLabel(key)}</span>
                        <span>{when}</span>
                      </li>
                    ))}
                  </ul>
                )}
            <p className={css.caption} data-manage-data-rollback>{t('info.data.rollbackNote')}</p>
          </div>
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
                <button
                  type="button" className={css.debugToggle}
                  data-manage-data-confirm
                  disabled={importPhase === 'committing'}
                  onClick={() => { confirmImport(importPreview, importText ?? '') }}
                >{importPhase === 'committing' ? t('info.data.importing') : t('info.data.confirm')}</button>
                <button
                  type="button" className={css.debugToggle}
                  data-manage-data-cancel
                  disabled={importPhase === 'committing'}
                  onClick={cancelImport}
                >{t('info.data.importCancel')}</button>
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
            {props.pruneBackups !== undefined && (pruneArmed ? (
              <span data-manage-data-prune-confirm>
                {t('info.data.pruneConfirm')}
                <button type="button" className={css.debugToggle} data-manage-data-prune-yes onClick={pruneBackups}>{t('info.data.pruneYes')}</button>
                <button type="button" className={css.debugToggle} data-manage-data-prune-cancel onClick={() => { setPruneArmed(false) }}>{t('info.data.pruneCancel')}</button>
              </span>
            ) : (
              <button type="button" className={css.debugToggle} data-manage-data-prune onClick={() => { setPruneArmed(true) }}>{t('info.data.prune')}</button>
            ))}
            {pruned !== undefined && (
              <span role="status" data-manage-data-pruned>{t('info.data.pruned', { count: String(pruned) })}</span>
            )}
          </div>
          </>)}
        </div>
      )}
      </>)}
      {section !== 'data' && (<>
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
      {(app.needs.some(need => need.startsWith('capability:')) || (app.process !== undefined && app.process.length > 0)) && (
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
            {(app.process ?? []).map(command => (
              <li className={listCss.need} key={`process:${command.name}`} data-process-summary={command.name}>
                <div className={listCss.needHead}><span className={listCss.needName}>{command.name}</span></div>
                <p className={listCss.needPurpose}>{command.description}</p>
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

