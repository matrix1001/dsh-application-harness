import { describe, expect, it } from 'vitest'
import {
  applyRetention, applySettingsPatch, assertEntryKind, assertSourceKind, attributeOf, backoffMs, clampText,
  decodeEntities, DEFAULT_SETTINGS, effectiveInterval, emptyDocument, entryBytes, entryTime, extractDescription, extractPageTitle,
  familyInterval, groupEntries, hashText, hostOf, htmlToParagraphs, htmlToText, isDue, isSourceKind, newEntryId, newSourceId,
  normalizeHttpUrl, normalizeInterval, normalizeRepo, parseFeed, parseGitHubReleasesHtml, parseInstant, parseOpml, plainText,
  queryEntries, reasonOf, summarizeEntry, tagAttribute, tagText, upsertEntries,
} from '../src/model.ts'
import type { Entry, InboxSettings, Source } from '../src/model.ts'

const settings: InboxSettings = { ...DEFAULT_SETTINGS }

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 's1',
    kind: 'rss',
    name: 'Feed',
    url: 'https://feed.test/rss',
    enabled: true,
    intervalMs: 60_000,
    config: {},
    removed: false,
    failures: 0,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...overrides,
  }
}

function entry(overrides: Partial<Entry> = {}): Entry {
  const value: Entry = {
    id: 'e1',
    sourceId: 's1',
    sourceKind: 'rss',
    externalId: 'x1',
    url: 'https://feed.test/1',
    title: 'Title',
    summary: 'Summary',
    content: 'Body',
    fetchedAt: 1000,
    contentHash: 'h1',
    favorite: false,
    ...overrides,
  }
  if (overrides.sourceKind === 'manual') delete value.sourceId
  return value
}

describe('inbox model text helpers', () => {
  it('decodes named, decimal and hex entities and leaves the rest', () => {
    expect(decodeEntities('a&amp;b&lt;c&#39;d&#x41;e&nbsp;f')).toBe("a&b<c'dAe f")
    expect(decodeEntities('&unknown; &#0; &#x110000;')).toBe('&unknown; &#0; &#x110000;')
    expect(decodeEntities('plain')).toBe('plain')
  })

  it('clamps text and normalizes whitespace', () => {
    expect(clampText('  short  ', 10)).toBe('short')
    expect(clampText('abcdef', 4)).toBe('abc…')
    expect(clampText('a\r\nb', 10)).toBe('a\nb')
  })

  it('turns HTML into paragraphs and inline text', () => {
    expect(htmlToParagraphs('<p>one</p><div>two <b>bold</b></div><script>x</script><style>y</style>')).toEqual(['one', 'two bold'])
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo')
    expect(htmlToText('')).toBe('')
    expect(plainText(' <b>hi</b>&amp; <i>there</i> ')).toBe('hi & there')
  })

  it('hashes deterministically and reads dates', () => {
    expect(hashText('same')).toBe(hashText('same'))
    expect(hashText('same')).toMatch(/^[0-9a-f]{8}$/)
    expect(hashText('other')).not.toBe(hashText('same'))
    expect(parseInstant('2026-01-02T03:04:05Z')).toBe(Date.parse('2026-01-02T03:04:05Z'))
    expect(parseInstant('')).toBeUndefined()
    expect(parseInstant('not a date')).toBeUndefined()
  })

  it('reports one thrown value’s reason', () => {
    expect(reasonOf(new Error('boom'))).toBe('boom')
    expect(reasonOf('boom')).toBe('boom')
  })

  it('mints prefixed ids', () => {
    expect(newSourceId()).toMatch(/^s_[0-9a-f-]+$/)
    expect(newEntryId()).toMatch(/^e_[0-9a-f-]+$/)
  })
})

