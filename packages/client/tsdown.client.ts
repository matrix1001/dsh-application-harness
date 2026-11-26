/**
 * Shared tsdown preset for UI plugin client bundles. Emits a closure-factory
 * artifact: the bundle calls window.__ModuleLoader__.load({id, factory})
 * and resolves externals through the injected require (loader module table —
 * cordis DI entities, no globals, no import map). CSS Modules are compiled by
 * lightningcss inside the bundle: importing `x.module.css` yields the
 * hashed class map, and the css text auto-injects a <style data-plugin="<id>">
 * tag at factory execution (the loader removes plugin-owned tags on unload).
 * The virtual loader registers each real stylesheet as a watch dependency.
 *
 * **Known divergence from the checkout's `packages/client/tsdown.client.ts`**
 * (0.1.6-alpha.2, the file this one mirrors): upstream also carries the
 * package-local **async-chunk contract** — `chunkFileNames: 'client.[name].js'`,
 * a `banner` that adds a `chunk:` field for non-entry chunks, the
 * `require.async(...)` rewrite of dynamic imports (`asyncChunkRequirePlugin`),
 * and a `writeBundle` mtime stamp that advances the package revision after a
 * chunk-only rebuild (what `dsh-client-hmr` polls). None of that is ported
 * here, deliberately: nothing in this repo code-splits, and the eager
 * `load({ id, factory })` registration is still the whole loading contract
 * (`packages/client/modules/src/client/manifest.ts`). The purity gate below
 * therefore REFUSES a package-local dynamic import rather than emitting a
 * chunk this preset cannot name or load — port the contract before lifting
 * that rule.
 */
import { readFile } from 'node:fs/promises'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** The physical stylesheet behind each emitted virtual id (kept out of the id itself). */
const cssAssetPaths = new Map<string, string>()

/**
 * Wire/type layers a client bundle may inline: browser-safe contracts
 * with no runtime identity to share (no Symbol/instanceof/singleton state).
 * Everything else under @deepseek-ai/* is either a module-table entry
 * (external) or a leak the purity gate rejects.
 */
export const INLINE_SAFE = /^@deepseek-ai\/dsh-(session|llm|tools|brand)(\/|$)/

/**
 * Vendored framework libraries: rescoped into @deepseek-ai, so the gate below
 * would read them as plugin packages. They carry no cross-plugin runtime
 * identity to share — the framework itself is a platform module (external),
 * while these are ordinary libraries a browser bundle inlines.
 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/**
 * Explicit allowlist of generated typert /remote contributions a client bundle
 * may inline. Inline-safe: they are generated descriptors/codecs with no shared
 * runtime identity. This replaces the former blanket
 * `/^@deepseek-ai\/(?:dsh-|application-harness-)[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/`
 * regex (review #④, 2026-08-23) — a regex auto-inlined ANY future package's
 * /remote subpath by convention, even one that wrongly exported shared
 * identity there. Add a package's /remote here **only** once it is confirmed a
 * typert-generated contribution.
 */
const GENERATED_REMOTE = new Set(['@matrix1001/dsh-application-harness-host-bridge/remote'])

/**
 * Platform subpaths a client bundle may inline because they are **constants and
 * types only** (the platform publishes them for exactly this: the route IDs and
 * wire payloads the host routes and the browser package share). The entry is a
 * PRECISE specifier, never a whole platform package: everything else a platform
 * host package exports carries runtime identity and stays external or is
 * rejected. `dsh-host-open-in-app/shared` is the open-in-app route contract
 * (`OPEN_IN_APP_APPS_ROUTE` / `OPEN_IN_APP_OPEN_ROUTE` + the two payload types)
 * that U3's directory action drives instead of re-typing the route strings.
 */
const INLINE_PLATFORM_SUBPATHS = new Set([
  '@deepseek-ai/dsh-host-open-in-app/shared',
  // The rc.2 generator's remote contribution imports this precise subpath to
  // assemble lazy method info. It carries types and a factory only; Zod stays
  // the platform seed handled separately by the externals table.
  '@deepseek-ai/dsh-typert-protocol/remote-info',
])

