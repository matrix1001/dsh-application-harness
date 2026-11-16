#!/usr/bin/env node
/**
 * The deployment package set, profile-path resolution, and launch preflight —
 * **one read-only source** for `setup.mjs` (which installs the profile),
 * `dev-apps.mjs` (which verifies the link channel), and `launch-apps.mjs`
 * (which pre-checks the checkout launch).
 *
 * The set is defined by **explicit package areas plus the application-harness naming
 * rule** — deliberately NOT by `private` and NOT by "a `lib/` directory
 * exists":
 *
 * - `packages/typert/protocol` is a private **build shell** (the generator's
 *   vendored snapshot). It has build output and is not deployed; a `lib/`-based
 *   rule demanded a deployment entry for it (2026-09-10 false alarm).
 * - An application package that has **not been built yet** still belongs to the
 *   deployment set: skipping it because `lib/` is absent would hide exactly the
 *   problem the check exists to report.
 *
 * The profile path resolves ONCE, from `$DSH_HOME` → `homedir()` → the profile
 * name, so a custom `DSH_HOME` never inspects the default profile.
 *
 * The preflight resolves the **entry points that will actually load** from the
 * deployment descriptor (`.yml`) plus each package's own `exports` map, and
 * checks those files exist — and, since AR2 ②, that a mounted row's artifact is
 * not older than the sources it was built from (a host entry as much as a
 * client bundle). It deliberately does not demand an artifact for every
 * optional platform client: the platform's own build owns those. What it still
 * never proves is "the artifacts are runnable" — that stays the build's, the
 * smoke's and the browser e2e's job.
 * @module
 */

import { existsSync, readFileSync, readdirSync, realpathSync as realpathSyncNode, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { load as parseYamlRaw, DEFAULT_SCHEMA, Type } from 'js-yaml'

/** The package areas whose `@matrix1001/dsh-application-harness*` packages the profile deploys, in order. */
export const PACKAGE_AREAS = ['packages/application', 'packages/client', 'packages/examples']

/**
 * The tolerance of the stale-artifact check (PL4, extended to host rows by
 * AR2 ② 2026-09-19), in milliseconds: a single checkout or install writes
 * `src/` and `lib/` in filesystem order, so the sources can end up marginally
 * newer than a freshly built artifact. Only a REAL edit (seconds and beyond) is
 * reported as stale.
 */
export const STALE_ENTRY_GRACE_MS = 2000

/**
 * The newest mtime (ms) under `<dir>/src`, or `undefined` when there is no
 * source tree (a published-only package cannot be stale this way).
 * @param {string} dir - the package directory.
 * @returns {number | undefined} the newest source mtime.
 */
export function newestSourceMtime(dir) {
  const base = join(dir, 'src')
  if (!existsSync(base)) return undefined
  let newest
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const at = statSync(path).mtimeMs
        if (newest === undefined || at > newest) newest = at
      }
    }
  }
  walk(base)
  return newest
}

/** The bundle package's manifest path, relative to the repo root (deployed like the rest). */
export const BUNDLE_MANIFEST = 'packages/bundle/app-harness/package.json'

/** The deployment descriptor: the declaration the preflight reads its package sets from. */
export const DEPLOYMENT_DESCRIPTOR = 'packages/bundle/app-harness/deployment.yml'

/** The default profile name. */
export const PROFILE_DEFAULT = 'application-harness'

/** This module's own checkout root (the caller's root stays injectable). */
export const OWN_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

/** Whether a package name is one this harness deploys (the naming rule, not a directory heuristic). */
export function isDeploymentPackageName(name) {
  return typeof name === 'string' && (name === '@matrix1001/dsh-application-harness' || name.startsWith('@matrix1001/dsh-application-harness-'))
}

/**
 * Every manifest path in the deployment areas, plus the bundle package.
 * @param {string} root - the repo root.
 * @returns {string[]} absolute `package.json` paths that exist.
 */
