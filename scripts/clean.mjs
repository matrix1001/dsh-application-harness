#!/usr/bin/env node
/**
 * `pnpm run clean` — remove build artifacts, and nothing else.
 *
 * Why this is a script instead of `git clean -Xdf -e node_modules` (arch-review
 * 2026-09-15, finding `clean-deletes-workspace-data`): under `-X` git removes
 * EVERY ignored path, and `-e <pattern>` does not make an exception there — it
 * ADDS an ignore rule, so the old command also listed `node_modules/` for
 * deletion and deleted `.dsh-applications/`, which is not a build artifact at
 * all: it holds the cwd-relative workspace data — the applications' own
 * documents written by the applications. Since
 * 2026-09-22 (AR2n④) that workspace is
 * `$DSH_WORKSPACE` / `~/dsh-workspaces/<profile>` and no longer this repo, so
 * the path below is protected as a *legacy* world a not-yet-adopted launch may
 * still hold — see `scripts/workspace.mjs`. Pathspec
 * limiting and `-e '!pattern'` were both measured and rejected (see the
 * finding's rationale); an explicit, testable script is what remains.
 *
 * Usage:
 *   node scripts/clean.mjs [--dry-run] [--purge-data] [--workspace <dir>]
 *
 * What a real run prints is what it is ABOUT to delete, each path absolute, one
 * line per path — an irreversible deletion is worth announcing before it
 * happens rather than reporting after (AR2″a review, Minor). `--dry-run` prints
 * the same set, untouched, as `would remove <path>`.
 *
 * `--purge-data` is the only way to remove the protected paths, and it must be
 * asked for by name. `--workspace <dir>` (with `--purge-data`) names the
 * WORKSPACE whose `.dsh-applications/` is business data too: since AR2n④ that is
 * where the live world is (`$DSH_WORKSPACE` / `~/dsh-workspaces/<profile>`), and
 * this module never guesses it — a bare `--purge-data` reaches only the repo's
 * own (legacy) `.dsh-applications/` and says so. `scripts/tests/clean.test.mjs`
 * pins the protected set, the dry-run/real-run path parity, and the fact that a
 * default run never lists any of it.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKSPACES_DIRNAME, WORKSPACE_ENV, worldDirOf } from './workspace.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Paths that a default run must never remove. `--purge-data` unlocks `DATA`. */
export const PROTECTED = Object.freeze(['node_modules', '.dsh-applications'])
/** The one protected path that is business data rather than a dependency tree. */
export const DATA = '.dsh-applications'
/** Where the live world lives instead (a message, not a default this command ever acts on). */
export const LIVE_WORLD_HINT = `$${WORKSPACE_ENV} / ~/${WORKSPACES_DIRNAME}/<profile>`
/** Repository-root artifact directories. */
export const ROOT_ARTIFACTS = Object.freeze(['coverage', 'tmp', 'lib'])
/** Artifact directories inside a package (`packages/<area>/<pkg>/…`). */
export const PACKAGE_ARTIFACT_DIRS = Object.freeze(['lib'])
/** Files removed wherever they appear outside a protected tree. */
export const ARTIFACT_SUFFIXES = Object.freeze(['.tsbuildinfo'])

const firstSegment = (path) => path.split(sep)[0]

/**
 * Every artifact path this workspace owns, as repo-relative POSIX paths.
 * @param {string} root - repository root
 * @returns {string[]} sorted, deduplicated artifact paths that exist
 */
export function collectArtifacts(root = ROOT) {
  const found = new Set()
  for (const name of ROOT_ARTIFACTS) {
    if (existsSync(join(root, name))) found.add(name)
  }

  const packageRoots = []
  const packages = join(root, 'packages')
  if (existsSync(packages)) {
    for (const area of readdirSync(packages)) {
      const areaPath = join(packages, area)
      if (firstSegment(area) === 'node_modules' || !lstatSync(areaPath).isDirectory()) continue
      for (const pkg of readdirSync(areaPath)) {
        const pkgPath = join(areaPath, pkg)
        if (lstatSync(pkgPath).isDirectory()) packageRoots.push(pkgPath)
      }
    }
  }
  const apps = join(root, 'apps')
  if (existsSync(apps)) {
    for (const app of readdirSync(apps)) {
      for (const face of ['host', 'view']) {
        const pkgPath = join(apps, app, face)
        if (existsSync(pkgPath) && lstatSync(pkgPath).isDirectory()) packageRoots.push(pkgPath)
      }
    }
  }
  for (const pkgPath of packageRoots) {
    for (const dir of PACKAGE_ARTIFACT_DIRS) {
      if (existsSync(join(pkgPath, dir))) found.add(relative(root, join(pkgPath, dir)))
    }
    for (const entry of readdirSync(pkgPath)) {
      if (ARTIFACT_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
        found.add(relative(root, join(pkgPath, entry)))
      }
    }
  }
  return [...found].sort()
}

