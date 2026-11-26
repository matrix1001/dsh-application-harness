#!/usr/bin/env node
/**
 * The documented way to install this workspace's dependencies.
 *
 * It is `pnpm install` plus the workspace-local store (`scripts/pnpm-store.mjs`),
 * because a bare `pnpm install` writes its store under the user's home — outside
 * the boundary a confined agent session may write — and therefore asks for a
 * sandbox escalation on every run. Use `node scripts/deps.mjs [-- pnpm args…]`
 * (or `pnpm run deps`) instead; the arguments after `--` are forwarded verbatim
 * to `pnpm install`, so `--frozen-lockfile`, `--offline` and friends still work.
 *
 * Deliberately NOT a bare `pnpm install` alias in `package.json`: a shell alias
 * cannot be honoured by a script, a CI job or an agent, and the failure mode of
 * forgetting it is a prompt rather than an error.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmInstallArgs } from './pnpm-store.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Resolve the pnpm command, honouring the repo's corepack pin, as {cmd, prefix}. */
function resolvePnpm() {
  const tryProbe = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 30000 }).status === 0
  if (tryProbe('pnpm')) return { cmd: 'pnpm', prefix: [] }
  if (tryProbe('corepack')) return { cmd: 'corepack', prefix: ['pnpm'] }
  process.stderr.write('error: pnpm not found — install pnpm (or enable corepack) to install this workspace\n')
  process.exit(1)
}

const extra = process.argv.slice(2)
const { cmd, prefix } = resolvePnpm()
const result = spawnSync(cmd, [...prefix, ...pnpmInstallArgs(ROOT, extra)], { cwd: ROOT, stdio: 'inherit' })
if (result.error !== undefined) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
// The client test plane reads a source fixture generated from the installed
// line (platform client entries are module-table bundles). Refresh it after
// every install so the tests never run against a stale copy.
const fixture = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-platform-fixture.mjs'), '--ensure'], { cwd: ROOT, stdio: 'inherit' })
if (fixture.error !== undefined) throw fixture.error
process.exit(fixture.status ?? 1)