export function workspaceManifests(root) {
  const out = []
  for (const group of PACKAGE_AREAS) {
    const base = join(root, group)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      const abs = join(base, entry, 'package.json')
      if (existsSync(abs)) out.push(abs)
    }
  }
  const bundle = join(root, BUNDLE_MANIFEST)
  if (existsSync(bundle)) out.push(bundle)
  return out
}

/**
 * Map every deployed `@matrix1001/dsh-application-harness*` package to its absolute
 * directory — the same set `setup.mjs` writes as `link:` dependencies.
 * @param {string} root - the repo root.
 * @returns {Map<string, string>} name → absolute package directory.
 */
export function deploymentPackages(root) {
  const map = new Map()
  for (const manifest of workspaceManifests(root)) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch {
      continue
    }
    if (isDeploymentPackageName(parsed.name)) map.set(parsed.name, dirname(manifest))
  }
  return map
}

/**
 * Resolve the harness home once: `$DSH_HOME` when set and non-empty, else
 * `<homedir>/.dsh`.
 * @param {Record<string, string | undefined>} [env] - the environment (defaults to `process.env`).
 * @param {string} [home] - the user's home directory (defaults to `homedir()`).
 * @returns {string} the resolved harness home.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(home, '.dsh')
}

/**
 * Resolve a profile directory from the harness home and the profile name.
 * @param {{ dshHome?: string, profile?: string, env?: Record<string, string | undefined>, home?: string }} [options] - overrides.
 * @returns {string} the profile directory (not necessarily existing).
 */
export function resolveProfileDir(options = {}) {
  const home = options.dshHome ?? resolveDshHome(options.env ?? process.env, options.home ?? homedir())
  const profile = options.profile ?? PROFILE_DEFAULT
  return join(home, 'profiles', profile)
}

/**
 * The directory the profile's deployed packages are installed under. The
 * package NAME passed to {@link checkDeploymentEntries} is the full scoped name,
 * so this is the profile's `node_modules` (not the scope directory under it).
 * @param {string} profileDir - the profile directory.
 * @returns {string} the profile's node_modules directory.
 */
export function deploymentDirOf(profileDir) {
  return join(profileDir, 'node_modules')
}

/**
 * Split a package specifier into its package name and optional subpath.
 * @param {string} specifier - e.g. `@matrix1001/dsh-application-harness-store/atomic`.
 * @returns {{ name: string, subpath: string }} the name (scope + first segment) and the subpath (`''` for the root).
 */
export function splitSpecifier(specifier) {
  const parts = specifier.split('/')
  const name = parts.slice(0, 2).join('/')
  return { name, subpath: parts.slice(2).join('/') }
}

/**
 * Verify every deployed package's profile entry resolves back at this
 * workspace: the official-channel deployment is a `link:` symlink, so its
 * realpath must be the package directory. A missing entry, a stale copy, or an
 * unresolvable link is reported.
 * @param {{ packages: Map<string, string>, deploymentDir: string, realpathSync?: (path: string) => string }} options - the deployment set and the profile's scoped dir.
 * @returns {string[]} one human-readable problem per package (empty = all good).
 */
export function checkDeploymentEntries({ packages, deploymentDir, realpathSync = realpathSyncNode }) {
  const problems = []
  for (const [name, dir] of packages) {
    const entry = join(deploymentDir, name)
    // No `existsSync` gate: it swallows exactly the errors worth distinguishing
    // (a dangling link reads as "absent", a symlink loop as "absent" too), so
    // the classification comes from realpath's own failure instead.
    try {
      if (realpathSync(entry) !== realpathSync(dir)) {
        problems.push(`${name}: deployment entry resolves elsewhere (a stale copy?) — re-run node scripts/setup.mjs`)
      }
    } catch (error) {
      const code = error?.code
      problems.push(code === 'ENOENT'
        ? `${name}: deployment entry absent — run node scripts/setup.mjs to (re)build the profile`
        : `${name}: deployment entry unresolvable (${code ?? 'unknown'}) — re-run node scripts/setup.mjs`)
    }
  }
  return problems
}

