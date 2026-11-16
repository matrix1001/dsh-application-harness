// @vitest-environment jsdom
/**
 * The plugin halves and the directory-picker adapter. The browser half
 * registers the page/dictionaries with its fiber (teardown proves removal),
 * the registered page falls back to the path input when the deployment has no
 * picker, and the adapter degrades on every absence/cancel/failure.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationView, ApplicationViewRegistry } from '@matrix1001/dsh-application-harness-client-applications/client'
import { apply, directoryPicker, inject, pickDirectory } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { flush, makeCall, makeCancel, makeChanged, makeUi, node } from './harness.tsx'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

/** The registration registry the plugin writes into (the shell owns the production one). */
function registryStub(): ApplicationViewRegistry {
  const entries = new Map<string, ApplicationView>()
  const stores = new Map<string, ReturnType<typeof makeUi>>()
  return {
    register(appId, view) {
      if (entries.has(appId)) throw new Error(`duplicate view for ${appId}`)
      entries.set(appId, view)
      return () => { entries.delete(appId); stores.delete(appId) }
    },
    views: () => new Map(entries),
    state(appId) {
      const existing = stores.get(appId)
      if (existing !== undefined) return existing
      const created = makeUi()
      stores.set(appId, created)
      return created
    },
  }
}

/** Boot a Cordis context with the locale and registry services. */
async function mount(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; views: ApplicationViewRegistry }> {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const views = registryStub()
  ctx.provide('applicationViews', views)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, views }
}

/** Build the shell props the registered page receives. */
function pageProps(): Record<string, unknown> {
  return {
    call: makeCall({ listScans: () => ({ callId: 'c', status: 'success', result: { scans: [] } }), listTrash: () => ({ callId: 'c', status: 'success', result: { entries: [] } }) }).call,
    cancel: makeCancel().cancel,
    onChanged: makeChanged().onChanged,
    running: false,
    pageContext: { report: () => () => undefined },
    openManagement: () => undefined,
    claimProgress: () => () => undefined,
    viewport: { report: () => () => undefined },
    ui: { getSnapshot: () => ({}), set: () => undefined, subscribe: () => () => undefined },
  }
}

describe('browser half', () => {
  it('declares its services and registers the disk-space page with the fill layout', async () => {
    expect(inject).toEqual(['locale', 'applicationViews'])
    const { views, fiber } = await mount()
    const view = views.views().get('disk-space')
    expect(view).toBeDefined()
    expect(view!.contentLayout).toBe('fill')
    expect(view!.tone).toBe('warn')
    expect((view!.name as () => string)()).toBe(en['app.name'])
    expect((view!.description as () => string)()).toBe(en['app.description'])
    expect(view!.icon!({ size: 16 })).toBeTruthy()

    // The registered component is the page: mounting it without a picker
    // leaves the path input as the route and reports that fact.
    const rendered = render(view!.Component!(pageProps() as never))
    await flush()
    fireEvent.click(node(rendered, '[data-disk-pick]')!)
    await flush()
    expect(node(rendered, '[data-disk-notice]')?.textContent).toBe(en['view.notice.pickerUnavailable'])
    cleanup()
    await fiber.dispose()
    expect(views.views().size).toBe(0)
  })

  it('registers both dictionaries under its namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await mount()
    ctx.locale.setLocale('zh')
    const t = ctx.locale.bind(NS)
    expect(t('view.tab.browse')).toBe(zh['view.tab.browse'])
    ctx.locale.setLocale('en')
    expect(t('view.tab.browse')).toBe(en['view.tab.browse'])
    await fiber.dispose()
    expect(t('view.tab.browse')).toBe('view.tab.browse')
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('directory-picker adapter', () => {
  it('resolves only a namespace that carries the pick verb', async () => {
    const missing = { get: () => undefined } as unknown as Context
    expect(directoryPicker(missing)).toBeUndefined()
    const incomplete = { get: () => ({ list: async () => undefined }) } as unknown as Context
    expect(directoryPicker(incomplete)).toBeUndefined()
    const remote = { pick: async () => ({ ok: true as const, value: '/picked' }) }
    const complete = { get: () => remote } as unknown as Context
    expect(directoryPicker(complete)).toBe(remote)
    expect(await pickDirectory(complete)).toBe('/picked')
  })

  it('returns undefined on absence, cancellation, failure and a thrown transport', async () => {
    const missing = { get: () => undefined } as unknown as Context
    expect(await pickDirectory(missing)).toBeUndefined()

    const cancelled = { get: () => ({ pick: async () => ({ ok: true, value: null }) }) } as unknown as Context
    expect(await pickDirectory(cancelled)).toBeUndefined()

    const refused = { get: () => ({ pick: async () => ({ ok: false, error: { code: 'x', message: 'no' } }) }) } as unknown as Context
    expect(await pickDirectory(refused)).toBeUndefined()

    const throwing = { get: () => ({ pick: async () => { throw new Error('transport') } }) } as unknown as Context
    expect(await pickDirectory(throwing)).toBeUndefined()
  })
})

describe('node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})
