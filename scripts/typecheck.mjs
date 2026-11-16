#!/usr/bin/env node
/**
 * The development typecheck: host and client sources resolve the platform
 * types from the checkout snapshot, so an API the checkout provides can be
 * used before the same line is published to npm.
 *
 * The release typecheck (`pnpm run typecheck:release`) keeps the npm line.
 * The two are deliberately separate: dev is the execution line, release is
 * the published contract.
 *
 * @module scripts/typecheck
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** Run one step and stop at the first failure. */
function run(label, command, args) {
  process.stdout.write(`typecheck: ${label}\n`)
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const platformTypes = join(ROOT, 'scripts', 'platform-types.mjs')
run('prepare checkout types', process.execPath, [platformTypes, '--prepare'])
run('host', process.execPath, [platformTypes, '--run', process.execPath, TSC, '-b', '--force', 'tsconfig.host.json'])
run('typert', process.execPath, [join(ROOT, 'scripts', 'generate-typert.mjs')])
run('client', process.execPath, [platformTypes, '--run', process.execPath, TSC, '-b', '--force', 'tsconfig.client.json'])
run('tests', process.execPath, [join(ROOT, 'scripts', 'typecheck-tests.mjs')])
