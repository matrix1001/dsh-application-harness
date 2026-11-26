#!/usr/bin/env node
/**
 * Version three-line gate (conformance finding `version-skew-declaration-vs-execution`),
 * upgraded to registry dual-source (open-design B2, 2026-09-07): the skew between
 * our *declaration line* (the manifest pins) and the *execution line* (the
 * platform packages the live application-harness profile actually loads) is judged,
 * and both are compared against the **registry line** (npm dist-tags) so a
 * pending platform port (`behind`) and an unreleased execution line
 * (`unsupported`) are explicit instead of silent. `--self-test` runs the pure
 * classifier over fixtures and must reproduce every verdict.
 *
 * The registry line is the max of the `latest`/`next`/`alpha` dist-tags
 * (2026-09-17): the declared line may itself be an alpha, so omitting that tag
 * would make every package unjudgeable against the registry the moment we
 * declared one — `unsupported` against a registry that was never asked about
 * the line we actually track (the 10-task line bump reads this gate as its
 * acceptance number, so that silence would have been read as 70 real findings).
 *
 * The executable half lives in `main()` behind the usual import guard (the same
 * shape as `vendor-platform-src.mjs`), and the judgment seams are exported, so
 * the classifier and the mixed-line summary are testable without reading a
 * profile or reaching the network.
 *
 * Sources
 *   - **declared** — every `@deepseek-ai/dsh*` pin across our workspace
 *     manifests (root + every packages row's package.json). One version per
 *     package or the gate fails (a mixed declaration is exactly the skew the
 *     finding attacks).
 *   - **executed** — the live profile's on-disk resolution **projection**.
 *     Platform 0.1.6-alpha.2 made `runtime` the launcher's default resolution
 *     mode: it installs an in-process resolution generation on Node's ESM/CJS
 *     resolvers, creates no fallback links, and drops pre-existing managed
 *     fallback links from its candidate set (app-boot's
 *     `profile-resolution/resolver.ts`; `healIsolatedProfileModuleFallback` is
 *     only called when the caller selects link/dual). The two directories below
 *     are therefore a **legacy projection** written by the former `link` mode —
 *     not the runtime's source of truth. They are still read because on this
 *     machine they mirror the checkout's dependency closure (the daily
 *     execution line), but a projection can go stale or dangle:
 *       1. <DSH_HOME>/profiles/<profile>/node_modules/@deepseek-ai/<name>
 *       2. <DSH_HOME>/profiles/node_modules/@deepseek-ai/<name>
 *          (legacy link-backend projection; dangles when the checkout moves)
 *     The third layer this gate used to read,
 *     `profiles/<profile>/.dsh-module-fallback`, belonged to the link mode's own
 *     link farm and was deleted with that mode in 0.1.7-alpha.1 — a permanently
 *     empty layer only invited the reading that something else had been checked.
 *     A broken link prints its own verdict (`[NO-EV]`, a no-evidence row) rather
 *     than falling through to the next layer or being counted with `n/s`: the
 *     two are different facts (a chain that never carried the package vs one
 *     whose entry outlived its target), and neither may answer for a row's
 *     ahead/behind judgment. A profile that has only ever run runtime mode has
 *     none of them and reads `n/s` throughout — that is the honest reading, not
 *     a pass.
 *   - **profile** (diagnostic only) — the profile's *bundle composition* from
 *     its `dsh.profile.bundles`. The profile deliberately pins no platform
 *     version: since the 2026-09-07 bundle-layer migration its lockfile holds
 *     only `link:` workspace deps and the platform packages resolve from the
 *     bundle layer at launch, so the old version scan could never match
 *     anything (platform-update-review 2026-09-10 finding
 *     `profile-lock-diagnostic-dead`). What is printable is the bundle list,
 *     and it is printed, never judged.
 *
 * Verdicts per package (only executed vs declared is judged):
 *   - executed < declared  → **FAIL** — a real downgrade: the run line is
 *     older than the line the gates typechecked/tested it against.
 *   - executed > declared  → WARN — checkout 前导: inherent while the daily
 *     launch runs from the platform checkout (AGENTS.md: 「npm pin 约束类型、
 *     CI 和发布面，不替代 checkout 执行线」).
 *   - executed == declared → OK
 *   - no resolution in the projection → note (a package that is not on the
 *     shortcut chain is informational; a profile with no legacy projection
 *     reads this way for every platform package).
 *
 * When the packages do not agree on one executed version the gate additionally
 * prints a `[MIXED-EXEC]` block naming the deviating packages — a *report*, not
 * a verdict: it changes no exit code. The 2026-09-17 platform-line bump survey
 * found three client packages resolving back into this repo instead of the
 * checkout, and the reader of this gate needs to see that shape explained (the
 * profile projects a bundle's direct platform deps from OUR pin) rather than
 * guess why three rows disagreed with the other seventy.
 *
 * On a machine with no live profile (CI sandbox) the gate prints a `skip`
 * line and exits 0 — there is nothing to measure there. Env overrides:
 * `DSH_HOME` / `DSH_PROFILE`.
 *
 * @module scripts/verify-execution-line
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'application-harness'
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)

/** @deepseek-ai/dsh* — the CLI (`dsh`) and every platform package. */
const isPlatformName = (name) => name.startsWith('@deepseek-ai/dsh')

