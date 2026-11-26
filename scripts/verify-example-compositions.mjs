#!/usr/bin/env node
/**
 * Example-composition gate. The bundle patch
 * (`packages/bundle/app-harness/cordis.patch.yml`) is the single source of
 * authority for which machinery rows the harness mounts; each example
 * composition under `examples/<name>/` (any `*cordis.yml` variant — the plain
 * `cordis.yml` and the `tooled.cordis.yml` include-overlay) runs them through
 * an `insert:` block, a plain row list, or an `include:` row with patches, and
 * may either carry the full machinery set (the web-application overlay — a web
 * profile + everything the bundle mounts) or a deliberately trimmed subset (the
 * keyless applications composition — anchor-only, no model/bridge/client rows).
 *
 * The gate compares, per composition, two things:
 *
 * 1. Machinery rows: the composition's *effective* row list (the include
 *    source's rows plus the rows its own patches insert — see
 *    `effectiveRows`) by id AND plugin name, against a rowset declaration in
 *    the file's header comment: `machinery-rowset: full` (every bundle
 *    machinery id) or `machinery-rowset: <id>, <id>, …` (an explicit subset).
 *    A missing or stale declaration fails loudly — a machinery row added to or
 *    dropped from the bundle patch must be re-synced into the compositions (or
 *    the declared intent deliberately changed) before release:check passes.
 *
 * 2. Example rows: non-machinery rows whose plugin is an `@deepseek-ai/
 *    application-harness-*` application or view, compared by id AND name against the
 *    packages' `dsh.appRow` declarations — collected from the package
 *    manifests (the single source of truth), the same set
 *    `scripts/generate-bundle-patch.mjs` aggregates into the bundle patch's
 *    generated-rows section. A row in a composition that no package
 *    declares, or whose name drifts from the declaration, fails loudly (the
 *    compositions are the second copy of the id/name pair — previously
 *    zero-checked). Platform rows (`cordis-plugin-*`/`dsh-*`) are not
 *    example rows and are skipped; `config` is never compared (compositions
 *    deliberately vary it, e.g. a different ledger path).
 *
 * The include expansion mirrors the cordis-plugin-include semantics
 * (`applyEntryPatches`): a row named `@deepseek-ai/cordis-plugin-include`
 * pulls its `config.path` list (relative to the including file) and applies
 * `config.patches` in order; an `insert:` patch without an `id` appends rows
 * to the top level. Any other patch shape fails loudly — the gate must be
 * extended rather than silently skipping rows.
 * @module
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { insertedRowsOf, patchRowsOf } from './descriptor-rows.mjs'
import { appHostDirs, appViewDirs } from './package-areas.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_PATCH = join(ROOT, 'packages/bundle/app-harness/cordis.patch.yml')
const EXAMPLES_DIR = join(ROOT, 'examples')
const COMPOSITION_RE = /cordis\.yml$/
const OVERLAY_RE = /\.patch\.yml$/
const OVERLAY_TARGETS_RE = /^#\s*overlay-targets:\s*(.+?)\s*$/m
const MARKER = /^#\s*machinery-rowset:\s*(.+?)\s*$/m
const INCLUDE_NAME = '@deepseek-ai/cordis-plugin-include'

/** Parse a patch composition into its row list (raw rows with id + name). */
function parseRows(text, file) {
  // Parse with the loader's own dialect (YAML 1.2 core + `!!js`), so the gate
  // reads exactly what the loader reads instead of a second parser's idea of it.
  let doc
  try {
    doc = parseEntryYaml(text)
  } catch (cause) {
    throw new Error(`unparseable yaml at ${file}: ${String(cause?.message ?? cause)}`)
  }
  // A patch document is a top-level list of rows (a `- id: …` list with no
  // wrapper, e.g. examples/applications) or an `insert:` block, either as a
  // mapping or as the single element of a top-level list. A list may mix rows
  // and `insert:` elements in one document; flatten both the same way.
  let list
  if (Array.isArray(doc)) list = doc
  else if (doc !== null && typeof doc === 'object' && doc.insert !== undefined) list = Array.isArray(doc.insert) ? doc.insert : [doc.insert]
  else throw new Error(`no row list found at ${file} (expected a top-level list or an "insert:" block)`)
  const rows = []
  for (const item of list) {
    if (item !== null && typeof item === 'object' && item.insert !== undefined) {
      rows.push(...(Array.isArray(item.insert) ? item.insert : [item.insert]))
    } else {
      rows.push(item)
    }
  }
  if (rows.some((row) => typeof row?.id !== 'string')) {
    throw new Error(`no row list found at ${file} (expected a top-level list or an "insert:" block)`)
  }
  return rows
}

