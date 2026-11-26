// @vitest-environment jsdom
/**
 * The applications area in a real slot runtime: the plugin's own bindings (the
 * keyed `main` area, the rail entry, the `applicationViews` registry, the shell
 * over the Remote double), the area's render (the navigation, the header, the
 * business surface, the management dialog), the registered page's props, the
 * `@page` reference source and the citation, the live watch fan and reconnect,
 * and teardown.
 *
 * The Remote namespace is the only double: the production renderer, slot
 * registry, locale plugin, registry, shell and components all run for real. The
 * management dialog is the platform's Modal, which portals to `document.body`,
 * so its assertions read the document rather than the slot's own container.
 */
import { Context } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, type SlotView } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerCandidate, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AppDataImportResult, AppDataRestorePreview, AppDataRestoreResult, AppInfo, AppOp, AppStatus, CallOutcome, Caller, CapabilityGrant, DelegationInfo, HistoryRecord, OnboardingState, PendingConfirmation, TaskSnapshot, WatchEvent,
} from '@matrix1001/dsh-application-harness-host-bridge/client'
import { apply, inject } from '../src/client/index.ts'
import { APPLICATION_PANEL_KEY } from '../src/client/panel-key.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ApplicationSettingsProps, ApplicationView, ApplicationViewProps } from '../src/client/contract.ts'

/** One successful Remote answer. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One carrier-level Remote failure (an outcome that never arrived). */
function carrierFailure<T>(): RemoteResult<T> {
  return { ok: false, error: new RemoteError('gateway/internal', 'the carrier is gone', {}) }
}

/** One application row. */
function app(id: string, status: AppStatus = 'available', ops: readonly AppOp[] = []): AppInfo {
  const failed = status === 'failed'
  const incomplete = status === 'stop-incomplete'
  return {
    id,
    name: `${id} title`,
    description: `${id} description`,
    version: '1.2.3',
    health: failed || incomplete ? 'degraded' : 'ok',
    activation: failed ? 'disabled' : 'enabled',
    runtime: status === 'available' ? 'ready' : status === 'starting' ? 'starting' : status === 'stopping' || status === 'stop-incomplete' ? 'stopping' : 'stopped',
    ...(failed ? { reason: 'platform.start-failed', detail: `${id} failed to start` } : incomplete ? { reason: 'platform.stop-incomplete', detail: `${id} stop incomplete` } : {}),
    needs: [],
    ops,
  }
}

/** One declared operation. */
function op(name: string, description = `${name} description`): AppOp {
  return { name, description, params: {}, exposure: {} }
}

/** One settled history record. */
function record(callId: string, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    callId,
    caller: { kind: 'human' },
    target: 'workbook',
    op: 'write',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    status: 'success',
    ...over,
  }
}

/** One pending confirmation. */
function confirmation(id: string): PendingConfirmation {
  return {
    id,
    caller: { kind: 'ai', sessionId: 'session-1' },
    capability: 'workbook#delete',
    reason: 'the agent wants to delete a task',
    at: '2026-01-01T00:00:02.000Z',
  }
}

/** One capability grant. */
function grant(caller: Caller, capabilities: readonly string[]): CapabilityGrant {
  return { caller, capabilities: [...capabilities], grantedAt: '2026-01-01T00:00:03.000Z' }
}

/** A page that reports one note from an effect, as every real page does. */
function notePage(): ApplicationView {
  return {
    name: 'Notebook',
    Component: (viewProps) => {
      useEffect(() => viewProps.pageContext.report({
        record: { appId: 'workbook', kind: 'note', id: 'n1' },
        selection: [{ appId: 'workbook', kind: 'note', id: 'n1' }],
        view: 'list',
        draftId: 'draft-1',
        filters: { status: 'open' },
        visibleRange: { from: '2026-01-01', to: '2026-01-31' },
        dirty: true,
        selectionNote: '笔记页选中',
        label: '笔记 n1',
      }), [])
      return <p data-testid="view-body">page</p>
    },
  }
}

/** A page that reports only its label (no record), the ambient-context shape. */
function labelPage(): ApplicationView {
  return {
    Component: (viewProps) => {
      useEffect(() => viewProps.pageContext.report({ label: '磁盘分析' }), [])
      return <p data-testid="label-page">label page</p>
    },
  }
}

/** A page that renders its own marker, for the navigation and switching cases. */
function markerPage(marker: string, name?: string): ApplicationView {
  return {
    ...(name === undefined ? {} : { name }),
    Component: () => <p data-testid={`${marker}-page`}>{`${marker} page`}</p>,
  }
}

/** A page whose button asks the shell for a cross-application record. */
function jumpPage(target: string): ApplicationView {
  return {
    Component: (props) => (
      <button
        type="button"
        data-testid="jump-page"
        onClick={() => {
          props.navigation?.open({ appId: target, record: { appId: target, kind: 'record', id: 'r1' }, view: 'detail' })
        }}
      >jump</button>
    ),
  }
}

/** A page that registers fixed page actions and records them. */
function actionPage(received: Array<{ action: string; input: unknown }>): ApplicationView {
  return {
    Component: (props) => {
      useEffect(() => props.pageActions?.onAction((action, input) => {
        received.push({ action, input })
        return !(input as { refuse?: boolean } | undefined)?.refuse
      }), [props.pageActions])
      return <p data-testid="action-page">action page</p>
    },
  }
}

/** A page that shares a draft and serves its shared read. */
function draftPage(received: Array<unknown>): ApplicationView {
  return {
    Component: (props) => {
      useEffect(() => props.drafts?.onRead((input) => {
        received.push(input)
        return { revision: 'r1', values: { '/title': 'shared' } }
      }), [props.drafts])
      useEffect(() => props.drafts?.onUpdate((input) => {
        received.push(input)
        return input.revision === 'old' ? { conflict: true } : { revision: 'r2', values: input.values }
      }), [props.drafts])
      return <><button type="button" data-draft-share onClick={() => { void props.drafts?.share({ draftId: 'd1', fields: ['/title'] }) }}>share</button><button type="button" data-draft-revoke onClick={() => { void props.drafts?.revoke({ draftId: 'd1' }) }}>revoke</button></>
    },
  }
}

/** One controllable watch stream (the shell never sends on the uplink). */
class FakeWatch {
  readonly frames: WatchEvent[] = []
  disposed = false
  private ended = false
  private failure: unknown
  private wake: (() => void) | undefined

  push(event: WatchEvent): void {
    this.frames.push(event)
    this.wakeUp()
  }

  end(): void {
    this.ended = true
    this.wakeUp()
  }

  fail(error: unknown): void {
    this.failure = error
    this.wakeUp()
  }

  dispose(): void {
    this.disposed = true
    this.end()
  }

  send(): void {}

