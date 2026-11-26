// @vitest-environment jsdom
/**
 * The management page's own actions, driven directly over its props.
 *
 * The panel suites mount the page through the real shell; the shell owns the
 * action-error line and reports a failed health check as a resolved `false`,
 * which is the normal path. The page ALSO guards its own async chain — a
 * `checkHealth` that rejects must clear the "checking" state and paint the
 * header's failure line instead of leaving the button disabled forever. That
 * only happens when the prop itself rejects, so this suite renders the page
 * with that one seam and the rest of its real props.
 */
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo, PendingConfirmation, TaskSnapshot } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ApplicationView } from '../src/client/contract.ts'
import { ManagementPage } from '../src/client/ManagementPage.tsx'
import type { ManagementPageProps } from '../src/client/ManagementPage.tsx'

afterEach(cleanup)

/** One application row the page can show. */
function appRow(id = 'health-app'): AppInfo {
  return {
    id,
    name: `${id} title`,
    description: `${id} description`,
    version: '1.2.3',
    health: 'ok',
    activation: 'enabled',
    runtime: 'ready',
    needs: [],
    ops: [],
  }
}

/** The state the page reads (nothing running, nothing projected yet). */
function state(): ManagementPageProps['state'] {
  return {
    apps: [appRow()],
    error: undefined,
    runningCalls: [],
    tasks: [],
    progress: [],
    outcomes: new Map(),
    tasksReading: false,
    tasksFailed: false,
    tasksLoaded: true,
    confirmations: [],
    confirmationsLoaded: true,
    confirmationsReading: false,
    confirmationsFailed: false,
    grants: [],
    grantsLoaded: false,
    grantsReading: false,
    grantsFailed: false,
    policies: [],
    policiesLoaded: false,
    policiesReading: false,
    policiesFailed: false,
    history: [],
    historyLoaded: false,
    historyReading: false,
    historyFailed: false,
  } as unknown as ManagementPageProps['state']
}

/** Build the page's complete prop set with a stubbed command surface. */
function props(over: Partial<ManagementPageProps> = {}): ManagementPageProps {
  const t = ((key: string) => key) as unknown as ManagementPageProps['t']
  return {
    state: state(),
    views: new Map(),
    request: { appId: 'health-app', tab: 'status' },
    narrow: false,
    currentApp: appRow(),
    currentView: undefined,
    onReturn: vi.fn(),
    notices: [],
    onOpenApp: vi.fn(),
    onNavigate: vi.fn(),
    networkProxy: () => undefined,
    settingsProps: vi.fn(),
    viewProps: vi.fn(),
    scroll: { get: () => undefined, set: () => {}, retain: () => {} },
    loadHistory: vi.fn(),
    loadTasks: vi.fn(),
    loadDataInfo: vi.fn(),
    restorePreview: vi.fn(),
    restoreData: vi.fn(),
    exportData: vi.fn(),
    previewDataImport: vi.fn(),
    importData: vi.fn(),
    loadGrants: vi.fn(),
    loadPolicies: vi.fn(),
    loadConfirmations: vi.fn(),
    setPolicy: vi.fn(async () => true),
    setActivation: vi.fn(async () => true),
    checkHealth: vi.fn(async () => true),
    setAppModel: vi.fn(async () => true),
    loadModelCatalog: vi.fn(),
    loadModelUsage: vi.fn(),
    loadModelLimits: vi.fn(),
    setModelLimits: vi.fn(async () => true),
    grant: vi.fn(async () => true),
    revoke: vi.fn(async () => true),
    answer: vi.fn(async () => true),
    cancelConfirmation: vi.fn(async () => true),
    delegations: vi.fn(async () => []),
    cancelDelegation: vi.fn(),
    openDelegation: vi.fn(async () => true),
    t,
    ...over,
  } as unknown as ManagementPageProps
}

