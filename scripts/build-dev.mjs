#!/usr/bin/env node
/**
 * The development build: typecheck and emit against the installed platform
 * line, then bundle JavaScript.
 * @module scripts/build-dev
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Run one step and stop at the first failure. */
function run(label, command, args, env = process.env) {
  process.stdout.write(`build:dev: ${label}\n`)
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('typecheck', process.execPath, [join(ROOT, 'scripts', 'typecheck.mjs')])
run('bundle host', process.execPath, [join(ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')])
run('bundle client', process.execPath, [join(ROOT, 'node_modules', 'tsdown', 'dist', 'run.mjs')], { ...process.env, DSH_BUILD_FACE: 'client' })
