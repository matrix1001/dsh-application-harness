/**
 * The inbox's domain model: the durable document vocabulary, the source and
 * entry normalizers, the RSS/Atom/GitHub-releases/OPML parsers, retention and
 * the query rules. Everything here is a pure function over its inputs (or a
 * deterministic generator such as an id or a hash), so the whole module is
 * testable without a runtime, a network or a clock of its own.
 *
 * External text is handled as DATA: the parsers turn HTML/XML into plain text for
 * summaries and Markdown for reader content, clamp every field and never render
 * raw markup; the view renders that Markdown as escaped text nodes only.
 * @module @matrix1001/dsh-application-harness-inbox/model
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'

/** The application id (the registry key, the view registry key and the row id). */
export const INBOX_APP_ID = 'inbox'
/** The unified-store namespace this application owns. */
export const INBOX_NAMESPACE = 'inbox'
/** The durable document version this application reads and writes. */
export const INBOX_SCHEMA_VERSION = 2
/** The declaration version (kept in step with the package version). */
export const INBOX_VERSION = '0.1.1-dev.0'
/** The application's display identity. */
export const INBOX_NAME = '信息收件箱'
/** One line about what the application is for. */
export const INBOX_DESCRIPTION = '外部信息进入、阅读、收藏与分诊；条目转任务或存为笔记。'

/** Field ceilings. */
export const MAX_TITLE = 300
export const MAX_SUMMARY = 1000
export const MAX_CONTENT = 200_000
export const MAX_SOURCE_NAME = 100
export const MAX_ERROR = 500
export const MAX_OPML = 1_000_000

/** The shortest automatic refresh period a source may carry (five minutes). */
export const MIN_INTERVAL_MS = 5 * 60_000
/** The longest automatic refresh period a source may carry (seven days). */
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60_000
/** The scheduler tick: how often the application asks whether a source is due. */
export const REFRESH_TICK_MS = 5 * 60_000
/** The longest a failing source waits before its next automatic attempt (a day). */
export const MAX_BACKOFF_MS = 24 * 60 * 60_000
/** The biggest feed/page body a single read may carry. */
export const MAX_FETCH_BYTES = 2 * 1024 * 1024
/** The most releases one GitHub read contributes (the releases feed/page holds ten). */
export const MAX_RELEASES = 10
/** The most entries one feed read contributes. */
export const MAX_FEED_ITEMS = 50
/** The default page limit for a list read (and the hard ceiling). */
export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200
/** How many entries one source group shows by default. */
export const DEFAULT_GROUP_SIZE = 3
/** The hard ceiling for one group's inline entries. */
export const MAX_GROUP_SIZE = 10

/** A source family. `manual` is an entry kind, never a source kind. */
export type SourceKind = 'github' | 'rss'
/** The kind an entry carries; a manually added link has no source. */
export type EntryKind = SourceKind | 'manual'
/** The two list pages a query may draw. */
export type InboxView = 'inbox' | 'saved'
/** The refresh scope: everything enabled, or only sources the schedule says are due. */
export type RefreshScope = 'all' | 'due'

/** Source-specific configuration; a GitHub source carries its canonical `repo`. */
export interface SourceConfig {
  repo?: string
}

/** One subscribed source. */
export interface Source {
  id: string
  kind: SourceKind
  name: string
  url: string
  enabled: boolean
  intervalMs: number
  config: SourceConfig
  removed: boolean
  failures: number
  lastCheckedAt?: number
  lastSuccessAt?: number
  lastError?: string
  backoffUntil?: number
  createdAt: number
  updatedAt: number
  version: number
}

/** One collected entry. */
export interface Entry {
  id: string
  sourceId?: string
  sourceKind: EntryKind
  externalId: string
  url: string
  title: string
  summary: string
  content: string
  publishedAt?: number
  fetchedAt: number
  contentHash: string
  readAt?: number
  seenAt?: number
  favorite: boolean
  taskId?: string
  noteId?: string
}

