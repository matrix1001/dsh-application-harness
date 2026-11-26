// @vitest-environment jsdom
/** The Session dock strip/body: the shared-row tab UI, controls and content column. */
import { createElement } from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApplicationsDockBody, ApplicationsDockHeader, type DockTabView } from '../src/client/ApplicationsDock.tsx'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(cleanup)

const t = ((key: string, params?: Record<string, string>) => params === undefined ? key : `${key}:${Object.values(params).join(',')}`) as never
const tabs: readonly DockTabView[] = [
  { id: 'app-1', kind: 'app-conversation', title: 'Application conversation' },
  { id: 'dev-1', kind: 'development', title: 'Development', appName: 'Notes' },
  { id: 'n-1', kind: 'normal', title: 'Normal session' },
]

function header(over: Partial<Parameters<typeof ApplicationsDockHeader>[0]> = {}) {
  const props = {
    tabs,
    otherTabs: [{ id: 'dev-2', kind: 'development' as const, title: 'Other development', appName: 'Todo' }],
    activeId: 'app-1',
    openableTabs: [] as readonly DockTabView[],
    onOpenTab: vi.fn(),
    otherOpen: false,
    normalChoices: [] as readonly { sessionId: string; title?: string }[],
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseRight: vi.fn(),
    onToggleOther: vi.fn(),
    onCollapse: vi.fn(),
    onNewConversation: vi.fn(),
    onNewDevelopment: vi.fn(),
    onOpenNormal: vi.fn(),
    onOpenInSession: vi.fn(),
    onToggleContext: vi.fn(),
    narrow: false,
    onBack: vi.fn(),
    t,
    ...over,
  }
  const view = render(createElement(ApplicationsDockHeader, props))
  return { view, props }
}