describe('inbox model URL and repository helpers', () => {
  it('normalizes http URLs and refuses everything else', () => {
    expect(normalizeHttpUrl('https://Example.test/path/#frag')).toBe('https://example.test/path')
    expect(normalizeHttpUrl('https://example.test')).toBe('https://example.test/')
    expect(() => normalizeHttpUrl('   ')).toThrow(/URL is required/)
    expect(() => normalizeHttpUrl('not a url')).toThrow(/not a valid URL/)
    expect(() => normalizeHttpUrl('ftp://example.test/file')).toThrow(/only http and https/)
  })

  it('reads a host or passes the input through', () => {
    expect(hostOf('https://www.example.test/a')).toBe('www.example.test')
    expect(hostOf('nonsense')).toBe('nonsense')
  })

  it('normalizes GitHub repository spellings', () => {
    expect(normalizeRepo('https://github.com/owner/repo.git')).toBe('owner/repo')
    expect(normalizeRepo('git@github.com:owner/repo')).toBe('owner/repo')
    expect(normalizeRepo(' owner/repo/ ')).toBe('owner/repo')
    expect(() => normalizeRepo('owner')).toThrow(/invalid GitHub repository/)
  })

  it('validates source and entry kinds', () => {
    expect(isSourceKind('rss')).toBe(true)
    expect(isSourceKind('github')).toBe(true)
    expect(isSourceKind('manual')).toBe(false)
    expect(isSourceKind('web')).toBe(false)
    expect(() => assertSourceKind('web')).toThrow(/kind must be github or rss/)
    expect(() => assertSourceKind('manual')).toThrow(/kind must be/)
    expect(assertEntryKind('manual')).toBe('manual')
    expect(assertEntryKind('github')).toBe('github')
    expect(() => assertEntryKind('web')).toThrow(/kind must be github, rss or manual/)
    expect(() => assertEntryKind('other')).toThrow(/kind must be/)
  })

  it('normalizes intervals', () => {
    expect(normalizeInterval(undefined, 5000)).toBe(5000)
    expect(normalizeInterval(0, 5000)).toBe(0)
    expect(normalizeInterval(600_000, 5000)).toBe(600_000)
    expect(() => normalizeInterval('soon', 0)).toThrow(/intervalMs/)
    expect(() => normalizeInterval(-1, 0)).toThrow(/intervalMs/)
    expect(() => normalizeInterval(1, 0)).toThrow(/intervalMs/)
    expect(() => normalizeInterval(8 * 24 * 60 * 60_000, 0)).toThrow(/intervalMs/)
    expect(() => normalizeInterval(1.5, 0)).toThrow(/intervalMs/)
  })

  it('maps the family cadence and builds an empty document', () => {
    expect(familyInterval(settings, 'github')).toBe(settings.githubRefreshMs)
    expect(familyInterval(settings, 'rss')).toBe(settings.feedRefreshMs)
    expect(emptyDocument()).toEqual({ schemaVersion: 2, sources: [], entries: [], settings })
  })
})

describe('inbox model settings', () => {
  it('applies a valid patch and leaves other fields alone', () => {
    expect(applySettingsPatch(settings, {
      retentionDays: 7,
      maxEntries: 10,
      maxBytes: 1000,
      githubRefreshMs: 0,
      feedRefreshMs: 600_000,
    })).toEqual({
      ...settings,
      retentionDays: 7,
      maxEntries: 10,
      maxBytes: 1000,
      githubRefreshMs: 0,
      feedRefreshMs: 600_000,
    })
    expect(applySettingsPatch(settings, {})).toEqual(settings)
    expect(applySettingsPatch(settings, { unknown: 1 })).toEqual(settings)
  })

  it('refuses malformed patches and out-of-range values', () => {
    expect(() => applySettingsPatch(settings, null)).toThrow(/must be an object/)
    expect(() => applySettingsPatch(settings, [1])).toThrow(/must be an object/)
    expect(() => applySettingsPatch(settings, { retentionDays: -1 })).toThrow(/retentionDays/)
    expect(() => applySettingsPatch(settings, { retentionDays: '7' })).toThrow(/retentionDays/)
    expect(() => applySettingsPatch(settings, { maxEntries: 1.5 })).toThrow(/maxEntries/)
    expect(() => applySettingsPatch(settings, { maxBytes: 2_000_000_000 })).toThrow(/maxBytes/)
    expect(() => applySettingsPatch(settings, { githubRefreshMs: -1 })).toThrow(/githubRefreshMs/)
    expect(() => applySettingsPatch(settings, { feedRefreshMs: Number.NaN })).toThrow(/feedRefreshMs/)
    expect(applySettingsPatch(settings, { watchRefreshMs: 8 * 24 * 60 * 60_000 })).toEqual(settings)
  })
})

