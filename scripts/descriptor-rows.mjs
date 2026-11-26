#!/usr/bin/env node
/**
 * The deployment descriptor's **row algebra**: parse the bundle patch's rows,
 * derive the workspace's real application roster, and compare each declared
 * set against the rows/declarations that implement it.
 *
 * It exists as its own module (not inline in `verify-deployment-descriptor.mjs`)
 * so the script-plane tests under `scripts/tests/` can drive every comparison
 * with fixtures — including the negative ones (a client row with no declared
 * package, a declared package with no row, a fifth application nobody
 * declared) that the checked-in tree can never exhibit.
 *
 * The split of concerns: the descriptor DECLARES, the bundle patch and each
 * package's `dsh.appRow` IMPLEMENT, and this module owns the comparison rules
 * between them. Every rule is bidirectional — a set that exists on only one
 * side is drift, in whichever direction (arch-review 2026-09-16 AR2 ①⑤).
 * @module
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { appHostDirs, packageDirs } from './package-areas.mjs'

/** Where the host application packages live (each declaring its own `dsh.appRow`). */
export const APP_PACKAGE_AREA = 'apps'

/**
 * Parse the `id` + `name` rows out of a cordis patch, keeping the structural
 * fact that decides what a row MEANS. The matcher stays deliberately narrow —
 * an `id` line immediately followed by its quoted `name`, with the row's own
 * block (to the next line at the same or a shallower indent) captured beside
 * it — because that is the shape `generate-bundle-patch.mjs` emits and the
 * shape the descriptor's `services`/`applications` entries mirror; a row that
 * only overrides an existing one (no `name`) adds no package and is not a row
 * here.
 *
 * `inserted` is not a style detail: a row nested under `insert:` MOUNTS a new
 * plugin, while a top-level row TARGETS an existing one (a platform row this
 * deployment disables or reconfigures). Treating the second as a mounted
 * package would demand a descriptor entry for a row we do not own; treating
 * the first as a target would hide a row nothing declares.
 * @param {string} patchText - the patch file's text.
 * @returns {Array<{ id: string, name: string, inserted: boolean, disabled: boolean }>} the rows, in file order.
 */
export function patchRowsOf(patchText) {
  const rows = []
  let insertIndent = -1
  const lines = patchText.split('\n')
  for (const [index, line] of lines.entries()) {
    const insert = /^(\s*)-?\s*insert:\s*$/u.exec(line)
    if (insert !== null) {
      insertIndent = insert[1].length
      continue
    }
    const match = /^(\s*)- id: ([^\s]+)\s*$/u.exec(line)
    if (match === null) continue
    const indent = match[1].length
    const next = lines[index + 1] ?? ''
    const named = /^\s+name: '([^']+)'\s*$/u.exec(next)
    if (named === null) continue
    // The row's own block: every following line indented DEEPER than its
    // `- id:` line (a `disabled:`/`config:` of THIS row, never the next row's).
    // Blank lines belong to it; a sibling row's `- id:` is at the same indent
    // and ends it.
    const block = []
    for (const following of lines.slice(index + 1)) {
      if (following.trim() === '') { block.push(following); continue }
      if (following.length - following.trimStart().length <= indent) break
      block.push(following)
    }
    rows.push({
      id: match[2],
      name: named[1],
      inserted: insertIndent >= 0 && indent > insertIndent,
      disabled: /^\s+disabled:\s*true\s*$/mu.test(block.join('\n')),
    })
  }
  return rows
}

/** The rows a patch MOUNTS (the ones nested under its `insert:` list). */
export function insertedRowsOf(patchRows) {
  return patchRows.filter((row) => row.inserted)
}

/** The rows a patch TARGETS (top-level overrides of rows another layer mounted). */
export function patchTargetsOf(patchRows) {
  return patchRows.filter((row) => !row.inserted)
}

/**
 * The workspace's REAL application roster: every `apps/<app>/host` package
 * that declares a `dsh.appRow`. Deriving it (instead of listing the known
 * appids) is what makes a fifth application enter the descriptor comparison
 * the moment it is wired — a hardcoded list silently excludes it (AR2 ⑤).
 * A test-only fixture package declares no `dsh.appRow` and is therefore not an
 * application by construction, not by an exclusion list.
 * @param {string} root - the repository root.
 * @returns {Array<{ id: string, name: string, dir: string }>} the roster, sorted by id.
 */
