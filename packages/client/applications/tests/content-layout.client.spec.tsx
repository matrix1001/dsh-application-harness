// @vitest-environment jsdom
/**
 * The page's height choice (`contentLayout` in contract.ts), as the surface
 * resolves it at render time:
 *
 * - `flow` — the default, whether the field is absent or spelled out — keeps
 *   exactly today's surface: the page is an ordinary item of the content
 *   column, the outer `.surface` scrolls it, and the framework's own memory
 *   gives the reader their position back per reported view;
 * - `fill` — the framework hands the page the height that is really left beside
 *   the notices (the content column grows to it) and keeps the outer memory out
 *   of the way: the page scrolls and remembers its own reading.
 *
 * The framework notices stay above a `fill` page either way: the connection
 * being down, a transport error, a refusal and the running calls are the
 * human's to see, not the page's to hide.
 *
 * jsdom computes no layout and no scroll: the heights the memory clamps against
 * are stubbed for these cases, exactly as `surface-scroll.client.spec.tsx` does.
 */
import { cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AppSurface, type AppSurfaceProps } from '../src/client/AppSurface.tsx'
import type { ApplicationView } from '../src/client/contract.ts'
import type { ApplicationsState, RefusalCode } from '../src/client/shell.ts'
import { clearSurfaceScroll } from '../src/client/surface-scroll.ts'
import css from '../src/client/ApplicationsArea.module.css'

beforeEach(() => { clearSurfaceScroll() })
afterEach(() => { cleanup(); clearSurfaceScroll() })

/** The row the surface draws; the id and the status are all it reads here. */
const row: AppInfo = {
  id: 'info-hub',
  name: 'Info hub',
  description: 'the reading surface',
  version: '1.0.0',
  health: 'ok', activation: 'enabled', runtime: 'ready',
  needs: [],
  ops: [],
}

/**
 * One registration as the surface receives it: the registry stores the object
 * untouched (`views.ts`), so an absent field here IS a registration that
 * declared nothing.
 * @param contentLayout - the height choice under test; omitted for the default.
 * @returns the registration.
 */
function page(contentLayout?: ApplicationView['contentLayout']): ApplicationView {
  return {
    ...(contentLayout === undefined ? {} : { contentLayout }),
    Component: () => <p data-testid="page-body">page</p>,
  }
}

/** The shell state one surface renders from: the row, nothing running, nothing failed. */
function state(over: Partial<ApplicationsState> = {}): ApplicationsState {
  return {
    apps: [row],
    activeAppId: row.id,
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
    onboarding: undefined,
    grantsLoaded: true,
    onboardingLoaded: false,
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

/** The locale seat: these cases assert structure, not copy. */
const t = ((key: string) => key) as unknown as TranslateNS<'applications'>

/** The shell's page props: the pages below draw a marker and touch none of them. */
const viewProps = (() => ({})) as unknown as AppSurfaceProps['viewProps']

/** An action none of these cases reaches. */
const noop = (): void => {}

/**
 * Render the surface for one registration, with its view reported ready.
 * @param view - the registration (or none: an application with no page).
 * @param over - an optional shell state (the notice case).
 * @returns the render result.
 */
function show(view: ApplicationView | undefined, over: { readonly state?: ApplicationsState } = {}): RenderResult {
  return render(
    <AppSurface
      state={over.state ?? state()}
      app={row}
      view={view}
      viewport={{ appId: row.id, key: 'tab:a', ready: true }}
      anyPage
      readEpoch={0}
      viewProps={viewProps}
      onRetry={noop}
      onRetryRead={noop}
      onManage={noop}
      onManagePermissions={noop}
      onAllowOnboarding={async () => false}
      onLaterOnboarding={async () => false}
      onDebug={noop}
      t={t}
    />,
  )
}

/** One rendered surface's content column (the framework's own layer over the page). */
function content(result: RenderResult): HTMLElement {
  const element = result.container.querySelector('[data-app-content]')
  if (!(element instanceof HTMLElement)) throw new Error('the surface rendered no content column')
  return element
}

/** One rendered surface's outer scroller. */
function scroller(result: RenderResult): HTMLElement {
  const element = result.container.querySelector('[data-app-surface]')
  if (!(element instanceof HTMLElement)) throw new Error('the surface rendered no scroller')
  return element
}

/** jsdom computes no layout: the heights the hook clamps against are stubbed for one case. */
function stubMetrics(scrollHeight = 1000, clientHeight = 200): () => void {
  const proto = HTMLElement.prototype as unknown as { scrollHeight?: unknown; clientHeight?: unknown }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight })
  return () => {
    delete proto.scrollHeight
    delete proto.clientHeight
  }
}

