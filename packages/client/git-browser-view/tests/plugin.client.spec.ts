// @vitest-environment jsdom
/**
 * The plugin halves: the browser entry registers the git-browser page into the
 * applications shell's `applicationViews` registry and the locale dictionaries
 * with the fiber (teardown proving removal), plus the inert node entry (Loader
 * governance / dsh.client discovery placeholder).
 */
import { createElement } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {
  ApplicationUiPatch, ApplicationUiState, ApplicationUiStore, ApplicationView, ApplicationViewRegistry,
} from '@matrix1001/dsh-application-harness-client-applications/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear() })

/** One in-memory per-application view-state store. */
function makeUi(): ApplicationUiStore {
  let state: ApplicationUiState = {}
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    set: (patch: ApplicationUiPatch) => {
      state = { ...state, ...patch } as ApplicationUiState
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** The registry the plugin writes into (the shell owns the real one). */
function registryStub(): ApplicationViewRegistry {
  const entries = new Map<string, ApplicationView>()
  const stores = new Map<string, ApplicationUiStore>()
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

/** Boot a raw Context with the locale + view-registry services and the plugin fiber. */
async function mount(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; views: ApplicationViewRegistry }> {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const views = registryStub()
  ctx.provide('applicationViews', views)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, views }
}

/** The props the shell hands a mounted page. */
function pageProps(views: ApplicationViewRegistry) {
  return {
    call: vi.fn(async () => ({ callId: 'call', status: 'success' as const, value: {} })),
    cancel: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
    running: false,
    pageContext: { report: vi.fn(() => () => undefined) },
    openManagement: vi.fn(),
    claimProgress: vi.fn(() => () => undefined),
    viewport: { report: vi.fn(() => () => undefined) },
    ui: views.state('git-browser'),
  } as never
}

describe('git-browser view browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['locale', 'applicationViews'])
  })

  it('registers the page under its appId, renders it, and unregisters with the fiber (HMR safety)', async () => {
    const { views, fiber } = await mount()
    const view = views.views().get('git-browser')
    expect(view).toBeDefined()
    expect(views.views().size).toBe(1)
    expect((view!.name as () => string)()).toBe(en['app.name'])
    expect((view!.description as () => string)()).toBe(en['app.description'])
    expect(view!.icon!({ size: 16 })).toBeTruthy()
    expect(view!.contentLayout).toBe('fill')
    expect(view!.tone).toBe('neutral')

    const page = render(createElement(view!.Component!, pageProps(views)))
    await waitFor(() => { expect(page.container.querySelector('[data-git-browser]')).toBeTruthy() })
    expect(page.container.querySelector('[data-git-empty]')).toBeTruthy()
    expect(page.container.querySelector('[data-git-readonly]')!.textContent).toBe(en['view.readonly'])
    cleanup()

    await fiber.dispose()
    expect(views.views().size).toBe(0)
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await mount()
    ctx.locale.setLocale('zh')
    const t = ctx.locale.bind(NS)
    expect(t('view.tab.worktree')).toBe(zh['view.tab.worktree'])
    ctx.locale.setLocale('en')
    expect(t('view.tab.worktree')).toBe(en['view.tab.worktree'])

    await fiber.dispose()
    expect(t('view.tab.worktree')).toBe('view.tab.worktree')
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('git-browser view node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})