/**
 * The composition's effective, mounted row list: `parseRows` plus include
 * expansion. A row named `@deepseek-ai/cordis-plugin-include` is replaced by
 * its target file's effective rows (relative `config.path`), then the target's
 * patches are applied in order — matching what the platform loader actually
 * mounts, so an include-inserted machinery row cannot hide from the gate.
 * Patches the gate cannot statically expand fail loudly instead of being
 * silently skipped.
 */
function effectiveRows(text, file, seen = new Set()) {
  const here = resolve(file)
  if (seen.has(here)) throw new Error(`include cycle at ${file}`)
  return expandRows(parseRows(text, file), file, new Set(seen).add(here))
}

/**
 * Expand the include rows of one composition, applying the loader's own patch
 * dialect to each included document (`applyEntryPatches`). This is the same
 * code path the loader runs, so a patch shape the gate has not seen is applied
 * correctly instead of being rejected by a second implementation.
 * @param rows - parsed rows of the current document.
 * @param file - the document's path (for diagnostics and relative includes).
 * @param seen - the include chain, for cycle detection.
 * @returns the effective mounted rows.
 */
function expandRows(rows, file, seen) {
  const out = []
  for (const row of rows) {
    if (row.name !== INCLUDE_NAME) {
      out.push(row)
      continue
    }
    const path = row.config?.path
    if (typeof path !== 'string') {
      throw new Error(`include row "${row.id}" at ${file} carries no string config.path`)
    }
    const target = resolve(dirname(file), path)
    if (!existsSync(target)) {
      throw new Error(`include target ${target} (referenced by ${file}) does not exist`)
    }
    if (seen.has(target)) throw new Error(`include cycle at ${target}`)
    const patches = row.config?.patches ?? []
    if (!Array.isArray(patches)) {
      throw new Error(`include row "${row.id}" at ${file} carries a non-array config.patches`)
    }
    const warnings = []
    let patched
    try {
      patched = applyEntryPatches(parseRows(readFileSync(target, 'utf8'), target), patches, (message) => warnings.push(String(message)))
    } catch (cause) {
      throw new Error(`include patches at ${file} could not be applied: ${String(cause?.message ?? cause)}`)
    }
    if (warnings.length > 0) {
      throw new Error(`include patches at ${file} did not apply: ${warnings.join('; ')}`)
    }
    out.push(...expandRows(patched.data, target, new Set(seen).add(target)))
  }
  return out
}

/**
 * The machinery rows (id → name) of the bundle patch: the INSERTED rows above
 * the generated-application marker only. The generated app rows below the
 * marker are example rows (checked against `dsh.appRow` declarations), not
 * machinery — and a top-level patch TARGET (the managed sidebar-replacement
 * directive disables a platform row this deployment takes over) mounts nothing
 * of ours, so demanding a `machinery-rowset` entry for it would make every
 * composition declare a row it must not carry: a keyless composition has no
 * browser sidebar to replace.
 */
function bundleMachinery(file) {
  const text = readFileSync(file, 'utf8')
  const markerIndex = text.indexOf('generated application rows')
  const machineryText = markerIndex === -1 ? text : text.slice(0, markerIndex)
  const map = new Map()
  for (const row of insertedRowsOf(patchRowsOf(machineryText))) {
    map.set(row.id, row.name)
  }
  if (map.size === 0) throw new Error(`bundle patch ${file} declares no rows`)
  return map
}

