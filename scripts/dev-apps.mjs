#!/usr/bin/env node
/**
 * Project-local iteration tool for app development. Host code must be rebuilt;
 * a rebuilt `link:`-ed package is replaced at the next profile recomposition
 * when the host mounts `dsh-hmr` (the platform does not watch this repo's
 * sources, so editing src without rebuilding changes nothing), and a restart
 * remains the safe default. Client bundles are not auto-HMR'd either (the
 * platform's `dev:web` watch covers only its own packages), so this script
 * closes that loop:
 *
 *   1. rebuild the client bundles (`tsdown` — the built `lib/client.js` lands
 *      in the workspace and, under the official-channel `link:` profile
 *      deployment (2026-09-07 migration), is live in the profile immediately;
 *      refresh the browser, no dsh restart).
 *   2. verify every deployed application-harness package entry points back at this
 *      workspace (a missing entry means the profile was never set up or was
 *      rebuilt without this checkout).
 *   3. remind you that a host-side change needs a rebuild (and a restart unless
 *      a recomposition replaces the linked package first).
 *
 * The former `--refresh` hardlink-snapshot ritual is retired: the deployment
 * now symlinks the workspace packages, so newly added build outputs appear
 * automatically (the `file:` hardlink quirk no longer exists).
 *
 * Usage:
 *   node scripts/dev-apps.mjs
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// T1: the deployment set and the profile path come from ONE shared resolver
// (`deployment-packages.mjs`) — the same set setup.mjs installs. The set is the
// explicit package areas + the application-harness naming rule: it excludes the private
// typert build shell (which has build output but is never deployed) and it
// still checks a legitimately unbuilt package instead of skipping it.
import { checkDeploymentEntries, deploymentDirOf, deploymentPackages, resolveProfileDir, PROFILE_DEFAULT } from './deployment-packages.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env.APPLICATION_HARNESS_PROFILE ?? PROFILE_DEFAULT
const DEPLOYMENT = deploymentDirOf(resolveProfileDir({ profile: PROFILE }))

// tsdown's real entry, not `node_modules/.bin/tsdown`: pnpm writes that as a
// POSIX shell shim, and `node <shell script>` is a SyntaxError (2026-09-10 —
// the shim form surfaced after a reinstall; the resolved entry runs under node
// on every platform).
const TSDOWN = fileURLToPath(import.meta.resolve('tsdown/run'))

/** Run one tsdown pass over the workspace. */
function runTsdown() {
  execFileSync(process.execPath, [TSDOWN], { cwd: ROOT, stdio: 'inherit' })
}

/** Generate the Typert wire artifacts from source before bundling. The
 * bundle-free pass replaces the old writeBundle ordering, so the client
 * bundles inline the current contract in the same run. */
function generateTypert() {
  console.log('[dev-apps] generating Typert contracts…')
  execFileSync(process.execPath, [join(ROOT, 'scripts/generate-typert.mjs')], { cwd: ROOT, stdio: 'inherit' })
}

/** Rebuild the client bundles. A client change is not auto-HMR'd by the platform's
 * `dev:web` watch (it covers only its own packages); the rebuild rewrites each
 * package's `lib/client.js` — and advances its mtime, the judgement
 * `dsh-client-hmr` polls — so the browser picks it up on a refresh. */
function rebuildClient() {
  generateTypert()
  console.log('[dev-apps] rebuilding client bundles (tsdown)…')
  runTsdown()
}

/** Verify each deployed package's profile entry resolves back at this workspace (the shared T1 check). */
function checkDeployment() {
  return checkDeploymentEntries({ packages: deploymentPackages(ROOT), deploymentDir: DEPLOYMENT })
}

rebuildClient()

const missing = checkDeployment()
if (missing.length > 0) {
  console.log(`\n[dev-apps] ${missing.length} deployment problem(s):`)
  for (const line of missing.slice(0, 30)) console.log(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('\n[dev-apps] deployment entries all resolve to this workspace (link: channel).')
}

console.log(`\n[dev-apps] profile: ${PROFILE} @ ${DEPLOYMENT}`)
console.log('\n[dev-apps] reminder: host-side / application changes are NOT hot-reloaded by default — restart dsh to pick them up.')
console.log('[dev-apps]   (the platform `dsh-hmr` row can watch this repo through a patch overlay; probe-verified 2026-09-18 — see the build section of AGENTS.md)')
console.log('[dev-apps] preflight for the checkout launch lane: node scripts/launch-apps.mjs --check-only')
