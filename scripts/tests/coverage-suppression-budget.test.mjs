import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGES = join(ROOT, 'packages')
/** The reviewed ceiling: every new suppression needs a budget change and a reason.
 * Raised 120 → 123 for the review-plan editor's UI-only guards (a checkbox
 * path that cannot be reached without a rendered plan, and the disabled Save
 * control), 124 for the on-disk store's always-present byte size, and 125 for
 * the import-confirm guard (the control renders only after a preview), and
 * 126 for a file vanishing between a walk and its candidate stat, and 190 for
 * the eight new application surfaces (calendar, inbox, usage, disk-space,
 * git-browser, workspace-review, notes and tasks editors): their defensive
 * malformed-input/UI-only branches are marked in place, while line/function
 * coverage stays at 100%. */
const BUDGET = 190

/** Every source file under packages/, skipping build output and dependencies. */
function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lib' || name === 'dist') continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...sources(path))
    else if (/\.(?:ts|tsx)$/u.test(name)) out.push(path)
  }
  return out
}

test('coverage suppressions stay inside the reviewed budget', () => {
  let count = 0
  const hotspots = []
  for (const path of sources(PACKAGES)) {
    const text = readFileSync(path, 'utf8')
    const hits = (text.match(/\/\*\s*(?:v8|c8) ignore/gu) ?? []).length
    if (hits > 0) hotspots.push(`${path.slice(ROOT.length + 1)}:${String(hits)}`)
    count += hits
  }
  assert.ok(count <= BUDGET, `coverage suppressions grew to ${String(count)} (budget ${String(BUDGET)}):\n${hotspots.join('\n')}`)
})