/** An entry without its full body (what a list returns). */
export type EntrySummary = Omit<Entry, 'content'>

/** The application's durable settings; no credentials: only public sources are read. */
export interface InboxSettings {
  retentionDays: number
  maxEntries: number
  maxBytes: number
  githubRefreshMs: number
  feedRefreshMs: number
}

/** The whole durable document. */
export interface InboxDocument {
  schemaVersion: 2
  sources: Source[]
  entries: Entry[]
  settings: InboxSettings
}

/** One source as a list read reports it, with the entries it owns. */
export interface SourceView extends Source {
  entryCount: number
  unreadCount: number
  latestAt?: number
}

/** The source list and its health summary. */
export interface SourcesResult {
  sources: SourceView[]
  health: { total: number; ok: number; error: number; paused: number }
}

/** The counts a list read reports for the page's badges. */
export interface EntryCounts {
  unread: number
  unseen: number
  saved: number
  all: number
}

/** One list read. */
export interface ListEntriesResult {
  entries: EntrySummary[]
  total: number
  /** How many entries match the filters (the page's summary line). */
  filteredUnread?: number
  counts: EntryCounts
}

/** One source group in the inbox's grouped read. */
export interface EntryGroup {
  sourceId?: string
  /** The source's display name; an empty string means the page must label it. */
  name: string
  kind: EntryKind
  removed: boolean
  enabled: boolean
  /** Matching entries in this group. */
  total: number
  /** Matching unread entries in this group. */
  unread: number
  /** The newest matching entry's sort instant. */
  latestAt: number
  /** The newest matching summaries, at most `perGroup`. */
  entries: EntrySummary[]
  /** Whether more matching entries exist beyond {@link entries}. */
  hasMore: boolean
}

/** One grouped inbox read. */
export interface ListGroupsResult {
  groups: EntryGroup[]
  total: number
  filteredUnread: number
  totalGroups: number
  counts: EntryCounts
}

/** The refresh request's result: the started (or already running) task. */
export interface RefreshResult {
  taskId?: string
  started: boolean
  sources: number
}

/** The answer of an OPML import. */
export interface OpmlResult {
  added: number
  skipped: number
  invalid: number
}

/** The default settings (the plan's 90 days / 2000 entries / 50 MB). */
export const DEFAULT_SETTINGS: InboxSettings = {
  retentionDays: 90,
  maxEntries: 2000,
  maxBytes: 50 * 1024 * 1024,
  githubRefreshMs: 30 * 60_000,
  feedRefreshMs: 60 * 60_000,
}

/** A fresh empty document. */
export function emptyDocument(): InboxDocument {
  return { schemaVersion: INBOX_SCHEMA_VERSION, sources: [], entries: [], settings: { ...DEFAULT_SETTINGS } }
}

/** A new source id. */
export function newSourceId(): string { return `s_${randomUUID()}` }

/** A new entry id. */
export function newEntryId(): string { return `e_${randomUUID()}` }

/** The family cadence a new source of `kind` starts from. */
export function familyInterval(settings: InboxSettings, kind: SourceKind): number {
  return kind === 'github' ? settings.githubRefreshMs : settings.feedRefreshMs
}

/** The stable, readable reason of an unknown thrown value. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Clamp one text field to a maximum length (trimmed, with an ellipsis when cut). */
export function clampText(value: string, max: number): string {
  const text = value.replace(/\r\n/g, '\n').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Decode the named and numeric HTML entities the parsers meet; other entity spellings pass through. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    const entity = ENTITIES[lower]
    return entity === undefined ? whole : entity
  })
}

/** The named entities the inbox decodes. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Drop markup from one HTML/XML fragment, keeping block boundaries as newlines. */
function stripMarkup(html: string): string {
  return html
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
}

/** Turn one HTML/XML fragment into plain-text paragraphs (empty ones dropped). */
export function htmlToParagraphs(html: string): string[] {
  return decodeEntities(stripMarkup(html))
    .split('\n')
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(part => part !== '')
}

