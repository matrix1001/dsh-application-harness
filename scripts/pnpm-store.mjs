/**
 * Where this workspace's package-manager scratch lives.
 *
 * Why it is a module and not a per-script literal: a confined agent session
 * (`workspace-write`) may write **only** under the session workspace, `/tmp` and
 * the platform temp dir — and `/tmp` is per-invocation ephemeral, so it is not a
 * place anything can be reused from. pnpm's content-addressable store and npm's
 * cache default to the user's home (`~/.local/share/pnpm/store`,
 * `~/.npm/_cacache`), which is *outside* that boundary: every `pnpm install` and
 * every `npm pack` therefore had to ask the user for a sandbox escalation, once
 * per command, forever (measured: 15 asks in two days, all of them this).
 *
 * Pointing both at a workspace-local directory removes the need rather than the
 * fence: the install and the pack do the same work, and the sandbox has nothing
 * to deny. The three callers — `scripts/deps.mjs` (the documented install
 * entry point), `scripts/setup.mjs` (the profile install) and
 * `scripts/verify-pack.mjs` (the pack gate) — read the paths from here, so the
 * location is stated once.
 *
 * **The store path must be passed as a command-line argument.** Measured with
 * pnpm 11.7: a `store-dir` in the project `.npmrc` is IGNORED (`pnpm store path`
 * still reports the home default and the install fails on the read-only home
 * store), and so is the `npm_config_store_dir` environment variable; only
 * `--store-dir <path>` moves it. npm is the other way round — it honours
 * `npm_config_cache` in the environment — which is why the two helpers below
 * look different.
 * @module
 */

import { join } from 'node:path'

/** The workspace-local pnpm store's directory name (gitignored; a pure cache). */
export const STORE_DIR_NAME = '.pnpm-store'

/**
 * The pnpm store this workspace installs into.
 * @param root - the repository root.
 * @returns the absolute store path.
 */
export function storeDirOf(root) {
  return join(root, STORE_DIR_NAME)
}

/**
 * The npm cache the pack gate packs with. It lives under `tmp/` (already
 * gitignored and cleaned by `pnpm run clean`) because it is scratch, not state.
 * @param root - the repository root.
 * @returns the absolute cache path.
 */
export function npmCacheDirOf(root) {
  return join(root, 'tmp', 'npm-cache')
}

/**
 * The arguments that make one `pnpm install` stay inside the workspace.
 *
 * `--config.confirmModulesPurge=false` is pnpm's own escape hatch for the other
 * half of the problem: changing the store invalidates the existing
 * `node_modules`, and pnpm refuses to purge it without a TTY
 * (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) — which is exactly the situation
 * an agent-run install is in. Without it the first install after a store move
 * aborts instead of migrating.
 * @param root - the repository root.
 * @param extra - further arguments (e.g. `--frozen-lockfile`), appended last.
 * @returns the full argument list for `pnpm`.
 */
export function pnpmInstallArgs(root, extra = []) {
  return ['install', '--store-dir', storeDirOf(root), '--config.confirmModulesPurge=false', ...extra]
}

/**
 * The environment an `npm` child needs so its cache stays inside the workspace.
 * @param root - the repository root.
 * @param env - the base environment (defaults to this process's).
 * @returns a copy of `env` with `npm_config_cache` redirected.
 */
export function npmCacheEnv(root, env = process.env) {
  return { ...env, npm_config_cache: npmCacheDirOf(root) }
}
