// @vitest-environment jsdom
/**
 * The shared page language pieces: empty state, form field and toolbar row.
 * These are presentational, so the suite pins the structure the applications
 * rely on — the label/control association and error role, the compact empty
 * variant, the toolbar wrap/align choice, and data-* passthrough (locator
 * anchors must survive the extraction).
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EmptyState, Field, Toolbar } from '../src/index.tsx'

afterEach(cleanup)

describe('EmptyState', () => {
  it('renders the title alone and adds nothing the caller did not ask for', () => {
    const view = render(<EmptyState title="Nothing here" />)
    const root = view.container.querySelector('[data-empty-state]')!
    expect(root.className).not.toContain('emptyStateCompact')
    expect(root.textContent).toBe('Nothing here')
    expect(root.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders a glyph, body, action and forwards anchors', () => {
    const view = render(
      <EmptyState
        title="Nothing here"
        body="Add a source to begin"
        icon={<span data-testid="glyph">g</span>}
        action={<button type="button">Add</button>}
        className="app-empty"
        data-info-empty
      />,
    )
    const root = view.container.querySelector('[data-info-empty]')!
    expect(root.textContent).toContain('Add a source to begin')
    expect(view.getByTestId('glyph').parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(view.getByRole('button', { name: 'Add' })).toBeDefined()
    expect(root.className).toContain('app-empty')
  })

  it('uses the compact in-panel variant', () => {
    const view = render(<EmptyState title="No tasks" compact />)
    expect(view.container.querySelector('[data-empty-state]')!.className).toContain('emptyStateCompact')
  })
})

describe('Field', () => {
  it('associates the label with the control through htmlFor', () => {
    const view = render(
      <Field label="Title" htmlFor="task-title">
        <input id="task-title" />
      </Field>,
    )
    expect(view.getByLabelText('Title')).toBeDefined()
  })

  it('renders the required marker, hint and an alert error', () => {
    const view = render(
      <Field label="Title" htmlFor="t" required hint="Short" error="Required" data-test-field>
        <input id="t" />
      </Field>,
    )
    const root = view.container.querySelector('[data-test-field]')!
    expect(root.textContent).toContain('*')
    expect(root.textContent).toContain('Short')
    expect(view.getByRole('alert').textContent).toBe('Required')
  })

  it('renders without optional lines and accepts an extra class', () => {
    const view = render(
      <Field label="Title" className="app-field">
        <input />
      </Field>,
    )
    const root = view.container.querySelector('[data-field]')!
    expect(root.className).toContain('app-field')
    expect(root.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('Toolbar', () => {
  it('is one non-wrapping row by default', () => {
    const view = render(<Toolbar><button type="button">A</button><button type="button">B</button></Toolbar>)
    const root = view.container.querySelector('[data-toolbar]')!
    expect(root.className).not.toContain('toolbarWrap')
    expect(root.className).not.toContain('toolbarStart')
  })

  it('wraps and aligns to the start on request, with a merged class', () => {
    const view = render(
      <Toolbar wrap align="start" className="app-toolbar" data-test-toolbar>
        <span>filters</span>
      </Toolbar>,
    )
    const root = view.container.querySelector('[data-test-toolbar]')!
    expect(root.className).toContain('toolbarWrap')
    expect(root.className).toContain('toolbarStart')
    expect(root.className).toContain('app-toolbar')
  })
})