describe('inbox model XML helpers', () => {
  it('reads tag text and CDATA', () => {
    expect(tagText('<item><title> Hello </title></item>', 'title')).toBe('Hello')
    expect(tagText('<item><title><![CDATA[ Raw <b> ]]></title></item>', 'title')).toBe('Raw <b>')
    expect(tagText('<item></item>', 'title')).toBe('')
  })

  it('reads quoted and bare attributes', () => {
    expect(attributeOf('<a href="https://x.test/?a=1&amp;b=2">', 'href')).toBe('https://x.test/?a=1&b=2')
    expect(attributeOf("<a href='https://x.test'>", 'href')).toBe('https://x.test')
    expect(attributeOf('<a href=https://x.test>', 'href')).toBe('https://x.test')
    expect(attributeOf('<a>', 'href')).toBe('')
    expect(tagAttribute('<entry><link href="https://x.test/atom" /></entry>', 'link', 'href')).toBe('https://x.test/atom')
    expect(tagAttribute('<entry></entry>', 'link', 'href')).toBe('')
  })
})

describe('inbox model feed parser', () => {
  it('parses RSS items with content, dates and a feed title', () => {
    const xml = `<rss><channel><title>My &amp; Feed</title>
      <item><guid>g1</guid><title>First</title><link>https://x.test/1</link>
        <pubDate>2026-01-02T03:04:05Z</pubDate><description><![CDATA[<p>Hello <b>world</b></p>]]></description></item>
      <item><title>Second</title><link>https://x.test/2</link><content:encoded><![CDATA[<p>Body</p>]]></content:encoded></item>
      <item><description>Only a body</description></item>
      <item><summary>Only a summary</summary></item>
      <item><content>Only content</content></item>
      <item><link>https://x.test/5</link></item>
      <item><title>Only a title</title></item>
      <item><id>tag:6</id><published>2026-03-01T00:00:00Z</published></item>
      <item><id>tag:7</id><date>2026-04-01T00:00:00Z</date></item>
    </channel></rss>`
    const feed = parseFeed(xml)
    expect(feed.title).toBe('My & Feed')
    expect(feed.items).toHaveLength(9)
    expect(feed.items[0]).toMatchObject({ externalId: 'g1', title: 'First', url: 'https://x.test/1', summary: 'Hello world', publishedAt: Date.parse('2026-01-02T03:04:05Z') })
    expect(feed.items[1]).toMatchObject({ externalId: 'https://x.test/2', title: 'Second', content: 'Body' })
    expect(feed.items[1]?.publishedAt).toBeUndefined()
    expect(feed.items[2]?.externalId).toMatch(/^feed:/)
    expect(feed.items[2]?.title).toBe(feed.items[2]?.externalId)
    expect(feed.items[3]).toMatchObject({ summary: 'Only a summary' })
    expect(feed.items[3]?.title).toBe(feed.items[3]?.externalId)
    expect(feed.items[4]).toMatchObject({ summary: 'Only content' })
    expect(feed.items[4]?.title).toBe(feed.items[4]?.externalId)
    expect(feed.items[5]).toMatchObject({ title: 'https://x.test/5' })
    expect(feed.items[6]).toMatchObject({ title: 'Only a title', content: 'Only a title' })
    expect(feed.items[7]?.publishedAt).toBe(Date.parse('2026-03-01T00:00:00Z'))
    expect(feed.items[8]?.publishedAt).toBe(Date.parse('2026-04-01T00:00:00Z'))
  })

  it('keeps headings, emphasis, links and lists as Markdown in content', () => {
    const xml = `<rss><channel><title>Markdown feed</title><item><title>Changes</title><link>https://x.test/1</link><description><![CDATA[
      <h2>Changes</h2>
      <p><strong>New:</strong> <a href="https://x.test/detail">details</a></p>
      <ul><li>one</li><li>two</li></ul>
    ]]></description></item></channel></rss>`
    const item = parseFeed(xml).items[0]
    expect(item?.content).toContain('## Changes')
    expect(item?.content).toContain('**New:** [details](https://x.test/detail)')
    expect(item?.content).toContain('- one\n- two')
    expect(item?.summary).not.toContain('##')
  })

  it('keeps fenced code blocks and their indentation in content', () => {
    const xml = `<rss><channel><title>Code feed</title><item><title>Snippet</title><description><![CDATA[<pre><code>  const a = 1
    const b = 2</code></pre>]]></description></item></channel></rss>`
    const item = parseFeed(xml).items[0]
    expect(item?.content).toContain('```')
    expect(item?.content).toContain('  const a = 1')
    expect(item?.content).toContain('    const b = 2')
  })

  it('parses Atom entries (id, href link, updated)', () => {
    const xml = `<feed><title>Atom</title>
      <entry><id>tag:1</id><title>Update</title><link href="https://x.test/atom" />
        <updated>2026-02-01T00:00:00Z</updated><summary>Short</summary></entry>
    </feed>`
    const feed = parseFeed(xml)
    expect(feed.title).toBe('Atom')
    expect(feed.items[0]).toMatchObject({ externalId: 'tag:1', title: 'Update', url: 'https://x.test/atom', summary: 'Short', publishedAt: Date.parse('2026-02-01T00:00:00Z') })
  })

  it('returns an empty parse for a document that is not a feed', () => {
    expect(parseFeed('<html><body>nope</body></html>')).toEqual({ title: '', items: [] })
  })
})