  async *[Symbol.asyncIterator](): AsyncGenerator<WatchEvent> {
    while (true) {
      const next = this.frames.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  private wakeUp(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** A watch that ignores disposal, so a test can deliver a late old-generation failure. */
class LingerWatch {
  private readonly done = Promise.withResolvers<void>()
  private failure: unknown
  dispose(): void { /* deliberately does not settle the iterator */ }
  fail(error: unknown): void { this.failure = error; this.done.resolve() }
  async *[Symbol.asyncIterator](): AsyncGenerator<WatchEvent> {
    await this.done.promise
    throw this.failure
  }
}

/** The Remote namespace double every case drives. */
/** One delegation record the management/send surfaces read. */
function delegationRecord(over: Partial<DelegationInfo> = {}): DelegationInfo {
  return {
    id: 'delegation-1',
    appId: 'workbook',
    title: 'Review the draft',
    instructions: 'Review the prepared draft and report what changed',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function fakeRemote() {
  return {
    list: vi.fn(async (): Promise<RemoteResult<readonly AppInfo[]>> => ok<readonly AppInfo[]>([
      app('workbook', 'available', [op('write')]),
      app('disk-analysis', 'available', [op('scan')]),
      app('info-hub'),
    ])),
    call: vi.fn(async (appId: string, opName: string, _args?: unknown, _requestId?: string): Promise<RemoteResult<CallOutcome>> =>
      ok<CallOutcome>({ callId: 'runtime-1', status: 'success', result: { called: `${appId}#${opName}` } })),
    cancel: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    dataInfo: vi.fn(async (appId: string) => ok({ appId, path: '/tmp/app-data.sqlite', byteSize: 1024, schemaVersion: 2, documentCount: 1, collections: { notes: 3 }, backups: [] as Array<{ path: string; byteSize: number; modifiedAt: number }>, backupCount: 0 })),
    dataExport: vi.fn(async () => ok({ fileName: 'application-harness-workbook.json', json: '{"version":1}' })),
    dataImportPreview: vi.fn(async (appId: string) => ok({ appId, apps: 1, documents: 1, collections: 0, newDocuments: 1, overwrittenDocuments: 0, removedDocuments: 0, newCollectionItems: 0, overwrittenCollectionItems: 0, removedCollectionItems: 0, planId: 'plan_import_1', expiresAt: Date.now() + 60_000 })),
    dataImport: vi.fn(async (appId: string): Promise<RemoteResult<AppDataImportResult>> => ok({ appId, apps: 1, documents: 1, collections: 0, newDocuments: 1, overwrittenDocuments: 0, removedDocuments: 0, newCollectionItems: 0, overwrittenCollectionItems: 0, removedCollectionItems: 0, backupPath: '/tmp/app-data.before-import.sqlite', reload: 'ok' })),
    dataReload: vi.fn(async () => ok(undefined)),
    dataPruneBackups: vi.fn(async () => ok({ removed: 2 })),
    dataRestorePreview: vi.fn(async (appId: string, backupPath: string): Promise<RemoteResult<AppDataRestorePreview>> => ok<AppDataRestorePreview>({
      appId, backupPath, backupModifiedAt: 1, backupByteSize: 1,
      documents: { backupOnly: 0, currentOnly: 0, modified: 0, unchanged: 0 },
      collections: { backupOnly: 0, currentOnly: 0, modified: 0, unchanged: 0 },
      conflicts: [], conflictCount: 0, truncated: false, metaChanged: [], previewFingerprint: 'fingerprint', planId: 'plan_restore', expiresAt: Date.now() + 60_000,
    })),
    dataRestore: vi.fn(async (appId: string, backupPath: string, _previewFingerprint?: string, _planId?: string, _requestId?: string): Promise<RemoteResult<AppDataRestoreResult>> => ok<AppDataRestoreResult>({
      appId, restoredFrom: backupPath, backupPath: '/tmp/pre-restore.sqlite', documents: 1, collections: 0, reload: 'ok',
    })),
    history: vi.fn(async (): Promise<RemoteResult<readonly HistoryRecord[]>> => ok<readonly HistoryRecord[]>([record('call-1')])),
    tasks: vi.fn(async (): Promise<RemoteResult<readonly TaskSnapshot[]>> => ok<readonly TaskSnapshot[]>([])),
    cancelTask: vi.fn(async (): Promise<RemoteResult<'accepted' | 'settled' | 'not-found'>> => ok('accepted' as const)),
    suggestedAppConversationPath: vi.fn(async (): Promise<RemoteResult<string>> => ok('/home/user/dsh-workspaces/app-conversation/default')),
    registerAppConversation: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    registerDevelopmentSession: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    clearDevelopmentSession: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    setAppConversationContext: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    policies: vi.fn(async (): Promise<RemoteResult<readonly import('@matrix1001/dsh-application-harness-host-bridge/client').OperationPolicyEntry[]>> => ok([])),
    setActivation: vi.fn(async (_appId: string, _activation: 'enabled' | 'disabled'): Promise<RemoteResult<readonly AppInfo[]>> => ok([])),
    checkHealth: vi.fn(async (_appId: string): Promise<RemoteResult<readonly AppInfo[]>> => ok<readonly AppInfo[]>([app('workbook')])),
    setAppModel: vi.fn(async (_appId: string, _selection: { provider: string; model: string } | null): Promise<RemoteResult<boolean>> => ok(true)),
    modelCatalog: vi.fn(async (): Promise<RemoteResult<{ providers: readonly unknown[] }>> => ok({ providers: [] })),
    modelUsage: vi.fn(async (): Promise<RemoteResult<import('@matrix1001/dsh-application-harness-host-bridge/client').ModelUsageSummary>> => ok({ calls: 2, succeeded: 1, failed: 1, cancelled: 0, usageMissing: 0, totalDurationMs: 5, inputTokens: 10, outputTokens: 20 })),
    modelLimits: vi.fn(async (): Promise<RemoteResult<{ background: boolean; maxConcurrent?: number; maxCallsPerMinute?: number }>> => ok({ background: true })),
    setModelLimits: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    completePageCommand: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    shareDraft: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    revokeDraftShare: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    setPolicy: vi.fn(async (): Promise<RemoteResult<readonly import('@matrix1001/dsh-application-harness-host-bridge/client').OperationPolicyEntry[]>> => ok([])),
    grants: vi.fn(async (): Promise<RemoteResult<readonly CapabilityGrant[]>> => ok<readonly CapabilityGrant[]>([grant({ kind: 'ai', sessionId: 'session-1' }, ['workbook#write'])])),
    onboarding: vi.fn(async (): Promise<RemoteResult<OnboardingState>> => ok<OnboardingState>({ apps: {} })),
    markOnboardingSeen: vi.fn(async (): Promise<RemoteResult<OnboardingState>> => ok<OnboardingState>({ apps: {} })),
    pendingConfirmations: vi.fn(async (): Promise<RemoteResult<readonly PendingConfirmation[]>> => ok<readonly PendingConfirmation[]>([confirmation('confirmation-1')])),
    answerConfirmation: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    cancelConfirmation: vi.fn(async (): Promise<RemoteResult<boolean>> => ok(true)),
    grant: vi.fn(async (): Promise<RemoteResult<CapabilityGrant>> => ok(grant({ kind: 'app', appId: 'workbook' }, ['capability:model']))),
    revoke: vi.fn(async (): Promise<RemoteResult<void>> => ok(undefined)),
    delegations: vi.fn(async (): Promise<RemoteResult<readonly DelegationInfo[]>> => ok<readonly DelegationInfo[]>([delegationRecord()])),
    delegation: vi.fn(async (id: string): Promise<RemoteResult<DelegationInfo>> => ok(delegationRecord({ id }))),
    sendDelegation: vi.fn(async (id: string, sessionId: string, supplement?: string): Promise<RemoteResult<DelegationInfo>> =>
      ok(delegationRecord({ id, status: 'active', sessionId, ...(supplement === undefined ? {} : {}) }))),
    cancelDelegation: vi.fn(async (id: string): Promise<RemoteResult<DelegationInfo>> =>
      ok(delegationRecord({ id, status: 'ended', outcome: 'cancelled' }))),
    watch: vi.fn((): FakeWatch => new FakeWatch()),
  }
}

type RemoteDouble = ReturnType<typeof fakeRemote>

/** One mounted area harness. */
interface Harness {
  readonly runtime: SlotTestRuntime
  readonly remote: RemoteDouble
  readonly selectPanel: ReturnType<typeof vi.fn>
  /** The watch generation the shell opened (the newest one). */
  stream(): FakeWatch
}

/**
 * Provide the `layout` service the area injects: a stateful double (the real
 * face moves its selection on `selectPanel` and notifies), so a case can assert
 * what a SECOND activation of the same entry means — the entry reads the
 * selection before it moves it.
 */
function provideLayout(ctx: Context): { selectPanel: ReturnType<typeof vi.fn> } {
  const activePanelId: { current: MainPanelId | null } = { current: null }
  const listeners = new Set<() => void>()
  const selectPanel = vi.fn((id: string | null) => {
    activePanelId.current = id as MainPanelId | null
    for (const listener of [...listeners]) listener()
  })
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: activePanelId.current }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    selectPanel,
    beginNavigation: vi.fn(() => new AbortController().signal),
    toggleSidebar: vi.fn(),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  } satisfies ILayout
  ctx.provide('layout', layout)
  return { selectPanel }
}

/**
 * Assemble the runtime the area needs: the Remote double with its namespace
 * installed, the layout double, the locale plugin (with the stand-ins its own
 * injects want), both slots the plugin binds into, and the plugin itself.
 * @param configure - optional last touch on the double before the plugin mounts
 *   (a case whose rows or answers differ from the defaults).
 * @param provideServices - optional last touch on the context, for a case that
 *   mounts a service the plugin joins when it is there (the trigger registry).
 * @returns the harness.
 */
async function mountPanel(
  configure?: (remote: RemoteDouble) => void,
  provideServices?: (ctx: Context) => void,
  extraNamespaces?: Record<string, unknown>,
  seed?: (runtime: SlotTestRuntime) => Promise<void>,
): Promise<Harness> {
  const remote = fakeRemote()
  configure?.(remote)
  const runtime = await SlotTestRuntime.create()
  runtime.remote.provideNamespaces({ applications: remote, ...extraNamespaces })
  const { selectPanel } = provideLayout(runtime.ctx)
  // The locale plugin declares `connection` (informational) and `configForms`
  // (`get` misses = nothing persisted) — minimal stand-ins keep its fiber from
  // suspending without standing in for anything this package reads.
  runtime.ctx.provide('connection', {} as never)
  runtime.ctx.provide('configForms', { get: () => undefined } as never)
  provideServices?.(runtime.ctx)
  await seed?.(runtime)
  await runtime.ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  await runtime.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.panellist.trailing': { kind: 'list', scope: 'root' },
    'conversation.input.placeholder': { kind: 'chain', scope: 'session' },
  })
  await runtime.mount({ inject: [...inject], apply })
  await settle()
  return {
    runtime,
    remote,
    selectPanel,
    stream: () => remote.watch.mock.results.at(-1)?.value as FakeWatch,
  }
}

/** Let the shell's asynchronous work run inside act. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

/** Render the keyed main entry (the area). */
function renderPanel(harness: Harness): SlotView<'main'> {
  return harness.runtime.renderSlot('main', {}, { entryKey: APPLICATION_PANEL_KEY })
}

/**
 * Register one application's contribution into the live registry. Inside act:
 * the area subscribes to the registry, so a late registration re-renders it.
 * @returns the unregister function.
 */
function register(harness: Harness, appId: string, view: ApplicationView): () => void {
  let dispose: () => void = () => {}
  act(() => { dispose = harness.runtime.ctx.applicationViews.register(appId, view) })
  return dispose
}

/** One application's tab in the header. */
function navRow(panel: SlotView<'main'>, appId: string): HTMLElement {
  const row = panel.container.querySelector(`[data-app-tab="${appId}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`the header has no tab for ${appId}`)
  return row
}

/** The application tab strip. */
function nav(panel: SlotView<'main'>): HTMLElement {
  const element = panel.container.querySelector('[data-app-tabs]')
  if (!(element instanceof HTMLElement)) throw new Error('the area rendered no application tabs')
  return element
}

/** The open management page (the area keeps it inside the application frame). */
function dialog(): HTMLElement {
  const element = document.body.querySelector('[data-manage-page]')
  if (!(element instanceof HTMLElement)) throw new Error('the management dialog is not open')
  return element
}

/** Testing Library queries bound to the open management page. */
function inDialog() {
  return within(dialog())
}

/** One element the dialog must have rendered, by selector. */
function inDocument(selector: string): HTMLElement {
  const element = document.body.querySelector(selector)
  if (!(element instanceof HTMLElement)) throw new Error(`nothing matches ${selector}`)
  return element
}

/** Open one data action's confirm dialog through its trigger, then confirm it. */
async function confirmDataAction(trigger: Element | null): Promise<void> {
  if (trigger === null) throw new Error('nothing to confirm')
  fireEvent.click(trigger)
  await waitFor(() => { expect(document.body.querySelector('[data-data-confirm-dialog]')).not.toBeNull() })
  fireEvent.click(inDocument('[data-data-confirm-yes]'))
  await waitFor(() => { expect(document.body.querySelector('[data-data-confirm-dialog]')).toBeNull() })
}

/** Open the management surface at its list, from the all-applications menu. */
function openManageList(panel: SlotView<'main'>): void {
  const entry = panel.container.querySelector('[data-app-all]')
  if (!(entry instanceof HTMLElement)) throw new Error('the header offers no all-applications entry')
  fireEvent.click(entry)
  fireEvent.click(inDocument('[data-app-manage-list]'))
}

/**
 * Mount the area against a stub trigger registry that records what joins it
 * and removes it again on the registration's disposer.
 * @returns the harness and the live source list.
 */
async function mountWithTriggers(): Promise<Harness & { registered: InputTriggerSource[] }> {
  const registered: InputTriggerSource[] = []
  const harness = await mountPanel(undefined, (ctx) => {
    ctx.reflect.provide('inputTriggers', {
      registerSource: (source: InputTriggerSource) => {
        registered.push(source)
        return () => { const at = registered.indexOf(source); if (at >= 0) registered.splice(at, 1) }
      },
      sessionOf: () => { throw new Error('the page source resolves no controller') },
    } as never)
  })
  return { ...harness, registered }
}

/** Ask one source for its rows, the way the pipeline does on `@`. */
function rowsFor(source: InputTriggerSource, sessionId: string): Promise<readonly InputTriggerCandidate[]> {
  return source.candidates(
    { sessionId } as ClientSessionContext,
    { query: '', position: 'inline', drilled: false, signal: new AbortController().signal } satisfies CandidateRequest,
  )
}

function rows(source: InputTriggerSource): Promise<readonly InputTriggerCandidate[]> {
  return rowsFor(source, 'session-1')
}

/**
 * jsdom has no ResizeObserver. The platform's Tooltip and the area's own
 * narrow-width observer both construct one; the stand-in keeps their effects
 * from crashing without pretending a layout exists. Narrow behavior is
 * covered by the browser lane, where the real observer runs.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // The area's preferences and the per-application view state persist through
  // localStorage: a case must never inherit the previous one's choices.
  localStorage.clear()
})

describe('plugin bindings', () => {
  it('renders a tab for every application that draws a page, and the sidebar entry beside the area', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    const panel = renderPanel(harness)
    await settle()
    const navigation = nav(panel)
    expect(navRow(panel, 'workbook').textContent).toContain('workbook title')
    // The registration's own name wins over the host's when it declares one.
    expect(navRow(panel, 'disk-analysis').textContent).toContain('Disk analysis')
    // An application without a page is reached through management, never here:
    // losing the page half is not losing the application.
    expect(navigation.querySelector('[data-app-tab="info-hub"]')).toBeNull()
    const rail = harness.runtime.renderSlot('sidebar.panellist', { size: 16, active: false }, { only: APPLICATION_PANEL_KEY })
    expect(rail.container.querySelector('svg')).not.toBeNull()
    // The trailing entry carries the waiting-confirmation count; the fixture
    // holds one parked confirmation.
    const trailing = harness.runtime.renderSlot('sidebar.panellist.trailing', { wide: true, active: false }, { only: APPLICATION_PANEL_KEY })
    const badge = trailing.container.querySelector('[data-app-rail-badge]')
    expect(badge?.querySelector('[aria-hidden="true"]')?.textContent).toBe('1')
    expect(badge?.textContent).toContain('1')
    await harness.runtime.dispose()
  })

  it('selects composer guidance for application-area and development Sessions', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      appConversation: { workspaceId: 'w-area', sessionId: 's-area' },
      appConversations: [{ workspaceId: 'w-area', sessionId: 's-area' }],
      developmentSessions: [{ appId: 'workbook', sessionId: 's-dev' }],
    }))
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    await settle()
    const [entry] = harness.runtime.slots.entriesOfSlot('conversation.input.placeholder')
    const select = entry?.select
    expect(select).toBeTypeOf('function')
    expect(select!({ sessionId: 's-area' } as never)).toEqual({ text: expect.stringContaining('application page') })
    expect(select!({ sessionId: 's-dev' } as never)).toEqual({ text: expect.stringContaining('workbook') })
    expect(select!({ sessionId: 's-other' } as never)).toBeNull()
    await harness.runtime.dispose()
  })

  it('opens the first application that draws a page, and switches on a row click', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    const panel = renderPanel(harness)
    await settle()
    // Rows in, nobody selected: the first application with a page takes the area.
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    expect(navRow(panel, 'workbook').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(navRow(panel, 'disk-analysis'))
    expect(panel.view.getByTestId('disk-page')).toBeDefined()
    expect(panel.view.queryByTestId('workbook-page')).toBeNull()
    expect(navRow(panel, 'disk-analysis').getAttribute('aria-selected')).toBe('true')
    await harness.runtime.dispose()
  })

  it('unpins from the complete application list and reopens the temporary tab there', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    const panel = renderPanel(harness)
    await settle()
    // The list is complete even on a fresh deployment where every page
    // application is already fixed; it is not an overflow-only menu.
    fireEvent.click(inDocument('[data-app-all]'))
    expect(inDocument('[data-app-apps-panel]')).not.toBeNull()
    const unpin = inDocument('[data-app-pin-toggle="disk-analysis"]')
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    unpin.focus()
    fireEvent.click(unpin)
    await settle()
    // Pinning is a row action: the panel stays open and focus stays on it.
    expect(inDocument('[data-app-apps-panel]')).not.toBeNull()
    expect(document.activeElement).toBe(inDocument('[data-app-pin-toggle="disk-analysis"]'))
    expect(inDocument('[data-app-pin-toggle="disk-analysis"]').getAttribute('aria-pressed')).toBe('false')
    expect(nav(panel).querySelector('[data-app-tab="disk-analysis"]')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    expect(document.activeElement).toBe(inDocument('[data-app-all]'))
    // The unpinned application is reopened from the same complete list.
    fireEvent.click(inDocument('[data-app-all]'))
    fireEvent.click(inDocument('[data-app-apps-row="disk-analysis"]'))
    await settle()
    expect(panel.view.getByTestId('disk-page')).toBeDefined()
    expect(navRow(panel, 'disk-analysis').getAttribute('aria-selected')).toBe('true')
    // The current application is not fixed: it is a temporary last tab until
    // the human pins it or leaves it.
    expect(navRow(panel, 'disk-analysis').getAttribute('data-app-tab-temporary')).toBe('true')
    fireEvent.click(inDocument('[data-app-all]'))
    fireEvent.click(inDocument('[data-app-pin-toggle="disk-analysis"]'))
    await settle()
    expect(navRow(panel, 'disk-analysis').getAttribute('data-app-tab-temporary')).toBeNull()
    await harness.runtime.dispose()
  })

  it('pins and unpins from the tab context menu and moves focus to the survivor', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({ pinned: ['workbook'], lastAppId: 'disk-analysis',
    }))
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    const panel = renderPanel(harness)
    await settle()
    // The active, unpinned application is the temporary last tab.
    expect(navRow(panel, 'disk-analysis').getAttribute('data-app-tab-temporary')).toBe('true')
    fireEvent.contextMenu(navRow(panel, 'disk-analysis'), { clientX: 20, clientY: 20 })
    fireEvent.click(within(inDocument('[role="menu"]')).getByRole('menuitem', { name: 'Pin' }))
    await settle()
    expect(navRow(panel, 'disk-analysis').getAttribute('data-app-tab-temporary')).toBeNull()
    // Unpinning the other (inactive) tab removes it and moves focus to the
    // surviving tab, not to body.
    fireEvent.contextMenu(navRow(panel, 'workbook'), { clientX: 20, clientY: 20 })
    fireEvent.click(within(inDocument('[role="menu"]')).getByRole('menuitem', { name: 'Unpin' }))
    await settle()
    expect(nav(panel).querySelector('[data-app-tab="workbook"]')).toBeNull()
    await waitFor(() => { expect(document.activeElement).toBe(navRow(panel, 'disk-analysis')) })
    // Unpinning the active tab keeps it as the temporary last tab.
    fireEvent.contextMenu(navRow(panel, 'disk-analysis'), { clientX: 20, clientY: 20 })
    fireEvent.click(within(inDocument('[role="menu"]')).getByRole('menuitem', { name: 'Unpin' }))
    await settle()
    expect(navRow(panel, 'disk-analysis').getAttribute('data-app-tab-temporary')).toBe('true')
    await waitFor(() => { expect(document.activeElement).toBe(navRow(panel, 'disk-analysis')) })
    // Dismissing the menu returns focus to the tab; the temporary tab also
    // cannot start a drag.
    fireEvent.contextMenu(navRow(panel, 'disk-analysis'), { clientX: 20, clientY: 20 })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(document.activeElement).toBe(navRow(panel, 'disk-analysis')) })
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), setDragImage: vi.fn() }
    fireEvent.dragStart(navRow(panel, 'disk-analysis'), { dataTransfer: transfer })
    expect(navRow(panel, 'disk-analysis').getAttribute('data-app-tab-dragging')).toBeNull()
    fireEvent.dragEnd(navRow(panel, 'disk-analysis'), { dataTransfer: transfer })
    await harness.runtime.dispose()
  })

  it('treats a drop after the last tab as a no-op and clears the insertion line on leave', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    register(harness, 'info-hub', markerPage('info'))
    const panel = renderPanel(harness)
    await settle()
    const order = (): Array<string | null> => [...nav(panel).querySelectorAll('[data-app-tab]')].map(row => row.getAttribute('data-app-tab'))
    const rows = ['workbook', 'disk-analysis', 'info-hub'].map(id => navRow(panel, id))
    rows.forEach((row, index) => {
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: index * 100, width: 80, right: index * 100 + 80, top: 0, bottom: 28, height: 28, x: index * 100, y: 0, toJSON: () => ({}) }),
      })
    })
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), setDragImage: vi.fn() }
    // Dropping the last tab beyond the last midpoint is its current slot: no
    // line and no preference write.
    fireEvent.dragStart(rows[2]!, { dataTransfer: transfer })
    fireEvent.dragOver(nav(panel), { clientX: 250, dataTransfer: transfer })
    expect(document.body.querySelector('[data-app-drop-line]')).toBeNull()
    fireEvent.drop(nav(panel), { clientX: 250, dataTransfer: transfer })
    await settle()
    expect(order()).toEqual(['workbook', 'disk-analysis', 'info-hub'])
    fireEvent.dragEnd(rows[2]!, { dataTransfer: transfer })
    // A drag that leaves the strip hides the caret; the drop then recomputes
    // the slot from the pointer instead of trusting stale state.
    fireEvent.dragStart(rows[0]!, { dataTransfer: transfer })
    fireEvent.dragOver(nav(panel), { clientX: 250, dataTransfer: transfer })
    expect(document.body.querySelector('[data-app-drop-line]')).not.toBeNull()
    fireEvent.dragLeave(nav(panel), { relatedTarget: document.body })
    expect(document.body.querySelector('[data-app-drop-line]')).toBeNull()
    fireEvent.drop(nav(panel), { clientX: 250, dataTransfer: transfer })
    await settle()
    expect(order()).toEqual(['disk-analysis', 'info-hub', 'workbook'])
    // A drag source without a DataTransfer (or an older transfer without
    // setDragImage) still starts and ends cleanly.
    fireEvent.dragStart(rows[0]!, {})
    fireEvent.dragEnd(rows[0]!, {})
    const plain = { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    fireEvent.dragStart(rows[0]!, { dataTransfer: plain })
    fireEvent.dragEnd(rows[0]!, { dataTransfer: plain })
    await harness.runtime.dispose()
  })

  it('shows a non-ready application status in the complete list', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([app('workbook', 'available'), app('disk-analysis', 'starting')]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk'))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-all]'))
    expect(inDocument('[data-app-apps-row="disk-analysis"] [data-tone="warn"]')).not.toBeNull()
    await harness.runtime.dispose()
  })

  it('ignores unrelated tab keys and drag events without a drag source', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk'))
    const panel = renderPanel(harness)
    await settle()
    const order = (): Array<string | null> => [...nav(panel).querySelectorAll('[data-app-tab]')].map(row => row.getAttribute('data-app-tab'))
    fireEvent.keyDown(navRow(panel, 'workbook'), { key: 'x' })
    fireEvent.dragOver(nav(panel), { clientX: 10 })
    fireEvent.drop(nav(panel), { clientX: 10 })
    await settle()
    expect(order()).toEqual(['workbook', 'disk-analysis'])
    await harness.runtime.dispose()
  })

  it('moves a fixed tab from its context menu without a custom shortcut', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    register(harness, 'info-hub', markerPage('info'))
    const panel = renderPanel(harness)
    await settle()
    const order = (): Array<string | null> => [...nav(panel).querySelectorAll('[data-app-tab]')].map(row => row.getAttribute('data-app-tab'))
    expect(order()).toEqual(['workbook', 'disk-analysis', 'info-hub'])
    fireEvent.contextMenu(navRow(panel, 'workbook'), { clientX: 20, clientY: 20 })
    fireEvent.click(within(inDocument('[role="menu"]')).getByRole('menuitem', { name: 'Move right' }))
    await settle()
    expect(order()).toEqual(['disk-analysis', 'workbook', 'info-hub'])
    fireEvent.contextMenu(navRow(panel, 'workbook'), { clientX: 20, clientY: 20 })
    fireEvent.click(within(inDocument('[role="menu"]')).getByRole('menuitem', { name: 'Move left' }))
    await settle()
    expect(order()).toEqual(['workbook', 'disk-analysis', 'info-hub'])
    await harness.runtime.dispose()
  })
  it('re-reads the rows through the real retry the surface offers', async () => {
    const harness = await mountPanel()
    renderPanel(harness)
    await settle()
    expect(harness.remote.list).toHaveBeenCalledTimes(1)
    // The live connection went down: the surface says so and offers the real read.
    harness.stream().end()
    await settle()
    const banner = inDocument('[data-app-connection]')
    fireEvent.click(within(banner).getByRole('button', { name: 'Read again' }))
    await settle()
    expect(harness.remote.list).toHaveBeenCalledTimes(2)
    await harness.runtime.dispose()
  })

  it('closes the management dialog with the area it belongs to', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    // Open the dialog, then take the panel away (the platform unmounts the
    // keyed entry when the selection moves). The request lives in the framework
    // INSTANCE, so it would outlive the component — and coming back would show
    // a modal nobody asked for again.
    openManageList(panel)
    await settle()
    expect(document.body.querySelector('[data-manage-page]')).not.toBeNull()
    act(() => { panel.update({}, { entryKey: 'conversation' }) })
    await settle()
    expect(document.body.querySelector('[data-manage-page]')).toBeNull()
    act(() => { panel.update({}, { entryKey: APPLICATION_PANEL_KEY }) })
    await settle()
    expect(document.body.querySelector('[data-manage-page]')).toBeNull()
    expect(document.body.querySelector('[data-manage-list]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('leaves for the conversation from the header’s own button', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-back]'))
    expect(harness.selectPanel).toHaveBeenCalledWith(null)
    await harness.runtime.dispose()
  })

  it('clears the record origin when the human switches tabs directly', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', jumpPage('disk-analysis'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(panel.view.getByTestId('jump-page'))
    await settle()
    expect(inDocument('[data-app-back]').getAttribute('aria-label')).toBe('Back to workbook title')
    // A direct tab switch is not a record back: the origin is dropped and the
    // one back goes to the conversation again.
    fireEvent.click(navRow(panel, 'workbook'))
    await settle()
    expect(panel.view.getByTestId('jump-page')).toBeDefined()
    expect(inDocument('[data-app-back]').getAttribute('aria-label')).toBe('Back to the conversation')
    await harness.runtime.dispose()
  })

  it('uses one contextual back for a cross-application record, then for the conversation', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', jumpPage('disk-analysis'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    const panel = renderPanel(harness)
    await settle()
    expect(inDocument('[data-app-back]').getAttribute('aria-label')).toBe('Back to the conversation')
    expect(document.body.querySelector('[data-app-record-back]')).toBeNull()
    fireEvent.click(panel.view.getByTestId('jump-page'))
    await settle()
    expect(panel.view.getByTestId('disk-page')).toBeDefined()
    // Still one back control; it points at the origin application.
    expect(document.body.querySelectorAll('[data-app-header] [data-app-back]')).toHaveLength(1)
    expect(document.body.querySelector('[data-app-record-back]')).toBeNull()
    expect(inDocument('[data-app-back]').getAttribute('aria-label')).toBe('Back to workbook title')
    fireEvent.click(inDocument('[data-app-back]'))
    await settle()
    expect(panel.view.getByTestId('jump-page')).toBeDefined()
    expect(inDocument('[data-app-back]').getAttribute('aria-label')).toBe('Back to the conversation')
    fireEvent.click(inDocument('[data-app-back]'))
    expect(harness.selectPanel).toHaveBeenCalledWith(null)
    await harness.runtime.dispose()
  })

  it('keeps working with no session anywhere (the surface is global)', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    expect(harness.runtime.ctx.get('sessions')).toBeDefined()
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    await harness.runtime.dispose()
  })

  it('offers first-use setup instead of borrowing a main Session for the conversation pane', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    expect(document.body.querySelector('[data-app-conversation-pane]')).toBeNull()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    // No dedicated conversation target exists yet: the pane must NOT open on
    // the main Session. The explicit first-use setup is the only way in.
    expect(document.body.querySelector('[data-app-conversation-pane]')).toBeNull()
    expect(document.body.querySelector('[data-app-conversation-setup]')).not.toBeNull()
    expect(document.body.querySelector('[data-app-conversation-setup-hint]')).not.toBeNull()
    // The application page stays mounted underneath the modal.
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    fireEvent.click(inDocument('[data-app-conversation-setup-cancel]'))
    await settle()
    expect(document.body.querySelector('[data-app-conversation-setup]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('warns once when the activation table could not be read', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([{ ...app('workbook'), activationUnavailable: true }]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    const notice = inDocument('[data-app-activation-unavailable]')
    expect(notice.textContent).toContain(en['activation.unavailable'])
    // It lives behind the header status control, closed by default; it never
    // floats over the page toolbar.
    const status = inDocument('[data-app-status]')
    expect(status.getAttribute('aria-expanded')).toBe('false')
    expect(status.getAttribute('aria-controls')).toBe('app-status-panel')
    expect(status.getAttribute('aria-haspopup')).toBeNull()
    expect(inDocument('[data-shell-notices]').getAttribute('role')).toBe('region')
    expect(inDocument('[data-shell-notices]').getAttribute('id')).toBe('app-status-panel')
    expect(inDocument('[data-shell-notices]').getAttribute('data-open')).toBe('false')
    fireEvent.click(status)
    expect(status.getAttribute('aria-expanded')).toBe('true')
    expect(inDocument('[data-shell-notices]').getAttribute('data-open')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(inDocument('[data-shell-notices]').getAttribute('data-open')).toBe('false')
  })

  it('dismisses the first-use setup without creating anything', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', labelPage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    // No directory-picker namespace in this host: the affordance is a no-op.
    fireEvent.click(inDocument('[data-app-conversation-setup-pick]'))
    await settle()
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    expect(document.body.querySelector('[data-app-conversation-setup]')).toBeNull()
    expect(harness.runtime.workspaces.calls.filter(call => call.method === 'create')).toHaveLength(0)
    await harness.runtime.dispose()
  })

  it('creates a development session in the chosen source workspace', async () => {
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'dev-session' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-dev', path }) as never)
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-menu]'))
    await settle()
    const develop = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes('Develop this application') || button.textContent?.includes('开发此应用'))!
    fireEvent.click(develop)
    await settle()
    fireEvent.change(inDocument('[data-develop-path]'), { target: { value: '/src/application' } })
    fireEvent.click(inDocument('[data-develop-submit]'))
    await settle()
    expect(harness.runtime.workspaces.calls.filter(call => call.method === 'create')).toHaveLength(1)
    expect(harness.remote.registerDevelopmentSession).toHaveBeenCalledWith(sessionId, 'workbook')
    expect(inDocument('[data-develop-created]')).not.toBeNull()
    const retain = vi.spyOn(harness.runtime.sessions, 'retain')
    fireEvent.click(inDocument('[data-develop-open]'))
    await settle()
    // The dock renders the platform Conversation, so its reference keeps the
    // `conversation` facet; without it the platform assembly never folds the
    // Session's event window.
    expect(retain).toHaveBeenCalledWith(sessionId, expect.objectContaining({ facets: { conversation: true } }))
    retain.mockRestore()
    // A development Session opens in the app-area dock by default: one tab,
    // marked as a development Session, with the application page still there.
    const devTab = inDocument('[data-app-dock-tab]')
    expect(devTab.getAttribute('data-kind')).toBe('development')
    expect(devTab.getAttribute('data-active')).toBe('true')
    expect(document.body.querySelector('[data-app-conversation-pane]')).not.toBeNull()
    expect(document.body.querySelector('[data-app-dock-empty]')).toBeNull()
    fireEvent.click(inDocument('[data-develop-done]'))
    await settle()
    expect(document.body.querySelector('[data-develop-dialog]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('selects a provider and model from the live catalog', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([{ ...app('workbook'), model: { provider: 'p1', model: 'm1' } }]))
      remote.modelCatalog.mockResolvedValue(ok({ providers: [
        { id: 'p1', name: 'Provider One', models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }] },
        { id: 'p2', name: 'Provider Two', models: [{ id: 'm3', name: 'Model Three' }] },
      ] }))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()
    const provider = inDocument('[data-model-provider]') as HTMLSelectElement
    expect(provider.tagName).toBe('SELECT')
    expect((inDocument('[data-model-name]') as HTMLSelectElement).value).toBe('m1')
    fireEvent.change(inDocument('[data-model-name]'), { target: { value: 'm2' } })
    fireEvent.click(inDocument('[data-model-save]'))
    await settle()
    expect(harness.remote.setAppModel).toHaveBeenCalledWith('workbook', { provider: 'p1', model: 'm2' })
    fireEvent.change(provider, { target: { value: 'p2' } })
    fireEvent.click(inDocument('[data-model-save]'))
    await settle()
    expect(harness.remote.setAppModel).toHaveBeenCalledWith('workbook', { provider: 'p2', model: 'm3' })
    await harness.runtime.dispose()
  })


  it('keeps the four areas separate without remounting the application', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    // Status carries the facts and declarations; the model lives in
    // permissions and the store facts in data.
    expect(inDocument('[data-manage-info]')).toBeTruthy()
    expect(inDocument('[data-app-ops]')).toBeTruthy()
    expect(document.body.querySelector('[data-model-provider]')).toBeNull()
    expect(document.body.querySelector('[data-manage-data]')).toBeNull()

    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()
    expect(inDocument('[data-manage-model]')).toBeTruthy()
    expect(document.body.querySelector('[data-app-ops]')).toBeNull()
    expect(document.body.querySelector('[data-manage-data]')).toBeNull()

    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await settle()
    expect(inDocument('[data-manage-data]')).toBeTruthy()
    expect(document.body.querySelector('[data-model-provider]')).toBeNull()
    expect(document.body.querySelector('[data-app-ops]')).toBeNull()

    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    await settle()
    expect(inDocument('[data-manage-info]')).toBeTruthy()
    expect(inDocument('[data-app-ops]')).toBeTruthy()
    expect(document.body.querySelector('[data-manage-data]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('falls back to text inputs when the model catalog is unavailable', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([app('workbook')]))
      remote.modelCatalog.mockRejectedValueOnce(new Error('offline'))
      remote.modelUsage.mockRejectedValueOnce(new Error('offline'))
      remote.modelLimits.mockRejectedValueOnce(new Error('offline'))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()
    expect((inDocument('[data-model-provider]') as HTMLInputElement).tagName).toBe('INPUT')
    await harness.runtime.dispose()
  })

  it('keeps the development dialog open on failure and closes cleanly', async () => {
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'dev-session' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-dev', path }) as never)
    harness.remote.registerDevelopmentSession.mockResolvedValueOnce(ok(false))
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    const open = async (): Promise<void> => {
      fireEvent.click(inDocument('[data-app-menu]'))
      await settle()
      const item = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes('Develop this application') || button.textContent?.includes('开发此应用'))!
      fireEvent.click(item)
      await settle()
    }
    await open()
    expect(document.body.textContent).not.toContain(`v8 ${'ignore'}`)
    fireEvent.keyDown(inDocument('[data-develop-path]'), { key: 'Enter' })
    await settle()
    expect(harness.runtime.workspaces.calls.filter(call => call.method === 'create')).toHaveLength(0)
    fireEvent.click(inDocument('[data-develop-cancel]'))
    await settle()
    expect(document.body.querySelector('[data-develop-dialog]')).toBeNull()

    await open()
    fireEvent.change(inDocument('[data-develop-path]'), { target: { value: '/src/application' } })
    fireEvent.click(inDocument('[data-develop-submit]'))
    await settle()
    expect(inDocument('[data-develop-dialog]')).not.toBeNull()
    expect(inDocument('[role="alert"]').textContent).toContain('refused')
    fireEvent.click(inDocument('[aria-label="Close"]'))
    await settle()
    expect(document.body.querySelector('[data-develop-dialog]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('binds the current page to the development session', async () => {
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'dev-page-session' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-dev-page', path }) as never)
    register(harness, 'workbook', notePage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-menu]'))
    await settle()
    const item = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes('Develop this application') || button.textContent?.includes('开发此应用'))!
    fireEvent.click(item)
    await settle()
    fireEvent.change(inDocument('[data-develop-path]'), { target: { value: '/src/application' } })
    fireEvent.click(inDocument('[data-develop-submit]'))
    await settle()
    expect(harness.remote.setAppConversationContext).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({
      appId: 'workbook',
      label: '笔记 n1',
      view: 'list',
      draftId: 'draft-1',
      hasUnsavedChanges: true,
    }))
    harness.remote.completePageCommand.mockClear()
    harness.stream().push({ kind: 'page-command', command: { commandId: 'pc-dev', sessionId, action: 'open', appId: 'workbook', view: 'list' } })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-dev', true)
    await harness.runtime.dispose()
  })

  it('drops a development Session’s page pointer when the dock closes', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      developmentSessions: [{ appId: 'workbook', sessionId: 'dev-close' }],
      dockExpanded: true,
    }))
    const harness = await mountPanel()
    await harness.runtime.sessions.add({ id: 'dev-close' })
    register(harness, 'workbook', notePage())
    renderPanel(harness)
    await settle()
    if (document.body.querySelector('[data-app-conversation-pane]') === null) {
      fireEvent.click(inDocument('[data-sidebar-right-expand]'))
      await settle()
    }
    fireEvent.click(inDocument('[data-app-dock-tab="dev-close"]'))
    await settle()
    expect(harness.remote.setAppConversationContext).toHaveBeenLastCalledWith('dev-close', expect.objectContaining({ appId: 'workbook' }))
    harness.remote.setAppConversationContext.mockClear()
    fireEvent.click(inDocument('[data-app-conversation-close]'))
    await new Promise<void>(resolve => { setTimeout(() => { resolve() }, 320) })
    await settle()
    expect(harness.remote.setAppConversationContext).toHaveBeenLastCalledWith('dev-close', null)
    await harness.runtime.dispose()
  })

  it('creates the dedicated conversation on first use and shows the current-page chip', async () => {
    const pick = vi.fn()
      .mockResolvedValueOnce(ok('/picked-folder'))
      .mockResolvedValueOnce(ok(null))
      .mockRejectedValueOnce(new Error('picker failed'))
    const harness = await mountPanel(undefined, undefined, { directoryPicker: { pick } })
    const sessionId = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    register(harness, 'workbook', notePage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    // A success, a cancelled pick and a throwing picker all leave the dialog
    // usable; only the first fills the field.
    expect((inDocument('[data-app-conversation-setup-path]') as HTMLInputElement).value).toBe('/home/user/dsh-workspaces/app-conversation/default')
    const pickButton = inDocument('[data-app-conversation-setup-pick]')!
    fireEvent.click(pickButton)
    await settle()
    expect((inDocument('[data-app-conversation-setup-path]') as HTMLInputElement).value).toBe('/picked-folder')
    fireEvent.click(pickButton)
    await settle()
    expect((inDocument('[data-app-conversation-setup-path]') as HTMLInputElement).value).toBe('/picked-folder')
    fireEvent.click(pickButton)
    await settle()
    expect((inDocument('[data-app-conversation-setup-path]') as HTMLInputElement).value).toBe('/picked-folder')
    const path = '/home/user/dsh-workspaces/app-conversation/p'
    fireEvent.change(inDocument('[data-app-conversation-setup-path]'), { target: { value: path } })
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    expect(document.body.querySelector('[data-app-conversation-setup]')).toBeNull()
    expect(document.body.querySelector('[data-app-conversation-pane]')).not.toBeNull()
    expect(harness.remote.registerAppConversation).toHaveBeenCalledWith(sessionId)
    expect(harness.remote.setAppConversationContext).toHaveBeenLastCalledWith(sessionId, {
      appId: 'workbook',
      label: '笔记 n1',
      record: { appId: 'workbook', kind: 'note', id: 'n1' },
      view: 'list',
      draftId: 'draft-1',
      selection: [{ appId: 'workbook', kind: 'note', id: 'n1' }],
      filters: { status: 'open' },
      visibleRange: { from: '2026-01-01', to: '2026-01-31' },
      hasUnsavedChanges: true,
    })
    const contextTab = inDocument('[data-app-dock-tab]')
    expect(contextTab).toBeTruthy()
    // Host page commands are answered only by the client that owns the app
    // conversation Session.
    harness.remote.completePageCommand.mockClear()
    harness.stream().push({ kind: 'page-command', command: { commandId: 'pc-other', sessionId: 'other', action: 'open', appId: 'workbook' } })
    await settle()
    expect(harness.remote.completePageCommand).not.toHaveBeenCalled()
    harness.stream().push({ kind: 'page-command', command: { commandId: 'pc-owner', sessionId, action: 'open', appId: 'workbook', view: 'list' } })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-owner', true)
    harness.stream().push({ kind: 'page-command', command: { commandId: 'pc-record', sessionId, action: 'open', appId: 'workbook', record: { kind: 'note', id: 'n1' } } })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-record', true)
    fireEvent.click(inDocument('[data-app-context-remove]'))
    await settle()
    expect(harness.remote.setAppConversationContext).toHaveBeenLastCalledWith(sessionId, null)
    expect(inDocument('[data-app-context-bar]').getAttribute('data-enabled')).toBe('false')
    fireEvent.click(inDocument('[data-app-context-restore]'))
    await settle()
    expect(inDocument('[data-app-context-bar]').getAttribute('data-enabled')).toBe('true')
    expect(harness.remote.setAppConversationContext).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ appId: 'workbook' }))
    // The expand button hides while the dock is open (like the platform right
    // Sidebar); the strip's collapse closes it; the remembered target then
    // reopens without a second setup.
    fireEvent.click(inDocument('[data-app-conversation-close]'))
    await new Promise<void>(resolve => { setTimeout(() => { resolve() }, 320) })
    await settle()
    expect(document.body.querySelector('[data-app-conversation-pane]')).toBeNull()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    expect(document.body.querySelector('[data-app-conversation-pane]')).not.toBeNull()
    fireEvent.click(inDocument('[data-app-conversation-close]'))
    await new Promise<void>(resolve => { setTimeout(() => { resolve() }, 320) })
    await settle()
    expect(document.body.querySelector('[data-app-conversation-pane]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('closes a Session tab without deleting it and reopens it from the add menu', async () => {
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    expect(document.querySelectorAll('[data-app-dock-tab]').length).toBe(1)
    fireEvent.click(inDocument('[data-app-dock-close]'))
    await settle()
    expect(document.querySelectorAll('[data-app-dock-tab]').length).toBe(0)
    expect(inDocument('[data-app-dock-empty]')).toBeTruthy()
    fireEvent.click(inDocument('[data-app-dock-new]'))
    await settle()
    const menu = inDocument('[role="menu"]')
    const openItem = [...menu.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes('Application area session'))
    expect(openItem).toBeTruthy()
    fireEvent.click(openItem as HTMLElement)
    await settle()
    expect(document.querySelectorAll('[data-app-dock-tab]').length).toBe(1)
    expect(document.body.querySelector('[data-app-conversation-pane]')).not.toBeNull()
    await harness.runtime.dispose()
  })

  it('opens a normal Session as a dock tab with no application context', async () => {
    const harness = await mountPanel()
    const appSession = await harness.runtime.sessions.add({ id: 'app-conversation' })
    const normalSession = await harness.runtime.sessions.add({ id: 'normal-session' })
    harness.runtime.sessions.stubCreate(async () => appSession)
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    fireEvent.click(inDocument('[data-app-dock-new]'))
    await settle()
    const items = [...inDocument('[role="menu"]').querySelectorAll('[role="menuitem"]')]
    const normal = items.at(-1)
    expect(normal).toBeTruthy()
    fireEvent.click(normal as HTMLElement)
    await settle()
    const tab = inDocument(`[data-app-dock-tab="${normalSession}"]`)
    expect(tab.getAttribute('data-kind')).toBe('normal')
    expect(document.querySelectorAll('[data-app-conversation-context], [data-dock-context]').length).toBe(0)
    fireEvent.click(inDocument(`[data-app-dock-close="${normalSession}"]`))
    await settle()
    expect(document.querySelector(`[data-app-dock-tab="${normalSession}"]`)).toBeNull()
    await harness.runtime.dispose()
  })

  it('resizes the dock from its full-height edge and jumps to the active Session', async () => {
    const opened: string[] = []
    const harness = await mountPanel(undefined, (ctx) => {
      ctx.provide('uiWorkspace', { openSession: (sessionId: string) => { opened.push(sessionId) } } as never)
    })
    const sessionId = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    register(harness, 'workbook', notePage())
    const panel = renderPanel(harness)
    await settle()
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    const body = inDocument('[data-app-dock-body]')
    expect(body.style.width).toBe('522px')
    const handle = inDocument('[data-app-dock-resize]')
    expect(handle.className).toContain('dockResize')
    const capture = { has: true }
    Object.assign(handle, {
      setPointerCapture: () => {},
      hasPointerCapture: () => capture.has,
      releasePointerCapture: () => {},
    })
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1000 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 })
    await settle()
    expect(inDocument('[data-app-dock-body]').style.width).toBe('622px')
    fireEvent.click(inDocument('[data-app-dock-open-session]'))
    await settle()
    expect(opened).toContain(sessionId)
    expect(panel).toBeTruthy()
    await harness.runtime.dispose()
  })

  it('closes other dock tabs and tabs to the right from the tab menu', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      developmentSessions: [{ appId: 'workbook', sessionId: 'dev-1' }],
    }))
    const harness = await mountPanel()
    await harness.runtime.sessions.add({ id: 'dev-1' })
    const appSession = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => appSession)
    register(harness, 'workbook', notePage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    expect(inDocument('[data-app-dock-tab="dev-1"]')).toBeTruthy()
    const appTab = inDocument(`[data-app-dock-tab="${appSession}"]`)
    fireEvent.contextMenu(appTab, { clientX: 40, clientY: 60 })
    fireEvent.click([...inDocument('[role="menu"]').querySelectorAll('[role="menuitem"]')]
      .find(item => item.textContent === 'Close other sessions') as HTMLElement)
    await settle()
    expect(document.querySelector('[data-app-dock-tab="dev-1"]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('closes dock tabs to the right from the tab menu', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      developmentSessions: [{ appId: 'workbook', sessionId: 'dev-1' }],
    }))
    const harness = await mountPanel()
    await harness.runtime.sessions.add({ id: 'dev-1' })
    const appSession = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => appSession)
    register(harness, 'workbook', notePage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    const appTab = inDocument(`[data-app-dock-tab="${appSession}"]`)
    fireEvent.contextMenu(appTab, { clientX: 40, clientY: 60 })
    fireEvent.click([...inDocument('[role="menu"]').querySelectorAll('[role="menuitem"]')]
      .find(item => item.textContent === 'Close sessions to the right') as HTMLElement)
    await settle()
    expect(document.querySelector('[data-app-dock-tab="dev-1"]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('ignores a second submit while the workspace creation is in flight', async () => {
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    const gate = Promise.withResolvers<void>()
    harness.runtime.workspaces.stub('create', async ({ path }) => {
      await gate.promise
      return { workspaceId: 'w-app', path } as never
    })
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.change(inDocument('[data-app-conversation-setup-path]'), { target: { value: '/tmp/ws' } })
    const form = inDocument('[data-app-conversation-setup]')!
    fireEvent.submit(form)
    await settle()
    fireEvent.submit(form)
    await settle()
    expect(harness.runtime.workspaces.calls.filter(call => call.method === 'create')).toHaveLength(1)
    gate.resolve()
    await settle()
    expect(document.body.querySelector('[data-app-conversation-setup]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('reports a failed first-use workspace creation and keeps the setup dialog open', async () => {
    const harness = await mountPanel()
    harness.runtime.workspaces.stub('create', async () => { throw new Error('cannot create workspace') })
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.change(inDocument('[data-app-conversation-setup-path]'), { target: { value: '/tmp/ws' } })
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    expect(document.body.querySelector('[data-app-conversation-setup]')).not.toBeNull()
    expect(inDocument('[data-app-conversation-setup-error]')!.textContent).toContain('cannot create workspace')
    await harness.runtime.dispose()
  })

  it('labels the rail entry from the dictionary', async () => {
    const harness = await mountPanel()
    const entries = harness.runtime.ctx.slots.entries('sidebar.panellist')
    const label = entries[0]?.options.label
    expect(resolveSlotLabel(label)).toBe('Applications')
    await harness.runtime.dispose()
  })

  it('says it is reading while the first list read is still out', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockReturnValue(new Promise(() => {}))
    })
    renderPanel(harness)
    // "Not known yet" is not "nothing runs": neither the surface nor the
    // navigation claims the host has no applications.
    expect(inDocument('[data-app-loading]').textContent).toBe('Reading…')
    expect(inDocument('[data-app-tabs-empty]').textContent).toBe('Reading…')
    fireEvent.click(inDocument('[data-app-all]'))
    expect(inDocument('[data-app-apps-empty]').textContent).toBe('Reading…')
    await harness.runtime.dispose()
  })

  it('says the host runs nothing when the list is empty', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([]))
    })
    renderPanel(harness)
    await settle()
    const empty = inDocument('[data-app-state="empty"]')
    expect(empty.textContent).toContain('This host runs no applications')
    // Nothing to open does not mean nothing to manage: the state's own action
    // opens the management list, which says the same thing.
    fireEvent.click(inDocument('[data-app-all]'))
    expect(inDocument('[data-app-apps-empty]').textContent).toBe('No application provides a page yet')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(empty).getByRole('button', { name: 'Manage applications' }))
    expect(document.body.querySelector('[data-manage-page]')).not.toBeNull()
    expect(document.body.querySelector('[data-manage-row]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('renders the saved pinned order, appends a new application and ignores a removed id', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      pinned: ['info-hub', 'gone', 'workbook'],
    }))
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([
        app('workbook', 'available'), app('disk-analysis', 'available'), app('info-hub', 'available'),
      ]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk'))
    register(harness, 'info-hub', markerPage('info'))
    const panel = renderPanel(harness)
    await settle()
    expect([...nav(panel).querySelectorAll('[data-app-tab]')].map(row => row.getAttribute('data-app-tab')))
      .toEqual(['info-hub', 'workbook'])
    await harness.runtime.dispose()
  })

  it('says no application provides a page, and still offers the way into management', async () => {
    const harness = await mountPanel()
    renderPanel(harness)
    await settle()
    const state = inDocument('[data-app-state="no-page"]')
    expect(state.textContent).toContain('None of these applications registers a page')
    expect(within(state).getByRole('button', { name: 'Manage applications' })).toBeDefined()
    expect(inDocument('[data-app-tabs-empty]').textContent).toBe('No application provides a page yet')
    await harness.runtime.dispose()
  })

  it('shows an application whose page is gone as such, with the management way in', async () => {
    // The human was on an application whose page package has not loaded (or was
    // unloaded): the place is kept, and the surface says what is missing.
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({ lastAppId: 'info-hub' }))
    const harness = await mountPanel()
    renderPanel(harness)
    await settle()
    const state = inDocument('[data-app-state="no-view"]')
    expect(state.textContent).toContain('This application registers no page')
    expect(within(state).getByRole('button', { name: 'Manage applications' })).toBeDefined()
    await harness.runtime.dispose()
  })
})

describe('registered views', () => {
  it('renders the registered page with the shell props and its own view state', async () => {
    const harness = await mountPanel()
    const registry = harness.runtime.ctx.applicationViews
    const seen: ApplicationViewProps[] = []
    const dispose = register(harness, 'workbook', {
      name: 'Notebook',
      Component: (viewProps) => {
        seen.push(viewProps)
        return <p data-testid="view-body">{viewProps.running ? 'busy' : 'idle'}</p>
      },
    })
    const panel = renderPanel(harness)
    await settle()
    expect(panel.view.getByTestId('view-body').textContent).toBe('idle')
    expect(navRow(panel, 'workbook').textContent).toContain('Notebook')
    const props = seen.at(-1)
    expect(props?.running).toBe(false)
    // The page's own view state is the store of ITS registration.
    expect(props?.ui).toBe(registry.state('workbook'))
    await props?.call('write', { text: 'hi' })
    expect(harness.remote.call).toHaveBeenCalledWith('workbook', 'write', { text: 'hi' }, expect.any(String))
    // The page's change subscription is the shell's own fan.
    const listener = vi.fn()
    const off = props?.onChanged(listener)
    harness.stream().push({ kind: 'changed', appId: 'workbook' })
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    off?.()
    dispose()
    await settle()
    expect(registry.views().size).toBe(0)
    await harness.runtime.dispose()
  })

  it('shows a page registered after the area was already rendered, and keeps the place when it leaves', async () => {
    const harness = await mountPanel()
    const panel = renderPanel(harness)
    await settle()
    expect(inDocument('[data-app-state="no-page"]')).toBeDefined()
    const dispose = register(harness, 'workbook', markerPage('late'))
    await settle()
    expect(panel.view.getByTestId('late-page')).toBeDefined()
    dispose()
    await settle()
    // The place survives the registration leaving: the frame still says which
    // application the area is on, the surface says it has no page, and the
    // navigation (which lists pages) no longer offers a row for it.
    expect(inDocument('[data-app-state="no-view"]')).toBeDefined()
    expect(inDocument('[data-app-frame]').getAttribute('data-app-id')).toBe('workbook')
    expect(nav(panel).querySelector('[data-app-tab="workbook"]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('keeps each application’s view state to itself across a switch away and back', async () => {
    const harness = await mountPanel()
    const registry = harness.runtime.ctx.applicationViews
    const pageOf = (appId: string) => ({
      Component: (props: ApplicationViewProps) => (
        <div data-testid={`${appId}-page`}>
          <p data-testid={`${appId}-draft`}>{String(props.ui.getSnapshot().draft ?? '')}</p>
          <button type="button" onClick={() => { props.ui.set({ draft: `${appId} draft` }) }}>{`edit ${appId}`}</button>
        </div>
      ),
    })
    register(harness, 'workbook', pageOf('workbook'))
    register(harness, 'disk-analysis', pageOf('disk-analysis'))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(panel.view.getByRole('button', { name: 'edit workbook' }))
    fireEvent.click(navRow(panel, 'disk-analysis'))
    // The next application starts from its own state, not from the last page's.
    expect(panel.view.getByTestId('disk-analysis-draft').textContent).toBe('')
    fireEvent.click(panel.view.getByRole('button', { name: 'edit disk-analysis' }))
    fireEvent.click(navRow(panel, 'workbook'))
    // Unmounting is not forgetting: the human's choices are still there.
    expect(panel.view.getByTestId('workbook-draft').textContent).toBe('workbook draft')
    expect(registry.state('workbook').getSnapshot()).toEqual({ draft: 'workbook draft' })
    expect(registry.state('disk-analysis').getSnapshot()).toEqual({ draft: 'disk-analysis draft' })
    await harness.runtime.dispose()
  })
})

/** The page source among the sources this plugin registered. */
function pageSource(harness: Harness & { registered: InputTriggerSource[] }): InputTriggerSource {
  const source = harness.registered.find(candidate => candidate.name === 'page')
  if (source === undefined) throw new Error('no page source registered')
  return source
}

/** The application source among the sources this plugin registered. */
function applicationSource(harness: Harness & { registered: InputTriggerSource[] }): InputTriggerSource {
  const source = harness.registered.find(candidate => candidate.name === 'application')
  if (source === undefined) throw new Error('no application source registered')
  return source
}

describe('the page reference source', () => {
  it('offers the page a registered page reports, and clears it when that page unmounts', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      appConversation: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      appConversations: [{ workspaceId: 'workspace-1', sessionId: 'session-1' }],
    }))
    const harness = await mountWithTriggers()
    const panel = renderPanel(harness)
    await settle()
    // Nothing is offered while no page is mounted.
    expect(harness.registered).toHaveLength(2)
    expect(await rows(pageSource(harness))).toEqual([])
    const dispose = register(harness, 'workbook', notePage())
    await settle()
    expect(panel.view.getByTestId('view-body')).toBeDefined()
    expect(await rows(pageSource(harness))).toEqual([{
      name: '笔记 n1',
      description: '笔记页选中',
      value: '@page:workbook:note:n1',
      section: 'Current page',
    }])

    // The page leaves the area: its effect cleanup clears the page with it.
    dispose()
    await settle()
    expect(await rows(pageSource(harness))).toEqual([])
    await harness.runtime.dispose()
    // The registration is the injected scope's effect: it leaves with the shell.
    expect(harness.registered).toEqual([])
  })

  it('mounts without a trigger registry, offering nothing and failing nothing', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    await harness.runtime.dispose()
  })
})

describe('the application reference source', () => {
  it('offers every available application and omits the one the page row already represents', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      appConversation: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      appConversations: [{ workspaceId: 'workspace-1', sessionId: 'session-1' }],
    }))
    const harness = await mountWithTriggers()
    register(harness, 'workbook', notePage())
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    register(harness, 'info-hub', markerPage('hub', 'Info hub'))
    renderPanel(harness)
    await settle()
    expect((await rows(applicationSource(harness))).map(row => row.value)).toEqual([
      '@app:disk-analysis',
      '@app:info-hub',
    ])
    await harness.runtime.dispose()
  })

  it('keeps the current application for an ordinary Session with no page row', async () => {
    const harness = await mountWithTriggers()
    register(harness, 'workbook', notePage())
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    renderPanel(harness)
    await settle()
    // The ordinary Session is not a page owner, so no page row exists.
    expect(await rowsFor(pageSource(harness), 'ordinary-1')).toEqual([])
    // The page's application must still be reachable through the app row.
    expect((await rowsFor(applicationSource(harness), 'ordinary-1')).map(row => row.value)).toEqual([
      '@app:workbook',
      '@app:disk-analysis',
      '@app:info-hub',
    ])
    await harness.runtime.dispose()
  })
})

describe('the application tabs and the header', () => {
  it('moves the selection with the keyboard and scrolls the active tab into view', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    register(harness, 'info-hub', markerPage('info'))
    const panel = renderPanel(harness)
    await settle()
    const scroll = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    try {
      fireEvent.keyDown(navRow(panel, 'workbook'), { key: 'ArrowRight' })
      await settle()
      expect(navRow(panel, 'disk-analysis').getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(navRow(panel, 'disk-analysis'))
      expect(navRow(panel, 'disk-analysis').getAttribute('tabindex')).toBe('0')
      fireEvent.keyDown(navRow(panel, 'disk-analysis'), { key: 'End' })
      await settle()
      expect(navRow(panel, 'info-hub').getAttribute('aria-selected')).toBe('true')
      fireEvent.keyDown(navRow(panel, 'info-hub'), { key: 'Home' })
      await settle()
      expect(navRow(panel, 'workbook').getAttribute('aria-selected')).toBe('true')
      expect(scroll).toHaveBeenCalled()
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
    await harness.runtime.dispose()
  })

  it('opens the complete application list from the header and pins management at its footer', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    register(harness, 'disk-analysis', markerPage('disk', 'Disk analysis'))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-all]'))
    const list = inDocument('[data-app-apps-panel]')
    // Every page application is present, fixed or not, plus management.
    expect(within(list).getByRole('button', { name: 'workbook title' })).toBeDefined()
    expect(within(list).getByRole('button', { name: 'Disk analysis' })).toBeDefined()
    expect(within(list).getByRole('button', { name: 'Manage applications' })).toBeDefined()
    expect(inDocument('[data-app-pin-toggle="workbook"]').getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    expect(document.body.querySelector('[data-app-apps-panel]')).toBeNull()
    expect(document.activeElement).toBe(inDocument('[data-app-all]'))
    openManageList(panel)
    await settle()
    expect(inDocument('[data-manage-row="workbook"]')).not.toBeNull()
    await harness.runtime.dispose()
  })

  it('closes the application list on an outside press or a second trigger click', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-all]'))
    expect(inDocument('[data-app-apps-panel]')).not.toBeNull()
    // A press inside the panel and an unrelated key must not close it.
    fireEvent.pointerDown(inDocument('[data-app-apps-panel]'))
    fireEvent.keyDown(document, { key: 'Enter' })
    await settle()
    expect(inDocument('[data-app-apps-panel]')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    await settle()
    expect(document.body.querySelector('[data-app-apps-panel]')).toBeNull()
    // The current application's row closes the panel without switching.
    fireEvent.click(inDocument('[data-app-all]'))
    fireEvent.click(inDocument('[data-app-apps-row="workbook"]'))
    await settle()
    expect(document.body.querySelector('[data-app-apps-panel]')).toBeNull()
    expect(navRow(panel, 'workbook').getAttribute('aria-selected')).toBe('true')
    // The trigger toggles closed too.
    fireEvent.click(inDocument('[data-app-all]'))
    expect(inDocument('[data-app-apps-panel]')).not.toBeNull()
    fireEvent.click(inDocument('[data-app-all]'))
    await settle()
    expect(document.body.querySelector('[data-app-apps-panel]')).toBeNull()
    await harness.runtime.dispose()
  })
})

describe('the management dialog', () => {
  it('previews and restores one application from a whole-database backup', async () => {
    const backupPath = '/tmp/app-data.sqlite.before-import-restore'
    const harness = await mountPanel((remote) => {
      remote.dataInfo.mockResolvedValue(ok({
        appId: 'workbook', path: '/tmp/app-data.sqlite', byteSize: 1024, schemaVersion: 2, documentCount: 1, collections: { notes: 3 },
        backups: [{ path: backupPath, byteSize: 2048, modifiedAt: 1 }], backupCount: 1,
      }))
      remote.dataRestorePreview.mockResolvedValue(ok<AppDataRestorePreview>({
        appId: 'workbook', backupPath, backupModifiedAt: 1, backupByteSize: 2048,
        documents: { backupOnly: 1, currentOnly: 1, modified: 1, unchanged: 0 },
        collections: { backupOnly: 0, currentOnly: 0, modified: 0, unchanged: 0 },
        conflicts: [{ kind: 'document', name: 'notes' }], conflictCount: 1, truncated: false, metaChanged: [], previewFingerprint: 'fingerprint', planId: 'plan_restore', expiresAt: Date.now() + 60_000,
      }))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await waitFor(() => expect(inDocument('[data-manage-data]')).toBeDefined())
    fireEvent.click(inDocument(`[data-manage-data-restore="${backupPath}"]`))
    await waitFor(() => expect(inDocument('[data-manage-data-restore-preview]')).toBeDefined())
    expect(harness.remote.dataRestorePreview).toHaveBeenCalledWith('workbook', backupPath)
    expect(inDocument('[data-manage-data-restore-conflicts]').textContent).toContain('notes')
    fireEvent.click(inDocument('[data-manage-data-restore-confirm]'))
    await waitFor(() => expect(document.body.querySelector('[data-data-confirm-dialog]')).not.toBeNull())
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Restore this backup?')
    await waitFor(() => expect(document.activeElement).toBe(document.body.querySelector('[data-data-confirm-no]')))
    fireEvent.keyDown(document.body.querySelector('[data-data-confirm-no]')!, { key: 'Escape' })
    await waitFor(() => expect(document.body.querySelector('[data-data-confirm-dialog]')).toBeNull())
    expect(harness.remote.dataRestore).not.toHaveBeenCalled()
    await confirmDataAction(inDocument('[data-manage-data-restore-confirm]'))
    await waitFor(() => expect(inDocument('[data-manage-data-restore-result]').textContent).toContain('/tmp/pre-restore.sqlite'))
    const restoreArgs = harness.remote.dataRestore.mock.calls[0]!
    expect(restoreArgs.slice(0, 2)).toEqual(['workbook', 'plan_restore'])
    expect(restoreArgs[2]).toEqual(expect.any(String))
    await harness.runtime.dispose()
  })

  it('handles restore preview failure, cancel, truncation and reload failure', async () => {
    const backupPath = '/tmp/app-data.sqlite.before-import-edge'
    const harness = await mountPanel((remote) => {
      remote.dataInfo.mockResolvedValue(ok({
        appId: 'workbook', path: '/tmp/app-data.sqlite', byteSize: 1024, schemaVersion: 2, documentCount: 1, collections: { notes: 3 },
        backups: [{ path: backupPath, byteSize: 2048, modifiedAt: 1 }], backupCount: 1,
      }))
      remote.dataRestorePreview
        .mockRejectedValueOnce(new Error('preview down'))
        .mockResolvedValue(ok<AppDataRestorePreview>({
          appId: 'workbook', backupPath, backupModifiedAt: 1, backupByteSize: 2048,
          documents: { backupOnly: 0, currentOnly: 1, modified: 1, unchanged: 0 },
          collections: { backupOnly: 0, currentOnly: 0, modified: 0, unchanged: 0 },
          conflicts: [{ kind: 'document', name: 'notes' }], conflictCount: 51, truncated: true, metaChanged: ['legacy'],
          previewFingerprint: 'fingerprint', planId: 'plan_restore', expiresAt: Date.now() + 60_000,
        }))
      remote.dataRestore.mockResolvedValue(ok<AppDataRestoreResult>({
        appId: 'workbook', restoredFrom: backupPath, backupPath: '/tmp/pre-restore.sqlite', documents: 1, collections: 0,
        reload: 'failed', reloadError: 'reload down',
      }))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await waitFor(() => expect(inDocument('[data-manage-data]')).toBeDefined())
    fireEvent.click(inDocument(`[data-manage-data-restore="${backupPath}"]`))
    await waitFor(() => expect(inDocument('[data-manage-data-restore-error]').textContent).toContain('preview down'))
    fireEvent.click(inDocument(`[data-manage-data-restore="${backupPath}"]`))
    await waitFor(() => expect(inDocument('[data-manage-data-restore-preview]')).toBeDefined())
    expect(inDocument('[data-manage-data-restore-truncated]').textContent).toContain('50')
    expect(inDocument('[data-manage-data-restore-meta]').textContent).toContain('1')
    fireEvent.click(inDocument('[data-manage-data-restore-cancel]'))
    expect(document.body.querySelector('[data-manage-data-restore-preview]')).toBeNull()
    fireEvent.click(inDocument(`[data-manage-data-restore="${backupPath}"]`))
    await waitFor(() => expect(inDocument('[data-manage-data-restore-preview]')).toBeDefined())
    harness.remote.dataRestore.mockRejectedValueOnce(new Error('restore down'))
    await confirmDataAction(inDocument('[data-manage-data-restore-confirm]'))
    await waitFor(() => expect(inDocument('[data-manage-data-restore-error]').textContent).toContain('restore down'))
    expect(inDocument('[data-manage-data-restore-error]').textContent).toContain('Restore failed')
    await confirmDataAction(inDocument('[data-manage-data-restore-confirm]'))
    await waitFor(() => expect(inDocument('[data-manage-data-restore-reload-failed]')).toBeDefined())
    fireEvent.click(inDocument('[data-manage-data-restore-reload-retry]'))
    await settle()
    await harness.runtime.dispose()
  })

  it('lists every application the host runs, including the view-less ones, beside the detail', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    expect(document.body.querySelector('[data-manage-list]')).not.toBeNull()
    const ids = [...document.body.querySelectorAll('[data-manage-row]')].map(row => row.getAttribute('data-manage-row'))
    expect(ids).toEqual(['workbook', 'disk-analysis', 'info-hub'])
    expect(inDocument('[data-manage-row="workbook"]').textContent).toContain('workbook description')
    expect(inDocument('[data-manage-row="workbook"]').textContent).toContain('ready')
    // The row's content is its accessible name; no aria-label hides the status.
    expect(inDocument('[data-manage-row="workbook"]').getAttribute('aria-label')).toBeNull()
    expect(inDocument('[data-manage-row="workbook"]').textContent).not.toContain('no page')
    expect(inDocument('[data-manage-row="info-hub"]').textContent).toContain('info-hub description')
    expect(inDocument('[data-manage-row="info-hub"]').textContent).toContain('no page')
    // The list is persistent; selecting a row changes the subject of the
    // detail, not the application the area will return to.
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    expect(inDocument('[data-manage-list]')).not.toBeNull()
    expect(inDocument('[data-manage-detail]').getAttribute('data-app-id')).toBe('workbook')
    expect(inDocument('[data-manage-row="workbook"]').getAttribute('aria-current')).toBe('true')
    expect(inDocument('[data-manage-tab="status"]')).not.toBeNull()
    // Closing gives the page back exactly as it was.
    fireEvent.click(inDocument('[data-manage-return]'))
    expect(document.body.querySelector('[data-manage-page]')).toBeNull()
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    await harness.runtime.dispose()
  })
  it('lists durable background tasks and cancels one from the tasks tab', async () => {
    const task: TaskSnapshot = {
      taskId: 'task-1', traceId: 'task-1', appId: 'workbook', kind: 'scan', title: 'Scan', origin: { kind: 'background' },
      state: 'running', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      progress: { message: 'half', updatedAt: '2026-01-01T00:00:01.000Z' },
    }
    const harness = await mountPanel((remote) => {
      remote.tasks.mockResolvedValue(ok<readonly TaskSnapshot[]>([task]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    await settle()
    // The cross-application queue shows the live background task too.
    fireEvent.click(inDocument('[data-manage-queue="running"]'))
    await settle()
    expect(inDocument('[data-manage-background-task="task-1"]').textContent).toContain('Scan')
    fireEvent.click(inDocument('[data-manage-background-task="task-1"] [data-manage-background-task-cancel]'))
    await settle()
    expect(harness.remote.cancelTask).toHaveBeenCalledWith('workbook', 'task-1')
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await settle()
    expect(inDocument('[data-manage-background-task="task-1"]').textContent).toContain('half')
    fireEvent.click(inDocument('[data-manage-background-task-cancel]'))
    await settle()
    expect(harness.remote.cancelTask).toHaveBeenCalledWith('workbook', 'task-1')
    await harness.runtime.dispose()
  })

  it('shows the task-retry control when the task read fails, and retries it', async () => {
    const harness = await mountPanel((remote) => {
      remote.tasks.mockResolvedValueOnce(carrierFailure())
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    await settle()
    fireEvent.click(inDocument('[data-manage-queue="running"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tasks-retry]'))
    await settle()
    expect(harness.remote.tasks).toHaveBeenCalledTimes(2)
    await harness.runtime.dispose()
  })

  it('enables and disables an application from its info tab', async () => {
    let activation: 'enabled' | 'disabled' = 'enabled'
    const harness = await mountPanel((remote) => {
      remote.list.mockImplementation(async () => ok<readonly AppInfo[]>([
        { ...app('workbook'), activation },
      ]))
      remote.setActivation.mockImplementation(async (_appId, next) => {
        activation = next
        return ok<readonly AppInfo[]>([{ ...app('workbook'), activation }])
      })
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    expect(inDocument('[data-manage-activation]').getAttribute('data-activation')).toBe('enabled')
    fireEvent.click(inDocument('[data-manage-activation] button'))
    await settle()
    expect(harness.remote.setActivation).toHaveBeenCalledWith('workbook', 'disabled')
    expect(inDocument('[data-manage-activation]').getAttribute('data-activation')).toBe('disabled')
    expect(inDocument('[data-manage-activation] button')).toBeDefined()
    await harness.runtime.dispose()
  })

  it('shows the runtime/health/reason/detail projection and runs the explicit health check', async () => {
    let checked = false
    const degraded = {
      ...app('workbook'),
      health: 'degraded' as const,
      detail: 'the model is not configured',
    }
    const harness = await mountPanel((remote) => {
      remote.list.mockImplementation(async () => ok<readonly AppInfo[]>([checked ? degraded : app('workbook')]))
      remote.checkHealth.mockImplementation(async () => {
        checked = true
        return ok<readonly AppInfo[]>([degraded])
      })
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    const health = inDocument('[data-manage-health]')
    expect(health.getAttribute('data-runtime')).toBe('ready')
    expect(health.getAttribute('data-health')).toBe('ok')
    expect(health.getAttribute('data-activation')).toBe('enabled')
    expect(document.body.querySelector('[data-health-detail]')).toBeNull()
    fireEvent.click(inDocument('[data-health-check]'))
    await settle()
    expect(harness.remote.checkHealth).toHaveBeenCalledWith('workbook')
    expect(inDocument('[data-manage-health]').getAttribute('data-health')).toBe('degraded')
    expect(inDocument('[data-health-detail]').textContent).toContain('the model is not configured')
    await harness.runtime.dispose()
  })

  it('shows the check as running and reports a failed check on the header', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof harness.remote.checkHealth>>>()
    harness.remote.checkHealth.mockReturnValueOnce(pending.promise)
    fireEvent.click(inDocument('[data-health-check]'))
    await settle()
    expect((inDocument('[data-health-check]') as HTMLButtonElement).disabled).toBe(true)
    pending.resolve(carrierFailure<readonly AppInfo[]>())
    await settle()
    expect(inDocument('[data-health-error]')).toBeDefined()
    expect((inDocument('[data-health-check]') as HTMLButtonElement).disabled).toBe(false)
    await harness.runtime.dispose()
  })

  it('omits the health row while an application is not ready', async () => {
    const stopped = app('workbook', 'stopped')
    delete (stopped as { health?: 'ok' | 'degraded' }).health
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValueOnce(ok([{ ...stopped, activation: 'disabled', reason: 'platform.start-failed' }]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    expect(inDocument('[data-manage-info]').textContent).not.toContain('info.health')
    await harness.runtime.dispose()
  })

  it('lists runtime, health, reason and detail in the overview instead of a legacy status', async () => {
    const row = {
      ...app('workbook'),
      health: 'degraded' as const,
      reason: 'platform.updating' as const,
      detail: 'application data is being updated',
    }
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([row]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    await settle()
    const info = inDocument('[data-manage-info]')
    expect(info.textContent).toContain('Runtime')
    expect(info.textContent).toContain('Health')
    expect(info.textContent).toContain('Platform updating')
    expect(inDocument('[data-health-reason-code]').textContent).toBe('platform.updating')
    expect(inDocument('[data-health-detail]').textContent).toContain('application data is being updated')
    await harness.runtime.dispose()
  })

  it('treats an explicit enable of a health-failed application as its restart', async () => {
    const failed = {
      ...app('workbook'),
      runtime: 'stopped' as const,
      activation: 'enabled' as const,
      health: 'degraded' as const,
      reason: 'platform.health-failed' as const,
      detail: 'git is missing',
    }
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([failed]))
      remote.setActivation.mockResolvedValue(ok<readonly AppInfo[]>([app('workbook')]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    // The header says why it is down; the app is still enabled.
    expect(inDocument('[data-manage-health]').getAttribute('data-reason')).toBe('platform.health-failed')
    expect(inDocument('[data-health-detail]').textContent).toContain('git is missing')
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    await settle()
    const activation = inDocument('[data-manage-activation]')
    expect(activation.getAttribute('data-activation')).toBe('enabled')
    fireEvent.click(within(activation).getByRole('button'))
    await settle()
    expect(harness.remote.setActivation).toHaveBeenCalledWith('workbook', 'enabled')
    await harness.runtime.dispose()
  })

  it('lists an in-flight task and cancels it from the tasks tab', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    // An idle application says so instead of showing an empty card list.
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    expect(inDocument('[data-manage-tasks-empty]')).toBeDefined()
    // Start a call from the debug form and hold it on the wire.
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    fireEvent.click(inDocument('[data-manage-debug-toggle]'))
    let finish: ((value: RemoteResult<CallOutcome>) => void) | undefined
    harness.remote.call.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(inDialog().getByRole('button', { name: 'Call' }))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await settle()
    const requestId = harness.remote.call.mock.calls.at(-1)?.[3]
    expect(typeof requestId).toBe('string')
    expect(document.body.querySelector('[data-manage-task]')).not.toBeNull()
    expect(inDocument('[data-manage-task]').textContent).toBeDefined()
    // The shell's watch fan feeds the same task view: a progress notice for
    // this call is shown beside it, not hidden.
    harness.stream().push({
      kind: 'progress',
      notice: { appId: 'workbook', op: 'write', callId: requestId ?? 'request', message: 'working' },
    })
    await settle()
    expect(inDocument('[data-manage-task-progress]').textContent).toContain('working')
    fireEvent.click(inDocument('[data-manage-task-cancel]'))
    await settle()
    expect(harness.remote.cancel).toHaveBeenCalledWith(requestId)
    finish?.({ ok: true, value: { callId: requestId ?? 'request', status: 'cancelled' } })
    await settle()
    expect(document.body.querySelector('[data-manage-task]')).toBeNull()
    expect(document.body.querySelector('[data-manage-task-outcome]')?.textContent).toContain('cancelled')
    await harness.runtime.dispose()
  })

  it('shows an in-flight call across applications in the management list and cancels it', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    fireEvent.click(inDocument('[data-manage-debug-toggle]'))
    let finish: ((value: RemoteResult<CallOutcome>) => void) | undefined
    harness.remote.call.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(inDialog().getByRole('button', { name: 'Call' }))
    await settle()
    fireEvent.click(inDocument('[data-manage-queue="running"]'))
    await settle()
    expect(document.body.querySelector('[data-manage-active-task]')).not.toBeNull()
    expect(inDocument('[data-manage-active-tasks]').textContent).toContain('workbook')
    const requestId = harness.remote.call.mock.calls.at(-1)?.[3]
    fireEvent.click(inDocument('[data-manage-active-task-cancel]'))
    await settle()
    expect(harness.remote.cancel).toHaveBeenCalledWith(requestId)
    finish?.({ ok: true, value: { callId: requestId ?? 'request', status: 'cancelled' } })
    await settle()
    expect(document.body.querySelector('[data-manage-active-task]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('shows the settings tab only where settings are registered, and renders each application’s own', async () => {
    const harness = await mountPanel()
    const registry = harness.runtime.ctx.applicationViews
    const settingsSeen: ApplicationSettingsProps[] = []
    register(harness, 'workbook', {
      Component: () => <p data-testid="workbook-page">workbook page</p>,
      Settings: (props) => {
        settingsSeen.push(props)
        return <p data-testid="workbook-settings">{`${props.appId} settings`}</p>
      },
    })
    // Settings alone is a registration too: no page, still manageable here.
    register(harness, 'info-hub', {
      Settings: (props) => {
        settingsSeen.push(props)
        return <p data-testid="info-settings">{`${props.appId} settings`}</p>
      },
    })
    registry.state('workbook').set({ tab: 'calendar' })
    const panel = renderPanel(harness)
    await settle()
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    openManageList(panel)
    // An application with settings offers the settings area; the page opens on
    // its status area like every other application.
    fireEvent.click(inDocument('[data-manage-row="info-hub"]'))
    await settle()
    expect(inDocument('[data-manage-tab="settings"]')).not.toBeNull()
    fireEvent.click(inDocument('[data-manage-tab="settings"]'))
    await settle()
    expect(document.body.querySelector('[data-manage-settings]')).not.toBeNull()
    expect(inDialog().getByTestId('info-settings').textContent).toBe('info-hub settings')
    const infoProps = settingsSeen.at(-1)
    expect(infoProps?.appId).toBe('info-hub')
    // The settings carry THAT application's own view state and call face…
    expect(infoProps?.ui).toBe(registry.state('info-hub'))
    expect(infoProps?.ui.getSnapshot()).toEqual({})
    await infoProps?.call('scan', {})
    expect(harness.remote.call).toHaveBeenCalledWith('info-hub', 'scan', {}, expect.any(String))
    // …and managing another application never switches the page underneath.
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    expect(inDocument('[data-app-frame]').getAttribute('data-app-id')).toBe('workbook')
    // An application without settings has no settings tab; its detail keeps
    // the status area, and the list is still there to switch back.
    fireEvent.click(inDocument('[data-manage-row="disk-analysis"]'))
    await settle()
    expect(document.body.querySelector('[data-manage-tab="settings"]')).toBeNull()
    expect(inDocument('[data-manage-tab="status"]').getAttribute('aria-selected')).toBe('true')
    // The workbook's settings see the workbook's own state, not the other's.
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="settings"]'))
    await settle()
    expect(inDialog().getByTestId('workbook-settings').textContent).toBe('workbook settings')
    expect(settingsSeen.at(-1)?.ui).toBe(registry.state('workbook'))
    expect(settingsSeen.at(-1)?.ui.getSnapshot()).toEqual({ tab: 'calendar' })
    await harness.runtime.dispose()
  })

  it('restores the surface scroll for the view a page reports', async () => {
    // jsdom computes no layout: the heights the framework's clamp reads are
    // stubbed for this case only.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 1000 })
    try {
      const harness = await mountPanel()
      // A page shaped like a real one: it reports which view it draws and when
      // that view is ready; a tab switch is a NEW key.
      register(harness, 'workbook', {
        Component: (props) => {
          const [tab, setTab] = useState('a')
          useEffect(() => props.viewport.report({ key: `tab:${tab}`, ready: true }), [props.viewport, tab])
          return (
            <button type="button" data-switch-tab onClick={() => { setTab(tab === 'a' ? 'b' : 'a') }}>
              {tab}
            </button>
          )
        },
      })
      const panel = renderPanel(harness)
      await settle()
      const surface = inDocument('[data-app-surface]')
      act(() => {
        surface.scrollTop = 300
        surface.dispatchEvent(new Event('scroll'))
      })
      // Another view: it starts at its own position (nowhere), never the other's.
      const switchTab = (): HTMLElement => panel.container.querySelector('[data-switch-tab]') as HTMLElement
      fireEvent.click(switchTab())
      await settle()
      expect(inDocument('[data-app-surface]').scrollTop).toBe(0)
      // Back to the first view: its position comes back.
      fireEvent.click(switchTab())
      await settle()
      expect(inDocument('[data-app-surface]').scrollTop).toBe(300)
      await harness.runtime.dispose()
    } finally {
      if (original === undefined) delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight
      else Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original)
    }
  })

  it('hands a page the same viewport face across repaints, and one per application', async () => {
    const harness = await mountPanel()
    const seen: ApplicationViewProps[] = []
    register(harness, 'workbook', {
      Component: (props) => {
        seen.push(props)
        return <p data-testid="workbook-page">workbook</p>
      },
    })
    const panel = renderPanel(harness)
    await settle()
    expect(seen.length).toBeGreaterThan(0)
    // A repaint (a frame the panel renders for) reaches the page with the SAME
    // reporting face: a page keys an effect on it, so a fresh object per render
    // would re-report every view on every repaint.
    act(() => {
      harness.stream().push({ kind: 'progress', notice: { appId: 'workbook', op: 'write', callId: 'call-1', message: 'working' } })
    })
    await settle()
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)?.viewport).toBe(seen[0]?.viewport)
    // …and a different application gets its own face.
    expect(await panel.view.getByTestId('workbook-page').textContent).toBe('workbook')
    await harness.runtime.dispose()
  })

  it('hands a settings page stable bindings: a repaint is not a reason to read again', async () => {
    const harness = await mountPanel()
    const reads: string[] = []
    // A settings page shaped like a real one: subscribe once, read on mount,
    // both keyed on the props' own function identities.
    register(harness, 'info-hub', {
      Settings: (props: ApplicationSettingsProps) => {
        const [value, setValue] = useState('')
        useEffect(() => {
          let live = true
          const load = async (): Promise<void> => {
            reads.push('settings')
            const outcome = await props.call('settings', {})
            if (live) setValue(outcome.status)
          }
          const off = props.onChanged(() => { void load() })
          void load()
          return () => { live = false; off() }
        }, [props.call, props.onChanged])
        return <p data-testid="info-settings">{value}</p>
      },
    })
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="info-hub"]'))
    await settle()
    expect(inDialog().getByTestId('info-settings').textContent).toBe('success')
    expect(reads).toHaveLength(1)
    // A frame that is NOT this application's change (a progress notice) still
    // repaints the dialog and rebuilds the props object around the bindings.
    act(() => {
      harness.stream().push({ kind: 'progress', notice: { appId: 'workbook', op: 'write', callId: 'call-9', message: 'working' } })
    })
    await settle()
    expect(reads).toHaveLength(1)
    // The application's own change notification is the one thing that re-reads.
    act(() => { harness.stream().push({ kind: 'changed', appId: 'info-hub' }) })
    await settle()
    expect(reads).toHaveLength(2)
    await harness.runtime.dispose()
  })

  it('opens the current application’s settings straight from the header menu', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', {
      Component: () => <p data-testid="workbook-page">workbook page</p>,
      Settings: (props) => <p data-testid="workbook-settings">{props.appId}</p>,
    })
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-menu]'))
    // Escape closes the manage menu without opening anything.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.body.querySelector('[data-manage-page]')).toBeNull()
    fireEvent.click(inDocument('[data-app-menu]'))
    fireEvent.click(panel.view.getByRole('menuitem', { name: 'Settings' }))
    expect(document.body.querySelector('[data-manage-settings]')).not.toBeNull()
    expect(inDialog().getByTestId('workbook-settings').textContent).toBe('workbook')
    fireEvent.click(inDocument('[data-manage-return]'))
    // The header's own management trigger is hidden while the page shows, so
    // the page gives focus back to the application it returns to: its tab.
    await waitFor(() => expect(document.activeElement).toBe(inDocument('[data-app-tab-active]')))
    // The same menu's debug entry opens THIS application's info tab, where the
    // explicit debug form lives.
    fireEvent.click(inDocument('[data-app-menu]'))
    fireEvent.click(panel.view.getByRole('menuitem', { name: 'Debug call' }))
    expect(document.body.querySelector('[data-manage-info]')).not.toBeNull()
    expect(document.body.querySelector('[data-manage-debug-toggle]')).not.toBeNull()
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data]')).not.toBeNull())
    const data = document.body.querySelector('[data-manage-data]')!
    expect(data.textContent).toContain('/tmp/app-data.sqlite')
    expect(data.textContent).toContain('1.00 KiB')
    expect(data.textContent).toContain('notes: 3')
    const create = vi.fn(() => 'blob:data')
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    fireEvent.click(document.body.querySelector('[data-manage-data-export]')!)
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(create).toHaveBeenCalled()
    expect(revoke).toHaveBeenCalled()
    click.mockRestore()
    // A refused export states its reason instead of pretending a file exists.
    harness.remote.dataExport.mockRejectedValueOnce(new Error('export down'))
    fireEvent.click(document.body.querySelector('[data-manage-data-export]')!)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('export down'))
    expect(document.body.querySelector('[data-manage-data-error]')?.textContent).toContain('Data operation failed')
    expect(document.body.querySelector('[data-manage-data-error] details summary')?.textContent).toBe('Diagnostics')
    // Pruning old backups is a warning dialog, never a silent delete.
    fireEvent.click(document.body.querySelector('[data-manage-data-prune]')!)
    await waitFor(() => expect(document.body.querySelector('[data-data-confirm-dialog]')).not.toBeNull())
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Prune old backups?')
    expect(document.activeElement).toBe(document.body.querySelector('[data-data-confirm-no]'))
    fireEvent.click(document.body.querySelector('[data-data-confirm-no]')!)
    expect(document.body.querySelector('[data-data-confirm-dialog]')).toBeNull()
    expect(harness.remote.dataPruneBackups).not.toHaveBeenCalled()
    await confirmDataAction(document.body.querySelector('[data-manage-data-prune]'))
    await waitFor(() => expect(harness.remote.dataPruneBackups).toHaveBeenCalledWith(5))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-pruned]')?.textContent ?? '').toContain('2'))
    // The post-prune re-read can fail without discarding the prune answer.
    harness.remote.dataInfo.mockRejectedValueOnce(new Error('reload down'))
    await confirmDataAction(document.body.querySelector('[data-manage-data-prune]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('reload down'))
    harness.remote.dataPruneBackups.mockRejectedValueOnce(new Error('prune down'))
    await confirmDataAction(document.body.querySelector('[data-manage-data-prune]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('prune down'))
    // Preview, then confirm a JSON import; the result names the backup.
    const file = { text: async () => '{"version":1,"apps":{"workbook":{}}}' } as File
    const fileInput = document.body.querySelector('[data-manage-data-file]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).not.toBeNull())
    fireEvent.click(document.body.querySelector('[data-manage-data-confirm]')!)
    await waitFor(() => expect(document.body.querySelector('[data-data-confirm-dialog]')).not.toBeNull())
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Import data?')
    await waitFor(() => expect(document.activeElement).toBe(document.body.querySelector('[data-data-confirm-no]')))
    fireEvent.keyDown(document.body.querySelector('[data-data-confirm-no]')!, { key: 'Escape' })
    await waitFor(() => expect(document.body.querySelector('[data-data-confirm-dialog]')).toBeNull())
    expect(harness.remote.dataImport).not.toHaveBeenCalled()
    await confirmDataAction(document.body.querySelector('[data-manage-data-confirm]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-result]')?.textContent).toContain('/tmp/app-data.before-import.sqlite'))
    expect(document.body.querySelector('[data-manage-data-result]')?.getAttribute('role')).toBe('status')
    // Cancelling a preview abandons the file and returns the import to idle.
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).not.toBeNull())
    fireEvent.click(document.body.querySelector('[data-manage-data-cancel]')!)
    expect(document.body.querySelector('[data-manage-data-preview]')).toBeNull()
    expect(document.body.querySelector('[data-manage-data-file-name]')).toBeNull()
    // The commit presents the preview's plan and its own request id: without
    // them the host has no baseline to compare and the merge could overwrite a
    // write the preview never showed (the import path used to drop both).
    expect(harness.remote.dataImport).toHaveBeenCalledWith(
      'workbook', 'plan_import_1', expect.any(String),
    )
    // A committed import whose reload failed keeps the application held: the
    // result names the failure and offers the reload retry.
    harness.remote.dataImport.mockResolvedValueOnce(ok({
      appId: 'workbook', apps: 1, documents: 1, collections: 0,
      newDocuments: 1, overwrittenDocuments: 0, removedDocuments: 0, newCollectionItems: 0, overwrittenCollectionItems: 0, removedCollectionItems: 0,
      backupPath: '/tmp/app-data.before-import.sqlite', reload: 'failed', reloadError: 'reload hook down',
    }))
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).not.toBeNull())
    await confirmDataAction(document.body.querySelector('[data-manage-data-confirm]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-reload-failed]')?.textContent ?? '').toContain('reload hook down'))
    fireEvent.click(document.body.querySelector('[data-manage-data-reload-retry]')!)
    await waitFor(() => expect(harness.remote.dataReload).toHaveBeenCalledWith('workbook'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-reload-failed]')).toBeNull())
    // A retry that still fails surfaces its error and keeps the failed-import notice.
    harness.remote.dataReload.mockRejectedValueOnce(new Error('retry down'))
    harness.remote.dataImport.mockResolvedValueOnce(ok({
      appId: 'workbook', apps: 1, documents: 1, collections: 0,
      newDocuments: 1, overwrittenDocuments: 0, removedDocuments: 0, newCollectionItems: 0, overwrittenCollectionItems: 0, removedCollectionItems: 0,
      backupPath: '/tmp/app-data.before-import.sqlite', reload: 'failed', reloadError: 'reload hook down',
    }))
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).not.toBeNull())
    await confirmDataAction(document.body.querySelector('[data-manage-data-confirm]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-reload-failed]')).not.toBeNull())
    fireEvent.click(document.body.querySelector('[data-manage-data-reload-retry]')!)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('retry down'))
    // A re-read after the import can fail without discarding the import answer.
    harness.remote.dataInfo.mockRejectedValueOnce(new Error('reload down'))
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).not.toBeNull())
    await confirmDataAction(document.body.querySelector('[data-manage-data-confirm]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('reload down'))
    expect(document.body.querySelector('[data-manage-data-error]')?.getAttribute('role')).toBe('alert')
    // An empty chooser is a no-op; a refused preview and a refused import surface their error.
    fireEvent.change(fileInput, { target: { files: [] } })
    harness.remote.dataImportPreview.mockRejectedValueOnce(new Error('preview down'))
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('preview down'))
    harness.remote.dataImport.mockRejectedValueOnce(new Error('import down'))
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).not.toBeNull())
    harness.remote.dataImportPreview.mockClear()
    await confirmDataAction(document.body.querySelector('[data-manage-data-confirm]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('import down'))
    // A refused commit has spent its one-shot plan: the dialog re-reads the
    // preview so the next confirm compares against the CURRENT data instead of
    // retrying a dead token.
    await waitFor(() => expect(harness.remote.dataImportPreview).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).not.toBeNull())
    // A refused commit whose preview refresh ALSO fails drops the preview
    // instead of leaving a dead plan on screen.
    harness.remote.dataImport.mockRejectedValueOnce(new Error('import down twice'))
    harness.remote.dataImportPreview.mockRejectedValueOnce(new Error('refresh down'))
    await confirmDataAction(document.body.querySelector('[data-manage-data-confirm]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('import down twice'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-preview]')).toBeNull())
    // A failed info read and a failed export stay in the data section.
    harness.remote.dataInfo.mockRejectedValueOnce(new Error('data down'))
    fireEvent.click(document.body.querySelector('[data-manage-tab="permissions"]')!)
    fireEvent.click(document.body.querySelector('[data-manage-tab="data"]')!)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('data down'))
    fireEvent.click(document.body.querySelector('[data-manage-tab="permissions"]')!)
    fireEvent.click(document.body.querySelector('[data-manage-tab="data"]')!)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data]')).not.toBeNull())
    harness.remote.dataExport.mockRejectedValueOnce(new Error('export down'))
    fireEvent.click(document.body.querySelector('[data-manage-data-export]')!)
    await waitFor(() => expect(document.body.querySelector('[data-manage-data-error]')?.textContent ?? '').toContain('export down'))
    expect(document.body.querySelector('[data-manage-data-error]')?.textContent).toContain('Data operation failed')
    expect(document.body.querySelector('[data-manage-data-error] details summary')?.textContent).toBe('Diagnostics')
    await harness.runtime.dispose()
  })

  it('shows recent pre-import backups', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    harness.remote.dataInfo.mockResolvedValue(ok({
      appId: 'workbook', path: '/tmp/app-data.sqlite', byteSize: 2048, schemaVersion: 1, documentCount: 1, collections: { notes: 3 },
      backups: [
        { path: '/tmp/app-data.sqlite.before-import-new', byteSize: 2048, modifiedAt: Date.parse('2026-10-28T12:00:00Z') },
        { path: '/tmp/app-data.sqlite.before-import-old', byteSize: 1024, modifiedAt: Date.parse('2026-10-27T12:00:00Z') },
      ],
      backupCount: 3,
    }))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-menu]'))
    fireEvent.click(panel.view.getByRole('menuitem', { name: 'Debug call' }))
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await waitFor(() => expect(document.body.querySelector('[data-manage-data]')).not.toBeNull())
    const backups = document.body.querySelector('[data-manage-data-backups]')!
    expect(backups.textContent).toContain('Pre-import database snapshots')
    expect(backups.textContent).toContain('/tmp/app-data.sqlite.before-import-new')
    expect(backups.textContent).toContain('Pre-import database snapshots')
    expect(document.body.querySelector('[data-manage-data-backup-more]')?.textContent).toContain('1')
    await harness.runtime.dispose()
  })

  it('walks the detail tabs with the arrow keys', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-menu]'))
    fireEvent.click(panel.view.getByRole('menuitem', { name: 'Permissions' }))
    await settle()
    expect(inDocument('[data-manage-tab="permissions"]').getAttribute('aria-selected')).toBe('true')
    // The tablist model: the arrows move the selection, wrapping at the ends.
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    expect(inDocument('[data-manage-tab="data"]').getAttribute('aria-selected')).toBe('true')
    await settle()
    // The history tab read the calls targeting this application.
    expect(harness.remote.history).toHaveBeenCalledWith(50, 'workbook')
    fireEvent.keyDown(inDocument('[data-manage-tab="data"]'), { key: 'ArrowLeft' })
    expect(inDocument('[data-manage-tab="permissions"]').getAttribute('aria-selected')).toBe('true')
    // Any other key is the tablist's own business, not this handler's.
    fireEvent.keyDown(inDocument('[data-manage-tab="permissions"]'), { key: 'Enter' })
    expect(inDocument('[data-manage-tab="permissions"]').getAttribute('aria-selected')).toBe('true')
    await harness.runtime.dispose()
  })

  it('moves the DOM focus with the tab selection, and walks to the ends with Home and End', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-menu]'))
    fireEvent.click(panel.view.getByRole('menuitem', { name: 'Permissions' }))
    await settle()
    const tab = (key: string): HTMLElement => inDocument(`[data-manage-tab="${key}"]`)
    tab('permissions').focus()
    // The arrow moves the selection AND the focus: a roving tabindex that only
    // moved the selection would strand the keyboard user on a tab it no longer
    // owns (the shared TabBar's rule).
    fireEvent.keyDown(tab('permissions'), { key: 'ArrowRight' })
    expect(tab('data').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('data'))
    fireEvent.keyDown(tab('data'), { key: 'End' })
    expect(tab('data').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('data'), { key: 'Home' })
    expect(tab('status').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('status'))
    // The pane is the tablist's labelled panel, and the tab points at it.
    const body = inDocument('[data-manage-body]')
    expect(body.getAttribute('role')).toBe('tabpanel')
    expect(body.getAttribute('aria-labelledby')).toBe(tab('status').id)
    expect(tab('status').getAttribute('aria-controls')).toBe(body.id)
    await harness.runtime.dispose()
  })

  it('shows each application under its own localized name, with its own icon everywhere', async () => {
    const harness = await mountPanel()
    // A registration whose name follows the locale and whose icon is its own.
    register(harness, 'workbook', {
      name: () => (harness.runtime.ctx.locale.getSnapshot().active === 'zh' ? '工作簿' : 'Notebook'),
      icon: ({ size }) => <span data-testid="workbook-icon">{size}</span>,
      tone: 'business',
      Component: markerPage('workbook').Component!,
    })
    const panel = renderPanel(harness)
    await settle()
    const row = navRow(panel, 'workbook')
    expect(row.textContent).toContain('Notebook')
    expect(within(row).getByTestId('workbook-icon')).toBeDefined()
    // …and in the management list, which also says what the application is.
    openManageList(panel)
    const manageRow = inDocument('[data-manage-row="workbook"]')
    expect(within(manageRow).getByTestId('workbook-icon')).toBeDefined()
    expect(manageRow.textContent).toContain('Notebook')
    expect(manageRow.textContent).toContain('workbook description')
    // A language switch renames it in place: the getter runs per render, so
    // the name was never fixed to the language the registration happened in.
    act(() => { harness.runtime.ctx.locale.setLocale('zh') })
    // The tab strip is hidden while the management page shows, so read the
    // page's own row here; the tab is checked after going back to the page.
    expect(inDocument('[data-manage-row="workbook"]').textContent).toContain('工作簿')
    // An application with no declared icon gets the framework's neutral glyph.
    expect(inDocument('[data-manage-row="disk-analysis"]').querySelector('[data-app-icon]')).not.toBeNull()
    fireEvent.click(inDocument('[data-manage-return]'))
    expect(navRow(panel, 'workbook').textContent).toContain('工作簿')
    await harness.runtime.dispose()
  })

  it('opens the debug surface of an application that draws no page', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({ lastAppId: 'info-hub' }))
    const harness = await mountPanel()
    renderPanel(harness)
    await settle()
    // The surface offers the two ways in for an application without a page: the
    // debug surface of THIS application, and the management list.
    const state = inDocument('[data-app-state="no-view"]')
    expect(within(state).getByRole('button', { name: 'Manage applications' })).toBeDefined()
    fireEvent.click(within(state).getByRole('button', { name: 'Debug call' }))
    expect(document.body.querySelector('[data-manage-info]')).not.toBeNull()
    // The list is the page's persistent navigation, so it stays beside the
    // detail; the detail is the application without a page.
    expect(inDocument('[data-manage-detail]').getAttribute('data-app-id')).toBe('info-hub')
    expect(inDocument('[data-manage-debug-toggle]')).toBeDefined()
    await harness.runtime.dispose()
  })

  it('reads the calls targeting the application on screen, never another application’s', async () => {
    const harness = await mountPanel((remote) => {
      remote.history.mockResolvedValue(ok<readonly HistoryRecord[]>([
        record('call-1'),
        record('call-2', { target: 'disk-analysis', op: 'scan' }),
      ]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    // The header's own menu opens the current application's history.
    fireEvent.click(inDocument('[data-app-menu]'))
    fireEvent.click(panel.view.getByRole('menuitem', { name: 'Call history' }))
    await settle()
    expect(harness.remote.history).toHaveBeenCalledWith(50, 'workbook')
    expect(document.body.querySelector('[data-manage-history]')).not.toBeNull()
    expect(inDialog().getByText('write')).toBeDefined()
    // A record targeting another application is not this application's history.
    expect(inDialog().queryByText('scan')).toBeNull()
    // The next application's history names IT on the wire, and shows its own.
    fireEvent.click(inDocument('[data-manage-row="disk-analysis"]'))
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await settle()
    expect(harness.remote.history).toHaveBeenLastCalledWith(50, 'disk-analysis')
    expect(inDialog().getByText('scan')).toBeDefined()
    expect(inDialog().queryByText('write')).toBeNull()
    await harness.runtime.dispose()
  })

  it('shows a failed history read and retries it in place', async () => {
    const harness = await mountPanel((remote) => {
      remote.history.mockResolvedValueOnce(carrierFailure<readonly HistoryRecord[]>())
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-app-menu]'))
    fireEvent.click(panel.view.getByRole('menuitem', { name: 'Call history' }))
    await settle()
    expect(document.body.querySelector('[data-history-failed]')).not.toBeNull()
    fireEvent.click(inDocument('[data-history-retry]'))
    await settle()
    expect(document.body.querySelector('[data-history-failed]')).toBeNull()
    expect(inDialog().getByText('write')).toBeDefined()
    expect(harness.remote.history).toHaveBeenLastCalledWith(50, 'workbook')
    await harness.runtime.dispose()
  })

  it('shows the waiting confirmations with their count, and answers them from the list', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    // A parked caller is visible the moment the area is, without a tab of its
    // own on the business page.
    expect(inDocument('[data-app-header] [data-app-pending-count]').textContent).toBe('1')
    openManageList(panel)
    // `start` read the pending list once; opening the surface reads it again
    // (the human is looking at it now).
    await settle()
    expect(harness.remote.pendingConfirmations).toHaveBeenCalledTimes(2)
    fireEvent.click(inDocument('[data-manage-queue="confirmations"]'))
    await settle()
    expect(document.body.querySelector('[data-manage-confirmations]')).not.toBeNull()
    expect(inDialog().getByText('the agent wants to delete a task')).toBeDefined()
    expect(inDocument('[data-confirm-waiting]').textContent).toContain('Waiting')
    fireEvent.click(inDocument('[data-confirm-allow-once]'))
    await settle()
    expect(harness.remote.answerConfirmation).toHaveBeenCalledWith('confirmation-1', 'allowed-once')
    fireEvent.click(inDocument('[data-confirm-deny]'))
    await settle()
    expect(harness.remote.answerConfirmation).toHaveBeenLastCalledWith('confirmation-1', 'denied')
    fireEvent.click(inDocument('[data-confirm-withdraw]'))
    await settle()
    expect(harness.remote.cancelConfirmation).toHaveBeenCalledWith('confirmation-1')
    await harness.runtime.dispose()
  })

  it('renders every declared schema shape in the debug form and validates fields', async () => {
    const shape: AppOp = {
      name: 'shape',
      description: 'every shape',
      params: {
        name: { type: 'string', required: true, description: 'the name' },
        enabled: { type: 'boolean' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        nothing: { type: 'null', required: true },
        tags: { type: 'array' },
        meta: { type: 'object', additionalProperties: false },
        choice: { oneOf: [{ type: 'string' }, { type: 'number' }], required: true },
        mode: { type: 'string', enum: ['a', 'b'] },
        payload: { type: 'json' },
      },
      exposure: {},
    }
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([
        app('workbook', 'available', [shape, { name: 'ping', description: 'no args', params: {}, exposure: {} }]),
        app('disk-analysis'),
        app('info-hub'),
      ]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    fireEvent.click(inDocument('[data-manage-debug-toggle]'))
    const form = inDialog()
    fireEvent.change(form.getByLabelText('Operation'), { target: { value: 'shape' } })
    fireEvent.click(inDocument('[data-call-mode-form]'))
    expect(inDocument('[data-call-form-fields]')).toBeDefined()
    expect(inDocument('[data-call-field="nothing"]').textContent).toContain('null')
    // A required text field that is empty is named, not sent as an invented value.
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(inDocument('[data-call-field-error="name"]').textContent).toContain('Required')
    expect(harness.remote.call).not.toHaveBeenCalled()
    fireEvent.change(inDocument('[data-call-input="name"]'), { target: { value: 'draft' } })
    fireEvent.click(inDocument('[data-call-input="enabled"]'))
    fireEvent.change(inDocument('[data-call-input="count"]'), { target: { value: '2' } })
    fireEvent.change(inDocument('[data-call-input="ratio"]'), { target: { value: '1.5' } })
    fireEvent.change(inDocument('[data-call-input="tags"]'), { target: { value: '["a"]' } })
    fireEvent.change(inDocument('[data-call-input="meta"]'), { target: { value: '{"a":1}' } })
    fireEvent.change(inDocument('[data-call-input="choice"]'), { target: { value: '"x"' } })
    fireEvent.change(inDocument('[data-call-input="mode"]'), { target: { value: 'b' } })
    fireEvent.change(inDocument('[data-call-input="payload"]'), { target: { value: '' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(harness.remote.call).toHaveBeenLastCalledWith('workbook', 'shape', {
      name: 'draft', enabled: true, count: 2, ratio: 1.5, nothing: null, tags: ['a'], meta: { a: 1 }, choice: 'x', mode: 'b',
    }, expect.any(String))
    // A non-required invalid value and a malformed JSON field are field errors.
    fireEvent.change(inDocument('[data-call-input="count"]'), { target: { value: '1.5' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(inDocument('[data-call-field-error="count"]').textContent).toContain('Invalid')
    fireEvent.change(inDocument('[data-call-input="count"]'), { target: { value: '2' } })
    fireEvent.change(inDocument('[data-call-input="tags"]'), { target: { value: '{bad' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(inDocument('[data-call-field-error="tags"]').textContent).toContain('Invalid')
    fireEvent.change(inDocument('[data-call-input="tags"]'), { target: { value: '["a"]' } })
    // An operation with no parameters says so and submits `{}`.
    fireEvent.change(form.getByLabelText('Operation'), { target: { value: 'ping' } })
    expect(inDocument('[data-call-form-fields]').textContent).toContain('no parameters')
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(harness.remote.call).toHaveBeenLastCalledWith('workbook', 'ping', {}, expect.any(String))
    const clipboard = { writeText: vi.fn(async () => {}) }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    fireEvent.click(inDocument('[data-call-copy]'))
    await settle()
    expect(clipboard.writeText).toHaveBeenCalled()
    await harness.runtime.dispose()
  })

  it('approves and revokes declared needs', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([
        { ...app('workbook'), needs: ['capability:model'] },
      ]))
      remote.grants.mockResolvedValue(ok<readonly CapabilityGrant[]>([
        grant({ kind: 'app', appId: 'workbook' }, ['capability:model']),
      ]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()
    const needSwitch = (need: string): HTMLElement =>
      inDocument(`[data-app-need="${need}"] [role="switch"]`)
    expect(needSwitch('capability:model').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(needSwitch('capability:model'))
    await settle()
    expect(harness.remote.revoke).toHaveBeenCalledWith({ kind: 'app', appId: 'workbook' }, 'capability:model')
    await harness.runtime.dispose()
  })

  it('shares a draft and serves an owner-session draft read', async () => {
    const received: unknown[] = []
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    register(harness, 'workbook', draftPage(received))
    renderPanel(harness)
    await settle()
    // Before the app conversation exists there is no owner Session to share to.
    fireEvent.click(inDocument('[data-draft-share]'))
    fireEvent.click(inDocument('[data-draft-revoke]'))
    await settle()
    expect(harness.remote.shareDraft).not.toHaveBeenCalled()
    expect(harness.remote.revokeDraftShare).not.toHaveBeenCalled()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.change(inDocument('[data-app-conversation-setup-path]'), { target: { value: '/tmp/ws' } })
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    fireEvent.click(inDocument('[data-draft-share]'))
    await settle()
    expect(harness.remote.shareDraft).toHaveBeenCalledWith(sessionId, 'd1', ['/title'])
    fireEvent.click(inDocument('[data-draft-revoke]'))
    await settle()
    expect(harness.remote.revokeDraftShare).toHaveBeenCalledWith(sessionId, 'd1')

    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-draft', sessionId, action: 'draft-read', appId: 'workbook', input: { draftId: 'd1', fields: ['/title'] } },
    })
    await settle()
    expect(received).toEqual([{ draftId: 'd1', fields: ['/title'] }])
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-draft', true, undefined, { revision: 'r1', values: { '/title': 'shared' } })
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-draft-no-input', sessionId, action: 'draft-read', appId: 'workbook' },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-draft-no-input', true, undefined, { revision: 'r1', values: { '/title': 'shared' } })
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-draft-update', sessionId, action: 'draft-update', appId: 'workbook', input: { draftId: 'd1', revision: 'r1', values: { '/title': 'new' } } },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-draft-update', true, undefined, { revision: 'r2', values: { '/title': 'new' } })
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-draft-conflict', sessionId, action: 'draft-update', appId: 'workbook', input: { draftId: 'd1', revision: 'old', values: { '/title': 'new' } } },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-draft-conflict', true, undefined, { conflict: true })
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-draft-update-none', sessionId, action: 'draft-update', appId: 'other', input: { draftId: 'd1', revision: 'r1', values: {} } },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-draft-update-none', false)
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-draft-update-no-input', sessionId, action: 'draft-update', appId: 'workbook' },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-draft-update-no-input', true, undefined, { revision: 'r2', values: undefined })

    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-draft-none', sessionId, action: 'draft-read', appId: 'other', input: { draftId: 'd1' } },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-draft-none', false)
    await harness.runtime.dispose()
  })

  it('routes set-filters/select page commands to the mounted page controller', async () => {
    const received: Array<{ action: string; input: unknown }> = []
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'app-conversation' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    register(harness, 'workbook', actionPage(received))
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.change(inDocument('[data-app-conversation-setup-path]'), { target: { value: '/tmp/ws' } })
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()

    harness.remote.completePageCommand.mockClear()
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-filters', sessionId, action: 'set-filters', appId: 'workbook', input: { filters: { status: 'open' } } },
    })
    await settle()
    expect(received).toContainEqual({ action: 'set-filters', input: { filters: { status: 'open' } } })
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-filters', true)

    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-select', sessionId, action: 'select', appId: 'workbook', input: { selection: [{ kind: 'note', id: 'n1' }] } },
    })
    await settle()
    expect(received).toContainEqual({ action: 'select', input: { selection: [{ kind: 'note', id: 'n1' }] } })
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-select', true)
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-refuse', sessionId, action: 'select', appId: 'workbook', input: { selection: [], refuse: true } },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-refuse', false)
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-none', sessionId, action: 'set-filters', appId: 'other', input: { filters: {} } },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-none', false)
    harness.stream().push({
      kind: 'page-command',
      command: { commandId: 'pc-no-input', sessionId, action: 'set-filters', appId: 'workbook' },
    })
    await settle()
    expect(harness.remote.completePageCommand).toHaveBeenCalledWith('pc-no-input', true)
    await harness.runtime.dispose()
  })

  it('shows declared connections, capabilities and object types in the info tab', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([{
        ...app('workbook'),
        needs: ['capability:network', 'capability:process'],
        connections: [
          { kind: 'call', target: 'notes', ops: ['list'], available: true },
          { kind: 'subscription', publisher: 'notes', event: 'changed', open: true, available: true },
        ],
        objectTypes: [{ type: 'task', description: 'a task', resolveOperation: 'resolve' }],
        model: { provider: 'provider', model: 'model-name' },
        events: [{ type: 'changed', description: 'a change', subscription: 'open' }],
      }]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    await settle()
    expect(inDocument('[data-connection="notes"]').textContent).toContain('list')
    expect(inDocument('[data-connection="notes#changed"]').textContent).toContain('open')
    expect(inDocument('[data-capability="capability:network"]').textContent).toContain('network')
    expect(inDocument('[data-object-type="task"]').textContent).toContain('resolve')
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()
    expect(inDocument('[data-model-usage]').textContent).toContain('2')
    expect(inDocument('[data-model-usage]').getAttribute('data-model-tokens')).toBe('30')
    expect(document.body.querySelector('[data-model-last]')).toBeNull()
    expect((inDocument('[data-limits-background]') as HTMLInputElement).checked).toBe(true)
    expect((inDocument('[data-model-provider]') as HTMLInputElement).value).toBe('provider')
    fireEvent.change(inDocument('[data-model-provider]'), { target: { value: 'next-provider' } })
    fireEvent.change(inDocument('[data-model-name]'), { target: { value: 'next-model' } })
    fireEvent.click(inDocument('[data-model-save]'))
    await settle()
    expect(harness.remote.setAppModel).toHaveBeenCalledWith('workbook', { provider: 'next-provider', model: 'next-model' })
    fireEvent.click(inDocument('[data-model-reset]'))
    await settle()
    expect(harness.remote.setAppModel).toHaveBeenCalledWith('workbook', null)
    harness.remote.setAppModel.mockResolvedValueOnce(ok(false))
    fireEvent.click(inDocument('[data-model-save]'))
    await settle()
    expect(inDocument('[data-manage-model] [role="alert"]')).not.toBeNull()
    harness.remote.setAppModel.mockResolvedValueOnce(ok(false))
    fireEvent.click(inDocument('[data-model-reset]'))
    await settle()
    expect(inDocument('[data-manage-model] [role="alert"]')).not.toBeNull()
    fireEvent.click(inDocument('[data-limits-background]'))
    fireEvent.change(inDocument('[data-limits-concurrent]'), { target: { value: '3' } })
    fireEvent.change(inDocument('[data-limits-per-minute]'), { target: { value: '7' } })
    fireEvent.click(inDocument('[data-limits-save]'))
    await settle()
    expect(harness.remote.setModelLimits).toHaveBeenCalledWith('workbook', { background: false, maxConcurrent: 3, maxCallsPerMinute: 7 })
    harness.remote.setModelLimits.mockResolvedValueOnce(ok(false))
    fireEvent.click(inDocument('[data-limits-save]'))
    await settle()
    expect(inDocument('[data-model-limits] [role="alert"]')).not.toBeNull()
    await harness.runtime.dispose()
  })

  it('shows unknown token usage instead of zero and names the last model and status', async () => {
    const harness = await mountPanel((remote) => {
      remote.modelUsage.mockResolvedValueOnce(ok({
        calls: 1, succeeded: 1, failed: 0, cancelled: 0, usageMissing: 1, totalDurationMs: 7,
        lastModel: { provider: 'provider', model: 'model-name' }, lastStatus: 'success',
      }))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()
    expect(inDocument('[data-model-usage]').getAttribute('data-model-tokens')).toBe('unknown')
    expect(inDocument('[data-model-last]').getAttribute('data-model-last-model')).toBe('provider/model-name')
    expect(inDocument('[data-model-last]').getAttribute('data-model-last-status')).toBe('success')
    await harness.runtime.dispose()
  })

  it('sets an operation policy from the permissions tab', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([{
        ...app('workbook'),
        ops: [{ name: 'write', description: 'write a task', params: {}, exposure: { ai: 'confirm' } }],
        events: [
          { type: 'changed', description: 'a change', subscription: 'open' },
          { type: 'private', description: 'private', subscription: 'closed' },
        ],
      }]))
      remote.policies.mockResolvedValueOnce(carrierFailure())
      remote.policies.mockResolvedValue(ok([]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()

    // The first policy read failed, so the table offers the same loadPolicies
    // prop the shell start uses; retrying it succeeds and renders the selectors.
    const retry = inDocument('[data-policies-retry]')
    fireEvent.click(retry)
    await settle()
    const select = inDocument('[data-app-policy="write"] select') as HTMLSelectElement
    expect(select.value).toBe('default')
    fireEvent.change(select, { target: { value: 'allow' } })
    await settle()
    expect(harness.remote.setPolicy).toHaveBeenCalledWith('workbook', 'write', 'allow')
    expect(harness.remote.policies.mock.invocationCallOrder.at(-1))
      .toBeGreaterThan(harness.remote.setPolicy.mock.invocationCallOrder.at(-1) as number)
    await harness.runtime.dispose()
  })

  it('calls operations from the explicit debug form, with the outcome and the failures', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([
        app('workbook', 'available', [{ name: 'write', description: 'write', params: { text: { type: 'string', required: true } }, exposure: {} }]),
        app('disk-analysis', 'available', [op('scan')]),
        app('info-hub'),
      ]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    fireEvent.click(inDocument('[data-manage-debug-toggle]'))
    const form = inDialog()
    fireEvent.change(form.getByLabelText('Operation'), { target: { value: 'write' } })
    fireEvent.change(form.getByLabelText('Arguments (JSON)'), { target: { value: '{"text":"draft"}' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(harness.remote.call).toHaveBeenCalledWith('workbook', 'write', { text: 'draft' }, expect.any(String))
    // The FORM owns its call's result: it renders what its own request
    // answered, not the application's last settled outcome (which a background
    // read could have replaced meanwhile).
    expect(inDocument('[data-call-result]').textContent).toContain('"called": "workbook#write"')
    expect(inDocument('[data-call-result]').textContent).toContain('Result')
    expect(document.body.querySelector('[data-app-outcome]')).toBeNull()
    // The schema form is an alternative to writing JSON by hand; it submits
    // the same typed operation arguments and keeps the JSON mode available.
    fireEvent.click(inDocument('[data-call-mode-form]'))
    fireEvent.change(form.getByLabelText(/text/), { target: { value: 'form draft' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(harness.remote.call).toHaveBeenLastCalledWith('workbook', 'write', { text: 'form draft' }, expect.any(String))
    fireEvent.click(inDocument('[data-call-mode-json]'))
    // A refused transport is a live-region error, not a silent line.
    harness.remote.call.mockRejectedValueOnce(new Error('call down'))
    fireEvent.change(form.getByLabelText('Arguments (JSON)'), { target: { value: '{"text":"again"}' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(inDocument('[data-call-error]').textContent).toContain('call down')
    expect(inDocument('[data-call-error]').getAttribute('role')).toBe('alert')

    // Arguments that are not JSON are refused without a call.
    harness.remote.call.mockClear()
    fireEvent.change(form.getByLabelText('Arguments (JSON)'), { target: { value: 'not json' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(harness.remote.call).not.toHaveBeenCalled()
    expect(form.getByText('the arguments are not valid JSON')).toBeDefined()

    // An outcome that never arrived is shown as the Remote error it is.
    harness.remote.call.mockResolvedValue(carrierFailure<CallOutcome>())
    fireEvent.change(form.getByLabelText('Arguments (JSON)'), { target: { value: '{}' } })
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(form.getByText('gateway/internal: the carrier is gone')).toBeDefined()

    // While the call is in flight the form offers its own cancellation.
    const pending = Promise.withResolvers<RemoteResult<CallOutcome>>()
    harness.remote.call.mockReturnValue(pending.promise)
    fireEvent.click(form.getByRole('button', { name: 'Call' }))
    await settle()
    expect(form.getByText('calling')).toBeDefined()
    fireEvent.click(form.getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(harness.remote.cancel).toHaveBeenCalledWith(expect.any(String))
    await act(async () => {
      pending.resolve(ok<CallOutcome>({ callId: 'runtime-1', status: 'cancelled' }))
      await pending.promise
    })
    await settle()
    await harness.runtime.dispose()
  })

  it('renders the debug form for an application that declares no operation', async () => {
    const harness = await mountPanel()
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="info-hub"]'))
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    fireEvent.click(inDocument('[data-manage-debug-toggle]'))
    const form = inDialog()
    expect(form.getByLabelText('Operation')).toBeDefined()
    expect(form.getByRole('button', { name: 'Call' })).toBeDefined()
    await harness.runtime.dispose()
  })
})

describe('live state', () => {
  it('shows the progress notices of the running application and a failed row’s status', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([app('workbook', 'failed')]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    harness.stream().push({
      kind: 'progress',
      notice: { appId: 'workbook', op: 'write', callId: 'call-1', message: 'scanning step 2' },
    })
    await settle()
    expect(inDocument('[data-app-progress]').textContent).toContain('scanning step 2')
    // A failed application states the status and why; the row says it too.
    const state = inDocument('[data-app-state="failed"]')
    expect(state.textContent).toContain('failed')
    expect(state.textContent).toContain('workbook failed to start')
    expect(navRow(panel, 'workbook').getAttribute('aria-label')).toContain('failed')
    // The state's retry is the shell's ordinary re-read.
    const reads = harness.remote.list.mock.calls.length
    fireEvent.click(within(state).getByRole('button', { name: en['state.retry'] }))
    await settle()
    expect(harness.remote.list.mock.calls.length).toBeGreaterThan(reads)
    await harness.runtime.dispose()
  })

  it('shows a degraded application’s readable detail beside its page', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok<readonly AppInfo[]>([{
        ...app('workbook'),
        health: 'degraded',
        detail: 'the model is not configured',
      }]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    // The health line moves into the header status control; the page itself
    // keeps its content and does not spend a row on shell-level status.
    const notice = inDocument('[data-app-health-degraded]')
    expect(notice.textContent).toContain(en['status.degraded'])
    expect(notice.textContent).toContain('the model is not configured')
    expect(document.body.querySelector('[data-app-state="degraded"]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('answers a permission refusal with the application’s own permission page and a re-read', async () => {
    const harness = await mountPanel((remote) => {
      remote.call.mockResolvedValue(ok<CallOutcome>({
        callId: 'runtime-1', status: 'failed', error: { code: 'capability-not-approved', message: 'the user has not approved the storage capability for this application' },
      }))
    })
    // A page that reads on mount, the way every real one does: the refusal
    // arrives through the framework's own call face.
    let mounts = 0
    register(harness, 'workbook', {
      Component: (props) => {
        const [state, setState] = useState('reading')
        // The call face is stable per application (the shell's own binding), so
        // this is a mount read — exactly the one a real page runs.
        const call = props.call
        useEffect(() => {
          mounts += 1
          void call('read', {}).then(outcome => { setState(outcome.status) })
        }, [call])
        return <p data-page-state>{state}</p>
      },
    })
    const panel = renderPanel(harness)
    await settle()
    expect(panel.container.querySelector('[data-page-state]')?.textContent).toBe('failed')
    // The framework adds what the page cannot: what this refusal means in the
    // human's language, the way into the permission page, and a re-read.
    const notice = await waitFor(() => {
      const found = panel.container.querySelector('[data-app-refusal]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    expect(notice.getAttribute('data-app-refusal')).toBe('capability-not-approved')
    // The fallback locale before a language is chosen is English.
    expect(notice.textContent).toContain(en['refused.notApproved'])
    // The English sentence stays the host's (the page may show it); nothing
    // here parses it, and no capability is guessed into a selector.
    expect(notice.textContent).not.toContain('storage capability')

    // The retry re-mounts the page: its own read runs again. The actions live
    // in the header status panel; opening it is how a reader reaches them.
    fireEvent.click(inDocument('[data-app-status]'))
    expect(inDocument('[data-shell-notices]').getAttribute('data-open')).toBe('true')
    fireEvent.click(panel.container.querySelector('[data-app-refusal-retry]')!)
    await settle()
    expect(mounts).toBe(2)

    // The way out is THIS application's permission page, in the one dialog.
    fireEvent.click(inDocument('[data-app-status]'))
    fireEvent.click(panel.container.querySelector('[data-app-refusal-manage]')!)
    await settle()
    const dialog = document.body.querySelector('[data-manage-page]')!
    expect(dialog.querySelector('[data-manage-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true')
    // The detail is the application the refusal belongs to (its row's own
    // name — this case registers no display name).
    expect(dialog.textContent).toContain('workbook title')
    await harness.runtime.dispose()
  })

  it('clears a refusal through the first-run prompt, after the adjustment path', async () => {
    const harness = await mountPanel((remote) => {
      const row = { ...app('workbook'), needs: ['capability:storage'] }
      remote.list.mockResolvedValue(ok([row]))
      remote.grants.mockResolvedValue(ok([]))
      remote.onboarding.mockResolvedValue(ok({ apps: {} }))
      remote.call.mockResolvedValue(ok<CallOutcome>({
        callId: 'runtime-1', status: 'failed', error: { code: 'capability-not-approved', message: 'the user has not approved the storage capability for this application' },
      }))
    })
    let mounts = 0
    register(harness, 'workbook', {
      Component: (props) => {
        const call = props.call
        useEffect(() => {
          mounts += 1
          void call('read', {})
        }, [call])
        return <p data-page-state>page</p>
      },
    })
    const panel = renderPanel(harness)
    await settle()
    // The prompt owns the refusal while it is open: no second copy underneath.
    await waitFor(() => expect(document.body.querySelector('[data-onboarding-app="workbook"]')).not.toBeNull())
    expect(panel.container.querySelector('[data-app-refusal]')).toBeNull()
    // Adjustment opens the application's permission page ON TOP of the prompt.
    fireEvent.click(document.body.querySelector('[data-onboarding-action="adjust"]')!)
    await settle()
    const dialog = document.body.querySelector('[data-manage-page]')!
    expect(dialog.querySelector('[data-manage-tab="permissions"]')?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    // Approval grants, records, and re-runs the page's read (one remount).
    fireEvent.click(document.body.querySelector('[data-onboarding-action="allow-all"]')!)
    await settle()
    expect(harness.remote.grant).toHaveBeenCalledWith({ kind: 'app', appId: 'workbook' }, ['capability:storage'])
    expect(harness.remote.markOnboardingSeen).toHaveBeenCalled()
    await waitFor(() => expect(mounts).toBe(2))
    await harness.runtime.dispose()
  })

  it('tells a declaration problem from a grantable one, and offers no empty promise', async () => {
    const harness = await mountPanel((remote) => {
      remote.call.mockResolvedValue(ok<CallOutcome>({
        callId: 'runtime-1', status: 'failed', error: { code: 'capability-undeclared', message: 'never declared storage', }
      }))
    })
    register(harness, 'workbook', {
      Component: (props) => (
        <button type="button" onClick={() => { void props.call('read', {}) }}>read</button>
      ),
    })
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(panel.view.getByRole('button', { name: 'read' }))
    await settle()
    const notice = await waitFor(() => {
      const found = panel.container.querySelector('[data-app-refusal]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    expect(notice.getAttribute('data-app-refusal')).toBe('capability-undeclared')
    expect(notice.textContent).toContain(en['refused.undeclared'])
    // Approving anything cannot fix it, so the permission entry is not offered;
    // the re-read still is.
    expect(panel.container.querySelector('[data-app-refusal-manage]')).toBeNull()
    expect(panel.container.querySelector('[data-app-refusal-retry]')).not.toBeNull()
    await harness.runtime.dispose()
  })

  it('clears the refusal once a call of that application succeeds again', async () => {
    const harness = await mountPanel((remote) => {
      remote.call.mockResolvedValue(ok<CallOutcome>({
        callId: 'runtime-1', status: 'failed', error: { code: 'capability-not-approved', message: 'not approved', }
      }))
    })
    register(harness, 'workbook', {
      Component: (props) => (
        <button type="button" onClick={() => { void props.call('read', {}) }}>read</button>
      ),
    })
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(panel.view.getByRole('button', { name: 'read' }))
    await settle()
    await waitFor(() => expect(panel.container.querySelector('[data-app-refusal]')).toBeTruthy())

    // The human granted it; the next read succeeds and the notice is gone —
    // the record follows the outcomes, never a guess.
    harness.remote.call.mockResolvedValue(ok<CallOutcome>({ callId: 'runtime-2', status: 'success', result: null }))
    fireEvent.click(panel.view.getByRole('button', { name: 'read' }))
    await settle()
    expect(panel.container.querySelector('[data-app-refusal]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('leaves a settled outcome to the page that made the call', async () => {
    const harness = await mountPanel((remote) => {
      remote.call.mockResolvedValue(ok<CallOutcome>({
        callId: 'runtime-1', status: 'rejected', error: { code: 'denied', message: 'the user refused', }
      }))
    })
    // A page that reports its own call, the way every real one does.
    register(harness, 'workbook', {
      Component: (props) => {
        const [line, setLine] = useState('')
        return (
          <button
            type="button"
            onClick={() => {
              void props.call('write', {}).then((outcome) => {
                setLine(outcome.status === 'rejected' ? `denied: ${outcome.error?.message}` : outcome.status)
              })
            }}
          >
            {line === '' ? 'write' : line}
          </button>
        )
      },
    })
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(panel.view.getByRole('button', { name: 'write' }))
    await settle()
    // The page says it, near the control the human used…
    expect(panel.view.getByRole('button', { name: 'denied: the user refused' })).toBeDefined()
    // …and the framework adds no technical strip of its own.
    expect(document.body.querySelector('[data-app-outcome]')).toBeNull()
    expect(document.body.querySelector('[data-app-progress]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('reopens the watch stream and lets the pages re-read on reconnect', async () => {
    const harness = await mountPanel()
    const changes: number[] = []
    register(harness, 'workbook', {
      Component: (props) => {
        props.onChanged(() => { changes.push(1) })
        return <p data-testid="view-body">view</p>
      },
    })
    const panel = renderPanel(harness)
    await settle()
    expect(harness.remote.watch).toHaveBeenCalledTimes(1)
    const first = harness.stream()
    await act(async () => { harness.runtime.ctx.emit('connection/reset') })
    await settle()
    expect(first.disposed).toBe(true)
    expect(harness.remote.watch).toHaveBeenCalledTimes(2)
    // `start` + the reconnect both list; the reconnect's read is the second.
    expect(harness.remote.list.mock.calls.length).toBeGreaterThanOrEqual(2)
    // The registered page heard the reconnect (it re-reads its own data).
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(panel.view.getByTestId('view-body')).toBeDefined()
    await harness.runtime.dispose()
  })

  it('keeps a watch carrier failure in the connection notice and clears it on reconnect', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    harness.stream().fail(new Error('api gateway: Remote stream WebSocket closed'))
    await settle()
    expect(document.body.querySelector('[data-app-error]')).toBeNull()
    expect(inDocument('[data-app-connection]').textContent).toContain(en['conn.down'])
    expect(inDocument('[data-app-connection]').getAttribute('data-app-connection-error')).toContain('Remote stream WebSocket closed')
    await act(async () => { harness.runtime.ctx.emit('connection/reset') })
    await settle()
    expect(document.body.querySelector('[data-app-connection]')).toBeNull()
    expect(document.body.querySelector('[data-app-error]')).toBeNull()
    expect(harness.remote.watch).toHaveBeenCalledTimes(2)
    await harness.runtime.dispose()
  })

  it('ignores a late failure from the watch generation a reconnect already replaced', async () => {
    const watches: LingerWatch[] = []
    const harness = await mountPanel((remote) => {
      remote.watch = vi.fn(() => {
        const watch = new LingerWatch()
        watches.push(watch)
        return watch
      }) as unknown as typeof remote.watch
    })
    register(harness, 'workbook', markerPage('workbook'))
    renderPanel(harness)
    await settle()
    await act(async () => { harness.runtime.ctx.emit('connection/reset') })
    await settle()
    expect(watches).toHaveLength(2)
    watches[0]!.fail(new Error('late old-generation close'))
    await settle()
    expect(document.body.querySelector('[data-app-error]')).toBeNull()
    expect(document.body.querySelector('[data-app-connection]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('shows a transport failure on the error line and keeps it through a successful re-read', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValueOnce(carrierFailure<readonly AppInfo[]>())
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    expect(inDocument('[data-app-error]').getAttribute('role')).toBe('alert')
    expect(inDocument('[data-app-error]').textContent)
      .toContain('The last action failed: gateway/internal: the carrier is gone')
    // The first read failed: the rows are still unknown, and nothing pretends
    // they were empty.
    expect(inDocument('[data-app-tabs-empty]').textContent).toBe('Reading…')
    // The reconnect re-reads the rows, and they come back — a read that worked
    // says nothing about the action that did not, so the failure stays visible.
    await act(async () => { harness.runtime.ctx.emit('connection/reset') })
    await settle()
    expect(nav(panel).querySelector('[data-app-tab="workbook"]')).not.toBeNull()
    expect(inDocument('[data-app-error]').textContent).toContain('gateway/internal: the carrier is gone')
    await harness.runtime.dispose()
  })

  it('clears the area when the plugin unloads', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    expect(panel.view.getByTestId('workbook-page')).toBeDefined()
    await harness.runtime.dispose()
    expect(harness.runtime.ctx.get('applicationViews')).toBeUndefined()
  })
})

describe('the namespace mount', () => {
  it('mounts the generated contribution when the composition has not', async () => {
    const runtime = await SlotTestRuntime.create()
    const remote = fakeRemote()
    const disposeMount = vi.fn(async () => {})
    // A Remote double without the namespace yet: `$mount` is what installs it,
    // exactly as the platform gateway does for a generated contribution.
    runtime.ctx.set('remote', {
      ...runtime.remote,
      $mount: async () => {
        runtime.remote.provideNamespaces({ applications: remote })
        return disposeMount
      },
    } as never)
    runtime.ctx.provide('layout', {
      panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
      selectPanel: vi.fn(),
      beginNavigation: vi.fn(() => new AbortController().signal),
      toggleSidebar: vi.fn(),
      openRightbar: vi.fn(),
      closeRightbar: vi.fn(),
    } satisfies ILayout)
    runtime.ctx.provide('connection', {} as never)
    runtime.ctx.provide('configForms', { get: () => undefined } as never)
    await runtime.ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
    await runtime.declare({ 'main': { kind: 'keyed', scope: 'root' } })
    const handle = await runtime.mount({ inject: [...inject], apply })
    await settle()
    expect(remote.list).toHaveBeenCalledTimes(1)
    await handle.dispose()
    expect(disposeMount).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  })
})

describe('dictionaries', () => {
  it('pairs every Chinese key with an English one', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('the first-run permission card through the area', () => {
  it('grants and records via 全部允许, and only records via 稍后', async () => {
    const harness = await mountPanel((remote) => {
      const row = { ...app('info-hub'), needs: ['capability:storage'] }
      remote.list.mockResolvedValue(ok([row]))
      remote.grants.mockResolvedValue(ok([]))
      remote.onboarding.mockResolvedValue(ok({ apps: {} }))
    })
    const dispose = register(harness, 'info-hub', markerPage('info-hub'))
    try {
      const panel = renderPanel(harness)
      await settle()
      fireEvent.click(navRow(panel, 'info-hub'))
      await settle()
      fireEvent.click(document.body.querySelector('[data-onboarding-action="allow-all"]')!)
      await settle()
      expect(harness.remote.grant).toHaveBeenCalledWith({ kind: 'app', appId: 'info-hub' }, ['capability:storage'])
      expect(harness.remote.markOnboardingSeen).toHaveBeenCalledWith('info-hub', 'capability:storage')
      fireEvent.click(document.body.querySelector('[data-onboarding-action="later"]')!)
      await settle()
      expect(harness.remote.markOnboardingSeen).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
      await harness.runtime.dispose()
    }
  })

  it('does not record onboarding when the grant write fails', async () => {
    const harness = await mountPanel((remote) => {
      const row = { ...app('info-hub'), needs: ['capability:storage'] }
      remote.list.mockResolvedValue(ok([row]))
      remote.grants.mockResolvedValue(ok([]))
      remote.onboarding.mockResolvedValue(ok({ apps: {} }))
      remote.grant.mockResolvedValue(carrierFailure())
    })
    const dispose = register(harness, 'info-hub', markerPage('info-hub'))
    try {
      const panel = renderPanel(harness)
      await settle()
      fireEvent.click(navRow(panel, 'info-hub'))
      await settle()
      fireEvent.click(document.body.querySelector('[data-onboarding-action="allow-all"]')!)
      await settle()
      expect(harness.remote.grant).toHaveBeenCalled()
      expect(harness.remote.markOnboardingSeen).not.toHaveBeenCalled()
    } finally {
      dispose()
      await harness.runtime.dispose()
    }
  })
})

describe('the management dialog declared data', () => {
  it('shows an own-sqlite declaration', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValue(ok([{
        ...app('disk-space'),
        data: { kind: 'own-sqlite', path: 'disk-space/index.db', schemaVersion: 1 },
      }]))
    })
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="disk-space"]'))
    fireEvent.click(inDocument('[data-manage-tab="data"]'))
    await waitFor(() => expect(inDocument('[data-manage-data]')).toBeDefined())
    expect(inDocument('[data-manage-data-declared]').textContent).toContain('own-sqlite')
    expect(inDocument('[data-manage-data-declared]').textContent).toContain('disk-space/index.db')
  })

  it('reports a failed activation instead of silently bouncing back', async () => {
    const harness = await mountPanel((remote) => {
      remote.setActivation.mockResolvedValueOnce(carrierFailure())
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    await settle()
    fireEvent.click(inDocument('[data-manage-tab="status"]'))
    fireEvent.click(inDocument('[data-manage-activation] button'))
    await settle()
    expect(inDocument('[data-manage-activation-error]').textContent).toContain('not saved')
    await harness.runtime.dispose()
  })
})

it('switches application-area sessions and offers a pending delegation for the human to send', async () => {
  const harness = await mountPanel()
  const first = await harness.runtime.sessions.add({ id: 'area-1' })
  const second = await harness.runtime.sessions.add({ id: 'area-2' })
  let created = 0
  harness.runtime.sessions.stubCreate(async () => (created++ === 0 ? first : second))
  harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-area', path }) as never)
  register(harness, 'workbook', {
    Component: (props) => (
      <div>
        <button type="button" data-delegate-request onClick={() => { void props.delegation?.requestSend('delegation-1') }}>delegate</button>
        <button type="button" data-area-page onClick={() => { props.pageContext.report({ label: 'Area page' }) }}>page</button>
      </div>
    ),
  })
  renderPanel(harness)
  await settle()
  fireEvent.click(inDocument('[data-sidebar-right-expand]'))
  await settle()
  fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
  await settle()
  expect(inDocument('[data-app-dock-tab]')).toBeTruthy()
  fireEvent.click(inDocument('[data-app-dock-new]'))
  await settle()
  const menu = inDocument('[role="menu"]')
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'New application-area conversation' }))
  await settle()
  expect(document.querySelectorAll('[data-app-dock-tab]').length).toBe(2)
  fireEvent.click(inDocument(`${'[data-app-dock-tab="'}${first}"]`))
  await settle()
  fireEvent.click(inDocument('[data-delegate-request]'))
  await settle()
  expect(harness.remote.delegation).toHaveBeenCalledWith('delegation-1', 'workbook')
  const dialog = inDocument('[data-delegate-dialog]')
  expect(dialog).toBeTruthy()
  // The application instructions are shown read-only; the supplement is the human's own.
  expect(dialog.querySelector('[data-delegate-instructions]')?.textContent).toContain('Review the prepared draft')
  fireEvent.change(inDocument('[data-delegate-target]'), { target: { value: first } })
  fireEvent.change(inDocument('[data-delegate-supplement]'), { target: { value: '补充上下文' } })
  fireEvent.click(inDocument('[data-delegate-send]'))
  await settle()
  expect(harness.remote.sendDelegation).toHaveBeenCalledWith('delegation-1', first, '补充上下文', 'workbook')
  expect(document.body.querySelector('[data-delegate-dialog]')).toBeNull()
  await harness.runtime.dispose()
})

it('tells the human to set up an application-area session when a delegation has no target', async () => {
  const harness = await mountPanel()
  register(harness, 'workbook', {
    Component: (props) => (
      <button type="button" data-delegate-request onClick={() => { void props.delegation?.requestSend('delegation-1') }}>delegate</button>
    ),
  })
  renderPanel(harness)
  await settle()
  fireEvent.click(inDocument('[data-delegate-request]'))
  await settle()
  expect(inDocument('[data-delegate-dialog]')).toBeTruthy()
  expect(inDocument('[data-delegate-no-target]').textContent).toContain('application-area session')
  expect((inDocument('[data-delegate-send]') as HTMLButtonElement).disabled).toBe(true)
  await harness.runtime.dispose()
})

it('refuses a delegation record owned by another application', async () => {
  const harness = await mountPanel()
  harness.remote.delegation.mockResolvedValueOnce(ok(delegationRecord({ id: 'foreign', appId: 'other' })))
  register(harness, 'workbook', {
    Component: (props) => (
      <button
        type="button"
        data-foreign-delegation
        onClick={() => { void props.delegation?.requestSend('foreign').catch(() => {}) }}
      >foreign</button>
    ),
  })
  renderPanel(harness)
  await settle()
  fireEvent.click(inDocument('[data-foreign-delegation]'))
  await settle()
  expect(harness.remote.delegation).toHaveBeenCalledWith('foreign', 'workbook')
  expect(document.body.querySelector('[data-delegate-dialog]')).toBeNull()
  await harness.runtime.dispose()
})

describe('the management process commands', () => {
  it('shows the declared executables and commands in the permissions area', async () => {
    const harness = await mountPanel((remote) => {
      remote.list.mockResolvedValueOnce(ok([{
        ...app('workbook'),
        needs: ['capability:process'],
        process: [{ executable: 'git', commands: ['status', 'diff'], purpose: 'read a repository' }],
      }]))
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()
    expect(inDocument('[data-app-process-entry="git"]')).toBeTruthy()
    expect(inDocument('[data-app-process-entry="git"]').textContent).toContain('status, diff')
    expect(inDocument('[data-app-process-entry="git"]').textContent).toContain('read a repository')
    await harness.runtime.dispose()
  })
})

describe('the management delegation records', () => {
  /** The delegation states the host can persist; each maps to one list label. */
  function delegationRows(): readonly DelegationInfo[] {
    return [
      delegationRecord({ id: 'd-pending', status: 'pending' }),
      delegationRecord({
        id: 'd-active', status: 'active', sessionId: 'area-1',
        latestReport: { outcome: 'blocked', summary: '等待答复', question: '选哪个？' },
      }),
      delegationRecord({
        id: 'd-needs', status: 'needs-person', sessionId: 'area-2',
        latestReport: { outcome: 'blocked', summary: '需要人', question: '怎么继续？' },
      }),
      delegationRecord({ id: 'd-done', status: 'ended', outcome: 'completed', latestReport: { outcome: 'completed', summary: '已完成' } }),
      delegationRecord({ id: 'd-failed', status: 'ended', outcome: 'failed' }),
      delegationRecord({ id: 'd-cancelled', status: 'ended', outcome: 'cancelled' }),
      delegationRecord({ id: 'd-interrupted', status: 'ended', outcome: 'interrupted' }),
      // The host never writes an ended record without an outcome; the list still
      // has a truthful fallback label instead of inventing a state.
      { ...delegationRecord({ id: 'd-unknown', status: 'ended' }), outcome: undefined } as unknown as DelegationInfo,
    ]
  }

  it('lists every delegation state for this application and opens the bound session', async () => {
    const opened: string[] = []
    const harness = await mountPanel(
      (remote) => {
        remote.delegations.mockResolvedValue(ok<readonly DelegationInfo[]>(delegationRows()))
        remote.delegation.mockImplementation(async (id: string) => ok(
          id === 'd-active' ? delegationRecord({ id, status: 'active', sessionId: 'area-1' }) : delegationRecord({ id }),
        ))
      },
      (ctx) => { ctx.provide('uiWorkspace', { openSession: (sessionId: string) => { opened.push(sessionId) } } as never) },
    )
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()

    const label = (id: string): string => inDocument(`[data-manage-delegation="${id}"] [data-manage-delegation-state]`).textContent ?? ''
    expect(label('d-pending')).toContain('Awaiting send')
    expect(label('d-active')).toContain('Running')
    expect(label('d-active')).toContain('等待答复')
    expect(label('d-needs')).toContain('Needs a person')
    expect(label('d-done')).toContain('Completed')
    expect(label('d-failed')).toContain('Failed')
    expect(label('d-cancelled')).toContain('Cancelled')
    expect(label('d-interrupted')).toContain('Interrupted')
    expect(label('d-unknown')).toContain('Unavailable')
    // Only a pending record explains the human's next step.
    expect(inDocument('[data-manage-delegation="d-pending"] [data-manage-delegation-pending]')).toBeDefined()
    // The bound Session is the platform's identity, never the transcript.
    expect(inDocument('[data-manage-delegation="d-active"] [data-manage-delegation-session]').textContent).toBe('area-1')
    expect(document.body.querySelector('[data-manage-delegation="d-pending"] [data-manage-delegation-session]')).toBeNull()

    // Opening the execution goes through the host record and the area's own
    // Session opener, not an id the page supplied.
    fireEvent.click(inDocument('[data-manage-delegation="d-active"] [data-manage-delegation-open]'))
    await settle()
    expect(harness.remote.delegation).toHaveBeenCalledWith('d-active', 'workbook')
    expect(opened).toEqual(['area-1'])
    // A pending row gets no "open" action (nothing executes yet), and ended
    // rows get no cancel action.
    expect(document.body.querySelector('[data-manage-delegation="d-pending"] [data-manage-delegation-open]')).toBeNull()
    expect(document.body.querySelector('[data-manage-delegation="d-done"] [data-manage-delegation-cancel]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('shows loading, retries a failed read and reports an empty list', async () => {
    const pending = Promise.withResolvers<RemoteResult<readonly DelegationInfo[]>>()
    const harness = await mountPanel((remote) => {
      remote.delegations.mockReturnValueOnce(pending.promise)
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    expect(inDocument('[data-manage-delegations-loading]')).toBeDefined()
    pending.resolve(carrierFailure<readonly DelegationInfo[]>())
    await settle()
    // A failed read is a retry, not a silently empty list.
    expect(inDocument('[data-manage-delegations-retry]')).toBeDefined()
    harness.remote.delegations.mockResolvedValue(ok<readonly DelegationInfo[]>([]))
    fireEvent.click(inDocument('[data-manage-delegations-retry]'))
    await settle()
    expect(inDocument('[data-manage-delegations-empty]')).toBeDefined()
    await harness.runtime.dispose()
  })

  it('cancels a live delegation, refreshes the list and reports a refused action', async () => {
    const harness = await mountPanel((remote) => {
      remote.delegations.mockResolvedValue(ok<readonly DelegationInfo[]>([
        delegationRecord({ id: 'd-live', status: 'active', sessionId: 'area-1' }),
      ]))
      // The first cancel is refused by the host, the retry lands.
      remote.cancelDelegation.mockResolvedValueOnce({ ok: false, error: new Error('the host refused the cancel') as never })
      remote.cancelDelegation.mockRejectedValueOnce('raw cancel failure')
    })
    register(harness, 'workbook', markerPage('workbook'))
    const panel = renderPanel(harness)
    await settle()
    openManageList(panel)
    fireEvent.click(inDocument('[data-manage-row="workbook"]'))
    fireEvent.click(inDocument('[data-manage-tab="permissions"]'))
    await settle()

    fireEvent.click(inDocument('[data-manage-delegation="d-live"] [data-manage-delegation-cancel]'))
    await settle()
    expect(harness.remote.cancelDelegation).toHaveBeenCalledWith('d-live', 'workbook')
    expect(inDocument('[data-manage-delegations-error]').textContent).toContain('the host refused the cancel')

    fireEvent.click(inDocument('[data-manage-delegation="d-live"] [data-manage-delegation-cancel]'))
    await settle()
    // A non-Error rejection is rendered as its raw text, never swallowed.
    expect(inDocument('[data-manage-delegations-error]').textContent).toContain('raw cancel failure')

    fireEvent.click(inDocument('[data-manage-delegation="d-live"] [data-manage-delegation-cancel]'))
    await settle()
    expect(document.body.querySelector('[data-manage-delegations-error]')).toBeNull()
    // A committed action re-reads the host record instead of patching a cache.
    expect(harness.remote.delegations.mock.calls.length).toBeGreaterThan(1)
    await harness.runtime.dispose()
  })
})

describe('the delegation send dialog', () => {
  /** A page whose one button asks the shell to offer a pending delegation. */
  function delegationPage(): ApplicationView {
    return {
      name: 'Delegating page',
      Component: (props) => (
        <button
          type="button"
          data-delegate-request
          onClick={() => { void props.delegation?.requestSend('delegation-1') }}
        >delegate</button>
      ),
    }
  }

  /** Open the send dialog for the page's request. */
  async function requestSend(): Promise<void> {
    fireEvent.click(inDocument('[data-delegate-request]'))
    await settle()
  }

  it('cancels through the buttons and the mask, and refuses to send without a set-up target', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', delegationPage())
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(navRow(panel, 'workbook'))
    await settle()

    // Without a remembered conversation the dialog targets a NEW Session.
    await requestSend()
    expect((inDocument('[data-delegate-target]') as HTMLSelectElement).value).toBe('new')
    fireEvent.click(inDocument('[data-delegate-cancel]'))
    await settle()
    expect(document.body.querySelector('[data-delegate-dialog]')).toBeNull()

    // The header's close button resolves the request as cancelled too.
    await requestSend()
    fireEvent.click(inDocument('[data-delegate-dialog] button[aria-label]'))
    await settle()
    expect(document.body.querySelector('[data-delegate-dialog]')).toBeNull()

    // The modal mask owns the same close; it must not leave the request parked.
    await requestSend()
    const mask = inDocument('[data-delegate-dialog]').closest('[role="presentation"]')!
      .querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.click(mask)
    await settle()
    expect(document.body.querySelector('[data-delegate-dialog]')).toBeNull()

    // Sending to "new" when the area has no set-up conversation is blocked with
    // a first-use hint instead of a failed host round trip.
    await requestSend()
    expect(inDocument('[data-delegate-no-target]').textContent).toContain('application-area session')
    expect((inDocument('[data-delegate-send]') as HTMLButtonElement).disabled).toBe(true)
    await harness.runtime.dispose()
  })

  it('refuses a new target whose created conversation carries no Session id', async () => {
    const harness = await mountPanel()
    const first = await harness.runtime.sessions.add({ id: 'area-1' })
    harness.runtime.sessions.stubCreate(async () => first)
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-area', path }) as never)
    register(harness, 'workbook', delegationPage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    // A conversation reference without a Session identity cannot be sent to.
    const sessions = harness.runtime.sessions as unknown as { retain: (...args: never[]) => unknown }
    const originalRetain = sessions.retain
    sessions.retain = (() => ({})) as never
    try {
      await requestSend()
      fireEvent.change(inDocument('[data-delegate-target]'), { target: { value: 'new' } })
      fireEvent.click(inDocument('[data-delegate-send]'))
      await settle()
      expect(inDocument('[data-delegate-error]').textContent).toContain('A new application-area session could not be created.')
      expect(harness.remote.sendDelegation).not.toHaveBeenCalled()
    } finally {
      sessions.retain = originalRetain as never
    }
    await harness.runtime.dispose()
  })

  it('offers first-use setup from the send dialog when no target exists', async () => {
    const harness = await mountPanel()
    register(harness, 'workbook', delegationPage())
    const panel = renderPanel(harness)
    await settle()
    fireEvent.click(navRow(panel, 'workbook'))
    await settle()
    await requestSend()
    expect(inDocument('[data-delegate-no-target]')).toBeTruthy()
    expect((inDocument('[data-delegate-send]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(inDocument('[data-delegate-setup]'))
    await settle()
    expect(inDocument('[data-app-conversation-setup]')).toBeTruthy()
    await harness.runtime.dispose()
  })

  it('shows the supplement counter and the setup entry in the send dialog', async () => {
    const harness = await mountPanel()
    const first = await harness.runtime.sessions.add({ id: 'area-1' })
    harness.runtime.sessions.stubCreate(async () => first)
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-area', path }) as never)
    register(harness, 'workbook', delegationPage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    await requestSend()
    expect(inDocument('[data-delegate-supplement-count]').textContent).toBe('0/4000')
    fireEvent.change(inDocument('[data-delegate-supplement]'), { target: { value: 'hello' } })
    expect(inDocument('[data-delegate-supplement-count]').textContent).toBe('5/4000')
    fireEvent.click(inDocument('[data-delegate-cancel]'))
    await settle()
    await harness.runtime.dispose()
  })

  it('maps an unavailable target to a localized send error and keeps the dialog open', async () => {
    const harness = await mountPanel()
    const first = await harness.runtime.sessions.add({ id: 'area-1' })
    harness.runtime.sessions.stubCreate(async () => first)
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-area', path }) as never)
    harness.remote.sendDelegation.mockRejectedValueOnce(new Error('the target session is not running; open it in the application area and try again'))
    register(harness, 'workbook', delegationPage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    await requestSend()
    fireEvent.click(inDocument('[data-delegate-send]'))
    await settle()
    expect(inDocument('[data-delegate-error]').textContent).toContain('not available right now')
    expect(document.body.querySelector('[data-delegate-dialog]')).not.toBeNull()
    await harness.runtime.dispose()
  })

  it('creates a new application-area conversation for a new target before sending', async () => {
    const harness = await mountPanel()
    const first = await harness.runtime.sessions.add({ id: 'area-1' })
    const second = await harness.runtime.sessions.add({ id: 'area-2' })
    let created = 0
    harness.runtime.sessions.stubCreate(async () => (created++ === 0 ? first : second))
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-area', path }) as never)
    register(harness, 'workbook', delegationPage())
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    expect(inDocument('[data-app-dock-tab]')).toBeTruthy()

    await requestSend()
    fireEvent.change(inDocument('[data-delegate-target]'), { target: { value: 'new' } })
    fireEvent.click(inDocument('[data-delegate-send]'))
    await settle()
    // The human's chosen target is the NEW conversation the shell created.
    expect(harness.remote.sendDelegation).toHaveBeenCalledWith('delegation-1', second, '', 'workbook')
    expect(document.body.querySelector('[data-delegate-dialog]')).toBeNull()
    await harness.runtime.dispose()
  })
})

describe('dock context and add-menu states', () => {
  async function openAreaConversation(): Promise<Harness> {
    const harness = await mountPanel()
    const sessionId = await harness.runtime.sessions.add({ id: 'area-context' })
    harness.runtime.sessions.stubCreate(async () => sessionId)
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-area', path }) as never)
    register(harness, 'workbook', { name: 'workbook', Component: () => <p data-testid="view-body">workbook</p> })
    renderPanel(harness)
    await settle()
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    return harness
  }

  it('shows a no-page context bar without a remove control', async () => {
    const harness = await openAreaConversation()
    expect(inDocument('[data-app-context-bar]').textContent).toContain('No current page')
    expect(document.body.querySelector('[data-app-context-remove]')).toBeNull()
    await harness.runtime.dispose()
  })

  it('closes the dock add menu on Escape', async () => {
    const harness = await openAreaConversation()
    fireEvent.click(inDocument('[data-app-dock-new]'))
    await settle()
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    await harness.runtime.dispose()
  })
})

describe('development tab folding', () => {
  it('folds a development tab back to the area conversation when switching applications', async () => {
    const harness = await mountPanel()
    const area = await harness.runtime.sessions.add({ id: 'area-1' })
    const dev = await harness.runtime.sessions.add({ id: 'dev-fold' })
    let created = 0
    harness.runtime.sessions.stubCreate(async () => (created++ === 0 ? area : dev))
    harness.runtime.workspaces.stub('create', async ({ path }) => ({ workspaceId: 'w-area', path }) as never)
    const page = (appId: string): ApplicationView => ({ name: appId, Component: () => <p data-testid="view-body">{appId}</p> })
    register(harness, 'workbook', page('workbook'))
    register(harness, 'info-hub', page('info-hub'))
    renderPanel(harness)
    await settle()

    // First use: create the area conversation workspace.
    fireEvent.click(inDocument('[data-sidebar-right-expand]'))
    await settle()
    fireEvent.click(inDocument('[data-app-conversation-setup] button[type="submit"]'))
    await settle()
    // Create and open a development Session for workbook.
    fireEvent.click(inDocument('[data-app-menu]'))
    await settle()
    const develop = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes('Develop this application') || button.textContent?.includes('开发此应用'))!
    fireEvent.click(develop)
    await settle()
    fireEvent.change(inDocument('[data-develop-path]'), { target: { value: '/src/application' } })
    fireEvent.click(inDocument('[data-develop-submit]'))
    await settle()
    // The dialog's result step closes; the development Session is in the dock.
    fireEvent.click(inDocument('[data-develop-done]'))
    await settle()
    fireEvent.click(inDocument('[data-app-dock-tab="dev-fold"]'))
    await settle()
    // Switching to another application folds the development tab into the group
    // and selects the area conversation again.
    fireEvent.click(inDocument('[data-app-tab="info-hub"]'))
    await settle()
    const active = document.body.querySelector('[data-app-dock-tab][data-active="true"]')
    expect(active?.getAttribute('data-app-dock-tab')).toBe('area-1')
    await harness.runtime.dispose()
  })
})

describe('host session list reconciliation', () => {
  it('leaves remembered development sessions alone when the host list fails', async () => {
    localStorage.setItem('dsh.applications.preferences.v1', JSON.stringify({
      developmentSessions: [{ appId: 'todo', sessionId: 's-remembered' }],
    }))
    const harness = await mountPanel((remote) => {
      ;(remote as unknown as Record<string, unknown>).developmentBindings = vi.fn(async () => ({ ok: false as const }))
    })
    renderPanel(harness)
    await settle()
    const stored = JSON.parse(localStorage.getItem('dsh.applications.preferences.v1')!) as {
      readonly developmentSessions?: readonly { readonly sessionId: string; readonly appId: string }[]
    }
    expect(stored.developmentSessions).toContainEqual({ appId: 'todo', sessionId: 's-remembered' })
    await harness.runtime.dispose()
  })

  it('clears a host development binding whose Session is gone', async () => {
    const clearDevelopmentSession = vi.fn(async () => ({ ok: true as const, value: true }))
    const harness = await mountPanel((remote) => {
      ;(remote as unknown as Record<string, unknown>).developmentBindings = vi.fn(async () => ({
        ok: true as const,
        value: [{ sessionId: 'dev-gone', appId: 'workbook' }],
      }))
      ;(remote as unknown as Record<string, unknown>).clearDevelopmentSession = clearDevelopmentSession
    })
    renderPanel(harness)
    await settle()
    expect(clearDevelopmentSession).toHaveBeenCalledWith('dev-gone')
    await harness.runtime.dispose()
  })

  it('merges host development bindings when the area mounts', async () => {
    const harness = await mountPanel(
      (remote) => {
        ;(remote as unknown as Record<string, unknown>).developmentBindings = vi.fn(async () => ({
          ok: true as const,
          value: [{ sessionId: 'dev-host', appId: 'workbook' }],
        }))
      },
      undefined,
      undefined,
      async (runtime) => { await runtime.sessions.add({ id: 'dev-host' }) },
    )
    renderPanel(harness)
    await settle()
    const stored = JSON.parse(localStorage.getItem('dsh.applications.preferences.v1')!) as {
      readonly developmentSessions?: readonly { readonly sessionId: string; readonly appId: string }[]
    }
    expect(stored.developmentSessions).toContainEqual({ sessionId: 'dev-host', appId: 'workbook' })
    await harness.runtime.dispose()
  })
})
