/**
 * Script-plane tests for the deployment descriptor's row algebra
 * (`node --test`, NOT vitest — vitest collects `packages/*​/*​/tests/**` only).
 *
 * The checked-in tree can only exhibit the in-sync case, so every DRIFT rule is
 * exercised with a fixture: a client row with no declared package, a declared
 * package with no row, a fifth application nobody declared, a machinery row
 * missing from either side (arch-review 2026-09-16 AR2 ①⑤).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appPackagesOf, appRosterProblems, appRowPackagesOf, basePackageOf, childRowProblems, clientRosterProblems, clientRowProblems, clientRowsOf, homeFileProblems, insertedRowsOf, isClientRow, machineryRowProblems, machineryRowsOf, patchRowsOf, patchTargetsOf, workspaceFileProblems,
} from '../descriptor-rows.mjs'

/** Run `body` with a fresh temp dir, removed afterwards. */
function withFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-descriptor-rows-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('patch rows parse from both top-level and insert-nested shapes, and only id+name rows count', () => {
  const rows = patchRowsOf([
    '# a comment mentioning - id: not-a-row',
    'rows:',
    "  - id: app-tool-bridge",
    "    name: '@matrix1001/dsh-application-harness-tool-bridge'",
    "  - id: bundle-insert",
    '    insert:',
    "      - id: client-ui-demo",
    "        name: '@matrix1001/dsh-application-harness-demo-view'",
    '  - id: override-only',
    '    disabled: true',
    '',
  ].join('\n'))
  assert.deepEqual(rows, [
    { id: 'app-tool-bridge', name: '@matrix1001/dsh-application-harness-tool-bridge', inserted: false, disabled: false },
    { id: 'client-ui-demo', name: '@matrix1001/dsh-application-harness-demo-view', inserted: true, disabled: false },
  ])
})

test('a patch target is not an inserted row, and a named target keeps its disabled fact', () => {
  const rows = patchRowsOf([
    '# --- managed replacement directives ---',
    "- id: platform-row",
    "  name: '@deepseek-ai/dsh-client-ui-sidebar'",
    '  disabled: true',
    '# --- end managed replacement directives ---',
    '- insert:',
    "    - id: client-demo-row",
    "      name: '@matrix1001/dsh-application-harness-demo'",
    '',
  ].join('\n'))
  assert.deepEqual(rows, [
    { id: 'platform-row', name: '@deepseek-ai/dsh-client-ui-sidebar', inserted: false, disabled: true },
    { id: 'client-demo-row', name: '@matrix1001/dsh-application-harness-demo', inserted: true, disabled: false },
  ])
  assert.deepEqual(patchTargetsOf(rows).map((row) => row.id), ['platform-row'])
  assert.deepEqual(insertedRowsOf(rows).map((row) => row.id), ['client-demo-row'])
})

test('the application roster is derived from dsh.appRow declarations, not from a list', () => {
  withFixture((dir) => {
    const area = join(dir, 'apps')
    const write = (name, manifest) => {
      mkdirSync(join(area, name, 'host'), { recursive: true })
      writeFileSync(join(area, name, 'host', 'package.json'), JSON.stringify(manifest))
    }
    write('beta', { name: '@matrix1001/dsh-application-harness-beta', dsh: { appRow: { id: 'beta', name: '@matrix1001/dsh-application-harness-beta' } } })
    write('alpha', { name: '@matrix1001/dsh-application-harness-alpha', dsh: { appRow: { id: 'alpha', name: '@matrix1001/dsh-application-harness-alpha' } } })
    // A test-only fixture (no appRow) and a directory without a manifest are not applications.
    write('test-only', { name: '@matrix1001/dsh-application-harness-test-only' })
    mkdirSync(join(area, 'empty', 'host'), { recursive: true })
    assert.deepEqual(appPackagesOf(dir).map((app) => app.id), ['alpha', 'beta'])
    assert.equal(appPackagesOf(join(dir, 'nope')).length, 0)
  })
})