export function appPackagesOf(root) {
  const apps = []
  for (const dir of appHostDirs(root)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const row = manifest.dsh?.appRow
    if (row === undefined || typeof row.id !== 'string' || typeof row.name !== 'string') continue
    apps.push({ id: row.id, name: row.name, dir: relative(root, dir) })
  }
  return apps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Every package in the workspace that declares a `dsh.appRow` — applications and
 * client views alike. `generate-bundle-patch.mjs` emits those rows from the
 * declarations, so the deployment descriptor is their single declaration and
 * the bundle-manifest rules leave them to it (keyed by PACKAGE: a row's id is
 * not a reliable key — the row `client-ui-disk-analysis` mounts
 * `@matrix1001/dsh-application-harness-disk-analysis-view`, a different name).
 * @param {string} root - the repository root.
 * @returns {string[]} the declaring packages' names, sorted.
 */
export function appRowPackagesOf(root) {
  const names = []
  for (const dir of packageDirs(root)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest.name === 'string' && manifest.dsh?.appRow !== undefined) names.push(manifest.name)
  }
  return names.sort()
}

/** Whether a patch row is a client-plugin row (the machinery rows' complement). */
export function isClientRow(row) {
  return row.id.startsWith('client-') || row.id.startsWith('ui-')
}

/** The client-plugin rows a patch MOUNTS (the client machinery rows and the view rows, companions included). */
export function clientRowsOf(patchRows) {
  return insertedRowsOf(patchRows).filter(isClientRow)
}

/**
 * The MACHINERY rows: the descriptor's `services` set. Client rows are covered
 * by `client.packages` and application rows by `applications`, so they are
 * excluded here — each set has exactly one declaration and one comparison.
 * @param {Array<{ id: string, name: string }>} patchRows - the parsed rows.
 * @param {string[]} appIds - the derived application roster's ids.
 * @returns {Array<{ id: string, name: string }>} the machinery rows.
 */
export function machineryRowsOf(patchRows, appIds) {
  const appSet = new Set(appIds)
  return insertedRowsOf(patchRows).filter((row) => {
    if (isClientRow(row)) return false
    return !appSet.has(row.id)
  })
}

/**
 * The package a row's `name` resolves to: a published subpath —
 * `@scope/pkg/access` — folds onto its base package (the profile installs the
 * package, not the subpath).
 */
export function basePackageOf(name) {
  const [scope, pkg] = name.split('/')
  return scope === undefined || pkg === undefined ? name : `${scope}/${pkg}`
}

/**
 * The client-plugin rows ↔ `descriptor.client.packages`, both directions. The
 * client side used to be one-directional (declared → package exists on disk),
 * which left two blind spots: a patch row naming an undeclared package, and a
 * declared package that no row mounts — "the declared set is the real
 * composition" only held for the host machinery rows (AR2 ①).
 * @param {{ clientRows: Array<{ id: string, name: string }>, clientPackages: string[] }} sets - the patch's client rows and the declared client packages.
 * @returns {string[]} one problem per drift (empty = in sync).
 */
export function clientRowProblems({ clientRows, clientPackages }) {
  const declared = new Set(clientPackages)
  const problems = []
  for (const row of clientRows) {
    const target = basePackageOf(row.name)
    if (!declared.has(target)) {
      problems.push(`bundle patch row ${row.id} (${row.name}) is not declared in the descriptor's client.packages`)
    }
  }
  for (const pkg of clientPackages) {
    if (!clientRows.some((row) => basePackageOf(row.name) === pkg)) {
      problems.push(`declared client package ${pkg} has no bundle-patch row mounting it`)
    }
  }
  return problems
}

/**
 * The application roster ↔ `descriptor.applications`, both directions. Both
 * sides are derived from real declarations (the packages' `dsh.appRow` and the
 * descriptor's list), so a newly wired application is compared by existing.
 * @param {{ appRows: Array<{ id: string, name: string }>, declaredApps: Array<{ id: string, name: string }> }} sets - the derived roster and the declared applications.
 * @returns {string[]} one problem per drift (empty = in sync).
 */
export function appRosterProblems({ appRows, declaredApps, retired = [] }) {
  const problems = []
  for (const row of appRows) {
    if (retired.includes(row.name)) continue
    if (!declaredApps.some((declared) => declared.id === row.id && declared.name === row.name)) {
      problems.push(`package appRow ${row.id} (${row.name}) is not declared in the deployment descriptor`)
    }
  }
  for (const declared of declaredApps) {
    if (!appRows.some((row) => row.id === declared.id && row.name === declared.name)) {
      problems.push(`declared application ${declared.id} (${declared.name}) does not match any package dsh.appRow`)
    }
  }
  return problems
}

