/**
 * The application proxy over HTTPS: the seam picks the https transport, asks it
 * for a CONNECT tunnel through the configured proxy, and reports its failures
 * with the proxy's host. `node:https` is mocked here — a real tunnel would need
 * a live TLS origin — so this suite owns the secure branch the loopback proxy
 * suite cannot reach.
 */
import { Readable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const httpsRequest = vi.hoisted(() => vi.fn())

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>()
  return { ...actual, request: httpsRequest }
})

const { AppHttp } = await import('../src/index.ts')

/** One fake TLS-origin answer. */
interface FakeAnswer {
  readonly status: number
  readonly headers: Record<string, string | string[]>
  readonly body: string
}

/** Make the mocked `https.request` answer (or fail) on `end()`. */
function answerWith(answer: FakeAnswer | { readonly error: unknown }): void {
  httpsRequest.mockImplementation((_target: unknown, _options: unknown, callback: (response: unknown) => void) => {
    const listeners = new Map<string, (value: unknown) => void>()
    const request = {
      once: (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener)
        return request
      },
      end: () => {
        if ('error' in answer) {
          listeners.get('error')?.(answer.error)
          return
        }
        const stream = Readable.from([Buffer.from(answer.body)])
        Object.assign(stream, { statusCode: answer.status, headers: answer.headers })
        callback(stream)
      },
    }
    return request
  })
}

/** Mount the service with a configured proxy over the stub context. */
function mount(proxy: string): { getJson: (url: string, init?: Record<string, unknown>) => Promise<unknown> } {
  const provided: Record<string, unknown> = {}
  const ctx = {
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    emit: () => {},
    effect: (body: () => unknown) => body(),
  }
  void new AppHttp(ctx as unknown as Context, { proxy: { get: () => proxy } })
  return provided.applicationHttp as { getJson: (url: string, init?: Record<string, unknown>) => Promise<unknown> }
}

afterEach(() => { httpsRequest.mockReset() })

describe('AppHttp: the application proxy over HTTPS', () => {
  test('sends an https target through the https transport and shapes its response', async () => {
    answerWith({ status: 200, headers: { 'x-secure': 'yes' }, body: 'secure' })
    const result = await mount('http://127.0.0.1:1212').getJson('https://public.example/x') as {
      status: number
      headers: { get(name: string): string | null }
      text(): Promise<string>
    }
    expect(result.status).toBe(200)
    expect(result.headers.get('x-secure')).toBe('yes')
    await expect(result.text()).resolves.toBe('secure')
    expect(httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://public.example/x' }),
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'accept-encoding': 'identity' }) }),
      expect.any(Function),
    )
  })

  test('reports a TLS-origin failure without an error code by its message', async () => {
    answerWith({ error: new Error('boom') })
    await expect(mount('http://127.0.0.1:1212').getJson('https://public.example/x')).rejects.toThrow(/failed through the application network proxy 127\.0\.0\.1:1212: boom/u)
  })

  test('reports a non-Error failure by its string form', async () => {
    answerWith({ error: 'plain failure' })
    await expect(mount('http://127.0.0.1:1212').getJson('https://public.example/x')).rejects.toThrow(/failed through the application network proxy 127\.0\.0\.1:1212: plain failure/u)
  })
})
