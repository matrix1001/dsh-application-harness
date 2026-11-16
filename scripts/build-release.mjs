#!/usr/bin/env node
/**
 * Build the workspace on the *published/npm* platform line.
 *
 * Daily development builds against the platform checkout (`pnpm run build`):
 * the checkout supplies the Typert generator, so the artifacts match the
 * runtime `pnpm start` boots. The plugin is installed into a user's DSH
 * installation from npm, so its tarballs must be built the way the Pages
 * workflow builds them: with no checkout available. Pointing
 * `DSH_HARNESS_REPO` at a path that does not exist selects exactly that
 * fallback (see scripts/platform-checkout.mjs) without changing any source.
 *
 * Run `pnpm run build` again afterwards to restore checkout-line artifacts for
 * daily development; `pnpm run test:plugin` does both automatically.
 *
 * @module scripts/build-release
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NO_CHECKOUT = join(ROOT, 'tmp', 'release-line-no-checkout')

const result = spawnSync('pnpm', ['run', 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DSH_HARNESS_REPO: NO_CHECKOUT, CI: 'true' },
})
if (result.error !== undefined) {
  process.stderr.write(`build-release: ${String(result.error)}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