/**
 * Workspace static libraries a client bundle may inline: browser-safe shared
 * chrome with no cross-plugin runtime identity to share ("narrow static
 * owner" — silence means a private copy; each consuming bundle carries its
 * own inlined copy). Not plugin packages: no dsh.client, no profile row, so
 * the inline edge is build-time only.
 *
 * The purity gate resolves each member to its SOURCE entry (not its built
 * lib): the consumer bundles the library's src with the consumer's own
 * externals — the platform baseline stays external by construction (a
 * duplicate react instance inside the lib product is impossible, the
 * 2026-09-06 TabBar useRef crash mechanism), and the inline edge carries no
 * build-order dependency on the library's lib artifact (a parallel workspace
 * build can no longer race a stale lib — the 2026-09-08 批 G build failure).
 */
const INLINE_WORKSPACE: Readonly<Record<string, string>> = {
  '@matrix1001/dsh-application-harness-client-chrome': 'packages/client/chrome/src/index.tsx',
  '@matrix1001/dsh-application-harness-client-object-reference': 'packages/client/object-reference/src/index.tsx',
}

/**
 * Workspace mode replaces an empty config array with the root defaults. A
 * falsey entry instead removes this package before entry resolution.
 */
const SKIP_WORKSPACE_BUILD: UserConfig = { entry: '' }

/** Platform seed entries: the module specifiers the host shell shares into the frozen module table (mirrors packages/client/web/src/platform.ts in the harness repo). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** Externals resolved from the loader module table: the platform seed entries. */
export const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

/**
 * Read the package's own `dsh.client.external` seam list — the exact
 * module-table value requests the platform's row composition sequences at
 * boot (the non-baseline `external` key; `inject` stays informational-only
 * and is NOT a build seam). One source, the manifest.
 * @param configUrl - the calling tsdown.config.ts's import.meta.url (the helper
 * must not resolve from its own module, which lives up the tree).
 */
export function clientExternalFromPkg(configUrl: string): string[] {
  const manifest = JSON.parse(readFileSync(new URL('package.json', configUrl), 'utf8')) as {
    dsh?: { client?: { external?: unknown } }
  }
  const external = manifest.dsh?.client?.external ?? []
  if (!Array.isArray(external) || external.some(item => typeof item !== 'string')) {
    throw new Error(`dsh.client.external in the package manifest must be a string array`)
  }
  return external as string[]
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Rebase a physical lib-relative source onto a browser URL that mirrors the repository directories. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return repositoryPath.startsWith('packages/') ? `../../../${repositoryPath}` : source
}

/**
 * Build the tsdown config for one UI plugin package: the node-half lib build
 * plus the browser client bundle. Client packages emit both halves during the
 * Client pass by default; packages needed for Host reflection may opt into the
 * earlier Host pass. A package-level tsdown.config.ts REPLACES the root
 * workspace layout, so the lib half must be restated here — dropping it leaves
 * the package without lib/index.js and the host Loader cannot import its node
 * half.
 * @param id - plugin id (package name), stamped into the __ModuleLoader__.load
 * handoff and onto the injected style tags.
 * @param libEntry - node-half entries, spelled at the call site so each
 * package's own tsdown.config.ts states exactly what its node half emits (a
 * preset-side glob would hide it).
 * @param options - phase placement, lib overrides, and companion Node configs.
 * @returns ENV-selected tsdown config for the current build face.
 */
export function clientBundle(
  id: string,
  libEntry: readonly string[],
  options: ClientBundleOptions = {},
): BuildFaceConfig {
  const lib = clientLibraryConfig(id, libEntry, options.lib)
  return ({ env }) => {
    const face = buildFace(env?.DSH_BUILD_FACE ?? process.env.DSH_BUILD_FACE)
    const client = clientConfig(id, face === undefined
      ? 'src/client/index.ts'
      : 'lib/types/client/index.js', options.clientExternal ?? [])
    const node = [lib, ...(options.companions ?? [])]
    if (face === 'host') return options.hostPhase === true ? node : [SKIP_WORKSPACE_BUILD]
    if (face === 'client') return options.hostPhase === true ? [client] : [...node, client]
    return [...node, client]
  }
}

