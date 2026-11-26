// @vitest-environment jsdom
/**
 * The ordinary conversation's turn-scope control: it shows the @ scope the
 * host reports and asks the host to revoke it.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TurnScopeControl } from '../src/client/turn-scope.tsx'

const t = ((key: string, params?: { readonly apps?: string }) => (
  key === 'scope.label' ? `scope:${params?.apps ?? ''}` : 'revoke'
)) as never

function control(remote: {
  appScope?: (sessionId: string) => Promise<{ readonly ok: true; readonly value: { readonly apps: readonly string[] } } | { readonly ok: false }>
  cancelAppScope?: (sessionId: string) => Promise<{ readonly ok: true; readonly value: boolean } | { readonly ok: false }>
}): ReactNode {
  return <TurnScopeControl sessionId="s-1" remote={remote} t={t as never} />
}

describe('the turn scope control', () => {
  it('shows the scope and revokes it on request', async () => {
    const cancelAppScope = vi.fn(async () => ({ ok: true as const, value: true }))
    const view = render(control({ appScope: async () => ({ ok: true as const, value: { apps: ['todo', 'notes'] } }), cancelAppScope }))
    await vi.waitFor(() => { expect(view.container.querySelector('[data-app-turn-scope]')?.textContent).toContain('scope:todo、notes') })
    fireEvent.click(view.container.querySelector('[data-app-turn-scope-cancel]')!)
    await vi.waitFor(() => { expect(cancelAppScope).toHaveBeenCalledWith('s-1') })
    await vi.waitFor(() => { expect(view.container.querySelector('[data-app-turn-scope]')).toBeNull() })
  })

  it('stays hidden when the host read fails and keeps the scope when cancel is refused', async () => {
    const failed = render(control({ appScope: async () => { throw new Error('offline') } }))
    await vi.waitFor(() => { expect(failed.container.querySelector('[data-app-turn-scope]')).toBeNull() })
    const refused = render(control({
      appScope: async () => ({ ok: true as const, value: { apps: ['todo'] } }),
      cancelAppScope: async () => ({ ok: false }),
    }))
    await vi.waitFor(() => { expect(refused.container.querySelector('[data-app-turn-scope]')).not.toBeNull() })
    fireEvent.click(refused.container.querySelector('[data-app-turn-scope-cancel]')!)
    await vi.waitFor(() => { expect(refused.container.querySelector('[data-app-turn-scope]')).not.toBeNull() })
  })

  it('stays hidden without a scope or a host read', async () => {
    const none = render(control({}))
    await vi.waitFor(() => { expect(none.container.querySelector('[data-app-turn-scope]')).toBeNull() })
    const empty = render(control({ appScope: async () => ({ ok: true as const, value: { apps: [] } }) }))
    await vi.waitFor(() => { expect(empty.container.querySelector('[data-app-turn-scope]')).toBeNull() })
  })
})
