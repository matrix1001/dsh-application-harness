// @vitest-environment jsdom
/** The one-shot dock request and the conversation-header action that fills it. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDock } from '../src/client/dock.ts'
import { OpenInAreaAction } from '../src/client/OpenInAreaAction.tsx'

afterEach(cleanup)

describe('the dock request', () => {
  it('publishes one request until the area consumes it', () => {
    const dock = createDock()
    const listener = vi.fn()
    dock.subscribe(listener)
    expect(dock.getSnapshot()).toBeUndefined()
    dock.open({ sessionId: 's1', kind: 'development', appId: 'notes' })
    expect(dock.getSnapshot()).toEqual({ sessionId: 's1', kind: 'development', appId: 'notes' })
    expect(listener).toHaveBeenCalledTimes(1)
    dock.consume()
    expect(dock.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
    dock.consume()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('renders the header action and reports the Session kind and app', () => {
    const dock = createDock()
    const selectPanel = vi.fn()
    const view = render(
      <OpenInAreaAction sessionId="s1" kind="development" appId="notes" dock={dock} selectPanel={selectPanel} label="Open here" />,
    )
    const button = view.container.querySelector('[data-open-in-area="s1"]') as HTMLElement
    expect(button.getAttribute('aria-label')).toBe('Open here')
    fireEvent.click(button)
    expect(dock.getSnapshot()).toEqual({ sessionId: 's1', kind: 'development', appId: 'notes' })
    expect(selectPanel).toHaveBeenCalledTimes(1)
  })
})