test('machinery rows exclude client rows, the derived application rows and patch targets', () => {
  const rows = [
    { id: 'app-tool-bridge', name: '@matrix1001/dsh-application-harness-tool-bridge', inserted: true, disabled: false },
    { id: 'client-applications', name: '@matrix1001/dsh-application-harness-client-applications', inserted: true, disabled: false },
    { id: 'ui-workbook', name: '@matrix1001/dsh-application-harness-workbook-view', inserted: true, disabled: false },
    { id: 'workbook', name: '@matrix1001/dsh-application-harness-workbook', inserted: true, disabled: false },
    // A top-level target mounts nothing of ours: it must not demand a
    // descriptor entry.
    { id: 'platform-row', name: '@deepseek-ai/dsh-client-ui-sidebar', inserted: false, disabled: true },
  ]
  assert.deepEqual(machineryRowsOf(rows, ['workbook']), [{ id: 'app-tool-bridge', name: '@matrix1001/dsh-application-harness-tool-bridge', inserted: true, disabled: false }])
  assert.equal(isClientRow({ id: 'ui-x', name: 'y' }), true)
  assert.equal(isClientRow({ id: 'app-tool-bridge', name: 'y' }), false)
  assert.deepEqual(clientRowsOf(rows).map((row) => row.id), ['client-applications', 'ui-workbook'])
})