describe('the management page health check', () => {
  it('clears the running state and paints the failure line when the check rejects', async () => {
    const checkHealth = vi.fn(async () => { throw new Error('the check transport died') })
    render(createElement(ManagementPage, props({ checkHealth })))
    const button = document.body.querySelector('[data-health-check]')
    expect(button).toBeInstanceOf(HTMLElement)
    fireEvent.click(button as HTMLElement)
    await waitFor(() => expect(document.body.querySelector('[data-health-error]')).not.toBeNull())
    expect(checkHealth).toHaveBeenCalledWith('health-app')
    expect((document.body.querySelector('[data-health-check]') as HTMLButtonElement).disabled).toBe(false)
  })
})


describe('the management page navigation', () => {
  /** Two applications with distinct names, in host order beta then alpha. */
  function twoApps(): readonly AppInfo[] {
    return [appRow('beta'), appRow('alpha')]
  }

  it('searches and sorts the persistent list without changing the managed application', () => {
    const page = props({
      state: { ...props().state, apps: twoApps() },
      currentApp: appRow('beta'),
      request: { tab: 'status' },
    })
    render(createElement(ManagementPage, page))
    // The current application is marked and its detail is the fallback subject.
    expect(document.querySelector('[data-manage-row="beta"]')?.textContent).toContain('manage.current')
    expect(document.querySelector('[data-manage-detail-name]')?.textContent).toBe('beta title')
    expect(document.querySelector('[data-manage-row="alpha"]')?.textContent).not.toContain('manage.current')
    // A search filters the list only; the detail stays on the managed subject.
    const search = document.querySelector('[data-manage-search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'alpha' } })
    expect(document.querySelector('[data-manage-row="alpha"]')).not.toBeNull()
    expect(document.querySelector('[data-manage-row="beta"]')).toBeNull()
    expect(document.querySelector('[data-manage-detail-name]')?.textContent).toBe('beta title')
    fireEvent.click(document.querySelector('[data-manage-search-clear]') as HTMLElement)
    expect(document.querySelector('[data-manage-row="beta"]')).not.toBeNull()
    // Sorting by name is its own order; the host order is the default.
    const sort = document.querySelector('[data-manage-sort]') as HTMLSelectElement
    fireEvent.change(sort, { target: { value: 'name' } })
    expect([...document.querySelectorAll('[data-manage-row]')].map(row => row.getAttribute('data-manage-row'))).toEqual(['alpha', 'beta'])
    fireEvent.change(sort, { target: { value: 'order' } })
    expect([...document.querySelectorAll('[data-manage-row]')].map(row => row.getAttribute('data-manage-row'))).toEqual(['beta', 'alpha'])
  })

  it('opens the cross-application queues from their fixed entries', () => {
    const confirmation: PendingConfirmation = {
      id: 'confirmation-1', caller: { kind: 'ai', sessionId: 'session-1' },
      capability: 'health-app#delete', reason: 'a delete', at: '2026-01-01T00:00:02.000Z',
    }
    const task: TaskSnapshot = {
      taskId: 'task-1', traceId: 'task-1', appId: 'health-app', kind: 'scan', title: 'Scan', origin: { kind: 'background' },
      state: 'running', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    }
    const page = props({
      state: { ...props().state, confirmations: [confirmation], tasks: [task] },
      currentApp: appRow('health-app'),
      request: { tab: 'status' },
    })
    render(createElement(ManagementPage, page))
    const pending = document.querySelector('[data-manage-queue="confirmations"]') as HTMLElement
    expect(pending.textContent).toContain('1')
    fireEvent.click(pending)
    expect(document.querySelector('[data-manage-queue-view="confirmations"]')).not.toBeNull()
    expect(document.querySelector('[data-manage-confirmations]')).not.toBeNull()
    const running = document.querySelector('[data-manage-queue="running"]') as HTMLElement
    expect(running.textContent).toContain('1')
    fireEvent.click(running)
    expect(document.querySelector('[data-manage-queue-view="running"]')).not.toBeNull()
    expect(document.querySelector('[data-manage-background-task="task-1"]')).not.toBeNull()
  })

  it('opens another application page explicitly and hides the action on the current app', () => {
    const view = { Component: () => null } as unknown as ApplicationView
    const page = props({
      state: { ...props().state, apps: [appRow('alpha'), appRow('other')] },
      views: new Map([['other', view]]),
      currentApp: appRow('alpha'),
      request: { appId: 'other', tab: 'status' },
    })
    render(createElement(ManagementPage, page))
    fireEvent.click(document.querySelector('[data-manage-open-app]') as HTMLElement)
    expect(page.onOpenApp).toHaveBeenCalledWith('other')
    // The current application has no "open" action: the header returns to it.
    cleanup()
    render(createElement(ManagementPage, props({
      state: { ...props().state, apps: [appRow('alpha')] },
      views: new Map([['alpha', view]]),
      currentApp: appRow('alpha'),
      request: { appId: 'alpha', tab: 'status' },
    })))
    expect(document.querySelector('[data-manage-open-app]')).toBeNull()
    expect(document.querySelector('[data-manage-return]')).not.toBeNull()
  })

  it('switches the four detail areas and only offers settings where declared', () => {
    cleanup()
    const onNavigate = vi.fn()
    const page = props({
      state: { ...props().state, apps: [appRow('alpha')] },
      views: new Map([['alpha', { Component: () => null } as unknown as ApplicationView]]),
      currentApp: appRow('alpha'),
      request: { appId: 'alpha', tab: 'status' },
      onNavigate,
    })
    render(createElement(ManagementPage, page))
    const tabs = [...document.querySelectorAll('[role="tab"][data-manage-tab]')].map(tab => tab.getAttribute('data-manage-tab'))
    expect(tabs).toEqual(['status', 'permissions', 'data'])
    fireEvent.click(document.querySelector('[data-manage-tab="permissions"]') as HTMLElement)
    expect(onNavigate).toHaveBeenCalledWith({ appId: 'alpha', tab: 'permissions' })
    cleanup()
    const withSettings = {
      Component: () => null,
      Settings: () => createElement('p', { 'data-testid': 'page-settings' }, 'settings'),
    } as unknown as ApplicationView
    render(createElement(ManagementPage, props({
      state: { ...props().state, apps: [appRow('alpha')] },
      views: new Map([['alpha', withSettings]]),
      currentApp: appRow('alpha'),
      request: { appId: 'alpha', tab: 'settings' },
    })))
    expect([...document.querySelectorAll('[role="tab"][data-manage-tab]')].map(tab => tab.getAttribute('data-manage-tab'))).toEqual(['status', 'permissions', 'data', 'settings'])
    expect(document.querySelector('[data-manage-settings]')).not.toBeNull()
  })

  it('shows the list first on a narrow area, then the detail, and backs out by list then application', () => {
    cleanup()
    const onNavigate = vi.fn()
    const onReturn = vi.fn()
    const page = props({
      state: { ...props().state, apps: twoApps() },
      currentApp: appRow('beta'),
      request: { tab: 'status' },
      narrow: true,
      onNavigate,
      onReturn,
    })
    const view = render(createElement(ManagementPage, page))
    expect(document.querySelector('[data-manage-page]')?.getAttribute('data-view')).toBe('list')
    expect(document.querySelector('[data-manage-list]')).not.toBeNull()
    expect(document.querySelector('[data-manage-detail]')).toBeNull()
    fireEvent.click(document.querySelector('[data-manage-row="alpha"]') as HTMLElement)
    expect(onNavigate).toHaveBeenCalledWith({ appId: 'alpha', tab: 'status' })
    view.rerender(createElement(ManagementPage, { ...page, request: { appId: 'alpha', tab: 'status' } }))
    expect(document.querySelector('[data-manage-page]')?.getAttribute('data-view')).toBe('detail')
    expect(document.querySelector('[data-manage-detail]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-manage-back]') as HTMLElement)
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'status' })
    // Escape in the detail goes back to the list, not out of the area.
    onNavigate.mockClear()
    view.rerender(createElement(ManagementPage, { ...page, request: { appId: 'alpha', tab: 'status' } }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onNavigate).toHaveBeenCalledWith({ tab: 'status' })
    expect(onReturn).not.toHaveBeenCalled()
    // Escape on the list returns to the application.
    view.rerender(createElement(ManagementPage, { ...page, request: { tab: 'status' } }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onReturn).toHaveBeenCalled()
  })
})

/** A shared settings form double: reads a section, writes path ops, notifies like the real one. */
function proxyForm(initial?: string): { form: ConfigForm<{ proxy?: string }>; mutate: ReturnType<typeof vi.fn> } {
  let snapshot = {
    status: 'ready' as const,
    value: initial === undefined ? {} : { proxy: initial },
    base: {},
    user: initial === undefined ? {} : { proxy: initial },
    revision: 1,
    writable: true,
  }
  const listeners = new Set<() => void>()
  const mutate = vi.fn(async (ops: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[]) => {
    const value: Record<string, unknown> = { ...snapshot.value as Record<string, unknown> }
    for (const op of ops) {
      if (op.op === 'set') value[op.path[0]!] = op.value
      else delete value[op.path[0]!]
    }
    snapshot = { ...snapshot, value, user: value, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
    return true
  })
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  }
  return { form: form as unknown as ConfigForm<{ proxy?: string }>, mutate }
}

/** One button by its rendered label (the suite's translator returns the key). */
function buttonByLabel(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button labelled ${label}`)
  return found
}

describe('the application network proxy page', () => {
  it('opens from its fixed list entry and shows the unavailable line without a settings service', () => {
    const onNavigate = vi.fn()
    render(createElement(ManagementPage, props({
      state: { ...props().state, apps: [appRow('alpha')] },
      currentApp: appRow('alpha'),
      request: { tab: 'status' },
      onNavigate,
    })))
    const entry = document.querySelector('[data-manage-setting="network"]') as HTMLElement
    expect(entry).not.toBeNull()
    expect(entry.textContent).toContain('manage.network')
    fireEvent.click(entry)
    expect(onNavigate).toHaveBeenCalledWith({ setting: 'network' })
    cleanup()
    render(createElement(ManagementPage, props({
      state: { ...props().state, apps: [appRow('alpha')] },
      currentApp: appRow('alpha'),
      request: { setting: 'network' },
      networkProxy: () => undefined,
    })))
    expect(document.querySelector('[data-app-network-unavailable]')?.textContent).toBe('network.unavailable')
  })

  it('stages an edit, saves it, refuses an invalid draft and clears the override', async () => {
    const scope = proxyForm('http://127.0.0.1:1212')
    render(createElement(ManagementPage, props({
      state: { ...props().state, apps: [appRow('alpha')] },
      currentApp: appRow('alpha'),
      request: { setting: 'network' },
      networkProxy: () => scope.form,
    })))
    expect(document.querySelector('[data-manage-setting-title]')?.textContent).toBe('manage.network')
    // The saved value is in effect on open, and the badge reads the STORED state.
    expect(document.querySelector('[data-app-network-state]')?.getAttribute('data-app-network-state')).toBe('proxied')
    expect(document.body.textContent).toContain('network.overridden')
    const input = document.getElementById('app-network-proxy') as HTMLInputElement
    expect(input.value).toBe('http://127.0.0.1:1212')
    // No draft means nothing to save; the stored override offers its reset.
    expect(buttonByLabel('network.save').disabled).toBe(true)
    expect(buttonByLabel('network.reset')).not.toBeNull()
    fireEvent.change(input, { target: { value: 'https://127.0.0.1:8080' } })
    // A draft never claims to be enabled: the badge reports the unsaved change,
    // while the state line keeps naming what is actually in effect.
    expect(document.body.textContent).toContain('network.pending')
    expect(document.querySelector('[data-app-network-state]')?.getAttribute('data-app-network-dirty')).toBe('true')
    expect(document.querySelector('[data-app-network-state]')?.getAttribute('data-app-network-state')).toBe('proxied')
    expect(buttonByLabel('network.save').disabled).toBe(false)
    fireEvent.click(buttonByLabel('network.save'))
    await waitFor(() => expect(scope.mutate).toHaveBeenCalled())
    expect(scope.mutate.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['proxy'], value: 'https://127.0.0.1:8080' }])
    await waitFor(() => expect(input.value).toBe('https://127.0.0.1:8080'))
    await waitFor(() => expect(document.body.textContent).toContain('network.overridden'))
    // An http draft is an accepted value too (both schemes route).
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:8080' } })
    expect(input.getAttribute('aria-invalid')).toBeNull()
    // The reset stages a clear; saving it removes the override.
    fireEvent.click(buttonByLabel('network.reset'))
    await waitFor(() => expect(input.value).toBe(''))
    fireEvent.click(buttonByLabel('network.save'))
    await waitFor(() => expect(scope.mutate).toHaveBeenCalledTimes(2))
    expect(scope.mutate.mock.calls[1]?.[0]).toEqual([{ op: 'unset', path: ['proxy'] }])
    // A value the host could never route blocks the save and says why.
    await waitFor(() => expect(input.value).toBe(''))
    fireEvent.change(input, { target: { value: '127.0.0.1:1212' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(`${input.id}-message`)?.textContent).toBe('network.invalid')
    expect(buttonByLabel('network.save').disabled).toBe(true)
    // The same rule refuses a non-http(s) scheme and a credentialed URL.
    for (const draft of ['socks5://127.0.0.1:1080', 'http://alice:pw@127.0.0.1:1212']) {
      fireEvent.change(input, { target: { value: draft } })
      expect(input.value).toBe(draft)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(document.getElementById(`${input.id}-message`)?.textContent).toBe('network.invalid')
      expect(buttonByLabel('network.save').disabled).toBe(true)
    }
  })
})

/** An empty shared form: the row resolves no proxy yet. */
function emptyProxyForm(): ConfigForm<{ proxy?: string }> {
  return proxyForm().form
}

describe('the application network proxy page while unset', () => {
  it('says the backends go direct and shows an example, not a value', () => {
    render(createElement(ManagementPage, props({
      state: { ...props().state, apps: [appRow('alpha')] },
      currentApp: appRow('alpha'),
      request: { setting: 'network' },
      networkProxy: () => emptyProxyForm(),
    })))
    const input = document.getElementById('app-network-proxy') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('network.proxyPlaceholder')
    const state = document.querySelector('[data-app-network-state]')
    expect(state?.getAttribute('data-app-network-state')).toBe('direct')
    expect(state?.textContent).toBe('network.stateDirect')
    expect(document.body.textContent).not.toContain('network.overridden')
    expect(buttonByLabel('network.save').disabled).toBe(true)
  })
})

describe('the management header', () => {
  it('keeps the one return on the left with the current application in the title and the status control', () => {
    const onReturn = vi.fn()
    const page = props({
      state: { ...props().state, apps: [appRow('alpha')] },
      currentApp: appRow('alpha'),
      request: { appId: 'alpha', tab: 'status' },
      onReturn,
      notices: [{ id: 'offline', tone: 'error', text: 'the host is offline' }],
    })
    render(createElement(ManagementPage, page))
    expect(document.querySelector('[data-manage-leave]')).toBeNull()
    const back = document.querySelector('[data-manage-return]')
    expect(back).not.toBeNull()
    expect(back?.getAttribute('aria-label')).toBe('manage.returnApp')
    expect(document.querySelector('[data-manage-current-name]')?.textContent).toContain('alpha title')
    const status = document.querySelector('[data-manage-header] [data-app-status]')
    expect(status).not.toBeNull()
    fireEvent.click(status as HTMLElement)
    const panel = document.querySelector('#app-status-panel-manage')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('the host is offline')
    fireEvent.click(back as HTMLElement)
    expect(onReturn).toHaveBeenCalledTimes(1)
  })
})