/** Turn one HTML/XML fragment into plain text (paragraphs separated by a blank line). */
export function htmlToText(html: string): string {
  return htmlToParagraphs(html).join('\n\n')
}

/** Rewrite the common inline HTML tags as Markdown, leaving other text alone. */
function inlineTags(html: string): string {
  return html
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/gi, '**$1**')
    .replace(/<b\b[^>]*>([\s\S]*?)<\/b\s*>/gi, '**$1**')
    .replace(/<em\b[^>]*>([\s\S]*?)<\/em\s*>/gi, '*$1*')
    .replace(/<i\b[^>]*>([\s\S]*?)<\/i\s*>/gi, '*$1*')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, '`$1`')
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, '[$2]($1)')
    .replace(/<br\s*\/?>/gi, '\n')
}

/** One inline fragment as Markdown text on one line. */
function inlineMarkdown(html: string): string {
  return inlineTags(html).replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim()
}

/**
 * Turn one external HTML fragment into Markdown text. The inbox stores external
 * content as data and the page renders Markdown (never raw HTML); preserving
 * headings, lists, emphasis, links and fenced code here is what keeps release
 * notes and feed bodies readable instead of flattening them to one column of
 * paragraphs.
 */
export function htmlToMarkdown(html: string): string {
  const codeBlocks: string[] = []
  let text = html
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, body: string) => {
    const token = `@@INBOX_CODE_${String(codeBlocks.length)}@@`
    codeBlocks.push(`\`\`\`\n${decodeEntities(body.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '')}\n\`\`\``)
    return `\n\n${token}\n\n`
  })
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level: string, body: string) => `\n\n${'#'.repeat(Number(level))} ${inlineMarkdown(body)}\n\n`)
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_match, body: string) => `\n\n> ${inlineMarkdown(body).replace(/\n/g, '\n> ')}\n\n`)
  text = text.replace(/<\/li\s*>\s*<li\b/gi, '</li><li')
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_match, body: string) => `\n- ${inlineMarkdown(body)}`)
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|section|article|h[1-6]|ul|ol|table|tr)\s*>/gi, '\n\n')
  text = inlineTags(text).replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
  return text.replace(/@@INBOX_CODE_(\d+)@@/g, (_match, index: string) => codeBlocks[Number(index)] ?? '')
}

/** Turn one inline fragment into a single line of plain text. */
export function plainText(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** A deterministic 32-bit FNV-1a hash, hex encoded (the change signal and manual-entry key). */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Parse one date string into epoch milliseconds; an absent/unparseable value is `undefined`. */
export function parseInstant(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Normalize one http(s) URL: no fragment, no trailing slash (except the root). */
export function normalizeHttpUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new AppError('invalid-args', 'a URL is required')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new AppError('invalid-args', `not a valid URL: ${trimmed}`)
  }
  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new AppError('invalid-args', `only http and https URLs are accepted: ${trimmed}`)
  }
  parsed.hash = ''
  if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1)
  return parsed.toString()
}

/** The host of one URL, used as the fallback display name. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Normalize a GitHub repository argument to canonical `owner/repo`. */
export function normalizeRepo(input: string): string {
  const repo = input.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new AppError('invalid-args', `invalid GitHub repository: ${input}; expected owner/repo`)
  }
  return repo
}

/** Whether one value names a source family. */
export function isSourceKind(value: unknown): value is SourceKind {
  return value === 'github' || value === 'rss'
}

/** Assert one source family, with the accepted values in the refusal. */
export function assertSourceKind(value: unknown): SourceKind {
  if (!isSourceKind(value)) throw new AppError('invalid-args', 'kind must be github or rss')
  return value
}

/** Assert one entry kind (the filter accepts `manual` too). */
export function assertEntryKind(value: unknown): EntryKind {
  if (value === 'manual' || isSourceKind(value)) return value
  throw new AppError('invalid-args', 'kind must be github, rss or manual')
}

