// @vitest-environment jsdom
/**
 * The shared world-view chrome (Section + TabBar): a page-section composes an
 * optional header (title + caption + action) over a body that is a PLAIN
 * grouping by default (a card surface only where the caller asks for one) and
 * a bounded scroll area when `scroll` is set; the tab ring is a WAI-ARIA
 * tablist with roving tabindex. The chrome is a static browser library each
 * consuming client bundle inlines; the world views compose their sections from
 * it. These cases cover every Section branch (header presence,
 * title/caption/action each present or absent, surface on/off, scroll on/off,
 * className merge, data-* passthrough) so the chrome source holds 100%
 * coverage.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Section, TabBar } from '../src/index.tsx'
import css from '../src/shell.module.css'

afterEach(() => { cleanup() })

describe('Section', () => {
  it('renders a header (title + caption + action) over a PLAIN body by default', () => {
    const { container } = render(
      <Section title="标题" caption="副标题" action={<button type="button">动作</button>}>
        <span>内容</span>
      </Section>,
    )
    // Header: title + caption + action.
    expect(container.querySelector('h3')!.textContent).toBe('标题')
    expect(container.querySelector('span')!.textContent).toBe('副标题')
    expect(container.querySelector('button')!.textContent).toBe('动作')
    // An ordinary grouping is organized by its heading and spacing, never by a
    // card drawn around it.
    const body = container.querySelector('section')!.lastElementChild as HTMLElement
    expect(body.className).not.toContain(css.surface)
    expect(body.textContent).toContain('内容')
  })

  it('renders a card surface when the caller asks for one', () => {
    const { container } = render(
      <Section surface><span>工具面板</span></Section>,
    )
    const section = container.querySelector('section')!
    // No header (no title/caption/action), and the bounded tool's own surface.
    expect(section.querySelector('header')).toBeNull()
    expect(section.textContent).toContain('工具面板')
    const body = section.lastElementChild as HTMLElement
    expect(body.className).toContain(css.surface)
  })

  it('marks the body as a bounded scroll area when scroll is set', () => {
    const { container } = render(
      <Section scroll><span>滚动内容</span></Section>,
    )
    const section = container.querySelector('section')!
    const body = section.lastElementChild as HTMLElement
    expect(body.className).toContain(css.scroll)
  })

  it('merges an extra className and forwards data-* to the section root', () => {
    const { container } = render(
      <Section title="t" className="mine" data-testid="anchor">x</Section>,
    )
    const section = container.querySelector('section')!
    expect(section.className).toContain('mine')
    expect(section.getAttribute('data-testid')).toBe('anchor')
  })

  it('renders only a title (no caption/action) without a trailing action node', () => {
    const { container } = render(
      <Section title="only-title">内容</Section>,
    )
    const section = container.querySelector('section')!
    expect(section.querySelector('h3')!.textContent).toBe('only-title')
    // No caption, no action.
    expect(section.querySelectorAll('span')).toHaveLength(0)
    expect(section.querySelector('button')).toBeNull()
  })

  it('renders only a caption (no title) as the secondary line', () => {
    const { container } = render(
      <Section caption="仅说明">内容</Section>,
    )
    const section = container.querySelector('section')!
    expect(section.querySelector('h3')).toBeNull()
    expect(section.querySelector('span')!.textContent).toBe('仅说明')
  })
})

describe('TabBar', () => {
  it('renders every tab, marking the active one and setting aria-selected', () => {
    const { container } = render(
      <TabBar tabs={[{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }]} active="b" onSelect={() => {}} />,
    )
    const buttons = container.querySelectorAll('button[role="tab"]')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.textContent).toBe('甲')
    expect(buttons[1]!.textContent).toBe('乙')
    expect(buttons[0]!.getAttribute('aria-selected')).toBe('false')
    expect(buttons[1]!.getAttribute('aria-selected')).toBe('true')
    expect(buttons[0]!.className).not.toContain(css.tabActive)
    expect(buttons[1]!.className).toContain(css.tabActive)
    // The tablist root carries role=tablist.
    expect(container.querySelector('div[role="tablist"]')).not.toBeNull()
  })

  it('carries a per-tab locator anchor and an optional suffix node without redefining the tab', () => {
    // The disk-analysis adoption: each tab keeps its own identity
    // (`data-disk-tab="changes"`) and its own count badge while the ring itself
    // is the shared chrome. Chrome's semantics must win over the spread: an
    // anchor that tried to pass `role` or `aria-selected` cannot re-define the
    // button.
    const { container } = render(
      <TabBar
        tabs={[
          { id: 'a', label: '甲', anchor: { 'data-test-tab': 'a' }, suffix: <span data-test-badge>3</span> },
          { id: 'b', label: '乙', anchor: { 'data-test-tab': 'b', role: 'listitem', 'aria-selected': 'true' } },
        ]}
        active="b"
        onSelect={() => {}}
        data-test-ring
      />,
    )
    const ring = container.querySelector('div[role="tablist"]')!
    expect(ring.getAttribute('data-test-ring')).not.toBeNull()
    const first = container.querySelector('[data-test-tab="a"]')!
    expect(first.getAttribute('role')).toBe('tab')
    expect(first.getAttribute('aria-selected')).toBe('false')
    expect(first.querySelector('[data-test-badge]')!.textContent).toBe('3')
    const second = container.querySelector('[data-test-tab="b"]')!
    expect(second.getAttribute('role')).toBe('tab')
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(second.textContent).toBe('乙')
  })

  it('calls onSelect with the clicked tab id', () => {
    const onSelect = vi.fn()
    const { getByText } = render(
      <TabBar tabs={[{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }]} active="a" onSelect={onSelect} />,
    )
    fireEvent.click(getByText('乙'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('renders an attention dot only on the tabs that request one', () => {
    const { container } = render(
      <TabBar tabs={[{ id: 'a', label: '甲', dot: true }, { id: 'b', label: '乙' }]} active="a" onSelect={() => {}} />,
    )
    const buttons = container.querySelectorAll('button[role="tab"]')
    // The dot element is empty, so it never changes the visible label text.
    expect(buttons[0]!.textContent).toBe('甲')
    expect(buttons[1]!.textContent).toBe('乙')
    expect(buttons[0]!.querySelector(`.${css.tabDot}`)).not.toBeNull()
    expect(buttons[1]!.querySelector(`.${css.tabDot}`)).toBeNull()
  })

  it('roves tabindex to the active tab and moves focus/selection with arrow keys', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <TabBar tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]} active="b" onSelect={onSelect} />,
    )
    const buttons = (): HTMLElement[] => Array.from(container.querySelectorAll('button[role="tab"]'))
    // Roving tabindex: only the active tab is tabbable.
    expect(buttons()[0]!.tabIndex).toBe(-1)
    expect(buttons()[1]!.tabIndex).toBe(0)
    // A non-arrow key does not change selection.
    fireEvent.keyDown(buttons()[1]!, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    // ArrowRight moves to the next tab.
    fireEvent.keyDown(buttons()[1]!, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith('c')
    expect(document.activeElement).toBe(buttons()[2])
    // ArrowLeft wraps to the previous tab.
    fireEvent.keyDown(buttons()[2]!, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(document.activeElement).toBe(buttons()[1])
    fireEvent.keyDown(buttons()[1]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons()[2])
    fireEvent.keyDown(buttons()[2]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(buttons()[1])
  })

  it('merges a className and forwards data-* to the tablist root', () => {
    const { container } = render(
      <TabBar tabs={[{ id: 'a', label: '甲' }]} active="a" onSelect={() => {}} className="mine" data-testid="rings" />,
    )
    const root = container.querySelector('div[role="tablist"]')!
    expect(root.className).toContain('mine')
    expect(root.getAttribute('data-testid')).toBe('rings')
  })

  it('renders an empty tablist when there are no tabs', () => {
    const { container } = render(<TabBar tabs={[]} active="nope" onSelect={() => {}} />)
    const root = container.querySelector('div[role="tablist"]')!
    expect(root.querySelectorAll('button')).toHaveLength(0)
  })

})
