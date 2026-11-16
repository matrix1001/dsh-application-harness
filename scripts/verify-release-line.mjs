#!/usr/bin/env node
/**
 * The release-line gate: a release is allowed only when the platform checkout
 * and the npm registry agree.
 *
 * The daily execution line follows the checkout; the published plugin declares
 * and types against npm. Releasing while the checkout is ahead of npm would
 * ship artifacts built against one line and loaded by another, so this gate
 * fails until the checkout version is published and the declaration line and
 * snapshot have moved with it.
 *
 * Usage: `node scripts/verify-release-line.mjs [--checkout <dir>]`
 * Exit 0 only when checkout version = declared line = published version and
 * the snapshot commit is the checkout HEAD.
 * @module scripts/verify-release-line
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { checkoutRoot, readDeclaredLine, readSnapshotLock } from './platform-line.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Run git with the environment's broken GIT_CONFIG_* neutralized. */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
  }).trim()
}

/** Ask the registry whether the version exists. */
function registryStatus(version) {
  const result = spawnSync('npm', ['view', `@deepseek-ai/dsh@${version}`, 'version', '--json', '--cache', join(ROOT, 'tmp', 'npm-cache')], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.error !== undefined) return 'unknown'
  if (result.status === 0) return 'published'
  return /\bE404\b|404 Not Found/u.test(`${result.stdout}${result.stderr}`) ? 'missing' : 'unknown'
}

/**
 * Judge the four facts the gate has. Exported for the fixture tests: the CLI
 * collects them from the checkout, the lock, and the registry.
 * @param facts - version, published state, declared line, lock, head.
 * @returns the blocking problems, empty when the release line agrees.
 */
export function evaluateRelease({ checkoutVersion, published, declaredLine, lockCommit, head, lockError }) {
  const problems = []
  if (!semver.valid(checkoutVersion)) problems.push(`the checkout version ${String(checkoutVersion)} is not semantic`)
  if (published === 'missing') problems.push(`the checkout version ${checkoutVersion} is not published to npm — release blocked until it is`)
  else if (published === 'unknown') problems.push('the npm registry could not be queried — release blocked (fail closed)')
  if (declaredLine !== checkoutVersion) problems.push(`deployment.yml declares ${declaredLine}, but the checkout is ${checkoutVersion} — run platform-line --set ${checkoutVersion}`)
  if (lockError !== undefined) problems.push(lockError)
  else if (lockCommit !== head) problems.push(`the type snapshot commit ${String(lockCommit).slice(0, 12)} is not the checkout HEAD ${String(head).slice(0, 12)} — run platform-line --snapshot`)
  return problems
}

function main() {
  const argv = process.argv.slice(2)
  const index = argv.indexOf('--checkout')
  const checkout = index === -1 ? checkoutRoot() : resolve(argv[index + 1])
  if (!existsSync(join(checkout, 'package.json')) || !existsSync(join(checkout, '.git'))) {
    console.error(`verify-release-line: FAIL — no platform checkout at ${checkout}`)
    process.exit(1)
  }
  let checkoutVersion
  try {
    checkoutVersion = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version
  } catch (error) {
    console.error(`verify-release-line: FAIL — the checkout manifest is unreadable (${String(error)})`)
    process.exit(1)
  }
  const declaredLine = readDeclaredLine(ROOT)
  const lock = readSnapshotLock(ROOT)
  const head = git(checkout, ['rev-parse', 'HEAD'])
  const published = registryStatus(checkoutVersion)
  const problems = evaluateRelease({
    checkoutVersion,
    published,
    declaredLine,
    lockCommit: lock.commit,
    lockError: lock.error,
    head,
  })
  console.log(`verify-release-line: checkout ${checkoutVersion} @ ${head.slice(0, 12)}; declared ${declaredLine}; npm ${published}`)
  if (problems.length > 0) {
    console.error(`verify-release-line: release blocked — ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('verify-release-line: OK — the checkout line is published and the declaration/snapshot match it')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
