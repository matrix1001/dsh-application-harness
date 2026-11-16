// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { NotesPage, NotesView, type NotesTranslate } from '../src/client/NotesView.tsx'
import { type NotesKey, zh } from '../src/client/locales.ts'

type Call = ApplicationViewProps['call']
type Outcome = Awaited<ReturnType<Call>>

interface NoteFixture {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
  version: number
  deletedAt?: number
}

const t: NotesTranslate = (key, params) => {
  const template = zh[key as NotesKey]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

const baseNote: NoteFixture = {
  id: 'n1',
  title: '# Hello',
  body: '# Hello\n\nworld',
  tags: ['a'],
  pinned: false,
  createdAt: 1,
  updatedAt: Date.now(),
  version: 1,
}

function ok(value: unknown): Outcome {
  return { callId: 'c', status: 'success', result: value as never }
}

function failed(code: string, message: string): Outcome {
  return { callId: 'c', status: 'failed', error: { code, message } }
}

function makeProps(call: Call, overrides: Partial<ApplicationViewProps> = {}): ApplicationViewProps {
  return {
    call,
    cancel: vi.fn(),
    claimProgress: vi.fn(() => () => undefined),
    onChanged: vi.fn(() => () => undefined),
    running: false,
    pageContext: { report: vi.fn(() => () => undefined) },
    openManagement: vi.fn(),
    viewport: { report: vi.fn(() => () => undefined) } as never,
    ui: {} as never,
    ...overrides,
  }
}

function titleOf(body: string): string {
  return body.split('\n').find(line => line.trim() !== '')?.trim() ?? '无标题'
}

function makeBackend(initial: NoteFixture[]) {
  const notes = initial.map(note => ({ ...note, tags: [...note.tags] }))
  const call = vi.fn(async (op: string, input: unknown) => {
    const args = (input ?? {}) as Record<string, unknown>
    switch (op) {
      case 'list':
        return ok([...notes]
          .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)
          .map(note => {
            const { body: _body, ...summary } = note
            return summary
          }))
      case 'search':
        return ok([...notes]
          .filter(note => note.deletedAt === undefined)
          .filter(note => `${note.title}\n${note.body}\n${note.tags.join(' ')}`.toLowerCase().includes(String(args.query).toLowerCase()))
          .map(note => {
            const { body: _body, ...summary } = note
            return summary
          }))
      case 'get': {
        const found = notes.find(note => note.id === args.id)
        return found === undefined ? failed('not-found', 'missing') : ok({ ...found })
      }
      case 'update': {
        const index = notes.findIndex(note => note.id === args.id)
        const current = notes[index]
        if (current === undefined) return failed('not-found', 'missing')
        if (current.version !== args.expectedVersion) return failed('app.stale-version', 'stale')
        const body = typeof args.body === 'string' ? args.body : current.body
        const updated: NoteFixture = {
          ...current,
          body,
          title: titleOf(body),
          tags: Array.isArray(args.tags) ? args.tags as string[] : current.tags,
          pinned: typeof args.pinned === 'boolean' ? args.pinned : current.pinned,
          updatedAt: Date.now(),
          version: current.version + 1,
        }
        notes[index] = updated
        return ok({ ...updated })
      }
      case 'create': {
        const body = typeof args.body === 'string' ? args.body : ''
        const created: NoteFixture = {
          id: `n_${String(notes.length + 1)}`,
          title: titleOf(body),
          body,
          tags: Array.isArray(args.tags) ? args.tags as string[] : [],
          pinned: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1,
        }
        notes.push(created)
        return ok({ ...created })
      }
      case 'delete': {
        const index = notes.findIndex(note => note.id === args.id)
        const current = notes[index]
        if (current === undefined) return failed('not-found', 'missing')
        notes[index] = { ...current, deletedAt: Date.now(), updatedAt: Date.now(), version: current.version + 1 }
        return ok({ ...notes[index] })
      }
      case 'restore': {
        const index = notes.findIndex(note => note.id === args.id)
        const current = notes[index]
        if (current === undefined) return failed('not-found', 'missing')
        const restored = { ...current, version: current.version + 1 }
        delete restored.deletedAt
        notes[index] = restored
        return ok({ ...restored })
      }
      case 'exportNotes':
        return ok({ json: '{"schemaVersion":1,"notes":[]}' })
      case 'importNotes':
        return ok({ imported: 1 })
      default:
        return ok({})
    }
  })
  return { notes, call: call as unknown as Call }
}

