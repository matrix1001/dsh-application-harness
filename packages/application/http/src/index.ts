/**
 * The harness network capability (`ctx.applicationHttp`): applications make outbound
 * requests through it. The seam owns the application-facing fence — http/https
 * targets only, a bounded response body, an end-to-end request budget,
 * cancellation, and one response vocabulary for JSON, text and headers — and it
 * routes each request by the row's live `proxy` value:
 *
 * - unset: a plain `fetch`, so the platform's installed proxy dispatcher
 *   (the launcher's `dsh-http-proxy` over `HTTPS_PROXY`/`HTTP_PROXY` and the
 *   harness-home `.env`) governs the route;
 * - set: the application network proxy configured in the application area's
 *   management page. That route is deliberately app-scoped — one Node agent per
 *   request carrying `proxyEnv`, never the process-global dispatcher — so the
 *   model calls, web tools and DSH's own requests keep the platform policy.
 *
 * The application proxy URL carries no credentials (the setting refuses them)
 * and a failed proxied request never falls back to a direct connection.
 * @module @matrix1001/dsh-application-harness-http
 */

import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'

/** The JSON-GET response shape the harness transport uses (a subset of `Response`).
 * `text()` is the raw-body surface, `headers` the read-only response-header
 * surface (the GitHub rate-limit report reads it), and `body` the streaming body
 * when the transport exposes one — a caller enforcing a byte ceiling while the
 * body arrives reads it, and falls back to `text()` when it is absent. */
export interface JsonResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text?: () => Promise<string>
  headers?: { get?: (name: string) => string | null }
  body?: ReadableStream<Uint8Array> | null
}

/** The app-http row's live config: the optional application network proxy. */
export interface AppHttpConfig {
  /** The application network proxy URL; volatile, so a settings change applies to the next request. */
  readonly proxy?: Volatile<string | undefined> | undefined
}

/**
 * Where one application request goes: direct through the platform policy,
 * through the configured application proxy, or nowhere because the configured
 * value is unusable (`invalid` fails the request closed; it never degrades to
 * a direct connection).
 */
export type ProxyRoute =
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxied'; readonly url: URL }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Resolve one live `proxy` value into the route it names. Empty (or whitespace)
 * means direct; a value must be an http(s) URL and must not carry credentials.
 * The reason strings never echo the value, so a mistyped secret cannot reach a
 * log or an app's failure line.
 * @param value - the row's live proxy value.
 * @returns the route to take, or why the value is unusable.
 */
export function resolveProxyRoute(value: string | undefined): ProxyRoute {
  if (value === undefined) return { kind: 'direct' }
  const trimmed = value.trim()
  if (trimmed === '') return { kind: 'direct' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { kind: 'invalid', reason: 'it is not a URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: `its protocol ${url.protocol} is not http or https` }
  }
  if (url.username !== '' || url.password !== '') {
    return { kind: 'invalid', reason: 'it carries credentials, which this setting does not accept' }
  }
  return { kind: 'proxied', url }
}

/** The default response-body cap (8 MiB). */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** The statuses that carry a redirect target; 300/304 do not. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Resolve the byte cap of one response, failing closed on anything that is not
 * a finite, non-negative safe integer. `NaN` and `Infinity` are the reason this
 * is checked rather than coerced: every comparison against them is false, so
 * they would silently REMOVE the cap — the one direction a size fence must
 * never fail in. Only an omitted option takes the default.
 * @param maxBytes - the caller's cap, or `undefined` for {@link DEFAULT_MAX_BYTES}.
 * @returns the cap to enforce.
 */
export function resolveMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`application-harness http maxBytes must be a non-negative safe integer, got ${String(maxBytes)}`)
  }
  return maxBytes
}

/**
 * The longest delay `setTimeout` honours (2^31-1 ms). A larger value overflows
 * the timer and Node fires it immediately, so an explicit ceiling is part of
 * the contract rather than an implementation detail.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Resolve the request budget. Unlike the (client-side) recent-list helpers'
 * "no storage" degradation, an HTTP request always has a bounded wait: only an
 * OMITTED value takes the default, and an explicit value must be a positive safe
 * integer within the timer ceiling. `0`, negative, `NaN` and `Infinity` are
 * refused at the seam instead of becoming "no budget" or an immediate timeout
 * (REL-001).
 * @param timeoutMs - the caller's budget, or `undefined` for {@link DEFAULT_TIMEOUT_MS}.
 * @returns the budget to enforce.
 */
export function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`application-harness http timeoutMs must be a positive safe integer no greater than ${String(MAX_TIMEOUT_MS)}, got ${String(timeoutMs)}`)
  }
  return timeoutMs
}

