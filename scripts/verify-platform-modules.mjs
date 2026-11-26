#!/usr/bin/env node
/**
 * T5 — the client shared-module table, against the installed platform and this
 * repo's own two copies.
 *
 * `@deepseek-ai/dsh-client-web` publishes its `src/platform.ts` (the
 * `PLATFORM_MODULES` seed table) through the package's `./src/*` export, so the
 * upstream half is readable again — the header here used to claim it was not
 * published. Three facts must agree:
 *
 * 1. the installed platform's seed table;
 * 2. the build's external set (`packages/client/tsdown.client.ts`) and the
 *    factory gate's answerable set (`scripts/verify-client-factory.mjs`) —
 *    one table, two consumers;
 * 3. this repo's OWN `dsh.client.external` edges are a plugin seam the
 *    platform stitches at boot, NOT a platform seed: an edge that appears in
 *    the seed table would mean two mechanisms claim one specifier.
 *
 * A table that stops parsing is a FAIL that asks for the parser to be updated —
 * never an empty list that passes.
 * @module
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLocalPlatformModules } from './platform-contract.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_TABLE = 'packages/client/tsdown.client.ts'
const PLATFORM_TABLE = join('node_modules', '@deepseek-ai', 'dsh-client-web', 'src', 'platform.ts')

/** Every declared `dsh.client.external` edge in the workspace, as `{ package, edge }`. */
export function declaredExternalEdges(root = ROOT) {
  const edges = []
  for (const group of ['application', 'client', 'examples']) {
    const base = join(root, 'packages', group)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      const manifestPath = join(base, entry, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const external = manifest.dsh?.client?.external
      if (external === undefined) continue
      if (!Array.isArray(external)) throw new Error(`${manifestPath}: dsh.client.external must be a string array`)
      for (const edge of external) edges.push({ package: manifest.name, edge })
    }
  }
  return edges
}

/** Compare two string arrays as ordered lists. */
function sameList(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Run the check.
 * @param {{ root?: string }} [options] - the repo root.
 * @returns {number} the exit code.
 */
export function verify({ root = ROOT } = {}) {
  const failures = []
  let buildTable
  let platformTable
  try {
    buildTable = parseLocalPlatformModules(join(root, BUILD_TABLE))
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
  try {
    platformTable = parseLocalPlatformModules(join(root, PLATFORM_TABLE))
  } catch (error) {
    failures.push(`the installed platform table is unreadable (run: node scripts/deps.mjs): ${String(error.message ?? error)}`)
  }
  if (platformTable !== undefined && buildTable !== undefined && !sameList(platformTable, buildTable)) {
    failures.push(`${BUILD_TABLE} disagrees with the installed platform seed table:\n    platform: ${JSON.stringify(platformTable)}\n    build:    ${JSON.stringify(buildTable)}`)
  }
  let edges = []
  try {
    edges = declaredExternalEdges(root)
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
  for (const { package: pkg, edge } of edges) {
    if ((buildTable ?? []).includes(edge)) {
      failures.push(`${pkg} declares dsh.client.external ${edge}, which is also a platform seed module — a plugin seam must not claim a seed`)
    }
  }
  if (buildTable !== undefined) {
    console.log(`verify-platform-modules: OK — ${buildTable.length} platform seed(s) agree between the installed line and the local build table`)
  }
  console.log(`verify-platform-modules: this repo's own external edges: ${edges.length === 0 ? 'none declared (the seed table is the whole surface)' : edges.map(edge => edge.edge).join(', ')}`)
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  if (failures.length > 0) {
    console.error(`verify-platform-modules: FAIL — ${failures.length} problem(s)`)
    return 1
  }
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(verify({ root: ROOT }))
}