describe('inbox model GitHub releases page parser', () => {
  const page = `<html><body>
    <section id="release-v2.1.0" aria-labelledby="hd-1">
      <h2 class="sr-only" id="hd-1">Release &amp; notes</h2>
      <a href="/o/r/releases/tag/v2.1.0" class="Link--primary Link">Release 2.1</a>
      <div data-pjax="true" data-test-selector="body-content" data-view-component="true" class="markdown-body tmp-my-3">
        <p>Fixes <b>and</b> improvements</p>
        <div class="nested"><p>Nested note</p></div>
      </div>
      <relative-time class="no-wrap" datetime="2026-10-28T14:23:53Z">28 Oct</relative-time>
    </section>
    <section id="release-v2.0.0">
      <h2 class="sr-only">Second release</h2>
      <a href="https://github.com/o/r/releases/tag/v2.0.0">2.0</a>
      <div data-test-selector="body-content"><p>Second body</p></div>
    </section>
    <section id="release-" aria-labelledby="hd-2"></section>
    <section id="release-v3">
      <h2 class="sr-only"> </h2>
      <div data-test-selector="body-content"><p>Cut body
    </section>
  </body></html>`

  it('reads each release section: title, link, date and balanced body', () => {
    const items = parseGitHubReleasesHtml(page, 'o/r')
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      externalId: 'release:https://github.com/o/r/releases/tag/v2.1.0',
      title: 'Release & notes',
      url: 'https://github.com/o/r/releases/tag/v2.1.0',
      summary: 'Fixes and improvements\n\nNested note',
      content: 'Fixes **and** improvements\n\nNested note',
      publishedAt: Date.parse('2026-10-28T14:23:53Z'),
    })
    expect(items[1]).toMatchObject({
      externalId: 'release:https://github.com/o/r/releases/tag/v2.0.0',
      title: 'Second release',
      summary: 'Second body',
    })
    expect(items[1]?.publishedAt).toBeUndefined()
    expect(items[2]).toMatchObject({
      externalId: 'release:https://github.com/o/r/releases/tag/v3',
      title: 'v3',
      url: 'https://github.com/o/r/releases/tag/v3',
      summary: '',
      content: 'v3',
    })
  })

  it('falls back to the link text and to the tag, and skips malformed sections', () => {
    const fallback = parseGitHubReleasesHtml(`<section id="release-v9"><h2 class="sr-only"></h2><a href="/o/r/releases/tag/v9">Link title</a></section><section id="release-v10"><a href="/o/r/releases/tag/v10">No heading</a></section>`, 'o/r')
    expect(fallback[0]).toMatchObject({ title: 'Link title', summary: '', content: 'Link title' })
    expect(fallback[1]).toMatchObject({ title: 'No heading', summary: '', content: 'No heading' })
    expect(parseGitHubReleasesHtml('<html><body>no releases</body></html>', 'o/r')).toEqual([])
  })
})