/** The one over-limit error both transports raise. */
export function bodyTooLargeError(maxBytes: number): Error {
  return new Error(`application-harness http response body exceeds ${String(maxBytes)} bytes`)
}

/** The init an outbound request carries. */
export interface HttpInit {
  /** Extra request headers. */
  headers?: Record<string, string>
  /** The HTTP method; `'GET'` when absent. */
  method?: string
  /** Abort the request when aborted. */
  signal?: AbortSignal
  /** Follow HTTP redirects through the same scheme/private fence, at most five hops (default true). */
  followRedirects?: boolean
  /** Allow loopback/link-local/private destinations (default true; callers reading untrusted URLs should set false). */
  allowPrivate?: boolean
  /** End-to-end request budget in ms (default 30s). */
  timeoutMs?: number
  /**
   * Response-body cap in bytes (default 8 MiB). A body over it rejects rather
   * than arriving truncated; a value that
   * is not a non-negative safe integer is refused at the seam (never silently
   * replaced by the default).
   */
  maxBytes?: number
}

/** The `ctx.applicationHttp` surface applications make outbound JSON-GETs through. */
export interface AppHttpService {
  /** GET a URL and parse the JSON body through the row's configured route. */
  getJson(url: string, init?: HttpInit): Promise<JsonResponse>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The harness network capability; absent until the app-http row mounts. */
    applicationHttp?: AppHttpService
  }
}

/** The default request budget (ms): bounds an upstream that never completes. */
const DEFAULT_TIMEOUT_MS = 30000

/**
 * The `ctx.applicationHttp` provider: one scheme/size/timeout/cancellation fence
 * around either the platform-policy `fetch` or the configured application proxy.
 */
export class AppHttp extends Service {
  /** The row config schema: the application network proxy is the one tunable. */
  static Config = Schema.object({ proxy: Schema.string().volatile() })

  /** The live row config; `proxy` is volatile and read on every request. */
  private readonly settings: AppHttpConfig

  constructor(ctx: Context, config: AppHttpConfig = {}) {
    super(ctx, 'applicationHttp')
    this.settings = config
    // The Service base registers *this* instance under 'applicationHttp'.
  }

  /**
   * GET a URL, parse the JSON body, and bound the whole request by the timeout
   * budget and the response byte cap. A configured application proxy routes the
   * request through its own agent; otherwise the platform's installed proxy
   * dispatcher (and its `NO_PROXY`/loopback rules) governs the route.
   */
  async getJson(url: string, init: HttpInit = {}): Promise<JsonResponse> {
    // Only http/https reach the transport; data:/file: and every other scheme
    // a fetch layer could parse are refused here.
    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw new Error(`application-harness http: unparseable target URL ${JSON.stringify(url)}`)
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`application-harness http: unsupported target scheme ${JSON.stringify(target.protocol)} (http/https only)`)
    }
    // The byte cap and the budget are resolved at this one exit: a caller's
    // unusable value must not reach a path that would read it as "no cap"/"no
    // timeout", and it must not silently become the default either.
    const maxBytes = resolveMaxBytes(init.maxBytes)
    const timeoutMs = resolveTimeoutMs(init.timeoutMs)
    const route = resolveProxyRoute(this.settings.proxy?.get())
    // An unusable setting fails every request closed; it must never turn into a
    // silent direct connection the human did not ask for.
    if (route.kind === 'invalid') {
      throw new Error(`application-harness http: the application network proxy is unusable: ${route.reason}`)
    }
    const headers = init.headers ?? {}
    const proxied = route.kind === 'proxied'
    const direct: { headers: Record<string, string>; maxBytes: number; timeoutMs: number; method?: string; signal?: AbortSignal; followRedirects: boolean; allowPrivate: boolean } = { headers, maxBytes, timeoutMs, followRedirects: init.followRedirects !== false, allowPrivate: init.allowPrivate === true }
    if (init.method !== undefined) direct.method = init.method
    if (init.signal !== undefined) direct.signal = init.signal
    // A proxied request resolves its target at the proxy, so a local DNS answer
    // is neither evidence nor a gate — only literals and local names are refused
    // before the request leaves (the proxy route is the trusted egress).
    if (!direct.allowPrivate && await blockedTarget(target, !proxied)) throw new Error(`application-harness http: private or loopback target ${target.hostname} is not allowed`)
    return await requestJson(url, direct, proxied ? proxyTransport(route.url) : fetchTransport, !proxied)
  }
}

