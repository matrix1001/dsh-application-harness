#!/usr/bin/env node
/**
 * Build one self-contained installable bundle tarball.
 *
 * A DSH profile installs the bundle with `dsh plugin add <tarball>`. The bundle
 * declares its own packages as dependencies, so a normal tarball would make
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
 * Run `pnpm run build` first: this script packs the existing
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
import { packageDirs } from './package-areas.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_DIR = join(ROOT, 'packages', 'bundle', 'app-harness')
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
  for (const dir of packageDirs(ROOT)) {
    const file = join(dir, 'package.json')
    const manifest = json(file)
    if (names.includes(manifest.name)) found.set(manifest.name, { dir, manifest })
  }
  const missing = names.filter((name) => !found.has(name))
  if (missing.length > 0) throw new Error(`bundle dependencies not found in the workspace: ${missing.join(', ')}`)
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

/** Remove local-only sourcemap comments from an assembled pack tree. */
function stripSourceMapComments(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) { stripSourceMapComments(path); continue }
    if (!entry.name.endsWith('.js')) continue
    const text = readFileSync(path, 'utf8')
    const stripped = text.replace(/^\/\/# sourceMappingURL=.*$/gmu, '')
    if (stripped !== text) writeFileSync(path, stripped)
  }
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
  if (!existsSync(join(BUNDLE_DIR, 'lib', 'index.js'))) throw new Error('bundle lib/index.js is missing — run `pnpm run build` first')
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
  stripSourceMapComments(PACK_ROOT)
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
  const listing = execFileSync('tar', ['-tzf', target], { encoding: 'utf8' }).split('\n').filter(Boolean)
  if (listing.includes('package/../')) throw new Error('tarball contains a parent-relative path')
  for (const name of own.keys()) {
    if (!listing.includes(`package/node_modules/${name}/package.json`)) throw new Error(`tarball is missing ${name}`)
  }
  for (const required of [
    'package/cordis.patch.yml',
    'package/deployment.yml',
    'package/LICENSE',
    'package/locale/en.json',
    'package/locale/zh.json',
    'package/lib/index.js',
    'package/lib/types/index.d.ts',
  ]) {
    if (!listing.includes(required)) throw new Error(`tarball is missing ${required}`)
  }
  const extracted = join(WORK, 'verify')
  mkdirSync(extracted, { recursive: true })
  execFileSync('tar', ['-xzf', target, '-C', extracted], { stdio: 'pipe' })
  const nestedManifests = [join(extracted, 'package', 'package.json'), ...own.keys().map((name) => join(extracted, 'package', 'node_modules', ...name.split('/'), 'package.json'))]
  const deployment = readFileSync(join(extracted, 'package', 'deployment.yml'), 'utf8')
  const declaredLine = /declaredLine:\s*(\S+)/u.exec(deployment)?.[1]
  if (declaredLine === undefined) throw new Error('tarball deployment.yml has no platform.declaredLine')
  for (const file of nestedManifests) {
    const text = readFileSync(file, 'utf8')
    if (text.includes('workspace:')) throw new Error(`${file} still contains workspace:`)
    const manifest = JSON.parse(text)
    if (manifest.version !== version) throw new Error(`${file} is ${manifest.version}, release is ${version}`)
    if (manifest.engines?.dsh !== undefined && manifest.engines.dsh !== declaredLine) {
      throw new Error(`${file} engines.dsh ${manifest.engines.dsh} does not match ${declaredLine}`)
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh') && value !== declaredLine) {
          throw new Error(`${file} ${field}.${name}=${value} does not match ${declaredLine}`)
        }
      }
    }
  }
  // Shipped JS must not leak the build machine, and every sourceMappingURL
  // must point at a file the tarball actually ships.
  const absolute = /(?:^|[\s"'`(=:,])\/(?:home|Users)\/[^/\s"'`]+\//u
  for (const item of listing.filter(entry => entry.endsWith('.js'))) {
    const source = readFileSync(join(extracted, item), 'utf8')
    if (absolute.test(source)) throw new Error(`${item} contains a build-machine absolute path`)
    if (source.includes('sourceMappingURL=')) throw new Error(`${item} still carries a sourceMappingURL after packaging`)
  }
  process.stdout.write(`\nplugin tarball: ${target}\n`)
  process.stdout.write(`size: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB\n`)
  process.stdout.write(`sha256: ${target}.sha256\n`)
}

main()
