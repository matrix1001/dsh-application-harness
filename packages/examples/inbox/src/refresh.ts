/**
 * Source adapters: the three reads behind the inbox — GitHub releases, RSS/Atom
 * feeds and watched pages. A read is a pure mapping from one HTTP body plus the
 * source's previous snapshot to normalized entries; the caller owns the clock,
 * persistence, backoff and progress.
 *
 * Every outbound request goes through `capabilities.use('network', …)`, so the
 * user's standing approval is the one gate in front of the network. The fetch
 * implementation is injected (the row passes the host fetch; specs pass a
 * double), and a read never writes anything by itself.
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
  MAX_SUMMARY,
  MAX_TITLE,
  MAX_WATCH_TEXT,
  parseFeed,
  parseGitHubReleases,
  selectText,
  clampText,
} from './model.ts'
import type { IncomingEntry, ReleaseItem, Source } from './model.ts'

/** The minimal response shape an injected transport must answer. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}

/** One injected HTTP transport (the host fetch, or a spec's double). */
export type FetchImpl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>

/** Everything one source read needs. */
export interface PullOptions {
  fetch: FetchImpl
  signal: AbortSignal
  capabilities: CapabilityAccess
  token?: string
  /** Per-request deadline; defaults to 20 seconds. */
  timeoutMs?: number
}

/** The default application-level deadline for one outbound read. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000


/** The outcome of one source read. */
export interface PullResult {
  entries: IncomingEntry[]
  /** The new page baseline (watched pages only). */
  snapshot?: { hash: string; text: string }
}

/** The headers every inbox read carries. */
function baseHeaders(): Record<string, string> {
  return { accept: '*/*', 'user-agent': 'application-harness-inbox' }
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
  let response
  try {
    response = await options.capabilities.use('network', async () => await options.fetch(url, { headers, signal }))
  } catch (error) {
    if (timeout.aborted) throw new Error(`the request to ${url} timed out after ${String(timeoutMs)}ms`)
    throw error
  }
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} from ${url}`)
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (timeout.aborted) throw new Error(`the request to ${url} timed out after ${String(timeoutMs)}ms`)
    throw error
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`the response from ${url} exceeds ${String(maxBytes)} bytes`)
  return text
}

/** Parse one JSON body, failing loudly so the source records a real error. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('the response is not valid JSON')
  }
}

/** Map one parsed feed entry to the inbox's incoming shape. */
function feedEntry(item: { externalId: string; title: string; url: string; summary: string; content: string; publishedAt?: number }): IncomingEntry {
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

/** Read GitHub releases for one repository. */
async function pullGithub(source: Source, options: PullOptions): Promise<PullResult> {
  const repo = source.config.repo ?? source.url.replace(/^https?:\/\/github\.com\//i, '')
  const url = `https://api.github.com/repos/${repo}/releases?per_page=${String(MAX_RELEASES)}`
  const headers = {
    ...baseHeaders(),
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(options.token === undefined || options.token === '' ? {} : { authorization: `Bearer ${options.token}` }),
  }
  const body = await fetchText(options, url, headers)
  const releases: ReleaseItem[] = parseGitHubReleases(parseJson(body))
  return { entries: releases }
}

/** Read one RSS/Atom feed. */
async function pullRss(source: Source, options: PullOptions): Promise<PullResult> {
  const body = await fetchText(options, source.url, { ...baseHeaders(), accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' })
  const feed = parseFeed(body)
  if (feed.items.length === 0 && feed.title === '') throw new Error('the response is not an RSS or Atom feed')
  return { entries: feed.items.map(feedEntry) }
}

/** Read one watched page and report a change entry when the snapshot moved. */
async function pullWeb(source: Source, options: PullOptions): Promise<PullResult> {
  const body = await fetchText(options, source.url, baseHeaders())
  const selected = source.config.selector === undefined || source.config.selector === '' ? undefined : selectText(body, source.config.selector)
  const text = clampText(selected ?? htmlToText(body), MAX_WATCH_TEXT)
  if (text === '') throw new Error('the page has no readable text')
  const hash = hashText(text)
  const snapshot = { hash, text }
  const previous = source.config.snapshotHash
  if (previous === undefined || previous === hash) return { entries: [], snapshot }
  const title = extractPageTitle(body) ?? source.name
  const content = clampText(`页面内容发生了变化。\n\n${text}`, MAX_WATCH_TEXT)
  return {
    entries: [{
      externalId: `change:${hash}`,
      url: source.url,
      title: clampText(title, MAX_TITLE),
      summary: clampText(text, MAX_SUMMARY),
      content,
      contentHash: hash,
    }],
    snapshot,
  }
}

/** Read one source; the adapter is chosen by the source's declared family. */
export async function pullSource(source: Source, options: PullOptions): Promise<PullResult> {
  switch (source.kind) {
    case 'github':
      return await pullGithub(source, options)
    case 'rss':
      return await pullRss(source, options)
    case 'web':
      return await pullWeb(source, options)
    default:
      throw new Error(`unknown source kind: ${String((source as { kind?: unknown }).kind)}`)
  }
}

/** Fetch a page and read its title/description for a manually added link; failures surface to the caller. */
export async function fetchPageMeta(url: string, options: PullOptions): Promise<{ title?: string; description?: string; text: string }> {
  const body = await fetchText(options, url, { ...baseHeaders(), accept: 'text/html, */*;q=0.8' })
  const title = extractPageTitle(body)
  const description = extractDescription(body)
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    text: htmlToText(body),
  }
}