/**
 * The build artifact one package exports under a subpath (its `default` target).
 * @param {string} pkgDir - the package directory.
 * @param {string} subpath - `''` for the root export, else the subpath name.
 * @returns {{ file: string, specifier: string } | undefined} the resolved target, or undefined when the package does not export it.
 */
export function exportedEntry(pkgDir, subpath) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const key = subpath === '' ? '.' : `./${subpath}`
  const target = manifest.exports?.[key]
  const file = typeof target === 'string' ? target : target?.default
  if (typeof file !== 'string') return undefined
  return { file: join(pkgDir, file), specifier: `${manifest.name}${subpath === '' ? '' : `/${subpath}`}` }
}

/**
 * Every build artifact this deployment will load, resolved from the descriptor's
 * package sets and each package's own `exports` map. Missing entries are the
 * pre-launch problems: a host entry or a client bundle that was never built.
 * @param {{ descriptor: object, root: string, deployment: Map<string, string> }} options - the parsed descriptor, this workspace, and the deployment set.
 * @returns {Array<{ name: string, file: string, hint: string }>} one entry per missing artifact.
 */
export function missingBuildArtifacts({ descriptor, deployment }) {
  const missing = []
  const seen = new Set()
  const check = (specifier, hint) => {
    const { name, subpath } = splitSpecifier(specifier)
    // Platform rows (`@deepseek-ai/dsh-*`) are the platform's to build; only
    // this workspace's packages are checked here.
    if (!deployment.has(name)) return
    const dir = deployment.get(name)
    const entry = exportedEntry(dir, subpath)
    const key = `${specifier}|${hint}`
    if (seen.has(key)) return
    seen.add(key)
    if (entry === undefined || !existsSync(entry.file)) {
      missing.push({ name: specifier, file: entry?.file ?? join(dir, `lib/${subpath === '' ? 'index' : subpath}.js`), hint })
    }
  }
  for (const row of descriptor.services ?? []) check(row.package, 'host row entry missing — build it: (repo) pnpm run build')
  for (const row of descriptor.applications ?? []) check(row.package, 'application entry missing — build it: (repo) pnpm run build')
  for (const name of descriptor.client?.packages ?? []) check(`${name}/client`, 'client bundle missing — build it: (repo) pnpm exec tsdown   # or node scripts/dev-apps.mjs')
  return missing
}

/** The platform's `!!js` scalar tag: a patch value the platform loader evaluates; for the preflight it is an opaque string. */
const JS_TAG_SCHEMA = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => `!!js ${String(data)}` })])

/**
 * Parse one cordis patch YAML. The platform's `!!js` values are loader
 * expressions; the preflight only needs the row names, so they are read as
 * strings and never evaluated.
 * @param {string} text - the patch file's text.
 * @returns {unknown} the parsed document.
 */
export function parsePatchYaml(text) {
  return parseYamlRaw(text, { schema: JS_TAG_SCHEMA })
}

/**
 * Every package specifier ONE patch layer mounts: a row that carries a `name`
 * and is not disabled, plus every enabled entry of an `insert` list. A row
 * without a name only overrides an existing row and adds no package; a
 * `disabled: true` row is declared but not mounted, so its package may
 * legitimately be absent from the execution source; and a row carrying BOTH a
 * top-level `name` and an `insert` contributes only its insert entries — the
 * platform destructures `{ id, insert, name, … }` and mounts the insert branch
 * alone, so the top-level name is never mounted (PL7 ②, 2026-09-19).
 *
 * Only a literal `true` disables: a platform patch's conditional disable is a
 * `!!js` expression, which the preflight's YAML schema reads as an opaque string
 * rather than evaluating — such a row is mounted wherever its expression holds,
 * so it stays in the set (the strict comparison is load-bearing, not a style
 * choice).
 *
 * This reads ONE layer; the stack's composition (an overlay re-enabling a row a
 * shipped patch disabled) is {@link mergedPatchRowNames}.
 * @param {unknown} document - the parsed patch.
 * @returns {string[]} the specifiers, in declaration order.
 */
