/**
 * WCAG contrast arithmetic for the panel's stylesheet, measured against the
 * REAL platform theme.
 *
 * The panel paints with semantic aliases (`--dsw-alias-*`) and never with a
 * literal colour, so a contrast assertion has to resolve those aliases to the
 * concrete palette the platform ships. That palette is not part of this
 * repository: it lives in the installed `@deepseek-ai/dsh-client-ui-theme`
 * client bundle as the two `body` declaration blocks (light) and
 * `body[data-ds-dark-theme]` blocks (dark). This module reads them, follows
 * `var()` chains to their hex leaves, and computes the ratios — so the tests
 * assert what a browser would actually paint instead of a copied-down table
 * that drifts with the platform.
 *
 * Test-plane only: nothing here ships in the bundle.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The two resolved token maps of one platform theme. */
export interface Theme {
  /** `body` declarations: the light theme. */
  readonly light: ReadonlyMap<string, string>
  /** `body[data-ds-dark-theme]` declarations: the dark theme. */
  readonly dark: ReadonlyMap<string, string>
}

/** One `--name: value` declaration set of a stylesheet selector. */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const declarations = new Map<string, string>()
  const escaped = selector.replace(/[[\]]/gu, character => `\\${character}`)
  const pattern = new RegExp(`(?:^|[^\\w\\].-])${escaped}\\s*\\{([^{}]*)\\}`, 'g')
  for (const match of css.matchAll(pattern)) {
    for (const declaration of match[1]!.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon <= 0) continue
      const name = declaration.slice(0, colon).trim()
      if (name.startsWith('--')) declarations.set(name, declaration.slice(colon + 1).trim())
    }
  }
  return declarations
}

/**
 * Read the installed platform theme's token maps.
 *
 * The theme package is a platform module (not a dependency of this package),
 * so it is located through the pnpm store layout the repository pins — at the
 * EXACT version `deployment.yml` declares. The store keeps every earlier line
 * after an upgrade, so a name-only lookup could measure last release's palette.
 * @param root - the repository root (vitest runs from it).
 * @returns the light and dark token maps, alias and static namespaces merged
 *   (a later declaration wins, exactly as the cascade resolves them).
 * @throws when the declared theme package is not installed — a missing palette
 *   must fail loudly, never silently skip the measurement.
 */
export function readPlatformTheme(root = process.cwd()): Theme {
  const declared = /declaredLine:\s*(\S+)/u.exec(
    readFileSync(join(root, 'packages', 'bundle', 'app-harness', 'deployment.yml'), 'utf8'),
  )?.[1]
  if (declared === undefined) throw new Error('deployment.yml carries no platform.declaredLine')
  const store = join(root, 'node_modules', '.pnpm')
  const prefix = `@deepseek-ai+dsh-client-ui-theme@${declared}_`
  const directory = readdirSync(store).find(entry => entry.startsWith(prefix))
  if (directory === undefined) {
    throw new Error(`the platform theme package ${declared} is not installed under ${store} — run: node scripts/deps.mjs`)
  }
  const styles = join(store, directory, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'src', 'styles')
  // The package's own import order: base.css first, design-platform.css later;
  // `declarationsOf` merges matches in order, so the later block wins exactly
  // as the cascade resolves it.
  const css = `${readFileSync(join(styles, 'base.css'), 'utf8')}\n${readFileSync(join(styles, 'design-platform.css'), 'utf8')}`
  return {
    light: declarationsOf(css, 'body'),
    dark: declarationsOf(css, 'body[data-ds-dark-theme]'),
  }
}

/**
 * Resolve one token to its literal value by following `var()` chains.
 * @param theme - one theme's token map.
 * @param name - the token (`--dsw-alias-label-secondary`).
 * @returns the literal value, or undefined when the chain leaves the map or
 *   lands on a computed value (`color-mix()`) this helper does not evaluate.
 */
