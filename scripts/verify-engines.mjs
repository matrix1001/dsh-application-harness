#!/usr/bin/env node
/**
 * Plugin-compatibility gate: every deployment package declares a semantic
 * `engines.dsh` range that covers the platform line this repository declares.
 *
 * The platform's compatibility check makes `engines.dsh` authoritative when it
 * is present (peerDependencies are ignored) and treats a `workspace:` value as
 * incompatible. A package without the field is silently considered compatible
 * with every DSH version, which is the failure this gate prevents: a platform
 * update would load our rows with no compatibility refusal until something
 * breaks at runtime.
 *
 * The range is intentionally the 0.2 line (`>=0.2.2-rc.1 <0.3.0`): the
 * checkout tracks master, stable 0.2.x stays accepted, and a future 0.2.x
 * prerelease requires the declared line and this range to move together.
 * @module scripts/verify-engines
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESCRIPTOR = join(ROOT, 'packages/bundle/app-harness/deployment.yml')
const SHELL = join('packages', 'typert', 'protocol')

const descriptor = readFileSync(DESCRIPTOR, 'utf8')
const declared = /declaredLine:\s*(\S+)/u.exec(descriptor)?.[1]
if (declared === undefined) {
  console.error('verify-engines: deployment.yml has no platform.declaredLine')
  process.exit(1)
}

const problems = []
let checked = 0
for (const area of readdirSync(join(ROOT, 'packages'))) {
  const areaDir = join(ROOT, 'packages', area)
  if (!statSync(areaDir).isDirectory()) continue
  for (const pkg of readdirSync(areaDir)) {
    const dir = join('packages', area, pkg)
    if (dir === SHELL) continue
    const manifestPath = join(ROOT, dir, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@matrix1001/dsh-application-harness')) continue
    checked += 1
    const range = manifest.engines?.dsh
    if (typeof range !== 'string' || range === '') {
      problems.push(`${dir}: missing engines.dsh (the platform silently treats it as compatible with every DSH version)`)
      continue
    }
    if (range.includes('workspace:')) {
      problems.push(`${dir}: engines.dsh must be a semantic version range, not ${range}`)
      continue
    }
    if (semver.valid(range) !== null) {
      problems.push(`${dir}: engines.dsh is an exact version (${range}); use a range that covers the supported line`)
      continue
    }
    if (semver.validRange(range) === null) {
      problems.push(`${dir}: engines.dsh is not a valid semantic version range (${range})`)
      continue
    }
    if (!semver.satisfies(declared, range)) {
      problems.push(`${dir}: engines.dsh ${range} does not cover the declared line ${declared}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`verify-engines: ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-engines: OK — ${checked} deployment package(s) declare engines.dsh covering ${declared}`)
