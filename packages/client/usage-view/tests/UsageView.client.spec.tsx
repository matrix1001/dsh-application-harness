// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import type { ApplicationView } from '@matrix1001/dsh-application-harness-client-applications/client'
import { UsagePage, UsageView, type UsageResultWire, type UsageTranslate } from '../src/client/UsageView.tsx'
import { zh } from '../src/client/locales.ts'
import * as UsageViewPlugin from '../src/client/index.ts'
import * as UsageViewHostPlugin from '../src/index.ts'

type CallHandler = (op: string, args: Record<string, unknown>) => unknown | Error

function makeCall(handler: CallHandler): ApplicationViewProps['call'] {
  return vi.fn(async (op: string, args: Record<string, unknown>) => {
    const result = handler(op, args)
    if (result instanceof Error) return { callId: 'c', status: 'failed' as const, error: { code: 'app.failed', message: result.message } }
    return { callId: 'c', status: 'success' as const, result: result as never }
  }) as unknown as ApplicationViewProps['call']
}

function propsWith(call: ApplicationViewProps['call']): ApplicationViewProps {
  return {
    call,
    cancel: vi.fn(),
    claimProgress: vi.fn(() => () => undefined),
    onChanged: vi.fn(() => () => undefined),
    running: false,
    pageContext: { report: vi.fn(() => () => undefined) },
    openManagement: vi.fn(),
    viewport: { report: vi.fn(() => () => undefined) } as never,
    ui: {} as never,
  }
}

const t = ((key: keyof typeof zh): string => zh[key]) as UsageTranslate

const DAYS: UsageResultWire['days'] = [
  { date: '2026-10-30', cost: 3.2, tokens: 1_200_000, requests: 80 },
  { date: '2026-10-31', cost: 4.1, tokens: 1_400_000, requests: 90 },
  { date: '2026-11-01', cost: 2.8, tokens: 1_000_000, requests: 70 },
  { date: '2026-11-02', cost: 6.4, tokens: 2_000_000, requests: 150 },
  { date: '2026-11-03', cost: 4.9, tokens: 1_800_000, requests: 120 },
  { date: '2026-11-04', cost: 5.6, tokens: 2_100_000, requests: 160 },
  { date: '2026-11-05', cost: 1.6, tokens: 900_000, requests: 60 },
]

const ROWS: UsageResultWire['rows'] = [
  { model: 'deepseek-chat', keyId: 'k1', keyName: 'prod', tokens: 8_200_000, requests: 512, cost: 18.4 },
  { model: 'deepseek-reasoner', keyId: 'k2', keyName: 'test', tokens: 3_100_000, requests: 210, cost: 8.2 },
]

function readyResult(days: 7 | 30 = 7): UsageResultWire {
  if (days === 7) {
    return {
      status: 'ready',
      configured: true,
      period: 7,
      fetchedAt: Date.UTC(2026, 10, 5, 4, 40),
      window: { start: '2026-10-30', end: '2026-11-05', days: 7 },
      summary: { balance: 42.8, cumulativeCost: 1286.4, monthCost: 96.2, windowCost: 28.6, windowTokens: 12_400_000, windowRequests: 842 },
      days: DAYS,
      rows: ROWS,
    }
  }
  const days30 = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 9, 7 + index)).toISOString().slice(0, 10),
    cost: index % 3 === 0 ? 2.1 : 4.2,
    tokens: 1_300_000,
    requests: 100,
  }))
  return {
    status: 'ready',
    configured: true,
    period: 30,
    fetchedAt: Date.UTC(2026, 10, 5, 4, 45),
    window: { start: '2026-10-07', end: '2026-11-05', days: 30 },
    summary: { balance: 42.8, cumulativeCost: 1286.4, monthCost: 96.2, windowCost: 96.2, windowTokens: 41_800_000, windowRequests: 2914 },
    days: days30,
    rows: ROWS,
  }
}

const SETTINGS = { period: 7, cacheTtlMs: 300_000, tokenSet: true }

function usageArgsOf(call: ApplicationViewProps['call']): Array<[string, Record<string, unknown>]> {
  return (call as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } }).mock.calls
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('UsagePage', () => {
  it('binds the locale and renders the page', async () => {
    const snapshot = { active: 'zh' }
    const locale = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      bind: () => t,
    }
    const call = makeCall(op => op === 'usage' ? readyResult() : SETTINGS)
    render(<UsagePage {...propsWith(call)} locale={locale as never} />)
    await waitFor(() => { expect(screen.getByText('用量')).toBeTruthy() })
  })
})

