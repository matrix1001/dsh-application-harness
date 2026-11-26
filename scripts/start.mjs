#!/usr/bin/env node
/**
 * The daily application-harness start line.
 *
 * The application-harness is a local deployment bundle, not a normal npm plugin: it
 * links many workspace packages into a profile and serves built host/client
 * artifacts. `pnpm start` therefore owns the one thing a user should remember:
 * ensure the profile exists (first run), optionally rebuild, then hand off to
 * the launch wrapper (`scripts/launch-apps.mjs`), which runs the artifact /
 * workspace preflight and starts the installed npm platform line's dsh.
 *
 * It deliberately does NOT run `setup` when the profile already exists: setup
 * refreshes the profile and installs its dependencies, which is not a daily
 * operation. `--no-setup` makes that boundary explicit for scripts.
 *
 * Usage:
 *   pnpm start                         # daily start; opens the browser
 *   pnpm start -- --no-open            # forward web args after `--`
 *   pnpm start --build                 # build first, then start
 *   pnpm start --no-setup              # fail instead of bootstrapping a missing profile
 * @module scripts/start
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PROFILE_DEFAULT, resolveProfileDir } from './deployment-packages.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Split start's own flags from the launcher's arguments.
 * Everything after a literal `--` is passed to dsh verbatim; start flags must
 * come before it.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ build: boolean, noSetup: boolean, help: boolean, forward: string[] }} the parsed result.
 */
export function parseStartArgs(argv) {
  const parsed = { build: false, noSetup: false, help: false, forward: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      parsed.forward.push(...argv.slice(index))
      break
    }
    if (arg === '--build') parsed.build = true
    else if (arg === '--no-setup') parsed.noSetup = true
    else if (arg === '-h' || arg === '--help') parsed.help = true
    else parsed.forward.push(arg)
  }
  return parsed
}

function usage() {
  process.stdout.write(`usage: pnpm start [start options] [-- <dsh args>]\n\n`
    + `  --build       run \`pnpm run build:dev\` before starting\n`
    + `  --no-setup    fail if the profile is missing instead of bootstrapping it\n`
    + `  --profile <n> profile name (forwarded to launch-apps; default: ${PROFILE_DEFAULT})\n`
    + `  --no-open     open no browser (forwarded to dsh)\n`
    + `\nThe daily launcher is scripts/launch-apps.mjs: it checks the installed\n`
    + `platform line, the profile links and the built artifacts before starting\n`
    + `dsh in the workspace.\n`)
}

/** Find the profile name in the forwarded launcher arguments. */
function profileOf(forward) {
  for (let index = 0; index < forward.length; index += 1) {
    const arg = forward[index]
    if (arg === '--profile') return forward[index + 1] ?? PROFILE_DEFAULT
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return PROFILE_DEFAULT
}

/** Whether the profile exists as an installed profile directory. */
function profilePresent(profile) {
  return existsSync(join(resolveProfileDir({ profile }), 'package.json'))
}

/** Run one child with inherited stdio; return its exit code. */
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.error !== undefined) {
    process.stderr.write(`[start] ${String(result.error.message)}\n`)
    return 1
  }
  return result.status ?? 1
}

function main() {
  const parsed = parseStartArgs(process.argv.slice(2))
  if (parsed.help) {
    usage()
    return
  }
  if (parsed.forward.some(arg => arg === '--checkout' || arg.startsWith('--checkout='))) {
    process.stderr.write('[start] --checkout is no longer supported; pnpm start always uses the installed npm platform line\n')
    process.exitCode = 1
    return
  }
  const profile = profileOf(parsed.forward)

  if (!profilePresent(profile)) {
    if (parsed.noSetup) {
      process.stderr.write(`[start] profile ${profile} is missing; run \`pnpm run setup\` first (or omit --no-setup)\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`[start] profile ${profile} is missing — bootstrapping it with setup…\n`)
    const setup = run(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--profile', profile], ROOT)
    if (setup !== 0) {
      process.stderr.write(`[start] setup failed (exit ${String(setup)}); not starting\n`)
      process.exitCode = setup
      return
    }
  }

  if (parsed.build) {
    process.stdout.write('[start] building the workspace…\n')
    const build = run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:dev'], ROOT)
    if (build !== 0) {
      process.stderr.write(`[start] build failed (exit ${String(build)}); not starting\n`)
      process.exitCode = build
      return
    }
  }

  process.exitCode = run(process.execPath, [join(ROOT, 'scripts', 'launch-apps.mjs'), ...parsed.forward], ROOT)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
