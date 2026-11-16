// @vitest-environment jsdom
/**
 * The shared markdown renderer (chrome's `renderMarkdown`): a tiny
 * dependency-free subset (headings, paragraphs, unordered/ordered lists,
 * `- [ ]` / `- [x]` checklists, blockquotes, fenced code, `---` rules at the
 * block level; bold/italic/code/strike/links at the inline level). This suite
 * covers every parse state, every inline matcher, both real FORMS the two
 * surfaces use — the workbook's interactive checklist and the release note's
 * read-only, new-tab flavor — and the class-map option that lets a consumer
 * put its own CSS-module names on the parts it styles. Safety is the other
 * contract: raw text is emitted as React text nodes and a link whose scheme is
 * not a web scheme renders as inert text rather than a scriptable anchor.
 *
 * The two local copies this replaced were each covered by their own suite
 * (workbook-view/tests/markdown.spec.tsx, info-hub-view/tests/
 * release-markdown.client.spec.tsx); their assertions all live here now, plus
 * the ones the split could not hold: the inline pass keeps the text AROUND an
 * inline run exactly once (the workbook copy pushed the whole original string
 * again, a duplication its own suite never sampled).
 */
import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderMarkdown, type MarkdownOptions } from '../src/index.tsx'

afterEach(() => { cleanup() })

/** Render a markdown string into the jsdom tree and hand back the container element. */
function md(text: string, options: MarkdownOptions = {}): HTMLElement {
  const { container } = render(createElement('div', null, renderMarkdown(text, options)))
  return container.firstElementChild as HTMLElement
}

/** The rendered markup of a block set (a stable, whitespace-normalized view). */
function markupOf(text: string): string {
  return md(text).innerHTML
}

describe('renderMarkdown: blocks', () => {
  it('renders a plain paragraph wrapped in <p> (no injection)', () => {
    const el = md('buy milk & <eggs>')
    const p = el.querySelector('p.md-p')!
    expect(p.textContent).toBe('buy milk & <eggs>')
  })

  it('renders headings at the right level, and seven hashes as a paragraph', () => {
    const el = md('# Title\n\n## Subtitle\n\n###### Sub')
    const hs = el.querySelectorAll('.md-heading')
    expect(hs.length).toBe(3)
    expect(hs[0]!.tagName).toBe('H1')
    expect(hs[1]!.tagName).toBe('H2')
    expect(hs[2]!.tagName).toBe('H6')

    const seven = md('####### 不是标题')
    expect(seven.querySelector('h1')).toBeNull()
    expect(seven.querySelector('p.md-p')!.textContent).toBe('####### 不是标题')
  })

  it('renders a blockquote, joining its lines and dropping the markers', () => {
    expect(md('> quoted line').querySelector('blockquote.md-quote')!.textContent).toBe('quoted line')
    expect(md('> 第一行\n>第二行').querySelector('blockquote.md-quote')!.textContent).toBe('第一行\n第二行')
  })

  it('renders a horizontal rule and separates blocks on blank lines', () => {
    expect(md('before\n\n---').querySelector('hr.md-hr')).not.toBeNull()
    const el = md('上\n\n---\n\n下')
    expect(el.querySelectorAll('hr.md-hr')).toHaveLength(1)
    expect(el.querySelectorAll('p.md-p')).toHaveLength(2)
  })

  it('renders a fenced code block verbatim, including blank lines', () => {
    const el = md('```\nconst a = 1\n\n  const b = 2\n```')
    expect(el.querySelector('pre.md-pre')!.querySelector('code.md-code')!.textContent).toBe('const a = 1\n\n  const b = 2')
  })

  it('flushes an unclosed code block at end of input', () => {
    expect(md('```\nno close').querySelector('pre.md-pre')!.textContent).toBe('no close')
  })

  it('renders unordered and ordered lists, accepting * and an upper-case box', () => {
    const ul = md('- a\n- b')
    expect(ul.querySelector('ul.md-ul')!.children.length).toBe(2)
    expect(ul.querySelectorAll('li.md-li').length).toBe(2)

    const ol = md('1. first\n2. second')
    const list = ol.querySelector('ol.md-ol')!
    expect(list.children.length).toBe(2)
    expect(list.querySelectorAll('li.md-li').length).toBe(2)

    const star = md('* 星号')
    expect(star.querySelector('ul.md-ul')!.textContent).toContain('星号')
  })

  it('starts a new list when the marker family changes mid-run', () => {
    const container = md('- 无序\n1. 有序\n- 又无序')
    expect(container.querySelectorAll('ul.md-ul')).toHaveLength(2)
    expect(container.querySelector('ol.md-ol')!.textContent).toContain('有序')
    expect(container.querySelectorAll('ul.md-ul')[1]!.textContent).toContain('又无序')
  })

  it('flushes a list when a plain text line follows with no blank line', () => {
    const el = md('- a\ntrailing text')
    expect(el.querySelector('ul.md-ul')).not.toBeNull()
    expect(el.querySelector('p.md-p')!.textContent).toBe('trailing text')
  })

  it('joins a wrapped paragraph and keeps blocks in document order', () => {
    const el = md('第一行\n第二行')
    const paragraphs = el.querySelectorAll('p.md-p')
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0]!.textContent).toBe('第一行\n第二行')
  })

  it('renders nothing for an empty note', () => {
    expect(markupOf('')).toBe('')
    expect(markupOf('\n\n\n')).toBe('')
  })

  it('flushes a trailing paragraph, list and quote at the end of the note', () => {
    expect(markupOf('尾部段落')).toBe('<p class="md-p">尾部段落</p>')
    expect(markupOf('- 尾项')).toBe('<ul class="md-ul"><li class="md-li">尾项</li></ul>')
    expect(markupOf('> 尾引用')).toBe('<blockquote class="md-quote">尾引用</blockquote>')
  })
})

