/**
 * The platform checkout as our runtime line: resolving the two things it
 * supplies to this repo — the Typert generator our build emits faces with, and
 * the dsh binary our verification runners boot.
 *
 * The rule is the same for both, and it exists because the two lines drifted
 * apart: the profile already links the checkout, so a checkout runtime
 * validates our artifacts, but the build tool and the verification runners
 * still used the published line. That drift broke on 2026-09-16 — the platform
 * changed the strict-codec seat after the 0.1.6-alpha.1 tag
 * (`perf(typert): materialize generated schemas on first use` — the codec's
 * `schema` became a lazy `create: () => TypertSchema` factory), the checkout's
 * loader rejected faces emitted by the published generator, and the whole
 * typert-loader entry failed. So:
 *
 * - a **built** checkout at `$DSH_HARNESS_REPO` (default `~/deepseek-harness`)
 *   supplies the generator and the dsh binary — artifacts and verification
 *   take the runtime's shape;
 * - no checkout at all falls back to the published packages — that is CI,
 *   where the probe dsh is the npm-installed pinned line, so published-shape
 *   faces are exactly what that runtime accepts;
 * - a checkout that exists but is **not built** is an error, not a fallback:
 *   silently shipping published-line artifacts to a checkout runtime, or
 *   verifying against a runtime nobody launches, is the failure this
 *   resolution exists to prevent. Run `pnpm run build` in the checkout.
 *
 * The vendored protocol shell (`packages/typert/protocol`) is the type-side half
 * of the same rule: the generator's workspace analysis reads the protocol
 * types in OUR workspace, so the shell follows the checkout's
 * `packages/typert/protocol/src`. It stays a registered project so the
 * generator recognizes its type-meta symbols; its Context augmentation is
 * removed locally so discovery does not treat it as a contributor.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The published generator specifier — the no-checkout (CI) path. */
const PUBLISHED_GENERATOR = '@deepseek-ai/dsh-typert-generator/tsdown'

/** The generator package directory inside a platform checkout. */
function generatorDir(checkout) {
  return join(checkout, 'packages', 'typert', 'generator')
}

/**
 * The platform checkout the runtime line follows: `$DSH_HARNESS_REPO`, or
 * `~/deepseek-harness` (the convention documented in README.md).
 * @param env - the environment to read (`process.env` by default).
 * @returns the absolute checkout root.
 */
export function checkoutRoot(env = process.env) {
  const configured = env.DSH_HARNESS_REPO
  return configured !== undefined && configured !== '' ? resolve(configured) : join(homedir(), 'deepseek-harness')
}

/** Read the checkout generator's `./tsdown` runtime target (its package.json export). */
function generatorEntry(dir, readFile) {
  try {
    const manifest = JSON.parse(readFile(join(dir, 'package.json'), 'utf8'))
    const exported = manifest?.exports?.['./tsdown']
    const specifier = typeof exported === 'string' ? exported : exported?.default
    return typeof specifier === 'string' ? resolve(dir, specifier) : undefined
  } catch {
    return undefined
  }
}

/**
 * Decide where the generator comes from, without loading it.
 * @param options - injectable environment and filesystem probes (tests).
 * @returns `{ source: 'checkout' | 'npm' | 'unbuilt-checkout', checkout, entry }`.
 */
export function resolveTypertGenerator({ env = process.env, exists = existsSync, readFile = readFileSync } = {}) {
  const checkout = checkoutRoot(env)
  const dir = generatorDir(checkout)
  if (!exists(dir)) return { source: 'npm', checkout, entry: undefined }
  const entry = generatorEntry(dir, readFile)
  if (entry === undefined || !exists(entry)) {
    return { source: 'unbuilt-checkout', checkout, entry: entry ?? join(dir, 'lib', 'types', 'tsdown-plugin.js') }
  }
  return { source: 'checkout', checkout, entry }
}

/**
 * Decide which dsh binary a run boots: the checkout's built CLI when the
 * checkout is there, the repo-local published install otherwise (CI).
 *
 * The daily launch passes its own `--checkout` here (`launch-apps.mjs`): that
 * flag is resolved independently of `$DSH_HARNESS_REPO`, and the wrapper must
 * boot the binary of the checkout it was handed, not of whatever the
 * environment points at. Without an explicit checkout this reads
 * `$DSH_HARNESS_REPO` → `~/deepseek-harness`, the isolated runners' rule.
 * @param options - injectable checkout, environment, and filesystem probes (tests).
 * @returns `{ source: 'checkout' | 'npm' | 'unbuilt-checkout', checkout, bin }`.
 */
