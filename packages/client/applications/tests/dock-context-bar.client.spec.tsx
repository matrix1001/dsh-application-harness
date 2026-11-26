// @vitest-environment jsdom
/**
 * The dock's page-context bar as a plain render: the three states (attached,
 * detached, no page) and the one control each state offers.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DockContextBar } from '../src/client/ApplicationsDock.tsx'

const t = ((key: string, params?: { readonly label?: string }) => {
  if (key === 'conversation.contextChip') return `current:${params?.label ?? ''}`
  if (key === 'conversation.contextOff') return 'detached'
  if (key === 'conversation.noPage') return 'no page'
  return key
}) as never

function bar(page: { readonly label: string } | undefined, enabled: boolean, onToggle = vi.fn()): ReactNode {
  return <DockContextBar page={page} enabled={enabled} onToggle={onToggle} t={t as never} />
}

describe('the dock page-context bar', () => {
  it('shows the current page and removes it', () => {
    const onToggle = vi.fn()
    const view = render(bar({ label: 'Notes' }, true, onToggle))
    expect(view.container.textContent).toContain('current:Notes')
    fireEvent.click(view.container.querySelector('[data-app-context-remove]')!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('shows the detached state and restores it', () => {
    const onToggle = vi.fn()
    const view = render(bar({ label: 'Notes' }, false, onToggle))
    expect(view.container.textContent).toContain('detached')
    fireEvent.click(view.container.querySelector('[data-app-context-restore]')!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('shows no page without offering a control', () => {
    const view = render(bar(undefined, true))
    expect(view.container.textContent).toContain('no page')
    expect(view.container.querySelector('[data-app-context-remove]')).toBeNull()
    expect(view.container.querySelector('[data-app-context-restore]')).toBeNull()
  })
})
