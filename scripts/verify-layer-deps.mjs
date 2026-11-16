#!/usr/bin/env node
/**
 * Layer-dependency gate (remediation plan 阶段 G, 分层依赖门): the three-layer
 * architecture is a *property of the import graph*, not a doc sentence. This
 * gate reads every workspace package's source imports and fails when an edge
 * crosses a layer boundary the architecture forbids:
 *
 * ```
 * ① core        runtime
 * ② linkage     host-bridge, tool-bridge, context, http, store
 * ③ client      client/* (applications, chrome, *-view)
 * apps          examples/* + bundle
 * ```
 *
 * The roster is total over the workspace: the retired packages are gone from
 * the tree (P8), so a new package cannot slip in unclassified.
 *
 * Allowed edges: ① may import ①; ② may import ①/②; ③ may import ③ and the
 * *wire vocabulary* of ② (`/client`, `/types`); apps may import ①/②. Forbidden:
 * ① importing ②/③/apps, ② importing ③, ③ importing ①/② implementation modules
 * at value level (the purity gate checks the bundle face; this gate checks the
 * intent).
 *
 * The check is textual on purpose: it reads the source specifiers the packages
 * actually import, which is what the runtime sees. The package roster is total:
 * every workspace package is either layered or exempted by name with a reason
 * (2026-09-20), so a new package cannot slip in unchecked.
 * @module
 */

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The layer of each workspace package directory (relative to the repo root). */
const LAYERS = new Map()
for (const name of ['runtime']) LAYERS.set(`packages/application/${name}`, 'core')
for (const name of ['host-bridge', 'tool-bridge', 'context', 'http', 'store']) LAYERS.set(`packages/application/${name}`, 'linkage')
for (const name of ['applications', 'chrome', 'object-reference', 'notes-view', 'tasks-view', 'calendar-view', 'inbox-view', 'usage-view', 'disk-space-view', 'git-browser-view', 'workspace-review-view']) LAYERS.set(`packages/client/${name}`, 'client')
for (const name of ['notes', 'tasks', 'calendar', 'inbox', 'usage', 'disk-space', 'git-browser', 'workspace-review']) LAYERS.set(`packages/examples/${name}`, 'app')
LAYERS.set('packages/bundle/app-harness', 'app')

/**
 * Workspace packages that are not ours to layer, exempt BY NAME with a reason —
 * never by omission. The roster above is hand-written, and an unlisted package
 * used to be skipped silently both as an importer (`LAYERS.get` → continue) and
 * as an import target (`layerOfSpecifier` → "not a workspace import"), so the
 * map could only ever be wrong quietly (arch-review 2026-09-20,
 * `layer-deps-roster-hand-maintained`).
 */
const OUTSIDE_LAYERS = new Map([
  ['packages/typert/protocol', 'the vendored build-only typert protocol shell: it publishes the platform package name it snapshots'],
])

// The roster must be TOTAL: every workspace package is either layered above or
// exempted above, so a new package cannot enter the tree unclassified (and thus
// unchecked as both an importer and a target).
const unclassified = globSync('packages/*/*/package.json', { cwd: ROOT })
  .map((manifest) => dirname(manifest))
  .filter((dir) => !LAYERS.has(dir) && !OUTSIDE_LAYERS.has(dir))
if (unclassified.length > 0) {
  console.error('verify-layer-deps: workspace packages are in no layer (add them to LAYERS, or to OUTSIDE_LAYERS with a reason):')
  for (const dir of unclassified) console.error(`  - ${dir}`)
  process.exit(1)
}

/** The package name of a directory (from its package.json). */
function packageName(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')).name
}

/** Package directory by name. */
const DIR_BY_NAME = new Map()
for (const dir of LAYERS.keys()) DIR_BY_NAME.set(packageName(dir), dir)

/** The layer a specifier belongs to, or undefined for a non-workspace import. */
function layerOfSpecifier(specifier) {
  // `@matrix1001/dsh-application-harness-store/atomic` → the store package.
  const match = /^(@matrix1001\/dsh-application-harness(?:-[a-z-]+)?)(?:\/.*)?$/u.exec(specifier)
  if (match === null) return undefined
  const dir = DIR_BY_NAME.get(match[1])
  return dir === undefined ? undefined : LAYERS.get(dir)
}

/** Allowed layer→layer edges. */
const ALLOWED = new Set([
  'core->core',
  'linkage->core',
  'linkage->linkage',
  'client->client',
  'app->core',
  'app->linkage',
  'app->app',
  // The client face names the wire vocabulary (`/client`, `/types`) of the
  // linkage layer; the purity gate is what keeps that from becoming an
  // implementation edge.
  'client->linkage',
])

const files = globSync('packages/*/*/src/**/*.{ts,tsx}', { cwd: ROOT })
const problems = []
for (const file of files) {
  const dir = file.split('/src/')[0]
  const layer = LAYERS.get(dir)
  if (layer === undefined) continue
  const source = readFileSync(join(ROOT, file), 'utf8')
  const importers = [...source.matchAll(/(?:^|\n)\s*import\s+(type\s+)?[^'\n]*?from\s+['"]([^'"]+)['"]/gu)]
  for (const [, typeOnly, specifier] of importers) {
    const target = layerOfSpecifier(specifier)
    if (target === undefined || target === layer) continue
    if (ALLOWED.has(`${layer}->${target}`)) continue
    // A client package may *name* a core type: the wire vocabulary is erased
    // at runtime.
    if (layer === 'client' && target === 'core' && typeOnly !== undefined) continue
    problems.push(`${relative(ROOT, join(ROOT, file))}: ${layer} imports ${target} (${specifier}) — not an allowed layer edge`)
  }
}

if (problems.length > 0) {
  console.error('verify-layer-deps: the import graph crosses a forbidden layer boundary:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-layer-deps: OK — ${files.length} source files, ${LAYERS.size} packages, ${ALLOWED.size} allowed layer edges, no violations`)