/** Normalize one refresh interval (`undefined` = the caller's default; 0 = manual only). */
export function normalizeInterval(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_INTERVAL_MS || (value > 0 && value < MIN_INTERVAL_MS)) {
    throw new AppError('invalid-args', `intervalMs must be 0 or between ${String(MIN_INTERVAL_MS)} and ${String(MAX_INTERVAL_MS)}`)
  }
  return value
}

/** Assert one integer settings number in a range. */
function settingsNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError('invalid-args', `${name} must be an integer between ${String(min)} and ${String(max)}`)
  }
  return value
}

/** Apply one validated settings patch to the current settings. */
export function applySettingsPatch(current: InboxSettings, patch: unknown): InboxSettings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new AppError('invalid-args', 'settings patch must be an object')
  const raw = patch as Record<string, unknown>
  const next: InboxSettings = { ...current }
  if (raw.retentionDays !== undefined) next.retentionDays = settingsNumber(raw.retentionDays, 'retentionDays', 0, 3650)
  if (raw.maxEntries !== undefined) next.maxEntries = settingsNumber(raw.maxEntries, 'maxEntries', 0, 100_000)
  if (raw.maxBytes !== undefined) next.maxBytes = settingsNumber(raw.maxBytes, 'maxBytes', 0, 1_073_741_824)
  if (raw.githubRefreshMs !== undefined) next.githubRefreshMs = settingsNumber(raw.githubRefreshMs, 'githubRefreshMs', 0, MAX_INTERVAL_MS)
  if (raw.feedRefreshMs !== undefined) next.feedRefreshMs = settingsNumber(raw.feedRefreshMs, 'feedRefreshMs', 0, MAX_INTERVAL_MS)
  return next
}

/** Read the text of one XML tag, unwrapping CDATA. */
export function tagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(block)
  if (match === null) return ''
  const inner = (match[1] as string).trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner)
  return cdata === null ? inner : (cdata[1] as string).trim()
}

/** Read one attribute from one opening tag. */
export function attributeOf(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (match === null) return ''
  return decodeEntities((match[2] ?? match[3] ?? match[4]) as string).trim()
}

/** Read one attribute from the first `<tag …>` block. */
export function tagAttribute(block: string, tag: string, name: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(block)
  return match === null ? '' : attributeOf(match[0], name)
}

/** One feed entry, normalized for the inbox. */
export interface FeedItem {
  externalId: string
  title: string
  url: string
  summary: string
  content: string
  publishedAt?: number
}

/** One parsed feed. */
export interface ParsedFeed {
  title: string
  items: FeedItem[]
}

/** The first non-empty tag among `tags` (RSS and Atom spell the same value differently). */
function firstTag(block: string, tags: readonly string[]): string {
  for (const tag of tags) {
    const value = tagText(block, tag)
    if (value !== '') return value
  }
  return ''
}

/** Parse one RSS `<item>` / Atom `<entry>` block. */
function parseFeedItem(block: string): FeedItem {
  const guid = firstTag(block, ['guid', 'id'])
  const link = (tagText(block, 'link') || tagAttribute(block, 'link', 'href')).trim()
  const publishedAt = parseInstant(firstTag(block, ['pubDate', 'published', 'updated', 'date']))
  const payload = firstTag(block, ['content:encoded', 'description', 'summary', 'content'])
  const title = clampText(plainText(tagText(block, 'title')), MAX_TITLE)
  const decoded = decodeEntities(payload)
  const text = htmlToText(decoded)
  const markdown = htmlToMarkdown(decoded)
  const externalId = guid !== '' ? guid : (link !== '' ? link : `feed:${hashText(block)}`)
  return {
    externalId,
    title: title !== '' ? title : (link !== '' ? link : externalId),
    url: link,
    summary: clampText(text, MAX_SUMMARY),
    content: clampText(markdown !== '' ? markdown : title, MAX_CONTENT),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  }
}

