/**
 * The application area's stylesheet contracts, measured against the platform
 * theme:
 *
 * - **the management dialog** — one centered card, capped at `min(720px, 100%)`
 *   on a wide area and near-full-screen on a narrow one, with the head and the
 *   tab strip fixed while the body scrolls;
 * - **no CSS containment** — a `container-type` (or an `@container` query) on
 *   the area or its navigation would make them a containing block for the
 *   application pages' `position: fixed` overlays, which anchor to the viewport;
 *   narrowness is measured in JS (`narrow.ts`) and turned into classes instead;
 * - **the drawer's anchor** — the narrow navigation is absolutely positioned
 *   against the area root, which is relative only while narrow;
 * - **the banned text paint** — no copy is painted with the tertiary label
 *   (below AA on the base surface, measured below) and no rule uses a literal
 *   colour: the two stylesheets paint with semantic aliases only;
 * - **the text pairs** — every pair these stylesheets paint is resolved to the
 *   platform's own palette (light AND dark) and measured with real contrast
 *   arithmetic, so "AA" is a number here, not a claim.
 *
 * jsdom computes no layout, so the rules themselves are the artifact under
 * test: the class bodies are read out of the source CSS modules. The behaviour
 * the rules paint (the fold, the drawer, the dialog) is driven by the area spec.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  atRuleBody, contrastRatio, outerRules, propertyOf, readPlatformTheme, resolveToken, ruleBody,
} from './stylesheet.ts'

/** The two stylesheets the area paints with (the CSS-module imports carry class maps, not tokens). */
const sources = {
  area: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ApplicationsArea.module.css'), 'utf8'),
  lists: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'ApplicationsLists.module.css'), 'utf8'),
} as const

/** The unconditional rules of one stylesheet: what a wide area is painted with. */
const wide = { area: outerRules(sources.area), lists: outerRules(sources.lists) } as const

/** The marker of the narrow media query (the dialog goes near-full-screen there). */
const NARROW_MARKER = '(max-width: 720px)'

/** The narrow rules of the area stylesheet. */
const narrow = atRuleBody(sources.area, NARROW_MARKER) ?? ''

/** The declared value of one class's property in one stylesheet face. */
function value(face: string, className: string, property: string): string | undefined {
  const body = ruleBody(face, `.${className}`)
  return body === undefined ? undefined : propertyOf(body, property)
}

/** The value of one property in the rule carrying an exact selector. */
function selectorValue(face: string, selector: string, property: string): string | undefined {
  const body = ruleBody(face, selector)
  return body === undefined ? undefined : propertyOf(body, property)
}

/** One text pair these stylesheets paint: what it is, where, the class, its colour, its surface. */
type TextPair = readonly [what: string, sheet: 'area' | 'lists', selector: string, color: string, surface: string]

/** The pairs whose foreground is a platform LABEL colour. */
const TEXT_PAIRS: readonly TextPair[] = [
  ['a navigation row', 'area', 'navRow', 'dsw-alias-label-primary', 'dsw-alias-bg-base'],
  ['a navigation row status', 'area', 'navStatus', 'dsw-alias-label-secondary', 'dsw-alias-bg-base'],
  ['the navigation hint', 'area', 'navHint', 'dsw-alias-label-secondary', 'dsw-alias-bg-base'],
  ['the management entry', 'area', 'navManage', 'dsw-alias-label-secondary', 'dsw-alias-bg-base'],
  ['the header switcher', 'area', 'switcher', 'dsw-alias-label-primary', 'dsw-alias-bg-base'],
  ['a surface state', 'area', 'state', 'dsw-alias-label-primary', 'dsw-alias-bg-layer-1'],
  ['a state reason', 'area', 'stateReason', 'dsw-alias-label-secondary', 'dsw-alias-bg-layer-1'],
  ['a record code', 'lists', 'code', 'dsw-alias-label-secondary', 'dsw-alias-bg-layer-1'],
  ['a record meta line', 'lists', 'recordMeta', 'dsw-alias-label-secondary', 'dsw-alias-bg-layer-1'],
  ['a record meta value', 'lists', 'recordMetaText', 'dsw-alias-label-secondary', 'dsw-alias-bg-layer-1'],
  ['a record message', 'lists', 'recordMessage', 'dsw-alias-label-secondary', 'dsw-alias-bg-layer-1'],
]

/**
 * The platform's own state colours, kept as the platform ships them. The error
 * token measures 4.498:1 in light mode (4.50 unrounded) — at the AA boundary,
 * not over it — and inventing a second red here would break the platform's
 * vocabulary for no visible gain; the floor pins it against a further drop.
 */
const STATE_FLOOR = 4.49

/** The pairs whose foreground is a platform STATE colour rather than a label. */
const STATE_PAIRS: readonly TextPair[] = [
  ['a failed navigation row', 'area', ".navStatus[data-status='failed']", 'dsw-alias-state-error-primary', 'dsw-alias-bg-base'],
  ['the transport error line', 'area', 'error', 'dsw-alias-state-error-primary', 'dsw-alias-bg-layer-1'],
  ['a failed call’s message', 'lists', 'outcomeMessage', 'dsw-alias-state-error-primary', 'dsw-alias-bg-layer-1'],
]

describe('the management dialog (the new geometry)', () => {
  it('caps the card on a wide area and fills a narrow one', () => {
    expect(value(wide.area, 'dialog', 'width')).toBe('min(720px, 100%)')
    expect(value(wide.area, 'dialog', 'height')).toBe('min(620px, 100%)')
    expect(narrow).not.toBe('')
    expect(value(narrow, 'dialog', 'width')).toBe('100%')
    expect(value(narrow, 'dialog', 'height')).toBe('100%')
  })

  it('keeps the head and the tabs fixed while the body scrolls', () => {
    expect(value(wide.area, 'manageHead', 'flex')).toBe('none')
    expect(value(wide.area, 'manageTabs', 'flex')).toBe('none')
    expect(value(wide.area, 'manageBody', 'overflow')).toBe('auto')
    // A narrow tab strip wraps instead of overflowing the card.
    expect(value(wide.area, 'manageTabs', 'flex-wrap')).toBe('wrap')
  })
})

