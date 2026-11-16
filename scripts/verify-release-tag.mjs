#!/usr/bin/env node
/**
 * Check that a release tag names the version the bundle actually carries.
 *
 * Tags are `vX.Y.Z` (or a deliberate SemVer prerelease). A `-dev.` version on
 * a tag is refused: dev versions belong to main between releases and must not
 * be published as a release.
 *
 * Usage:
 *   node scripts/verify-release-tag.mjs v0.1.0
 *   node scripts/verify-release-tag.mjs "$GITHUB_REF_NAME"
 * @module scripts/verify-release-tag
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tag = process.argv[2]
if (typeof tag !== 'string' || !tag.startsWith('v')) {
  process.stderr.write('usage: node scripts/verify-release-tag.mjs v<semver>\n')
  process.exit(1)
}
const version = tag.slice(1)
if (semver.valid(version) === null) {
  process.stderr.write(`verify-release-tag: ${JSON.stringify(tag)} is not v<semver>\n`)
  process.exit(1)
}
if (version.includes('-dev.')) {
  process.stderr.write(`verify-release-tag: ${tag} is a dev version; tag a release version instead\n`)
  process.exit(1)
}
const bundle = JSON.parse(readFileSync(join(ROOT, 'packages', 'bundle', 'app-harness', 'package.json'), 'utf8'))
if (bundle.version !== version) {
  process.stderr.write(`verify-release-tag: tag ${tag} names ${version}, bundle is ${bundle.version}\n`)
  process.exit(1)
}
process.stdout.write(`verify-release-tag: OK — ${tag} matches bundle ${bundle.version}\n`)
