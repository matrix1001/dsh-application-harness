import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { CapabilityAccess } from '@matrix1001/dsh-application-harness-runtime'
import { fetchPageMeta, fetchText, pullSource } from '../src/refresh.ts'
import type { FetchImpl } from '../src/refresh.ts'
import { hashText } from '../src/model.ts'
import type { Source } from '../src/model.ts'

const signal = new AbortController().signal

function capabilities(refuse = false): CapabilityAccess & { uses: number } {
  const door = {
    appId: 'inbox',
    uses: 0,
    async use<T>(name: string, work: () => T | Promise<T>): Promise<T> {
      door.uses += 1
      if (refuse) throw new AppError('capability-not-approved', `no ${name}`)
      return await work()
    },
  }
  return door
}

function transport(body: string, status = 200, seen: Array<{ url: string; headers: Record<string, string> }> = []): FetchImpl {
  return async (url, init) => {
    seen.push({ url, headers: init.headers })
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
}

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

describe('fetchText', () => {
  it('reads a body through the network capability', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const door = capabilities()
    const text = await fetchText({ fetch: transport('hello', 200, seen), signal, capabilities: door }, 'https://x.test/', { accept: 'text/plain' })
    expect(text).toBe('hello')
    expect(door.uses).toBe(1)
    expect(seen[0]).toEqual({ url: 'https://x.test/', headers: { accept: 'text/plain' } })
  })

  it('bounds a hanging transport with an application deadline', async () => {
    const hanging: FetchImpl = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
    await expect(fetchText({ fetch: hanging, signal, capabilities: capabilities(), timeoutMs: 10 }, 'https://x.test/', {}))
      .rejects.toThrow(/timed out after 10ms/u)
  })

  it('keeps a body-read error when the deadline is not the cause', async () => {
    const broken: FetchImpl = async () => ({ ok: true, status: 200, text: async () => { throw new Error('body broke') } })
    await expect(fetchText({ fetch: broken, signal, capabilities: capabilities() }, 'https://x.test/', {}))
      .rejects.toThrow(/body broke/u)
  })

  it('applies the deadline while reading the response body', async () => {
    const bodyHangs: FetchImpl = async (_url, init) => ({
      ok: true,
      status: 200,
      text: async () => await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    await expect(fetchText({ fetch: bodyHangs, signal, capabilities: capabilities(), timeoutMs: 10 }, 'https://x.test/', {}))
      .rejects.toThrow(/timed out after 10ms/u)
  })

  it('refuses a non-OK status, an oversized body and a refused capability', async () => {
    await expect(fetchText({ fetch: transport('nope', 404), signal, capabilities: capabilities() }, 'https://x.test/', {})).rejects.toThrow(/HTTP 404/)
    await expect(fetchText({ fetch: transport('x'.repeat(20)), signal, capabilities: capabilities() }, 'https://x.test/', {}, 10)).rejects.toThrow(/exceeds 10 bytes/)
    await expect(fetchText({ fetch: transport('ok'), signal, capabilities: capabilities(true) }, 'https://x.test/', {})).rejects.toMatchObject({ code: 'capability-not-approved' })
  })
})

describe('fetchPageMeta', () => {
  it('returns the page title and description', async () => {
    const html = '<html><head><title>Page</title><meta name="description" content="About"></head><body><p>Text</p></body></html>'
    await expect(fetchPageMeta('https://x.test/', { fetch: transport(html), signal, capabilities: capabilities() }))
      .resolves.toEqual({ title: 'Page', description: 'About', text: 'Text' })
  })

  it('omits a missing title or description', async () => {
    await expect(fetchPageMeta('https://x.test/', { fetch: transport('<p>Only text</p>'), signal, capabilities: capabilities() }))
      .resolves.toEqual({ text: 'Only text' })
  })
})

describe('pullSource GitHub', () => {
  const release = { id: 1, tag_name: 'v1', name: 'One', body: 'Notes', html_url: 'https://gh.test/1', published_at: '2026-01-01T00:00:00Z' }

  it('reads releases anonymously and with a token', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const anonymous = await pullSource(source({ kind: 'github', url: 'https://github.com/o/r', config: { repo: 'o/r' } }), {
      fetch: transport(JSON.stringify([release]), 200, seen),
      signal,
      capabilities: capabilities(),
    })
    expect(anonymous.entries).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.github.com/repos/o/r/releases?per_page=20')
    expect(seen[0]?.headers.authorization).toBeUndefined()
    const authenticated = await pullSource(source({ kind: 'github', url: 'https://github.com/o/r', config: { repo: 'o/r' } }), {
      fetch: transport('[]', 200, seen),
      signal,
      capabilities: capabilities(),
      token: 'secret',
    })
    expect(authenticated.entries).toEqual([])
    expect(seen[1]?.headers.authorization).toBe('Bearer secret')
    expect(seen[1]?.headers['x-github-api-version']).toBe('2022-11-28')
  })

  it('derives the repository from the source URL when config carries none', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    await pullSource(source({ kind: 'github', url: 'https://github.com/o/r2', config: {} }), {
      fetch: transport('[]', 200, seen),
      signal,
      capabilities: capabilities(),
    })
    expect(seen[0]?.url).toBe('https://api.github.com/repos/o/r2/releases?per_page=20')
  })

  it('fails loudly on invalid JSON and on a non-array response', async () => {
    const options = { signal, capabilities: capabilities() }
    await expect(pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), { ...options, fetch: transport('not json') })).rejects.toThrow(/not valid JSON/)
    await expect(pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), { ...options, fetch: transport('{}') })).rejects.toThrow(/invalid GitHub releases response/)
  })
})

