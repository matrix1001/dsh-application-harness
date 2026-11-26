#!/usr/bin/env node
/**
 * Where workspace packages live. The repository has two shapes:
 *
 * - framework packages under `packages/<area>/<package>`;
 * - one directory per built-in application under `apps/<app>/{host,view}`,
 *   where host and view remain separate packages because they build for
 *   different execution planes.
 *
 * Scripts that walk the workspace use this module instead of repeating the
 * group names. Fixture tests that only create `packages/...` keep working: the
 * `apps` tree is optional and contributes nothing when absent.
 * @module scripts/package-areas
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** The fixed package areas under `packages/`. */
export const FRAMEWORK_AREAS = ['packages/application', 'packages/client', 'packages/bundle']

/** The per-application tree. */
export const APP_AREA = 'apps'

/**
 * Immediate child directories that carry a package manifest.
 * @param {string} base - absolute base directory.
 * @returns {string[]} absolute package directories.
 */
function childPackages(base) {
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map(entry => join(base, entry))
    .filter(dir => existsSync(join(dir, 'package.json')))
}

/**
 * Every application host package.
 * @param {string} root - repository root.
 * @returns {string[]} absolute directories, sorted.
 */
export function appHostDirs(root) {
  const base = join(root, APP_AREA)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map(app => join(base, app, 'host'))
    .filter(dir => existsSync(join(dir, 'package.json')))
    .sort()
}

/**
 * Every application view package.
 * @param {string} root - repository root.
 * @returns {string[]} absolute directories, sorted.
 */
export function appViewDirs(root) {
  const base = join(root, APP_AREA)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map(app => join(base, app, 'view'))
    .filter(dir => existsSync(join(dir, 'package.json')))
    .sort()
}

/**
 * Every deployable workspace package directory, excluding the vendored Typert
 * build shell (which has no deployment manifest).
 * @param {string} root - repository root.
 * @returns {string[]} absolute directories, sorted by relative path.
 */
export function packageDirs(root) {
  const dirs = []
  const packagesRoot = join(root, 'packages')
  if (existsSync(packagesRoot)) {
    for (const area of readdirSync(packagesRoot)) {
      for (const dir of childPackages(join(packagesRoot, area))) {
        const rel = relative(root, dir).split('\\').join('/')
        if (rel.startsWith('packages/typert')) continue
        dirs.push(dir)
      }
    }
  }
  dirs.push(...appHostDirs(root), ...appViewDirs(root))
  return [...new Set(dirs)].sort((a, b) => relative(root, a).localeCompare(relative(root, b)))
}

/**
 * Every deployable workspace package manifest path.
 * @param {string} root - repository root.
 * @returns {string[]} absolute manifest paths.
 */
export function packageManifests(root) {
  return packageDirs(root).map(dir => join(dir, 'package.json'))
}

/**
 * Map package names to their directories.
 * @param {string} root - repository root.
 * @returns {Map<string, string>} name → absolute directory.
 */
export function packageDirsByName(root) {
  const byName = new Map()
  for (const dir of packageDirs(root)) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string') byName.set(manifest.name, dir)
    } catch {
      // A malformed manifest is a package-gate problem, not a discovery failure.
    }
  }
  return byName
}

/**
 * The directory of one package by name, when present.
 * @param {string} root - repository root.
 * @param {string} name - package name.
 * @returns {string | undefined} the absolute directory.
 */
export function packageDirOf(root, name) {
  return packageDirsByName(root).get(name)
}

/**
 * Relative package directory for a root-relative manifest path.
 * @param {string} manifestPath - absolute manifest path.
 * @returns {string} the directory relative to its parent root.
 */
export function relativePackageDir(manifestPath) {
  return dirname(manifestPath)
}
