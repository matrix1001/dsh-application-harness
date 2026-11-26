// @vitest-environment jsdom
/**
 * The header status control: one permanent, quiet anchor.
 *
 * The control used to appear only while it had notices, so a normal refresh
 * (an `info` in-progress notice) or a health flip made a warning triangle blink
 * in and out of the header. These tests pin the replacement: the anchor is
 * always there, only an error/warning paints it as a warning and counts, and an
 * in-progress notice is readable through the disclosure without alarming.
 */
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { StatusControl } from '../src/client/StatusControl.tsx'
import type { AreaNotice } from '../src/client/notices.ts'

afterEach(cleanup)

const t = ((key: string) => key) as unknown as TranslateNS<'applications'>

describe('the header status control', () => {
  it('stays present with a neutral anchor and says nothing needs attention', () => {
    render(createElement(StatusControl, { notices: [], panelId: 'status-panel', t }))
    const button = document.querySelector('[data-app-status]') as HTMLElement
    expect(button).not.toBeNull()
    expect(button.getAttribute('data-tone')).toBe('neutral')
    expect(button.getAttribute('aria-label')).toBe('notices.normal')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-app-status-anchor]')).not.toBeNull()
    expect(document.querySelector('[data-app-status-count]')).toBeNull()
    const panel = document.querySelector('[data-shell-notices]') as HTMLElement
    expect(panel.getAttribute('role')).toBe('region')
    expect(panel.getAttribute('data-open')).toBe('false')
    expect(document.querySelector('[data-shell-notices-empty]')?.textContent).toBe('notices.empty')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(panel.getAttribute('data-open')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(panel.getAttribute('data-open')).toBe('false')
  })

  it('counts only actionable notices and shows the strongest tone', () => {
    const notices: readonly AreaNotice[] = [
      { id: 'progress', tone: 'info', text: 'reading three sources' },
      { id: 'health', tone: 'warning', text: 'a source is failing' },
      { id: 'down', tone: 'error', text: 'the host is offline' },
    ]
    render(createElement(StatusControl, { notices, panelId: 'status-panel', t }))
    const button = document.querySelector('[data-app-status]') as HTMLElement
    expect(button.getAttribute('data-tone')).toBe('error')
    expect(button.getAttribute('aria-label')).toBe('notices.label (2)')
    expect(document.querySelector('[data-app-status-anchor]')).toBeNull()
    expect(document.querySelector('[data-app-status-count]')?.textContent).toBe('2')
  })

  it('shows an in-progress notice in the panel without painting the anchor', () => {
    const notices: readonly AreaNotice[] = [{ id: 'progress', tone: 'info', text: 'refreshing three sources' }]
    render(createElement(StatusControl, { notices, panelId: 'status-panel', t }))
    const button = document.querySelector('[data-app-status]') as HTMLElement
    expect(button.getAttribute('data-tone')).toBe('neutral')
    expect(button.getAttribute('aria-label')).toBe('notices.normal')
    expect(document.querySelector('[data-app-status-count]')).toBeNull()
    fireEvent.click(button)
    expect(document.querySelector('[data-shell-notices]')?.textContent).toContain('refreshing three sources')
    expect(document.querySelector('[data-shell-notices-empty]')).toBeNull()
  })
})