/** The declared machinery-rowset of one composition, `full` or an explicit id list. */
function declaredRowset(text, file) {
  const match = MARKER.exec(text)
  if (!match) {
    throw new Error(`${file} has no "machinery-rowset:" declaration — every example composition must state whether it carries the full bundle machinery set or an explicit subset`)
  }
  const value = match[1].trim()
  return value === 'full' ? 'full' : value.split(/[,\s]+/).filter(Boolean)
}

/** Every launcher overlay under the examples tree (compositions and patch overlays). */
function overlayFiles() {
  const out = []
  for (const entry of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(EXAMPLES_DIR, entry.name)
    for (const name of readdirSync(dir).sort()) {
      if (OVERLAY_RE.test(name)) out.push(join(dir, name))
    }
  }
  return out
}

/** The example rows (id → declaration) from each package's `dsh.appRow`. */
function exampleAppRows() {
  const map = new Map()
  for (const dir of [...appHostDirs(ROOT), ...appViewDirs(ROOT)]) {
    const pkgFile = join(dir, 'package.json')
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    } catch {
      continue // A malformed manifest is the package's own problem; the row is just skipped.
    }
    const row = pkg === null || typeof pkg !== 'object' ? undefined : pkg.dsh?.appRow
    if (row === undefined) continue
    map.set(row.id, row)
  }
  return map
}

const machinery = bundleMachinery(BUNDLE_PATCH)
const appRows = exampleAppRows()
let failures = 0
let checked = 0