describe('inbox model OPML parser', () => {
  it('collects feed outlines and counts malformed rss outlines', () => {
    const xml = `<opml><body>
      <outline text="Category">
        <outline type="rss" text="One" title="First" xmlUrl="https://one.test/rss" />
        <outline type="rss" text="Two" xmlUrl="https://two.test/rss" />
        <outline type="rss" text="No URL" />
        <outline type="atom" text="No URL atom" />
        <outline type="rss" text="Bad" xmlUrl="ftp://bad.test/rss" />
        <outline type="rss" text="Host only" xmlUrl="https://three.test/" />
      </outline>
    </body></opml>`
    const parsed = parseOpml(xml)
    expect(parsed.invalid).toBe(3)
    expect(parsed.candidates).toEqual([
      { url: 'https://one.test/rss', name: 'First' },
      { url: 'https://two.test/rss', name: 'Two' },
      { url: 'https://three.test/', name: 'Host only' },
    ])
    expect(parseOpml('<html></html>')).toEqual({ candidates: [], invalid: 0 })
    const unnamed = parseOpml('<outline type="rss" xmlUrl="https://four.test/rss" />')
    expect(unnamed.candidates).toEqual([{ url: 'https://four.test/rss', name: 'four.test' }])
  })
})

describe('inbox model page helpers', () => {
  it('reads the page title and description', () => {
    expect(extractPageTitle('<html><head><title> Title &amp; more </title></head></html>')).toBe('Title & more')
    expect(extractPageTitle('<html></html>')).toBeUndefined()
    expect(extractPageTitle('<title> </title>')).toBeUndefined()
    expect(extractDescription('<meta name="description" content="Desc &amp; more">')).toBe('Desc & more')
    expect(extractDescription('<meta property="og:description" content="OG">')).toBe('OG')
    expect(extractDescription('<meta name="other" content="x"><meta name="description" content="">')).toBeUndefined()
    expect(extractDescription('<html></html>')).toBeUndefined()
  })
})

describe('inbox model entries', () => {
  it('adds, skips unchanged and updates changed feed entries', () => {
    const existing = entry({ id: 'e_old', externalId: 'a', contentHash: 'old', readAt: 5, favorite: true })
    const first = upsertEntries([existing], source(), [
      { externalId: 'a', url: 'https://feed.test/a', title: 'Changed', summary: 'S', content: 'C', contentHash: 'new', publishedAt: 50 },
      { externalId: 'b', url: 'https://feed.test/b', title: '', summary: 'S2', content: 'C2', contentHash: 'h2' },
      { externalId: 'c', url: 'https://feed.test/c', title: 'Dated', summary: 'S3', content: 'C3', contentHash: 'h3', publishedAt: 60 },
    ], 99)
    expect(first.added).toBe(2)
    expect(first.updated).toBe(1)
    expect(first.entries).toHaveLength(3)
    const updated = first.entries.find(candidate => candidate.id === 'e_old')!
    expect(updated).toMatchObject({ title: 'Changed', readAt: 5, favorite: true, fetchedAt: 99, publishedAt: 50 })
    const appended = first.entries.find(candidate => candidate.externalId === 'b')!
    expect(appended).toMatchObject({ sourceId: 's1', sourceKind: 'rss', title: 'https://feed.test/b', favorite: false })
    expect(appended.publishedAt).toBeUndefined()
    const second = upsertEntries(first.entries, source(), [
      { externalId: 'a', url: '', title: 'Changed', summary: 'S', content: 'C', contentHash: 'new' },
      { externalId: 'a', url: '', title: '', summary: 'S', content: 'C', contentHash: 'newer' },
    ], 100)
    expect(second.added).toBe(0)
    expect(second.updated).toBe(1)
    expect(second.entries).toHaveLength(3)
    expect(second.entries.find(candidate => candidate.externalId === 'a')).toMatchObject({ url: 'https://feed.test/a', title: 'Changed', fetchedAt: 100 })
  })

  it('summarizes, times and sizes entries', () => {
    const published = entry({ publishedAt: 5, fetchedAt: 10 })
    const fetched = entry({ id: 'e2', fetchedAt: 10 })
    expect(summarizeEntry(published)).not.toHaveProperty('content')
    expect(entryTime(published)).toBe(5)
    expect(entryTime(fetched)).toBe(10)
    expect(entryBytes(published)).toBe(Buffer.byteLength(JSON.stringify(published), 'utf8'))
  })
})