/** Parse one RSS 2.0 `<rss>` or Atom `<feed>` document. */
export function parseFeed(xml: string): ParsedFeed {
  const channel = /<channel\b[\s\S]*?<\/channel\s*>/i.exec(xml)?.[0] ?? ''
  const feed = /<feed\b[\s\S]*?<\/feed\s*>/i.exec(xml)?.[0] ?? ''
  const title = clampText(plainText(tagText(channel, 'title') || tagText(feed, 'title')), MAX_TITLE)
  const blocks = xml.match(/<item\b[\s\S]*?<\/item\s*>|<entry\b[\s\S]*?<\/entry\s*>/gi) ?? []
  return { title, items: blocks.slice(0, MAX_FEED_ITEMS).map(parseFeedItem) }
}

/**
 * Read the inner HTML of the releases page's release-body element. GitHub's
 * release bodies may carry nested `<div>` blocks, so the close tag is found by
 * balancing the divs instead of by the first `</div>`.
 */
function releaseBodyHtml(section: string): string | undefined {
  const open = /<div\b[^>]*data-test-selector="body-content"[^>]*>/i.exec(section)
  if (open === null) return undefined
  const from = open.index + open[0].length
  const tagRe = /<div\b|<\/div\s*>/gi
  tagRe.lastIndex = from
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(section)) !== null) {
    if (match[0].charAt(1) === '/') {
      depth -= 1
      if (depth === 0) return section.slice(from, match.index)
    } else {
      depth += 1
    }
  }
  return undefined
}

/**
 * Parse a GitHub releases HTML page (the fallback when `releases.atom` is not a
 * usable Atom feed) into feed items. Each release is one
 * `<section id="release-<tag>">` block with the title, atom-style date, the
 * `/releases/tag/…` link and the rendered body. A page without any release
 * section yields no items; the caller fails loudly rather than reporting an
 * empty inbox, so a GitHub redesign surfaces as a failed source, not silence.
 * @param html - the releases page HTML.
 * @param repo - the canonical `owner/repo` the page belongs to.
 */