function listManifests(root) {
  const files = [join(root, 'package.json')]
  for (const group of ['packages/application', 'packages/client', 'packages/examples', 'packages/bundle', 'packages/typert']) {
    const groupDir = join(root, group)
    for (const dir of readdirSync(groupDir)) {
      const pkgPath = join(groupDir, dir, 'package.json')
      if (existsSync(pkgPath)) files.push(pkgPath)
    }
  }
  return files
}

/**
 * Pre-release-aware semver compare; returns <0 / 0 / >0. Hand-rolled to keep
 * the gate dependency-free and total — a thrown parse error here would take
 * down the whole run, so the regex is the only shape it accepts. Exported
 * because it is the ordering seam every verdict rests on: `alpha` ranks below
 * `beta`/`rc`, numeric identifiers rank lowest, and the 2026-09-17 line move
 * makes the alpha-vs-alpha and alpha-vs-rc relations load-bearing.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const match = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v)
    if (!match) throw new Error(`unparseable version: ${v}`)
    return { core: match[1].split('.').map(Number), pre: match[2] === undefined ? null : match[2].split('.') }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1 // release > any prerelease
  if (pb.pre === null) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const ta = pa.pre[i]
    const tb = pb.pre[i]
    if (ta === undefined) return -1
    if (tb === undefined) return 1
    if (ta === tb) continue
    const rank = (token) => {
      if (/^\d+$/.test(token)) return { kind: 'n', value: Number(token) }
      const named = ['alpha', 'beta', 'rc'].indexOf(token)
      return named >= 0 ? { kind: 'p', value: named } : { kind: 's', value: token } // named < string identifiers
    }
    const ra = rank(ta)
    const rb = rank(tb)
    if (ra.kind !== rb.kind) {
      if (ra.kind === 'n') return -1 // numeric identifiers rank lowest
      if (rb.kind === 'n') return 1
      return ra.kind === 'p' ? -1 : 1
    }
    if (ra.kind === 'n' || ra.kind === 'p') return ra.value - rb.value
    const diff = ra.value.localeCompare(rb.value)
    if (diff !== 0) return diff
  }
  return 0
}

function executedRoots() {
  const nameDir = join(PROFILE_DIR, 'node_modules', '@deepseek-ai')
  const sharedDir = join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai')
  // Two layers, not three: `profiles/<profile>/.dsh-module-fallback` was the
  // link mode's own link farm, and platform 0.1.7-alpha.1 deleted the mechanism
  // (app-boot's `profile-resolution/legacy-links.ts` now only canonicalizes) —
  // a permanently empty layer invited the reading "we looked somewhere else".
  // The second label says what that directory IS: physical links the former
  // `link` backend wrote, which no longer track the runtime's own resolution
  // and dangle the moment the checkout's dependency graph moves (it did, in
  // 0.1.7). It is NOT "the checkout fallback" and not a runtime source of
  // truth — the runtime resolves in process and materializes no links at all.
  return [
    [nameDir, 'profile-local'],
    [sharedDir, 'legacy-link-projection'],
  ]
}

/** Whether the projection entry exists at all, without following the link.
 * `existsSync` follows symlinks, so a link whose target is gone answers `false`
 * — indistinguishable from "this layer never had the package". */
