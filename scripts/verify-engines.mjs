#!/usr/bin/env node
/**
 * Plugin-compatibility gate: every deployment package declares `engines.dsh`
 * equal to the platform line this repository declares.
 *
 * The platform's compatibility check makes `engines.dsh` authoritative when it
 * is present (peerDependencies are ignored) and treats a `workspace:` value as
 * incompatible. A package without the field is silently considered compatible
 * with every DSH version, which is the failure this gate prevents: a platform
 * update would load our rows with no compatibility refusal until something
 * breaks at runtime.
 *
 * The value is the exact declared line: this plugin supports the published
 * version it was built and tested against and refuses every other runtime
 * rather than assuming an untested range is compatible.
 * @module scripts/verify-engines
 */

import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { packageManifests } from './package-areas.mjs'

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
for (const manifestPath of packageManifests(ROOT)) {
  const dir = relative(ROOT, manifestPath).split('\\').join('/').replace(/\/package\.json$/u, '')
  if (dir === SHELL) continue
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    continue
  }
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@matrix1001/dsh-application-harness')) continue
  checked += 1
  {
    const range = manifest.engines?.dsh
    if (typeof range !== 'string' || range === '') {
      problems.push(`${dir}: missing engines.dsh (the platform silently treats it as compatible with every DSH version)`)
      continue
    }
    if (range.includes('workspace:')) {
      problems.push(`${dir}: engines.dsh must be a semantic version range, not ${range}`)
      continue
    }
    if (semver.valid(range) === null) {
      problems.push(`${dir}: engines.dsh must be the exact declared version (${range}); only the published line is supported`)
      continue
    }
    if (range !== declared) {
      problems.push(`${dir}: engines.dsh ${range} does not match the declared line ${declared}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`verify-engines: ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-engines: OK — ${checked} deployment package(s) pin engines.dsh to ${declared}`)
