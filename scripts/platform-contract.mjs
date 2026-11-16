#!/usr/bin/env node
/**
 * The platform-contract half of the T3/T4/T5 checks: the vendored-source lock,
 * the profile-shape comparator, and the platform-module table parser.
 *
 * The split of duties (plan 2026-09-13 §C2):
 * - **T3** (`vendor-platform-src.mjs --record/--check`) owns the lock: where each
 *   vendored tree came from (an immutable commit of the declared line), which
 *   files it holds, and their digest.
 * - **T4** (inside `verify-deployment-descriptor.mjs`) compares the profile this
 *   repo generates against the official `initProfile` sample, normalized for the
 *   differences that are OURS by design.
 * - **T5** (`verify-platform-modules.mjs`) compares the two local copies of the
 *   platform's shared-module table with the lock's snapshot of the real one.
 *
 * What a digest proves and what it does not: it proves the local snapshot still
 * matches what was recorded (and matches the tag when a checkout is available).
 * It is NOT an upstream signature — the first recording is what binds the two,
 * and that is why the tag's commit is recorded too.
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** The lock file holding the vendored-source provenance (T3) and the T5 snapshot. */
export const PLATFORM_LOCK = 'scripts/platform-src-lock.json'

/** The vendored trees: checkout-relative `src` path, lock name, and destination. */
export const VENDOR_PAIRS = [
  ['api/gateway', 'dsh-api-gateway'],
  ['api/session-controller', 'dsh-api-session-controller'],
  ['client/connection', 'dsh-client-connection'],
  ['client/locale', 'dsh-client-locale'],
  ['client/store', 'dsh-client-store'],
  ['client/ui-chat', 'dsh-client-ui-chat'],
  ['client/ui-context-menu', 'dsh-client-ui-context-menu'],
  ['client/ui-conversation', 'dsh-client-ui-conversation'],
  ['client/ui-session', 'dsh-client-ui-session'],
  ['llm/token-meter', 'dsh-token-meter'],
  ['test-support/client-runtime', 'dsh-client-test-runtime'],
  ['client/ui-renderer', 'dsh-client-ui-renderer'],
  // The typert protocol shell (`packages/typert/protocol`) is deliberately NOT
  // vendored here: the test plane follows the declared line, but the shell is
  // the build plane's type face and follows the **checkout** (its generator
  // does — see `scripts/platform-checkout.mjs`). `vendor-platform-src.mjs
  // --check` compares it against the checkout instead of the tag.
]

/** The platform file whose exported table T5 compares against (bound to the recorded commit). */
export const PLATFORM_MODULES_SOURCE = 'packages/client/web/src/platform.ts'

/**
 * The vendored destination of one pair, relative to the repo root.
 * @param {[string, string]} pair - one {@link VENDOR_PAIRS} entry.
 * @returns {string} the destination directory.
 */
export function targetOf(pair) {
  const [, name] = pair
  return `.platform-src/${name}/src`
}

/**
 * Every file under `dir`, as repo-relative POSIX paths, sorted.
 * @param {string} dir - the directory to walk.
 * @param {string} [base] - the base the relative paths are taken from.
 * @returns {string[]} the sorted relative file paths.
 */
export function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(abs, base))
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join('/'))
  }
  return out.sort()
}

/**
 * The digest of one tree: every file's relative path and content hash, in sorted
 * order — so an added, removed, renamed, or edited file all change it.
 * @param {string} dir - the tree to digest.
 * @returns {{ files: number, digest: string }} the file count and the `sha256:<hex>` digest.
 */
export function digestTree(dir) {
  const files = listFiles(dir)
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'))
    hash.update('\n')
  }
  return { files: files.length, digest: `sha256:${hash.digest('hex')}` }
}

/**
 * Read the lock file.
 * @param {string} root - the repo root.
 * @returns {object} the parsed lock.
 * @throws {Error} when the lock is missing or unparseable (a FAIL condition, never a silent skip).
 */
export function readLock(root) {
  const path = join(root, PLATFORM_LOCK)
  if (!existsSync(path)) throw new Error(`${PLATFORM_LOCK} is missing — record it: node scripts/vendor-platform-src.mjs --record`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${PLATFORM_LOCK} is unreadable (${String(error)}) — re-record it: node scripts/vendor-platform-src.mjs --record`)
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.targets)) {
    throw new Error(`${PLATFORM_LOCK} is malformed (no targets array) — re-record it: node scripts/vendor-platform-src.mjs --record`)
  }
  return parsed
}

/**
 * Compare the working tree against the lock (the CI-side, checkout-free check).
 * @param {string} root - the repo root.
 * @param {object} lock - the parsed lock.
 * @returns {{ failures: string[], checked: number }} drift failures and how many trees were compared.
 */
export function compareTreesToLock(root, lock) {
  const failures = []
  for (const target of lock.targets) {
    const dir = join(root, target.to)
    if (!existsSync(dir)) {
      failures.push(`${target.to} is missing (recorded ${target.files} file(s), ${target.digest})`)
      continue
    }
    const current = digestTree(dir)
    if (current.files !== target.files || current.digest !== target.digest) {
      failures.push(`${target.to} drifted: recorded ${target.files} file(s) ${target.digest}, found ${current.files} file(s) ${current.digest}`)
    }
  }
  return { failures, checked: lock.targets.length }
}

/**
 * Parse the platform's `PLATFORM_MODULES` static array out of its source text.
 * Only an explicit `export const PLATFORM_MODULES = [ ... ]` literal is
 * accepted: a generated or computed table must FAIL (and require the parser to
 * be updated), never silently parse as an empty list.
 * @param {string} source - the platform source file's text.
 * @returns {string[]} the module specifiers, in declaration order.
 * @throws {Error} when the table is absent or not a literal array of strings.
 */
export function parsePlatformModules(source) {
  const start = source.indexOf('export const PLATFORM_MODULES')
  if (start === -1) throw new Error('PLATFORM_MODULES is not exported from the platform source — update the parser')
  const open = source.indexOf('[', start)
  const close = source.indexOf(']', open)
  if (open === -1 || close === -1 || close < open) throw new Error('PLATFORM_MODULES is not a literal array — update the parser')
  const inner = source.slice(open + 1, close)
  const specifiers = [...inner.matchAll(/'([^']+)'/gu)].map(match => match[1])
  // Every non-empty, non-comment segment must be a quoted string; anything else
  // (a spread, a computed entry) means the table is no longer a static literal.
  const leftovers = inner
    .replace(/'[^']*'/gu, '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
  if (leftovers.length > 0) throw new Error(`PLATFORM_MODULES carries non-literal entries (${leftovers.join(' ')}) — update the parser`)
  if (specifiers.length === 0) throw new Error('PLATFORM_MODULES parsed as empty — refusing to treat that as a pass')
  return specifiers
}

/**
 * Parse a local `PLATFORM_MODULES` array out of one of this repo's files (the
 * same literal rule as {@link parsePlatformModules}).
 * @param {string} file - the file path (for the error message).
 * @returns {string[]} the module specifiers.
 */
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
