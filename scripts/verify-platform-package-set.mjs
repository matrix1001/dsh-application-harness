#!/usr/bin/env node
/**
 * Reconciliation of the reference plane against the installed platform line:
 * every `@deepseek-ai/dsh*` name this repo references must be a package the
 * published line actually ships — either the `@deepseek-ai/dsh` CLI itself or
 * a package directory under `node_modules/@deepseek-ai`.
 *
 * The reference plane is `dependencies`/`devDependencies`/`peerDependencies`
 * of the root manifest and of every `packages/<group>/<pkg>/package.json`, plus
 * the names in `pnpm-workspace.yaml`'s `overrides` list — that is read by the
 * resolver, never by the dependency graph, so a stale name there fails in no
 * other gate.
 *
 * What it catches: a rename arrived with a platform release (`ptc-runtime*`
 * for `code-runtime*`, or the package-name cleanup) and a manifest or mirror
 * list still names the old package. What it deliberately does not do: compare
 * against a platform checkout's own workspace — the installed line is the
 * contract this repo builds and ships against.
 * @module
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { packageManifests } from './package-areas.mjs'
import { readDeclaredLine } from './platform-line.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** `@deepseek-ai/dsh*` — the CLI and every platform package. */
const PLATFORM_NAME = /^@deepseek-ai\/dsh(-|$)/u

/** Manifest sections that make a name a reference. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']

/** The umbrella package: a CLI entry, not a workspace package. */
const UMBRELLA = '@deepseek-ai/dsh'

/** Whether a name belongs to the platform train. */
function platformName(name) {
  return typeof name === 'string' && PLATFORM_NAME.test(name)
}

/**
 * Every platform name this repo refers to, with the files that refer to it.
 * @param {string} root - the repo root.
 * @returns {Map<string, string[]>} name → sorted root-relative sources.
 */
export function referenceSites(root = ROOT) {
  const sites = new Map()
  const record = (name, site) => {
    if (!platformName(name)) return
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
  for (const manifestPath of packageManifests(root)) {
    readManifest(manifestPath, relative(root, manifestPath).split('\\').join('/'))
  }
  const workspacePath = join(root, 'pnpm-workspace.yaml')
  if (existsSync(workspacePath)) {
    const workspace = parseYaml(readFileSync(workspacePath, 'utf8'))
    for (const name of Object.keys(workspace?.overrides ?? {})) record(name, 'pnpm-workspace.yaml (overrides)')
  }
  for (const list of sites.values()) list.sort()
  return sites
}

/**
 * The version one `node_modules/.pnpm` entry directory carries.
 *
 * Store entries look like `@deepseek-ai+dsh-tool@0.2.3-alpha.2_<peer hash>`;
 * the peer hash suffix makes a name-only prefix match insufficient after a
 * platform upgrade, when the previous line's directories are still present.
 * @param {string} entry - one `.pnpm` directory name.
 * @returns {string | undefined} the version, or undefined for a name that does not parse.
 */
export function storeEntryVersion(entry) {
  const at = entry.indexOf('@', entry.indexOf('+') + 1)
  if (at === -1) return undefined
  const rest = entry.slice(at + 1)
  const underscore = rest.indexOf('_')
  return underscore === -1 ? undefined : rest.slice(0, underscore)
}

/**
 * The version a package manifest names, or undefined when it cannot be read.
 * @param {string} path - the manifest path.
 * @returns {string | undefined} the version.
 */
function manifestVersion(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version
  } catch {
    return undefined
  }
}

/**
 * Whether the installed line ships this name AT the declared version: a hoisted
 * package, or one the lockfile resolved into the pnpm store (the mirror lists
 * name transitive platform packages that are normally not hoisted).
 *
 * The store may still hold directories from earlier platform lines after an
 * upgrade; those do not satisfy the reference, or a removed package would keep
 * passing this gate forever.
 * @param {string} root - the repo root.
 * @param {string} name - the platform package name.
 * @param {(path: string) => boolean} exists - the existence probe (injectable for the tests).
 * @param {string[]} store - the pnpm store entries (injectable for the tests).
 * @param {(path: string) => string | undefined} versionOf - manifest version reader (injectable for the tests).
 * @param {string} line - the declared platform line the reference must resolve at.
 * @returns {'hoisted' | 'store' | 'missing'} where it was found.
 */
export function installed(root, name, exists = existsSync, store = storeEntries(root), versionOf = manifestVersion, line = readDeclaredLine(root)) {
  const bare = name === UMBRELLA ? 'dsh' : name.slice('@deepseek-ai/'.length)
  const manifest = join(root, 'node_modules', '@deepseek-ai', bare, 'package.json')
  if (exists(manifest) && versionOf(manifest) === line) return 'hoisted'
  const prefix = `@deepseek-ai+${bare}@`
  return store.some(entry => entry.startsWith(prefix) && storeEntryVersion(entry) === line) ? 'store' : 'missing'
}

/**
 * The pnpm store's entry names (`node_modules/.pnpm`), or an empty list.
 * @param {string} root - the repo root.
 * @returns {string[]} the entry names.
 */
export function storeEntries(root) {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return []
  return readdirSync(store)
}

/**
 * The check.
 * @param {{ root?: string }} [options] - the repo root.
 * @returns {number} the exit code.
 */
export function verify({ root = ROOT } = {}) {
  const sites = referenceSites(root)
  const store = storeEntries(root)
  const line = readDeclaredLine(root)
  const manifestNames = [...sites.entries()].filter(([, where]) => where.some(site => !site.startsWith('pnpm-workspace.yaml')))
  const mirrorOnly = sites.size - manifestNames.length
  const missing = manifestNames.filter(([name]) => installed(root, name, existsSync, store, manifestVersion, line) === 'missing')
  console.log(`verify-platform-package-set: ${manifestNames.length} imported platform name(s) checked against the installed line ${line}`
    + (mirrorOnly === 0 ? '' : `; ${mirrorOnly} mirror-list name(s) are declarative and not checked here`))
  if (missing.length === 0) return 0
  console.error(`verify-platform-package-set: FAIL — ${missing.length} name(s) are not installed at ${line}:`)
  for (const [name, where] of missing) {
    console.error(`  - ${name} — referenced by ${where.join(', ')}`)
  }
  return 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(verify({ root: ROOT }))
}
