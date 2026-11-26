// @vitest-environment jsdom
/**
 * The first-run permission card: when it appears (available, loaded, a missing
 * platform capability, and no record at the current fingerprint), what it says,
 * and the three actions' exact scope. The card is a notification; the allow
 * action only forwards the missing `capability:*` names, never the peer needs.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PermissionOnboarding } from '../src/client/PermissionOnboarding.tsx'
import type { ApplicationsState } from '../src/client/shell.ts'

afterEach(() => { cleanup() })

const t = ((key: string): string => key) as unknown as TranslateNS<'applications'>

const app: AppInfo = {
  id: 'info-hub',
  name: '信息中心',
  description: 'the reading surface',
  version: '1.0.0',
  health: 'ok', activation: 'enabled', runtime: 'ready',
  needs: ['capability:storage', 'capability:network', 'workbook#createTask'],
  ops: [],
}

function state(over: Partial<ApplicationsState> = {}): ApplicationsState {
  return {
    apps: [app],
    activeAppId: app.id,
    runningCalls: [],
    outcomes: new Map(),
    refusals: new Map(),
    progress: [],
    history: [],
    historyLoaded: true,
    historyReading: false,
    historyFailed: false,
    historyTarget: undefined,
    tasks: [],
    tasksLoaded: false,
    tasksReading: false,
    tasksFailed: false,
    policies: [], policiesReading: false, policiesFailed: false, policiesLoaded: false,
    grants: [],
    grantsReading: false,
    grantsFailed: false,
    onboarding: { apps: {} },
    grantsLoaded: true,
    onboardingLoaded: true,
    confirmations: [],
    confirmationsLoaded: true,
    confirmationsReading: false,
    confirmationsFailed: false,
    watching: true,
    connectionError: undefined,
    error: undefined,
    ...over,
  }
}

function card(over: Partial<ApplicationsState> = {}, handlers: Partial<{
  onAllow: (appId: string, capabilities: readonly string[], fingerprint: string) => Promise<boolean>
  onLater: (appId: string, fingerprint: string) => Promise<boolean>
  onManage: (appId: string) => void
}> = {}): ReturnType<typeof render> {
  return render(
    <PermissionOnboarding
      app={app}
      state={state(over)}
      onAllow={handlers.onAllow ?? (async () => true)}
      onLater={handlers.onLater ?? (async () => true)}
      onManage={handlers.onManage ?? (() => {})}
      t={t}
    />,
  )
}

describe('the first-run permission card', () => {
  it('lists the missing platform capabilities', () => {
    card()
    expect(document.body.querySelector('[data-onboarding-app="info-hub"]')).not.toBeNull()
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('onboarding.title')
    expect(dialog?.textContent).toContain('cap.storage')
    expect(dialog?.textContent).toContain('cap.network')
    expect(dialog?.querySelector('[data-onboarding-action="allow-all"]')).not.toBeNull()
    expect(dialog?.querySelector('[data-onboarding-action="adjust"]')).not.toBeNull()
    expect(dialog?.querySelector('[data-onboarding-action="later"]')).not.toBeNull()
  })

  it('uses the registered display name and states how many capabilities "all" covers', () => {
    const localT = ((key: string, params?: Record<string, unknown>): string =>
      params === undefined ? key : `${key}:${String(params.count ?? params.name)}`) as unknown as TranslateNS<'applications'>
    render(
      <PermissionOnboarding
        app={app}
        view={{ name: () => '本地化信息中心' }}
        state={state()}
        onAllow={async () => true}
        onLater={async () => true}
        onManage={() => {}}
        t={localT}
      />,
    )
    expect(document.body.textContent).toContain('onboarding.title:本地化信息中心')
    expect(document.body.querySelector('[data-onboarding-action="allow-all"]')?.textContent).toContain('onboarding.allowAllCount:2')
  })

  it('allow-all forwards only the missing platform capabilities and the fingerprint', async () => {
    const onAllow = vi.fn(async () => true)
    card({}, { onAllow })
    fireEvent.click(document.body.querySelector('[data-onboarding-action="allow-all"]')!)
    expect(onAllow).toHaveBeenCalledWith('info-hub', ['capability:storage', 'capability:network'], 'capability:network|capability:storage')
  })

  it('later records the fingerprint without granting, and adjust opens the permission page', () => {
    const onLater = vi.fn(async () => true)
    const onManage = vi.fn()
    card({}, { onLater, onManage })
    fireEvent.click(document.body.querySelector('[data-onboarding-action="adjust"]')!)
    expect(onManage).toHaveBeenCalledWith('info-hub')
    fireEvent.click(document.body.querySelector('[data-onboarding-action="later"]')!)
    expect(onLater).toHaveBeenCalledWith('info-hub', 'capability:network|capability:storage')
  })

  it('keeps the card and says so when the approval was not saved', async () => {
    const onAllow = vi.fn(async () => false)
    card({}, { onAllow })
    fireEvent.click(document.body.querySelector('[data-onboarding-action="allow-all"]')!)
    await vi.waitFor(() => expect(document.body.querySelector('[data-onboarding-failure]')?.textContent).toContain('onboarding.failed'))
    expect(document.body.querySelector('[data-onboarding-app="info-hub"]')).not.toBeNull()
  })

  it.each([
    ['the grants have not loaded', { grantsLoaded: false }],
    ['the onboarding record has not loaded', { onboardingLoaded: false }],
    ['every capability is already granted', {
      grants: [{ caller: { kind: 'app' as const, appId: app.id }, capabilities: ['capability:storage', 'capability:network'], grantedAt: '2026-01-01T00:00:00.000Z' }],
    }],
    ['the current fingerprint was already answered', {
      onboarding: { apps: { [app.id]: { fingerprint: 'capability:network|capability:storage', seenAt: '2026-01-01T00:00:00.000Z' } } },
    }],
  ])('does not appear when %s', (_label, over) => {
    card(over as Partial<ApplicationsState>)
    expect(document.body.querySelector('[data-onboarding-app="info-hub"]')).toBeNull()
  })

  it('does not appear for an unavailable app or one with no platform capability', () => {
    for (const candidate of [{ ...app, runtime: 'stopped' as const }, { ...app, needs: ['workbook#createTask'] }]) {
      const view = render(
        <PermissionOnboarding app={candidate} state={state()} onAllow={async () => true} onLater={async () => true} onManage={() => {}} t={t} />,
      )
      expect(document.body.querySelector('[data-onboarding-app="info-hub"]')).toBeNull()
      view.unmount()
    }
  })

  it('keeps the card and says so when the "later" answer was not recorded', async () => {
    const onLater = vi.fn(async () => false)
    card({}, { onLater })
    fireEvent.click(document.body.querySelector('[data-onboarding-action="later"]')!)
    await vi.waitFor(() => expect(document.body.querySelector('[data-onboarding-failure]')?.textContent).toContain('onboarding.laterFailed'))
    expect(document.body.querySelector('[data-onboarding-app="info-hub"]')).not.toBeNull()
  })

  it('shows the pending label while a "later" answer is in flight', async () => {
    let resolve!: (value: boolean) => void
    const onLater = (): Promise<boolean> => new Promise((settle) => { resolve = settle })
    card({}, { onLater })
    const button = document.body.querySelector('[data-onboarding-action="later"]')!
    fireEvent.click(button)
    expect(button.textContent).toContain('onboarding.pending')
    await act(async () => { resolve(true) })
  })
})

describe('the first-run prompt as a modal', () => {
  it('treats the modal close control as the same answer as 稍后', async () => {
    const onLater = vi.fn(async () => true)
    card({}, { onLater })
    fireEvent.click(document.body.querySelector('button[aria-label="onboarding.later"]')!)
    await vi.waitFor(() => expect(onLater).toHaveBeenCalledWith('info-hub', 'capability:network|capability:storage'))
  })

  it('does not ask twice while the answer is in flight', async () => {
    let resolve!: (value: boolean) => void
    const onLater = vi.fn(() => new Promise<boolean>((done) => { resolve = done }))
    card({}, { onLater })
    fireEvent.click(document.body.querySelector('[data-onboarding-action="later"]')!)
    fireEvent.click(document.body.querySelector('button[aria-label="onboarding.later"]')!)
    expect(onLater).toHaveBeenCalledTimes(1)
    resolve(true)
    await vi.waitFor(() => expect(document.body.querySelector('[data-onboarding-action="later"]')?.textContent).toBe('onboarding.later'))
  })
})
