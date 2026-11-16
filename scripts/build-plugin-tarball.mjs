#!/usr/bin/env node
/**
 * Build one self-contained installable bundle tarball.
 *
 * A DSH profile installs the bundle with `dsh plugin add <tarball>`. The bundle
 * declares its 23 own packages as dependencies, so a normal tarball would make
 * the user configure a private registry. Instead this script vendors those
 * packages into the bundle's `node_modules` and records them as
 * `bundleDependencies`; the result is one asset with no registry lookup for
 * our own packages. Platform packages stay peer dependencies and are supplied
 * by the running DSH installation.
 *
 * The bundle itself is packed with npm: pnpm's isolated linker rejects
 * `bundleDependencies`, and `pnpm pack` in this workspace follows the parent
 * node_modules into unsafe `../` tarball entries. npm packs the same directory
 * as a clean, self-contained asset. Own packages are still packed with pnpm so
 * their `workspace:` dependencies are rewritten.
 *
 * Run `node scripts/build-release.mjs` first: this script packs the existing
 * `lib/` products and never chooses a platform build line by itself.
 *
 * Usage:
 *   node scripts/build-plugin-tarball.mjs
 *   node scripts/build-plugin-tarball.mjs --out dist
 * @module scripts/build-plugin-tarball
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_DIR = join(ROOT, 'packages', 'bundle', 'app-harness')
const AREAS = ['application', 'client', 'examples']
const WORK = join(ROOT, 'tmp', 'plugin-tarball')
const ASSETS = join(WORK, 'assets')
const PACK_ROOT = join(WORK, 'pack')
const NPM_CACHE = join(ROOT, 'tmp', 'npm-cache')
const BUNDLE = '@matrix1001/dsh-application-harness'
const PREFIX = '@matrix1001/dsh-application-harness-'

/** The requested output directory (a directory, never a file). */
function outputDir() {
  const index = process.argv.indexOf('--out')
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value === undefined ? join(ROOT, 'dist') : resolve(ROOT, value)
}

/** JSON at a path. */
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The tarball pnpm emits for a scoped package. */
function tarballName(name, version) {
  return `${name.slice(1).replace('/', '-')}-${version}.tgz`
}

/** Every own runtime dependency, mapped to its package directory. */
function ownPackages(bundle) {
  const names = Object.keys(bundle.dependencies).filter((name) => name.startsWith(PREFIX))
  const found = new Map()
  for (const area of AREAS) {
    const base = join(ROOT, 'packages', area)
    for (const dir of readdirSync(base)) {
      const file = join(base, dir, 'package.json')
      if (!existsSync(file)) continue
      const manifest = json(file)
      if (names.includes(manifest.name)) found.set(manifest.name, { dir: join(base, dir), manifest })
    }
  }
  const missing = names.filter((name) => !found.has(name))
  if (missing.length > 0) throw new Error(`bundle dependencies not found in packages/: ${missing.join(', ')}`)
  return found
}

/** Run pnpm pack in a directory and return the packed file. */
function pack(dir, destination, expected) {
  execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd: dir, stdio: 'pipe' })
  const path = join(destination, expected)
  if (!existsSync(path)) throw new Error(`pnpm pack did not produce ${path}`)
  return path
}

/** Pack the vendored bundle with npm; it keeps bundleDependencies clean. */
function packBundle() {
  mkdirSync(NPM_CACHE, { recursive: true })
  execFileSync('npm', ['pack', '--pack-destination', ASSETS], {
    cwd: PACK_ROOT,
    stdio: 'pipe',
    env: { ...process.env, npm_config_cache: NPM_CACHE },
  })
  const path = join(ASSETS, tarballName(BUNDLE, json(join(PACK_ROOT, 'package.json')).version))
  if (!existsSync(path)) throw new Error(`npm pack did not produce ${path}`)
  return path
}