export function parseGitHubReleasesHtml(html: string, repo: string): FeedItem[] {
  const blocks = html.match(/<section\b[^>]*\bid="release-[^"]*"[\s\S]*?<\/section\s*>/gi) ?? []
  const items: FeedItem[] = []
  for (const block of blocks.slice(0, MAX_RELEASES)) {
    // The block regex already fixed the `<section id="release-…">` prefix, so the tag is the id's tail.
    const sectionTag = (/(<section\b[^>]*>)/i.exec(block) as RegExpExecArray)[1] as string
    const tag = attributeOf(sectionTag, 'id').slice('release-'.length)
    if (tag === '') continue
    const link = /<a\b[^>]*href="([^"]*\/releases\/tag\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const href = link === null ? '' : decodeEntities(link[1] as string)
    const url = href === '' ? `https://github.com/${repo}/releases/tag/${tag}` : new URL(href, 'https://github.com').toString()
    const heading = /<h2\b[^>]*class="[^"]*sr-only[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(block)
    const headingText = heading === null ? '' : plainText(heading[1] as string)
    const linkText = link === null ? '' : plainText(link[2] as string)
    const title = clampText(headingText !== '' ? headingText : (linkText !== '' ? linkText : tag), MAX_TITLE)
    const time = /<relative-time\b[^>]*\bdatetime="(\d{4}-\d{2}-\d{2}T[^"]*)"/i.exec(block)
    const publishedAt = time === null ? undefined : parseInstant(time[1] as string)
    const body = releaseBodyHtml(block)
    const text = body === undefined ? '' : htmlToText(body)
    const markdown = body === undefined ? '' : htmlToMarkdown(body)
    items.push({
      externalId: `release:${url}`,
      title,
      url,
      summary: clampText(text, MAX_SUMMARY),
      content: clampText(markdown !== '' ? markdown : title, MAX_CONTENT),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return items
}

/** One feed a pasted OPML document names. */
export interface OpmlCandidate {
  url: string
  name: string
}

/** Parse an OPML document into its feed candidates; malformed rss outlines count as invalid. */
export function parseOpml(xml: string): { candidates: OpmlCandidate[]; invalid: number } {
  const outlines = xml.match(/<outline\b[^>]*>/gi) ?? []
  const candidates: OpmlCandidate[] = []
  let invalid = 0
  for (const outline of outlines) {
    const rawUrl = attributeOf(outline, 'xmlUrl')
    const type = attributeOf(outline, 'type').toLowerCase()
    if (rawUrl === '') {
      if (type === 'rss' || type === 'atom') invalid += 1
      continue
    }
    let url: string
    try {
      url = normalizeHttpUrl(rawUrl)
    } catch {
      invalid += 1
      continue
    }
    const name = plainText(attributeOf(outline, 'title') || attributeOf(outline, 'text'))
    candidates.push({ url, name: clampText(name !== '' ? name : hostOf(url), MAX_SOURCE_NAME) })
  }
  return { candidates, invalid }
}

/** One entry a source read contributes. */
export interface IncomingEntry {
  externalId: string
  url: string
  title: string
  summary: string
  content: string
  contentHash: string
  publishedAt?: number
}

/** The dedupe/update result of one source read. */
export interface UpsertResult {
  entries: Entry[]
  added: number
  updated: number
}

/**
 * Merge one source read into the entry list. GitHub-release/RSS entries dedupe
 * by `sourceId + externalId`; a changed payload updates the stored fields while
 * the reader's state (read/seen/favorite/task/note) stays.
 */
export function upsertEntries(entries: readonly Entry[], source: Source, incoming: readonly IncomingEntry[], now: number): UpsertResult {
  const next = [...entries]
  let added = 0
  let updated = 0
  for (const item of incoming) {
    const index = next.findIndex(entry => entry.sourceId === source.id && entry.externalId === item.externalId)
    if (index < 0) {
      const created: Entry = {
        id: newEntryId(),
        sourceId: source.id,
        sourceKind: source.kind,
        externalId: item.externalId,
        url: item.url,
        title: clampText(item.title, MAX_TITLE) || item.url,
        summary: clampText(item.summary, MAX_SUMMARY),
        content: clampText(item.content, MAX_CONTENT),
        fetchedAt: now,
        contentHash: item.contentHash,
        favorite: false,
      }
      if (item.publishedAt !== undefined) created.publishedAt = item.publishedAt
      next.push(created)
      added += 1
      continue
    }
    const existing = next[index]!
    if (existing.contentHash === item.contentHash) continue
    const nextEntry: Entry = {
      ...existing,
      url: item.url !== '' ? item.url : existing.url,
      title: clampText(item.title, MAX_TITLE) || existing.title,
      summary: clampText(item.summary, MAX_SUMMARY),
      content: clampText(item.content, MAX_CONTENT),
      fetchedAt: now,
      contentHash: item.contentHash,
    }
    if (item.publishedAt !== undefined) nextEntry.publishedAt = item.publishedAt
    next[index] = nextEntry
    updated += 1
  }
  return { entries: next, added, updated }
}

/** The byte size one entry contributes to the store budget (its JSON encoding). */
export function entryBytes(entry: Entry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8')
}

/**
 * Apply the retention policy. Expired read, non-favorite entries go first; the
 * entry/byte ceilings then delete the oldest remaining non-favorite entries,
 * read ones before unread ones. Favorites are never removed automatically, and
 * the age policy never removes unread entries: an unread entry is only lost
 * when the configured `maxEntries`/`maxBytes` ceiling is actually exceeded.
 */
export function applyRetention(entries: readonly Entry[], settings: InboxSettings, now: number): { entries: Entry[]; removed: number } {
  const removed = new Set<string>()
  if (settings.retentionDays > 0) {
    const cutoff = now - settings.retentionDays * 24 * 60 * 60_000
    for (const entry of entries) {
      if (entry.favorite || entry.readAt === undefined) continue
      if (entry.readAt < cutoff) removed.add(entry.id)
    }
  }
  let kept = entries.filter(entry => !removed.has(entry.id))
  let totalBytes = kept.reduce((sum, entry) => sum + entryBytes(entry), 0)
  const readCandidates = kept
    .filter(entry => entry.readAt !== undefined && !entry.favorite)
    .sort((left, right) => (left.readAt as number) - (right.readAt as number) || left.id.localeCompare(right.id))
  const unreadCandidates = kept
    .filter(entry => entry.readAt === undefined && !entry.favorite)
    .sort((left, right) => entryTime(left) - entryTime(right) || left.id.localeCompare(right.id))
  let readIndex = 0
  let unreadIndex = 0
  while ((settings.maxEntries > 0 && kept.length > settings.maxEntries) || (settings.maxBytes > 0 && totalBytes > settings.maxBytes)) {
    // Read entries are the normal pruning surface; unread entries are only
    // touched once that surface is exhausted, so an active inbox cannot grow
    // past the configured ceiling forever.
    const candidate = readCandidates[readIndex++] ?? unreadCandidates[unreadIndex++]
    if (candidate === undefined) break
    if (removed.has(candidate.id)) continue
    removed.add(candidate.id)
    totalBytes -= entryBytes(candidate)
    kept = kept.filter(entry => entry.id !== candidate.id)
  }
  return { entries: kept, removed: removed.size }
}

/** One entry summary (the body is dropped). */
export function summarizeEntry(entry: Entry): EntrySummary {
  const { content: _content, ...summary } = entry
  return summary
}

/** The instant an entry sorts by: when it was published, else when it was fetched. */
export function entryTime(entry: EntrySummary): number {
  return entry.publishedAt ?? entry.fetchedAt
}

/** One list query, already narrowed by the caller. */
export interface EntryQuery {
  view: InboxView
  unread?: boolean
  newOnly?: boolean
  sourceId?: string
  kind?: EntryKind
  search?: string
  offset?: number
  limit?: number
}

/** One filtered, sorted selection shared by the flat and grouped reads. */
interface EntrySelection {
  filtered: Entry[]
  counts: EntryCounts
  filteredUnread: number
}

/** Filter and sort entries; counts are over the whole inbox, not the filtered set. */
function selectEntries(entries: readonly Entry[], sources: readonly Source[], query: EntryQuery): EntrySelection {
  const counts: EntryCounts = {
    unread: entries.filter(entry => entry.readAt === undefined).length,
    unseen: entries.filter(entry => entry.seenAt === undefined).length,
    saved: entries.filter(entry => entry.favorite).length,
    all: entries.length,
  }
  const needle = query.search?.trim().toLocaleLowerCase() ?? ''
  const sourceNames = new Map(sources.map(source => [source.id, source.name]))
  const filtered = entries.filter((entry) => {
    if (query.view === 'saved' && !entry.favorite) return false
    if (query.unread === true && entry.readAt !== undefined) return false
    if (query.newOnly === true && entry.seenAt !== undefined) return false
    if (query.sourceId !== undefined && entry.sourceId !== query.sourceId) return false
    if (query.kind !== undefined && entry.sourceKind !== query.kind) return false
    if (needle === '') return true
    const sourceName = entry.sourceId === undefined ? '' : (sourceNames.get(entry.sourceId) ?? '')
    return `${entry.title}\n${entry.summary}\n${entry.content}\n${sourceName}`.toLocaleLowerCase().includes(needle)
  }).sort((left, right) => entryTime(right) - entryTime(left) || left.id.localeCompare(right.id))
  return { filtered, counts, filteredUnread: filtered.filter(entry => entry.readAt === undefined).length }
}

/** Filter, sort and paginate the entries; counts are over the whole inbox, not the filtered page. */
export function queryEntries(entries: readonly Entry[], sources: readonly Source[], query: EntryQuery): ListEntriesResult {
  const selection = selectEntries(entries, sources, query)
  const offset = Math.max(query.offset ?? 0, 0)
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)
  return {
    entries: selection.filtered.slice(offset, offset + limit).map(summarizeEntry),
    total: selection.filtered.length,
    filteredUnread: selection.filteredUnread,
    counts: selection.counts,
  }
}

