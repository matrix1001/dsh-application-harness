// @vitest-environment jsdom
/**
 * The framework's one glyph renderer: every place that names an application
 * (navigation, quick switcher, header, management list) draws this, so the same
 * application never appears with two faces. A registration that declares no
 * icon still gets a glyph — the platform's neutral plugin mark — and a tone
 * maps to a theme class rather than to a colour.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppIcon, toneClass } from '../src/client/AppIcon.tsx'
import type { ApplicationTone, ApplicationView } from '../src/client/contract.ts'

afterEach(cleanup)

/** One registration carrying only the display facts this module reads. */
function view(over: Partial<ApplicationView> = {}): ApplicationView {
  return { Component: () => null, ...over }
}

describe('toneClass', () => {
  it('paints one class per declared tone, neutral for anything undeclared', () => {
    const declared: readonly ApplicationTone[] = ['business', 'success', 'warn', 'error', 'neutral']
    const classes = declared.map(tone => toneClass(view({ tone })))
    // Every declared tone has its own class…
    expect(new Set(classes).size).toBe(declared.length)
    // …none of them is empty (the join stays safe under the CSS-module map)…
    expect(classes.every(className => className !== '')).toBe(true)
    // …and a registration that declares nothing is neutral.
    expect(toneClass(undefined)).toBe(toneClass(view({ tone: 'neutral' })))
    expect(toneClass(view())).toBe(toneClass(view({ tone: 'neutral' })))
  })
})

describe('AppIcon', () => {
  it('renders the registration’s own glyph at the size the place asked for', () => {
    const own = view({ icon: ({ size }) => <span data-testid="own-icon">{size}</span> })
    const { getByTestId } = render(<AppIcon view={own} size={20} />)
    expect(getByTestId('own-icon').textContent).toBe('20')
  })

  it('falls back to the platform’s plugin glyph when nothing is declared', () => {
    const bare = render(<AppIcon view={view()} size={16} />)
    const marker = bare.container.querySelector('[data-app-icon]')
    expect(marker).not.toBeNull()
    // The fallback is a real platform glyph, not an empty box.
    expect(marker?.querySelector('svg')).not.toBeNull()
    // An application with no registration at all gets it too.
    const none = render(<AppIcon view={undefined} size={16} />)
    expect(none.container.querySelector('[data-app-icon] svg')).not.toBeNull()
  })
})
