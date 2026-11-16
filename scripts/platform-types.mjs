#!/usr/bin/env node
/**
 * The checkout-side type plane: materialize the platform checkout's built
 * declarations inside this repo and swap the tsconfig base paths for the
 * duration of one tsc run.
 *
 * Why a copied snapshot: a `paths` entry pointing straight at the checkout
 * makes that declaration's bare imports resolve through the checkout's own
 * `node_modules`; the resulting two `@deepseek-ai/cordis` module identities
 * never merge their `Context` augmentations. Copying the declarations under
 * this repo makes their imports resolve through this repo's `node_modules`,
 * so the client faces compose exactly as they do in the published line.
 *
 * Why this is wrapped: `tsdown` bundles JavaScript, not declarations. A
 * checkout `.d.ts` path is fine for `tsc` and fatal for `tsdown`, so the base
 * configs are swapped only around the tsc command and restored immediately
 * after (including on SIGINT/SIGTERM).
 *
 * Commands:
 *   --prepare [--force] [--checkout <dir>]
 *       copy the checkout's built .d.ts files into tmp/platform-types/vendor
 *       and write the host/client paths maps (cached by checkout HEAD)
 *   --run <command...>
 *       swap the base paths in, run the command, restore them, propagate exit
 *   --check
 *       verify the snapshot matches the checkout HEAD (no writes)
 *   --restore
 *       restore base configs from the crash backup, if one exists
 * @module scripts/platform-types
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = process.env.DSH_HARNESS_REPO ?? join(process.env.HOME ?? '', 'deepseek-harness')
const OUT = join(ROOT, 'tmp', 'platform-types')
const VENDOR = join(OUT, 'vendor')
const BASE = join(ROOT, 'tsconfig.base.json')
const CLIENT_BASE = join(ROOT, 'tsconfig.base.client.json')
const HOST_PATHS = join(OUT, 'host-paths.json')
const CLIENT_PATHS = join(OUT, 'client-paths.json')
const MARKER = join(OUT, 'prepared.json')
const BACKUP = join(OUT, 'crash-backup')

/** Run git with the environment's broken GIT_CONFIG_* neutralized. */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
  }).trim()
}

/** Every checkout package manifest at the depth the platform uses. */
function walkManifests(dir, depth = 0, out = []) {
  if (depth > 3 || !existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'fixtures') continue
    const child = join(dir, entry.name)
    if (existsSync(join(child, 'package.json'))) out.push(join(child, 'package.json'))
    walkManifests(child, depth + 1, out)
  }
  return out
}

/** Resolve the `types` condition of one export value. */
function findTypes(value) {
  if (typeof value === 'string') return value.endsWith('.d.ts') ? value : undefined
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.types === 'string') return value.types
  for (const key of ['import', 'require', 'default', 'node', 'browser']) {
    const found = findTypes(value[key])
    if (found !== undefined) return found
  }
  return undefined
}

/** Copy one package's built declaration files, preserving the lib/ layout. */
function copyDeclarations(pkgDir, dest) {
  const lib = join(pkgDir, 'lib')
  if (!existsSync(lib)) return 0
  let copied = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { walk(abs); continue }
      if (!entry.name.endsWith('.d.ts')) continue
      const target = join(dest, relative(pkgDir, abs).split('\\').join('/'))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(abs, target)
      copied += 1
    }
  }
  walk(lib)
  return copied
}

/** Read a JSON file, or undefined when it does not exist. */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/** Write one paths map. */
function writePaths(path, paths) {
  writeFileSync(path, `${JSON.stringify(paths, null, 2)}\n`)
}