describe('the dock strip', () => {
  it('moves through the Session tabs with roving focus and Delete closes one', () => {
    const { view, props } = header()
    const active = view.container.querySelector('[data-app-dock-tab="app-1"]') as HTMLElement
    expect(active.getAttribute('tabindex')).toBe('0')
    expect((view.container.querySelector('[data-app-dock-tab="dev-1"]') as HTMLElement).getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(active, { key: 'ArrowRight' })
    expect(props.onSelect).toHaveBeenCalledWith('dev-1')
    fireEvent.keyDown(active, { key: 'ArrowLeft' })
    expect(props.onSelect).toHaveBeenCalledWith('n-1')
    fireEvent.keyDown(active, { key: 'Home' })
    expect(props.onSelect).toHaveBeenCalledWith('app-1')
    fireEvent.keyDown(active, { key: 'End' })
    expect(props.onSelect).toHaveBeenCalledWith('n-1')
    fireEvent.keyDown(active, { key: 'Delete' })
    expect(props.onClose).toHaveBeenCalledWith('app-1')
  })

  it('renders the Session tabs, selects and closes one, and exposes the kind icons', () => {
    const { view, props } = header()
    expect(view.getByRole('tab', { name: /Application conversation/ })).toBeDefined()
    expect(view.getByRole('tab', { name: /Development/ })).toBeDefined()
    expect(view.container.querySelector('[data-app-dock-tab="dev-1"]')?.getAttribute('data-kind')).toBe('development')
    fireEvent.click(view.getByRole('tab', { name: /Development/ }))
    expect(props.onSelect).toHaveBeenCalledWith('dev-1')
    fireEvent.click(view.container.querySelector('[data-app-dock-close="n-1"]') as HTMLElement)
    expect(props.onClose).toHaveBeenCalledWith('n-1')
  })

  it('folds the other-application development tabs and selects them when unfolded', () => {
    const { view, props } = header()
    const toggle = view.container.querySelector('[data-app-dock-other-toggle]') as HTMLElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-app-dock-tab="dev-2"]')).toBeNull()
    fireEvent.click(toggle)
    expect(props.onToggleOther).toHaveBeenCalled()
    cleanup()
    const opened = header({ otherOpen: true })
    fireEvent.click(opened.view.getByRole('tab', { name: /Other development/ }))
    expect(opened.props.onSelect).toHaveBeenCalledWith('dev-2')
  })

  it('opening the add menu offers new, reopened and normal Sessions', () => {
    const { view, props } = header({
      openableTabs: [{ id: 'app-2', kind: 'app-conversation', title: 'Old conversation' }],
      normalChoices: [{ sessionId: 'normal-1', title: 'Normal one' }],
    })
    fireEvent.click(view.container.querySelector('[data-app-dock-new]') as HTMLElement)
    const menu = document.body.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    fireEvent.click(within(menu as HTMLElement).getByRole('menuitem', { name: 'dock.openSession: Old conversation' }))
    expect(props.onOpenTab).toHaveBeenCalledWith('app-2')
    fireEvent.click(view.container.querySelector('[data-app-dock-new]') as HTMLElement)
    fireEvent.click(within(document.body.querySelector('[role="menu"]') as HTMLElement).getByRole('menuitem', { name: 'dock.newAppConversation' }))
    expect(props.onNewConversation).toHaveBeenCalled()
    fireEvent.click(view.container.querySelector('[data-app-dock-new]') as HTMLElement)
    fireEvent.click(within(document.body.querySelector('[role="menu"]') as HTMLElement).getByRole('menuitem', { name: 'dock.newDevelopment' }))
    expect(props.onNewDevelopment).toHaveBeenCalled()
  })

  it('opens the tab context menu for open-in-conversation and close', () => {
    const { view, props } = header()
    const tab = view.container.querySelector('[data-app-dock-tab="dev-1"]') as HTMLElement
    fireEvent.contextMenu(tab, { clientX: 40, clientY: 60 })
    const menu = document.body.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    fireEvent.click(within(menu as HTMLElement).getByRole('menuitem', { name: 'dock.openInSession' }))
    expect(props.onOpenInSession).toHaveBeenCalledWith('dev-1')
    fireEvent.contextMenu(tab, { clientX: 40, clientY: 60 })
    const menu2 = document.body.querySelector('[role="menu"]')
    fireEvent.click(within(menu2 as HTMLElement).getByRole('menuitem', { name: /dock.closeTab/ }))
    expect(props.onClose).toHaveBeenCalledWith('dev-1')
    fireEvent.contextMenu(tab, { clientX: 40, clientY: 60 })
    fireEvent.click(within(document.body.querySelector('[role="menu"]') as HTMLElement).getByRole('menuitem', { name: 'dock.closeOthers' }))
    expect(props.onCloseOthers).toHaveBeenCalledWith('dev-1')
    fireEvent.contextMenu(tab, { clientX: 40, clientY: 60 })
    fireEvent.click(within(document.body.querySelector('[role="menu"]') as HTMLElement).getByRole('menuitem', { name: 'dock.closeRight' }))
    expect(props.onCloseRight).toHaveBeenCalledWith('dev-1')
  })

  it('renders the Session status dot with its accessible label', () => {
    const { view } = header({ tabs: [{ id: 'app-1', kind: 'app-conversation', title: 'App', status: { tone: 'attention', label: 'Needs you' } }] })
    const dot = view.container.querySelector('[data-tone="attention"]')
    expect(dot?.getAttribute('aria-label')).toBe('Needs you')
  })

  it('wires the panel controls', () => {
    const { view, props } = header()
    fireEvent.click(view.container.querySelector('[data-app-dock-open-session]') as HTMLElement)
    expect(props.onOpenInSession).toHaveBeenCalledWith('app-1')
    fireEvent.click(view.container.querySelector('[data-app-dock-collapse]') as HTMLElement)
    expect(props.onCollapse).toHaveBeenCalled()
  })

  it('renders the content column and the narrow overlay', () => {
    const body = render(<ApplicationsDockBody width={390} narrow={false} t={t}><p>conversation</p></ApplicationsDockBody>)
    expect(body.container.textContent).toContain('conversation')
    expect(body.container.querySelector('[data-app-dock-body]')?.getAttribute('data-app-dock-body')).toBe('true')
    cleanup()
    const narrow = render(<ApplicationsDockBody width={390} narrow t={t}><p>conversation</p></ApplicationsDockBody>)
    expect(narrow.container.querySelector('[data-app-dock-body]')?.className).toContain('dockBodyNarrow')
  })
})