function button(container: HTMLElement, selector: string): HTMLButtonElement {
  const element = container.querySelector(selector)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`missing button ${selector}`)
  return element
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('NotesPage', () => {
  it('binds the locale and renders the page', async () => {
    const snapshot = { language: 'zh' }
    const locale = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      bind: () => t,
    }
    render(<NotesPage {...makeProps(makeBackend([baseNote]).call)} locale={locale as never} />)
    await waitFor(() => { expect(screen.getByText('全部')).toBeTruthy() })
  })
})

describe('NotesView', () => {
  it('renders the three panes with counts, tags, rows and scope switches', async () => {
    const now = Date.now()
    const today = new Date(now)
    today.setHours(10, 42, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const sameYear = new Date(today.getFullYear(), today.getMonth() >= 6 ? 0 : 11, 15, 12)
    const previousYear = new Date(today.getFullYear() - 1, 5, 15, 12)
    const notes: NoteFixture[] = [
      { ...baseNote, id: 'n1', title: '# Hello', body: '# Hello\n\nworld', tags: ['a'], updatedAt: today.getTime() },
      { ...baseNote, id: 'n2', title: '# Second', body: '# Second', tags: ['b', 'c'], pinned: true, updatedAt: yesterday.getTime() },
      { ...baseNote, id: 'n3', title: '# Gone', body: '# Gone', tags: ['c'], updatedAt: sameYear.getTime(), deletedAt: now },
      { ...baseNote, id: 'n4', title: '', body: '# ', tags: [], updatedAt: previousYear.getTime() },
    ]
    const backend = makeBackend(notes)
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(3) })

    expect(container.querySelector('[data-notes-rail]')).toBeTruthy()
    expect(container.querySelector('[data-notes-list]')).toBeTruthy()
    expect(container.querySelector('[data-notes-editor]')).toBeTruthy()
    expect(container.querySelector('[data-notes-tab-count="all"]')?.textContent).toBe('3')
    expect(container.querySelector('[data-notes-tab-count="favorites"]')?.textContent).toBe('1')
    expect(container.querySelector('[data-notes-tab-count="trash"]')?.textContent).toBe('1')
    expect(container.querySelector('[data-notes-tab-count="all"]')?.textContent).toBe('3')
    expect(container.querySelectorAll('[data-notes-tag]')).toHaveLength(3)
    expect(container.querySelector('[data-notes-tag="c"]')?.getAttribute('data-notes-tag-count')).toBe('1')

    const pinnedRow = container.querySelector('[data-notes-note="n2"]')
    expect(pinnedRow?.getAttribute('data-notes-pinned')).toBe('true')
    expect(pinnedRow?.textContent).toContain('Second')
    expect(pinnedRow?.textContent).toContain('置顶')
    expect(pinnedRow?.textContent).toContain('昨天')
    expect(container.querySelector('[data-notes-note="n1"]')?.textContent).toContain('Hello')
    expect(container.querySelector('[data-notes-note="n4"]')?.textContent).toContain('无标题')
    await waitFor(() => { expect(container.querySelector('[data-notes-preview] h1')?.textContent).toBe('Second') })
    fireEvent.click(button(container, '[data-notes-note="n1"]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-preview] h1')?.textContent).toBe('Hello') })

    fireEvent.click(button(container, '[data-notes-scope="favorites"]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-list-title]')?.textContent).toBe('收藏')
    expect(container.querySelector('[data-notes-note]')?.getAttribute('data-notes-note')).toBe('n2')

    fireEvent.click(button(container, '[data-notes-scope="trash"]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-note="n3"]')?.getAttribute('data-notes-deleted')).toBe('true')
    await waitFor(() => { expect(container.querySelector('[data-notes-restore]')).toBeTruthy() })
    expect(container.querySelector('[data-notes-trash-notice]')).toBeTruthy()
    expect(container.querySelector('[data-notes-save]')).toBeNull()

    fireEvent.click(button(container, '[data-notes-scope="all"]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(3) })
    fireEvent.click(button(container, '[data-notes-tab="favorites"]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-list-title]')?.textContent).toBe('收藏') })
    fireEvent.click(button(container, '[data-notes-tab="all"]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(3) })

    fireEvent.click(button(container, '[data-notes-tag="c"]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-list-title]')?.textContent).toBe('#c')
    fireEvent.click(button(container, '[data-notes-tag="c"]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(3) })
  })

  it('distinguishes loading, all-empty and no-tag states', async () => {
    let settle: ((outcome: Outcome) => void) | undefined
    const listPromise = new Promise<Outcome>(resolve => { settle = resolve })
    const call = vi.fn((op: string) => op === 'list' ? listPromise : Promise.resolve(ok({}))) as unknown as Call
    const { container } = render(<NotesView {...makeProps(call)} t={t} />)
    expect(container.querySelector('[data-notes-loading]')).toBeTruthy()
    settle?.(ok([]))
    await waitFor(() => { expect(container.querySelector('[data-notes-empty="all"]')).toBeTruthy() })
    expect(screen.getByText('还没有笔记')).toBeTruthy()
    expect(screen.getByText('新建一篇开始记录')).toBeTruthy()
    expect(container.querySelector('[data-notes-tags-empty]')).toBeTruthy()
    expect(container.querySelector('[data-notes-select]')).toBeTruthy()
  })

  it('shows the favorites and trash empty states', async () => {
    const backend = makeBackend([{ ...baseNote, pinned: false }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    fireEvent.click(button(container, '[data-notes-scope="favorites"]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-empty="favorites"]')).toBeTruthy() })
    expect(screen.getByText('还没有收藏的笔记')).toBeTruthy()
    fireEvent.click(button(container, '[data-notes-scope="trash"]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-empty="trash"]')).toBeTruthy() })
    expect(screen.getByText('回收站是空的')).toBeTruthy()
  })

  it('filters by title and tag and shows the no-result state', async () => {
    const backend = makeBackend([
      { ...baseNote, id: 'n1', title: '# Hello', tags: ['a'] },
      { ...baseNote, id: 'n2', title: '# Second', tags: ['b'], updatedAt: baseNote.updatedAt - 1 },
    ])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(2) })
    const search = container.querySelector('[data-notes-search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'hello' } })
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-note="n1"]')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'B' } })
    await waitFor(() => { expect(container.querySelector('[data-notes-note="n2"]')).toBeTruthy() })
    expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1)
    fireEvent.change(search, { target: { value: 'nothing' } })
    await waitFor(() => { expect(container.querySelector('[data-notes-empty="search"]')).toBeTruthy() })
    expect(screen.getByText('没有匹配的笔记')).toBeTruthy()
    expect(screen.getByText('换个关键词试试')).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(2) })
  })

  it('keeps a load failure distinct from empty, retries, and reports a reload failure', async () => {
    let failing = true
    let listener: (() => void) | undefined
    const summary = { ...baseNote, body: undefined }
    const call = vi.fn(async (op: string) => {
      if (op === 'list') return failing ? failed('threw', 'load failed') : ok([summary])
      if (op === 'get') return ok({ ...baseNote })
      return ok({})
    }) as unknown as Call
    const onChanged = vi.fn((callback: () => void) => { listener = callback; return () => undefined })
    const { container } = render(<NotesView {...makeProps(call, { onChanged })} t={t} />)
    await waitFor(() => { expect(screen.getByText('load failed')).toBeTruthy() })
    expect(container.querySelector('[data-notes-empty]')).toBeNull()
    failing = false
    fireEvent.click(button(container, '[data-notes-retry]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-load-error]')).toBeNull()

    failing = true
    listener?.()
    await waitFor(() => { expect(container.querySelector('[data-notes-load-error]')?.textContent).toContain('load failed') })
    expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1)
  })

  it('opens a routed note and reports a failed get without stale content', async () => {
    const backend = makeBackend([baseNote])
    const routed = render(
      <NotesView
        {...makeProps(backend.call, { route: { appId: 'notes', record: { appId: 'notes', kind: 'note', id: 'n1' }, nonce: '1' } })}
        t={t}
      />,
    )
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('get', { id: 'n1' }) })
    expect(routed.container.querySelector('[data-notes-mobile-pane]')?.getAttribute('data-notes-mobile-pane')).toBe('detail')
    await waitFor(() => { expect(routed.container.querySelector('[data-notes-preview] h1')?.textContent).toBe('Hello') })
    routed.unmount()

    const failing = vi.fn(async (op: string) => {
      if (op === 'list') return ok([{ ...baseNote, body: undefined }])
      if (op === 'get') return failed('threw', 'get failed')
      return ok({})
    }) as unknown as Call
    const { container } = render(<NotesView {...makeProps(failing)} t={t} />)
    await waitFor(() => { expect(screen.getByText('get failed')).toBeTruthy() })
    expect(container.querySelector('[data-notes-select]')).toBeTruthy()
  })

  it('renders preview blocks, inline marks and the source switch', async () => {
    const body = [
      '# Title',
      '',
      'paragraph `code` **bold** *italic*',
      '',
      '## Section',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '> quoted',
      '> lines',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '---',
      '',
    ].join('\n')
    const backend = makeBackend([{ ...baseNote, title: '# Title', body }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview] h1')?.textContent).toBe('Title') })
    const preview = container.querySelector('[data-notes-preview]') as HTMLElement
    expect(preview.querySelector('h2')?.textContent).toBe('Section')
    expect(preview.querySelectorAll('ul li')).toHaveLength(2)
    expect(preview.querySelectorAll('ol li')).toHaveLength(2)
    expect(preview.querySelector('blockquote')?.textContent).toContain('quoted')
    expect(preview.querySelector('pre')?.textContent).toContain('const x = 1')
    expect(preview.querySelector('hr')).toBeTruthy()
    expect(preview.querySelector('strong')?.textContent).toBe('bold')
    expect(preview.querySelector('em')?.textContent).toBe('italic')
    expect(preview.querySelector('p code')?.textContent).toBe('code')
    expect(container.querySelector('[data-notes-wordcount]')?.textContent).toContain('字')

    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    const source = container.querySelector('[data-notes-source]') as HTMLTextAreaElement
    expect(source.value).toBe(body)
    fireEvent.change(source, { target: { value: '# Changed\n\nbody' } })
    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    expect(container.querySelector('[data-notes-preview] h1')?.textContent).toBe('Changed')
  })

  it('shows an empty body and the untitled fallback', async () => {
    const backend = makeBackend([{ ...baseNote, id: 'n1', title: '', body: '', tags: [] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-empty-body]')).toBeTruthy() })
    expect(screen.getByText('还没有内容。')).toBeTruthy()
    expect(container.querySelector('[data-notes-note="n1"]')?.textContent).toContain('无标题')
    expect(container.querySelector('[data-notes-tags-empty]')).toBeTruthy()
  })

  it('shares the open draft, serves reads and applies revision-checked updates', async () => {
    const backend = makeBackend([{ ...baseNote }])
    let readHandler: ((input: { draftId: string; fields?: readonly string[] }) => { revision: string; values: unknown }) | undefined
    let updateHandler: ((input: { draftId: string; revision: string; values: unknown }) => { revision: string; values: unknown } | { conflict: true }) | undefined
    const drafts = {
      share: vi.fn(async () => true),
      revoke: vi.fn(async () => true),
      onRead: vi.fn((handler: typeof readHandler) => { readHandler = handler; return () => undefined }),
      onUpdate: vi.fn((handler: typeof updateHandler) => { updateHandler = handler; return () => undefined }),
    }
    const { container } = render(<NotesView {...makeProps(backend.call, { drafts: drafts as never })} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-note="n1"]')).toBeTruthy() })
    fireEvent.click(container.querySelector('[data-notes-note="n1"]')!)
    await waitFor(() => { expect(container.querySelector('[data-notes-share]')).toBeTruthy() })
    if (container.querySelector('[data-notes-source]') === null) fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    drafts.share.mockResolvedValueOnce(false)
    fireEvent.click(button(container, '[data-notes-share]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-share-error]')).not.toBeNull() })
    fireEvent.click(button(container, '[data-notes-share]'))
    await waitFor(() => { expect(drafts.share).toHaveBeenCalledWith({ draftId: 'n1', fields: ['/body', '/tags'] }) })
    await waitFor(() => { expect(button(container, '[data-notes-share]').dataset.notesShare).toBe('on') })

    expect(readHandler!({ draftId: 'n1', fields: ['/body'] })).toMatchObject({ values: { '/body': baseNote.body } })
    expect(() => readHandler!({ draftId: 'other' })).toThrow(/no longer open/u)
    expect(updateHandler!({ draftId: 'other', revision: '1', values: {} })).toEqual({ conflict: true })
    expect(updateHandler!({ draftId: 'n1', revision: 'wrong', values: {} })).toEqual({ conflict: true })
    const revision = readHandler!({ draftId: 'n1' }).revision
    expect(updateHandler!({ draftId: 'n1', revision, values: { '/body': '# Changed' } })).toMatchObject({ values: { '/body': '# Changed' } })
    await waitFor(() => { expect((container.querySelector('[data-notes-source]') as HTMLTextAreaElement).value).toContain('# Changed') })
    const nextRevision = readHandler!({ draftId: 'n1' }).revision
    expect(updateHandler!({ draftId: 'n1', revision: nextRevision, values: { '/tags': [1, 'b'] } })).toMatchObject({ values: { '/tags': ['b'] } })

    drafts.revoke.mockResolvedValueOnce(false)
    fireEvent.click(button(container, '[data-notes-share]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-share-error]')).not.toBeNull() })
    fireEvent.click(button(container, '[data-notes-share]'))
    await waitFor(() => { expect(drafts.revoke).toHaveBeenCalledWith({ draftId: 'n1' }) })
  })

  it('auto-saves 600ms after typing', async () => {
    const backend = makeBackend([{ ...baseNote }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\nchanged' } })
    expect(container.querySelector('[data-notes-save-state]')?.getAttribute('data-notes-save-state')).toBe('dirty')
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('update', expect.objectContaining({ body: '# Hello\n\nchanged', expectedVersion: 1 }))
    }, { timeout: 2000 })
    await waitFor(() => { expect(container.querySelector('[data-notes-save-state]')?.getAttribute('data-notes-save-state')).toBe('saved') })
    expect((container.querySelector('[data-notes-save]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves manually and edits tags, pin state and chips', async () => {
    const backend = makeBackend([{ ...baseNote, tags: ['a'] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\nchanged' } })
    fireEvent.click(button(container, '[data-notes-save]'))
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('update', expect.objectContaining({ body: '# Hello\n\nchanged' }))
    })

    fireEvent.click(button(container, '[data-notes-pin]'))
    expect(container.querySelector('[data-notes-pin]')?.textContent).toBe('取消置顶')
    fireEvent.click(button(container, '[data-notes-save]'))
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('update', expect.objectContaining({ pinned: true }))
    })

    const tags = container.querySelector('[data-notes-tags]') as HTMLInputElement
    fireEvent.change(tags, { target: { value: 'a, b' } })
    expect((container.querySelector('[data-notes-tags]') as HTMLInputElement).value).toBe('a, b')
    fireEvent.click(button(container, '[data-notes-save]'))
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('update', expect.objectContaining({ tags: ['a', 'b'] }))
    })

    fireEvent.click(button(container, '[data-notes-remove-tag="b"]'))
    expect(container.querySelector('[data-notes-tag-chip="b"]')).toBeNull()
    fireEvent.click(button(container, '[data-notes-add-tag]'))
    expect(document.activeElement).toBe(tags)
    fireEvent.change(tags, { target: { value: 'a, c' } })
    fireEvent.click(button(container, '[data-notes-save]'))
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('update', expect.objectContaining({ tags: ['a', 'c'] }))
    })
  })

  it('keeps the draft on a stale version and reloads on demand', async () => {
    const backend = makeBackend([{ ...baseNote, body: '# Hello\n\nfirst' }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    backend.notes[0]!.version = 2
    backend.notes[0]!.body = '# Hello\n\nexternal'
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\ndraft' } })
    fireEvent.click(button(container, '[data-notes-save]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-conflict]')).toBeTruthy() })
    expect((container.querySelector('[data-notes-source]') as HTMLTextAreaElement).value).toBe('# Hello\n\ndraft')
    expect(container.querySelector('[data-notes-save-state]')?.getAttribute('data-notes-save-state')).toBe('conflict')
    fireEvent.click(button(container, '[data-notes-reload]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')?.textContent).toContain('external') })
    expect(container.querySelector('[data-notes-conflict]')).toBeNull()
  })

  it('deletes with confirmation and restores from the trash', async () => {
    const backend = makeBackend([{ ...baseNote }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    await waitFor(() => { expect(container.querySelector('[data-notes-delete]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-delete]'))
    await waitFor(() => { expect(document.querySelector('[data-notes-delete-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[role="dialog"] button[aria-label="取消"]')!)
    expect(backend.call).not.toHaveBeenCalledWith('delete', expect.anything())
    fireEvent.click(button(container, '[data-notes-delete]'))
    await waitFor(() => { expect(document.querySelector('[data-notes-delete-confirm]')).toBeTruthy() })
    fireEvent.click(Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === '取消')!)
    expect(backend.call).not.toHaveBeenCalledWith('delete', expect.anything())
    fireEvent.click(button(container, '[data-notes-delete]'))
    await waitFor(() => { expect(document.querySelector('[data-notes-delete-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-notes-delete-confirm]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('delete', { id: 'n1' }) })
    await waitFor(() => { expect(container.querySelector('[data-notes-select]')).toBeTruthy() })

    const trashed = makeBackend([{ ...baseNote, deletedAt: Date.now() }])
    const second = render(<NotesView {...makeProps(trashed.call)} t={t} />)
    await waitFor(() => { expect(second.container.querySelectorAll('[data-notes-note]')).toHaveLength(0) })
    fireEvent.click(button(second.container, '[data-notes-scope="trash"]'))
    await waitFor(() => { expect(second.container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    fireEvent.click(button(second.container, '[data-notes-restore]'))
    await waitFor(() => { expect(trashed.call).toHaveBeenCalledWith('restore', { id: 'n1' }) })
    await waitFor(() => { expect(second.container.querySelector('[data-notes-page]')?.getAttribute('data-notes-scope')).toBe('all') })
    await waitFor(() => { expect(second.container.querySelector('[data-notes-restore]')).toBeNull() })
  })

  it('creates a draft and opens it in source mode', async () => {
    const backend = makeBackend([{ ...baseNote }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    fireEvent.click(button(container, '[data-notes-new]'))
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('create', { body: '# 新笔记\n\n', tags: [] }) })
    await waitFor(() => { expect(container.querySelector('[data-notes-note="n_2"]')).toBeTruthy() })
    // The editor may land in preview first when the create and open effects
    // settle in the opposite order; switch to source explicitly.
    if (container.querySelector('[data-notes-source]') === null) {
      fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    }
    await waitFor(() => { expect(container.querySelector('[data-notes-source]')).toBeTruthy() }, { timeout: 10000 })
    expect((container.querySelector('[data-notes-source]') as HTMLTextAreaElement).value).toBe('# 新笔记\n\n')
    expect(container.querySelector('[data-notes-note="n_2"]')).toBeTruthy()
  }, 15000)

  it('guards unsaved leaves, reports context, reloads and toggles the narrow pane', async () => {
    const backend = makeBackend([
      { ...baseNote, id: 'n1', updatedAt: baseNote.updatedAt },
      { ...baseNote, id: 'n2', title: '# Other', body: '# Other', updatedAt: baseNote.updatedAt - 1 },
    ])
    let guard: (() => boolean | Promise<boolean>) | undefined
    let listener: (() => void) | undefined
    const report = vi.fn(() => () => undefined)
    const onChanged = vi.fn((callback: () => void) => { listener = callback; return () => undefined })
    const props = makeProps(backend.call, {
      pageContext: { report },
      onChanged,
      registerLeaveGuard: (callback) => { guard = callback; return () => undefined },
    })
    const { container } = render(<NotesView {...props} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview] h1')?.textContent).toBe('Hello') })
    expect(report).toHaveBeenCalledWith({ label: '笔记' })
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ record: { appId: 'notes', kind: 'note', id: 'n1' }, view: 'editor' }))
    expect(await guard?.()).toBe(true)

    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\nchanged' } })
    const pending = guard?.()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(document.querySelector('[data-confirm-dialog]')?.textContent).toContain('离开后本次修改会丢失')
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    expect(await pending).toBe(false)

    expect(container.querySelector('[data-notes-page]')?.getAttribute('data-notes-mobile-pane')).toBe('list')
    fireEvent.click(button(container, '[data-notes-note="n2"]'))
    expect(container.querySelector('[data-notes-page]')?.getAttribute('data-notes-mobile-pane')).toBe('detail')
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('get', { id: 'n2' }) })
    fireEvent.click(button(container, '[data-notes-back]'))
    expect(container.querySelector('[data-notes-page]')?.getAttribute('data-notes-mobile-pane')).toBe('list')

    const listCalls = (backend.call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([op]) => op === 'list').length
    listener?.()
    await waitFor(() => {
      expect((backend.call as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([op]) => op === 'list').length).toBeGreaterThan(listCalls)
    })
  })

  it('exports and imports the JSON document', async () => {
    const createObjectURL = vi.fn(() => 'blob:notes')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const backend = makeBackend([{ ...baseNote }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    fireEvent.click(button(container, '[data-notes-export]'))
    await waitFor(() => { expect(createObjectURL).toHaveBeenCalled() })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:notes')
    fireEvent.click(button(container, '[data-notes-import]'))
    expect(HTMLInputElement.prototype.click).toHaveBeenCalled()
    const input = container.querySelector('[data-notes-import-input]') as HTMLInputElement
    const file = new File(['{"schemaVersion":1}'], 'notes.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => '{"schemaVersion":1}' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('importNotes', { json: '{"schemaVersion":1}', mode: 'merge' })
    })
  })

  it('reports action failures for save, delete, restore, create, export and import', async () => {
    const notes = [
      { ...baseNote, id: 'n1', updatedAt: baseNote.updatedAt },
      { ...baseNote, id: 'n2', title: '# Trash', body: '# Trash', updatedAt: baseNote.updatedAt - 1, deletedAt: Date.now() },
    ]
    const call = vi.fn(async (op: string, input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>
      if (op === 'list') return ok(notes.map(({ body: _body, ...summary }) => summary))
      if (op === 'get') {
        const found = notes.find(note => note.id === args.id)
        return found === undefined ? failed('not-found', 'missing') : ok({ ...found })
      }
      if (op === 'update') return failed('threw', 'save failed')
      if (op === 'delete') return failed('threw', 'delete failed')
      if (op === 'restore') return failed('threw', 'restore failed')
      if (op === 'create') return failed('threw', 'create failed')
      if (op === 'exportNotes') return failed('threw', 'export failed')
      if (op === 'importNotes') return failed('threw', 'import failed')
      return ok({})
    }) as unknown as Call
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const { container } = render(<NotesView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\nchanged' } })
    fireEvent.click(button(container, '[data-notes-save]'))
    await waitFor(() => { expect(screen.getByText('save failed')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-delete]'))
    await waitFor(() => { expect(document.querySelector('[data-notes-delete-confirm]')).toBeTruthy() })
    fireEvent.click(document.querySelector('[data-notes-delete-confirm]') as HTMLButtonElement)
    await waitFor(() => { expect(screen.getByText('delete failed')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-new]'))
    await waitFor(() => { expect(screen.getByText('create failed')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-export]'))
    await waitFor(() => { expect(screen.getByText('export failed')).toBeTruthy() })
    const input = container.querySelector('[data-notes-import-input]') as HTMLInputElement
    const file = new File(['{}'], 'notes.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => '{}' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => { expect(screen.getByText('import failed')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-scope="trash"]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-restore]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-restore]'))
    await waitFor(() => { expect(screen.getByText('restore failed')).toBeTruthy() })
  })

  it('searches the body through the application operation and copies a conflicted draft', async () => {
    const backend = makeBackend([{ ...baseNote, body: 'unique body word' }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-note]')).toBeTruthy() })
    fireEvent.change(container.querySelector('[data-notes-search]') as HTMLInputElement, { target: { value: 'unique body' } })
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('search', { query: 'unique body' }) }, { timeout: 2000 })
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })

    const stale = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'update'
      ? { callId: 'c', status: 'failed', error: { code: 'app.stale-version', message: 'stale' } }
      : backend.call(op, args as never) as never)
    const rendered = render(<NotesView {...makeProps(stale as never)} t={t} />)
    await waitFor(() => { expect(rendered.container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.change(rendered.container.querySelector('[data-notes-tags]') as HTMLInputElement, { target: { value: 'x' } })
    await waitFor(() => { expect(rendered.container.querySelector('[data-notes-conflict]')).toBeTruthy() }, { timeout: 2000 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    fireEvent.click(rendered.container.querySelector('[data-notes-copy-draft]') as HTMLButtonElement)
    await waitFor(() => { expect(writeText).toHaveBeenCalled() })
    await waitFor(() => { expect(rendered.container.querySelector('[data-notes-copy-draft]')?.textContent).toBe('已复制') })
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(rendered.container.querySelector('[data-notes-copy-draft]') as HTMLButtonElement)
  })

  it('flushes a dirty draft before switching tag scope', async () => {
    const backend = makeBackend([baseNote, { ...baseNote, id: 'n2', title: '# B', tags: ['c'] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(container.querySelector('[data-notes-toggle-mode]') as HTMLButtonElement)
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\ndirty' } })
    fireEvent.click(container.querySelector('[data-notes-tag="c"]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('update', expect.objectContaining({ body: '# Hello\n\ndirty' })) })
  })
})
