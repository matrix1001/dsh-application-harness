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

describe('fetchText without a host network service', () => {
  it('refuses the direct fetch when fallback is disabled', async () => {
    const fetch = async () => { throw new Error('must not be used') }
    await expect(fetchText({ fetch, signal: new AbortController().signal, capabilities: capabilities(), allowFetchFallback: false }, 'https://x.test/', {})).rejects.toThrow(/network service is unavailable/u)
  })
})

describe('fetchText through the host network service', () => {
  it('delegates to applicationHttp with the redirect/private fences and the byte cap', async () => {
    const calls: unknown[] = []
    const http = {
      getJson: async (url: string, init: unknown) => {
        calls.push({ url, init })
        return { ok: true, status: 200, text: async () => 'hello' }
      },
    }
    const signal = new AbortController().signal
    const text = await fetchText({ fetch: async () => { throw new Error('must not be used') }, http, signal, capabilities: capabilities() }, 'https://x.test/', { accept: 'text/plain' }, 12)
    expect(text).toBe('hello')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: 'https://x.test/', init: { maxBytes: 12, followRedirects: true, allowPrivate: false } })
  })
})

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
  const atom = `<feed><title>Release notes from r</title>
    <entry><id>tag:github.com,2008:Repository/1/v1</id><title>One</title>
      <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1" />
      <updated>2026-01-01T00:00:00Z</updated>
      <content type="html">&lt;p&gt;Notes &amp;amp; more&lt;/p&gt;</content></entry>
    </feed>`
  const releasesPage = `<html><body>
    <section id="release-v1">
      <h2 class="sr-only">One</h2>
      <a href="/o/r/releases/tag/v1">One</a>
      <div data-test-selector="body-content"><p>Notes from the page</p></div>
      <relative-time datetime="2026-01-01T00:00:00Z">1 Jan</relative-time>
    </section>
  </body></html>`

  /** A routed transport: the atom URL and the page URL may answer differently. */
  function githubTransport(seen: Array<{ url: string; headers: Record<string, string> }>, atomReply: { status: number; body: string }, pageReply: { status: number; body: string } = { status: 404, body: '' }): FetchImpl {
    return async (url, init) => {
      seen.push({ url, headers: init.headers })
      const reply = url.endsWith('/releases.atom') ? atomReply : pageReply
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => reply.body }
    }
  }

  it('reads the Atom web feed first, not the GitHub API', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await pullSource(source({ kind: 'github', url: 'https://github.com/o/r', config: { repo: 'o/r' } }), {
      fetch: githubTransport(seen, { status: 200, body: atom }),
      signal,
      capabilities: capabilities(),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://github.com/o/r/releases.atom')
    expect(seen[0]?.headers.accept).toContain('application/atom+xml')
    expect(seen[0]?.headers.authorization).toBeUndefined()
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      externalId: 'release:https://github.com/o/r/releases/tag/v1',
      title: 'One',
      url: 'https://github.com/o/r/releases/tag/v1',
      summary: 'Notes & more',
      publishedAt: Date.parse('2026-01-01T00:00:00Z'),
    })
  })

  it('falls back to the releases page when the feed answers an HTTP error', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), {
      fetch: githubTransport(seen, { status: 429, body: 'rate limited' }, { status: 200, body: releasesPage }),
      signal,
      capabilities: capabilities(),
    })
    expect(seen.map(call => call.url)).toEqual(['https://github.com/o/r/releases.atom', 'https://github.com/o/r/releases'])
    expect(seen[1]?.headers.accept).toContain('text/html')
    expect(result.entries[0]).toMatchObject({
      externalId: 'release:https://github.com/o/r/releases/tag/v1',
      title: 'One',
      summary: 'Notes from the page',
      publishedAt: Date.parse('2026-01-01T00:00:00Z'),
    })
  })

  it('falls back to the releases page when the feed body is not Atom', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), {
      fetch: githubTransport(seen, { status: 200, body: '<html>not a feed</html>' }, { status: 200, body: releasesPage }),
      signal,
      capabilities: capabilities(),
    })
    expect(result.entries).toHaveLength(1)
    expect(seen[1]?.url).toBe('https://github.com/o/r/releases')
  })

  it('returns no entries for a valid releases feed of an empty repository', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), {
      fetch: githubTransport(seen, { status: 200, body: '<feed><title>Release notes from r</title></feed>' }),
      signal,
      capabilities: capabilities(),
    })
    expect(result.entries).toEqual([])
    expect(seen).toHaveLength(1)
  })

  it('keeps a feed entry without a link addressable by its feed identity', async () => {
    const atomNoLink = '<feed><title>Release notes from r</title><entry><id>tag:1</id><title>No link</title><updated>2026-01-01T00:00:00Z</updated></entry></feed>'
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), {
      fetch: githubTransport(seen, { status: 200, body: atomNoLink }),
      signal,
      capabilities: capabilities(),
    })
    expect(result.entries[0]).toMatchObject({ externalId: 'release:tag:1', title: 'No link', url: '' })
  })

  it('derives the repository from the source URL when config carries none', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    await pullSource(source({ kind: 'github', url: 'https://github.com/o/r2', config: {} }), {
      fetch: githubTransport(seen, { status: 200, body: '<feed><title>Empty</title></feed>' }),
      signal,
      capabilities: capabilities(),
    })
    expect(seen[0]?.url).toBe('https://github.com/o/r2/releases.atom')
  })

  it('fails loudly when both the feed and the releases page fail', async () => {
    await expect(pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), {
      fetch: githubTransport([], { status: 404, body: '' }, { status: 404, body: '' }),
      signal,
      capabilities: capabilities(),
    })).rejects.toThrow(/the GitHub releases read failed: HTTP 404 .*the releases page failed: HTTP 404/u)
  })

  it('fails loudly when the releases page has no recognizable releases', async () => {
    await expect(pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), {
      fetch: githubTransport([], { status: 404, body: '' }, { status: 200, body: '<html><body>changed markup</body></html>' }),
      signal,
      capabilities: capabilities(),
    })).rejects.toThrow(/no recognizable releases/)
  })

  it('skips the releases page when the feed failed on the transport', async () => {
    const seen: Array<{ url: string }> = []
    const fetch: FetchImpl = async (url) => {
      seen.push({ url })
      throw new TypeError('fetch failed')
    }
    await expect(pullSource(source({ kind: 'github', config: { repo: 'o/r' } }), { fetch, signal, capabilities: capabilities() }))
      .rejects.toThrow(/the releases page was not attempted/u)
    // One retry of the feed, and no HTML page request on the same broken route.
    expect(seen.map(call => call.url)).toEqual(['https://github.com/o/r/releases.atom', 'https://github.com/o/r/releases.atom'])
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
  })

  it('accepts a titled feed with no items and refuses a non-feed body', async () => {
    await expect(pullSource(source(), { fetch: transport('<rss><channel><title>Empty</title></channel></rss>'), signal, capabilities: capabilities() }))
      .resolves.toEqual({ entries: [], title: 'Empty' })
    await expect(pullSource(source(), { fetch: transport('<html>nope</html>'), signal, capabilities: capabilities() })).rejects.toThrow(/not an RSS/)
  })

  it('retries one transport accident before recording a failure', async () => {
    let attempts = 0
    const fetch: FetchImpl = async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('fetch failed')
      return { ok: true, status: 200, text: async () => '<rss><channel><title>Feed</title></channel></rss>' }
    }
    await expect(pullSource(source(), { fetch, signal, capabilities: capabilities() })).resolves.toEqual({ entries: [], title: 'Feed' })
    expect(attempts).toBe(2)
  })

  it('does not retry an answer from the server', async () => {
    let attempts = 0
    const fetch: FetchImpl = async () => {
      attempts += 1
      return { ok: false, status: 500, text: async () => '' }
    }
    await expect(pullSource(source(), { fetch, signal, capabilities: capabilities() })).rejects.toThrow(/HTTP 500/u)
    expect(attempts).toBe(1)
  })
})

describe('pullSource dispatch', () => {
  it('refuses an unknown source kind, including the removed web watch', async () => {
    await expect(pullSource({ ...source(), kind: 'other' as never }, { fetch: transport(''), signal, capabilities: capabilities() }))
      .rejects.toThrow(/unknown source kind/)
    await expect(pullSource({ ...source(), kind: 'web' as never }, { fetch: transport(''), signal, capabilities: capabilities() }))
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
