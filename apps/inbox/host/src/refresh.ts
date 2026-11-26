/**
 * Source adapters: the two reads behind the inbox — GitHub releases (its Atom
 * web feed first, the releases HTML page as the fallback) and generic RSS/Atom
 * feeds. A read is a pure mapping from one HTTP body to normalized entries; the
 * caller owns the clock, persistence, backoff and progress.
 *
 * Every outbound request goes through `capabilities.use('network', …)`, so the
 * user's standing approval is the one gate in front of the network. The fetch
 * implementation is injected (the row passes the host fetch; specs pass a
 * double), and a read never writes anything by itself. Only public sources are
 * read: there is no token, cookie or other credential on the wire.
 * @module @matrix1001/dsh-application-harness-inbox/refresh
 */

import type { CapabilityAccess } from '@matrix1001/dsh-application-harness-runtime'
import {
  extractDescription,
  extractPageTitle,
  hashText,
  htmlToText,
  MAX_FETCH_BYTES,
  MAX_RELEASES,
  parseFeed,
  parseGitHubReleasesHtml,
  reasonOf,
} from './model.ts'
import type { FeedItem, IncomingEntry, Source } from './model.ts'

/** The minimal response shape an injected transport must answer. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}

/** One injected HTTP transport (the host fetch, or a spec's double). */
export type FetchImpl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>

/** The application HTTP service's bounded GET response (structural: no package dependency). */
export interface ApplicationHttpLike {
  getJson(url: string, init: {
    headers?: Record<string, string>
    signal?: AbortSignal
    maxBytes?: number
    timeoutMs?: number
    followRedirects?: boolean
    allowPrivate?: boolean
  }): Promise<FetchResponseLike & { text?: () => Promise<string> }>
}

/** Everything one source read needs. */
export interface PullOptions {
  /** The direct transport, when a caller explicitly injected one. */
  fetch?: FetchImpl
  signal: AbortSignal
  capabilities: CapabilityAccess
  /** The host's bounded network service; absent in unit tests using the injected fetch. */
  http?: ApplicationHttpLike
  /** Whether the direct `fetch` path may be used when `http` is absent (default true for direct callers). */
  allowFetchFallback?: boolean
  /** Per-request deadline; defaults to 20 seconds. */
  timeoutMs?: number
}

/** The default application-level deadline for one outbound read. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/** The outcome of one source read. */
export interface PullResult {
  entries: IncomingEntry[]
  /** The feed's own title, when the read found one (an RSS source can adopt it). */
  title?: string
}

/** The headers every inbox read carries. */
function baseHeaders(): Record<string, string> {
  return { accept: '*/*', 'user-agent': 'application-harness-inbox' }
}

/** Marks a failure raised by the request path itself, not by an answer from the server. */
const TRANSPORT_FAILURE = Symbol('inbox-transport-failure')

/** One request-path failure: a deadline, a refused connection or a broken body read. */
function transportFailure(message: string): Error {
  return Object.assign(new Error(message), { [TRANSPORT_FAILURE]: true })
}

/** Tag a caught request error so a caller can tell it from the server's own answer. */
function markTransport(error: unknown): Error {
  const marked = error instanceof Error ? error : new Error(String(error))
  return Object.assign(marked, { [TRANSPORT_FAILURE]: true })
}

/**
 * Whether one read failed on the request path (deadline, refused connection,
 * broken body) rather than by an answer from the server. Only this kind can
 * succeed on a second identical attempt; an HTTP status or an oversized body
 * would answer the same way again.
 * @param error - the caught failure.
 * @returns true when the failure came from the request path.
 */
export function isTransportFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[TRANSPORT_FAILURE] === true
}

/**
 * Read one URL, giving one transport accident exactly one more attempt. A
 * cancelled caller is never retried, and neither is a real answer.
 */
async function readText(options: PullOptions, url: string, headers: Record<string, string>, maxBytes?: number): Promise<string> {
  try {
    return await fetchText(options, url, headers, maxBytes)
  } catch (error) {
    if (options.signal.aborted || !isTransportFailure(error)) throw error
    return await fetchText(options, url, headers, maxBytes)
  }
}

/**
 * Read one URL as text under the application's `network` capability. A refused
 * capability, a non-OK status and an oversized body all fail the one source
 * read (the caller records the failure and backs off).
 */