/**
 * The bundle patch's rows ↔ the bundle manifest's children, both directions.
 *
 * The rows MOUNT what the manifest DECLARES: a row naming a harness package the
 * bundle never declares resolves through the workspace only, and the day its
 * `workspace:*` turns into a registry range the row is unmountable — the one
 * direction nothing else covered (arch-review 2026-09-19; the DA2 finding: the
 * `app-health` row was mounted while `@matrix1001/dsh-application-harness-health` sat in
 * neither `peerDependencies` nor `devDependencies`). The reverse direction is
 * "a child nothing mounts and no other child requires".
 *
 * Scope: the rows the bundle manifest owns — the machinery rows and the client
 * rows. The generated application/view rows are declared by the deployment
 * descriptor instead, so `verify-deployment-descriptor.mjs` compares those (each
 * set has exactly one declaration and one comparison). Platform rows
 * (`@deepseek-ai/dsh-*`) and a row naming the bundle itself are outside a rule
 * about harness children.
 * @param {{ rows: Array<{ id: string, name: string }>, children: string[], self: string, childPrefix: string, referenced: string[] }} sets - the mounted rows (machinery + client), the bundle's child peers, the bundle's own package name, the harness package-name prefix, and the children some other child declares as a peer.
 * @returns {string[]} one problem per drift (empty = in sync).
 */
export function childRowProblems({ rows, children, self, childPrefix, referenced }) {
  const problems = []
  const childSet = new Set(children)
  for (const row of rows) {
    const pkg = basePackageOf(row.name)
    if (pkg === self || !pkg.startsWith(childPrefix) || childSet.has(pkg)) continue
    problems.push(`bundle patch row ${row.id} (${row.name}) is not declared among the bundle's children (add "${pkg}" to its peerDependencies)`)
  }
  const referencedSet = new Set(referenced)
  for (const child of children) {
    if (rows.some((row) => basePackageOf(row.name) === child) || referencedSet.has(child)) continue
    problems.push(`bundle child ${child} is mounted by no bundle-patch row and required by no other child (remove it or mount it)`)
  }
  return problems
}

/**
 * The home-bound data files ↔ the compositions that declare them, both
 * directions (arch-review 2026-09-16 ⑧, landed 2026-09-20).
 *
 * A harness-home file is declared as an exact `dshHomePath('application-harness/…')`
 * expression — the same literal text the row's `config` carries, because the
 * `!!js` expression is never evaluated in a static check and the text is the
 * only evidence (the workspace-file sibling has the same rule with `${cwd}`).
 * Both directions matter: a declared file no composition names is a stale
 * declaration, and a `dshHomePath` path no declaration names is an undeclared
 * data location — the state the home half sat in until this rule existed.
 * @param {{ homeFiles: Array<{ path?: string }>, sources: string[] }} sets - the descriptor's `homeFiles` entries and the texts to find declarations in (the bundle patch, the app-row configs).
 * @returns {string[]} one problem per drift (empty = in sync).
 */
export function homeFileProblems({ homeFiles, sources }) {
  const problems = []
  const declared = new Set()
  for (const file of homeFiles) {
    const literal = typeof file?.path === 'string' ? file.path : undefined
    if (literal === undefined || !/^dshHomePath\('application-harness\/[^']+'\)$/u.test(literal)) {
      problems.push(`homeFiles entry ${JSON.stringify(file?.path)} is not a dshHomePath('application-harness/<file>') path`)
      continue
    }
    declared.add(literal)
    if (!sources.some((text) => text.includes(literal))) {
      problems.push(`home file ${literal} is not declared by any composition row or dsh.appRow config`)
    }
  }
  for (const source of sources) {
    for (const match of source.matchAll(/dshHomePath\('([^']+)'\)/gu)) {
      const literal = `dshHomePath('${match[1]}')`
      if (!declared.has(literal)) problems.push(`${literal} is bound by a composition but not declared in the descriptor's homeFiles`)
    }
  }
  return problems
}