/**
 * Group one filtered selection by source. Each group carries its newest
 * `perGroup` summaries plus its own totals, so one busy feed can never fill the
 * page with only its own entries. Groups order by their newest matching entry,
 * with removed sources last; the manual-link entries form one group.
 */
export function groupEntries(entries: readonly Entry[], sources: readonly Source[], query: EntryQuery, perGroup = DEFAULT_GROUP_SIZE): ListGroupsResult {
  const selection = selectEntries(entries, sources, query)
  const sourceById = new Map(sources.map(source => [source.id, source]))
  const size = Number.isFinite(perGroup) ? Math.min(Math.max(Math.trunc(perGroup), 1), MAX_GROUP_SIZE) : DEFAULT_GROUP_SIZE
  const bySource = new Map<string, EntryGroup>()
  for (const entry of selection.filtered) {
    const key = entry.sourceId ?? '\u0000manual'
    let group = bySource.get(key)
    if (group === undefined) {
      const source = entry.sourceId === undefined ? undefined : sourceById.get(entry.sourceId)
      group = {
        ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
        name: source?.name ?? '',
        kind: entry.sourceKind,
        removed: source?.removed === true,
        enabled: source?.enabled !== false,
        total: 0,
        unread: 0,
        latestAt: entryTime(entry),
        entries: [],
        hasMore: false,
      }
      bySource.set(key, group)
    }
    group.total += 1
    if (entry.readAt === undefined) group.unread += 1
    if (group.entries.length < size) group.entries.push(summarizeEntry(entry))
  }
  const groups = [...bySource.values()]
  for (const group of groups) group.hasMore = group.total > group.entries.length
  groups.sort((left, right) => {
    if (left.removed !== right.removed) return left.removed ? 1 : -1
    return right.latestAt - left.latestAt || (left.sourceId ?? '').localeCompare(right.sourceId ?? '')
  })
  return {
    groups,
    total: selection.filtered.length,
    filteredUnread: selection.filteredUnread,
    totalGroups: groups.length,
    counts: selection.counts,
  }
}

