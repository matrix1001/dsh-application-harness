// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFailure } from '../src/local-failure.tsx'

afterEach(cleanup)

describe('LocalFailure', () => {
  it('keeps the host message behind the disclosure and announces the localized title', () => {
    const view = render(<LocalFailure title="Could not refresh" message="socket hang up" detailLabel="Diagnostics" data-testid="local" />)
    const node = screen.getByTestId('local')
    expect(node.getAttribute('role')).toBe('alert')
    expect(node.getAttribute('data-local-failure')).toBe('true')
    // The English wire message is not the headline; it is only in the details.
    expect(node.firstElementChild?.textContent).toBe('Could not refresh')
    expect(node.querySelector('details summary')?.textContent).toBe('Diagnostics')
    expect(node.querySelector('details [data-local-failure-message]')?.textContent).toBe('socket hang up')
    view.unmount()
  })

  it('renders the optional action and code, and nothing to disclose without detail', () => {
    const withDetail = render(<LocalFailure title="Save failed" code="app.stale" detailLabel="Diagnostics" action={<button type="button">Retry</button>} />)
    expect(withDetail.container.querySelector('button')?.textContent).toBe('Retry')
    expect(withDetail.container.querySelector('[data-local-failure-code]')?.textContent).toBe('app.stale')
    cleanup()
    const bare = render(<LocalFailure title="Save failed" detailLabel="Diagnostics" />)
    expect(bare.container.querySelector('details')).toBeNull()
  })
})