export async function fetchText(options: PullOptions, url: string, headers: Record<string, string>, maxBytes = MAX_FETCH_BYTES): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([options.signal, timeout])
  if (options.http === undefined && (options.allowFetchFallback === false || options.fetch === undefined)) {
    throw new Error('the application network service is unavailable')
  }
  let response: FetchResponseLike
  try {
    // The host service owns the byte cap, redirect policy, private-address
    // fence and proxy route. The injected fetch is the test seam only.
    response = options.http === undefined
      ? await options.capabilities.use('network', async () => await options.fetch!(url, { headers, signal }))
      : await options.capabilities.use('network', async () => await options.http!.getJson(url, {
          headers,
          signal,
          maxBytes,
          timeoutMs,
          followRedirects: true,
          allowPrivate: false,
        }))
  } catch (error) {
    if (timeout.aborted) throw transportFailure(`the request to ${url} timed out after ${String(timeoutMs)}ms`)
    throw markTransport(error)
  }
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} from ${url}`)
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (timeout.aborted) throw transportFailure(`the request to ${url} timed out after ${String(timeoutMs)}ms`)
    throw markTransport(error)
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`the response from ${url} exceeds ${String(maxBytes)} bytes`)
  return text
}

/** Map one parsed feed entry to the inbox's incoming shape. */
function feedEntry(item: FeedItem): IncomingEntry {
  return {
    externalId: item.externalId,
    url: item.url,
    title: item.title,
    summary: item.summary,
    content: item.content,
    contentHash: hashText(`${item.title}\n${item.summary}\n${item.content}`),
    ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
  }
}

/** The release key shared by the Atom and HTML reads, so a fallback never duplicates an entry. */
function releaseEntry(item: FeedItem): IncomingEntry {
  return feedEntry({ ...item, externalId: `release:${item.url !== '' ? item.url : item.externalId}` })
}

/** The releases read: the Atom web feed first, the HTML releases page only when the feed is unusable. */
async function pullGithub(source: Source, options: PullOptions): Promise<PullResult> {
  const repo = (source.config.repo ?? source.url.replace(/^https?:\/\/github\.com\//i, '')).replace(/\/+$/, '')
  const atomUrl = `https://github.com/${repo}/releases.atom`
  let feedError: unknown
  try {
    const body = await readText(options, atomUrl, { ...baseHeaders(), accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7' })
    const feed = parseFeed(body)
    if (feed.title !== '' || feed.items.length > 0) return { entries: feed.items.slice(0, MAX_RELEASES).map(releaseEntry) }
    feedError = new Error('the releases feed was not an Atom feed')
  } catch (error) {
    // The feed read already spent its one retry. Asking for the HTML page would
    // spend the same budget on the same broken route, so only a real answer (an
    // HTTP status or a body that is not a feed) is worth the fallback.
    if (isTransportFailure(error)) {
      throw new Error(`the GitHub releases read failed: ${reasonOf(error)}; the releases page was not attempted because the network could not be reached`)
    }
    feedError = error
  }
  const pageUrl = `https://github.com/${repo}/releases`
  let page: string
  try {
    page = await readText(options, pageUrl, { ...baseHeaders(), accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.8' })
  } catch (error) {
    throw new Error(`the GitHub releases read failed: ${reasonOf(feedError)}; the releases page failed: ${reasonOf(error)}`)
  }
  const items = parseGitHubReleasesHtml(page, repo)
  if (items.length === 0) throw new Error('the GitHub releases page had no recognizable releases')
  return { entries: items.map(releaseEntry) }
}

/** Read one RSS/Atom feed. */
async function pullRss(source: Source, options: PullOptions): Promise<PullResult> {
  const body = await readText(options, source.url, { ...baseHeaders(), accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' })
  const feed = parseFeed(body)
  if (feed.items.length === 0 && feed.title === '') throw new Error('the response is not an RSS or Atom feed')
  return {
    entries: feed.items.map(feedEntry),
    ...(feed.title === '' ? {} : { title: feed.title }),
  }
}

/** Read one source; the adapter is chosen by the source's declared family. */
export async function pullSource(source: Source, options: PullOptions): Promise<PullResult> {
  switch (source.kind) {
    case 'github':
      return await pullGithub(source, options)
    case 'rss':
      return await pullRss(source, options)
    default:
      throw new Error(`unknown source kind: ${String((source as { kind?: unknown }).kind)}`)
  }
}

/** Fetch a page and read its title/description for a manually added link; failures surface to the caller. */
export async function fetchPageMeta(url: string, options: PullOptions): Promise<{ title?: string; description?: string; text: string }> {
  const body = await readText(options, url, { ...baseHeaders(), accept: 'text/html, */*;q=0.8' })
  const title = extractPageTitle(body)
  const description = extractDescription(body)
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    text: htmlToText(body),
  }
}