describe('inbox model retention', () => {
  const now = 100 * 24 * 60 * 60_000

  it('expires old read non-favorites and keeps everything else', () => {
    const entries = [
      entry({ id: 'old-read', readAt: now - 100 * 24 * 60 * 60_000 }),
      entry({ id: 'old-favorite', readAt: now - 100 * 24 * 60 * 60_000, favorite: true }),
      entry({ id: 'old-unread' }),
      entry({ id: 'fresh-read', readAt: now - 1 }),
    ]
    expect(applyRetention(entries, { ...settings, retentionDays: 90, maxEntries: 0, maxBytes: 0 }, now)).toEqual({ entries: entries.filter(candidate => candidate.id !== 'old-read'), removed: 1 })
    expect(applyRetention(entries, { ...settings, retentionDays: 0, maxEntries: 0, maxBytes: 0 }, now)).toEqual({ entries, removed: 0 })
  })

  it('enforces the entry ceiling over the oldest read entries only', () => {
    const entries = [
      entry({ id: 'unread', fetchedAt: 1 }),
      entry({ id: 'favorite', readAt: 1, favorite: true }),
      entry({ id: 'read-late', readAt: 3 }),
      entry({ id: 'read-early', readAt: 2 }),
    ]
    const result = applyRetention(entries, { ...settings, retentionDays: 0, maxEntries: 2, maxBytes: 0 }, now)
    expect(result.removed).toBe(2)
    expect(result.entries.map(candidate => candidate.id).sort()).toEqual(['favorite', 'unread'])
  })

  it('prunes the oldest unread only after the read candidates are exhausted', () => {
    const entries = [entry({ id: 'unread', fetchedAt: 1 }), entry({ id: 'favorite', readAt: 1, favorite: true })]
    const result = applyRetention(entries, { ...settings, retentionDays: 0, maxEntries: 1, maxBytes: 0 }, now)
    expect(result.removed).toBe(1)
    expect(result.entries.map(candidate => candidate.id)).toEqual(['favorite'])
  })

  it('prefers read entries and orders unread ones by entry time', () => {
    const entries = [
      entry({ id: 'unread-old', fetchedAt: 1 }),
      entry({ id: 'unread-new', fetchedAt: 5 }),
      entry({ id: 'read-new', readAt: 9 }),
      entry({ id: 'read-old', readAt: 2 }),
      entry({ id: 'favorite', readAt: 1, favorite: true }),
    ]
    const result = applyRetention(entries, { ...settings, retentionDays: 0, maxEntries: 2, maxBytes: 0 }, now)
    expect(result.entries.map(candidate => candidate.id).sort()).toEqual(['favorite', 'unread-new'])
    expect(result.removed).toBe(3)
  })

  it('enforces the byte ceiling', () => {
    const big = entry({ id: 'read-big', readAt: 1, content: 'x'.repeat(500) })
    const small = entry({ id: 'read-small', readAt: 2, content: 'x' })
    const result = applyRetention([big, small], { ...settings, retentionDays: 0, maxEntries: 0, maxBytes: entryBytes(small) + 10 }, now)
    expect(result.removed).toBe(1)
    expect(result.entries.map(candidate => candidate.id)).toEqual(['read-small'])
  })

  it('orders equally-old entries by id', () => {
    const entries = [entry({ id: 'b', readAt: 1 }), entry({ id: 'a', readAt: 1 })]
    const result = applyRetention(entries, { ...settings, retentionDays: 0, maxEntries: 1, maxBytes: 0 }, now)
    expect(result.entries.map(candidate => candidate.id)).toEqual(['b'])
  })
})

