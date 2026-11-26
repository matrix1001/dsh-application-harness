// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { NotesPage, NotesView, type NotesTranslate } from '../src/client/NotesView.tsx'
import { type NotesKey, zh } from '../src/client/locales.ts'

type Call = ApplicationViewProps['call']
type Outcome = Awaited<ReturnType<Call>>

interface AttachmentFixture {
  id: string
  name: string
  size: number
  type: string
  sha256: string
  missing?: boolean
}

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
  attachments: AttachmentFixture[]
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
  attachments: [],
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
  const notes = initial.map(note => ({ ...note, tags: [...note.tags], attachments: note.attachments.map(attachment => ({ ...attachment })) }))
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
          .filter(note => args.includeDeleted === true || note.deletedAt === undefined)
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
          attachments: [],
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
      case 'uploadAttachment': {
        const note = notes.find(candidate => candidate.id === args.noteId)
        if (note === undefined) return failed('not-found', 'missing note')
        const attachment: AttachmentFixture = {
          id: `att_${String((note.attachments?.length ?? 0) + 1)}`,
          name: String(args.name),
          size: atob(String(args.dataBase64)).length,
          type: String(args.type),
          sha256: 'a'.repeat(64),
        }
        note.attachments = [...(note.attachments ?? []), attachment]
        note.version += 1
        return ok({ note: { ...note }, attachment: { ...attachment } })
      }
      case 'downloadAttachment': {
        const note = notes.find(candidate => candidate.id === args.noteId)
        const attachment = note?.attachments?.find(candidate => candidate.id === args.attachmentId)
        if (attachment === undefined) return failed('not-found', 'missing attachment')
        if (attachment.missing === true) return ok({ ...attachment, missing: true })
        return ok({ ...attachment, missing: false, dataBase64: btoa('attachment bytes') })
      }
      case 'deleteAttachment': {
        const note = notes.find(candidate => candidate.id === args.noteId)
        const attachment = note?.attachments?.find(candidate => candidate.id === args.attachmentId)
        if (note === undefined || attachment === undefined) return failed('not-found', 'missing attachment')
        note.attachments = (note.attachments ?? []).filter(candidate => candidate.id !== args.attachmentId)
        note.version += 1
        return ok({ note: { ...note }, attachment: { ...attachment } })
      }
      case 'exportNotes':
        return ok({ json: '{"schemaVersion":1,"notes":[]}', warnings: [] })
      case 'importNotes':
        return ok({ imported: 1, attachments: { written: 0, missing: 0 } })
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

/**
 * Invoke an element's React `onClick` even when the element is disabled.
 * `fireEvent`/real pointers never reach a disabled button, so proving the
 * page's own second-line guard (e.g. "do not summarize a dirty draft") needs
 * the listener itself. Test-only: reads React's DOM-node bookkeeping.
 */
