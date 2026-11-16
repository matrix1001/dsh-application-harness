#!/usr/bin/env node
/**
 * T5 — the client shared-module table against its truth source.
 *
 * Three things must agree:
 * 1. this repo's TWO local copies of the platform seed table
 *    (`packages/client/tsdown.client.ts` — the build's external set — and
 *    `scripts/verify-client-factory.mjs` — the factory gate's answerable set);
 * 2. the lock's snapshot of the platform's real `PLATFORM_MODULES`, recorded
 *    from the declared line's immutable commit (T3);
 * 3. when a checkout holding the recorded source is available, that source's
 *    file again — the declared line's tag, or the commit the lock recorded when
 *    the execution line runs ahead of the tag (`vendor-platform-src --commit`).
 *    Which one is the lock's `sourceMode`; both modes assert the source is ON
 *    the declared line before comparing, and follow the recorder's own rule.
 *
 * The seed table and this repo's OWN whitelist edges are validated separately:
 * a `dsh.client.external` edge is a plugin-package seam the platform stitches
 * at boot, NOT a platform seed, so an edge that appears in the seed table would
 * mean two different mechanisms claiming one specifier.
 *
 * Statuses (plan §C2): local copy drift, a lock mismatch, or a recorded source
 * the declared line no longer reaches = FAIL; no upstream snapshot/checkout =
 * UNVERIFIED, printed explicitly and never folded into a PASS. An unparseable
 * table is a FAIL that asks for the parser to be updated — never an empty list
 * that passes.
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLocalPlatformModules, parsePlatformModules, PLATFORM_LOCK, PLATFORM_MODULES_SOURCE, readLock } from './platform-contract.mjs'
import { declaredLine, tagFor } from './vendor-platform-src.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_TABLE = 'packages/client/tsdown.client.ts'
const FACTORY_TABLE = 'scripts/verify-client-factory.mjs'

/**
 * Run git in a checkout (the environment exports a broken GIT_CONFIG_*).
 * stderr is PIPED rather than inherited, so a failing read is reported once —
 * inside the caller's own FAIL line — instead of also being echoed to the
 * terminal ahead of it.
 * @param {string} checkout - the platform checkout root.
 * @param {string[]} args - the git arguments.
 * @returns {string} git's trimmed stdout.
 */
