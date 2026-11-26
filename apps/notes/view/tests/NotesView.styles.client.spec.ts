/**
 * The notes page's container-query geometry, read out of the stylesheet
 * because jsdom computes no layout:
 *
 * - the full layout is the 160px tag rail, the 320px list and the editor;
 * - the medium layout (720–1040px) keeps a 150px rail — the page's only tag
 *   filter — beside a 300px list, and lets the editor shrink with `minmax(0,
 *   1fr)` instead of forcing horizontal overflow;
 * - only the narrow layout (≤720px) drops the rail and switches to one pane.
 *
 * The regression this guards: two rules at the same 1040px breakpoint sized
 * the rail and then immediately hid it, so the rail never appeared.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'NotesView.module.css'),
  'utf8',
)

/** One `@container` query's source, from its marker to the next query or the end. */
function containerBlock(maxWidth: number): string {
  const marker = `@container (max-width: ${String(maxWidth)}px)`
  const start = source.indexOf(marker)
  expect(start, marker).toBeGreaterThanOrEqual(0)
  const next = source.indexOf('@container', start + marker.length)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('the notes page container queries', () => {
  it('keeps the 150px tag rail at medium widths', () => {
    const medium = containerBlock(1040)
    expect(medium).toContain('grid-template-columns: 150px 300px minmax(0, 1fr)')
    // The editor column may shrink; a fixed third column would overflow.
    expect(medium).toContain('minmax(0, 1fr)')
    // The dead rule hid the rail at the same breakpoint that sized it.
    expect(medium).not.toMatch(/\.rail\s*\{[^}]*display:\s*none/u)
  })

  it('drops the rail and the pane split only in the narrow layout', () => {
    const narrow = containerBlock(720)
    expect(narrow).toMatch(/\.rail\s*\{[^}]*display:\s*none/u)
    // ≤720px is the single list/detail page; the first-note budget rules from
    // the narrow block are still in force.
    expect(narrow).toContain('.workspace { display: block; position: relative; }')
    expect(narrow).toContain('.listSub { display: none; }')
    expect(narrow).toContain('.hideNarrow { display: none; }')
  })
})