/**
 * The css-modules inline plugin: compiles `x.module.css` into the hashed class
 * map plus an idempotent `<style data-plugin>` injector, so the styles ride
 * the JavaScript bundle (shared by the client-bundle preset and by static
 * browser libraries whose lib product is inlined into consumer bundles).
 * @param id - the package id stamped into the style tag / tag id.
 * @returns the tsdown plugin.
 */
export function cssModulesPlugin(id: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      // The virtual id is emitted into the bundle; a build-machine absolute
      // path there would leak the checkout location and make builds
      // irreproducible. Keep the physical path in this process-local map.
      const key = relative(process.cwd(), abs) || basename(abs)
      cssAssetPaths.set(key, abs)
      return CSS_VIRTUAL_PREFIX + key + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const key = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = cssAssetPaths.get(key) ?? resolvePath(process.cwd(), key)
      // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      // The style-tag plugin qualifier: the consumer's own id for its css, or
      // the source library's package name when the css lives under an inlined
      // workspace library (packages/client/<pkg>/src) — every consumer bundle
      // inlining chrome's shell.module.css stamps the SAME chrome-qualified
      // tag id, so the idempotent injector yields one shared tag instead of
      // one duplicate per consumer.
      const qualifier = cssPluginQualifier(id, fileId)
      // One <style data-plugin> per module file; idempotent under re-evaluation.
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${qualifier}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(qualifier)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/**
 * Build a Client-only Node library during the Client pass.
 * @param id - Package name used in tsdown diagnostics.
 * @param libEntry - Emitted JavaScript entries consumed from `lib/types`.
 * @returns ENV-selected tsdown config for the Client build face.
 */
export function clientLibrary(id: string, libEntry: readonly string[]): BuildFaceConfig {
  const lib = clientLibraryConfig(id, libEntry)
  return clientOnly([lib])
}

/**
 * Select arbitrary package-local configs only during the Client pass.
 * @param configs - Node-side configs emitted after Client tsc.
 * @returns ENV-selected tsdown config for the Client build face.
 */
export function clientOnly(configs: readonly UserConfig[]): BuildFaceConfig {
  return ({ env }) => buildFace(env?.DSH_BUILD_FACE ?? process.env.DSH_BUILD_FACE) === 'host'
    ? [SKIP_WORKSPACE_BUILD]
    : [...configs]
}

interface ClientBundleOptions {
  /** Emit the Node-side artifacts during the Host pass instead of the Client pass. */
  readonly hostPhase?: boolean
  /** Additional Node-side configs emitted alongside the package library. */
  readonly companions?: readonly UserConfig[]
  /** Overrides for the package's primary Node-side library config. */
  readonly lib?: UserConfig
  /**
   * Sanctioned cross-plugin value seams: the package's own
   * `dsh.client.external` module-table requests (exact import specifiers —
   * infrastructure/transport/generated-assembly edges only; `inject` stays
   * informational and is not a build seam). The client bundle externalizes
   * each declared specifier verbatim — the loader module table answers the
   * factory-time require through registered-factory recursion (the
   * dependency's stage-one prefetch keeps that factory registered first).
   * Every other @deepseek-ai value import stays a build error.
   */
  readonly clientExternal?: readonly string[]
}

type BuildFace = 'host' | 'client' | undefined

type BuildFaceConfig = (inlineConfig: Pick<UserConfig, 'env'>) => UserConfig[]

function buildFace(value: unknown): BuildFace {
  if (value === undefined || value === 'host' || value === 'client') return value
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The slice of a workspace manifest the Node half's externality rule reads.
 */
interface WorkspaceManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const manifestCache = new Map<string, WorkspaceManifest>()

/**
 * The workspace package's own manifest, by package name (the layout is fixed:
 * `packages/<group>/<dir>/package.json` or `apps/<app>/{host,view}/package.json`).
 * @param id - the package name.
 * @returns its manifest.
 * @throws when no workspace manifest declares that name.
 */
function workspaceManifest(id: string): WorkspaceManifest {
  const cached = manifestCache.get(id)
  if (cached !== undefined) return cached
  for (const manifestPath of [
    ...globSync('packages/*/*/package.json', { cwd: REPOSITORY_ROOT }),
    ...globSync('apps/*/*/package.json', { cwd: REPOSITORY_ROOT }),
  ]) {
    const manifest = JSON.parse(readFileSync(resolvePath(REPOSITORY_ROOT, manifestPath), 'utf8')) as WorkspaceManifest
    if (manifest.name !== id) continue
    manifestCache.set(id, manifest)
    return manifest
  }
  throw new Error(`tsdown: no workspace package manifest declares the name ${id}`)
}

/** Escape a package name for literal use inside a RegExp. */
function escapeSpecifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const productionExternalCache = new Map<string, readonly RegExp[]>()

/**
 * External patterns for one package's Node half: its own `dependencies`,
 * `peerDependencies` and `optionalDependencies` names, matched as `name` or
 * `name/subpath`.
 * @param id - the package name.
 * @returns the patterns.
 */
function productionExternals(id: string): readonly RegExp[] {
  const cached = productionExternalCache.get(id)
  if (cached !== undefined) return cached
  const manifest = workspaceManifest(id)
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const patterns = [...names].sort().map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
  productionExternalCache.set(id, patterns)
  return patterns
}

export function clientLibraryConfig(
  id: string,
  libEntry: readonly string[],
  overrides: UserConfig = {},
): UserConfig {
  const isProductionDependency = (specifier: string): boolean =>
    productionExternals(id).some(pattern => pattern.test(specifier))
  return {
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      // The Node half runs from a real install: a production dependency is on
      // disk there and stays an import, everything else inlines. Stating BOTH
      // halves takes the artifact off tsdown's `getProductionDeps` fallback,
      // where moving a dependency between npm sections silently re-bundles it
      // (dsh-conformance 2026-09-23, batch 5: this preset stated only the
      // browser half; the platform's own `clientLibraryConfig` states both).
      // Builtins keep tsdown's own handling (neither side claims them).
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
    ...overrides,
  }
}

function clientConfig(id: string, entry: string, clientExternal: readonly string[]): UserConfig {
  // The declared edges externalize verbatim (exact specifiers — the platform
  // matches dsh.client.external exactly, no bare-name expansion; a
  // feature-plugin value seam is never a legitimate entry).
  const seam = [...clientExternal]
  return {
    name: `${id}/client`,
    entry: { client: entry },
    // Browser bundle lands next to the node half (single lib/ artifact dir;
    // the entryFileNames pin keeps it exactly lib/client.js). clean must stay
    // off — a default clean would wipe the node-half output emitted above.
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Types ship from lib/types (tsc); dts here would wrap the banner/footer into .d.cts and break parsing.
    dts: false,
    // Plugin code is fetched outside Vite's module graph, so its own bundle
    // must carry the TS/TSX mapping consumed by browser profiling tools.
    sourcemap: true,
    clean: false,
    // tsdown auto-externalizes package dependencies; anything NOT in the
    // loader module table must inline instead (wire/type layers, clsx — every
    // non-shared dep). The rc.2 shell shares zod and @tanstack/react-virtual,
    // so both are table entries now. A require() the table cannot answer is a
    // guaranteed runtime throw, so the rule is the table list itself (plus
    // the sanctioned seams): no opinion for table entries (neverBundle above
    // wins), bundle everything else.
    deps: {
      neverBundle: [...CLIENT_EXTERNALS, ...seam],
      alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) || seam.includes(id) ? undefined : true),
    },
    // Browser bundles inline node-idiom deps (zustand/immer read
    // process.env.NODE_ENV; zustand's esm build also probes
    // import.meta.env.MODE, which a CJS output cannot carry — rolldown flags
    // EMPTY_IMPORT_META). vite defined both on the seed path; tsdown inlining
    // needs the substitutions here or the factory throws ReferenceError at
    // boot / the build gate reds. Both keys honor the build's NODE_ENV so a
    // dev build keeps the dev-branch semantics; artifacts default to production.
    // The bare `import.meta.env` key is required alongside the precise MODE
    // key: zustand probes `import.meta.env ? import.meta.env.MODE : ...`, and
    // the truthiness probe would otherwise survive as an empty import.meta.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [cssModulesPlugin(id), {
      // Bundle purity gate (build-time mirror of the module-edge rules):
      // platform seed entries stay external, inline-safe wire layers inline,
      // a package's declared dsh.client.external edges externalize verbatim
      // (the loader module table answers them), and every other
      // @deepseek-ai value import is a build error — a cross-plugin value
      // import either inlines a duplicate runtime instance or requires a
      // specifier the frozen module table cannot answer. Cross-plugin
      // collaboration goes through cordis services instead.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        // Inline workspace libraries resolve to their source entry before the
        // platform-package gate below: the consumer bundles the src (with its
        // own externals), never the library's built lib — no stale-lib race,
        // no duplicate baseline. These packages use the @matrix1001 scope, so
        // the early `@deepseek-ai/` return must not swallow them.
        const workspaceEntry = INLINE_WORKSPACE[source]
        if (workspaceEntry !== undefined) return resolvePath(REPOSITORY_ROOT, workspaceEntry)
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
        if (seam.includes(source)) return null // declared dsh.client.external edge: external, answered by the module table
        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.has(source)) return null // wire contribution: inline is the point
        if (INLINE_PLATFORM_SUBPATHS.has(source)) return null // platform subpath that is constants + types only (an exact specifier, never a whole package)
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), a declared dsh.client.external edge, an inline-safe wire layer, a generated /remote contribution, or an inline workspace library — `
          + 'a constants-and-types platform subpath, an inline workspace library, or a generated /remote contribution — '
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
      // Single-file rule (platform 0.1.6-alpha.2 folded package-local dynamic
      // imports into a chunk protocol: the chunk must be named
      // `client.<name>.js` and loaded through `require.async`, and the preset
      // stamps the entry afterwards). This fork does NOT implement that
      // protocol — the eager `load({ id, factory })` registration below is
      // still the whole contract — so a package-local dynamic import would
      // emit a bare `require(...)` the browser loader cannot answer, failing
      // at RUN time inside the running app instead of here. Refuse it at build
      // time: a client package is one file, or it is a build error.
      resolveDynamicImport(specifier: unknown) {
        if (typeof specifier !== 'string') return null
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null
        throw new Error(
          `client bundle purity: "${specifier}" is a package-local dynamic import — this preset keeps every client package a SINGLE file (no chunk protocol: no \`client.<name>.js\`, no \`require.async\`), `
          + 'so this would ship a require() the browser loader cannot answer; import it statically instead, or port the platform\'s async-chunk contract into this preset first',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // The map is served from /plugins/<scoped-package>/client.js.map. The
      // browser resolves its local sources back into URLs that mirror the
      // /packages/<group>/<package>/src directories; sourcesContent keeps them usable
      // without exposing that tree as an HTTP route.
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/**
 * The style-tag plugin qualifier for one physical css file: the consumer
 * package's id for its own stylesheet, or the owning workspace library's
 * manifest name for a css file under `packages/client/<pkg>/src` (an inlined
 * library's css keeps a library-qualified tag id whoever bundles it).
 * @param id - the consumer plugin id.
 * @param fileId - the physical stylesheet path.
 * @returns the qualifier stamped into the style tag's id/dataset.
 */
function cssPluginQualifier(id: string, fileId: string): string {
  const marker = `${sep}packages${sep}client${sep}`
  const index = fileId.indexOf(marker)
  if (index < 0) return id
  const rest = fileId.slice(index + marker.length)
  const pkgDir = rest.split(sep, 1)[0]
  if (pkgDir === undefined || pkgDir.length === 0) return id
  const manifestPath = resolvePath(REPOSITORY_ROOT, 'packages/client', pkgDir, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
    return typeof manifest.name === 'string' ? manifest.name : id
  } catch {
    return id
  }
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
