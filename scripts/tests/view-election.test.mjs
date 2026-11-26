/**
 * Script-plane tests for the world views' election literals (`node --test`, NOT
 * vitest — vitest collects `packages/*​/*​/tests/**` only).
 *
 * Each view package registers its page into the applications shell's
 * `applicationViews` registry for ONE application, named by a HAND-WRITTEN
 * `APP_ID` literal in its `src/client/index.ts`. Nothing else in the package
 * ties that literal back to the row: a typo (or a view copied from another one
 * and not re-pointed) makes the view silently never appear — no error, no empty
 * state, the shell just keeps rendering the generic call form — and two views
 * electing the same id would race for the same page (arch-review 2026-09-20,
 * `view-selector-literal-ungated`).
 *
 * The expected id is triple-declared and must agree: the row id names it
 * (`client-ui-<appId>`), the row's `appId` field states it, and some package's
 * `dsh.appRow.id` declares it as an application.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { appHostDirs, appViewDirs } from '../package-areas.mjs'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The appId one view source elects (the `const APP_ID = '<id>'` literal). */
export function electedAppId(source) {
  return /^const APP_ID = '([^']+)'$/mu.exec(source)?.[1]
}

/** Every view package: its name, declared row, and the appId its source elects. */
function viewPackages() {
  const views = []
  for (const dir of appViewDirs(ROOT)) {
    const manifestPath = join(dir, 'package.json')
    const sourcePath = join(dir, 'src/client/index.ts')
    if (!existsSync(manifestPath) || !existsSync(sourcePath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const row = manifest.dsh?.appRow
    if (typeof row?.id !== 'string' || !row.id.startsWith('client-ui-')) continue
    views.push({ dir, name: manifest.name, rowId: row.id, rowAppId: row.appId, elected: electedAppId(readFileSync(sourcePath, 'utf8')) })
  }
  return views
}

/** Every declared application id (`apps/<app>/host`'s `dsh.appRow.id`). */
function applicationIds() {
  const ids = new Set()
  for (const dir of appHostDirs(ROOT)) {
    const row = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh?.appRow
    if (typeof row?.id === 'string') ids.add(row.id)
  }
  return ids
}

test('every view elects exactly the application its row id names, and no two views claim one', () => {
  const views = viewPackages()
  const apps = applicationIds()
  assert.ok(views.length >= 4, `expected the four world views, found ${String(views.length)}`)
  const claimed = new Map()
  for (const view of views) {
    const expected = view.rowId.replace(/^client-ui-/u, '')
    assert.equal(view.rowAppId, expected, `${view.name}'s row declares appId ${JSON.stringify(view.rowAppId)}, its row id ${view.rowId} names ${JSON.stringify(expected)}`)
    assert.equal(view.elected, expected, `${view.name} elects ${JSON.stringify(view.elected)}, its row ${view.rowId} names ${JSON.stringify(expected)}`)
    assert.ok(apps.has(expected), `${view.name} elects ${expected}, which no package's dsh.appRow declares as an application`)
    const other = claimed.get(expected)
    assert.equal(other, undefined, `${view.name} and ${other} both elect ${expected}`)
    claimed.set(expected, view.name)
  }
  // The fixtures the rule is written for: a re-pointed literal and a missing one.
  assert.equal(electedAppId("const APP_ID = 'other'\n"), 'other')
  assert.equal(electedAppId('const x = 1\n'), undefined)
  assert.equal(electedAppId("const OTHER_APP_ID = 'x'\nconst APP_ID = 'y'\n"), 'y')
})