function projectionEntryExists(dir, unscoped) {
  try {
    lstatSync(join(dir, unscoped))
    return true
  } catch {
    return false
  }
}

/**
 * Read one package's executed version off the projection chain.
 * Exported with an injectable root list so the dangling-projection rule is
 * provable without a live profile — the same seam discipline as `classify`.
 * @param name - the scoped platform package name.
 * @param roots - `[dir, label]` pairs in precedence order.
 * @returns `{ version, from, dangling }` for a hit, `{ dangling }` when every
 * entry was broken, or `undefined` when the chain never carried the package.
 */
export function executedVersion(name, roots = executedRoots()) {
  const unscoped = name.replace('@deepseek-ai/', '')
  const dangling = []
  for (const [dir, label] of roots) {
    const pkgPath = join(dir, unscoped, 'package.json')
    if (!existsSync(pkgPath)) {
      // The entry survives the target: the legacy link outlived the package it
      // pointed at (pnpm pruned it, the checkout moved). Skipping in silence
      // would let the next layer — or `n/s` — answer for a broken chain.
      if (projectionEntryExists(dir, unscoped)) dangling.push(label)
      continue
    }
    return { version: JSON.parse(readFileSync(pkgPath, 'utf8')).version, from: label, dangling }
  }
  return dangling.length > 0 ? { dangling } : undefined
}

/** Diagnostic only: the profile's bundle composition (it records no platform
 * version by design — see the header's `profile` entry). */