export function resolveDshBin({ repoRoot, env = process.env, checkout = checkoutRoot(env), exists = existsSync } = {}) {
  const cliDir = join(checkout, 'apps', 'cli')
  if (!exists(cliDir)) {
    return { source: 'npm', checkout, bin: join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') }
  }
  const bin = join(cliDir, 'lib', 'bin.js')
  if (!exists(bin)) return { source: 'unbuilt-checkout', checkout, bin }
  return { source: 'checkout', checkout, bin }
}

/**
 * The one remedy string both the generator and the runners print for an
 * unbuilt checkout, so the failure reads the same wherever it surfaces.
 * @param resolved - an `unbuilt-checkout` resolution.
 * @returns the message.
 */
export function unbuiltCheckoutMessage(resolved) {
  const expected = resolved.entry ?? resolved.bin
  return `the platform checkout at ${resolved.checkout} is not built (expected ${String(expected)})`
    + ' — run `pnpm run build` in the checkout first, or point DSH_HARNESS_REPO at a built one'
}

/**
 * Decide which generator **root API** a bundle-free pass loads (as opposed to
 * {@link resolveTypertGenerator}, which resolves the tsdown subpath). The
 * checkout-first rule is the same: a built checkout supplies the generator,
 * no checkout falls back to the published package, and an unbuilt checkout is
 * an error rather than a silent fallback.
 * @param options - injectable environment and filesystem probes (tests).
 * @returns `{ source: 'checkout' | 'npm' | 'unbuilt-checkout', checkout, entry }`.
 */
export function resolveTypertGeneratorApi({ env = process.env, exists = existsSync } = {}) {
  const checkout = checkoutRoot(env)
  const dir = generatorDir(checkout)
  if (!exists(dir)) return { source: 'npm', checkout, entry: undefined }
  const entry = join(dir, 'lib', 'index.js')
  if (!exists(entry)) return { source: 'unbuilt-checkout', checkout, entry }
  return { source: 'checkout', checkout, entry }
}

/**
 * Load the generator's root API (`findWorkspaceRoot`,
 * `WorkspaceTypertGenerator`, `writeWorkspaceArtifacts`, …) from the resolved
 * source.
 * @param options - resolution inputs plus `importer`/`log` seats (tests).
 * @returns the generator module namespace.
 */
export async function loadTypertGenerator({
  importer = (specifier) => import(specifier),
  log = (line) => process.stdout.write(`${line}\n`),
  ...resolution
} = {}) {
  const resolved = resolveTypertGeneratorApi(resolution)
  if (resolved.source === 'unbuilt-checkout') {
    throw new Error(`typert: ${unbuiltCheckoutMessage(resolved)}`)
  }
  if (resolved.source === 'npm') {
    log(
      `typert: no platform checkout at ${resolved.checkout}; using the published generator`
      + ' — artifact shape follows the published line, not a runtime checkout',
    )
  }
  const specifier = resolved.source === 'checkout'
    ? pathToFileURL(resolved.entry).href
    : '@deepseek-ai/dsh-typert-generator'
  return importer(specifier)
}

/**
 * Load the tsdown-facing `typertPlugin` from the resolved source.
 * @param options - resolution inputs plus `importer`/`log` seats (tests).
 * @returns the generator's `typertPlugin` factory.
 */
export async function loadTypertPlugin({
  importer = (specifier) => import(specifier),
  log = (line) => process.stdout.write(`${line}\n`),
  ...resolution
} = {}) {
  const resolved = resolveTypertGenerator(resolution)
  if (resolved.source === 'unbuilt-checkout') {
    throw new Error(`typert: ${unbuiltCheckoutMessage(resolved)}`)
  }
  if (resolved.source === 'npm') {
    log(
      `typert: no platform checkout at ${resolved.checkout}; using the published generator`
      + ' — face shape follows the published line, not a runtime checkout',
    )
  }
  const specifier = resolved.source === 'checkout' ? pathToFileURL(resolved.entry).href : PUBLISHED_GENERATOR
  const module = await importer(specifier)
  return module.typertPlugin
}