describe('registration', () => {
  it('registers the dictionaries, the localized view and the fill layout', () => {
    UsageViewHostPlugin.apply()
    const effects: Array<() => unknown> = []
    const registerDictionary = vi.fn(() => () => undefined)
    const registerView = vi.fn((_appId: string, _view: ApplicationView) => () => undefined)
    const ctx = {
      effect: (work: () => unknown) => { effects.push(work); return () => undefined },
      locale: { register: registerDictionary, bind: () => t },
      applicationViews: { register: registerView },
    }
    UsageViewPlugin.apply(ctx as never)
    for (const effect of effects) effect()
    expect(registerDictionary).toHaveBeenCalled()
    expect(registerView).toHaveBeenCalledWith('usage', expect.objectContaining({ contentLayout: 'fill' }))
    const view = registerView.mock.calls[0]?.[1] as unknown as ApplicationView
    expect((view.name as () => string)()).toBe('DeepSeek 用量')
    expect((view.description as () => string)()).toBe('DeepSeek 账户余额、消费、Tokens 与请求。')
    const element = view.Component?.(propsWith(makeCall(op => op === 'usage' ? readyResult() : SETTINGS)))
    expect(element).toBeTruthy()
  })
})

describe('UsageView', () => {
  it('renders the six figures, chart and table, and switches 7/30 + refreshes', async () => {
    const call = makeCall((op, args) => {
      if (op === 'usage') return args.days === 30 ? readyResult(30) : readyResult(7)
      if (op === 'settings' || op === 'setSettings') return SETTINGS
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-card="balance"]')).toBeTruthy() })
    expect(container.querySelector('[data-usage-page]')?.getAttribute('data-usage-state')).toBe('ready')
    expect(container.querySelector('[data-usage-value="balance"]')?.textContent).toBe('¥ 42.80')
    expect(container.querySelector('[data-usage-value="cumulative"]')?.textContent).toBe('¥ 1,286.40')
    expect(container.querySelector('[data-usage-value="month"]')?.textContent).toBe('¥ 96.20')
    expect(container.querySelector('[data-usage-value="window"]')?.textContent).toBe('¥ 28.60')
    expect(container.querySelector('[data-usage-value="tokens"]')?.textContent).toBe('12.40M')
    expect(container.querySelector('[data-usage-value="requests"]')?.textContent).toBe('842')
    expect(container.querySelectorAll('[data-usage-card]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-usage-bar]')).toHaveLength(7)
    expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(2)
    expect(container.querySelector('[data-usage-range]')?.textContent).toBe('2026-10-30 – 2026-11-05')

    const callsBefore = usageArgsOf(call).length
    fireEvent.click(screen.getByRole('tab', { name: '7 天' }))
    expect(usageArgsOf(call)).toHaveLength(callsBefore)

    fireEvent.click(screen.getByRole('tab', { name: '30 天' }))
    await waitFor(() => { expect(container.querySelector('[data-usage-value="window"]')?.textContent).toBe('¥ 96.20') })
    expect(container.querySelectorAll('[data-usage-bar]')).toHaveLength(30)
    expect(usageArgsOf(call)).toContainEqual(['usage', { days: 30 }])
    expect(usageArgsOf(call)).toContainEqual(['setSettings', { period: 30 }])

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(usageArgsOf(call)).toContainEqual(['usage', { days: 30, refresh: true }]) })
  })

  it('filters only the table and keeps the chart unchanged', async () => {
    const call = makeCall(op => op === 'usage' ? readyResult() : SETTINGS)
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(2) })
    const bars = container.querySelectorAll('[data-usage-bar]').length
    const model = container.querySelector('[data-usage-filter="model"]') as HTMLSelectElement
    const key = container.querySelector('[data-usage-filter="key"]') as HTMLSelectElement
    fireEvent.change(model, { target: { value: 'deepseek-chat' } })
    expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(1)
    fireEvent.change(model, { target: { value: 'deepseek-reasoner' } })
    fireEvent.change(key, { target: { value: 'k2' } })
    expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(1)
    fireEvent.change(model, { target: { value: '' } })
    expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(1)
    fireEvent.change(model, { target: { value: 'deepseek-chat' } })
    expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(0)
    expect(container.querySelector('[data-usage-empty]')).toBeTruthy()
    expect(container.querySelectorAll('[data-usage-bar]')).toHaveLength(bars)
  })

  it('exports the current window and filter as a downloaded CSV', async () => {
    const createObjectURL = vi.fn(() => 'blob:usage')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const call = makeCall((op) => {
      if (op === 'usage') return readyResult()
      if (op === 'settings' || op === 'setSettings') return SETTINGS
      if (op === 'exportUsage') return { filename: 'usage.csv', csv: 'date,model\r\n', rows: 2 }
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-card="window"]')).toBeTruthy() })
    fireEvent.change(container.querySelector('[data-usage-filter="model"]') as HTMLSelectElement, { target: { value: 'deepseek-chat' } })
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }))
    await waitFor(() => { expect(usageArgsOf(call)).toContainEqual(['exportUsage', { days: 7, model: 'deepseek-chat', key: '' }]) })
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('reports a failed export without losing the table', async () => {
    const call = makeCall((op) => {
      if (op === 'usage') return readyResult()
      if (op === 'settings' || op === 'setSettings') return SETTINGS
      if (op === 'exportUsage') return new Error('export failed')
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-card="window"]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }))
    await waitFor(() => { expect(container.querySelector('[data-usage-notice]')?.textContent).toContain('export failed') })
    expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(2)
    fireEvent.click(container.querySelector('[data-usage-notice] button') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-usage-notice]')).toBeNull() })
  })

  it('shows the unconfigured state and saves a token through the settings panel', async () => {
    let configured = false
    const call = makeCall((op) => {
      if (op === 'usage') {
        if (!configured) {
          return {
            status: 'unconfigured',
            configured: false,
            period: 7,
            window: { start: '2026-10-30', end: '2026-11-05', days: 7 },
            summary: {},
            days: [],
            rows: [],
          } satisfies UsageResultWire
        }
        return readyResult()
      }
      if (op === 'settings') return { ...SETTINGS, tokenSet: configured }
      if (op === 'setSettings') { configured = true; return { ...SETTINGS, tokenSet: true } }
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-unconfigured]')).toBeTruthy() })
    expect(container.querySelector('[data-usage-page]')?.getAttribute('data-usage-state')).toBe('unconfigured')

    fireEvent.click(screen.getByRole('button', { name: 'Token 设置' }))
    expect(container.querySelector('[data-usage-settings]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Token 设置' }))
    expect(container.querySelector('[data-usage-settings]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '配置 Token' }))
    expect(container.querySelector('[data-usage-token-state]')?.textContent).toBe('未设置')

    fireEvent.change(container.querySelector('[data-usage-token]') as HTMLInputElement, { target: { value: 'token-abc' } })
    fireEvent.submit(container.querySelector('[data-usage-settings] form') as HTMLFormElement)
    await waitFor(() => { expect(usageArgsOf(call)).toContainEqual(['setSettings', { platformToken: 'token-abc' }]) })
    await waitFor(() => { expect(container.querySelector('[data-usage-page]')?.getAttribute('data-usage-state')).toBe('ready') })
    expect(container.querySelectorAll('[data-usage-bar]')).toHaveLength(7)
  })

  it('reports a token-save failure in the settings panel state', async () => {
    const call = makeCall((op) => {
      if (op === 'usage') return { status: 'unconfigured', configured: false, period: 7, window: { start: '2026-10-30', end: '2026-11-05', days: 7 }, summary: {}, days: [], rows: [] } satisfies UsageResultWire
      if (op === 'settings') return { ...SETTINGS, tokenSet: false }
      if (op === 'setSettings') return new Error('save failed')
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-unconfigured]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '配置 Token' }))
    fireEvent.change(container.querySelector('[data-usage-token]') as HTMLInputElement, { target: { value: 'bad' } })
    fireEvent.submit(container.querySelector('[data-usage-settings] form') as HTMLFormElement)
    await waitFor(() => { expect(container.querySelector('[data-usage-notice]')?.textContent).toContain('save failed') })
  })

  it('keeps a stale snapshot visible with its own notice', async () => {
    const stale: UsageResultWire = {
      ...readyResult(),
      status: 'stale',
      stale: true,
      message: 'network down',
    }
    const call = makeCall(op => op === 'usage' ? stale : SETTINGS)
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-stale]')).toBeTruthy() })
    expect(container.querySelector('[data-usage-page]')?.getAttribute('data-usage-state')).toBe('stale')
    expect(container.querySelector('[data-usage-stale]')?.textContent).toContain('network down')
    expect(container.querySelectorAll('[data-usage-card]')).toHaveLength(6)
    expect(container.querySelector('[data-usage-value="window"]')?.textContent).toBe('¥ 28.60')
  })

  it('shows a failed read as its own full error state', async () => {
    const call = makeCall((op) => {
      if (op === 'usage') return new Error('read failed')
      if (op === 'settings') return SETTINGS
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-error]')?.textContent).toContain('read failed') })
    expect(container.querySelector('[data-usage-page]')?.getAttribute('data-usage-state')).toBe('failed')
    expect(container.querySelectorAll('[data-usage-card]')).toHaveLength(0)
    expect((container.querySelector('[data-usage-action="export"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('formats compact token counts on both sides of the K/M boundary', async () => {
    const compactResult: UsageResultWire = {
      ...readyResult(),
      summary: { ...readyResult().summary, windowTokens: 1500 },
      rows: [
        { model: 'model-a', keyId: 'k1', keyName: 'prod', tokens: 1500, requests: 1, cost: 0.1 },
        { model: 'model-b', keyId: 'k2', keyName: 'test', tokens: 842, requests: 1, cost: 0.1 },
      ],
    }
    const call = makeCall(op => op === 'usage' ? compactResult : SETTINGS)
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-usage-row]')).toHaveLength(2) })
    expect(container.querySelector('[data-usage-value="tokens"]')?.textContent).toBe('1.5K')
    expect(container.textContent).toContain('842')
  })

  it('renders an empty ready reading without inventing values', async () => {
    const empty: UsageResultWire = {
      status: 'ready',
      configured: true,
      period: 7,
      fetchedAt: Date.UTC(2026, 10, 5, 4, 40),
      window: { start: '2026-10-30', end: '2026-11-05', days: 7 },
      summary: {},
      days: [],
      rows: [],
    }
    const call = makeCall(op => op === 'usage' ? empty : SETTINGS)
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-empty]')).toBeTruthy() })
    expect(container.querySelectorAll('[data-usage-bar]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-usage-value]')).toHaveLength(6)
    expect(container.querySelector('[data-usage-value="balance"]')?.textContent).toBe('—')
  })

  it('formats billions and clears a saved token behind an explicit confirmation', async () => {
    const call = makeCall((op) => {
      if (op === 'usage') return { ...readyResult(), summary: { ...readyResult().summary, windowTokens: 1_500_000_000 } }
      if (op === 'settings') return SETTINGS
      if (op === 'setSettings') return SETTINGS
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-value="tokens"]')?.textContent).toBe('1.50B') })
    fireEvent.click(screen.getByRole('button', { name: 'Token 设置' }))
    fireEvent.click(container.querySelector('[data-usage-action="clear-token"]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(usageArgsOf(call).some(([op]) => op === 'setSettings')).toBe(false)
    fireEvent.click(container.querySelector('[data-usage-action="clear-token"]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(usageArgsOf(call)).toContainEqual(['setSettings', { platformToken: '' }]) })
    await waitFor(() => { expect(container.querySelector('[data-usage-notice]')?.textContent).toContain('Token 已清除。') })
  })

  it('retries a failed read from the error panel', async () => {
    let fail = true
    const call = makeCall((op) => {
      if (op === 'usage') return fail ? new Error('read failed') : readyResult()
      if (op === 'settings') return SETTINGS
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-error]')).toBeTruthy() })
    fail = false
    fireEvent.click(container.querySelector('[data-usage-retry]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-usage-error]')).toBeNull() })
  })

  it('reports a failed token clear in the settings panel', async () => {
    const call = makeCall((op) => {
      if (op === 'usage') return readyResult()
      if (op === 'settings') return SETTINGS
      if (op === 'setSettings') return new Error('clear failed')
      return {}
    })
    const { container } = render(<UsageView {...propsWith(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-usage-stats]')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Token 设置' }))
    fireEvent.click(container.querySelector('[data-usage-action="clear-token"]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-usage-notice]')?.textContent).toContain('clear failed') })
  })
})
