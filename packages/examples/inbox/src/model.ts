/**
 * The inbox's domain model: the durable document vocabulary, the source and
 * entry normalizers, the feed/GitHub/OPML parsers, retention and the query
 * rules. Everything here is a pure function over its inputs (or a deterministic
 * generator such as an id or a hash), so the whole module is testable without a
 * runtime, a network or a clock of its own.
 *
 * External text is handled as DATA: the parsers turn HTML/XML into plain text,
 * clamp every field and never render markup; the view receives text nodes only.
 * @module @matrix1001/dsh-application-harness-inbox/model
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'

/** The application id (the registry key, the view registry key and the row id). */
export const INBOX_APP_ID = 'inbox'
/** The unified-store namespace this application owns. */
export const INBOX_NAMESPACE = 'inbox'
/** The durable document version this application reads and writes. */
export const INBOX_SCHEMA_VERSION = 1
/** The declaration version (kept in step with the package version). */
export const INBOX_VERSION = '0.2.0-rc.1'
/** The application's display identity. */
export const INBOX_NAME = '信息收件箱'
/** One line about what the application is for. */
export const INBOX_DESCRIPTION = '外部信息进入、阅读、收藏与分诊；条目转任务或存为笔记。'

/** The one secret field the host keeps outside business data. */
export const GITHUB_TOKEN_SECRET = 'githubToken'

/** Field ceilings. */
export const MAX_TITLE = 300
export const MAX_SUMMARY = 1000
export const MAX_CONTENT = 200_000
export const MAX_SOURCE_NAME = 100
export const MAX_SELECTOR = 200
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
/** The most entries one GitHub read contributes. */
export const MAX_RELEASES = 20
/** The most entries one feed read contributes. */
export const MAX_FEED_ITEMS = 50
/** The most page text a watch keeps as its compare baseline. */
export const MAX_WATCH_TEXT = 40_000
/** The default page limit for a list read (and the hard ceiling). */
export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

/** A source family. `manual` is an entry kind, never a source kind. */
export type SourceKind = 'github' | 'rss' | 'web'
/** The kind an entry carries; a manually added link has no source. */
export type EntryKind = SourceKind | 'manual'
/** The two list pages a query may draw. */
export type InboxView = 'inbox' | 'saved'
/** The refresh scope: everything enabled, or only sources the schedule says are due. */
export type RefreshScope = 'all' | 'due'

/** Source-specific configuration; a GitHub source carries `repo`, a watch its selector and baseline. */
export interface SourceConfig {
  repo?: string
  selector?: string
  snapshotHash?: string
  snapshotText?: string
}

/** One watched source. */
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

/** The application's durable settings (the GitHub token is a secret, never here). */
export interface InboxSettings {
  retentionDays: number
  maxEntries: number
  maxBytes: number
  githubRefreshMs: number
  feedRefreshMs: number
  watchRefreshMs: number
}

/** The whole durable document. */
export interface InboxDocument {
  schemaVersion: 1
  sources: Source[]
  entries: Entry[]
  settings: InboxSettings
}

/** What `settings`/`setSettings` return: the document's settings plus the token's presence. */
export interface SettingsView extends InboxSettings {
  githubTokenSet: boolean
}

/** One source as a list read reports it, with the entries it owns. */
export interface SourceView extends Source {
  entryCount: number
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
  watchRefreshMs: 6 * 60 * 60_000,
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
  if (kind === 'github') return settings.githubRefreshMs
  return kind === 'rss' ? settings.feedRefreshMs : settings.watchRefreshMs
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
  return value === 'github' || value === 'rss' || value === 'web'
}

/** Assert one source family, with the accepted values in the refusal. */
export function assertSourceKind(value: unknown): SourceKind {
  if (!isSourceKind(value)) throw new AppError('invalid-args', 'kind must be github, rss or web')
  return value
}

/** Assert one entry kind (the filter accepts `manual` too). */
export function assertEntryKind(value: unknown): EntryKind {
  if (value === 'manual' || isSourceKind(value)) return value
  throw new AppError('invalid-args', 'kind must be github, rss, web or manual')
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
  if (raw.watchRefreshMs !== undefined) next.watchRefreshMs = settingsNumber(raw.watchRefreshMs, 'watchRefreshMs', 0, MAX_INTERVAL_MS)
  return next
}

