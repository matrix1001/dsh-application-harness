#!/usr/bin/env node
/**
 * The workspace typecheck: host, Typert faces, client and test files, all
 * against the published platform line installed in `node_modules`.
 *
 * There is one type plane. The repo depends on published `@deepseek-ai/dsh*`
 * packages only, so the types a release is built with and the types this
 * command reads are the same ones — CI, `release:check` and the daily loop
 * cannot disagree about an API.
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

run('host', process.execPath, [TSC, '-b', '--force', 'tsconfig.host.json'])
run('typert', process.execPath, [join(ROOT, 'scripts', 'generate-typert.mjs')])
run('client', process.execPath, [TSC, '-b', '--force', 'tsconfig.client.json'])
run('tests', process.execPath, [join(ROOT, 'scripts', 'typecheck-tests.mjs')])
