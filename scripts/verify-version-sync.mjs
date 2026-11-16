#!/usr/bin/env node
/**
 * Version-sync hygiene gate (worktable 调研 A2 轻量纪律).
 *
 * Every publishable workspace package shares one release version (the bundle
 * `@matrix1001/dsh-application-harness` is the release entry): a release ships them all
 * together, and a version skew means a mixed-version install. The
 * `packages/typert/protocol` shell is the documented exception — it is a
 * vendored build-only snapshot whose version tracks the *platform* line, not
 * the harness release line.
 *
 * Pure node over the workspace's `package.json` files (no install needed), so
 * it lives in `release:check` alongside the other verify scripts. Failed
 * checks exit non-zero and print which package diverges from the bundle.
 *
 * @module scripts/verify-version-sync
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUNDLE = path.join(root, 'packages/bundle/app-harness/package.json')
const SHELL = 'packages/typert/protocol'

const bundle = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'))
const releaseVersion = bundle.version
if (typeof releaseVersion !== 'string' || releaseVersion === '') {
  console.error(`verify-version-sync: the bundle has no usable version (${String(releaseVersion)})`)
  process.exit(1)
}

const divergents = []
let checked = 0
for (const group of fs.readdirSync(path.join(root, 'packages'))) {
  const groupDir = path.join(root, 'packages', group)
  if (!fs.statSync(groupDir).isDirectory()) continue
  for (const dir of fs.readdirSync(groupDir)) {
    if (`packages/${group}/${dir}` === SHELL) continue
    const pkgPath = path.join(groupDir, dir, 'package.json')
    if (!fs.existsSync(pkgPath)) continue
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    if (pkg.private === true) continue // non-published dev-only packages version freely
    checked += 1
    if (pkg.version !== releaseVersion) {
      divergents.push(`${pkg.name ?? pkgPath}: ${pkg.version} (expected ${releaseVersion})`)
    }
  }
}

if (divergents.length > 0) {
  console.error(`verify-version-sync: ${divergents.length} of ${checked} publishable packages diverge from the bundle version ${releaseVersion} (the ${SHELL} vendored shell is exempt):`)
  for (const line of divergents) console.error(`  - ${line}`)
  process.exit(1)
}
console.log(`verify-version-sync: ${checked} publishable packages all at ${releaseVersion} (${SHELL} exempt)`)