/**
 * Remove (or list) the workspace's build artifacts, and — only when asked — the
 * business data, which since AR2n④ is TWO places: this repo's own (legacy)
 * `.dsh-applications/`, and the one inside a `--workspace <dir>` the caller
 * names. The named workspace is resolved to an absolute path and its world is
 * pushed onto `removed` as it is, so the dry run prints the very path a real run
 * would delete.
 *
 * `beforeRemove` is called with each path's ABSOLUTE form immediately before it
 * is touched. The CLI uses it to say what a real run is about to delete while it
 * can still be read as a warning: the `removed` list it returns is a report, and
 * for an irreversible purge of a path outside the repo a report that arrives
 * after the fact is no confirmation at all (AR2″a review, Minor).
 * @param {{ root?: string, dryRun?: boolean, purgeData?: boolean, workspace?: string, beforeRemove?: (absolutePath: string) => void }} [options]
 * @returns {{ removed: string[], skipped: string[], dryRun: boolean, workspaceWorld?: string }} what was removed (or would be), and the named workspace's world path when one was named.
 */
export function cleanWorkspace(options = {}) {
  const { root = ROOT, dryRun = false, purgeData = false, workspace, beforeRemove } = options
  const skipped = purgeData ? [] : [...PROTECTED]
  const targets = collectArtifacts(root)
  const removed = []

  for (const target of targets) {
    if (!purgeData && PROTECTED.includes(firstSegment(target))) continue
    const absolute = join(root, target)
    beforeRemove?.(absolute)
    if (!dryRun) rmSync(absolute, { recursive: true, force: true })
    removed.push(target)
  }
  const repoWorld = resolve(join(root, DATA))
  if (purgeData && existsSync(repoWorld)) {
    beforeRemove?.(repoWorld)
    if (!dryRun) rmSync(repoWorld, { recursive: true, force: true })
    removed.push(DATA)
  }
  // A NAMED workspace only: the default world (`~/dsh-workspaces/<profile>`) is
  // deliberately never derived here — a purge that guesses which world is live is
  // how the live one gets deleted by accident. The repo's own path is already
  // covered above (the same directory, spelled repo-relative); a workspace that
  // resolves to it adds nothing.
  const workspaceWorld = workspace === undefined ? undefined : resolve(worldDirOf(workspace))
  if (purgeData && workspaceWorld !== undefined && workspaceWorld !== repoWorld && existsSync(workspaceWorld)) {
    beforeRemove?.(workspaceWorld)
    if (!dryRun) rmSync(workspaceWorld, { recursive: true, force: true })
    removed.push(workspaceWorld)
  }
  return { removed, skipped, dryRun, workspaceWorld }
}

/**
 * Parse the CLI arguments (exported for the script tests).
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ dryRun: boolean, purgeData: boolean, workspace?: string } | { error: string }} the options, or why they were refused.
 */
export function parseArgs(argv = []) {
  const opts = { dryRun: false, purgeData: false, workspace: undefined }
  const unknown = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--purge-data') opts.purgeData = true
    else if (arg === '--workspace') {
      opts.workspace = argv[++index]
      if (opts.workspace === undefined) return { error: '--workspace needs a directory' }
    } else unknown.push(arg)
  }
  if (unknown.length) return { error: `unknown argument(s): ${unknown.join(', ')}` }
  // A workspace holds business data only: without `--purge-data` there is
  // nothing this command could legitimately do there, and accepting the flag
  // quietly would read as "that was taken care of".
  if (opts.workspace !== undefined && !opts.purgeData) {
    return { error: '--workspace needs --purge-data (a workspace holds business data, not build artifacts)' }
  }
  return opts
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href

if (isEntryPoint) {
  const { dryRun, purgeData, workspace, error } = parseArgs(process.argv.slice(2))
  if (error !== undefined) {
    console.error(`clean: ${error}\nusage: node scripts/clean.mjs [--dry-run] [--purge-data] [--workspace <dir>]`)
    process.exit(2)
  }
  const { removed, skipped, workspaceWorld } = cleanWorkspace({
    dryRun, purgeData, workspace,
    // A real run echoes each ABSOLUTE path as it is about to go. The listing it
    // used to print afterwards only was too late to be anything but a report:
    // `--purge-data --workspace <dir>` deletes business data outside this repo,
    // irreversibly, and named the path only once it was already gone (AR2″a
    // review, Minor). The dry run keeps the post-hoc listing — nothing was
    // deleted there, and `would remove <path>` is the F-5 parity contract.
    beforeRemove: dryRun ? undefined : (path) => console.log(`removing ${path}`),
  })
  if (dryRun) for (const path of removed) console.log(`would remove ${path}`)
  if (removed.length === 0) console.log('clean: nothing to remove')
  if (purgeData && workspaceWorld !== undefined && !removed.includes(workspaceWorld)) {
    console.log(`clean: no world at ${workspaceWorld} — nothing to purge there`)
  }
  if (skipped.length) {
    console.log(`clean: kept ${skipped.join(', ')} (business data needs --purge-data)`)
  }
  // The sentence the old usage was missing (F-5): say which paths were actually
  // touched and that the live world is NOT among them, so "`--purge-data` is how
  // you delete business data" cannot be read as "it deleted the world".
  if (purgeData && workspaceWorld === undefined) {
    console.log(`clean: --purge-data reached this repository only (${join(ROOT, DATA)} — this repo's own LEGACY world path);`
      + ` since AR2n④ the LIVE world lives in a WORKSPACE (${LIVE_WORLD_HINT}) — name the one you mean: --purge-data --workspace <dir>`)
  }
}