/** Read one string field out of an untrusted record (numbers are stringified). */
function stringField(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
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
  const text = htmlToText(payload)
  const externalId = guid !== '' ? guid : (link !== '' ? link : `feed:${hashText(block)}`)
  return {
    externalId,
    title: title !== '' ? title : (link !== '' ? link : externalId),
    url: link,
    summary: clampText(text, MAX_SUMMARY),
    content: clampText(text !== '' ? text : title, MAX_CONTENT),
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

/** One GitHub release, normalized for the inbox. */
export interface ReleaseItem {
  externalId: string
  url: string
  title: string
  summary: string
  content: string
  contentHash: string
  publishedAt?: number
}

/** Parse the GitHub releases response (an array) into entries; malformed members are skipped. */
export function parseGitHubReleases(value: unknown): ReleaseItem[] {
  if (!Array.isArray(value)) throw new Error('invalid GitHub releases response')
  const items: ReleaseItem[] = []
  for (const raw of value.slice(0, MAX_RELEASES)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const release = raw as Record<string, unknown>
    const tag = stringField(release.tag_name)
    const id = stringField(release.id)
    const name = stringField(release.name)
    const body = stringField(release.body)
    const url = stringField(release.html_url)
    const externalId = `release:${id !== '' ? id : tag}`
    if (externalId === 'release:') continue
    const content = clampText(body, MAX_CONTENT)
    const publishedAt = parseInstant(stringField(release.published_at))
    items.push({
      externalId,
      url,
      title: clampText(name !== '' ? name : (tag !== '' ? tag : externalId), MAX_TITLE),
      summary: clampText(body, MAX_SUMMARY),
      content,
      contentHash: hashText(`${name}\n${body}\n${url}`),
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
 * Merge one source read into the entry list. GitHub/RSS entries dedupe by
 * `sourceId + externalId`; a changed payload updates the stored fields while the
 * reader's state (read/seen/favorite/task/note) stays. Web-change entries carry a
 * unique external id and are always new.
 */
export function upsertEntries(entries: readonly Entry[], source: Source, incoming: readonly IncomingEntry[], now: number): UpsertResult {
  const next = [...entries]
  let added = 0
  let updated = 0
  for (const item of incoming) {
    const index = source.kind === 'web' ? -1 : next.findIndex(entry => entry.sourceId === source.id && entry.externalId === item.externalId)
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
 * Apply the retention policy: expired read, non-favorite entries go first; the
 * entry/byte ceilings then delete the oldest remaining read, non-favorite ones.
 * Favorites and unread entries are never removed automatically.
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
  const candidates = kept
    .filter(entry => entry.readAt !== undefined && !entry.favorite)
    .sort((left, right) => (left.readAt as number) - (right.readAt as number) || left.id.localeCompare(right.id))
  let index = 0
  while ((settings.maxEntries > 0 && kept.length > settings.maxEntries) || (settings.maxBytes > 0 && totalBytes > settings.maxBytes)) {
    const candidate = candidates[index]
    index += 1
    if (candidate === undefined) break
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

/** Filter, sort and paginate the entries; counts are over the whole inbox, not the filtered page. */
export function queryEntries(entries: readonly Entry[], sources: readonly Source[], query: EntryQuery): ListEntriesResult {
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
  const offset = Math.max(query.offset ?? 0, 0)
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)
  return {
    entries: filtered.slice(offset, offset + limit).map(summarizeEntry),
    total: filtered.length,
    counts,
  }
}

/** Whether an automatic attempt may run now (the manual scope ignores this). */
export function isDue(source: Source, now: number): boolean {
  if (source.removed || !source.enabled || source.intervalMs <= 0) return false
  if (source.backoffUntil !== undefined && source.backoffUntil > now) return false
  return (source.lastCheckedAt ?? 0) + source.intervalMs <= now
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

/** The selector shape: an optional tag, an optional id and any number of classes. */
interface ParsedSelector {
  tag: string
  id: string
  classes: string[]
}

/** Parse a terse CSS selector (`tag`, `#id`, `.class`, and their combinations). */
function parseSelector(selector: string): ParsedSelector {
  const match = /^([a-zA-Z][a-zA-Z0-9-]*)?(?:#([A-Za-z0-9_-]+))?((?:\.[A-Za-z0-9_-]+)*)$/.exec(selector.trim())
  if (match === null) return { tag: '', id: '', classes: [] }
  const classes = match[3] === '' || match[3] === undefined ? [] : match[3].split('.').filter(part => part !== '')
  return { tag: match[1] ?? '', id: match[2] ?? '', classes }
}

/** Elements that have no closing tag (a selector match contributes nothing). */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

/**
 * Extract the plain text of the first element matching a terse selector
 * (`tag`, `#id`, `.class` and simple combinations). Returns `undefined` when the
 * selector is empty or matches nothing, so the caller falls back to the whole
 * page text.
 */
export function selectText(html: string, selector: string): string | undefined {
  const parsed = parseSelector(selector)
  if (parsed.tag === '' && parsed.id === '' && parsed.classes.length === 0) return undefined
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
  let match: RegExpExecArray | null
  while ((match = openRe.exec(html)) !== null) {
    const tag = (match[1] as string).toLowerCase()
    if (parsed.tag !== '' && tag !== parsed.tag) continue
    if (parsed.id !== '' && attributeOf(match[0], 'id') !== parsed.id) continue
    if (parsed.classes.length > 0) {
      const classes = attributeOf(match[0], 'class').split(/\s+/).filter(Boolean)
      if (!parsed.classes.every(name => classes.includes(name))) continue
    }
    if (VOID_TAGS.has(tag)) continue
    const close = html.toLowerCase().indexOf(`</${tag}`, openRe.lastIndex)
    if (close < 0) return undefined
    return htmlToText(html.slice(openRe.lastIndex, close))
  }
  return undefined
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
