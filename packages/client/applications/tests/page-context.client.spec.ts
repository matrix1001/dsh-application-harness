/**
 * The page context and the `@page` reference chip over it: the store's rules
 * (set, update, clear, owner stamp, stale disposers), the token the chip
 * serializes (stable for one object, grammar-identical to what the host
 * parses), and the source's three callbacks — candidates, pick, codec — driven
 * directly.
 *
 * The per-occurrence serialization at submit is the platform pipeline's own
 * behaviour (its suite covers `serializeReference` per chip); what this suite
 * pins is the half that is ours: the codec answers with the chip's reference
 * and nothing else, so two chips of the same object can only ever produce the
 * same text.
 */
import { describe, expect, it } from 'vitest'
import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createPageContext } from '../src/client/page-context.ts'
import { createPageSource, PAGE_SOURCE_NAME } from '../src/client/page-source.ts'
import { appToken } from '../src/client/page-token.ts'
import { pageToken } from '../src/client/page-token.ts'
import type { PageContextService } from '../src/client/contract.ts'

/** The registered source of one fresh store, with both stores themselves. */
function mounted(): { pageContext: PageContextService; source: InputTriggerSource } {
  const pageContext = createPageContext()
  return { pageContext, source: createPageSource(pageContext) }
}

/** One candidate the source offered, with the reference it carries. */
async function offered(source: InputTriggerSource): Promise<InputTriggerCandidate | undefined> {
  const [first] = await source.candidates({ sessionId: 's-1' as never }, {
    query: '', position: 'inline', drilled: false, signal: new AbortController().signal,
  })
  return first
}

/** Pick one row and read the insertion it asks for. */
function pick(source: InputTriggerSource, candidate: InputTriggerCandidate) {
  return source.onPick({
    candidate,
    session: { sessionId: 's-1' as never },
    position: 'inline',
    via: 'menu',
    action: 'pick',
    span: { start: 0, end: 0, draftRev: 1 },
  })
}

describe('the page context store', () => {
  it('holds what the page reports and clears it when the report is undone', () => {
    const pageContext = createPageContext()
    expect(pageContext.current()).toBeUndefined()
    const clear = pageContext.report('workbook', { record: { kind: 'note', id: 'n1' }, label: 'Workbook · note n1' })
    expect(pageContext.current()).toEqual({
      appId: 'workbook',
      record: { kind: 'note', id: 'n1' },
      label: 'Workbook · note n1',
    })
    clear()
    expect(pageContext.current()).toBeUndefined()
  })

  it('replaces the context when the page reports again, keeping the ownership of the newest report', () => {
    const pageContext = createPageContext()
    const first = pageContext.report('workbook', { record: { kind: 'note', id: 'n1' }, label: 'note n1' })
    const second = pageContext.report('workbook', { record: { kind: 'note', id: 'n2' }, label: 'note n2' })
    expect(pageContext.current()).toMatchObject({ record: { id: 'n2' } })
    // The loser's cleanup runs as React retires it; it must not blank the newer report.
    first()
    expect(pageContext.current()).toMatchObject({ record: { id: 'n2' } })
    second()
    expect(pageContext.current()).toBeUndefined()
  })

  it('lets a new page take over, and the old page clean up without clearing it', () => {
    const pageContext = createPageContext()
    const workbook = pageContext.report('workbook', { label: 'Workbook' })
    const infoHub = pageContext.report('info-hub', { record: { kind: 'project', id: 'p_1' }, label: 'Info hub' })
    expect(pageContext.current()).toMatchObject({ appId: 'info-hub' })
    // Unmounting the page that lost the panel must not clear the page that won it.
    workbook()
    expect(pageContext.current()).toMatchObject({ appId: 'info-hub' })
    infoHub()
    expect(pageContext.current()).toBeUndefined()
  })

  it('reports a page with no record, and a bare page cleared twice is still clear', () => {
    const pageContext = createPageContext()
    const clear = pageContext.report('workbook', { label: 'Workbook', selectionNote: '总览' })
    expect(pageContext.current()).toEqual({ appId: 'workbook', label: 'Workbook', selectionNote: '总览' })
    clear()
    clear()
    expect(pageContext.current()).toBeUndefined()
  })
})

describe('the page token', () => {
  it('spells the grammar the host parses', () => {
    expect(pageToken('workbook', { kind: 'note', id: 'n3' })).toBe('@page:workbook:note:n3')
    expect(pageToken('workbook', { kind: 'task', id: 't_9f-2' })).toBe('@page:workbook:task:t_9f-2')
    expect(pageToken('workbook', undefined)).toBe('@page:workbook')
  })

  it('is stable: the same object always spells the same token', () => {
    const record = { kind: 'event', id: 'e_1' } as const
    expect(pageToken('info-hub', record)).toBe(pageToken('info-hub', { ...record }))
  })
})