export function patchRowNames(document) {
  const names = []
  if (!Array.isArray(document)) return names
  for (const row of document) collectRowNames(row, names)
  return names
}

/** Append one row's mounted specifiers (see {@link patchRowNames} for the rules). */
function collectRowNames(row, names) {
  if (row === null || typeof row !== 'object') return
  const record = /** @type {Record<string, unknown>} */ (row)
  const enabled = record.disabled !== true
  // A row with an insert mounts its INSERTED rows; a top-level `name` beside an
  // `insert` is dead weight in the platform's loader and must not be demanded.
  if (Array.isArray(record.insert)) {
    for (const inserted of record.insert) collectRowNames(inserted, names)
    return
  }
  if (enabled && typeof record.name === 'string') names.push(record.name)
}

/**
 * The package specifiers a patch STACK mounts: the layers are composed in
 * application order (shipped bundle patches → the profile's user layer → each
 * launcher `--patch` overlay), with rows keyed by `id` the way the loader keys
 * them, so an overlay can disable a shipped row and — the shape this used to
 * miss — RE-ENABLE one a shipped patch disabled (`disabled: false`). A row is
 * mounted iff its last declaration leaves it enabled; a row that only carries
 * `id` + config keeps the names an earlier layer declared for that id.
 *
 * The platform's own web-app patch ships such a row (the Schedule overlay flips
 * `ui-schedule`'s `disabled: true` back on), which is why unioning the layers
 * without composing them under-required the artifact set (PL7 ①).
 * @param {unknown[]} layers - parsed patch documents, in application order.
 * @returns {string[]} the mounted specifiers, in first-declaration order.
 */
export function mergedPatchRowNames(layers) {
  /** @type {Map<string, { names: string[], disabled: boolean }>} */
  const byId = new Map()
  /** @type {Array<{ id?: string, name?: string }>} */
  const order = []
  const record = (row) => {
    if (row === null || typeof row !== 'object') return
    const entry = /** @type {Record<string, unknown>} */ (row)
    // The insert branch mounts its entries; the row's own name never mounts.
    if (Array.isArray(entry.insert)) {
      for (const inserted of entry.insert) record(inserted)
      return
    }
    const id = typeof entry.id === 'string' ? entry.id : undefined
    if (id === undefined) {
      if (entry.disabled !== true && typeof entry.name === 'string') order.push({ name: entry.name })
      return
    }
    if (!byId.has(id)) {
      byId.set(id, { names: [], disabled: false })
      order.push({ id })
    }
    const state = byId.get(id)
    // A later declaration supersedes the names; the disabled flag only moves
    // when the layer actually carries one (an override row keeps the rest).
    if (typeof entry.name === 'string') state.names = [entry.name]
    if (entry.disabled === true) state.disabled = true
    else if (entry.disabled === false) state.disabled = false
  }
  for (const layer of layers) {
    if (!Array.isArray(layer)) continue
    for (const row of layer) record(row)
  }
  const names = []
  for (const entry of order) {
    if (entry.name !== undefined) { names.push(entry.name); continue }
    const state = byId.get(entry.id)
    if (state.disabled !== true) names.push(...state.names)
  }
  return names
}

/**
 * A resolver over the launch's execution source: the platform checkout's own
 * workspace packages first (the checkout lane runs THOSE), then the checkout's
 * installed node_modules, then the profile's installed packages.
 * @param {{ checkout: string, profileDir: string, repoRoot?: string }} options - the checkout, the profile, and this repo's root.
 * @returns {{ resolve: (name: string) => string | undefined, root: (dir: string) => 'checkout' | 'repo' | 'profile', workspace: Map<string, string> }} the resolver, with the workspace name → directory map it resolves through.
 */