describe('renderMarkdown: inline', () => {
  it('renders bold, italic, code, strike and link spans', () => {
    const el = md('**bold** and **bold x** x **multi**')
    expect(el.querySelectorAll('strong').length).toBe(3)

    expect(md('*italic*').querySelector('em')!.textContent).toBe('italic')
    expect(md('`inline`').querySelector('code.md-code')!.textContent).toBe('inline')
    expect(md('~~gone~~').querySelector('del')!.textContent).toBe('gone')

    const link = md('[site](https://x)')
    const a = link.querySelector('a.md-link')!
    expect(a.getAttribute('href')).toBe('https://x')
    expect(a.textContent).toBe('site')
  })

  it('keeps the text around an inline run, exactly once, in order', () => {
    const el = md('前 **中** 后')
    const p = el.querySelector('p.md-p')!
    expect(p.textContent).toBe('前 中 后')
    expect(p.childNodes).toHaveLength(3)

    const mixed = md('`码` 然后 **粗** 然后 [链](https://example.com)')
    const first = mixed.querySelector('p.md-p')!
    expect(first.querySelector('code')!.textContent).toBe('码')
    expect(first.querySelector('strong')!.textContent).toBe('粗')
    expect(first.querySelector('a')!.textContent).toBe('链')
    expect(first.textContent).toBe('码 然后 粗 然后 链')
  })

  it('never emits an <a> for a disallowed link scheme (javascript:/data: render as inert text)', () => {
    const el = md('[click](javascript:alert(1))')
    expect(el.querySelector('a.md-link')).toBeNull()
    expect(el.querySelector('span.md-link')!.textContent).toBe('click')
    expect(md('[d](data:text/html,<script>)').querySelector('a.md-link')).toBeNull()
    expect(md('[mail](mailto:a@b)').querySelector('a.md-link')!.getAttribute('href')).toBe('mailto:a@b')
  })

  it('renders a #anchor and a scheme-less relative target as safe links', () => {
    expect(md('[jump](#sec-1)').querySelector('a.md-link')!.getAttribute('href')).toBe('#sec-1')
    expect(md('[doc](notes/readme)').querySelector('a.md-link')!.getAttribute('href')).toBe('notes/readme')
  })

  it('emits plain text without special chars verbatim and leaves an unmatched marker alone', () => {
    expect(md('no specials here').querySelector('p.md-p')!.textContent).toBe('no specials here')
    expect(md('未闭合的 **粗体').querySelector('strong')).toBeNull()
    expect(md('未闭合的 **粗体').querySelector('p.md-p')!.textContent).toBe('未闭合的 **粗体')
  })

  it('keeps an empty inline run from swallowing the rest of the note', () => {
    // `**` with no content is not a bold run; the paragraph keeps the literal text.
    expect(markupOf('a ** b')).toBe('<p class="md-p">a ** b</p>')
  })

  it('never interprets raw HTML from the note', () => {
    const el = md('<img src=x onerror=alert(1)> 与 <b>粗</b>')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('p.md-p')!.textContent).toBe('<img src=x onerror=alert(1)> 与 <b>粗</b>')
  })
})