function gitIn(checkout, args) {
  return execFileSync('git', args, {
    cwd: checkout, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Whether `ancestor` is an ancestor of `commit` in the checkout — the same
 * ancestry rule the recorder asserts, answered instead of thrown: git exits
 * non-zero when the answer is no.
 * @param {string} checkout - the platform checkout root.
 * @param {string} ancestor - the commit that must be reached.
 * @param {string} commit - the commit that must reach it.
 * @returns {boolean} the verdict.
 */
function isAncestor(checkout, ancestor, commit) {
  try {
    gitIn(checkout, ['merge-base', '--is-ancestor', ancestor, commit])
    return true
  } catch {
    return false
  }
}

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

/** Compare two string arrays as ordered lists (module-table identity is order-sensitive for readability, not semantics — report either). */
function sameList(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Run the whole T5 check.
 * @param {{ root?: string, checkout?: string }} [options] - the repo root and an optional platform checkout.
 * @returns {number} the exit code.
 */
export function verify({ root = ROOT, checkout } = {}) {
  const failures = []
  let buildTable
  let factoryTable
  try {
    buildTable = parseLocalPlatformModules(join(root, BUILD_TABLE))
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
  try {
    factoryTable = parseLocalPlatformModules(join(root, FACTORY_TABLE))
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
  if (buildTable !== undefined && factoryTable !== undefined && !sameList(buildTable, factoryTable)) {
    failures.push(`${BUILD_TABLE} and ${FACTORY_TABLE} disagree on the platform seed table:\n    build:   ${JSON.stringify(buildTable)}\n    factory: ${JSON.stringify(factoryTable)}`)
  }
  let lock
  try {
    lock = readLock(root)
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
  const recorded = lock?.platformModules?.modules
  if (recorded === undefined) {
    failures.push(`${PLATFORM_LOCK} carries no platformModules snapshot — re-record it: node scripts/vendor-platform-src.mjs --record --checkout <path>`)
  } else if (buildTable !== undefined && !sameList(buildTable, recorded)) {
    failures.push(`the local platform seed table does not match the declared line's (${lock.tag}):\n    ours:     ${JSON.stringify(buildTable)}\n    platform: ${JSON.stringify(recorded)}`)
  }
  // The seed table and this repo's own whitelist edges are separate mechanisms.
  let edges = []
  try {
    edges = declaredExternalEdges(root)
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
  for (const { package: pkg, edge } of edges) {
    if ((recorded ?? []).includes(edge) || (buildTable ?? []).includes(edge)) {
      failures.push(`${pkg} declares dsh.client.external "${edge}", which is a platform SEED entry — an edge must be this repo's own seam, not a module the shell already shares`)
    }
  }
  if (failures.length > 0) {
    console.error('verify-platform-modules: FAIL')
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  console.log(`verify-platform-modules: OK — ${buildTable.length} platform seeds agree across both local copies and ${PLATFORM_LOCK} (${lock.tag})`)
  console.log(`verify-platform-modules: this repo's own external edges: ${edges.length === 0 ? 'none declared (the seed table is the whole surface)' : edges.map(entry => `${entry.package}→${entry.edge}`).join(', ')}`)
  // The upstream half: explicit PASS or explicit UNVERIFIED — never folded in.
  if (checkout === undefined || !existsSync(join(checkout, '.git'))) {
    console.log('verify-platform-modules: upstream UNVERIFIED — no platform checkout; the comparison used the recorded snapshot only')
    return 0
  }
  try {
    // How the lock names its source, for every line this half prints.
    const origin = lock.sourceMode === 'commit' ? `${lock.tag} +${lock.commitsAhead}` : lock.tag
    let commit
    if (lock.sourceMode === 'commit') {
      // The commit the lock recorded must still be ON the declared line — the
      // recorder's rule, re-asserted here because the line's anchor can move
      // after the fact (a re-tag, a re-pointed checkout).
      const line = declaredLine(root)
      const lineTag = tagFor(line)
      commit = gitIn(checkout, ['rev-parse', `${lock.commit}^{commit}`])
      const lineCommit = gitIn(checkout, ['rev-parse', `${lineTag}^{commit}`])
      if (!isAncestor(checkout, lineCommit, commit)) {
        console.error(`verify-platform-modules: FAIL — the recorded commit ${lock.commit} is no longer on the declared line ${line} (${lineTag})`)
        return 1
      }
    } else {
      const tagCommit = gitIn(checkout, ['rev-parse', `${lock.tag}^{commit}`])
      if (tagCommit !== lock.commit) {
        console.error(`verify-platform-modules: FAIL — ${lock.tag} resolves to ${tagCommit} but the lock records ${lock.commit}`)
        return 1
      }
      commit = tagCommit
    }
    const live = parsePlatformModules(gitIn(checkout, ['show', `${commit}:${PLATFORM_MODULES_SOURCE}`]))
    if (!sameList(live, buildTable)) {
      console.error(`verify-platform-modules: FAIL — the source's table differs from ours:\n    live: ${JSON.stringify(live)}\n    ours: ${JSON.stringify(buildTable)}`)
      return 1
    }
    console.log(`verify-platform-modules: upstream PASS — ${PLATFORM_MODULES_SOURCE} @ ${origin} (${commit}) matches`)
    return 0
  } catch (error) {
    console.error(`verify-platform-modules: FAIL — the checkout could not be read: ${String(error.message ?? error)}`)
    return 1
  }
}

function main() {
  const argv = process.argv.slice(2)
  const index = argv.indexOf('--checkout')
  const checkout = index === -1
    ? (process.env.DSH_HARNESS_REPO !== undefined && process.env.DSH_HARNESS_REPO !== '' ? process.env.DSH_HARNESS_REPO : join(process.env.HOME ?? '', 'deepseek-harness'))
    : argv[index + 1]
  process.exit(verify({ checkout: existsSync(join(checkout, '.git')) ? checkout : undefined }))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