export function resolveToken(theme: ReadonlyMap<string, string>, name: string): string | undefined {
  const seen = new Set<string>()
  let current = name
  while (!seen.has(current)) {
    seen.add(current)
    const raw = theme.get(current)
    if (raw === undefined) return undefined
    const nested = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/u.exec(raw)
    if (nested !== null) {
      current = nested[1]!
      continue
    }
    // Source-theme values are rgb() literals; the compiled bundle uses hex.
    // Accept both so the reader can measure the declared version's source.
    return /^#[0-9a-fA-F]{3,8}$/u.test(raw) || /^rgba?\(/u.test(raw) ? raw : undefined
  }
  return undefined
}

/** One `#rgb`/`#rrggbb` or opaque `rgb()` colour as its three 0-255 channels. */
function channelsOf(color: string): [number, number, number] {
  if (color.startsWith('rgb')) {
    const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*[\d.]+\s*)?\)$/u.exec(color)
    if (match === null) throw new Error(`unsupported colour literal: ${color}`)
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const body = color.slice(1)
  const full = body.length === 3 ? [...body].map(character => `${character}${character}`).join('') : body
  if (full.length !== 6) throw new Error(`unsupported colour literal: ${color}`)
  return [0, 2, 4].map(at => Number.parseInt(full.slice(at, at + 2), 16)) as [number, number, number]
}

/** WCAG relative luminance of one sRGB colour. */
function luminance(color: string): number {
  const [r, g, b] = channelsOf(color).map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The WCAG 2.x contrast ratio between two literal colours.
 * @param foreground - the text colour.
 * @param background - the surface behind it.
 * @returns the ratio, 1 (identical) to 21 (black on white).
 */
export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/**
 * The declaration body of the rule whose selector list carries an exact
 * selector.
 *
 * Reads the stylesheet SOURCE (a CSS module import yields only the class map),
 * which is the only place the tokens and the pairs they are painted with exist.
 * Filtering by the exact selector is what keeps a conditional rule (`.nav` vs
 * `.nav[data-nav-state='collapsed']`) from answering for the plain one.
 * @param stylesheet - the `.module.css` text.
 * @param selector - the exact selector (`.navRow`, `[data-nav-state='collapsed']`).
 * @returns the rule's declaration body, or undefined when no rule carries it.
 */
export function ruleBody(stylesheet: string, selector: string): string | undefined {
  for (const match of stylesheet.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1]!.split(',').map(candidate => candidate.trim())
    if (selectors.includes(selector)) return match[2]!
  }
  return undefined
}

/**
 * One property inside one declaration body.
 * @param body - a rule body from {@link ruleBody}.
 * @param property - the CSS property (`color`).
 * @returns the declared value, or undefined when the body does not set it.
 */
export function propertyOf(body: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'u').exec(body)
  return match?.[1]?.trim()
}

/**
 * The stylesheet with every at-rule block removed: its DEFAULT (unconditional)
 * rules, which is what a wide pane is painted with.
 * @param stylesheet - the `.module.css` text.
 * @returns the stylesheet's outer rules only (comments dropped).
 */
export function outerRules(stylesheet: string): string {
  const source = stylesheet.replace(/\/\*[\s\S]*?\*\//gu, '')
  let outer = ''
  let at = 0
  while (at < source.length) {
    if (source[at] !== '@') {
      outer += source[at]
      at += 1
      continue
    }
    const open = source.indexOf('{', at)
    if (open < 0) break
    let depth = 0
    let end = open
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    at = end + 1
  }
  return outer
}

/**
 * The body of the first at-rule whose prelude carries a marker.
 * @param stylesheet - the `.module.css` text.
 * @param marker - text the at-rule prelude carries (`(max-width: 640px)`).
 * @returns the at-rule's body text (its nested rules included), or undefined
 *   when no such at-rule exists.
 */
export function atRuleBody(stylesheet: string, marker: string): string | undefined {
  const markerAt = stylesheet.indexOf(marker)
  if (markerAt < 0) return undefined
  const open = stylesheet.indexOf('{', markerAt)
  if (open < 0) return undefined
  let depth = 0
  for (let at = open; at < stylesheet.length; at += 1) {
    if (stylesheet[at] === '{') depth += 1
    else if (stylesheet[at] === '}') {
      depth -= 1
      if (depth === 0) return stylesheet.slice(open + 1, at)
    }
  }
  return undefined
}