test('a client row with no declared package is drift, and so is a declared package with no row (AR2 ①)', () => {
  const clientRows = [
    { id: 'client-applications', name: '@matrix1001/dsh-application-harness-client-applications' },
    { id: 'client-ui-ghost', name: '@matrix1001/dsh-application-harness-ghost-view' },
  ]
  assert.deepEqual(clientRowProblems({ clientRows, clientPackages: ['@matrix1001/dsh-application-harness-client-applications', '@matrix1001/dsh-application-harness-ghost-view'] }), [])
  const undeclaredRow = clientRowProblems({ clientRows, clientPackages: ['@matrix1001/dsh-application-harness-client-applications'] })
  assert.equal(undeclaredRow.length, 1)
  assert.match(undeclaredRow[0], /client-ui-ghost .* is not declared in the descriptor's client\.packages/u)
  const unroutedPackage = clientRowProblems({ clientRows: [clientRows[0]], clientPackages: ['@matrix1001/dsh-application-harness-client-applications', '@matrix1001/dsh-application-harness-orphan-view'] })
  assert.equal(unroutedPackage.length, 1)
  assert.match(unroutedPackage[0], /declared client package @matrix1001\/dsh-application-harness-orphan-view has no bundle-patch row/u)
  assert.equal(basePackageOf('@matrix1001/dsh-application-harness-x'), '@matrix1001/dsh-application-harness-x')
  // Every published subpath folds — the bundle row mounts `…/access`, the
  // package the profile installs is the base (DA2).
  assert.equal(basePackageOf('@matrix1001/dsh-application-harness-store/atomic'), '@matrix1001/dsh-application-harness-store')
})

test('the generated rows are keyed by the declaring package, not by the row id (DA2 scope)', () => {
  withFixture((dir) => {
    const write = (area, name, manifest) => {
      mkdirSync(join(dir, 'packages', area, name), { recursive: true })
      writeFileSync(join(dir, 'packages', area, name, 'package.json'), JSON.stringify(manifest))
    }
    // A client view is as much a generated row as an application, and its row
    // id (`client-ui-demo`) names a different package (`…-demo-view`) — the
    // package is the only reliable key.
    write('client', 'demo-view', { name: '@matrix1001/dsh-application-harness-demo-view', dsh: { appRow: { id: 'client-ui-demo', name: '@matrix1001/dsh-application-harness-demo-view' } } })
    mkdirSync(join(dir, 'apps', 'demo', 'host'), { recursive: true })
    writeFileSync(join(dir, 'apps', 'demo', 'host', 'package.json'), JSON.stringify({ name: '@matrix1001/dsh-application-harness-demo', dsh: { appRow: { id: 'demo', name: '@matrix1001/dsh-application-harness-demo' } } }))
    write('application', 'plain', { name: '@matrix1001/dsh-application-harness-plain' })
    assert.deepEqual(appRowPackagesOf(dir), ['@matrix1001/dsh-application-harness-demo', '@matrix1001/dsh-application-harness-demo-view'])
    assert.deepEqual(appRowPackagesOf(join(dir, 'nope')), [])
  })
})

test('a mounted row the bundle never declares is drift, and so is a child nothing mounts (DA2)', () => {
  const scope = {
    children: ['@matrix1001/dsh-application-harness-http'],
    self: '@matrix1001/dsh-application-harness',
    childPrefix: '@matrix1001/dsh-application-harness-',
    referenced: [],
  }
  const rows = [
    { id: 'app-http', name: '@matrix1001/dsh-application-harness-http' },
    // A row naming the bundle itself is not a child-row drift, and platform
    // rows are rule 2's business (platform pins), not the harness-child rule's.
    { id: 'bundle', name: '@matrix1001/dsh-application-harness' },
    { id: 'app-typert', name: '@deepseek-ai/dsh-typert-protocol' },
  ]
  assert.deepEqual(childRowProblems({ rows, ...scope }), [])
  const undeclared = childRowProblems({ rows, ...scope, children: [] })
  assert.equal(undeclared.length, 1)
  assert.match(undeclared[0], /bundle patch row app-http .* is not declared among the bundle's children/u)
  // The reverse: a child no row mounts and no child requires.
  const orphan = childRowProblems({ rows: [], ...scope, children: ['@matrix1001/dsh-application-harness-context'] })
  assert.equal(orphan.length, 1)
  assert.match(orphan[0], /bundle child @matrix1001\/dsh-application-harness-context is mounted by no bundle-patch row/u)
  // …unless another child requires it: the logical ledger contract every
  // provider implements is a child no row mounts, by design.
  assert.deepEqual(childRowProblems({ rows: [], ...scope, children: ['@matrix1001/dsh-application-harness-context'], referenced: ['@matrix1001/dsh-application-harness-context'] }), [])
})

test('a fifth application nobody declared is drift (AR2 ⑤)', () => {
  const appRows = [
    { id: 'workbook', name: '@matrix1001/dsh-application-harness-workbook' },
    { id: 'fifth', name: '@matrix1001/dsh-application-harness-fifth' },
  ]
  const declaredApps = [{ id: 'workbook', name: '@matrix1001/dsh-application-harness-workbook' }]
  const problems = appRosterProblems({ appRows, declaredApps })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /package appRow fifth .* is not declared in the deployment descriptor/u)
  // The reverse direction adds its own finding on top (the undeclared `fifth`).
  const reverse = appRosterProblems({ appRows, declaredApps: [...declaredApps, { id: 'ghost', name: '@matrix1001/dsh-application-harness-ghost' }] })
  assert.equal(reverse.length, 2)
  assert.match(reverse.join('\n'), /declared application ghost .* does not match any package dsh\.appRow/u)
  assert.deepEqual(appRosterProblems({ appRows, declaredApps: appRows }), [])
})

test('the declared client roster and the packages declaring dsh.client must agree (client-roster-not-derived)', () => {
  const derived = ['@matrix1001/dsh-application-harness-client-applications', '@matrix1001/dsh-application-harness-client-panel']
  assert.deepEqual(clientRosterProblems({ declared: derived, derived }), [])
  const undeclared = clientRosterProblems({ declared: [derived[0]], derived })
  assert.equal(undeclared.length, 1)
  assert.match(undeclared[0], /application-harness-client-panel declares a dsh\.client face but is not in the descriptor/u)
  const stale = clientRosterProblems({ declared: [...derived, '@matrix1001/dsh-application-harness-client-ghost'], derived })
  assert.equal(stale.length, 1)
  assert.match(stale[0], /declared client package @matrix1001\/dsh-application-harness-client-ghost does not declare a dsh\.client face/u)
})

test('home files and the compositions that bind them must name each other (AR2 ⑧)', () => {
  const patch = "      config:\n        accessPath: !!js dshHomePath('application-harness/access.json')"
  const homeFiles = [{ path: "dshHomePath('application-harness/access.json')" }, { path: "dshHomePath('application-harness/store.json')" }]
  // The store is declared but nothing binds it — a stale declaration.
  const stale = homeFileProblems({ homeFiles, sources: [patch] })
  assert.equal(stale.length, 1)
  assert.match(stale[0], /home file dshHomePath\('application-harness\/store\.json'\) is not declared by any composition/u)
  // …and a bound path the descriptor never declares is the mirror (the state the
  // home half sat in before this rule existed).
  const undeclared = homeFileProblems({ homeFiles: [homeFiles[0]], sources: [patch, "persistPath: !!js dshHomePath('application-harness/background.json')"] })
  assert.equal(undeclared.length, 1)
  assert.match(undeclared[0], /dshHomePath\('application-harness\/background\.json'\) is bound by a composition but not declared/u)
  // A path outside the harness-home convention, or one written in any other
  // shape, is not a home file declaration at all.
  const malformed = homeFileProblems({ homeFiles: [{ path: "dshHomePath('elsewhere/store.json')" }, { path: '${cwd}/store.json' }], sources: [] })
  assert.equal(malformed.length, 2)
  assert.match(malformed[0], /is not a dshHomePath\('application-harness\/<file>'\) path/u)
  assert.deepEqual(homeFileProblems({ homeFiles, sources: [patch, "persistPath: !!js dshHomePath('application-harness/store.json')"] }), [])
})

test('workspace files and the compositions that bind them must name each other (WP6)', () => {
  // The shapes the composition really writes: the bundle patch's key lines, and
  // an app-row config value — which arrives DECODED from package.json, so it
  // carries no YAML key and no escaping, just the same template in the same
  // `!!js` wrapper.
  const ledger = '        path: !!js "`${process.cwd()}/.dsh-applications/notes.jsonl`"'
  const checkpoint = '        cachePath: !!js "`${process.cwd()}/.dsh-applications/filters.json`"'
  const workbook = '        workbookPath: !!js "`${process.cwd()}/.dsh-applications/workbook.json`"'
  const appRowWorkbook = '!!js "`${process.cwd()}/.dsh-applications/workbook.json`"'
  // The descriptor's own spelling: `${cwd}/…`, one key per file.
  const workspaceFiles = [
    { path: '${cwd}/.dsh-applications/notes.jsonl' },
    { path: '${cwd}/.dsh-applications/filters.json' },
    { path: '${cwd}/.dsh-applications/workbook.json' },
  ]
  // Both directions agree; workbook.json is bound twice (patch row + app-row
  // value) and is still one declaration, not a finding of its own.
  assert.deepEqual(workspaceFileProblems({ workspaceFiles, sources: [[ledger, checkpoint, workbook].join('\n'), appRowWorkbook] }), [])
  // Declared but bound by nothing: the direction that predates the reverse one.
  // Both PRE-EXISTING messages are asserted WHOLE, rendering included — the
  // constraint that their wording must not change is only real if a change
  // fails here (downstream may look for them by string).
  const unbound = workspaceFileProblems({ workspaceFiles, sources: [[ledger, checkpoint].join('\n')] })
  assert.deepEqual(unbound, ['workspace file ${cwd}/.dsh-applications/workbook.json is not declared as a ${cwd}-relative path by any composition row or dsh.appRow config (a basename-only match does not count)'])

  // Bound by a composition but declared by nothing — the half that did not
  // exist before 2026-09-22. One finding per binding (the patch binds
  // workbook.json and so does the app-row value: two texts, two findings),
  // each naming the text a reader has to find.
  const boundOnly = workspaceFileProblems({ workspaceFiles: [], sources: [[ledger, checkpoint, workbook].join('\n'), appRowWorkbook] })
  assert.deepEqual(boundOnly, [
    '${process.cwd()}/.dsh-applications/notes.jsonl is bound by a composition but not declared in the descriptor\'s workspaceFiles',
    '${process.cwd()}/.dsh-applications/filters.json is bound by a composition but not declared in the descriptor\'s workspaceFiles',
    '${process.cwd()}/.dsh-applications/workbook.json is bound by a composition but not declared in the descriptor\'s workspaceFiles',
    '${process.cwd()}/.dsh-applications/workbook.json is bound by a composition but not declared in the descriptor\'s workspaceFiles',
  ])

  // A malformed entry (a home path, a bare basename, an empty string, no
  // `path`) is reported and does NOT enter the declared set: the reverse
  // direction must not read a shape it cannot verify as a declaration.
  const malformed = workspaceFileProblems({
    workspaceFiles: [{ path: "dshHomePath('application-harness/store.json')" }, { path: 'notes.jsonl' }, { path: '' }, {}],
    sources: [],
  })
  assert.deepEqual(malformed, [
    'workspaceFiles entry "dshHomePath(\'application-harness/store.json\')" is not a ${cwd}/<relative> path',
    'workspaceFiles entry "notes.jsonl" is not a ${cwd}/<relative> path',
    'workspaceFiles entry "" is not a ${cwd}/<relative> path',
    'workspaceFiles entry undefined is not a ${cwd}/<relative> path',
  ])
  const bareBasename = workspaceFileProblems({ workspaceFiles: [{ path: 'notes.jsonl' }], sources: ['        path: !!js "`${process.cwd()}/notes.jsonl`"'] })
  assert.deepEqual(bareBasename, [
    'workspaceFiles entry "notes.jsonl" is not a ${cwd}/<relative> path',
    '${process.cwd()}/notes.jsonl is bound by a composition but not declared in the descriptor\'s workspaceFiles',
  ])

  // A reverse match ends with its own field — the closing backtick of the
  // template literal — and does not run into the next one.
  const paired = workspaceFileProblems({ workspaceFiles: [{ path: '${cwd}/a.json' }], sources: ['    path: !!js "`${process.cwd()}/a.json`", other: !!js "`${process.cwd()}/b.json`"'] })
  assert.deepEqual(paired, ['${process.cwd()}/b.json is bound by a composition but not declared in the descriptor\'s workspaceFiles'])

  // The 2026-09-15 judgment (data-path-location-ungated) survives: a line under
  // `${process.cwd()}` naming only the basename is not a binding…
  const basenameOnly = workspaceFileProblems({ workspaceFiles: [workspaceFiles[0]], sources: ['        path: !!js "`${process.cwd()}/notes.jsonl`"'] })
  assert.deepEqual(basenameOnly, [
    'workspace file ${cwd}/.dsh-applications/notes.jsonl is not declared as a ${cwd}-relative path by any composition row or dsh.appRow config (a basename-only match does not count)',
    '${process.cwd()}/notes.jsonl is bound by a composition but not declared in the descriptor\'s workspaceFiles',
  ])
  // …and neither is the full relative path without the cwd expression (what a
  // file moved out of the workspace, to `dshHomePath`, looks like).
  const withoutCwd = workspaceFileProblems({ workspaceFiles: [workspaceFiles[0]], sources: ["        path: !!js dshHomePath('application-harness/.dsh-applications/notes.jsonl')"] })
  assert.deepEqual(withoutCwd, ['workspace file ${cwd}/.dsh-applications/notes.jsonl is not declared as a ${cwd}-relative path by any composition row or dsh.appRow config (a basename-only match does not count)'])
})

test('machinery rows and declared services must name each other', () => {
  const machineryRows = [{ id: 'app-tool-bridge', name: '@matrix1001/dsh-application-harness-tool-bridge' }]
  assert.deepEqual(machineryRowProblems({ machineryRows, declaredRows: machineryRows }), [])
  const missingRow = machineryRowProblems({ machineryRows, declaredRows: [{ id: 'app-store', name: '@matrix1001/dsh-application-harness-store' }] })
  assert.equal(missingRow.length, 2)
  assert.match(missingRow.join('\n'), /declared service row app-store .* is not in the bundle patch/u)
  assert.match(missingRow.join('\n'), /bundle patch row app-tool-bridge .* is not declared in the deployment descriptor/u)
})