/** Copy the files a published bundle needs into the pack root. */
function copyBundle() {
  mkdirSync(PACK_ROOT, { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml', 'deployment.yml']) {
    cpSync(join(BUNDLE_DIR, name), join(PACK_ROOT, name))
  }
  // Plugin display metadata (locale dictionaries) travels with the bundle so
  // the profile's plugin manager can show the name/description without
  // evaluating any code. Optional: a bundle without locale text still loads.
  if (existsSync(join(BUNDLE_DIR, 'locale'))) {
    cpSync(join(BUNDLE_DIR, 'locale'), join(PACK_ROOT, 'locale'), { recursive: true })
  }
  cpSync(join(BUNDLE_DIR, 'lib'), join(PACK_ROOT, 'lib'), { recursive: true })
  const license = join(ROOT, 'LICENSE')
  if (existsSync(license)) cpSync(license, join(PACK_ROOT, 'LICENSE'))
}

function main() {
  const bundle = json(join(BUNDLE_DIR, 'package.json'))
  if (bundle.name !== BUNDLE) throw new Error(`unexpected bundle name: ${bundle.name}`)
  if (!existsSync(join(BUNDLE_DIR, 'lib', 'index.js'))) throw new Error('bundle lib/index.js is missing — run node scripts/build-release.mjs first')
  const own = ownPackages(bundle)
  const version = bundle.version
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(ASSETS, { recursive: true })
  mkdirSync(PACK_ROOT, { recursive: true })

  for (const [name, { dir, manifest }] of own) {
    if (manifest.version !== version) throw new Error(`${name} is ${manifest.version}, bundle is ${version}; run node scripts/version.mjs first`)
    const tarball = pack(dir, ASSETS, tarballName(name, version))
    const target = join(PACK_ROOT, 'node_modules', ...name.split('/'))
    mkdirSync(target, { recursive: true })
    execFileSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], { stdio: 'pipe' })
    process.stdout.write(`  ✓ vendored ${name}@${version}\n`)
  }

  copyBundle()
  const manifestPath = join(PACK_ROOT, 'package.json')
  const release = json(manifestPath)
  for (const name of own.keys()) release.dependencies[name] = version
  release.bundleDependencies = [...own.keys()]
  delete release.devDependencies
  writeFileSync(manifestPath, JSON.stringify(release, undefined, 2) + '\n')
  const expected = tarballName(BUNDLE, version)
  const tarball = packBundle()
  const out = outputDir()
  mkdirSync(out, { recursive: true })
  const target = join(out, expected)
  cpSync(tarball, target)
  const bytes = readFileSync(target)
  writeFileSync(`${target}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  ${expected}\n`)

  // Verify the asset independently of the build tree: every own package is
  // present, no workspace protocol leaked into a manifest, and the bundle
  // patch/license are included.
  const listing = execFileSync('tar', ['-tzf', target], { encoding: 'utf8' })
  if (listing.includes('package/../')) throw new Error('tarball contains a parent-relative path')
  for (const name of own.keys()) {
    if (!listing.includes(`package/node_modules/${name}/package.json`)) throw new Error(`tarball is missing ${name}`)
  }
  if (!listing.includes('package/cordis.patch.yml')) throw new Error('tarball is missing cordis.patch.yml')
  if (!listing.includes('package/LICENSE')) throw new Error('tarball is missing LICENSE')
  if (!listing.includes('package/locale/en.json')) throw new Error('tarball is missing locale/en.json')
  const extracted = join(WORK, 'verify')
  mkdirSync(extracted, { recursive: true })
  execFileSync('tar', ['-xzf', target, '-C', extracted], { stdio: 'pipe' })
  for (const file of [join(extracted, 'package', 'package.json'), ...own.keys().map((name) => join(extracted, 'package', 'node_modules', ...name.split('/'), 'package.json'))]) {
    if (readFileSync(file, 'utf8').includes('workspace:')) throw new Error(`${file} still contains workspace:`)
  }
  process.stdout.write(`\nplugin tarball: ${target}\n`)
  process.stdout.write(`size: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB\n`)
  process.stdout.write(`sha256: ${target}.sha256\n`)
}

main()