describe('renderMarkdown: the interactive checklist (the workbook form)', () => {
  /** Render with a toggle recorder, the way a note view wires it to an `edit` run. */
  function mdWithTasks(text: string, toggles: Array<[number, boolean]>, disabled?: boolean): HTMLElement {
    const onToggleTask = (i: number, checked: boolean): void => { toggles.push([i, checked]) }
    return md(text, { onToggleTask, ...(disabled === undefined ? {} : { disabled }) })
  }

  it('renders checkboxes, tracks a global task index and fires toggles', () => {
    const toggles: Array<[number, boolean]> = []
    const el = mdWithTasks('# Todo\n\n- [ ] buy milk\n- [x] ship panel', toggles)
    const inputs = el.querySelectorAll('input.md-task-input')
    expect(inputs.length).toBe(2)
    expect((inputs[0] as HTMLInputElement).checked).toBe(false)
    expect((inputs[1] as HTMLInputElement).checked).toBe(true)

    // The checked item carries the strikethrough class.
    const done = el.querySelectorAll('span.md-task-done')
    expect(done.length).toBe(1)
    expect(done[0]!.textContent).toBe('ship panel')

    // Toggling the first box reports index 0 and the target state.
    fireEvent.click(inputs[0]!)
    expect(toggles).toEqual([[0, true]])
  })

  it('disables the checkboxes when disabled (the browser swallows clicks on disabled inputs)', () => {
    const el = mdWithTasks('- [ ] buy milk', [], true)
    const input = el.querySelector('input.md-task-input') as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  it('continues the task index across a heading + list boundary', () => {
    const toggles: Array<[number, boolean]> = []
    const el = mdWithTasks('- [ ] first\n\nsecond list\n\n- [ ] second', toggles)
    const inputs = el.querySelectorAll('input.md-task-input')
    expect(inputs.length).toBe(2)
    fireEvent.click(inputs[1]!)
    expect(toggles).toEqual([[1, true]])
  })

  it('puts every checklist item in its own list element and numbers them in order', () => {
    const el = md('- [ ] 未做\n- [x] 已做', { onToggleTask: () => {} })
    const items = el.querySelectorAll('ul.md-ul > li.md-task')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toBe('未做')
    expect(items[1]!.textContent).toBe('已做')
  })
})

describe('renderMarkdown: the read-only flavor (the release-note form)', () => {
  it('renders unordered, ordered and checklist lists as their own elements, with no interactive checkbox', () => {
    const el = md('* 星号\n- 二\n\n1. 甲\n2. 乙\n\n- [ ] 未做\n- [X] 已做')
    const uls = el.querySelectorAll('ul.md-ul')
    const ol = el.querySelector('ol.md-ol')
    expect(uls).toHaveLength(2)
    expect(Array.from(uls[0]!.children).map(li => li.textContent)).toEqual(['星号', '二'])
    expect(Array.from(ol!.children).map(li => li.textContent)).toEqual(['甲', '乙'])
    expect(Array.from(uls[1]!.children).map(li => li.textContent)).toEqual(['未做', '已做'])
    expect(el.querySelectorAll('input')).toHaveLength(0)
    // No class map: the checklist items carry the renderer's literal default.
    expect(Array.from(uls[1]!.children).map(li => li.className)).toEqual(['md-li', 'md-li'])
  })

  it('renders links as new-tab anchors when externalLinks is set', () => {
    const container = md('[发布说明](https://example.com/notes)', { externalLinks: true })
    const anchor = container.querySelector('a')!
    expect(anchor.getAttribute('href')).toBe('https://example.com/notes')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noreferrer')
    expect(anchor.textContent).toBe('发布说明')
    // The default flavor keeps the anchor in the same tab.
    expect(md('[发布说明](https://example.com/notes)').querySelector('a')!.getAttribute('target')).toBeNull()
  })
})

describe('renderMarkdown: the code-block callback', () => {
  it('passes the fence language and body, and renders its node', () => {
    const calls: Array<{ lang?: string | undefined; code: string }> = []
    const el = md('```ts\nconst a = 1\n```', {
      renderCodeBlock: (block) => { calls.push(block); return createElement('code', { 'data-code': '' }, block.code) },
    })
    expect(calls).toEqual([{ lang: 'ts', code: 'const a = 1' }])
    expect(el.querySelector('[data-code]')!.textContent).toBe('const a = 1')
  })

  it('omits the language when the fence has no info string', () => {
    const calls: Array<{ lang?: string | undefined; code: string }> = []
    md('```\nplain\n```', { renderCodeBlock: (block) => { calls.push(block); return null } })
    expect(calls).toEqual([{ code: 'plain' }])
  })
})

describe('renderMarkdown: the class-map option', () => {
  it('stamps the consumer\'s names and keeps the literal default for the parts it does not name', () => {
    const classes = { link: 'hash_link', task: 'hash_task', taskInput: 'hash_input', taskText: 'hash_text', taskDone: 'hash_done' }
    const el = md('[site](https://x)\n\n- [x] done\n\n`code`', { classes, onToggleTask: () => {} })
    expect(el.querySelector('a')!.className).toBe('hash_link')
    expect(el.querySelector('li')!.className).toBe('hash_task')
    expect(el.querySelector('li > input')!.className).toBe('hash_input')
    expect(el.querySelector('li > span')!.className).toBe('hash_text hash_done')
    // Not named by the map: the renderer's literal default names the part.
    expect(el.querySelector('code')!.className).toBe('md-code')
    expect(el.querySelector('p')!.className).toBe('md-p')
  })

  it('stamps an inert (unsafe-scheme) link span with the same link class', () => {
    const el = md('[click](javascript:alert(1))', { classes: { link: 'hash_link' } })
    expect(el.querySelector('span')!.className).toBe('hash_link')
  })
})

describe('renderMarkdown: the exported renderer', () => {
  it('returns one React node per parsed block, in document order', () => {
    const nodes: ReactNode[] = renderMarkdown('# 标题\n\n段落\n\n- 项')
    expect(nodes).toHaveLength(3)
    // Each node is a React element: an object with a `type` and `props`.
    for (const node of nodes) {
      expect(typeof node).toBe('object')
      expect(typeof (node as { type?: unknown }).type).toBe('string')
    }
    expect((nodes[0] as { type: string }).type).toBe('h1')
  })
})