/**
 * The workspace-bound data files ↔ the compositions that bind them, both
 * directions (arch-review 2026-09-16 ⑧: the home half landed 2026-09-20, this
 * half's reverse direction 2026-09-22).
 *
 * The two sides spell one location differently on purpose: the descriptor
 * declares `${cwd}/<relative>` (its own vocabulary), the composition binds
 * `` `${process.cwd()}/<relative>` ``, so both normalize to the same
 * `<relative>` key here — neither spelling gets a rule of its own.
 *
 * The `!!js` expression is never evaluated in a static check, so the literal
 * text is the only evidence — the same premise as `homeFileProblems`, the home
 * half of this declaration. The two directions are NOT the same text test:
 * - forward — does a composition name the declared relative path AND
 *   `process.cwd()` on the SAME line? A basename-only match must not count, or
 *   the gate stays green after the file moved out of the workspace (to
 *   `dshHomePath`, say): arch-review 2026-09-15, data-path-location-ungated;
 * - reverse — is every `${process.cwd()}/<relative>` the composition binds
 *   declared below? Without it a composition that binds a workspace path nobody
 *   declared stays invisible (the gap until 2026-09-22: the three files bound
 *   today were all declared too, so the missing direction was latent).
 * @param {{ workspaceFiles: Array<{ path?: string }>, sources: string[] }} sets - the descriptor's `workspaceFiles` entries and the texts to find bindings in (the bundle patch, the app-row configs).
 * @returns {string[]} one problem per drift (empty = in sync).
 */
export function workspaceFileProblems({ workspaceFiles, sources }) {
  const problems = []
  const declared = new Set()
  for (const file of workspaceFiles) {
    const literal = typeof file?.path === 'string' ? file.path : undefined
    const relative = typeof literal === 'string' ? literal.replace(/^\$\{cwd\}\//u, '') : undefined
    // A malformed entry (a dshHomePath(...), a bare basename, an empty string,
    // no `path` at all) is reported and deliberately NOT declared: the reverse
    // direction must not read a shape it cannot verify as a declaration.
    if (typeof relative !== 'string' || relative.length === 0 || relative === literal) {
      problems.push(`workspaceFiles entry ${JSON.stringify(file?.path)} is not a \${cwd}/<relative> path`)
      continue
    }
    declared.add(relative)
    if (!sources.some((text) => text.split('\n').some((line) => line.includes(relative) && line.includes('process.cwd()')))) {
      problems.push(`workspace file ${literal} is not declared as a \${cwd}-relative path by any composition row or dsh.appRow config (a basename-only match does not count)`)
    }
  }
  for (const source of sources) {
    // The bindings end where the JS string literal ends (backtick/quote), at
    // whitespace, or at a backslash escape — a match never runs past its own
    // field into the next one.
    for (const match of source.matchAll(/\$\{process\.cwd\(\)\}\/([^\s`"'\\]+)/gu)) {
      if (!declared.has(match[1])) problems.push(`${match[0]} is bound by a composition but not declared in the descriptor's workspaceFiles`)
    }
  }
  return problems
}

/**
 * The declared client roster ↔ the packages that actually declare `dsh.client`,
 * both directions (arch-review 2026-09-20, `client-roster-not-derived`).
 *
 * `descriptor.client.packages` was a hand-written list compared only against the
 * patch's client rows (which are themselves generated) — a client package that
 * nobody added to the declaration, or a declared name whose package stopped
 * declaring `dsh.client`, was invisible. The packages' own declarations are the
 * derivation source here, exactly as `dsh.appRow` is for the application roster.
 * @param {{ declared: string[], derived: string[] }} sets - the descriptor's `client.packages` and the workspace packages declaring a `dsh.client` face.
 * @returns {string[]} one problem per drift (empty = in sync).
 */
export function clientRosterProblems({ declared, derived, retired = [] }) {
  const problems = []
  for (const name of derived) {
    if (retired.includes(name)) continue
    if (!declared.includes(name)) {
      problems.push(`package ${name} declares a dsh.client face but is not in the descriptor's client.packages`)
    }
  }
  for (const name of declared) {
    if (!derived.includes(name)) {
      problems.push(`declared client package ${name} does not declare a dsh.client face`)
    }
  }
  return problems
}

/**
 * The machinery rows ↔ `descriptor.services`, both directions.
 * @param {{ machineryRows: Array<{ id: string, name: string }>, declaredRows: Array<{ id: string, name: string }> }} sets - the patch's machinery rows and the declared services.
 * @returns {string[]} one problem per drift (empty = in sync).
 */
export function machineryRowProblems({ machineryRows, declaredRows }) {
  const problems = []
  for (const row of declaredRows) {
    if (!machineryRows.some((actual) => actual.id === row.id && actual.name === row.name)) {
      problems.push(`declared service row ${row.id} (${row.name}) is not in the bundle patch`)
    }
  }
  for (const row of machineryRows) {
    if (!declaredRows.some((declared) => declared.id === row.id && declared.name === row.name)) {
      problems.push(`bundle patch row ${row.id} (${row.name}) is not declared in the deployment descriptor`)
    }
  }
  return problems
}
