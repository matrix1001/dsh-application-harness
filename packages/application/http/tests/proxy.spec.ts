/**
 * The application network proxy: the app-http row's volatile `proxy` value
 * routes application requests through the configured egress while every other
 * request keeps the platform policy ("the platform proxy dispatcher, or
 * direct"). These tests drive the seam over real loopback servers — the proxy is
 * a plain http server that answers absolute-form requests itself — so the
 * route, the headers and the fence are observed on the wire.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AppHttp, resolveProxyRoute, type AppHttpService } from '../src/index.ts'

/** Every server a test opened; closed after it. */
const servers: Server[] = []

/** Stop one server, ignoring a server that already stopped. */
function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => { resolve() })
  })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(stop))
})

/** One request the test proxy saw. */
interface ProxyHit {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
}

/** A loopback proxy that answers absolute-form requests itself and records them. */
async function startProxy(answer: (hit: ProxyHit, response: import('node:http').ServerResponse) => void): Promise<{ url: string; hits: ProxyHit[] }> {
  const hits: ProxyHit[] = []
  const server = createServer((request, response) => {
    const hit: ProxyHit = { method: request.method ?? '', url: request.url ?? '', headers: request.headers }
    hits.push(hit)
    answer(hit, response)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('the test proxy has no port')
  return { url: `http://127.0.0.1:${String(address.port)}`, hits }
}

/** One loopback origin for the direct and loopback-bypass cases. */
async function startOrigin(body: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(body)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('the test origin has no port')
  return `http://127.0.0.1:${String(address.port)}/`
}

/** A port nothing listens on (open, read, close). */
async function freePort(): Promise<number> {
  const server = createServer()
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('no port')
  const port = address.port
  servers.splice(servers.indexOf(server), 1)
  await stop(server)
  return port
}

/** Mount the service over the stub context the direct suite uses. */
function mount(proxy?: string): AppHttpService {
  const provided: Record<string, unknown> = {}
  const ctx = {
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    emit: () => {},
    effect: (body: () => unknown) => body(),
  }
  void new AppHttp(ctx as unknown as Context, proxy === undefined ? {} : { proxy: { get: () => proxy } })
  return provided.applicationHttp as AppHttpService
}

describe('AppHttp: the configured application network proxy', () => {
  test('resolves the live value into the route it names', () => {
    expect(resolveProxyRoute(undefined)).toEqual({ kind: 'direct' })
    expect(resolveProxyRoute('')).toEqual({ kind: 'direct' })
    expect(resolveProxyRoute('   ')).toEqual({ kind: 'direct' })
    expect(resolveProxyRoute('http://127.0.0.1:1212')).toMatchObject({ kind: 'proxied' })
    expect(resolveProxyRoute(' https://proxy.example:8443 ')).toMatchObject({ kind: 'proxied' })
    expect(resolveProxyRoute('not a url')).toEqual({ kind: 'invalid', reason: 'it is not a URL' })
    expect(resolveProxyRoute('socks5://127.0.0.1:1080')).toEqual({ kind: 'invalid', reason: 'its protocol socks5: is not http or https' })
    expect(resolveProxyRoute('http://alice@127.0.0.1:1212')).toEqual({ kind: 'invalid', reason: 'it carries credentials, which this setting does not accept' })
    expect(resolveProxyRoute('http://alice:s3cret@127.0.0.1:1212')).toEqual({ kind: 'invalid', reason: 'it carries credentials, which this setting does not accept' })
  })

  test('fails closed on an unusable value without touching either transport', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const service = mount('socks5://127.0.0.1:1080')
    await expect(service.getJson('http://public.example/x')).rejects.toThrow(/application network proxy is unusable: its protocol socks5: is not http or https/u)
    const failure = await mount('http://alice:s3cret@127.0.0.1:1212').getJson('http://public.example/x').then(
      () => { throw new Error('expected the unusable value to be refused') },
      (error: unknown) => error as Error,
    )
    expect(failure.message).toMatch(/carries credentials/u)
    // The refusal names the rule, never the value: a mistyped secret stays out
    // of logs and out of the application's failure line.
    expect(failure.message).not.toContain('alice')
    expect(failure.message).not.toContain('s3cret')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('sends an http target through the configured proxy and shapes its response', async () => {
    const proxy = await startProxy((_hit, response) => {
      response.setHeader('set-cookie', ['a=1', 'b=2'])
      response.writeHead(201, { 'content-type': 'application/json', 'x-proxy': 'yes' })
      response.end(JSON.stringify({ via: 'proxy' }))
    })
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const result = await mount(proxy.url).getJson('http://public.example/x', {
      method: 'POST',
      headers: { accept: 'application/json', 'accept-encoding': 'gzip' },
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(201)
    expect(result.headers?.get?.('x-proxy')).toBe('yes')
    expect(result.headers?.get?.('missing')).toBeNull()
    expect(result.headers?.get?.('set-cookie')).toBe('a=1, b=2')
    await expect(result.json()).resolves.toEqual({ via: 'proxy' })
    expect(proxy.hits).toHaveLength(1)
    expect(proxy.hits[0]).toMatchObject({ method: 'POST', url: 'http://public.example/x' })
    expect(proxy.hits[0]?.headers.accept).toBe('application/json')
    // node:http does not decode a compressed body: the proxied route asks for identity.
    expect(proxy.hits[0]?.headers['accept-encoding']).toBe('identity')
    // The platform-policy fetch is not the route when the application proxy is set.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('treats a non-2xx proxied answer as a real answer, not a transport failure', async () => {
    const proxy = await startProxy((_hit, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('unavailable')
    })
    const result = await mount(proxy.url).getJson('http://public.example/x')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    await expect(result.text?.()).resolves.toBe('unavailable')
  })

  test('fails a proxied request without falling back to a direct connection', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const port = await freePort()
    const service = mount(`http://127.0.0.1:${String(port)}`)
    await expect(service.getJson('http://public.example/x')).rejects.toThrow(/failed through the application network proxy 127\.0\.0\.1:\d+: ECONNREFUSED/u)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('follows a redirect through the same proxy and revalidates every hop', async () => {
    const proxy = await startProxy((hit, response) => {
      if (hit.url === 'http://public.example/start') {
        response.writeHead(302, { location: 'http://public.example/final' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    const result = await mount(proxy.url).getJson('http://public.example/start')
    expect(result.status).toBe(200)
    expect(proxy.hits.map(hit => hit.url)).toEqual(['http://public.example/start', 'http://public.example/final'])
  })

  test('refuses a private literal target before the proxied request leaves', async () => {
    const proxy = await startProxy((_hit, response) => {
      response.writeHead(200)
      response.end('{}')
    })
    await expect(mount(proxy.url).getJson('http://127.0.0.1/x')).rejects.toThrow(/private or loopback target 127\.0\.0\.1 is not allowed/u)
    expect(proxy.hits).toHaveLength(0)
  })

  test('lets the proxy resolve a name the local resolver cannot answer', async () => {
    // The proxy is the trusted egress: a proxied read must not consult the local
    // resolver, whose answer is neither the route's answer nor a useful gate.
    const proxy = await startProxy((_hit, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('proxied')
    })
    const result = await mount(proxy.url).getJson('http://does-not-exist.invalid/x')
    expect(result.status).toBe(200)
    await expect(result.text?.()).resolves.toBe('proxied')
  })

  test('sends a loopback target direct even while a proxy is configured', async () => {
    const origin = await startOrigin('direct')
    const proxy = await startProxy((_hit, response) => {
      response.writeHead(500)
      response.end('proxy')
    })
    const result = await mount(proxy.url).getJson(origin, { allowPrivate: true })
    expect(result.status).toBe(200)
    await expect(result.text?.()).resolves.toBe('direct')
    expect(proxy.hits).toHaveLength(0)
  })

  test('bounds a proxied body by the byte cap', async () => {
    const proxy = await startProxy((_hit, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('0123456789')
    })
    const result = await mount(proxy.url).getJson('http://public.example/big', { maxBytes: 4 })
    await expect(result.text?.()).rejects.toThrow('application-harness http response body exceeds 4 bytes')
  })

  test('bounds a hung proxied request by the budget and detaches the listener', async () => {
    const proxy = await startProxy(() => { /* the proxy never answers */ })
    const controller = new AbortController()
    await expect(mount(proxy.url).getJson('http://public.example/slow', { timeoutMs: 20, signal: controller.signal })).rejects.toThrow(/timed out after 20ms/u)
    expect(controller.signal.aborted).toBe(false)
  })

  test('aborts a proxied request through the forwarded signal', async () => {
    const proxy = await startProxy(() => { /* the proxy never answers */ })
    const controller = new AbortController()
    const pending = mount(proxy.url).getJson('http://public.example/slow', { signal: controller.signal })
    await new Promise((resolve) => { setImmediate(resolve) })
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/u)
  })
})
