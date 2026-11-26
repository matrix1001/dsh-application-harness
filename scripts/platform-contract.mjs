#!/usr/bin/env node
/**
 * The platform contracts this repo still shares with the published line:
 *
 * - the local shared-module table parser (`PLATFORM_MODULES` in our own two
 *   copies) — the platform's upstream table is not published as a package, so
 *   the two local copies are compared with each other;
 * - the profile-shape comparator (`initProfile` sample vs the profile this repo
 *   generates), used by `verify-deployment-descriptor.mjs`;
 * - the installed-package locator for the official profile packages.
 *
 * Everything that used to compare against a platform checkout (vendored trees,
 * digests, the lock) is gone: the repo depends on the published line only.
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function parseLocalPlatformModules(file) {
  const source = readFileSync(file, 'utf8')
  const start = source.indexOf('const PLATFORM_MODULES')
  if (start === -1) throw new Error(`${file}: PLATFORM_MODULES not found`)
  const open = source.indexOf('[', start)
  const close = source.indexOf('] as const', open)
  const end = close === -1 ? source.indexOf(']', open) : close
  if (open === -1 || end === -1) throw new Error(`${file}: PLATFORM_MODULES is not a literal array`)
  const inner = source.slice(open + 1, end)
  const specifiers = [...inner.matchAll(/'([^']+)'/gu)].map(match => match[1])
  if (specifiers.length === 0) throw new Error(`${file}: PLATFORM_MODULES parsed as empty`)
  return specifiers
}

/**
 * Read one profile manifest into its comparable shape.
 *
 * `patchReload` is deliberately NOT normalized: platform 0.1.6-alpha.2 deleted
 * it from the loader's `initProfile` template, and the former `?? 'live'`
 * default made the old comparison compare two values this function had just
 * invented — vacuously true. The field is now asserted ABSENT instead (see
 * `compareProfileShape`).
 * @param {unknown} manifest - the parsed manifest.
 * @returns {{ private: unknown, name: unknown, dependencies: unknown, bundles: unknown, patchReload: unknown }} the fields the contract pins.
 */
export function normalizeProfileManifest(manifest) {
  const profile = manifest?.dsh?.profile ?? {}
  return {
    private: manifest?.private,
    name: manifest?.name,
    dependencies: manifest?.dependencies,
    bundles: profile.bundles,
    patchReload: profile.patchReload,
  }
}

/** Whether a value is a plain object (not null, not an array). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The shape label of one manifest field (its type, for the type-level comparison). */
function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Compare the official `initProfile` sample with the profile this repo
 * generates — a real structural comparison of BOTH sides, not a checklist
 * against values hardcoded from one platform snapshot (the earlier version
 * never read the official sample's pnpm settings or patch shape, so a change
 * there — or a mutated sample — passed silently; the review's repro).
 *
 * Compared: the required file set; the manifest's field TYPES (`private`,
 * `name`'s `dsh-profile-` shape, `dependencies` object, `bundles` string array,
 * `patchReload` absent); the pnpm settings the platform requires
 * (`packages` / `nodeLinker` / `autoInstallPeers`, value-for-value against the
 * official sample); and the patch file's top-level shape.
 *
 * Normalized away (the differences that are ours BY DESIGN, per the plan):
 * dependency `link:` paths and their count, the bundle LIST content, the
 * profile's own name, and comment text.
 * @param {{ official: string, ours: string, parseYaml: (text: string) => unknown }} options - the two profile dirs and the YAML parser.
 * @returns {string[]} one failure per mismatch (empty = aligned).
 */