/**
 * The period one source actually follows: its own interval when it carries an
 * override, otherwise its family setting. `0` is "no override", never "never":
 * a source pauses by being disabled, so `0` follows the current family setting
 * instead of silently stopping.
 */
export function effectiveInterval(source: Source, settings: InboxSettings): number {
  return source.intervalMs > 0 ? source.intervalMs : familyInterval(settings, source.kind)
}

/** Whether an automatic attempt may run now (the manual scope ignores this). */
export function isDue(source: Source, now: number, settings: InboxSettings): boolean {
  if (source.removed || !source.enabled) return false
  if (source.backoffUntil !== undefined && source.backoffUntil > now) return false
  return (source.lastCheckedAt ?? 0) + effectiveInterval(source, settings) <= now
}

/**
 * The delay a source waits after `failures` consecutive failures: its own period
 * doubled per failure, starting at one period and capped at {@link MAX_BACKOFF_MS}.
 */
export function backoffMs(failures: number, intervalMs: number): number {
  if (failures <= 0) return 0
  const floor = intervalMs > 0 ? intervalMs : REFRESH_TICK_MS
  return Math.min(MAX_BACKOFF_MS, floor * 2 ** failures)
}

/** The page's declared `<title>`, when it has one. */
export function extractPageTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  if (match === null) return undefined
  const title = clampText(plainText(match[1] as string), MAX_TITLE)
  return title === '' ? undefined : title
}

/** A page's declared description (`meta name="description"` or `og:description`). */
export function extractDescription(html: string): string | undefined {
  const tags = /<meta\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = tags.exec(html)) !== null) {
    const name = attributeOf(match[0], 'name').toLowerCase()
    const property = attributeOf(match[0], 'property').toLowerCase()
    if (name !== 'description' && property !== 'og:description') continue
    const content = attributeOf(match[0], 'content')
    return content === '' ? undefined : clampText(plainText(content), MAX_SUMMARY)
  }
  return undefined
}
