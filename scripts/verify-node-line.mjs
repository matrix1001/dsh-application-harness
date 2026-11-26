#!/usr/bin/env node
/**
 * Node-line gate: the runtime floor this repo declares is the floor the
 * installed platform declares.
 *
 * DSH 0.2.3-alpha.1 moved `engines.node` to `^24.22.3 || >=26.13.1` (the
 * undici security fixes) while every repository fact — `engines.node`,
 * `.nvmrc`, the workflows, README/START — still said 24.9.0. `verify-engines`
 * only checks `engines.dsh`, and docs testing only checks links, so nothing
 * caught the drift. This gate reads the installed platform manifest as the one
 * source and checks every place the repo repeats it.
 *
 * The running process is checked too: a release built under a Node the platform
 * refuses is not a supported deliverable, even when pnpm only warns.
 * @module scripts/verify-node-line
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The Node range the installed `@deepseek-ai/dsh` declares. */
export function platformNodeRange(root = ROOT) {
  const manifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} is missing — run: node scripts/deps.mjs`)
  const range = JSON.parse(readFileSync(manifestPath, 'utf8')).engines?.node
  if (typeof range !== 'string' || range === '' || semver.validRange(range) === null) {
    throw new Error(`${manifestPath} has no valid engines.node`)
  }
  return range
}

/** Whether one exact version satisfies a range, prereleases included. */
function satisfies(version, range) {
  return semver.valid(version) !== null && semver.satisfies(version, range, { includePrerelease: true })
}

/**
 * Run the gate.
 * @param {{ root?: string, nodeVersion?: string, log?: (line: string) => void, error?: (line: string) => void }} [options] - root and the running version (injectable for the tests).
 * @returns {number} the exit code.
 */
export function verify({ root = ROOT, nodeVersion = process.versions.node, log = console.log, error = console.error } = {}) {
  const problems = []
  let range
  try {
    range = platformNodeRange(root)
  } catch (cause) {
    error(`verify-node-line: ${String(cause.message ?? cause)}`)
    return 1
  }
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declared = rootManifest.engines?.node
  if (declared !== range) problems.push(`package.json engines.node ${String(declared)} does not match the installed platform's ${range}`)

  const nvmrcPath = join(root, '.nvmrc')
  if (!existsSync(nvmrcPath)) problems.push('.nvmrc is missing')
  else {
    const pinned = readFileSync(nvmrcPath, 'utf8').trim()
    if (!satisfies(pinned, range)) problems.push(`.nvmrc ${pinned} does not satisfy ${range}`)
  }

  const workflows = join(root, '.github', 'workflows')
  if (existsSync(workflows)) {
    for (const file of readdirSync(workflows).filter(entry => entry.endsWith('.yml') || entry.endsWith('.yaml'))) {
      const text = readFileSync(join(workflows, file), 'utf8')
      for (const match of text.matchAll(/node-version:\s*(\S+)/gu)) {
        const value = match[1].replace(/['"]/gu, '')
        if (!satisfies(value, range)) problems.push(`.github/workflows/${file} node-version ${value} does not satisfy ${range}`)
      }
    }
  }

  for (const file of ['README.md', join('docs', 'START.md')]) {
    const path = join(root, file)
    if (!existsSync(path)) {
      problems.push(`${file} is missing`)
      continue
    }
    if (!readFileSync(path, 'utf8').includes(range)) problems.push(`${file} does not name the Node range ${range}`)
  }

  if (!satisfies(nodeVersion, range)) problems.push(`the running Node ${nodeVersion} does not satisfy ${range}`)

  if (problems.length > 0) {
    error(`verify-node-line: FAIL — ${problems.length} problem(s):`)
    for (const problem of problems) error(`  - ${problem}`)
    return 1
  }
  log(`verify-node-line: OK — engines, .nvmrc, workflows and docs agree on ${range} (running ${nodeVersion})`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(verify())
}
