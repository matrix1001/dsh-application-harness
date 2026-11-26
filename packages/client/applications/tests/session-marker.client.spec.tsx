// @vitest-environment jsdom
/**
 * The Session-row marker: only application-area and development Sessions get
 * a glyph, and its accessible name carries the full meaning (including the
 * development application's display name).
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { SessionRowMarker } from '../src/client/session-marker.tsx'
import type { ApplicationPreferences } from '../src/client/preferences.ts'

const t = ((key: string, params?: { readonly app?: string }) => (
  key === 'marker.development' ? `development:${params?.app ?? ''}` : key
)) as never

function marker(sessionId: string, preferences: ApplicationPreferences, apps: readonly { id: string; name: string }[] = []): ReactNode {
  const useApplicationsPreferences = ((select: (state: ApplicationPreferences) => unknown) => select(preferences)) as never
  const useApplicationsRail = ((select: (state: { apps: readonly { id: string; name: string }[] }) => unknown) => select({ apps })) as never
  return <>{SessionRowMarker({ sessionId, t, useApplicationsPreferences, useApplicationsRail } as never)}</>
}

describe('the Session row marker', () => {
  it('marks an application-area Session', () => {
    const view = render(marker('s-app', {
      appConversation: { workspaceId: 'w', sessionId: 's-app' },
    }))
    const element = view.container.querySelector('[data-session-marker]')
    expect(element?.getAttribute('data-session-marker')).toBe('application')
    expect(element?.getAttribute('aria-label')).toBe('marker.application')
  })

  it('marks a development Session with its application name', () => {
    const view = render(marker('s-dev', {
      developmentSessions: [{ appId: 'todo', sessionId: 's-dev' }],
    }, [{ id: 'todo', name: '待办' }]))
    const element = view.container.querySelector('[data-session-marker]')
    expect(element?.getAttribute('data-session-marker')).toBe('development')
    expect(element?.getAttribute('title')).toBe('development:待办')
  })

  it('renders nothing for an ordinary Session', () => {
    const view = render(marker('s-normal', {}))
    expect(view.container.querySelector('[data-session-marker]')).toBeNull()
  })

  it('falls back to the application id when the row is not loaded', () => {
    const view = render(marker('s-dev', {
      developmentSessions: [{ appId: 'missing', sessionId: 's-dev' }],
    }))
    const element = view.container.querySelector('[data-session-marker]')
    expect(element?.getAttribute('title')).toBe('development:missing')
  })

  it('renders nothing without the preferences hook', () => {
    const view = render(<>{SessionRowMarker({ sessionId: 's-app', t } as never)}</>)
    expect(view.container.querySelector('[data-session-marker]')).toBeNull()
  })
})