/** Whether an IPv4/IPv6 literal is loopback, link-local, or private. */
function privateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const parts = address.split('.').map(Number)
    const a = parts[0]!
    const b = parts[1]!
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && parts[2] === 0)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  // Every IPv4-mapped address is untrusted: URL parsing normalizes the
  // punctuation to hex groups, so a dotted-only match would miss ::1.
  if (normalized.startsWith('::ffff:')) return true
  return false
}

/** Whether one target's host is a loopback/private literal or a local name. */
function isPrivateLiteral(target: URL): boolean {
  const host = target.hostname.replace(/^\[|\]$/gu, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  return isIP(host) !== 0 && privateAddress(host)
}

/** Whether a name resolves to a loopback/link-local/private address; an unresolvable name fails closed. */
async function resolvesPrivate(target: URL): Promise<boolean> {
  const host = target.hostname.replace(/^\[|\]$/gu, '')
  /* v8 ignore next 8 -- DNS is external I/O; literal/localhost cases are tested, the resolved-address fence is the same predicate */
  try {
    const addresses = await lookup(host, { all: true, verbatim: true })
    return addresses.length === 0 || addresses.some(entry => privateAddress(entry.address))
  } catch {
    // A name that cannot be resolved is not a destination this fence can
    // prove public; fail closed rather than letting fetch try another path.
    return true
  }
}

/**
 * Whether the seam refuses one target before any request is sent. A proxied
 * route skips the DNS lookup (`resolveNames` false): the proxy resolves the
 * name, and the local answer is not the route's answer.
 */
async function blockedTarget(target: URL, resolveNames: boolean): Promise<boolean> {
  return isPrivateLiteral(target) || (resolveNames && await resolvesPrivate(target))
}

/** One transport's answer: the subset of `Response` the seam reads. */
interface TransportResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: ReadableStream<Uint8Array> | null
}

/** One request path: the platform-policy fetch, or the application proxy over node:http(s). */
type Transport = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<TransportResponse>

/** The direct transport: the process-global `fetch`, and therefore the platform proxy policy. */
const fetchTransport: Transport = async (url, init) => {
  const response = await fetch(url, { method: init.method, headers: init.headers, signal: init.signal, redirect: 'manual' })
  return { ok: response.ok, status: response.status, headers: response.headers, body: response.body }
}

/** The loopback hosts the application proxy never sees (Node's own `NO_PROXY` matching). */
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1,[::1]'

/** Copy the caller's headers for a proxied request, forcing an identity body. */
function proxyHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'accept-encoding') continue
    next[name] = value
  }
  // node:http does not decode a compressed body, so the proxied route asks for
  // the bytes every caller can parse instead of accepting a coding it cannot read.
  next['accept-encoding'] = 'identity'
  return next
}

/** One response header as the fetch `Headers` surface reports it. */
function responseHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(', ') : value
}

/** The one failure shape for a proxied read; it names the proxy's host and port, never its userinfo. */
function proxyRequestError(proxy: URL, url: string, error: unknown): Error {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  const reason = code ?? (error instanceof Error ? error.message : String(error))
  return new Error(`application-harness http: the request to ${url} failed through the application network proxy ${proxy.host}: ${reason}`)
}

/**
 * The application-proxy transport: one short-lived Node agent per request,
 * scoped with `proxyEnv` so only this request uses the configured egress.
 * @param proxy - the configured proxy URL (no credentials).
 * @returns the transport the seam calls for every hop.
 */
function proxyTransport(proxy: URL): Transport {
  const proxyEnv = { http_proxy: proxy.href, https_proxy: proxy.href, no_proxy: LOOPBACK_NO_PROXY }
  return async (url, init) => {
    const target = new URL(url)
    const secure = target.protocol === 'https:'
    const agent = secure ? new HttpsAgent({ proxyEnv }) : new HttpAgent({ proxyEnv })
    try {
      return await new Promise<TransportResponse>((resolve, reject) => {
        const request = (secure ? httpsRequest : httpRequest)(target, {
          method: init.method,
          headers: proxyHeaders(init.headers),
          agent,
          signal: init.signal,
        }, (response) => {
          // The response owns the socket from here: destroy the one-request agent
          // when the body closes, whichever way it ends.
          response.once('close', () => { agent.destroy() })
          /* v8 ignore next -- node's client resolves the response callback only after it parsed a status line */
          const status = response.statusCode ?? 0
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => responseHeader(response.headers, name) },
            body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
          })
        })
        request.once('error', (error) => {
          agent.destroy()
          // A canceled request is the caller's or the budget's verdict, not a
          // proxy failure: hand back the signal's reason so a timeout keeps its
          // deadline in the message.
          reject(init.signal.aborted ? init.signal.reason : error)
        })
        request.end()
      })
    } catch (error) {
      agent.destroy()
      if (init.signal.aborted) throw error
      throw proxyRequestError(proxy, url, error)
    }
  }
}

