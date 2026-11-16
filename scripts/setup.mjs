#!/usr/bin/env node
/**
 * One-time bootstrap for dsh-application-harness.
 *
 * Builds the workspace and creates the dedicated dsh profile (`application-harness`)
 * with the harness machinery + the four example applications link:-linked from
 * this checkout (official bundle-layer channel: the bundle patch carries the
 * machinery + generated application rows; the profile patch is a pure user
 * layer). It does NOT boot the UI — the daily launch is `pnpm start`
 * (scripts/start.mjs), which hands off to the platform checkout wrapper after
 * its preflight:
 *
 *     pnpm start
 *
 * (`--launch` remains as a deprecated registry/PATH boot path; it is not the
 * checkout execution line.)
 *
 * The booted child's cwd is the workspace ($DSH_WORKSPACE, otherwise
 * ~/dsh-workspaces/<profile>), never this repository. Application data lives
 * under DSH_HOME; a legacy .dsh-applications directory is moved only after an
 * interactive confirmation. Both launchers use scripts/workspace.mjs.
 *
 * The user needs `@deepseek-ai/dsh` on PATH (or reachable through `npx`, or set
 * `DSH_BIN`). The web UI opens at http://127.0.0.1:3080.
 *
 * Usage:
 *   node scripts/setup.mjs                  # build + create/install the application-harness profile
 *   node scripts/setup.mjs --launch         # deprecated: boot via registry/PATH; use pnpm start
 *   node scripts/setup.mjs --no-build       # skip the build (lib/ already present)
 *   node scripts/setup.mjs --no-install     # skip the repo install (node_modules present)
 *   node scripts/setup.mjs --profile X      # use/name the profile X (default application-harness)
 *   node scripts/setup.mjs --no-open        # (with --launch) boot without opening a browser
 *   node scripts/setup.mjs --dry-run        # generate+print profile files, no install/boot
 *   node scripts/setup.mjs -- <web args>    # extra inner args for the web app (with --launch)
 *   Environment:
 *     DSH_WORKSPACE         the workspace the booted world belongs to
 *                           (default: ~/dsh-workspaces/<profile>; a relative value resolves against the invocation cwd)
 *     DSH_WORKSPACE_LEGACY  `path.delimiter`-separated directories a legacy `.dsh-applications/` may live in
 *                           (default: this repo + $DSH_CHECKOUT; empty = no legacy world)
 * @module
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
// The deployment set and the profile path resolve in ONE place
// (scripts/deployment-packages.mjs), shared with dev-apps.mjs / launch-apps.mjs
// — T1: the set follows the package areas + the naming rule, never `private`
// or "a lib/ exists".
import { deploymentPackages, resolveLaunchSource, resolveProfileDir, PROFILE_DEFAULT } from './deployment-packages.mjs'
// The workspace resolver is the SAME module the checkout wrapper uses (D1): one
// entry booting the repo root and the other the checkout is exactly the
// two-worlds defect this shares a fix with.
import { defaultCheckout } from './launch-apps.mjs'
import { prepareWorkspace, resolveWorkspace, worldDirOf } from './workspace.mjs'
import { pnpmInstallArgs } from './pnpm-store.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {{profile:string, build:boolean, install:boolean, launch:boolean, dshBin?:string, dryRun:boolean, extra:string[]}} */
const opts = { profile: PROFILE_DEFAULT, build: true, install: true, launch: false, dshBin: undefined, dryRun: false, extra: [] }

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-build') opts.build = false
    else if (arg === '--build') opts.build = true
    else if (arg === '--no-install') opts.install = false
    else if (arg === '--install') opts.install = true
    else if (arg === '--launch') opts.launch = true
    else if (arg === '--no-open') opts.extra.push('--no-open')
    else if (arg === '--profile') opts.profile = argv[++i]
    else if (arg === '--dsh') opts.dshBin = argv[++i]
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--') opts.extra.push(...argv.slice(i + 1))
    else if (arg === '-h' || arg === '--help') { usage(); process.exit(0) }
    else opts.extra.push(arg)
  }
}
function usage() {
  process.stdout.write(`usage: node scripts/setup.mjs [options]\n\n`
    + `  --no-build      skip the workspace build (lib/ already present)\n`
    + `  --no-install    skip the repo install (node_modules present)\n`
    + `  --profile <n>   profile name (default: ${PROFILE_DEFAULT})\n`
    + `  --launch        deprecated: registry/PATH boot; use pnpm start\n`
    + `  --no-open       (with --launch) boot the web UI without opening a browser\n`
    + `  --dsh <bin>     explicit dsh bin (else PATH, else npx @deepseek-ai/dsh)\n`
    + `  --dry-run       generate+print the profile files and exit (no install/boot)\n`
    + `\n--launch boots the world in the workspace, not in this repo:\n`
    + `  DSH_WORKSPACE   workspace directory (default ~/dsh-workspaces/<profile>;\n`
    + `                  a relative value resolves against the invocation cwd)\n`
    + `  DSH_WORKSPACE_LEGACY  PATH-style separated ('${delimiter}') legacy .dsh-applications/ candidates\n`
    + `                  (default: this repo + $DSH_CHECKOUT; empty = none)\n`
    + `\nDaily launch:  pnpm start\n`
    + `Direct boot:   (cd <workspace> && dsh --profile ${PROFILE_DEFAULT} --no-open)   # cwd = the workspace, not the checkout\n`)
}
parseArgs(process.argv.slice(2))

