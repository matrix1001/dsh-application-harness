// @vitest-environment jsdom
/** The chrome's own controls: no platform primitive package involved. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import type { ComponentType } from 'react'
import {
  Button, FenceCodeBlock, Menu, MenuItemButton, Modal, Switch, Tooltip,
  IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconCheckOutlineRegular,
} from '../src/index.tsx'
import * as icons from '../src/ui/icons.tsx'

afterEach(cleanup)

describe('Button', () => {
  it('renders every variant, size and a forwarded ref', () => {
    const ref = createRef<HTMLButtonElement>()
    const view = render(<><Button ref={ref} variant="primary">p</Button><Button variant="ghost" size="sm">g</Button><Button>o</Button></>)
    expect(ref.current?.textContent).toBe('p')
    expect(view.container.querySelectorAll('button')).toHaveLength(3)
    expect(view.container.querySelectorAll('button')[1]!.className).toContain('buttonSm')
  })
  it('passes disabled and data attributes through', () => {
    const view = render(<Button disabled data-x="1" onClick={() => { throw new Error('no') }}>x</Button>)
    const button = view.getByRole('button')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('data-x')).toBe('1')
  })
})

describe('Switch', () => {
  it('reports the next state and honours disabled', () => {
    const onChange = vi.fn()
    const view = render(<Switch checked={false} label="need" onChange={onChange} />)
    fireEvent.click(view.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
    view.rerender(<Switch checked label="need" disabled onChange={onChange} />)
    expect(view.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })
})

describe('Tooltip', () => {
  it('shows the label on hover/focus and hides on leave', () => {
    const view = render(<Tooltip label="hint" side="bottom" delayMs={0}><button>target</button></Tooltip>)
    expect(screen.queryByRole('tooltip')).toBeNull()
    const wrap = view.container.querySelector('span')!
    fireEvent.mouseEnter(wrap)
    expect(screen.getByRole('tooltip').textContent).toBe('hint')
    fireEvent.mouseLeave(wrap)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(view.getByRole('button'))
    expect(screen.queryByRole('tooltip')).not.toBeNull()
    fireEvent.blur(view.getByRole('button'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
  it('supports delayed display and clears the timer on unmount', () => {
    vi.useFakeTimers()
    try {
      const view = render(<Tooltip label="hint" delayMs={20}><button>target</button></Tooltip>)
      fireEvent.mouseEnter(view.container.querySelector('span')!)
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => { vi.advanceTimersByTime(25) })
      expect(screen.queryByRole('tooltip')).not.toBeNull()
      view.unmount()
    } finally { vi.useRealTimers() }
  })
})

describe('Modal', () => {
  it('renders a headed dialog and closes through the close button, mask and Escape', () => {
    const onClose = vi.fn()
    const view = render(<Modal open onClose={onClose} title="Title" description="Body" closeLabel="Close" footer={<button>ok</button>}>content</Modal>)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Title')
    expect(view.getByText('Body')).toBeDefined()
    expect(view.getByText('ok')).toBeDefined()
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(document.body.querySelector('[aria-hidden="true"]')!)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })
  it('renders headless content without a header or footer', () => {
    const view = render(<Modal open headless onClose={() => {}} title="H">body</Modal>)
    expect(view.queryByRole('heading')).toBeNull()
    expect(view.getByText('body')).toBeDefined()
  })
})

describe('Menu', () => {
  it('renders item entries and invokes the id', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const view = render(<Menu open anchor={<button>open</button>} items={[
      { id: 'one', label: 'One' },
      { type: 'separator', id: 's' },
      { type: 'label', id: 'l', text: 'Group' },
      { id: 'two', label: 'Two', danger: true, icon: <span>i</span> },
    ]} onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(view.getByRole('menuitem', { name: /One/u }))
    expect(onSelect).toHaveBeenCalledWith('one')
    expect(view.container.querySelector('[role="separator"]')).not.toBeNull()
    expect(view.getByText('Group')).toBeDefined()
    expect(view.container.querySelector('[role="menu"]')).not.toBeNull()
  })
  it('renders component rows, closes outside, and walks with the keyboard', async () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()
    const view = render(<Menu open autoFocus anchor={<button>open</button>} onClose={onClose}><MenuItemButton onSelect={onSelect}>A</MenuItemButton><MenuItemButton danger onSelect={() => {}}>B</MenuItemButton></Menu>)
    expect(document.activeElement?.textContent).toBe('A')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('B')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('A')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement?.textContent).toBe('B')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement?.textContent).toBe('A')
    fireEvent.click(view.getByRole('menuitem', { name: 'A' }))
    expect(onSelect).toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })
  it('closes with Escape and can portal', () => {
    const onClose = vi.fn()
    render(<Menu open portal anchor={<button>open</button>} onClose={onClose} items={[{ id: 'a', label: 'A' }]} onSelect={() => {}} />)
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('FenceCodeBlock', () => {
  it('renders code and copies with the labels', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = render(<FenceCodeBlock lang="ts" code="const x = 1" labels={{ copyLabel: 'Copy', copiedLabel: 'Copied' }} />)
    expect(view.getByText('const x = 1')).toBeDefined()
    fireEvent.click(view.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Copied' })).toBeDefined())
    expect(writeText).toHaveBeenCalledWith('const x = 1')
  })
})

describe('icons', () => {
  it('renders the shared icon props', () => {
    const view = render(<><IconChevronDownOutlineRegular size={12} /><IconCheckOutlineRegular /></>)
    expect(view.container.querySelectorAll('svg')).toHaveLength(2)
    expect(view.container.querySelector('svg')!.getAttribute('width')).toBe('12')
  })

  it('draws every icon from the platform artwork', () => {
    const entries = Object.entries(icons).filter(([name]) => name.startsWith('Icon'))
    expect(entries).toHaveLength(22)
    for (const [, value] of entries) {
      const Icon = value as ComponentType<{ readonly size?: number }>
      const view = render(<Icon />)
      const svg = view.container.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg!.getAttribute('viewBox')).toBeTruthy()
      expect(svg!.querySelectorAll('path, circle, rect').length).toBeGreaterThan(0)
      view.unmount()
    }
  })

  it('keeps the platform non-scaling stroke on outline paths', () => {
    const view = render(<IconBranchOutlineRegular />)
    expect(view.container.querySelector('path')?.getAttribute('vector-effect')).toBe('non-scaling-stroke')
  })
})
