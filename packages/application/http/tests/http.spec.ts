import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AppHttp, DEFAULT_MAX_BYTES, MAX_TIMEOUT_MS, bodyTooLargeError, resolveMaxBytes, resolveTimeoutMs, type AppHttpService } from '../src/index.ts'

/** The provided service, typed for the direct-path assertions. */
interface ProvidedHttp extends AppHttpService {}

/** A minimal context surface; the real Service registration path is exercised once below. */
function makeCtx(): { ctx: Context; provided: Record<string, unknown> } {
  const provided: Record<string, unknown> = {}
  const ctx = {
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    emit: () => {},
    effect: (body: () => unknown) => body(),
  }
  return { ctx: ctx as unknown as Context, provided }
}

/** Mount the service through the stub context and hand back the registered instance. */
function mount(): ProvidedHttp {
  const { ctx, provided } = makeCtx()
  void new AppHttp(ctx)
  return provided.applicationHttp as ProvidedHttp
}

afterEach(() => { vi.unstubAllGlobals() })

/** A `fetch` double that rejects when the signal aborts. */
function fetchLike(init?: { signal?: AbortSignal }): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted === true) {
      reject(new Error('aborted'))
      return
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

/** A response whose body reader is observable: reads and cancellation. */
function countingResponse(chunks: Uint8Array[], cancelFails = true): { response: Response; reads: () => number; cancelled: () => boolean } {
  let reads = 0
  let cancelled = false
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          const chunk = chunks[reads]
          reads += 1
          return chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk }
        },
        cancel: async () => {
          cancelled = true
          if (cancelFails) throw new Error('cancel failed')
        },
      }),
    },
  }
  return { response: response as unknown as Response, reads: () => reads, cancelled: () => cancelled }
}

describe('AppHttp: registration', () => {
  test('provides ctx.applicationHttp with getJson() and no proxy policy of its own', () => {
    const service = mount()
    expect(service).toBeDefined()
    expect('proxy' in service).toBe(false)
    expect(typeof service.getJson).toBe('function')
  })

  test('registers exactly once through the real cordis context (no double provide)', () => {
    const ctx = new Context()
    expect(() => { void new AppHttp(ctx) }).not.toThrow()
    const service = ctx.applicationHttp as AppHttpService
    expect(typeof service.getJson).toBe('function')
  })
})

