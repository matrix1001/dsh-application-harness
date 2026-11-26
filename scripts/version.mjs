#!/usr/bin/env node
/**
 * Set the release-train version on every publishable package.
 *
 * The bundle is the release entry and all `@matrix1001/dsh-application-harness*`
 * packages ship together, so a version bump is one operation over the whole
 * workspace (the private Typert build shell keeps the platform line and is
 * exempt). The lockfile is refreshed because workspace importers carry the
 * package versions.
 *
 * Usage:
 *   node scripts/version.mjs 0.1.0
 *   node scripts/version.mjs 0.1.1-dev.0
 * @module scripts/version
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { packageManifests } from './package-areas.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = '@matrix1001/dsh-application-harness'

/** The requested version, or a usage error. */
function requestedVersion() {
  const value = process.argv[2]
  if (value === undefined || !semver.valid(value)) {
    process.stderr.write('usage: node scripts/version.mjs <semver>\n')
    process.exit(1)
  }
  return value
}

/** Every publishable package manifest in the release train. */
function manifests() {
  return packageManifests(ROOT)
    .map((file) => {
      try {
        return { file, manifest: JSON.parse(readFileSync(file, 'utf8')) }
      } catch {
        // A vanished/partial manifest is not a publishable package.
        return undefined
      }
    })
    .filter((entry) => entry !== undefined)
    .filter(({ manifest }) => typeof manifest.name === 'string'
      && (manifest.name === PREFIX || manifest.name.startsWith(`${PREFIX}-`))
      && manifest.private !== true)
}

const version = requestedVersion()
const packages = manifests()
if (packages.length === 0) {
  process.stderr.write('version: no publishable application-harness packages found\n')
  process.exit(1)
}
for (const { file, manifest } of packages) {
  manifest.version = version
  writeFileSync(file, JSON.stringify(manifest, undefined, 2) + '\n')
}
process.stdout.write(`version: set ${packages.length} package(s) to ${version}\n`)

// Workspace importers and node_modules carry the package version. Refresh both;
// a stale node_modules makes the next `pnpm run build` attempt an interactive
// repair, which a CI/sandbox run cannot answer.
try {
  execFileSync('pnpm', [
    'install',
    '--store-dir', join(ROOT, '.pnpm-store'),
    '--config.confirmModulesPurge=false',
    '--config.frozen-lockfile=false',
  ], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
} catch {
  process.stderr.write('version: version fields were written, but the lockfile refresh failed — run `node scripts/deps.mjs --config.frozen-lockfile=false`\n')
  process.exit(1)
}

execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify-version-sync.mjs')], { cwd: ROOT, stdio: 'inherit' })