export function packageResolver({ checkout, profileDir, repoRoot = OWN_ROOT }) {
  const workspace = new Map()
  // BOTH workspaces are scanned: the checkout's platform packages (the checkout
  // lane executes those) and this repo's own packages (the profile links them
  // straight out of the workspace, so they are never under any node_modules).
  // Checkout first: where the two could disagree, the launched tree wins.
  for (const tree of [checkout, repoRoot]) {
    for (const group of ['packages', join('packages', 'bundle')]) {
      const base = join(tree, group)
      if (!existsSync(base)) continue
      const dirs = group === 'packages'
        ? readdirSync(base).flatMap(entry => {
          const nested = join(base, entry)
          try {
            return statSync(nested).isDirectory() ? readdirSync(nested).map(inner => join(nested, inner)) : []
          } catch { return [] }
        })
        : readdirSync(base).map(entry => join(base, entry))
      for (const dir of dirs) {
        const manifest = join(dir, 'package.json')
        if (!existsSync(manifest)) continue
        try {
          const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
          if (typeof name === 'string' && !workspace.has(name)) workspace.set(name, dir)
        } catch { /* an unreadable manifest is not a resolution candidate */ }
      }
    }
  }
  const roots = [checkout, profileDir, repoRoot]
  return {
    resolve(name) {
      const local = workspace.get(name)
      if (local !== undefined) return local
      for (const root of roots) {
        const candidate = join(root, 'node_modules', name)
        if (existsSync(join(candidate, 'package.json'))) return candidate
      }
      return undefined
    },
    root(dir) {
      if (dir.startsWith(checkout)) return 'checkout'
      if (dir.startsWith(repoRoot)) return 'repo'
      return 'profile'
    },
    workspace,
  }
}

/**
 * This repo's packages one package's SOURCE imports by value: the
 * `@matrix1001/dsh-application-harness*` specifiers in `<dir>/src`, minus the statements
 * that import nothing at runtime (`import type` / `export type` — a type-only
 * edge is erased, so it cannot put a byte into the artifact).
 *
 * Read from the source, not from a build config's inline roster: what a bundle
 * actually inlined is a property of the source it was built from, and a second
 * hand-kept roster is exactly the drift this repo has been burned by twice
 * (`layer-deps-roster-hand-maintained`, `client-roster-not-derived`). The
 * platform half (`react`, `cordis`, `@deepseek-ai/dsh-client-*`, the typert
 * protocol) is excluded by the deployment naming rule, and that is faithful
 * rather than convenient: the client build externalizes the module-table
 * baseline, so those specifiers are answered at boot, not bundled.
 * @param dir - the package directory.
 * @returns the imported package names.
 */
export function workspaceSourceImports(dir) {
  const base = join(dir, 'src')
  const names = new Set()
  if (!existsSync(base)) return names
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/u.test(entry.name)) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/^import\s+(?!type\s)[^'"]*?from\s+['"](@[^'"]+)['"]/gmu)) {
        names.add(match[1])
      }
    }
  }
  walk(base)
  return new Set(
    [...names]
      .map((specifier) => specifier.split('/').slice(0, 2).join('/'))
      .filter((name) => isDeploymentPackageName(name)),
  )
}

/**
 * This repo's packages whose SOURCES feed one row's artifact.
 *
 * A client bundle INLINES its workspace imports (the client build externalizes
 * only the platform entries; the purity gate rejects anything else), so a
 * bundle is stale when a package it inlined was edited — even though the
 * bundle's own `src/` did not move. That is the case the own-`src/` criterion
 * could not see (AR2″a, `stale-check-misses-inlined-inputs`): an edit to the
 * inlined library left every consumer bundle reporting "not stale".
 *
 * A host entry's workspace imports stay external — the profile resolves them at
 * runtime — so its artifact depends on its own sources only, and this returns
 * an empty set for it.
 *
 * The walk is transitive and covers each inlined package's WHOLE source tree,
 * which is a superset of what the bundle really inlined (a bundle takes the
 * subpaths it imports, not every module of the package). That superset is the
 * safe direction for a staleness check — it can ask for a rebuild that was not
 * strictly needed, never skip one that was — and it is what keeps this from
 * needing a second, hand-kept roster of inline edges.
 * @param dir - the mounted row's package directory.
 * @param {{ workspace: Map<string, string>, inlines: boolean }} options - the workspace index and whether this row is a client bundle.
 * @returns the workspace directories that feed the artifact (excluding the row's own).
 */
