/**
 * The shared tiny, dependency-free markdown renderer: it renders a safe subset
 * of markdown to React elements (no HTML injection, no external lib — so the
 * client bundle purity gate is untouched): headings, paragraphs,
 * unordered/ordered lists, `- [ ]` / `- [x]` checklists, blockquotes, fenced
 * code blocks, and `---` rules at the block level; `**bold**`, `*italic*`,
 * `` `code` ``, `~~strike~~`, and `[text](url)` at the inline level. Raw text
 * is emitted as React text nodes, which are inherently escaped — no
 * `dangerouslySetInnerHTML` — so note text can never inject HTML.
 *
 * ONE parse + render pass serves both markdown surfaces, and each keeps its
 * real behavior as an option instead of a second copy: the workbook's note
 * body renders `- [ ]` items as interactive checkboxes wired to
 * `onToggleTask` and hands in its own CSS-module class map (`classes`), while
 * the info-hub release note is read-only (no toggle → plain list text) and
 * opens links in a new tab (`externalLinks`). The two copies were written
 * separately and had already drifted once — the same `safeHref` fix had to be
 * applied twice (commit 98a737d / 批 K) — so the link-safety judgment lives
 * here with the renderer that uses it (./safe-href.ts).
 * @module @matrix1001/dsh-application-harness-client-chrome/markdown
 */
import { createElement, Fragment, type ReactNode } from 'react'
import { safeHrefForExternal } from './safe-href.ts'

/** One entry of a parsed list block; `task`/`checked` are set for `- [ ]` / `- [x]` items. */
interface MarkdownListItem {
  /** The item's inline text (list marker stripped). */
  text: string
  /** Set (true) when the line was written as a checklist item. */
  task?: boolean
  /** The checklist state of a task item. */
  checked?: boolean
}

/** A single block parsed from the markdown text. */
type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; value: string; lang?: string }
  | { type: 'hr' }

/**
 * The class names the renderer stamps on the elements it emits. Every part has
 * a literal `md-*` default — the name both surfaces shipped with, and the one
 * a consumer styles through its own descendant selectors. A consumer that
 * styles a part through its own **CSS module** supplies the module's hashed
 * name instead: the class map's value is what ends up in the DOM, so the rule
 * actually matches (a literal name never matches a hashed class map).
 */
export interface MarkdownClassNames {
  /** `<h1>`–`<h6>` heading. */
  heading?: string | undefined
  /** Paragraph. */
  paragraph?: string | undefined
  /** Blockquote. */
  quote?: string | undefined
  /** `<hr>` rule. */
  rule?: string | undefined
  /** Inline or fenced `<code>`. */
  code?: string | undefined
  /** The `<pre>` wrapping a fenced code block. */
  codeBlock?: string | undefined
  /** A list item. */
  listItem?: string | undefined
  /** An unordered list. */
  unorderedList?: string | undefined
  /** An ordered list. */
  orderedList?: string | undefined
  /** The `<a>` (or inert `<span>`) wrapping a link's text. */
  link?: string | undefined
  /** The `<li>` of an interactive checklist item. */
  task?: string | undefined
  /** The checklist checkbox. */
  taskInput?: string | undefined
  /** The checklist item's text wrapper. */
  taskText?: string | undefined
  /** Merged onto the text wrapper of a checked item. */
  taskDone?: string | undefined
}

/** The literal `md-*` name of every part, used when the consumer names no class for it. */
const DEFAULT_CLASS_NAMES: Record<keyof MarkdownClassNames, string> = {
  heading: 'md-heading',
  paragraph: 'md-p',
  quote: 'md-quote',
  rule: 'md-hr',
  code: 'md-code',
  codeBlock: 'md-pre',
  listItem: 'md-li',
  unorderedList: 'md-ul',
  orderedList: 'md-ol',
  link: 'md-link',
  task: 'md-task',
  taskInput: 'md-task-input',
  taskText: 'md-task-text',
  taskDone: 'md-task-done',
}

/** The class one part carries: the consumer's map entry when it names one, else the literal default. */
function classOf(part: keyof MarkdownClassNames, classes: MarkdownClassNames | undefined): string {
  return classes?.[part] ?? DEFAULT_CLASS_NAMES[part]
}