const log = (message) => process.stdout.write(`${message}\n`)
const warn = (message) => process.stderr.write(`warning: ${message}\n`)
const fail = (message) => { process.stderr.write(`error: ${message}\n`); process.exit(1) }

/** Resolve the pnpm command, honoring the repo's corepack pin, as {cmd, prefix}. */
function resolvePnpm() {
  const tryProbe = (cmd) => {
    const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 30000 })
    return probe.status === 0
  }
  if (tryProbe('pnpm')) return { cmd: 'pnpm', prefix: [] }
  if (tryProbe('corepack')) return { cmd: 'corepack', prefix: ['pnpm'] }
  fail('pnpm not found — install pnpm (or enable corepack) to build the workspace and install the profile')
}

/** Run a command; inherit stdio. Returns the exit code, or throws on spawn error. */
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

/** Ensure a directory exists. */
function ensureDir(dir) { mkdirSync(dir, { recursive: true }) }

/** Verify Node satisfies the repo engine range. */
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) {
    fail(`Node ${process.version} is too old — this repo needs Node >= 24.9.0 (engines)`)
  }
}


/** The profile dir under $DSH_HOME (the one resolver, shared with the launcher wrapper). */
function profileDir() {
  return resolveProfileDir({ profile: opts.profile })
}

/** The profile scaffold files, and what each side owns. */
const PROFILE_WORKSPACE_TEMPLATE = ['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n')

/** The bundles this deployment requires, in layer order. */
const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@matrix1001/dsh-application-harness']

/**
 * Merge this deployment's required bundles into the profile's list.
 *
 * `dsh.profile.bundles` is not ours alone: platform 0.1.7's plugin manager reads
 * it as each bundle's `enabled` flag (`packages/boot/app-boot/src/profile-plugins.ts`
 * — `readProfilePlugins` reads `bundles.includes(name)`, `writeProfileBundles`
 * and `reconcileProfilePlugins` write it after every activate/deactivate).
 * Rewriting the list wholesale silently rolled those choices back — an enabled
 * bundle vanished from the layer stack, a disabled one came back — with the
 * dependency left behind in `package.json`. So: keep every entry and its order,
 * append only what is missing, never remove a USER choice. A missing required
 * entry is indistinguishable in the manifest from a deliberate deactivation, so
 * the caller reports the append instead of guessing which one it was.
 *
 * The one exception is `dropped`: names whose dependency this repo itself just
 * proved stale (renamed or gone — see {@link writeProfile}). Such a name is not
 * a user choice and cannot be loaded from that dependency, but leaving it in the
 * list keeps a phantom bundle in the layer stack: with the dependency gone the
 * boot reports a skipped bundle, and with it still there the plugin page shows a
 * second card for the SAME patch.
 * @param existing - the profile manifest's current `dsh.profile.bundles`, if any.
 * @param required - the bundles this deployment needs in the layer stack.
 * @param dropped - dependency names this run removed as stale, never a user choice.
 * @returns the merged list, the names that were appended, and the stale ones removed.
 */
function mergeBundles(existing, required, dropped = new Set()) {
  const listed = Array.isArray(existing) ? existing.filter(name => typeof name === 'string' && name !== '') : []
  const kept = listed.filter(name => !dropped.has(name))
  const removed = listed.filter(name => dropped.has(name))
  const added = required.filter(name => !kept.includes(name))
  return { bundles: [...kept, ...added], added, removed }
}

/**
 * The profile's own patch layer header. Since platform 0.1.7-alpha.1 this file
 * is **the platform's settings document**, not only our empty overlay: the
 * config editor and the settings service persist user and plugin configuration
 * into it (`packages/boot/config-editor` → `profileContext.patchPath`,
 * `packages/settings/settings` likewise), and the platform's own settings page
 * writes rows here by plugin id. The header is written ONLY when the file does
 * not exist yet — an existing document is never touched (see {@link writeProfile}).
 */