export function inlinedSourceDirs(dir, { workspace, inlines }) {
  const reached = []
  if (!inlines) return reached
  const seen = new Set([dir])
  const queue = [...workspaceSourceImports(dir)]
  while (queue.length > 0) {
    const name = queue.shift()
    const target = workspace.get(name)
    if (target === undefined || seen.has(target)) continue
    seen.add(target)
    reached.push(target)
    for (const next of workspaceSourceImports(target)) queue.push(next)
  }
  return reached
}

/**
 * The patch files one bundle declares, in application order. The platform reads
 * `dsh.bundle.patch` as EITHER one path OR an ordered list of paths and
 * concatenates the parsed lists of every resolved file (its own
 * `bundlePatchFiles`, packages/boot/app-boot); the web-app bundle ships a list
 * since 0.1.7-alpha.2 (platform commit 654caa4bbd, one `cordis.patch.yml` plus
 * four `presets/*.patch.yml`). Reading only the string form declared the daily
 * deployment's web-app layer unreadable and refused to launch it, and reading
 * only the first entry would under-require every other layer's rows.
 * @param {unknown} bundle - a bundle manifest's `dsh.bundle` declaration.
 * @returns {string[] | undefined} the package-relative patch paths in order, or
 *   `undefined` when the declaration is missing or not a list of strings (the
 *   caller reports that; this never throws where the platform would).
 */
export function bundlePatchFiles(bundle) {
  const declared = /** @type {{ patch?: unknown }} */ (bundle ?? {}).patch
  const files = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) return undefined
  return files
}

/**
 * The launch preflight's artifact set: every entry point the composition will
 * actually load, resolved from the profile's bundle list → each bundle's patch
 * rows → each row package's own `exports`.
 *
 * A package declaring `dsh.client` (the browser roster) must have its `./client`
 * bundle built; every other row must have its row subpath's entry. Rows the
 * composition does not mount are never demanded, and a package that merely
 * exists in the checkout is not checked.
 * @param {{ checkout: string, profileDir: string, repoRoot?: string, readYaml?: (text: string) => unknown }} options - the launch's sources.
 * @returns {{ missing: Array<{name: string, file: string, where: string, hint: string}>, checked: number, rows: number }} the problems and the checked counts.
 */