describe('inbox model queries', () => {
  const sources = [source({ id: 's1', name: 'Feed One' })]
  const entries = [
    entry({ id: 'e1', title: 'Alpha', readAt: 1, seenAt: 1, favorite: true, publishedAt: 30 }),
    entry({ id: 'e2', title: 'Beta', fetchedAt: 20, sourceKind: 'manual' }),
    entry({ id: 'e3', title: 'Gamma', content: 'needle', fetchedAt: 10 }),
    entry({ id: 'e4', title: 'Delta', fetchedAt: 40, readAt: 40 }),
    entry({ id: 'e5', title: 'Orphan', fetchedAt: 5, sourceId: 'missing' }),
  ]

  it('counts, sorts and paginates', () => {
    const result = queryEntries(entries, sources, { view: 'inbox' })
    expect(result.counts).toEqual({ unread: 3, unseen: 4, saved: 1, all: 5 })
    expect(result.total).toBe(5)
    expect(result.entries.map(item => item.id)).toEqual(['e4', 'e1', 'e2', 'e3', 'e5'])
    expect(result.entries[0]).not.toHaveProperty('content')
  })

  it('applies view, state, source, kind and search filters', () => {
    expect(queryEntries(entries, sources, { view: 'saved' }).entries.map(item => item.id)).toEqual(['e1'])
    expect(queryEntries(entries, sources, { view: 'inbox', unread: true }).entries.map(item => item.id)).toEqual(['e2', 'e3', 'e5'])
    expect(queryEntries(entries, sources, { view: 'inbox', newOnly: true }).entries.map(item => item.id)).toEqual(['e4', 'e2', 'e3', 'e5'])
    expect(queryEntries(entries, sources, { view: 'inbox', sourceId: 's1' }).entries.map(item => item.id)).toEqual(['e4', 'e1', 'e3'])
    expect(queryEntries(entries, sources, { view: 'inbox', kind: 'manual' }).entries.map(item => item.id)).toEqual(['e2'])
    expect(queryEntries(entries, sources, { view: 'inbox', search: 'NEEDLE' }).entries.map(item => item.id)).toEqual(['e3'])
    expect(queryEntries(entries, sources, { view: 'inbox', search: 'feed one' }).entries.map(item => item.id)).toEqual(['e4', 'e1', 'e3'])
    expect(queryEntries(entries, sources, { view: 'inbox', search: '   ' }).total).toBe(5)
    expect(queryEntries(entries, sources, { view: 'inbox', search: 'orphan' }).entries.map(item => item.id)).toEqual(['e5'])
  })

  it('applies offset and limit bounds', () => {
    expect(queryEntries(entries, sources, { view: 'inbox', offset: 1, limit: 2 }).entries.map(item => item.id)).toEqual(['e1', 'e2'])
    expect(queryEntries(entries, sources, { view: 'inbox', offset: -5, limit: 0 }).entries).toHaveLength(1)
    expect(queryEntries(entries, sources, { view: 'inbox', limit: 1000 }).entries).toHaveLength(5)
  })

  it('breaks timestamp ties by id', () => {
    const tied = [entry({ id: 'b', fetchedAt: 1 }), entry({ id: 'a', fetchedAt: 1 })]
    expect(queryEntries(tied, [], { view: 'inbox' }).entries.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('reports the filtered unread count beside the global counts', () => {
    const result = queryEntries(entries, sources, { view: 'inbox', unread: true })
    expect(result.total).toBe(3)
    expect(result.filteredUnread).toBe(3)
    expect(result.counts.unread).toBe(3)
    const saved = queryEntries(entries, sources, { view: 'saved' })
    expect(saved.total).toBe(1)
    expect(saved.filteredUnread).toBe(0)
  })
})

describe('inbox model groups', () => {
  const sources = [
    source({ id: 's1', name: 'Feed One' }),
    source({ id: 's2', name: 'Removed feed', url: 'https://feed.test/removed', removed: true }),
  ]
  const entries = [
    entry({ id: 'e1', title: 'Alpha', sourceId: 's1', readAt: 1, seenAt: 1, favorite: true, publishedAt: 30 }),
    entry({ id: 'e2', title: 'Beta', fetchedAt: 20, sourceKind: 'manual' }),
    entry({ id: 'e3', title: 'Gamma', fetchedAt: 10, sourceId: 's1', content: 'needle' }),
    entry({ id: 'e4', title: 'Delta', fetchedAt: 40, sourceId: 's1', readAt: 40 }),
    entry({ id: 'e5', title: 'Removed one', fetchedAt: 5, sourceId: 's2' }),
  ]

  it('groups by source, orders by newest and caps each group', () => {
    const result = groupEntries(entries, sources, { view: 'inbox' })
    expect(result.total).toBe(5)
    expect(result.filteredUnread).toBe(3)
    expect(result.totalGroups).toBe(3)
    expect(result.groups.map(group => group.sourceId)).toEqual(['s1', undefined, 's2'])
    const first = result.groups[0]!
    expect(first).toMatchObject({ name: 'Feed One', kind: 'rss', removed: false, enabled: true, total: 3, unread: 1, latestAt: 40, hasMore: false })
    expect(first.entries.map(item => item.id)).toEqual(['e4', 'e1', 'e3'])
    expect(first.entries[0]).not.toHaveProperty('content')
    expect(result.groups[1]).toMatchObject({ name: '', total: 1, unread: 1, removed: false })
    expect(result.groups[2]).toMatchObject({ name: 'Removed feed', removed: true, total: 1, unread: 1 })
  })

  it('caps one busy group and keeps its totals', () => {
    const result = groupEntries(entries, sources, { view: 'inbox' }, 2)
    const first = result.groups[0]!
    expect(first.entries.map(item => item.id)).toEqual(['e4', 'e1'])
    expect(first.total).toBe(3)
    expect(first.hasMore).toBe(true)
  })

  it('applies the same filters as the flat read', () => {
    expect(groupEntries(entries, sources, { view: 'inbox', unread: true }).groups.map(group => [group.sourceId, group.total, group.entries.map(item => item.id)])).toEqual([
      [undefined, 1, ['e2']],
      ['s1', 1, ['e3']],
      ['s2', 1, ['e5']],
    ])
    expect(groupEntries(entries, sources, { view: 'inbox', search: 'needle' }).groups.map(group => group.sourceId)).toEqual(['s1'])
    expect(groupEntries(entries, sources, { view: 'saved' }).groups.map(group => group.entries.map(item => item.id))).toEqual([['e1']])
  })

  it('normalizes the per-group size and breaks empty filters', () => {
    expect(groupEntries(entries, sources, { view: 'inbox' }, 0).groups[0]?.entries).toHaveLength(1)
    expect(groupEntries(entries, sources, { view: 'inbox' }, 99).groups[0]?.entries).toHaveLength(3)
    expect(groupEntries(entries, sources, { view: 'inbox' }, Number.NaN).groups[0]?.entries).toHaveLength(3)
    expect(groupEntries([], sources, { view: 'inbox' })).toMatchObject({ groups: [], total: 0, totalGroups: 0, filteredUnread: 0 })
  })
})

describe('inbox model scheduling', () => {
  it('decides whether a source is due', () => {
    expect(isDue(source({ lastCheckedAt: 0, intervalMs: 60_000 }), 60_000, settings)).toBe(true)
    expect(isDue(source({ intervalMs: 60_000 }), 60_000, settings)).toBe(true)
    expect(isDue(source({ lastCheckedAt: 100, intervalMs: 60_000 }), 60_099, settings)).toBe(false)
    expect(isDue(source({ lastCheckedAt: 100, intervalMs: 60_000 }), 60_100 + 1, settings)).toBe(true)
    expect(isDue(source({ backoffUntil: 200 }), 100, settings)).toBe(false)
    // No override: the family setting decides, so `0` keeps refreshing
    // instead of silently never running.
    expect(isDue(source({ intervalMs: 0, lastCheckedAt: 0 }), 100, settings)).toBe(false)
    expect(isDue(source({ intervalMs: 0, lastCheckedAt: 0 }), settings.feedRefreshMs, settings)).toBe(true)
    expect(isDue(source({ kind: 'github', intervalMs: 0, lastCheckedAt: 0 }), settings.githubRefreshMs, settings)).toBe(true)
    expect(isDue(source({ intervalMs: 60_000, lastCheckedAt: 0 }), settings.feedRefreshMs, settings)).toBe(true)
    expect(isDue(source({ enabled: false }), 100, settings)).toBe(false)
    expect(isDue(source({ removed: true }), 100, settings)).toBe(false)
  })

  it('resolves the period a source follows', () => {
    expect(effectiveInterval(source({ intervalMs: 60_000 }), settings)).toBe(60_000)
    expect(effectiveInterval(source({ intervalMs: 0 }), settings)).toBe(settings.feedRefreshMs)
    expect(effectiveInterval(source({ kind: 'github', intervalMs: 0 }), settings)).toBe(settings.githubRefreshMs)
  })

  it('backs off exponentially with a cap', () => {
    expect(backoffMs(0, 1000)).toBe(0)
    expect(backoffMs(1, 1000)).toBe(2000)
    expect(backoffMs(2, 1000)).toBe(4000)
    expect(backoffMs(1, 0)).toBe(2 * 5 * 60_000)
    expect(backoffMs(40, 1000)).toBe(24 * 60 * 60_000)
  })
})