/**
 * Leave one reported view and come back to it, the way the scroll-memory suite
 * does: where the reader lands is the outer memory answering (0 when nothing
 * was remembered for that view).
 * @param view - the registration to render in both directions.
 * @param from - where the reader was before leaving.
 * @returns the scroll position after the return.
 */
function landAfterReturning(view: ApplicationView, from: number): number {
  const first = show(view)
  const element = scroller(first)
  element.scrollTop = from
  act(() => { element.dispatchEvent(new Event('scroll')) })
  first.unmount()
  return scroller(show(view)).scrollTop
}

describe('the page’s height choice', () => {
  it('keeps the outer scroller and its memory for a page that declares nothing', () => {
    const restore = stubMetrics()
    try {
      const view = page()
      expect(content(show(view)).className).not.toContain(css.contentFill)
      expect(landAfterReturning(view, 420)).toBe(420)
    } finally {
      restore()
    }
  })

  it('treats an explicit `flow` exactly as the absent default', () => {
    const restore = stubMetrics()
    try {
      const view = page('flow')
      expect(content(show(view)).className).not.toContain(css.contentFill)
      expect(landAfterReturning(view, 420)).toBe(420)
    } finally {
      restore()
    }
  })

  it('hands a `fill` page the leftover height, and its position to nobody', () => {
    const restore = stubMetrics()
    try {
      const view = page('fill')
      const first = show(view)
      // The height the notices leave is the content column's now: the page
      // inside scrolls itself (the rule lives in the stylesheet spec).
      expect(content(first).className).toContain(css.contentFill)
      first.unmount()
      // The same sequence that gives a `flow` page its position back leaves
      // this page at the top: the outer memory is not consulted for it…
      expect(landAfterReturning(view, 420)).toBe(0)
      // …and nothing was RECORDED under that key either: a `flow` page
      // reporting the same view starts at the top before any scroll of its own
      // (the page's own scrolling would write 0 over the leak and hide it).
      expect(scroller(show(page('flow'))).scrollTop).toBe(0)
    } finally {
      restore()
    }
  })

  it('leaves the shell notices to the frame and keeps the `fill` page mounted', () => {
    const result = show(page('fill'), {
      state: state({
        watching: false,
        connectionError: undefined,
        error: 'gateway/internal: the carrier is gone',
        refusals: new Map<string, RefusalCode>([[row.id, 'capability-not-approved']]),
        progress: [{ appId: row.id, op: 'read', callId: 'call-1', message: 'reading' }],
      }),
    })
    // The notices live in the frame's floating stack now: the surface must not
    // re-create them as rows above the page.
    for (const marker of ['[data-app-connection]', '[data-app-error]', '[data-app-refusal]', '[data-app-progress]']) {
      expect(result.container.querySelector(marker), marker).toBeNull()
    }
    expect(result.container.querySelector('[data-testid="page-body"]')).not.toBeNull()
  })
})

describe('AppSurface: the first-run permission card', () => {
  it('approves the card, re-runs a refused read, and wires the later answer', async () => {
    const custom: AppInfo = { ...row, needs: ['capability:storage'] }
    const onAllowOnboarding = vi.fn(async () => true)
    const onLaterOnboarding = vi.fn(async () => true)
    const onRetryRead = vi.fn()
    render(
      <AppSurface
        state={state({
          apps: [custom],
          policies: [], policiesReading: false, policiesFailed: false, policiesLoaded: false,
    grants: [],
          onboarding: { apps: {} },
          grantsLoaded: true,
          onboardingLoaded: true,
          refusals: new Map([[custom.id, 'capability-not-approved']]),
        })}
        app={custom}
        view={page()}
        viewport={{ appId: custom.id, key: 'tab:a', ready: true }}
        anyPage
        readEpoch={0}
        viewProps={viewProps}
        onRetry={noop}
        onRetryRead={onRetryRead}
        onManage={noop}
        onManagePermissions={noop}
        onAllowOnboarding={onAllowOnboarding}
        onLaterOnboarding={onLaterOnboarding}
        onDebug={noop}
          t={t}
      />,
    )
    fireEvent.click(document.body.querySelector('[data-onboarding-action="allow-all"]')!)
    expect(onAllowOnboarding).toHaveBeenCalledWith('info-hub', ['capability:storage'], 'capability:storage')
    await vi.waitFor(() => expect(onRetryRead).toHaveBeenCalledTimes(1))
    fireEvent.click(document.body.querySelector('[data-onboarding-action="later"]')!)
    expect(onLaterOnboarding).toHaveBeenCalledWith('info-hub', 'capability:storage')
  })
})