export function missingCompositionArtifacts({ checkout, profileDir, repoRoot = OWN_ROOT, readYaml = parsePatchYaml, extraPatches = [] }) {
  const missing = []
  // Client bundles whose source tree is NEWER than the built artifact (PL4):
  // the missing-artifact check cannot see the "a pull edited an existing client
  // package without adding a row" case — the row still resolves, it just serves
  // the previous bytes.
  const stale = []
  const resolver = packageResolver({ checkout, profileDir, repoRoot })
  const profileManifestPath = join(profileDir, 'package.json')
  if (!existsSync(profileManifestPath)) {
    return { missing: [{ name: 'profile', file: profileManifestPath, where: 'profile', hint: `profile not found — bootstrap it: node scripts/setup.mjs` }], stale: [], checked: 0, rows: 0 }
  }
  const bundles = JSON.parse(readFileSync(profileManifestPath, 'utf8'))?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length === 0) {
    return { missing: [{ name: 'profile bundles', file: profileManifestPath, where: 'profile', hint: `dsh.profile.bundles is empty — re-run node scripts/setup.mjs` }], stale: [], checked: 0, rows: 0 }
  }
  // The patch stack's layers, in the loader's application order: every bundle's
  // shipped patch, then the profile's USER layer, then each launcher `--patch`
  // overlay. Reading only the shipped layer under-required the artifact set:
  // an overlay that re-enables a shipped `disabled: true` row mounts a package
  // the union never asked for (PL7 ①).
  const layers = []
  for (const bundle of bundles) {
    if (typeof bundle !== 'string') continue
    const dir = resolver.resolve(bundle)
    if (dir === undefined) {
      missing.push({ name: bundle, file: join(checkout, 'node_modules', bundle), where: 'checkout', hint: 'bundle package not installed — run (checkout): pnpm install' })
      continue
    }
    let patchFiles
    try {
      patchFiles = bundlePatchFiles(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.dsh?.bundle)
    } catch { /* an unreadable bundle manifest is reported below */ }
    if (patchFiles === undefined) {
      missing.push({ name: bundle, file: join(dir, 'package.json'), where: resolver.root(dir), hint: 'bundle declares no dsh.bundle.patch — the composition cannot be read' })
      continue
    }
    // Every declared file is read, in order, and every one that is not there is
    // named: one missing layer is one missing artifact set, not a reason to
    // report the bundle as unreadable.
    for (const patchFile of patchFiles) {
      const patchPath = join(dir, patchFile)
      if (!existsSync(patchPath)) {
        missing.push({ name: `${bundle} patch`, file: patchPath, where: resolver.root(dir), hint: 'bundle patch missing — rebuild it' })
        continue
      }
      layers.push(readYaml(readFileSync(patchPath, 'utf8')))
    }
  }
  const userLayer = join(profileDir, 'cordis.patch.yml')
  if (existsSync(userLayer)) layers.push(readYaml(readFileSync(userLayer, 'utf8')))
  const launchDir = process.cwd()
  for (const file of extraPatches) {
    const path = resolve(launchDir, file)
    if (!existsSync(path)) {
      // The launcher would hand this path to dsh, which then fails to boot:
      // report it here, where the cause is still nameable.
      missing.push({ name: `--patch ${file}`, file: path, where: 'launch', hint: 'patch overlay not found — the launch would fail to boot' })
      continue
    }
    layers.push(readYaml(readFileSync(path, 'utf8')))
  }
  const names = mergedPatchRowNames(layers)
  let checked = 0
  for (const specifier of new Set(names)) {
    const { name, subpath } = splitSpecifier(specifier)
    const dir = resolver.resolve(name)
    if (dir === undefined) {
      missing.push({ name: specifier, file: join(checkout, 'node_modules', name), where: 'checkout', hint: 'row package not installed — run (checkout): pnpm install' })
      continue
    }
    const where = resolver.root(dir)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      missing.push({ name: specifier, file: join(dir, 'package.json'), where, hint: 'unreadable package manifest' })
      continue
    }
    const client = manifest.dsh?.client !== undefined
    // A SUBPATH row (`…/access`) mounts that entry whatever else the package
    // ships: the `./client` shortcut is for the package's own row only. Applying
    // it to subpath rows validated the client bundle instead of the entry the row
    // actually mounts — the mounted entry could be missing and nothing said so
    // (arch-review 2026-09-20, preflight-client-invariant-blind).
    const key = subpath === '' ? (client ? './client' : '.') : `./${subpath}`
    const target = manifest.exports?.[key]
    const rel = typeof target === 'string' ? target : target?.default
    if (typeof rel !== 'string') {
      missing.push({ name: specifier, file: join(dir, 'package.json'), where, hint: `package exports no ${key} entry while the composition mounts it` })
      continue
    }
    checked += 1
    const file = join(dir, rel)
    if (!existsSync(file)) {
      missing.push({
        name: client ? `${specifier} client bundle` : specifier,
        file,
        where,
        hint: where === 'repo'
          ? (client ? 'client bundle missing — build it: (repo) pnpm exec tsdown   # or node scripts/dev-apps.mjs' : 'host entry missing — build it: (repo) pnpm run build')
          : 'platform artifact missing — build it: (checkout) pnpm run build',
      })
      continue
    }
    // A mounted row whose artifact resolves RESOLVES but predates the sources it
    // was built from serves the previous bytes. This applies to every mounted
    // row — host entries included, not just client bundles (AR2 ②): a host entry
    // is exactly as capable of being one pull
    // behind, and the browser lane's evidence would then describe code that is
    // not what the row loads.
    // What feeds this artifact: its own sources, plus — for a client bundle —
    // the sources of every workspace package the bundle INLINED. An inlined
    // library's edit moves no file under the bundle's own `src/`, so the
    // own-`src/` criterion alone reported "not stale" and the row served the
    // previous bytes (AR2″a, `stale-check-misses-inlined-inputs`).
    const inlined = inlinedSourceDirs(dir, { workspace: resolver.workspace, inlines: client })
    const newest = [dir, ...inlined].reduce((newest, source) => {
      const at = newestSourceMtime(source)
      if (at === undefined) return newest
      return newest === undefined || at > newest ? at : newest
    }, undefined)
    if (newest !== undefined && newest > statSync(file).mtimeMs + STALE_ENTRY_GRACE_MS) {
      const what = client ? 'client bundle' : 'host entry'
      const artifact = client ? 'lib/client.js' : rel.replace(/^\.\//u, '')
      const cause = newest === newestSourceMtime(dir) ? 'src/' : `an inlined input (${inlined.map((source) => relative(repoRoot, source)).join(', ')}/src/)`
      stale.push({
        name: client ? `${specifier} client bundle` : specifier,
        file,
        where,
        hint: where === 'repo'
          ? `stale ${what}: ${cause} is newer than ${artifact} — rebuild it: (repo) ${client ? 'pnpm exec tsdown   # or node scripts/dev-apps.mjs' : 'pnpm run build'}`
          : `stale ${what}: ${cause} is newer than ${artifact} — rebuild it: (checkout) pnpm run build`,
      })
    }
  }
  return { missing, stale, checked, rows: new Set(names).size }
}