function userLayerTemplate() {
  return `# ${opts.profile} 用户层（user patch layer）—— 叠加序 = 各 bundle 层 → 本用户层 → 启动器 --patch 层。
# 机制行与应用行来自 @matrix1001/dsh-application-harness bundle 层
# （packages/bundle/app-harness/cordis.patch.yml，含生成器聚合的应用行）。
# 平台把用户/插件设置写进本文件（设置页、插件管理），所以它由平台拥有：
# setup 只在它不存在时写这份模板，已存在的内容一律原样保留。
[]
`
}

/** Parse the profile's existing patch layer, or `undefined` when unreadable. */
function readUserLayer(path) {
  try {
    return parseYaml(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Seed the profile: the manifest, pnpm workspace settings, and the patch layer.
 * 官方通道形态（迁移计划决策 1/3/5，2026-09-07）：deps 用 `link:`（符号链接整
 * 目录——新构建产物自动出现，hardlink 快照怪癖从根消失）；`dsh.profile.bundles`
 * 显式列出平台双 bundle + application-harness bundle（行集 = bundle patch 内的机制行 +
 * 生成器聚合的应用行，单一 bundle 层、确定性顺序）。
 *
 * **This is a merge, not a rebuild** (2026-09-23). The profile directory holds
 * state the platform owns — user settings in `cordis.patch.yml`, plugins the
 * plugin manager installed into `package.json`, and build approvals in
 * `pnpm-workspace.yaml` — and until 0.1.7 the first two lived outside it
 * (`$DSH_HOME/settings.yaml`), which is why destroying the directory used to be
 * harmless. It is not any more: this function used to be reached right after an
 * `rmSync(dir)`, so one settings-page edit plus one `setup` run silently reset
 * every setting and dropped every installed plugin. Now the directory is never
 * removed, our dependency set is refreshed IN PLACE, the bundle list is merged
 * rather than rewritten (`dsh.profile.bundles` is the plugin manager's
 * activate/deactivate field — see {@link mergeBundles}), and the two
 * platform-owned files are left alone.
 * @param dir - the profile directory.
 * @param packages - this repo's deployment packages (name → absolute dir).
 * @throws when an existing patch layer is present but not a readable YAML array.
 */
/**
 * Whether an absolute path is inside this repo's `packages/` tree. It is the one
 * test that tells a dependency of OURS (a `link:` into the deployment packages)
 * from a plugin the manager installed (a `link:` into the pnpm store).
 * @param target - the dependency's `link:` target.
 * @returns whether the path belongs to this repo.
 */
function isInsideRepoPackages(target) {
  const packagesRoot = join(ROOT, 'packages')
  return target === packagesRoot || target.startsWith(`${packagesRoot}/`)
}

/**
 * The package name a directory's own manifest declares, or `undefined` when it
 * cannot be read. A rename keeps the package DIRECTORY, so the link target's
 * existence cannot tell an old dependency key from a current one; the manifest
 * inside it can.
 * @param target - the dependency's `link:` target.
 * @returns the declared `name`, if readable.
 */
function declaredPackageName(target) {
  try {
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    return typeof manifest.name === 'string' ? manifest.name : undefined
  } catch {
    return undefined
  }
}

function writeProfile(dir, packages) {
  ensureDir(dir)
  const deps = {}
  for (const [name, pkgDir] of packages) deps[name] = `link:${pkgDir}`
  // What the plugin manager installed (any dependency outside our deployment
  // set) is kept; our own entries are refreshed, and one that this repo no
  // longer deploys is dropped.
  const manifestPath = join(dir, 'package.json')
  let existing = {}
  if (existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      fail(`the profile manifest is unreadable — refusing to overwrite it: ${manifestPath} (${String(error)})`)
    }
  }
  const managed = new Set(Object.keys(deps))
  // What the plugin manager installed is kept; our own entries are refreshed —
  // and an entry of OURS that this repo no longer deploys is dropped. The two
  // cases are told apart by the link target, not by the name: a dependency whose
  // `link:` points into this repo's `packages/` is ours (a removed deployment
  // package leaves a dangling entry; a RENAMED one leaves an entry whose target
  // still exists but whose manifest now declares another name — the 2026-11
  // `@deepseek-ai` → `@matrix1001` rename left 26 such pairs, one of them the
  // bundle layer itself, so the plugin page showed that bundle twice), while a
  // plugin the manager installed links into the pnpm store and is never touched
  // here.
  const dropped = new Set()
  const keptEntries = Object.entries(existing.dependencies ?? {}).filter(([name, spec]) => {
    if (managed.has(name)) return false
    if (typeof spec !== 'string' || !spec.startsWith('link:')) return true
    const target = spec.slice('link:'.length)
    if (!isInsideRepoPackages(target)) return true
    if (!existsSync(target)) {
      dropped.add(name)
      log(`profile dependency ${name} pointed at ${target}, which this repo no longer deploys — dropped`)
      return false
    }
    const declared = declaredPackageName(target)
    if (declared === undefined || declared === name) return true
    dropped.add(name)
    log(`profile dependency ${name} points at ${target}, whose package is now ${declared} — dropped`)
    return false
  })
  const kept = Object.fromEntries(keptEntries)
  const { bundles, added, removed } = mergeBundles(existing.dsh?.profile?.bundles, REQUIRED_BUNDLES, dropped)
  const manifest = {
    name: typeof existing.name === 'string' && existing.name !== '' ? existing.name : `dsh-profile-${opts.profile}`,
    private: true,
    dependencies: { ...kept, ...deps },
    dsh: {
      ...(existing.dsh ?? {}),
      profile: { ...(existing.dsh?.profile ?? {}), bundles },
    },
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  // The append is deliberate and visible: an absent required bundle may be the
  // user's own deactivation, and silently re-enabling it is the mirror image of
  // the defect this merge removes on the other side.
  for (const name of added) log(`profile bundle ${name} was missing from dsh.profile.bundles — appended`)
  // A stale name goes with the dependency that made it loadable: keeping it in
  // the layer list is what shows a second card for the same bundle patch.
  for (const name of removed) log(`profile bundle ${name} belonged to a dependency this repo no longer deploys by that name — dropped`)
  // The workspace file carries the platform's build approvals
  // (`packages/boot/plugin-manager`'s build-approval writes it), so our
  // scaffold is only ever the FIRST version of it.
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_WORKSPACE_TEMPLATE)
  // The patch layer is the platform's settings document: keep it as it is, and
  // fail closed rather than replace a document we cannot read.
  const userLayerPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(userLayerPath)) {
    writeFileSync(userLayerPath, userLayerTemplate())
  } else if (!Array.isArray(readUserLayer(userLayerPath))) {
    fail('the profile patch layer is not a readable YAML array — refusing to overwrite it,'
      + ` move it aside by hand if it really is meant to be reset: ${userLayerPath}`)
  }
}

/** Whether a command name resolves on PATH. */
function hasOnPath(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' })
  return result.status === 0
}

/**
 * Resolve the dsh launch argv AND report what that resolution actually
 * verified (T2): `--launch` goes through the registry/PATH execution line, not
 * the platform checkout, so the wrapper's checkout preflight does not cover it —
 * say so instead of implying a check that did not happen. The resolution itself
 * lives in the shared helper so it is testable (`resolveLaunchSource`).
 *
 * The shape is the wrapper's (D2): `runtimeSource` and `workspaceCwd` are two
 * fields, so "where the code comes from" and "which world it boots" cannot be
 * confused for one cwd again.
 * @returns {{ runtimeSource: { cmd: string, args: string[], source: string, verified: boolean, note: string }, workspaceCwd: string }} the launch plan and its provenance.
 */
function launchPlan() {
  return {
    runtimeSource: resolveLaunchSource({
      ...(opts.dshBin === undefined ? {} : { dshBin: opts.dshBin }),
      env: process.env,
      onPath: hasOnPath,
      profileArgs: ['--profile', opts.profile, ...opts.extra],
    }),
    workspaceCwd: resolveWorkspace({ profile: opts.profile }),
  }
}

function main() {
  checkNode()
  // The world's home, resolved once and printed on every run — this is the
  // path the booted child runs in, and the same one the checkout wrapper
  // resolves (D1/D2). `--launch` adopts a legacy world into it before booting.
  const plan = launchPlan()
  log(`workspace: ${plan.workspaceCwd} (the world lives in ${worldDirOf(plan.workspaceCwd)})`)
  if (opts.dryRun) {
    const packages = deploymentPackages(ROOT)
    const realDir = profileDir()
    const scratch = join(ROOT, 'tmp', 'dryrun-profile')
    rmSync(scratch, { recursive: true, force: true })
    process.stdout.write(`# dry-run: profile dir would be ${realDir}\n`
      + `# (files written to scratch ${scratch} for inspection)\n`
      + `# file: deps (${packages.size}):\n`
      + [...packages.keys()].sort().map(name => `#   ${name} -> ${join(packages.get(name), '')}`).join('\n') + '\n\n')
    writeProfile(scratch, packages)
    process.stdout.write(`# --- package.json ---\n${readFileSync(join(scratch, 'package.json'), 'utf8')}\n`
      + `# --- pnpm-workspace.yaml ---\n${readFileSync(join(scratch, 'pnpm-workspace.yaml'), 'utf8')}\n`
      + `# --- cordis.patch.yml ---\n${readFileSync(join(scratch, 'cordis.patch.yml'), 'utf8')}\n`)
    process.exit(0)
  }

  const pnpm = resolvePnpm()
  const runPnpm = (args, cwd) => run(pnpm.cmd, [...pnpm.prefix, ...args], cwd)
  // Both installs run against the WORKSPACE-LOCAL store (scripts/pnpm-store.mjs):
  // the home store is outside what a confined session may write, so a bare
  // `pnpm install` here cost a sandbox escalation on every setup run.
  const install = (cwd, extra = []) => runPnpm(pnpmInstallArgs(ROOT, extra), cwd)

  if (opts.install && !existsSync(join(ROOT, 'node_modules', '.bin', 'tsc'))) {
    log('installing workspace deps (pnpm install, workspace-local store)…')
    const status = install(ROOT)
    if (status !== 0) fail(`pnpm install failed (exit ${status})`)
  }

  if (opts.build && !existsSync(join(ROOT, 'packages', 'bundle', 'app-harness', 'lib', 'index.js'))) {
    log('building the workspace (pnpm run build)…')
    const status = runPnpm(['run', 'build'], ROOT)
    if (status !== 0) fail(`pnpm run build failed (exit ${status})`)
  }

  const dir = profileDir()
  // NOT `rmSync(dir)`: that directory holds the platform's own state — the
  // settings document, the plugins the plugin manager installed, the build
  // approvals — and since 0.1.7 that state lives HERE rather than beside the
  // profile. `writeProfile` refreshes our half and leaves theirs alone.
  log(`refreshing dsh profile ${dir} (settings, installed plugins and build approvals are kept)…`)
  writeProfile(dir, deploymentPackages(ROOT))
  log('installing profile plugins (file: links, workspace-local store)…')
  // The profile manifest is generated by this script; its lockfile is a cache,
  // not a reviewed input. Refresh it instead of inheriting CI's frozen default.
  const status = install(dir, ['--config.frozen-lockfile=false'])
  if (status !== 0) fail(`profile pnpm install failed (exit ${status})`)

  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    warn('DEEPSEEK_API_KEY is not set — the inbox/usage apps and the web chat need it; export it or add a .env')
  }

  if (opts.launch) {
    warn('--launch is deprecated; use `pnpm start` for the checkout launch line')
    // T2: report what the resolution verified (or did not) before booting. The
    // checkout lane's artifact preflight lives in scripts/launch-apps.mjs; this
    // path (DSH_BIN → PATH → npx) has no checkout to preflight.
    log(`launch source: ${plan.runtimeSource.source} — ${plan.runtimeSource.note}`)
    if (!plan.runtimeSource.verified) warn(`${plan.runtimeSource.source} could not be verified locally: the checkout-lane preflight (scripts/launch-apps.mjs) does not cover this execution source`)
    // The world's fail-closed adoption (D4), the same module the wrapper uses:
    // the legacy candidates are this repo ($DSH_CHECKOUT's checkout) and the
    // checkout, and nothing boots until the adoption is complete.
    let world
    try {
      world = prepareWorkspace({ workspace: plan.workspaceCwd, repoRoot: ROOT, checkout: defaultCheckout(process.env) })
    } catch (error) {
      fail(String(error.message ?? error))
    }
    log(world.note)
    log(`launching: (cd ${plan.workspaceCwd}) ${[plan.runtimeSource.cmd, ...plan.runtimeSource.args].join(' ')}`)
    const exit = run(plan.runtimeSource.cmd, plan.runtimeSource.args, plan.workspaceCwd)
    process.exit(exit === 0 ? 0 : exit)
  }
  log(`\nprofile ${opts.profile} is ready. The daily checkout launch goes through the wrapper (T2: client-artifact preflight first):`)
  log(`\n  node scripts/launch-apps.mjs --checkout ~/deepseek-harness\n`)
  log(`Direct boot (no preflight) — this exact source, ${plan.runtimeSource.source}: ${plan.runtimeSource.note}`)
  log(`Run it IN the workspace above: ${[plan.runtimeSource.cmd, ...plan.runtimeSource.args].join(' ')}\n`)
}

main()
