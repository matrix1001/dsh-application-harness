// @vitest-environment jsdom
/**
 * The rail badge and composer-guidance pieces as plain renders: the sidebar
 * owns their rows, so these assertions cover what this plugin contributes —
 * the count text, the accessible description, and the elected guidance.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ApplicationsRailBadge } from '../src/client/rail.tsx'
import { ApplicationsPlaceholder } from '../src/client/placeholder.tsx'

/** The locale seat the components receive in production. */
const t = ((key: string, params?: { readonly count?: number }) => (
  key === 'rail.pending' ? `${String(params?.count)} pending` : key
)) as never

/** Render the badge with a scripted confirmation count. */
function badge(count: number): ReactNode {
  const useApplicationsRail = ((select: (state: { confirmations: readonly unknown[] }) => unknown) => (
    select({ confirmations: Array.from({ length: count }, () => ({})) })
  )) as never
  return <>{ApplicationsRailBadge({ useApplicationsRail, t, wide: true, active: false } as never)}</>
}

describe('the applications rail badge', () => {
  it('shows the waiting count with a screen-reader description', () => {
    const view = render(badge(2))
    const element = view.container.querySelector('[data-app-rail-badge]')
    expect(element?.querySelector('[aria-hidden="true"]')?.textContent).toBe('2')
    expect(element?.textContent).toContain('2 pending')
  })

  it('renders nothing while no confirmation is waiting', () => {
    const view = render(badge(0))
    expect(view.container.querySelector('[data-app-rail-badge]')).toBeNull()
  })
})

describe('the application conversation guidance', () => {
  it('renders the elected text inline', () => {
    const view = render(<>{ApplicationsPlaceholder({ matched: { text: 'Ask about the page' } } as never)}</>)
    expect(view.container.textContent).toBe('Ask about the page')
  })
})