/**
 * Resolve how `setup --launch` will boot dsh — and say what that resolution
 * actually VERIFIED (T2). The launch path is the registry/PATH line
 * (DSH_BIN → PATH → npx), not the platform checkout, so the wrapper's checkout
 * preflight does not cover it: `npx` fetches from the registry and cannot be
 * verified locally, and a bin/DSH_BIN path is verified only by existing.
 * @param {{ dshBin?: string, env?: Record<string, string | undefined>, onPath?: (name: string) => boolean, exists?: (path: string) => boolean }} options - the explicit bin, the environment, and the probes.
 * @returns {{ cmd: string, args: string[], source: string, verified: boolean, note: string }} the plan plus its provenance.
 */
export function resolveLaunchSource({ dshBin, env = process.env, onPath = () => false, exists = existsSync, profileArgs = [] } = {}) {
  if (dshBin !== undefined && dshBin !== '') {
    return { cmd: process.execPath, args: [dshBin, ...profileArgs], source: '--dsh', verified: exists(dshBin),
      note: exists(dshBin) ? 'explicit bin found on disk' : 'explicit bin path does not exist' }
  }
  const fromEnv = env.DSH_BIN
  if (fromEnv !== undefined && fromEnv !== '') {
    return { cmd: process.execPath, args: [fromEnv, ...profileArgs], source: 'DSH_BIN', verified: exists(fromEnv),
      note: exists(fromEnv) ? 'DSH_BIN found on disk' : 'DSH_BIN path does not exist' }
  }
  if (onPath('dsh')) return { cmd: 'dsh', args: profileArgs, source: 'PATH', verified: true, note: 'dsh resolved on PATH' }
  return { cmd: 'npx', args: ['@deepseek-ai/dsh', ...profileArgs], source: 'npx', verified: false,
    note: 'no local dsh found — npx fetches @deepseek-ai/dsh from the registry; the execution line is NOT the platform checkout' }
}
