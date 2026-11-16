#!/usr/bin/env node
/**
 * Reconciliation of the reference plane against the platform package set
 * (origin: `PL1 step ②` of the pre-2026-09-13 backlog, recorded as
 * "T8 平台包集合对账门"; that backlog now lives only in git history):
 * every `@deepseek-ai/dsh*` name we reference must exist on
 * the platform line. The three package renames of the 0.1.6 line
 * (`code-runtime*` → `ptc-runtime*`, `workflow-worker-thread` → `workflow-ptc`)
 * are exactly the failure this catches — and it also covers the two inert
 * mirror lists in `pnpm-workspace.yaml` (`overrides`, `minimumReleaseAgeExclude`),
 * which `pnpm install` cannot police: the resolver reads them, the dependency
 * graph never sees them, so a stale name there fails in no other gate.
 *
 * Reference plane: `dependencies`/`devDependencies`/`peerDependencies` of the
 * root manifest and of every `packages/<group>/<pkg>/package.json`, plus the
 * `overrides` names and `minimumReleaseAgeExclude` entries of
 * `pnpm-workspace.yaml` (each entry carries `@version`, which is stripped).
 * The plane is deliberately RAW: the platform filter belongs to `diffSets`, so
 * the names this repo owns stay visible in the report.
 *
 * Available plane: the checkout's package set as the checkout ITSELF declares
 * it — the `packages` globs of its `pnpm-workspace.yaml` (the package tier,
 * `apps/*`, `vendor/*`, …). Scanning the package tier alone would be wrong:
 * `@deepseek-ai/dsh` (the CLI bin) lives in `apps/cli` and
 * `@deepseek-ai/dsh-web-frontend` in `apps/web`, and we reference both — a gate
 * that called them missing would be crying wolf on names that plainly exist,
 * which is how a gate gets switched off. Reading the platform's own
 * declaration also keeps test fixtures buried inside the package tier (the
 * typert generator's fixture workspaces) out of the answer.
 *
 * No checkout (CI) → UNVERIFIED, exit 0 — the same convention as
 * `vendor-platform-src --check`.
 * @module
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The platform's naming convention. A regex over the name, not a registry
 * lookup, and the gate's whole filter: `@deepseek-ai/dsh` itself matches (the
 * `-` or end alternative), while this repo's own `@matrix1001/dsh-application-harness-*`
 * packages and the vendored `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`
 * edges do not.
 */
const PLATFORM_NAME = /^@deepseek-ai\/dsh(-|$)/u

/** Manifest sections that make a name a reference (`optionalDependencies` is not used in this repo). */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']

/** Where a checkout's packages are looked for when it declares no workspace globs. */
const WORKSPACE_FALLBACK = ['packages/*/*']

/**
 * Whether a name is a platform package.
 * @param name - the package name.
 * @returns the verdict.
 */
function platformName(name) {
  return typeof name === 'string' && PLATFORM_NAME.test(name)
}

/**
 * Drop the `@version` a `minimumReleaseAgeExclude` entry carries. The last `@`
 * is the separator (`@scope/name@1.2.3`); a bare name (index 0, or none) is
 * already a name.
 * @param entry - the workspace entry.
 * @returns the package name.
 */
function stripVersion(entry) {
  const at = entry.lastIndexOf('@')
  return at > 0 ? entry.slice(0, at) : entry
}

/**
 * Every name this repo refers to, with the files that refer to it. The sites
 * are what makes a FAIL actionable: a rename arrives as "this name is gone",
 * and the fix starts at the manifest or workspace list that still names it.
 * @param root - the repo root.
 * @returns a Map from package name to its sorted, root-relative sources.
 */
export function referenceSites(root = ROOT) {
  const sites = new Map()
  const record = (name, site) => {
    if (typeof name !== 'string' || name === '') return
    const existing = sites.get(name)
    if (existing === undefined) sites.set(name, [site])
    else if (!existing.includes(site)) existing.push(site)
  }
  const readManifest = (path, site) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) record(name, site)
    }
  }
  readManifest(join(root, 'package.json'), 'package.json')
  const groups = join(root, 'packages')
  if (existsSync(groups)) {
    for (const group of readdirSync(groups)) {
      const groupDir = join(groups, group)
      if (!statSync(groupDir).isDirectory()) continue
      for (const entry of readdirSync(groupDir)) {
        const manifestPath = join(groupDir, entry, 'package.json')
        if (!existsSync(manifestPath)) continue
        readManifest(manifestPath, `packages/${group}/${entry}/package.json`)
      }
    }
  }
  const workspacePath = join(root, 'pnpm-workspace.yaml')
  if (existsSync(workspacePath)) {
    const workspace = parseYaml(readFileSync(workspacePath, 'utf8'))
    for (const name of Object.keys(workspace?.overrides ?? {})) record(name, 'pnpm-workspace.yaml (overrides)')
    for (const entry of workspace?.minimumReleaseAgeExclude ?? []) {
      record(stripVersion(entry), 'pnpm-workspace.yaml (minimumReleaseAgeExclude)')
    }
  }
  for (const list of sites.values()) list.sort()
  return sites
}