/** The options a render call carries: how checklists and links behave, and the consumer's class names. */
export interface MarkdownOptions {
  /**
   * Flip the `index`-th checklist task; `checked` is the target state. A
   * consumer that supplies no toggle gets read-only checklist items (plain
   * list text — a release note renders no interactive checkbox).
   */
  onToggleTask?: (index: number, checked: boolean) => void
  /** Disable the checklist inputs (the view passes its in-flight marker, so a run surface never fires mid-run). */
  disabled?: boolean
  /** Render links as new-tab anchors (`target="_blank" rel="noreferrer"`); release notes commonly carry external references. */
  externalLinks?: boolean
  /** The consumer's class names for the parts it styles (see {@link MarkdownClassNames}). */
  classes?: MarkdownClassNames
  /**
   * Render one fenced code block. Omitted keeps the built-in `<pre><code>`;
   * a client that links the platform primitives passes `FenceCodeBlock` here
   * to gain syntax highlighting, diff coloring and the copy control.
   */
  renderCodeBlock?: (block: { readonly lang?: string | undefined; readonly code: string }) => ReactNode
}

/** Split the text into markdown blocks (line-based state machine). */
function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let listItems: MarkdownListItem[] = []
  let listOrdered = false
  let inList = false
  let quote: string[] = []
  let code: string[] = []
  let codeLang: string | undefined
  let inCode = false

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  const flushList = (): void => {
    if (!inList && listItems.length === 0) return
    blocks.push({ type: 'list', ordered: listOrdered, items: listItems })
    listItems = []
    inList = false
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    blocks.push({ type: 'quote', text: quote.join('\n') })
    quote = []
  }

  for (const line of lines) {
    if (inCode) {
      if (line.trim() === '```') { blocks.push({ type: 'code', value: code.join('\n'), ...(codeLang === undefined ? {} : { lang: codeLang }) }); code = []; codeLang = undefined; inCode = false }
      else code.push(line)
      continue
    }
    if (/^```/.test(line.trim())) {
      flushParagraph(); flushList(); flushQuote()
      const info = line.trim().slice(3).trim()
      codeLang = info === '' ? undefined : info.split(/\s+/u)[0]
      inCode = true
      continue
    }
    if (/^#{1,6}\s/.test(line)) { flushParagraph(); flushList(); flushQuote(); blocks.push({ type: 'heading', level: line.match(/^#+/)![0].length, text: line.replace(/^#+\s*/, '') }); continue }
    if (/^\s*>\s?/.test(line)) { flushParagraph(); flushList(); quote.push(line.replace(/^\s*>\s?/, '')); continue }
    if (/^(-|\*)\s+\[[ xX]\]\s+/.test(line)) {
      flushParagraph(); flushQuote()
      const checked = /\[[xX]\]/.test(line)
      const text = line.replace(/^[-*]\s+\[[ xX]\]\s+/, '')
      if (inList && !listOrdered) listItems.push({ text, task: true, checked })
      else { flushList(); listOrdered = false; inList = true; listItems = [{ text, task: true, checked }] }
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph(); flushQuote()
      const item = { text: line.replace(/^[-*]\s+/, '') }
      if (inList && !listOrdered) listItems.push(item)
      else { flushList(); listOrdered = false; inList = true; listItems = [item] }
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph(); flushQuote()
      const item = { text: line.replace(/^\d+\.\s+/, '') }
      if (inList && listOrdered) listItems.push(item)
      else { flushList(); listOrdered = true; inList = true; listItems = [item] }
      continue
    }
    if (/^\s*---\s*$/.test(line)) { flushParagraph(); flushList(); flushQuote(); blocks.push({ type: 'hr' }); continue }
    if (line.trim() === '') { flushParagraph(); flushList(); flushQuote(); continue }
    // A plain text line joins the current paragraph (or starts one).
    if (inList) flushList()
    paragraph.push(line)
  }
  // Flush any trailing open block.
  if (inCode) blocks.push({ type: 'code', value: code.join('\n'), ...(codeLang === undefined ? {} : { lang: codeLang }) })
  flushParagraph(); flushList(); flushQuote()
  return blocks
}

/**
 * Split an inline string into bold/italic/code/strike/link text nodes. Raw
 * text is emitted as React text nodes, which are inherently escaped — no
 * `dangerouslySetInnerHTML` is used, so the text can never inject HTML.
 * @param text - the inline text of one block.
 * @param options - the render options (link behavior and class names).
 * @returns the inline nodes, in document order.
 */
function renderInline(text: string, options: MarkdownOptions): ReactNode[] {
  const nodes: ReactNode[] = []
  const classes = options.classes
  const externalLinks = options.externalLinks === true
  let rest = text
  let key = 0
  while (rest.length > 0) {
    const link = rest.match(/\[([^\]]+)\]\(([^)]+)\)/)
    const bold = rest.match(/\*\*([^*]+)\*\*/)
    const code = rest.match(/`([^`]+)`/)
    const strike = rest.match(/~~([^~]+)~~/)
    const italic = rest.match(/\*([^*\n]+)\*/)
    const first = [
      { match: link, start: link?.index ?? Infinity, make: (m: RegExpMatchArray) => {
        const href = safeHrefForExternal(m[2]!)
        const className = classOf('link', classes)
        if (href === undefined) {
          // An unsupported scheme renders as inert text (no <a>) — the link text
          // still shows, but the target never becomes a scriptable anchor.
          return createElement('span', { key, className }, m[1])
        }
        return externalLinks
          ? createElement('a', { key, href, className, target: '_blank', rel: 'noreferrer' }, m[1])
          : createElement('a', { key, href, className }, m[1])
      } },
      { match: bold, start: bold?.index ?? Infinity, make: (m: RegExpMatchArray) => createElement('strong', { key }, m[1]) },
      { match: code, start: code?.index ?? Infinity, make: (m: RegExpMatchArray) => createElement('code', { key, className: classOf('code', classes) }, m[1]) },
      { match: strike, start: strike?.index ?? Infinity, make: (m: RegExpMatchArray) => createElement('del', { key }, m[1]) },
      { match: italic, start: italic?.index ?? Infinity, make: (m: RegExpMatchArray) => createElement('em', { key }, m[1]) },
    ].filter(item => item.match !== null).sort((a, b) => a.start - b.start)[0]
    if (first === undefined || !first.match) {
      nodes.push(rest)
      rest = ''
      continue
    }
    const before = rest.slice(0, first.start)
    if (before !== '') nodes.push(before)
    // eslint-disable-next-line no-loop-func
    nodes.push(first.make(first.match))
    key += 1
    rest = rest.slice(first.start + first.match[0].length)
  }
  return nodes
}

/**
 * Render one parsed block to a React node.
 * @param block - the parsed block.
 * @param key - the block's React key.
 * @param options - the render options (checklist behavior and class names).
 * @param taskStart - the index to begin assigning checklist tasks.
 * @returns the node and the next checklist index.
 */
function renderBlock(block: Block, key: number, options: MarkdownOptions, taskStart: number): { node: ReactNode; nextTask: number } {
  const classes = options.classes
  switch (block.type) {
    case 'heading': return { node: createElement(`h${block.level}` as 'h1', { key, className: classOf('heading', classes) }, renderInline(block.text, options)), nextTask: taskStart }
    case 'paragraph': return { node: createElement('p', { key, className: classOf('paragraph', classes) }, renderInline(block.text, options)), nextTask: taskStart }
    case 'quote': return { node: createElement('blockquote', { key, className: classOf('quote', classes) }, renderInline(block.text, options)), nextTask: taskStart }
    case 'hr': return { node: createElement('hr', { key, className: classOf('rule', classes) }), nextTask: taskStart }
    case 'code': {
      const renderCode = options.renderCodeBlock
      const node = renderCode === undefined
        ? createElement('pre', { key, className: classOf('codeBlock', classes) }, createElement('code', { className: classOf('code', classes) }, block.value))
        : createElement(Fragment, { key }, renderCode({ ...(block.lang === undefined ? {} : { lang: block.lang }), code: block.value }))
      return { node, nextTask: taskStart }
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      const onToggleTask = options.onToggleTask
      let current = taskStart
      const items = block.items.map((item, i) => {
        const itemKey = `${key}-${i}`
        if (item.task === true && onToggleTask !== undefined) {
          const index = current
          current += 1
          const id = `task-${itemKey}`
          return createElement('li', { key: itemKey, className: classOf('task', classes) },
            createElement('input', {
              type: 'checkbox', className: classOf('taskInput', classes), id,
              checked: item.checked === true,
              disabled: options.disabled === true,
              onChange: () => { onToggleTask(index, !item.checked) },
            }),
            createElement('span', { className: item.checked === true ? `${classOf('taskText', classes)} ${classOf('taskDone', classes)}` : classOf('taskText', classes) }, renderInline(item.text, options)),
          )
        }
        return createElement('li', { key: itemKey, className: classOf('listItem', classes) }, renderInline(item.text, options))
      })
      return { node: createElement(tag, { key, className: classOf(block.ordered ? 'orderedList' : 'unorderedList', classes) }, items), nextTask: current }
    }
  }
}

/**
 * Render markdown text as React nodes. Safe, no HTML injection (the output is
 * built from React text nodes, which escape the text; links/code/bold/italic/
 * strike are the only wrapped spans).
 * @param text - the markdown source.
 * @param options - the render options; see {@link MarkdownOptions}.
 * @returns one node per parsed block, in document order.
 */
export function renderMarkdown(text: string, options: MarkdownOptions = {}): ReactNode[] {
  let taskIndex = 0
  return parseBlocks(text).map((block, index) => {
    const rendered = renderBlock(block, index, options, taskIndex)
    taskIndex = rendered.nextTask
    return rendered.node
  })
}