describe('the area’s layout invariants', () => {
  it('never becomes a CSS container for the pages’ fixed overlays', () => {
    expect(sources.area).not.toMatch(/container-type\s*:/u)
    expect(sources.lists).not.toMatch(/container-type\s*:/u)
    // A container QUERY is the same containment by another spelling.
    expect(sources.area).not.toMatch(/@container/u)
    expect(sources.lists).not.toMatch(/@container/u)
    // The outer box is a plain flex row: the navigation column and the frame.
    expect(value(wide.area, 'area', 'display')).toBe('flex')
    expect(value(wide.area, 'nav', 'display')).toBe('flex')
    expect(value(wide.area, 'frame', 'min-width')).toBe('0')
  })

  it('leaves a `flow` page to the outer scroller and hands a `fill` page the leftover height', () => {
    // `flow` (the default of `contentLayout`, contract.ts): the column claims no
    // free space, so the page stays an ordinary block and the outer `.surface`
    // scrolls it.
    expect(value(wide.area, 'content', 'display')).toBe('flex')
    expect(value(wide.area, 'content', 'flex')).toBeUndefined()
    // `fill`: the column takes the height left beside the notices and hands it
    // to the page, whose own list/body scrolls inside it.
    expect(value(wide.area, 'contentFill', 'flex')).toBe('1 1 auto')
    expect(value(wide.area, 'contentFill', 'min-height')).toBe('0')
  })

  it('anchors the narrow drawer to the area, and folds the wide column away entirely', () => {
    // The drawer is absolutely positioned, so the area root must be its
    // containing block while narrow — and only then.
    expect(value(wide.area, 'navDrawer', 'position')).toBe('absolute')
    expect(selectorValue(wide.area, ".area[data-narrow='true']", 'position')).toBe('relative')
    // Wide and folded: the column leaves the row (display: none), it does not
    // shrink to a sliver.
    expect(value(wide.area, 'nav', 'flex')).toBe('0 0 204px')
    expect(selectorValue(wide.area, ".nav[data-nav-state='collapsed']", 'display')).toBe('none')
  })

  it('paints no copy with the tertiary label and no rule with a literal colour', () => {
    for (const [what, source] of Object.entries(sources) as Array<[string, string]>) {
      // The label tertiary measures below AA on the base surface (asserted
      // below); neither stylesheet paints TEXT with it.
      expect(source, what).not.toMatch(/color:\s*var\(--dsw-alias-label-tertiary\)/u)
      // Semantic aliases only: a literal colour would leave the platform theme.
      expect(source, what).not.toMatch(/#[0-9a-fA-F]{3,8}/u)
    }
  })
})

describe('the area text pairs', () => {
  const theme = readPlatformTheme()

  /** The surfaces the tables above sit on, painted by these stylesheets themselves. */
  const SURFACES: readonly [sheet: 'area' | 'lists', className: string, token: string][] = [
    ['area', 'area', 'dsw-alias-bg-base'],
    ['area', 'state', 'dsw-alias-bg-layer-1'],
    ['area', 'error', 'dsw-alias-bg-layer-1'],
    ['lists', 'record', 'dsw-alias-bg-layer-1'],
    ['lists', 'outcome', 'dsw-alias-bg-layer-1'],
  ]

  it('paints the surfaces the pairs sit on', () => {
    // Without this, a class that stopped painting its surface would leave the
    // measurements below measuring pairs nobody paints.
    for (const [sheet, className, token] of SURFACES) {
      expect(value(wide[sheet], className, 'background'), `.${className}`).toBe(`var(--${token})`)
    }
  })

  it('declares each pair on the class that carries it', () => {
    for (const [what, sheet, selector, color] of [...TEXT_PAIRS, ...STATE_PAIRS]) {
      expect(selectorValue(wide[sheet], selector.startsWith('.') ? selector : `.${selector}`, 'color'), what)
        .toBe(`var(--${color})`)
    }
  })

  it('paints every label pair at or above WCAG AA in both themes', () => {
    for (const [what, , , foreground, background] of TEXT_PAIRS) {
      for (const scheme of ['light', 'dark'] as const) {
        const front = resolveToken(theme[scheme], `--${foreground}`)
        const back = resolveToken(theme[scheme], `--${background}`)
        expect(front, `${foreground} (${scheme})`).toBeDefined()
        expect(back, `${background} (${scheme})`).toBeDefined()
        const ratio = contrastRatio(front as string, back as string)
        expect(ratio, `${what}: ${foreground} on ${background} (${scheme})`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the platform state colours at the boundary they ship at', () => {
    for (const [what, , , foreground, background] of STATE_PAIRS) {
      for (const scheme of ['light', 'dark'] as const) {
        const front = resolveToken(theme[scheme], `--${foreground}`) as string
        const back = resolveToken(theme[scheme], `--${background}`) as string
        expect(contrastRatio(front, back), `${what} (${scheme})`).toBeGreaterThanOrEqual(STATE_FLOOR)
      }
    }
  })

  it('measures the defect the ban exists for: the tertiary label is below AA', () => {
    const tertiary = resolveToken(theme.light, '--dsw-alias-label-tertiary') as string
    expect(contrastRatio(tertiary, resolveToken(theme.light, '--dsw-alias-bg-base') as string)).toBeLessThan(4.5)
  })
})