/** Prepare the vendor snapshot and paths maps. */
function prepare({ force = false } = {}) {
  if (!existsSync(join(CHECKOUT, '.git'))) throw new Error(`no platform checkout at ${CHECKOUT} (pass --checkout <dir>)`)
  const head = git(CHECKOUT, ['rev-parse', 'HEAD'])
  const marker = readJson(MARKER)
  if (!force && marker?.head === head && existsSync(VENDOR) && existsSync(HOST_PATHS) && existsSync(CLIENT_PATHS)) {
    console.log(`platform-types: reuse snapshot at ${head.slice(0, 12)}`)
    return
  }
  // The declarations are produced by the checkout's own build; a checkout
  // without them is a setup error, never a silent fallback to npm.
  const probe = join(CHECKOUT, 'packages/client/ui-primitives/lib/types/index.d.ts')
  if (!existsSync(probe)) throw new Error(`the checkout at ${CHECKOUT} has no built declarations — run pnpm run build there first`)

  rmSync(VENDOR, { recursive: true, force: true })
  mkdirSync(VENDOR, { recursive: true })
  const platformPaths = {}
  let packages = 0
  let skipped = 0
  for (const manifestPath of walkManifests(join(CHECKOUT, 'packages')).concat(walkManifests(join(CHECKOUT, 'apps')))) {
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { skipped += 1; continue }
    const name = manifest.name
    if (typeof name !== 'string' || !/^@deepseek-ai\/dsh(-|$)/u.test(name)) continue
    const pkgDir = manifestPath.slice(0, -'/package.json'.length)
    const slug = name.replace(/^@/u, '').replaceAll('/', '-')
    const dest = join(VENDOR, slug)
    if (copyDeclarations(pkgDir, dest) === 0) { skipped += 1; continue }
    packages += 1
    const exports = manifest.exports
    const entries = exports === undefined
      ? [['.', manifest.types ?? findTypes(manifest)]]
      : (typeof exports === 'string' ? [['.', exports]] : Object.entries(exports))
    for (const [subpath, value] of entries) {
      if (typeof subpath !== 'string' || subpath.includes('*') || subpath === './package.json') continue
      const target = findTypes(value)
      if (target === undefined) continue
      const abs = resolve(pkgDir, target)
      const rel = relative(pkgDir, abs)
      if (rel.startsWith('..')) continue
      const copied = join(dest, rel)
      if (!existsSync(copied)) continue
      const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`
      platformPaths[specifier] = [`./${relative(ROOT, copied).split('\\').join('/')}`]
    }
  }
  const base = ts.readConfigFile(BASE, ts.sys.readFile)
  if (base.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(base.error.messageText, ' '))
  const ownPaths = base.config.compilerOptions?.paths ?? {}
  // The host plane keeps our source paths; the client plane deliberately lets
  // our own packages resolve through node_modules (the build already does).
  const hostPaths = { ...ownPaths, ...platformPaths }
  writePaths(HOST_PATHS, hostPaths)
  writePaths(CLIENT_PATHS, platformPaths)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(MARKER, `${JSON.stringify({ checkout: CHECKOUT, head, packages, paths: Object.keys(platformPaths).length, skipped, at: new Date().toISOString() }, null, 2)}\n`)
  console.log(`platform-types: ${packages} package(s), ${Object.keys(platformPaths).length} path(s), ${skipped} skipped, checkout ${head.slice(0, 12)}`)
}

/** Swap the base paths in, run `fn`, and restore the raw files no matter what. */
function withCheckoutBases(fn) {
  const hostPaths = readJson(HOST_PATHS)
  const clientPaths = readJson(CLIENT_PATHS)
  if (hostPaths === undefined || clientPaths === undefined) throw new Error('platform-types: no prepared paths — run --prepare first')
  mkdirSync(BACKUP, { recursive: true })
  const baseRaw = readFileSync(BASE, 'utf8')
  const clientRaw = readFileSync(CLIENT_BASE, 'utf8')
  writeFileSync(join(BACKUP, 'tsconfig.base.json'), baseRaw)
  writeFileSync(join(BACKUP, 'tsconfig.base.client.json'), clientRaw)
  let restored = false
  const restore = () => {
    if (restored) return
    writeFileSync(BASE, baseRaw)
    writeFileSync(CLIENT_BASE, clientRaw)
    restored = true
  }
  const onSignal = (signal) => { restore(); process.exit(signal === 'SIGINT' ? 130 : 143) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const base = ts.readConfigFile(BASE, ts.sys.readFile)
    const client = ts.readConfigFile(CLIENT_BASE, ts.sys.readFile)
    if (base.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(base.error.messageText, ' '))
    if (client.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(client.error.messageText, ' '))
    writeFileSync(BASE, `${JSON.stringify({ ...base.config, compilerOptions: { ...base.config.compilerOptions, paths: hostPaths } }, null, 2)}\n`)
    writeFileSync(CLIENT_BASE, `${JSON.stringify({ ...client.config, compilerOptions: { ...client.config.compilerOptions, paths: clientPaths } }, null, 2)}\n`)
    return fn()
  } finally {
    restore()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

/** Restore the crash backup if one was left behind. */
function restoreBackup() {
  for (const name of ['tsconfig.base.json', 'tsconfig.base.client.json']) {
    const backup = join(BACKUP, name)
    if (existsSync(backup)) {
      writeFileSync(join(ROOT, name), readFileSync(backup))
      console.log(`platform-types: restored ${name} from crash backup`)
    }
  }
  rmSync(BACKUP, { recursive: true, force: true })
}

/** Verify the snapshot is current. */
function check() {
  const marker = readJson(MARKER)
  if (marker === undefined) throw new Error('platform-types: no prepared snapshot — run --prepare')
  if (!existsSync(VENDOR) || !existsSync(HOST_PATHS) || !existsSync(CLIENT_PATHS)) throw new Error('platform-types: snapshot files are missing — run --prepare')
  const head = git(CHECKOUT, ['rev-parse', 'HEAD'])
  if (marker.head !== head) throw new Error(`platform-types: snapshot is ${marker.head.slice(0, 12)} but checkout is ${head.slice(0, 12)} — run --prepare`)
  console.log(`platform-types: OK — ${marker.packages} package(s), ${marker.paths} path(s), checkout ${head.slice(0, 12)}`)
}

/** CLI. */
function main() {
  const argv = process.argv.slice(2)
  const mode = argv[0]
  const checkoutIndex = argv.indexOf('--checkout')
  if (checkoutIndex !== -1) process.env.DSH_HARNESS_REPO = argv[checkoutIndex + 1]
  try {
    if (mode === '--prepare') { prepare({ force: argv.includes('--force') }); return }
    if (mode === '--check') { check(); return }
    if (mode === '--restore') { restoreBackup(); return }
    if (mode === '--run') {
      const command = argv.slice(1)
      if (command.length === 0) throw new Error('platform-types: --run needs a command')
      const status = withCheckoutBases(() => spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: 'inherit', env: process.env }).status ?? 1)
      process.exit(status)
    }
    console.log(`platform-types: the checkout type plane
  --prepare [--force] [--checkout <dir>]  build the declaration snapshot + paths maps
  --run <command...>                      swap paths, run the command, restore, propagate exit
  --check                                 verify the snapshot matches the checkout HEAD
  --restore                               restore base configs from a crash backup`)
    process.exit(1)
  } catch (error) {
    console.error(`platform-types: FAIL — ${String(error.message ?? error)}`)
    process.exit(1)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