describe('AppHttp: limits', () => {
  test('resolves an omitted cap to the default and refuses an unusable one', () => {
    expect(resolveMaxBytes(undefined)).toBe(DEFAULT_MAX_BYTES)
    expect(resolveMaxBytes(0)).toBe(0)
    expect(resolveMaxBytes(12)).toBe(12)
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => resolveMaxBytes(bad)).toThrow(/non-negative safe integer/)
    }
    expect(bodyTooLargeError(7).message).toContain('7')
  })

  test('resolves an omitted budget to the default and refuses an unusable one (REL-001)', async () => {
    expect(resolveTimeoutMs(undefined)).toBe(30_000)
    expect(resolveTimeoutMs(1)).toBe(1)
    expect(resolveTimeoutMs(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS)
    // 0 is NOT "no deadline": the service promises a bounded wait, so only an
    // omitted value takes the default. NaN/Infinity/negative and values beyond
    // the timer ceiling are refused before any request starts.
    for (const bad of [0, Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, MAX_TIMEOUT_MS + 1]) {
      expect(() => resolveTimeoutMs(bad)).toThrow(/positive safe integer/)
    }
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    await expect(mount().getJson('https://example.com/x', { timeoutMs: Number.NaN })).rejects.toThrow(/positive safe integer/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('AppHttp: direct path', () => {
  test('fetches directly and shapes the response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchImpl)
    const result = await mount().getJson('https://api.deepseek.com/x', { headers: { accept: 'application/json' } })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.headers?.get?.('content-type')).toContain('application/json')
    await expect(result.json()).resolves.toEqual({ hello: 'world' })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.deepseek.com/x', expect.objectContaining({ method: 'GET', headers: { accept: 'application/json' } }))
  })

  test('reads raw text and memoizes the transcript across text() and json()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"hello":"world"}', { status: 200 })))
    const result = await mount().getJson('https://example.com/x')
    await expect(result.text?.()).resolves.toBe('{"hello":"world"}')
    await expect(result.json()).resolves.toEqual({ hello: 'world' })
  })

  test('passes the method through to fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    await mount().getJson('https://example.com/x', { method: 'POST', headers: { a: 'b' } })
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/x', expect.objectContaining({ method: 'POST' }))
  })

  test('reads a bodiless response as an empty body and admits a zero cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const result = await mount().getJson('https://example.com/x', { maxBytes: 0 })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(204)
    await expect(result.text?.()).resolves.toBe('')
  })

  test('reads an empty stream as an empty body', async () => {
    const { response, reads } = countingResponse([])
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect((await mount().getJson('https://example.com/x')).text?.()).resolves.toBe('')
    expect(reads()).toBe(1)
  })

  test('bounds a hung request by the timeout budget and detaches the listener', async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('application-harness http request timed out after 20ms')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchImpl)
    const controller = new AbortController()
    await expect(mount().getJson('https://example.com/x', { timeoutMs: 20, signal: controller.signal })).rejects.toThrow(/timed out/)
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
  })

  test('an already-aborted signal aborts the fetch immediately', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      expect(init?.signal?.aborted).toBe(true)
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const controller = new AbortController()
    controller.abort()
    await mount().getJson('https://example.com/x', { signal: controller.signal })
  })

  test('an abort after the call fires through the forwarded signal', async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => fetchLike(init))
    vi.stubGlobal('fetch', fetchImpl)
    const controller = new AbortController()
    const pending = mount().getJson('https://example.com/x', { signal: controller.signal })
    await new Promise((resolve) => { setImmediate(resolve) })
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  test('an abort that beat the dispatch aborts the request all the same', async () => {
    const fetchImpl = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => fetchLike(init))
    vi.stubGlobal('fetch', fetchImpl)
    const controller = new AbortController()
    const pending = mount().getJson('https://example.com/x', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  test('refuses a body over maxBytes, stops reading at the cap and leaks neither timer nor listener', async () => {
    vi.useFakeTimers()
    try {
      const { response, reads, cancelled } = countingResponse([new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)])
      vi.stubGlobal('fetch', vi.fn(async () => response))
      const controller = new AbortController()
      const result = await mount().getJson('https://example.com/x', { maxBytes: 10, signal: controller.signal })
      await expect(result.text?.()).rejects.toThrow('application-harness http response body exceeds 10 bytes')
      expect(reads()).toBe(2)
      expect(cancelled()).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a successful cancel does not mask the size verdict', async () => {
    const { response, cancelled } = countingResponse([new Uint8Array(8), new Uint8Array(8)], false)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect((await mount().getJson('https://example.com/x', { maxBytes: 5 })).text?.()).rejects.toThrow(/exceeds 5 bytes/)
    expect(cancelled()).toBe(true)
  })

  test('counts bytes rather than characters on a multi-byte body', async () => {
    const payload = '汉字'.repeat(5)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(payload, { status: 200 })))
    await expect((await mount().getJson('https://example.com/x', { maxBytes: 20 })).text?.()).rejects
      .toThrow('application-harness http response body exceeds 20 bytes')
    const result = await mount().getJson('https://example.com/x', { maxBytes: Buffer.byteLength(payload) })
    await expect(result.text?.()).resolves.toBe(payload)
  })

  test('refuses an unusable maxBytes at the seam, without touching the transport', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    const service = mount()
    await expect(service.getJson('https://example.com/x', { maxBytes: Number.NaN }))
      .rejects.toThrow('application-harness http maxBytes must be a non-negative safe integer, got NaN')
    await expect(service.getJson('https://example.com/x', { maxBytes: -1 }))
      .rejects.toThrow('application-harness http maxBytes must be a non-negative safe integer, got -1')
    await expect(service.getJson('https://example.com/x', { maxBytes: 1.5 }))
      .rejects.toThrow('application-harness http maxBytes must be a non-negative safe integer, got 1.5')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('refuses a non-http(s) or unparseable target at the seam exit', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    const service = mount()
    await expect(service.getJson('data:text/plain,x')).rejects.toThrow(/unsupported target scheme "data:"/)
    await expect(service.getJson('file:///etc/passwd')).rejects.toThrow(/unsupported target scheme "file:"/)
    await expect(service.getJson('not a url')).rejects.toThrow(/unparseable target URL/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a fetch rejection clears the budget and forwarded listener', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
      await expect(mount().getJson('https://example.com/x', { signal: controller.signal })).rejects.toThrow('network down')
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