function clickThroughDisabled(element: HTMLElement): void {
  const node = element as unknown as Record<string, { onClick?: () => void } | undefined>
  const key = Object.keys(node).find(candidate => candidate.startsWith('__reactProps$'))
  const onClick = key === undefined ? undefined : node[key]?.onClick
  if (onClick === undefined) throw new Error('element carries no React click handler')
  onClick()
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
    expect(container.querySelector('[data-notes-list-title]')?.textContent).toBe('置顶')
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
    await waitFor(() => { expect(container.querySelector('[data-notes-list-title]')?.textContent).toBe('置顶') })
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
    expect(screen.getByText('还没有置顶的笔记')).toBeTruthy()
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
    await waitFor(() => { expect(container.querySelector('[data-notes-read-failure]')).not.toBeNull() })
    expect(container.querySelector('[data-notes-read-failure]')?.textContent).toContain('读取笔记失败')
    expect(container.querySelector('[data-notes-read-failure]')?.textContent).toContain('load failed')
    expect(container.querySelector('[data-notes-empty]')).toBeNull()
    failing = false
    fireEvent.click(button(container, '[data-notes-retry]'))
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-read-failure]')).toBeNull()
    expect(container.querySelector('[data-notes-load-error]')).toBeNull()

    failing = true
    listener?.()
    await waitFor(() => { expect(container.querySelector('[data-notes-load-error]')?.textContent).toContain('读取笔记失败') })
    expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1)
  })

  it('shows the permission refusal as a light page state without a second action', async () => {
    const call = vi.fn(async (op: string) => op === 'list'
      ? failed('app.capability-not-approved', 'the user has not approved app-data')
      : ok({})) as unknown as Call
    const { container } = render(<NotesView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-read-failure]')).not.toBeNull() })
    expect(container.querySelector('[data-notes-read-failure]')?.textContent).toContain('尚未读取笔记')
    expect(container.querySelector('[data-notes-read-failure]')?.textContent).toContain('右上角')
    // The prominent action lives in the header status control; the page only
    // states that the content was not read and adds no second permission entry.
    expect(container.querySelector('[data-notes-read-manage]')).toBeNull()
    expect(container.querySelector('[data-notes-read-failure] details')).toBeNull()
    expect(container.querySelector('[data-notes-load-error]')).toBeNull()
    expect(container.querySelector('[data-notes-empty]')).toBeNull()
  })

  it('turns a save permission refusal into a localized message and a permission action', async () => {
    const call = vi.fn(async (op: string) => {
      if (op === 'list') return ok([{ ...baseNote, body: undefined }])
      if (op === 'get') return ok({ ...baseNote })
      if (op === 'update') return failed('app.capability-not-approved', 'the host raw refusal')
      return ok({})
    }) as unknown as Call
    const openManagement = vi.fn()
    const { container } = render(<NotesView {...makeProps(call, { openManagement })} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\nchanged' } })
    fireEvent.click(button(container, '[data-notes-save]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-save-error]')?.textContent).toContain('没有获得') })
    expect(container.querySelector('[data-notes-save-error]')?.textContent).not.toContain('the host raw refusal')
    fireEvent.click(button(container, '[data-notes-save-manage]'))
    expect(openManagement).toHaveBeenCalledWith('permissions')
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
    // A new note is an editing action: the caret must be in the body, not on
    // the list button the human just left behind.
    expect(document.activeElement).toBe(container.querySelector('[data-notes-source]'))
  }, 15000)

  it('keeps a typed comma while editing tags and accepts the full-width comma', async () => {
    const backend = makeBackend([{ ...baseNote, tags: ['a'] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-tags]')).toBeTruthy() })
    const tags = container.querySelector('[data-notes-tags]') as HTMLInputElement
    fireEvent.focus(tags)
    fireEvent.change(tags, { target: { value: 'a,' } })
    expect(tags.value).toBe('a,')
    fireEvent.change(tags, { target: { value: 'a,b' } })
    expect(tags.value).toBe('a,b')
    expect(container.querySelector('[data-notes-tag-chip="b"]')).toBeTruthy()
    fireEvent.change(tags, { target: { value: 'a,b，工作、学习' } })
    expect(container.querySelector('[data-notes-tag-chip="工作"]')).toBeTruthy()
    expect(container.querySelector('[data-notes-tag-chip="学习"]')).toBeTruthy()
    fireEvent.blur(tags)
    expect((container.querySelector('[data-notes-tags]') as HTMLInputElement).value).toBe('a, b, 工作, 学习')
  })

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
    await waitFor(() => { expect(container.querySelector('[data-notes-page]')?.getAttribute('data-notes-mobile-pane')).toBe('detail') })
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

  it('reports save and delete failures, and blocks a new note while the draft cannot be saved', async () => {
    const notes = [{ ...baseNote, id: 'n1', updatedAt: baseNote.updatedAt }]
    const call = vi.fn(async (op: string, input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>
      if (op === 'list') return ok(notes.map(({ body: _body, ...summary }) => summary))
      if (op === 'get') {
        const found = notes.find(note => note.id === args.id)
        return found === undefined ? failed('not-found', 'missing') : ok({ ...found })
      }
      if (op === 'update') return failed('threw', 'save failed')
      if (op === 'delete') return failed('threw', 'delete failed')
      if (op === 'create') return failed('threw', 'create failed')
      return ok({})
    }) as unknown as Call
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
    await waitFor(() => { expect(call).toHaveBeenCalledWith('update', expect.anything()) })
    expect(call).not.toHaveBeenCalledWith('create', expect.anything())
    expect(container.querySelector('[data-notes-note="n1"]')).toBeTruthy()
    expect(screen.getByText('save failed')).toBeTruthy()
  })

  it('reports create, export, import and restore failures', async () => {
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
      if (op === 'create') return failed('threw', 'create failed')
      if (op === 'exportNotes') return failed('threw', 'export failed')
      if (op === 'importNotes') return failed('threw', 'import failed')
      if (op === 'restore') return failed('threw', 'restore failed')
      return ok({})
    }) as unknown as Call
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const { container } = render(<NotesView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
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

  it('searches tags through the host and reaches trashed notes in the trash scope', async () => {
    const backend = makeBackend([
      { ...baseNote, id: 'n1', title: '# Hello', body: 'plain body', tags: ['DeepWork'] },
      { ...baseNote, id: 'n2', title: '# Gone', body: 'removed body', tags: ['DeepWork'], deletedAt: Date.now(), updatedAt: baseNote.updatedAt - 1 },
    ])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    const search = container.querySelector('[data-notes-search]') as HTMLInputElement
    // A tag-only match: the host query now covers the field the placeholder
    // promises, so the server answer cannot replace the local hit with nothing.
    fireEvent.change(search, { target: { value: 'deepwork' } })
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('search', { query: 'deepwork' }) }, { timeout: 2000 })
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-note="n1"]')).toBeTruthy()
    expect(container.querySelector('[data-notes-note="n2"]')).toBeNull()

    // Switching to the trash re-runs the search for soft-deleted notes; the
    // live-only answer above would leave the trash search permanently empty.
    fireEvent.click(button(container, '[data-notes-scope="trash"]'))
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('search', { query: 'deepwork', includeDeleted: true })
    }, { timeout: 2000 })
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(1) })
    expect(container.querySelector('[data-notes-note="n2"]')?.getAttribute('data-notes-deleted')).toBe('true')
  })

  it('renders attachment rows with their sizes and the missing marker', async () => {
    const attachments: AttachmentFixture[] = [
      { id: 'att_a', name: 'tiny.txt', size: 12, type: 'text/plain', sha256: 'a'.repeat(64) },
      { id: 'att_b', name: 'kilo.txt', size: 2048, type: 'text/plain', sha256: 'b'.repeat(64) },
      { id: 'att_c', name: 'mega.pdf', size: 2 * 1024 * 1024, type: 'application/pdf', sha256: 'c'.repeat(64) },
      { id: 'att_d', name: 'gone.txt', size: 10, type: 'text/plain', sha256: 'd'.repeat(64), missing: true },
    ]
    const backend = makeBackend([{ ...baseNote, attachments }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-attachment]')).toHaveLength(4) })
    expect(container.querySelector('[data-notes-attachments]')?.getAttribute('data-notes-attachment-count')).toBe('4')
    expect(container.querySelector('[data-notes-attachment="att_a"] [data-notes-attachment-name]')?.textContent).toBe('tiny.txt')
    expect(container.querySelector('[data-notes-attachment="att_a"] [data-notes-attachment-size]')?.textContent).toBe('12 B')
    expect(container.querySelector('[data-notes-attachment="att_b"] [data-notes-attachment-size]')?.textContent).toBe('2.0 KB')
    expect(container.querySelector('[data-notes-attachment="att_c"] [data-notes-attachment-size]')?.textContent).toBe('2.0 MB')
    expect(container.querySelector('[data-notes-attachment="att_d"]')?.getAttribute('data-notes-attachment-missing')).toBe('true')
    expect(container.querySelector('[data-notes-attachment="att_d"] [data-notes-attachment-missing-badge]')?.textContent).toBe('字节缺失')
    expect((container.querySelector('[data-notes-attachment="att_d"] [data-notes-attachment-download]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[data-notes-attachment="att_a"] [data-notes-attachment-download]') as HTMLButtonElement).disabled).toBe(false)
    expect(container.querySelector('[data-notes-attachment-empty]')).toBeNull()
  })

  it('uploads a picked file as base64 and applies the server note', async () => {
    const backend = makeBackend([{ ...baseNote }])
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment-empty]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-attachment-upload]'))
    expect(HTMLInputElement.prototype.click).toHaveBeenCalled()
    const input = container.querySelector('[data-notes-attachment-input]') as HTMLInputElement
    // A cancelled picker (no file) is a no-op.
    fireEvent.change(input, { target: { files: [] } })
    expect(backend.call).not.toHaveBeenCalledWith('uploadAttachment', expect.anything())
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => {
      expect(backend.call).toHaveBeenCalledWith('uploadAttachment', { noteId: 'n1', name: 'hello.txt', type: 'text/plain', dataBase64: btoa('hello') })
    })
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment="att_1"]')).toBeTruthy() })
  })

  it('reports an upload that the server refuses and one whose bytes cannot be read', async () => {
    const rejected = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'uploadAttachment'
      ? failed('threw', 'upload failed')
      : makeBackend([{ ...baseNote }]).call(op, args as never) as never) as unknown as Call
    const first = render(<NotesView {...makeProps(rejected)} t={t} />)
    await waitFor(() => { expect(first.container.querySelector('[data-notes-attachment-empty]')).toBeTruthy() })
    const input = first.container.querySelector('[data-notes-attachment-input]') as HTMLInputElement
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => { expect(first.container.querySelector('[data-notes-attachment-error]')?.textContent).toBe('upload failed') })
    first.unmount()

    const unreadable = makeBackend([{ ...baseNote }])
    const second = render(<NotesView {...makeProps(unreadable.call)} t={t} />)
    await waitFor(() => { expect(second.container.querySelector('[data-notes-attachment-empty]')).toBeTruthy() })
    const broken = new File(['x'], 'broken.bin', { type: 'text/plain' })
    Object.defineProperty(broken, 'arrayBuffer', { value: async () => { throw new Error('denied') } })
    fireEvent.change(second.container.querySelector('[data-notes-attachment-input]') as HTMLInputElement, { target: { files: [broken] } })
    await waitFor(() => { expect(second.container.querySelector('[data-notes-attachment-error]')?.textContent).toBe('附件操作失败') })
  })

  it('downloads attachment bytes through a blob object URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:attachment')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const attachment: AttachmentFixture = { id: 'att_a', name: 'tiny.txt', size: 16, type: 'text/plain', sha256: 'a'.repeat(64) }
    const backend = makeBackend([{ ...baseNote, attachments: [attachment] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment="att_a"]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-attachment="att_a"] [data-notes-attachment-download]'))
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('downloadAttachment', { noteId: 'n1', attachmentId: 'att_a' }) })
    await waitFor(() => { expect(createObjectURL).toHaveBeenCalled() })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:attachment')
  })

  it('marks a raced download as missing and reports a failed download', async () => {
    const attachment: AttachmentFixture = { id: 'att_a', name: 'tiny.txt', size: 16, type: 'text/plain', sha256: 'a'.repeat(64) }
    const raced = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'downloadAttachment'
      ? ok({ ...attachment, missing: true })
      : makeBackend([{ ...baseNote, attachments: [attachment] }]).call(op, args as never) as never) as unknown as Call
    const first = render(<NotesView {...makeProps(raced)} t={t} />)
    await waitFor(() => { expect(first.container.querySelector('[data-notes-attachment="att_a"]')).toBeTruthy() })
    fireEvent.click(button(first.container, '[data-notes-attachment="att_a"] [data-notes-attachment-download]'))
    await waitFor(() => { expect(first.container.querySelector('[data-notes-attachment-error]')?.textContent).toBe('字节缺失') })
    first.unmount()

    const failing = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'downloadAttachment'
      ? failed('threw', 'download failed')
      : makeBackend([{ ...baseNote, attachments: [attachment] }]).call(op, args as never) as never) as unknown as Call
    const second = render(<NotesView {...makeProps(failing)} t={t} />)
    await waitFor(() => { expect(second.container.querySelector('[data-notes-attachment="att_a"]')).toBeTruthy() })
    fireEvent.click(button(second.container, '[data-notes-attachment="att_a"] [data-notes-attachment-download]'))
    await waitFor(() => { expect(second.container.querySelector('[data-notes-attachment-error]')?.textContent).toBe('download failed') })
  })

  it('asks before deleting an attachment and keeps the bytes when cancelled', async () => {
    const attachment: AttachmentFixture = { id: 'att_a', name: 'tiny.txt', size: 16, type: 'text/plain', sha256: 'a'.repeat(64) }
    const backend = makeBackend([{ ...baseNote, attachments: [attachment] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment="att_a"]')).toBeTruthy() })
    const remove = button(container, '[data-notes-attachment="att_a"] [data-notes-attachment-delete]')
    fireEvent.click(remove)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(document.querySelector('[data-confirm-dialog]')?.textContent).toContain('确定删除“tiny.txt”吗？')
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).toBeNull() })
    expect(backend.call).not.toHaveBeenCalledWith('deleteAttachment', expect.anything())
    expect(container.querySelector('[data-notes-attachment="att_a"]')).toBeTruthy()

    fireEvent.click(remove)
    await waitFor(() => { expect(document.querySelector('[data-confirm-accept]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('deleteAttachment', { noteId: 'n1', attachmentId: 'att_a' }) })
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment="att_a"]')).toBeNull() })
  })

  it('deletes an attachment and reports a failed delete', async () => {
    const attachment: AttachmentFixture = { id: 'att_a', name: 'tiny.txt', size: 16, type: 'text/plain', sha256: 'a'.repeat(64) }
    const backend = makeBackend([{ ...baseNote, attachments: [attachment] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment="att_a"]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-attachment="att_a"] [data-notes-attachment-delete]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-accept]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(backend.call).toHaveBeenCalledWith('deleteAttachment', { noteId: 'n1', attachmentId: 'att_a' }) })
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment="att_a"]')).toBeNull() })
    expect(container.querySelector('[data-notes-attachment-empty]')).toBeTruthy()

    const failing = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'deleteAttachment'
      ? failed('threw', 'delete attachment failed')
      : makeBackend([{ ...baseNote, attachments: [attachment] }]).call(op, args as never) as never) as unknown as Call
    const second = render(<NotesView {...makeProps(failing)} t={t} />)
    await waitFor(() => { expect(second.container.querySelector('[data-notes-attachment="att_a"]')).toBeTruthy() })
    fireEvent.click(button(second.container, '[data-notes-attachment="att_a"] [data-notes-attachment-delete]'))
    await waitFor(() => { expect(document.querySelector('[data-confirm-accept]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(second.container.querySelector('[data-notes-attachment-error]')?.textContent).toBe('delete attachment failed') })
  })

  it('renders stored attachments for a trashed note without management controls', async () => {
    const attachment: AttachmentFixture = { id: 'att_trash', name: 'kept.txt', size: 5, type: 'text/plain', sha256: 'e'.repeat(64), missing: true }
    const backend = makeBackend([{ ...baseNote, deletedAt: Date.now(), attachments: [attachment] }])
    const { container } = render(<NotesView {...makeProps(backend.call)} t={t} />)
    await waitFor(() => { expect(container.querySelectorAll('[data-notes-note]')).toHaveLength(0) })
    fireEvent.click(button(container, '[data-notes-scope="trash"]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment="att_trash"]')).toBeTruthy() })
    expect(container.querySelector('[data-notes-attachment-upload]')).toBeNull()
    expect(container.querySelector('[data-notes-attachment-delete]')).toBeNull()
    expect((container.querySelector('[data-notes-attachment-download]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows attachment export warnings and an import summary', async () => {
    const createObjectURL = vi.fn(() => 'blob:notes')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const backend = makeBackend([{ ...baseNote }])
    const call = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === 'exportNotes') return ok({ json: '{"schemaVersion":1,"notes":[]}', warnings: ['attachment-omitted:att_1', 'attachment-missing:att_2'] })
      if (op === 'importNotes') return ok({ imported: 2, attachments: { written: 1, missing: 1 } })
      return backend.call(op, args as never) as never
    }) as unknown as Call
    const { container } = render(<NotesView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-attachment-empty]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-export]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-notice]')?.textContent).toContain('2 个附件未包含字节') })
    const file = new File(['{"schemaVersion":1,"notes":[]}'], 'notes.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => '{"schemaVersion":1,"notes":[]}' })
    fireEvent.change(container.querySelector('[data-notes-import-input]') as HTMLInputElement, { target: { files: [file] } })
    await waitFor(() => { expect(container.querySelector('[data-notes-notice]')?.textContent).toBe('已导入 2 条；写入附件 1 个，缺失 1 个。') })
  })

  it('summarizes the open note through the model operation and closes the summary', async () => {
    const backend = makeBackend([{ ...baseNote }])
    const call = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'summarize'
      ? ok({ summary: '模型摘要' })
      : backend.call(op, args as never) as never) as unknown as Call
    const { container } = render(<NotesView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    expect(container.querySelector('[data-notes-summary]')).toBeNull()
    fireEvent.click(button(container, '[data-notes-summarize]'))
    await waitFor(() => { expect(call).toHaveBeenCalledWith('summarize', { id: 'n1' }) })
    await waitFor(() => { expect(container.querySelector('[data-notes-summary] p')?.textContent).toBe('模型摘要') })
    expect(container.querySelector('[data-notes-summary-error]')).toBeNull()
    fireEvent.click(button(container, '[data-notes-summary-close]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-summary]')).toBeNull() })
  })

  it('localizes a model failure and keeps the raw diagnostic behind a disclosure', async () => {
    const backend = makeBackend([{ ...baseNote }])
    const raw = 'the model call failed (AUTH): key sk-***, request_id=req-1'
    const failing = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'summarize'
      ? failed('threw', raw)
      : backend.call(op, args as never) as never) as unknown as Call
    const first = render(<NotesView {...makeProps(failing)} t={t} />)
    await waitFor(() => { expect(first.container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(first.container, '[data-notes-summarize]'))
    await waitFor(() => { expect(first.container.querySelector('[data-notes-summary-error]')).not.toBeNull() })
    const error = first.container.querySelector('[data-notes-summary-error]')!
    // The alert's own copy is localized; the vendor text is not the headline.
    expect(error.textContent?.startsWith('模型调用失败，请稍后重试；如果持续失败，请检查模型凭据。')).toBe(true)
    const detail = error.querySelector('details[data-notes-summary-detail]') as HTMLDetailsElement | null
    expect(detail).not.toBeNull()
    expect(detail?.open).toBe(false)
    expect(detail?.querySelector('summary')?.textContent).toBe('诊断信息')
    expect(detail?.textContent).toContain('the model call failed (AUTH)')
    expect(detail?.textContent).toContain('request_id=req-1')
    first.unmount()

    const silent = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'summarize'
      ? { callId: 'c', status: 'failed' } as never
      : backend.call(op, args as never) as never) as unknown as Call
    const second = render(<NotesView {...makeProps(silent)} t={t} />)
    await waitFor(() => { expect(second.container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(second.container, '[data-notes-summarize]'))
    await waitFor(() => { expect(second.container.querySelector('[data-notes-summary-error]')?.textContent).toBe('总结失败') })
    expect(second.container.querySelector('[data-notes-summary-detail]')).toBeNull()
  })

  it('localizes a summary permission refusal and offers the permission page', async () => {
    const backend = makeBackend([{ ...baseNote }])
    const denied = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'summarize'
      ? { callId: 'c', status: 'failed', error: { code: 'app.capability-not-approved', message: 'the user has not approved the model capability' } } as never
      : backend.call(op, args as never) as never) as unknown as Call
    const open = vi.fn()
    const { container } = render(<NotesView {...makeProps(denied, { openManagement: open })} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-summarize]'))
    await waitFor(() => { expect(container.querySelector('[data-notes-summary-error]')?.textContent).toContain('没有获得') })
    const error = container.querySelector('[data-notes-summary-error]')!
    expect(error.textContent).not.toContain('the user has not approved')
    expect(error.querySelector('[data-notes-summary-detail]')).toBeNull()
    fireEvent.click(button(container, '[data-notes-summary-manage]'))
    expect(open).toHaveBeenCalledWith('permissions')
  })

  it('ignores a summarize request while the open draft has unsaved changes', async () => {
    const backend = makeBackend([{ ...baseNote }])
    const call = vi.fn(async (op: string, args: Record<string, unknown>) => op === 'summarize'
      ? ok({ summary: 'unexpected' })
      : backend.call(op, args as never) as never) as unknown as Call
    const { container } = render(<NotesView {...makeProps(call)} t={t} />)
    await waitFor(() => { expect(container.querySelector('[data-notes-preview]')).toBeTruthy() })
    fireEvent.click(button(container, '[data-notes-toggle-mode]'))
    fireEvent.change(container.querySelector('[data-notes-source]') as HTMLTextAreaElement, { target: { value: '# Hello\n\ndirty' } })
    const summarize = button(container, '[data-notes-summarize]')
    expect(summarize.disabled).toBe(true)
    // The UI disables the control, so a real pointer cannot reach the handler;
    // invoke the listener directly to prove it also refuses a dirty draft (the
    // second line of defence).
    clickThroughDisabled(summarize)
    expect(call).not.toHaveBeenCalledWith('summarize', expect.anything())
    expect(container.querySelector('[data-notes-summary]')).toBeNull()
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