describe('pullSource RSS', () => {
  it('maps feed entries and hashes their content', async () => {
    const xml = '<rss><channel><title>Feed</title><item><guid>g1</guid><title>One</title><link>https://x.test/1</link><description>Body</description><pubDate>2026-01-01T00:00:00Z</pubDate></item><item><guid>g2</guid><title>Two</title><description>Other</description></item></channel></rss>'
    const result = await pullSource(source(), { fetch: transport(xml), signal, capabilities: capabilities() })
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1]?.publishedAt).toBeUndefined()
    expect(result.entries[0]).toMatchObject({ externalId: 'g1', title: 'One', url: 'https://x.test/1', summary: 'Body', publishedAt: Date.parse('2026-01-01T00:00:00Z') })
    expect(result.entries[0]?.contentHash).toBe(hashText('One\nBody\nBody'))
    expect(result.snapshot).toBeUndefined()
  })

  it('accepts a titled feed with no items and refuses a non-feed body', async () => {
    await expect(pullSource(source(), { fetch: transport('<rss><channel><title>Empty</title></channel></rss>'), signal, capabilities: capabilities() }))
      .resolves.toEqual({ entries: [] })
    await expect(pullSource(source(), { fetch: transport('<html>nope</html>'), signal, capabilities: capabilities() })).rejects.toThrow(/not an RSS/)
  })
})

describe('pullSource web', () => {
  const page = '<html><head><title>Watched</title></head><body><p>First</p></body></html>'

  it('sets a baseline without an entry on the first read', async () => {
    const result = await pullSource(source({ kind: 'web', name: 'Page', url: 'https://page.test/', config: {} }), {
      fetch: transport(page), signal, capabilities: capabilities(),
    })
    expect(result.entries).toEqual([])
    expect(result.snapshot).toEqual({ hash: hashText('First'), text: 'First' })
  })

  it('does nothing when the snapshot is unchanged', async () => {
    const result = await pullSource(source({ kind: 'web', config: { snapshotHash: hashText('First') } }), {
      fetch: transport(page), signal, capabilities: capabilities(),
    })
    expect(result.entries).toEqual([])
  })

  it('reports a change entry with the page title', async () => {
    const result = await pullSource(source({ kind: 'web', name: 'Page', url: 'https://page.test/', config: { snapshotHash: 'old' } }), {
      fetch: transport(page), signal, capabilities: capabilities(),
    })
    expect(result.entries[0]).toMatchObject({
      externalId: `change:${hashText('First')}`,
      title: 'Watched',
      url: 'https://page.test/',
      summary: 'First',
      content: '页面内容发生了变化。\n\nFirst',
      contentHash: hashText('First'),
    })
    expect(result.entries[0]?.publishedAt).toBeUndefined()
  })

  it('falls back to the source name when the page has no title', async () => {
    const result = await pullSource(source({ kind: 'web', name: 'Page', config: { snapshotHash: 'old' } }), {
      fetch: transport('<p>Changed</p>'), signal, capabilities: capabilities(),
    })
    expect(result.entries[0]?.title).toBe('Page')
  })

  it('reads the selector result when one matches and the page text otherwise', async () => {
    const html = '<html><body><div id="main"><p>Selected</p></div><p>Rest</p></body></html>'
    const selected = await pullSource(source({ kind: 'web', config: { selector: '#main' } }), {
      fetch: transport(html), signal, capabilities: capabilities(),
    })
    expect(selected.snapshot?.text).toBe('Selected')
    const unmatched = await pullSource(source({ kind: 'web', config: { selector: '#missing' } }), {
      fetch: transport(html), signal, capabilities: capabilities(),
    })
    expect(unmatched.snapshot?.text).toBe('Selected\n\nRest')
  })

  it('refuses a page with no readable text', async () => {
    await expect(pullSource(source({ kind: 'web', config: {} }), { fetch: transport('<html><script>x</script></html>'), signal, capabilities: capabilities() }))
      .rejects.toThrow(/no readable text/)
  })
})

describe('pullSource dispatch', () => {
  it('refuses an unknown source kind', async () => {
    await expect(pullSource({ ...source(), kind: 'other' as never }, { fetch: transport(''), signal, capabilities: capabilities() }))
      .rejects.toThrow(/unknown source kind/)
  })

  it('combines the caller signal with the request deadline', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<FetchImpl>(async () => ({ ok: true, status: 200, text: async () => '<rss><channel><title>x</title></channel></rss>' }))
    await pullSource(source(), { fetch, signal: controller.signal, capabilities: capabilities() })
    const passed = fetch.mock.calls[0]?.[1].signal
    expect(passed).not.toBe(controller.signal)
    expect(passed?.aborted).toBe(false)
    controller.abort()
    expect(passed?.aborted).toBe(true)
  })
})