function profileBundles() {
  const manifestPath = join(PROFILE_DIR, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles : undefined
}

/**
 * Pure three-line classifier (registry dual-source): the verdict for one
 * package's declared pin, live execution, and registry published line.
 * `executed`/`registry` are optional (no profile, unreachable registry).
 * Exported so the truth table is provable without a live profile — that
 * absence is the gate's normal CI state, which is exactly why the classifier
 * must not be testable only through it.
 */
export function classify({ name, declared, executed, registry }) {
  const cmp = (a, b) => compareVersions(a, b)
  if (executed !== undefined && registry !== undefined && cmp(executed, registry) > 0) {
    return { verdict: 'unsupported', name, declared, executed, registry }
  }
  if (registry !== undefined && cmp(registry, declared) > 0) {
    return { verdict: 'behind', name, declared, executed, registry }
  }
  if (executed !== undefined && cmp(executed, declared) < 0) {
    return { verdict: 'fail', name, declared, executed, registry }
  }
  if (executed !== undefined && cmp(executed, declared) > 0) {
    return { verdict: 'ahead', name, declared, executed, registry }
  }
  return { verdict: 'ok', name, declared, executed, registry }
}

/**
 * Group executed versions across packages. A live profile whose packages
 * resolve to more than one platform version is a MIXED execution line — the
 * shape the 2026-09-17 survey found (three client packages the profile
 * projects from OUR pin instead of taking from the checkout). The gate
 * reports it; the per-package verdicts carry the alarm.
 * Returns `undefined` when every row agrees (or when nothing was measured), so
 * the caller prints the block only when there is a deviation to explain.
 */
export function summarizeExecutedLines(rows) {
  const byVersion = new Map()
  for (const row of rows) {
    if (row.executed === undefined) continue
    if (!byVersion.has(row.executed)) byVersion.set(row.executed, [])
    byVersion.get(row.executed).push(row.name)
  }
  if (byVersion.size < 2) return undefined
  const [line, names] = [...byVersion.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  const deviating = [...byVersion.entries()]
    .filter(([version]) => version !== line)
    .map(([version, entries]) => ({ version, names: entries.sort() }))
  return { line, count: names.length, deviating }
}

/** Fixture-driven self-proof: the classifier must reproduce every verdict. */
function selfTest() {
  const fixtures = [
    ['ok', { declared: '0.1.2-rc.1', executed: '0.1.2-rc.1', registry: '0.1.2-rc.1' }, 'ok'],
    ['ahead(固有)', { declared: '0.1.2-rc.1', executed: '0.1.3-alpha.1', registry: '0.1.2-rc.1' }, 'unsupported'],
    ['behind', { declared: '0.1.2-rc.1', executed: '0.1.2-rc.1', registry: '0.1.3-alpha.1' }, 'behind'],
    ['fail(降级)', { declared: '0.1.2-rc.1', executed: '0.1.2-alpha.5', registry: '0.1.2-rc.1' }, 'fail'],
    ['ahead-registry-unreachable', { declared: '0.1.2-rc.1', executed: '0.1.3-alpha.1', registry: undefined }, 'ahead'],
    ['ok-on-declared-alpha', { declared: '0.1.6-alpha.1', executed: '0.1.6-alpha.1', registry: '0.1.6-alpha.1' }, 'ok'],
    ['behind-on-alpha', { declared: '0.1.5-rc.1', executed: '0.1.5-rc.1', registry: '0.1.6-alpha.1' }, 'behind'],
  ]
  for (const [label, input, expected] of fixtures) {
    const actual = classify({ name: 'fixture', ...input }).verdict
    if (actual !== expected) throw new Error(`self-test "${label}": expected ${expected}, got ${actual}`)
  }
  console.log(`  ✓ ${fixtures.length} classifier self-tests reproduce every verdict`)
}

if (process.argv.includes('--self-test')) {
  selfTest()
  process.exit(0)
}

/**
 * The registry published line from a package's `dist-tags`: the max of the
 * `latest`/`next`/`alpha` tags, `undefined` when none of the three is present.
 * `alpha` is included because the declared line itself may be an alpha
 * (2026-09-17): leaving it out would make every package unjudgeable against the
 * registry the moment we declared one, and would silence the "a new line is
 * published" signal inside the line we actually track. Exported as the pure
 * seam the candidate set lives in — the 2026-09-17 final review found the old
 * inline set untested (dropping `alpha` left every test green), so the set must
 * be provable without a network call.
 * @param distTags - the registry document's `dist-tags` (missing → undefined).
 * @returns the highest of the three candidate tags, or undefined.
 */
export function pickRegistryLine(distTags) {
  const tags = distTags ?? {}
  const candidates = [tags.latest, tags.next, tags.alpha].filter((tag) => typeof tag === 'string')
  if (candidates.length === 0) return undefined
  return candidates.sort(compareVersions).at(-1)
}

/**
 * The registry published line via the network (5s budget, unreachable →
 * undefined). The judgment is `pickRegistryLine`; this half is only the fetch.
 */
async function registryLine(name) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`https://registry.npmjs.org/${name}`, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return undefined
    const data = await response.json()
    return pickRegistryLine(data['dist-tags'])
  } catch {
    return undefined
  }
}

/**
 * The gate's only red path: a real downgrade (`fail`) or a mixed declaration.
 * Exported so the exit-code rule is provable without a live profile — `main()`
 * prints per-package lines and cannot be exercised by a unit test, but the rule
 * it applies (`counts.fail > 0 || mixed.length > 0`) is exactly this.
 * @param counts - the per-verdict counters.
 * @param mixed - the mixed-declaration rows.
 * @returns 1 when the gate must fail, 0 otherwise.
 */
export function exitCodeFor(counts, mixed) {
  return counts.fail > 0 || mixed.length > 0 ? 1 : 0
}

