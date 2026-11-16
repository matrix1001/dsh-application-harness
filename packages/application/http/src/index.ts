/**
 * The harness network capability (`ctx.applicationHttp`): applications make outbound
 * requests through it and the platform's single proxy policy — `dsh-http-proxy`,
 * installed by the launcher from `HTTPS_PROXY`/`HTTP_PROXY` and the harness-home
 * `.env` — routes the underlying `fetch`. This seam deliberately owns no proxy
 * policy of its own: a second policy would not share the platform's loopback and
 * `NO_PROXY` rules, and the two answers could disagree.
 *
 * What the seam still owns is the application-facing fence: http/https targets
 * only, a bounded response body, an end-to-end request budget, cancellation, and
 * one response vocabulary for JSON, text and headers.
 * @module @matrix1001/dsh-application-harness-http
 */

import { Service, type Context } from '@deepseek-ai/cordis'
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

/** The default response-body cap (8 MiB). */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

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
 * the timer and Node fires it immediately, so an explicit ceiling is part of the
 * contract rather than an implementation detail.
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
  /** GET a URL and parse the JSON body through the platform's installed fetch policy. */
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
 * around the platform's own `fetch` (and therefore the platform proxy policy).
 */
export class AppHttp extends Service {
  /** The row config schema: no tunables. */
  static Config = Schema.object({})

  constructor(ctx: Context) {
    super(ctx, 'applicationHttp')
    // The Service base registers *this* instance under 'applicationHttp'.
  }

  /**
   * GET a URL, parse the JSON body, and bound the whole request by the timeout
   * budget and the response byte cap. The request is a plain `fetch`, so the
   * platform's installed proxy dispatcher (and its `NO_PROXY`/loopback rules)
   * governs the route.
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
    const headers = init.headers ?? {}
    const direct: { headers: Record<string, string>; maxBytes: number; timeoutMs: number; method?: string; signal?: AbortSignal } = { headers, maxBytes, timeoutMs }
    if (init.method !== undefined) direct.method = init.method
    if (init.signal !== undefined) direct.signal = init.signal
    return directGetJson(url, direct)
  }
}

/**
 * A direct `fetch` GET shaped as a {@link JsonResponse}, bounded by the timeout
 * budget and response byte cap so a hung or oversized upstream never wedges the
 * caller.
 */
async function directGetJson(
  url: string,
  init: { headers: Record<string, string>; maxBytes: number; timeoutMs: number; method?: string; signal?: AbortSignal },
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
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      signal: controller.signal,
    })
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
      // The native response's own surfaces: a caller reading a header (the
      // GitHub rate limit) or enforcing its own byte ceiling while the body
      // arrives reads the same objects the platform exposes.
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
