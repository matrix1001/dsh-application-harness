// @vitest-environment jsdom
/**
 * The shared promise confirmation layer: a caller awaits a boolean, so both
 * decisions, Escape, the backdrop and a superseding request must settle it.
 */
import { useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useConfirm } from '../src/confirm.tsx'

afterEach(() => { cleanup() })

function Harness(): JSX.Element {
  const { confirm, dialog } = useConfirm()
  const [result, setResult] = useState('pending')
  return (
    <div>
      <button type="button" data-ask onClick={() => { void confirm({ title: 'Leave?', body: 'Changes will be lost.', confirmLabel: 'Leave', cancelLabel: 'Stay', danger: true }).then(value => { setResult(String(value)) }) }}>ask</button>
      <button type="button" data-ask-plain onClick={() => { void confirm({ title: 'Plain?', confirmLabel: 'OK', cancelLabel: 'No' }).then(value => { setResult(String(value)) }) }}>plain</button>
      <output data-result>{result}</output>
      {dialog}
    </div>
  )
}

function ask(): void { fireEvent.click(document.querySelector('[data-ask]') as HTMLButtonElement) }

describe('useConfirm', () => {
  it('settles true from the confirm button and renders the supplied copy', async () => {
    render(<Harness />)
    ask()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(document.querySelector('[data-confirm-dialog]')?.textContent).toContain('Changes will be lost.')
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-result]')?.textContent).toBe('true') })
    expect(document.querySelector('[data-confirm-dialog]')).toBeNull()
  })

  it('settles false from cancel, Escape and the backdrop', async () => {
    render(<Harness />)
    ask()
    await waitFor(() => { expect(document.querySelector('[data-confirm-cancel]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-confirm-cancel]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-result]')?.textContent).toBe('false') })

    ask()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(document.querySelector('[data-result]')?.textContent).toBe('false') })

    ask()
    await waitFor(() => { expect(document.querySelector('[data-confirm-backdrop]')).not.toBeNull() })
    fireEvent.mouseDown(document.querySelector('[data-confirm-backdrop]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-result]')?.textContent).toBe('false') })
  })

  it('omits an absent body, keeps a plain primary action and ignores clicks inside the panel', async () => {
    render(<Harness />)
    fireEvent.click(document.querySelector('[data-ask-plain]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    expect(document.querySelector('[data-confirm-dialog]')?.textContent).toBe('Plain?NoOK')
    fireEvent.mouseDown(document.querySelector('[data-confirm-dialog]') as HTMLElement)
    expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-result]')?.textContent).toBe('true') })
  })

  it('settles the previous question false when a second one supersedes it', async () => {
    render(<Harness />)
    ask()
    await waitFor(() => { expect(document.querySelector('[data-confirm-dialog]')).not.toBeNull() })
    ask()
    await waitFor(() => { expect(document.querySelector('[data-result]')?.textContent).toBe('false') })
    fireEvent.click(document.querySelector('[data-confirm-accept]') as HTMLButtonElement)
    await waitFor(() => { expect(document.querySelector('[data-result]')?.textContent).toBe('true') })
  })
})