describe('the application token', () => {
  it('spells the application reference grammar', () => {
    expect(appToken('workbook')).toBe('@app:workbook')
    expect(appToken('info-hub')).toBe('@app:info-hub')
  })
})

describe('the page reference source', () => {
  it('owns the @ trigger under the page name', () => {
    const { source } = mounted()
    expect(source.trigger).toBe('@')
    expect(source.name).toBe(PAGE_SOURCE_NAME)
    expect(source.showGroupTitle).toBe(false)
  })

  it('offers no row while no page reports a context', async () => {
    const { source } = mounted()
    expect(await offered(source)).toBeUndefined()
  })

  it('offers the page as one row whose value is the token it will attach', async () => {
    const { pageContext, source } = mounted()
    pageContext.report('workbook', { record: { kind: 'note', id: 'n3' }, label: '笔记 n3' })
    expect(await offered(source)).toEqual({
      name: '笔记 n3',
      description: '@page:workbook:note:n3',
      value: '@page:workbook:note:n3',
      section: 'Current page',
    })
  })

  it("shows the page's own line about the selection instead of the token when it has one", async () => {
    const { pageContext, source } = mounted()
    pageContext.report('workbook', { label: '任务', selectionNote: '任务看板' })
    expect(await offered(source)).toEqual({ name: '任务', description: '任务看板', value: '@page:workbook', section: 'Current page' })
  })

  it('inserts the picked row as a reference chip carrying its token', async () => {
    const { pageContext, source } = mounted()
    pageContext.report('workbook', { record: { kind: 'note', id: 'n3' }, label: '笔记 n3' })
    const candidate = await offered(source)
    if (candidate === undefined) throw new Error('expected one offered row')
    expect(pick(source, candidate)).toEqual({
      insert: {
        source: PAGE_SOURCE_NAME,
        ref: '@page:workbook:note:n3',
        label: '笔记 n3',
        clipboardText: '@page:workbook:note:n3',
      },
    })
  })

  it('refuses a row that carries no reference rather than inserting a made-up one', () => {
    const { source } = mounted()
    expect(() => pick(source, { name: '笔记 n3' })).toThrow(/carried no reference/u)
  })

  it('keeps a picked chip on the page it was picked from, whatever page follows', async () => {
    const { pageContext, source } = mounted()
    pageContext.report('workbook', { record: { kind: 'note', id: 'n3' }, label: '笔记 n3' })
    const candidate = await offered(source)
    if (candidate === undefined) throw new Error('expected one offered row')
    const picked = pick(source, candidate)
    // `PickOutcome` also carries the non-object arms (`'handled'`, `undefined`),
    // so the object guard is what makes the `in` narrowing legal.
    if (typeof picked !== 'object' || picked === null || !('insert' in picked)) throw new Error('expected an insertion')
    const codec = source.codec
    if (codec === undefined) throw new Error('expected the source to carry a codec')
    // The human navigates away before sending: the chip is bound to the position
    // it was picked into, and its model form is unchanged by where they are now.
    pageContext.report('info-hub', { record: { kind: 'project', id: 'p_1' }, label: 'Info hub' })
    await expect(codec.serialize(picked.insert.ref, new AbortController().signal)).resolves.toBe('@page:workbook:note:n3')
  })

  it('serializes one chip as the token it carries, and two chips of one object alike', async () => {
    const { pageContext, source } = mounted()
    pageContext.report('workbook', { record: { kind: 'note', id: 'n3' }, label: '笔记 n3' })
    const codec = source.codec
    if (codec === undefined) throw new Error('expected the source to carry a codec')
    const signal = new AbortController().signal
    // The pipeline calls serialize once per occurrence; each call answers with
    // that occurrence's own reference.
    await expect(codec.serialize('@page:workbook:note:n3', signal)).resolves.toBe('@page:workbook:note:n3')
    await expect(codec.serialize('@page:workbook', signal)).resolves.toBe('@page:workbook')
    await expect(Promise.all([
      codec.serialize('@page:workbook:note:n3', signal),
      codec.serialize('@page:workbook:note:n3', signal),
    ])).resolves.toEqual(['@page:workbook:note:n3', '@page:workbook:note:n3'])
    expect(codec.clipboardText('@page:workbook:note:n3')).toBe('@page:workbook:note:n3')
  })
})