/**
 * The reference plane as a sorted name list, unfiltered (see `diffSets`).
 * @param root - the repo root.
 * @returns the names.
 */
export function referencedNames(root = ROOT) {
  return [...referenceSites(root).keys()].sort()
}

/**
 * The package globs a checkout declares as its own workspace. An unreadable
 * declaration THROWS rather than quietly shrinking the available plane: a
 * smaller set would turn into false "missing" verdicts, and a wrong list is
 * worse than a loud stop.
 * @param checkout - the platform checkout root.
 * @returns the globs.
 */
function workspaceGlobs(checkout) {
  const path = join(checkout, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return WORKSPACE_FALLBACK
  const declared = parseYaml(readFileSync(path, 'utf8'))?.packages
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`${path} declares no packages: list — the platform package set cannot be read from it`)
  }
  return declared
}

/**
 * Expand one workspace glob to directories. Only the forms the platform's own
 * file uses are supported — literal paths and `*` segments — because a pattern
 * this resolver silently mis-reads would shrink the available plane.
 * @param checkout - the platform checkout root.
 * @param pattern - one `packages` entry.
 * @returns the matched directories (existing ones for `*` segments; a literal is returned whether or not it exists).
 */
function matchWorkspaceGlob(checkout, pattern) {
  if (pattern.startsWith('!') || pattern.includes('**')) {
    throw new Error(`${pattern}: this gate expands literal paths and single-segment * globs only — update the resolver`)
  }
  let current = [checkout]
  for (const segment of pattern.split('/')) {
    if (segment === '') continue
    const next = []
    for (const base of current) {
      if (segment !== '*') {
        next.push(join(base, segment))
        continue
      }
      if (!existsSync(base)) continue
      for (const entry of readdirSync(base)) {
        const candidate = join(base, entry)
        if (statSync(candidate).isDirectory()) next.push(candidate)
      }
    }
    current = next
  }
  return current
}

/**
 * The names available on the platform line: every package in the checkout's
 * own workspace globs that carries a manifest.
 * @param checkout - the platform checkout root.
 * @returns the sorted names.
 */
export function platformNamesFromCheckout(checkout) {
  const names = new Set()
  for (const glob of workspaceGlobs(checkout)) {
    for (const dir of matchWorkspaceGlob(checkout, glob)) {
      const manifestPath = join(dir, 'package.json')
      // A matched directory without a manifest is not a package (a group dir, a
      // docs folder): it contributes no name and is not an error.
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string' && manifest.name !== '') names.add(manifest.name)
    }
  }
  return [...names].sort()
}

/**
 * Compare the two planes. The filter lives HERE, on both sides: only
 * `@deepseek-ai/dsh*` names are compared, so the caller may hand over the raw
 * lists and this repo's own workspace packages / vendored edges can never
 * appear as missing.
 * @param options - the two name lists.
 * @returns `{ missing, unused }`, both sorted.
 */
export function diffSets({ referenced, available }) {
  const referencedPlatform = [...new Set(referenced.filter(platformName))].sort()
  const availablePlatform = new Set(available.filter(platformName))
  return {
    missing: referencedPlatform.filter((name) => !availablePlatform.has(name)),
    unused: [...availablePlatform].filter((name) => !referencedPlatform.includes(name)).sort(),
  }
}

/**
 * Run the gate.
 * @param options - the repo root, the platform checkout (undefined = none), and the log seats.
 * @returns the exit code (0 = OK or UNVERIFIED, 1 = FAIL).
 */
export function verify({ root = ROOT, checkout, log = console.log, error = console.error } = {}) {
  const sites = referenceSites(root)
  const referenced = [...sites.keys()].sort()
  const platformReferenced = referenced.filter(platformName)
  if (checkout === undefined) {
    log(`verify-platform-package-set: UNVERIFIED — no platform checkout; ${platformReferenced.length} referenced platform name(s) were not reconciled against the line`)
    return 0
  }
  let available
  try {
    available = platformNamesFromCheckout(checkout)
  } catch (cause) {
    error(`verify-platform-package-set: FAIL — the checkout's package set could not be read: ${String(cause?.message ?? cause)}`)
    return 1
  }
  const { missing, unused } = diffSets({ referenced, available })
  if (missing.length > 0) {
    error(`verify-platform-package-set: FAIL — ${missing.length} referenced platform name(s) do not exist on the platform line (${checkout}):`)
    for (const name of missing) error(`  - ${name} — referenced by ${sites.get(name).join(', ')}`)
    error('  a rename on the platform line arrives here first: fix the name at the site(s) above, then re-run')
    return 1
  }
  log(`verify-platform-package-set: OK — ${platformReferenced.length} referenced platform names all exist (${available.length} available on the line, ${unused.length} unreferenced)`)
  return 0
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