for (const entry of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(EXAMPLES_DIR, entry.name)
  for (const name of readdirSync(dir)) {
    if (!COMPOSITION_RE.test(name)) continue
    const file = join(dir, name)
    checked += 1
    const text = readFileSync(file, 'utf8')
    const problems = []
    try {
      const declared = declaredRowset(text, file)
      const want = new Set(declared === 'full' ? machinery.keys() : declared)
      for (const id of want) {
        if (!machinery.has(id)) problems.push(`declares machinery row "${id}" that the bundle patch does not carry`)
      }
      const rows = effectiveRows(text, file)
      const present = new Map(rows.filter((row) => machinery.has(row.id)).map((row) => [row.id, row.name]))
      const missing = [...want].filter((id) => !present.has(id))
      const extra = [...present.keys()].filter((id) => !want.has(id))
      if (missing.length || extra.length) {
        problems.push(`machinery rows deviate from the "${declared === 'full' ? 'full' : declared.map(String).join(', ')}" declaration (missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'})`)
      }
      for (const [id, name] of present) {
        if (name !== machinery.get(id)) {
          problems.push(`machinery row "${id}" is "${name ?? '<no name>'}", the bundle patch has "${machinery.get(id)}"`)
        }
      }
      // The second-copy check: every non-machinery application-harness row in the
      // composition must match its package's dsh.appRow declaration.
      let exampleChecked = 0
      for (const row of rows) {
        if (machinery.has(row.id)) continue
        if (typeof row.name !== 'string' || !row.name.startsWith('@matrix1001/dsh-application-harness-')) continue
        exampleChecked += 1
        const declaredRow = appRows.get(row.id)
        if (declaredRow === undefined) {
          problems.push(`example row "${row.id}" (${row.name}) has no dsh.appRow declaration — every non-machinery harness row must be declared by its package (see scripts/setup.mjs exampleRows())`)
        } else if (declaredRow.name !== row.name) {
          problems.push(`example row "${row.id}" is "${row.name}", the package's dsh.appRow declares "${declaredRow.name}"`)
        }
        // A VIEW row's package declares the application it renders
        // (`dsh.appRow.appId`): the composition must mount that application's
        // HOST row too. The selector of a view's slot unit matches on
        // `owner.appId`, so a view row without its host row can never match a
        // world entity — while the platform still materializes a client bundle
        // for the composed entry. That is exactly how `client-ui-git-read` sat
        // in the web overlay, with every gate green (dsh-conformance 2026-09-23;
        // fixed by hand in batch 1, guarded here in batch 5).
        if (typeof declaredRow?.appId === 'string' && !rows.some(candidate => candidate.id === declaredRow.appId)) {
          problems.push(`view row "${row.id}" (${row.name}) renders application "${declaredRow.appId}", which this composition does not mount`)
        }
      }
      if (problems.length) {
        failures += 1
        console.error(`verify-example-compositions: ${file}`)
        for (const problem of problems) console.error(`  - ${problem}`)
      } else {
        console.log(`verify-example-compositions: ${file} — machinery rows OK (${want.size} declared, names match the bundle patch); example rows OK (${exampleChecked} row(s) matched dsh.appRow)`)
      }
    } catch (err) {
      failures += 1
      console.error(`verify-example-compositions: ${file}`)
      console.error(`  - ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// The launcher overlays (`examples/applications/*.patch.yml`) are what the
// browser lanes actually boot with (`dsh --patch <file>`), and their rows sat
// outside every gate: an insert naming a fixture file that has since been
// renamed, or an override aimed at a row id nobody declares, surfaced only when
// that lane booted (arch-review 2026-09-20, fixture-overlay-row-ids-ungated).
//
// The override direction is one the repo cannot enumerate on its own: the rows
// these overlays disable (`app-http` is ours, `directory-picker` is the
// platform's) live in compositions this repo does not carry. So the overlay
// DECLARES its targets in an `# overlay-targets:` header line and the gate pins
// the declaration to the file — both directions.
for (const file of overlayFiles()) {
  checked += 1
  const text = readFileSync(file, 'utf8')
  const problems = []
  try {
    const rows = parseRows(text, file)
    const overrides = rows.filter((row) => typeof row.name !== 'string').map((row) => row.id)
    const declared = (OVERLAY_TARGETS_RE.exec(text)?.[1] ?? '').split(/[,\s]+/u).filter(Boolean)
    if (overrides.length > 0 && declared.length === 0) {
      problems.push(`overrides ${overrides.join(', ')} without an "# overlay-targets:" declaration — state which existing row ids this overlay targets`)
    }
    const undeclared = overrides.filter((id) => !declared.includes(id))
    if (undeclared.length > 0) problems.push(`overrides row(s) the header does not declare: ${undeclared.join(', ')}`)
    const unused = declared.filter((id) => !overrides.includes(id))
    if (unused.length > 0) problems.push(`declares target(s) no row overrides: ${unused.join(', ')}`)
    for (const row of rows) {
      if (typeof row.name !== 'string') continue
      if (row.name.startsWith('./') || row.name.startsWith('../')) {
        if (!existsSync(resolve(dirname(file), row.name))) {
          problems.push(`row "${row.id}" mounts ${row.name}, which does not exist beside ${file}`)
        }
      } else if (row.name.startsWith('@matrix1001/dsh-application-harness-') && !appRows.has(row.id)) {
        problems.push(`row "${row.id}" (${row.name}) has no dsh.appRow declaration`)
      }
    }
    if (problems.length === 0) {
      console.log(`verify-example-compositions: ${file} — overlay OK (${String(overrides.length)} declared target(s), ${String(rows.length - overrides.length)} inserted row(s))`)
    }
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err))
  }
  if (problems.length > 0) {
    failures += 1
    console.error(`verify-example-compositions: ${file}`)
    for (const problem of problems) console.error(`  - ${problem}`)
  }
}

if (checked === 0) {
  console.error('verify-example-compositions: no example compositions found')
  process.exit(1)
}
if (failures > 0) {
  console.error(`verify-example-compositions: ${failures}/${checked} composition(s) deviate from the machinery rowset or the dsh.appRow declarations — re-sync ${BUNDLE_PATCH} or the package manifests, or change the declared intent`)
  process.exit(1)
}
console.log(`verify-example-compositions: OK — ${checked} composition(s) match the bundle patch machinery rows and the dsh.appRow declarations`)
