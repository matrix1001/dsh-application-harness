#!/usr/bin/env node
/**
 * The layout budget, as numbers instead of adjectives.
 *
 * Why this exists: the layout review could only say "the first entry is too far
 * down" because nobody measured it. Every claim that survives as a rule needs a
 * number here — otherwise the next feature adds one more row above the content
 * and nobody notices.
 *
 * The module is PURE on purpose: a geometry sample is `{ app, viewport, values }`
 * and the verdict is arithmetic. The browser lane owns the measuring, so these
 * thresholds can be tested without a host, a browser, or a build.
 *
 * Thresholds (decision G7 / S1):
 * - the first data row starts at most 200 CSS px from the top of the window on
 *   a desktop viewport, 260 on a narrow one (a phone stacks the same two chrome
 *   rows into a taller strip);
 * - the shell supplies the page inset: 24px inline on desktop, 16px narrow.
 * @module
 */

/** The agreed thresholds, in CSS px. */
export const LAYOUT_BUDGET = Object.freeze({
  firstContent: Object.freeze({ desktop: 200, narrow: 260 }),
  pageInline: Object.freeze({ desktop: 24, narrow: 16 }),
  /** The window widths the two classes of viewport start at. */
  narrowBelow: 720,
})

/**
 * Which budget row a viewport belongs to.
 * @param width - the window width in CSS px.
 * @returns `narrow` below 720, `desktop` otherwise.
 */
export function viewportClassOf(width) {
  return width < LAYOUT_BUDGET.narrowBelow ? 'narrow' : 'desktop'
}

/**
 * Judge one application's measured geometry against the budget.
 * @param sample - `{ app, viewport, firstContentY, pageInline }`; either value
 * may be undefined when the page did not render (that is a failure, not a skip).
 * @returns `{ app, viewport, ok, findings }` — one finding per broken rule.
 */
export function judgeLayout(sample) {
  const kind = viewportClassOf(sample.viewport)
  const findings = []
  const maxY = LAYOUT_BUDGET.firstContent[kind]
  const inline = LAYOUT_BUDGET.pageInline[kind]
  if (sample.firstContentY === undefined) {
    findings.push(`${sample.app}@${sample.viewport}: no first content row (nothing measured)`)
  } else if (sample.firstContentY > maxY) {
    findings.push(`${sample.app}@${sample.viewport}: first content at ${sample.firstContentY}px, budget ${maxY}px`)
  }
  if (sample.pageInline === undefined) {
    findings.push(`${sample.app}@${sample.viewport}: no page inset measured`)
  } else if (sample.pageInline !== inline) {
    findings.push(`${sample.app}@${sample.viewport}: page inset ${sample.pageInline}px, expected ${inline}px`)
  }
  return { app: sample.app, viewport: sample.viewport, ok: findings.length === 0, findings }
}

/**
 * Judge a whole matrix.
 * @param samples - one sample per application and viewport.
 * @returns `{ ok, results }`.
 */
export function judgeMatrix(samples) {
  const results = samples.map(judgeLayout)
  return { ok: results.every(result => result.ok), results }
}

/**
 * Group a font-size histogram by the seven scale roles.
 * @param entries - `{ size, count }` pairs, any order.
 * @returns `{ withinScale, offScale, total }` where `withinScale` maps a role to
 * its count and `offScale` lists the sizes that are not tokens.
 */
export function summarizeFonts(entries) {
  const roles = new Map([
    [11, 'caption'], [12, 'meta'], [13, 'body'], [15, 'subtitle'], [17, 'heading'], [20, 'title'], [24, 'display'],
  ])
  const withinScale = {}
  const offScale = []
  let total = 0
  for (const { size, count } of entries) {
    total += count
    const role = roles.get(size)
    if (role === undefined) offScale.push({ size, count })
    else withinScale[role] = (withinScale[role] ?? 0) + count
  }
  return { withinScale, offScale, total }
}