export function compareProfileShape({ official, ours, parseYaml }) {
  const failures = []
  const required = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']
  for (const file of required) {
    if (!existsSync(join(official, file))) failures.push(`the official sample has no ${file} — the platform's initProfile contract changed`)
    if (!existsSync(join(ours, file))) failures.push(`the generated profile is missing the required file ${file}`)
  }
  if (failures.length > 0) return failures

  const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const officialShape = normalizeProfileManifest(readJson(official, 'package.json'))
  const ourShape = normalizeProfileManifest(readJson(ours, 'package.json'))

  // The official side IS the contract: a sample that stops looking like a
  // profile means the assumption must be re-derived, not silently tolerated.
  if (officialShape.private !== true) failures.push('the official sample is not private — the contract assumption is stale')
  if (typeof officialShape.name !== 'string' || !officialShape.name.startsWith('dsh-profile-')) {
    failures.push('the official sample name is no longer `dsh-profile-<name>` — the contract assumption is stale')
  }
  if (!isPlainObject(officialShape.dependencies)) failures.push('the official sample dependencies are no longer an object — the contract assumption is stale')
  if (!Array.isArray(officialShape.bundles) || !officialShape.bundles.every(bundle => typeof bundle === 'string')) {
    failures.push('the official sample dsh.profile.bundles is no longer a string array — the contract assumption is stale')
  }
  // patchReload was deleted from the loader's profile template in 0.1.6-alpha.2
  // (what it used to decide is now the composition's `dsh-hmr` row). Asserting
  // its ABSENCE keeps a real signal where the vocabulary check had none: a field
  // written back under the old semantics is silently ignored by the loader, and
  // only an explicit negative catches that.
  if (officialShape.patchReload !== undefined) {
    failures.push(`the official sample carries dsh.profile.patchReload (${JSON.stringify(officialShape.patchReload)}) — the field returned to the platform template; re-derive the contract instead of trusting this reverse assertion`)
  }

  // …and ours must carry the same TYPES, not merely "some" value.
  if (ourShape.private !== true) failures.push('the generated profile manifest must set private: true')
  if (typeof ourShape.name !== 'string' || !ourShape.name.startsWith('dsh-profile-')) {
    failures.push('the generated profile manifest name must be `dsh-profile-<profile>`')
  }
  if (!isPlainObject(ourShape.dependencies)) failures.push('the generated profile manifest must carry a dependencies object')
  if (typeOf(ourShape.bundles) !== typeOf(officialShape.bundles)) {
    failures.push(`dsh.profile.bundles must be ${typeOf(officialShape.bundles)} (found ${typeOf(ourShape.bundles)})`)
  } else if (!ourShape.bundles.every(bundle => typeof bundle === 'string')) {
    failures.push('dsh.profile.bundles must contain only strings')
  }
  // The reverse assertion: the field must be ABSENT. It was removed in
  // 0.1.6-alpha.2 and the loader ignores it, so a value here is either a stale
  // writer or a typo — both worth reddening, neither worth comparing.
  if (ourShape.patchReload !== undefined) {
    failures.push(`dsh.profile.patchReload must be absent (found ${JSON.stringify(ourShape.patchReload)}) — the platform dropped the field in 0.1.6-alpha.2`)
  }

  // The patch layer: both sides must be the same top-level shape, and ours must
  // satisfy whatever element predicate the official template sets.
  const officialPatch = parseYaml(readFileSync(join(official, 'cordis.patch.yml'), 'utf8'))
  const ourPatch = parseYaml(readFileSync(join(ours, 'cordis.patch.yml'), 'utf8'))
  for (const [label, value] of [['the official sample', officialPatch], ['the generated profile', ourPatch]]) {
    if (!Array.isArray(value)) failures.push(`${label} cordis.patch.yml must be a top-level array (found ${typeOf(value)})`)
  }
  if (Array.isArray(officialPatch) && Array.isArray(ourPatch)) {
    const officialElement = officialPatch.length === 0 ? undefined : typeOf(officialPatch[0])
    if (officialElement !== undefined) {
      const mismatch = ourPatch.find(entry => typeOf(entry) !== officialElement)
      if (mismatch !== undefined) {
        failures.push(`cordis.patch.yml entries must be ${officialElement} like the official sample (found ${typeOf(mismatch)})`)
      }
    } else if (ourPatch.length > 0) {
      // The shipped template is an EMPTY array: a generated profile that adds
      // entries is where the user layer stops being the empty layer the
      // deployment descriptor claims.
      failures.push(`the official template is an empty array, but the generated user layer carries ${ourPatch.length} entry(ies)`)
    }
  }

  // The pnpm settings: the OFFICIAL sample's values are the requirement, so a
  // platform change (or a mutated sample) is caught by comparing against it.
  const officialWorkspace = parseYaml(readFileSync(join(official, 'pnpm-workspace.yaml'), 'utf8'))
  const ourWorkspace = parseYaml(readFileSync(join(ours, 'pnpm-workspace.yaml'), 'utf8'))
  if (!isPlainObject(officialWorkspace)) {
    failures.push('the official sample pnpm-workspace.yaml is not a mapping — the contract assumption is stale')
    return failures
  }
  for (const key of ['packages', 'nodeLinker', 'autoInstallPeers']) {
    if (officialWorkspace[key] === undefined) {
      failures.push(`the official sample pnpm-workspace.yaml declares no ${key} — the platform requirement changed`)
      continue
    }
    if (JSON.stringify(ourWorkspace?.[key]) !== JSON.stringify(officialWorkspace[key])) {
      failures.push(`pnpm-workspace.yaml ${key} must be ${JSON.stringify(officialWorkspace[key])} like the official sample (found ${JSON.stringify(ourWorkspace?.[key])})`)
    }
  }
  return failures
}

/**
 * Locate the installed platform package that publishes the official
 * `initProfile` for the DECLARED line. A missing package or a version that does
 * not match the declared line is a configuration error on this line (fail
 * closed); only an optional checkout may degrade to UNVERIFIED.
 * @param {{ root: string, declaredLine: string, exists?: (path: string) => boolean, readJson?: (path: string) => unknown }} options - the repo root and the declared line.
 * @returns {{ status: 'ok', version: string, manifest: string } | { status: 'missing', manifest: string } | { status: 'mismatch', version: string, manifest: string }} the verdict.
 */
export function officialAppBoot(options) {
  return officialPlatformPackage('dsh-app-boot', options)
}

/**
 * Locate the installed package that publishes the official bundle lists
 * (`DEFAULT_PROFILE_BUNDLES`, `PROFILE_TEMPLATES`). The list moved out of
 * `dsh-app-boot` in 0.2.2; T4 needs both packages from the declared line.
 * @param {{ root: string, declaredLine: string, exists?: (path: string) => boolean, readJson?: (path: string) => unknown }} options - the repo root and the declared line.
 * @returns the same verdict shape as {@link officialAppBoot}.
 */
export function officialBundleLists(options) {
  return officialPlatformPackage('dsh-official-bundles', options)
}

/** Read one installed platform package's version and compare it with the declared line. */
function officialPlatformPackage(name, { root, declaredLine, exists = existsSync, readJson = (path) => JSON.parse(readFileSync(path, 'utf8')) }) {
  const manifest = join(root, 'node_modules', '@deepseek-ai', name, 'package.json')
  if (!exists(manifest)) return { status: 'missing', manifest }
  const installed = readJson(manifest)
  if (installed?.version !== declaredLine) return { status: 'mismatch', version: String(installed?.version), manifest }
  return { status: 'ok', version: String(installed.version), manifest }
}