/**
 * The verdict for a row the projection could not give a version for. Two
 * different facts, and they were one count until 2026-09-23: `no-evidence` —
 * the chain carried an ENTRY for this package whose target is gone (a legacy
 * link that outlived what it pointed at, so there is nothing to judge the row
 * by), and `n/s` — the chain never carried the package at all (nothing on disk
 * mentioned it; it may resolve nested in the CLI tree). Neither participates in
 * ahead/behind, but how many rows this gate cannot speak for, and why, is the
 * reading a line bump is checked against.
 * @param executed - the `executedVersion` result (or `undefined`).
 * @returns the verdict string.
 */
export function unmeasuredVerdict(executed) {
  return executed?.dangling !== undefined && executed.dangling.length > 0 ? 'no-evidence' : 'n/s'
}

/**
 * The gate proper: read the declaration line off the manifests, ask the
 * registry (in parallel, one request per package), measure the live profile's
 * resolution, print one line per package, then the mixed-line report and the
 * counts summary. Everything that touches the machine lives here so importing
 * the module for its pure seams is free of I/O (the shape this file shares
 * with `vendor-platform-src.mjs`).
 */
async function main() {
  const declaredBy = new Map() // name -> Set<version>
  for (const pkgPath of listManifests(ROOT)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        if (!isPlatformName(name) || typeof spec !== 'string') continue
        if (!declaredBy.has(name)) declaredBy.set(name, new Set())
        declaredBy.get(name).add(spec)
      }
    }
  }
  const names = [...declaredBy.keys()].sort()

  const registryBy = new Map()
  {
    const results = await Promise.all(names.map(async (name) => [name, await registryLine(name)]))
    for (const [name, line] of results) registryBy.set(name, line)
  }
  const registryUnreachable = [...registryBy.values()].every((line) => line === undefined)
  const registryAnswered = [...registryBy.values()].filter((line) => line !== undefined).length
  const registryMissing = names.length - registryAnswered
  // A PARTIAL answer is its own fact, and one this gate used to lose: every
  // lookup shares a 5s budget inside one Promise.all, so a few slow or blocked
  // requests degrade to `undefined` — printed as `?` — and the row still read
  // `[OK]`, indistinguishable from "this package has no candidate tag". The
  // count below is printed whenever any did not answer, and the rows themselves
  // say `no registry evidence` instead of a bare `?`
  // (dsh-conformance 2026-09-23, batch 5). The judgment stays non-red on a
  // missing network on purpose: this repository is offline-capable by design.
  if (registryMissing > 0) {
    console.log(`  registry line: ${registryAnswered}/${names.length} package(s) answered — ${registryMissing} have NO published-line evidence (unreachable, timed out, or absent from npm; their rows are marked)` )
  }

  if (!existsSync(PROFILE_DIR)) {
    console.log(`verify-execution-line: no live profile at ${PROFILE_DIR} — execution line unmeasured (CI sandbox); declared ${names.length} platform packages checked in manifests`)
    if (registryUnreachable) console.log('  registry line unreachable — published-line judgment skipped (declared explicitly)')
    process.exit(0)
  }

  const results = []
  const mixed = []
  const dangling = []
  for (const name of names) {
    const versions = [...declaredBy.get(name)]
    if (versions.length > 1) {
      mixed.push({ name, versions })
      continue
    }
    const declared = versions[0]
    const executed = executedVersion(name)
    if (executed?.dangling !== undefined && executed.dangling.length > 0) {
      dangling.push({ name, layers: executed.dangling })
    }
    if (executed?.version === undefined) {
      results.push({ verdict: unmeasuredVerdict(executed), name, declared })
      continue
    }
    results.push(classify({ name, declared, executed: executed.version, registry: registryBy.get(name) }))
  }

  const pad = (name) => ' '.repeat(Math.max(2, 47 - name.length))
  console.log(`verify-execution-line: ${PROFILE_DIR} live profile — declared (manifest pins) vs executed (live resolution) vs registry (npm dist-tags)`)
  const counts = { ok: 0, ahead: 0, behind: 0, unsupported: 0, 'n/s': 0, 'no-evidence': 0, fail: 0 }
  for (const result of results) {
    counts[result.verdict] += 1
    switch (result.verdict) {
      case 'ok':
        console.log(`  [OK]    ${result.name}${pad(result.name)}declared ${result.declared} = executed (@${result.executed}) = registry ${result.registry ?? '? (no registry evidence)'}`)
        break
      case 'ahead':
        console.log(`  [WARN]  ${result.name}${pad(result.name)}declared ${result.declared} < executed ${result.executed} — 执行线随 checkout，固有 (registry ${result.registry ?? '? (no registry evidence)'})`)
        break
      case 'behind':
        console.log(`  [BEHIND]${result.name}${pad(result.name)}declared ${result.declared} < registry ${result.registry} — 平台已发新版，移植到期 (executed ${result.executed ?? '?'})`)
        break
      case 'unsupported':
        console.log(`  [UNSUP] ${result.name}${pad(result.name)}executed ${result.executed} > registry ${result.registry} — 跑在未发布线上 (declared ${result.declared})`)
        break
      case 'fail':
        console.log(`  [FAIL]  ${result.name}${pad(result.name)}declared ${result.declared} > executed ${result.executed} — 降级：run 线落后声明线`)
        break
      case 'no-evidence':
        console.log(`  [NO-EV] ${result.name}${pad(result.name)}declared ${result.declared}; the projection carries an ENTRY whose target is gone — no executed version to judge this row by (see [DANGLING] below)`)
        break
      default:
        console.log(`  [n/s]   ${result.name}${pad(result.name)}declared ${result.declared}; not resolvable through the on-disk projection (no legacy link, or it resolves nested in the CLI tree) — unmeasured`)
    }
  }
  for (const { name, versions } of mixed) console.log(`  [FAIL]  ${name}${pad(name)}mixed declaration: ${versions.join(', ')}`)
  for (const { name, layers } of dangling) {
    console.log(`  [DANGLING] ${name}${pad(name)}projection entry exists but its target is gone in: ${layers.join(', ')} — a legacy link outlived what it pointed at; do not read this row's executed version as the runtime's`)
  }

  const executedLines = summarizeExecutedLines(results)
  if (executedLines !== undefined) {
    console.log(`  [MIXED-EXEC] the live execution line spans ${executedLines.deviating.length + 1} versions — majority ${executedLines.line} (${executedLines.count} packages)`)
    for (const { version, names } of executedLines.deviating) {
      console.log(`      ${version}: ${names.join(', ')}`)
    }
    console.log('      a bundle that depends on a platform package directly gets a profile-local projection of it；the projected copy follows OUR pin, not the checkout')
  }

  const bundles = profileBundles()
  if (bundles !== undefined) console.log(`  profile (diagnostic): bundles ${bundles.join(', ')} — the profile records no platform version by design; the bundle layer resolves it at launch`)

  // `no-evidence` is its own column: those rows did reach a projection entry,
  // it is just broken, so they are "cannot speak for this row" rather than
  // "nothing on disk mentioned it" — and neither participates in ahead/behind.
  console.log(`verify-execution-line: ${counts.ok} OK, ${counts.ahead} ahead(固有), ${counts.behind} behind(registry), ${counts.unsupported} unsupported(unreleased), ${counts['n/s']} no-shortcut, ${counts['no-evidence']} no-evidence, ${counts.fail} downgraded, ${mixed.length} mixed-declaration${registryUnreachable ? '; registry unreachable — published-line judgment skipped' : ''}`)
  if (exitCodeFor(counts, mixed) !== 0) {
    console.error('verify-execution-line: FAIL — the live execution line is BEHIND (or mixed against) the declared pin line; re-ensure the profile (or move the checkout) so the run line is not older than what the gates verified')
    process.exit(1)
  }
  console.log('verify-execution-line: OK')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
