/**
 * Type seat for `scripts/platform-checkout.mjs` — the module stays plain ESM JS
 * (the scripts plane's convention, loadable by tsdown's config loader and by
 * `node --test` alike); this declaration exists so the two tsdown configs' and
 * the two verification runners' imports carry types instead of an implicit
 * `any`.
 */

/** Where a resolved checkout artifact comes from. */
export type TypertGeneratorSource = 'checkout' | 'npm' | 'unbuilt-checkout'

/**
 * The platform checkout the runtime line follows: `$DSH_HARNESS_REPO`, or
 * `~/deepseek-harness`.
 * @param env - the environment to read (`process.env` by default).
 * @returns the absolute checkout root.
 */
export function checkoutRoot(env?: Record<string, string | undefined>): string

/**
 * Decide where the generator comes from, without loading it.
 * @param options - injectable environment and filesystem probes.
 * @returns the chosen source, the checkout it looked at, and the entry path
 *   when one exists.
 */
export function resolveTypertGenerator(options?: {
  env?: Record<string, string | undefined>
  exists?: (path: string) => boolean
  readFile?: (path: string, encoding: string) => string
}): { source: TypertGeneratorSource; checkout: string; entry: string | undefined }

/**
 * Decide which dsh binary an isolated verification run boots.
 * @param options - the repo root (for the published bin), plus injectable
 *   environment and filesystem probes.
 * @returns the chosen source, the checkout it looked at, and the bin path.
 */
export function resolveDshBin(options?: {
  repoRoot?: string
  env?: Record<string, string | undefined>
  exists?: (path: string) => boolean
}): { source: TypertGeneratorSource; checkout: string; bin: string }

/**
 * The one remedy string both the generator and the runners print for an
 * unbuilt checkout.
 * @param resolved - an `unbuilt-checkout` resolution.
 * @returns the message.
 */
export function unbuiltCheckoutMessage(resolved: {
  checkout: string
  entry?: string | undefined
  bin?: string | undefined
}): string

/**
 * Load the tsdown-facing `typertPlugin` from the resolved source.
 * @param options - resolution inputs plus the `importer`/`log` seats.
 * @returns the generator's `typertPlugin` factory.
 */
export function loadTypertPlugin(options?: {
  env?: Record<string, string | undefined>
  exists?: (path: string) => boolean
  readFile?: (path: string, encoding: string) => string
  importer?: (specifier: string) => Promise<{ typertPlugin: unknown }>
  log?: (line: string) => void
}): Promise<(pluginOptions?: {
  mode?: 'package' | 'workspace'
  faces?: readonly ('host' | 'client')[]
}) => { name: string }>