/**
 * A direct or proxied GET shaped as a {@link JsonResponse}, bounded by the
 * timeout budget and response byte cap so a hung or oversized upstream never
 * wedges the caller.
 * @param url - the first request URL.
 * @param init - the resolved method, headers, budget, cap and fences.
 * @param transport - the route's request path.
 * @param resolveNames - whether the private-target fence may resolve a name.
 * @returns the response surface the seam hands its caller.
 */
async function requestJson(
  url: string,
  init: { headers: Record<string, string>; maxBytes: number; timeoutMs: number; method?: string; signal?: AbortSignal; followRedirects: boolean; allowPrivate: boolean },
  transport: Transport,
  resolveNames: boolean,
): Promise<JsonResponse> {
  const controller = new AbortController()
  const forward = init.signal
  const emitAbort = (): void => { controller.abort() }
  if (forward !== undefined) {
    forward.addEventListener('abort', emitAbort, { once: true })
    // A signal already aborted before the call must abort the request too:
    // 'abort' never fires retroactively on an already-aborted signal.
    if (forward.aborted) emitAbort()
  }
  // The seam already validated and defaulted the budget; no `?? default` here,
  // so a value that reached this point is the one the request runs with.
  const budget = init.timeoutMs
  // Detach the forwarder + clear the budget once, whichever way the request ends
  // (a body read, a fetch rejection, or the budget firing).
  const cleanup = (): void => {
    clearTimeout(timer)
    if (forward !== undefined) forward.removeEventListener('abort', emitAbort)
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`application-harness http request timed out after ${budget}ms`))
    cleanup()
  }, budget)
  try {
    let current = url
    let response!: TransportResponse
    for (let hops = 0; ; hops += 1) {
      response = await transport(current, { method: init.method ?? 'GET', headers: init.headers, signal: controller.signal })
      if (!REDIRECT_STATUSES.has(response.status)) break
      if (!init.followRedirects) throw new Error(`application-harness http: redirect from ${current} was refused (followRedirects is false)`)
      const location = response.headers.get('location')
      if (location === null) throw new Error(`application-harness http: redirect from ${current} carries no Location`)
      if (hops >= 5) throw new Error(`application-harness http: too many redirects from ${url}`)
      let next: URL
      try { next = new URL(location, current) } catch { throw new Error(`application-harness http: unparseable redirect target ${JSON.stringify(location)}`) }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error(`application-harness http: unsupported redirect scheme ${JSON.stringify(next.protocol)}`)
      if (!init.allowPrivate && await blockedTarget(next, resolveNames)) throw new Error(`application-harness http: private or loopback redirect target ${next.hostname} is not allowed`)
      current = next.href
    }
    // The budget and the byte cap both cover the BODY. `fetch` resolves on
    // headers, so clearing the timer here left `json()`/`text()` unbounded — a
    // tarpitting upstream held the caller forever on this path while the
    // tunneled path stayed bounded (arch-review 2026-09-20,
    // http-direct-body-unbounded-after-headers). The budget therefore stays
    // armed until the body has been consumed, and the read below — which
    // decodes and parses the transcript itself instead of calling
    // `response.json()`/`text()` — is what clears it. Memoized because the two
    // surfaces are two views of ONE body stream: a second read would otherwise
    // surface as a locked-stream `TypeError` that names neither the cap nor the
    // transport. The read stops at `maxBytes`, so an over-limit body is never
    // buffered to its end.
    let body: Promise<string> | undefined
    const readBody = (): Promise<string> => {
      body ??= (async () => {
        try {
          const reader = response.body?.getReader()
          if (reader === undefined) return ''
          const chunks: Uint8Array[] = []
          let received = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.byteLength
            if (received > init.maxBytes) {
              // Stop pulling bytes and give the connection back instead of
              // draining it; a cancel that itself fails (the transfer is already
              // gone) must not mask the size verdict, which is the caller's
              // answer.
              await reader.cancel().catch(() => {})
              throw bodyTooLargeError(init.maxBytes)
            }
            chunks.push(value)
          }
          return Buffer.concat(chunks).toString('utf8')
        } finally {
          cleanup()
        }
      })()
      return body
    }
    return {
      ok: response.ok,
      status: response.status,
      // The transport's own response surfaces: a caller reading a header (the
      // GitHub rate limit) or enforcing its own byte ceiling while the body
      // arrives reads the same objects the route exposes.
      headers: response.headers,
      body: response.body,
      json: async () => JSON.parse(await readBody()),
      text: () => readBody(),
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

export default AppHttp
