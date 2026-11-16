#!/usr/bin/env node
/**
 * The daily **checkout launch** wrapper (T2): resolve this run's execution
 * source → resolve the workspace its world belongs to → check the client
 * artifacts it will load → then boot dsh from the checkout, IN the workspace.
 *
 * Why a wrapper: the daily launch is `(cd <platform checkout> && pnpm dsh
 * --profile application-harness)`, which executes the CHECKOUT's platform packages, not
 * this repo's pinned registry line. After a platform update, a stale or missing
 * build output (most visibly a client bundle) used to surface only as a blank
 * page inside the running app (2026-09-10 startup incident). The order below is
 * fixed: nothing launches when the preflight fails.
 *
 * Runtime source and workspace are two different things (AR2n④, D2): the child
 * keeps the CHECKOUT as its code source while its cwd is the **workspace**
 * (`$DSH_WORKSPACE`, else `~/dsh-workspaces/<profile>`, see
 * scripts/workspace.mjs), the one directory the workspace data
 * (`${cwd}/.dsh-applications/…`, the applications' own documents) lives in.
 * Handing the child the checkout as its cwd put that data where a re-clone or
 * `git clean -xdf` destroys it, and made this wrapper and `setup.mjs --launch`
 * boot two different worlds from one profile.
 *
 * The code source is the checkout's **CLI entry**, resolved by
 * `scripts/platform-checkout.mjs` and handed to `node` — not a `pnpm dsh`
 * invocation. A package-manager lookup finds its project root by walking up
 * from the child's cwd, and the child's cwd is the workspace, which has no
 * `package.json`: `pnpm dsh` therefore ran in the nearest ancestor manifest
 * (moving that install's own packages aside) or died with
 * ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND — never in the checkout (2026-09-23).
 *
 * The world is adopted before the child exists, and never by guessing: one
 * legacy world is moved in (source and target printed), two worlds with data
 * refuse to launch, nothing anywhere is announced as a NEW WORLD. A world that
 * would be refused is reported by the CHECK lane as `UNVERIFIED` — reason and
 * by-hand fix included, nothing written, exit 0 — because a data layout is not
 * a defect of the repository this gate is about; only a real launch refuses.
 *
 * What the preflight does NOT do: pull, build, or repair anything — not this
 * workspace, not the checkout, not the profile. It resolves the entry points
 * this deployment loads (the deployment descriptor + each package's `exports`),
 * rejects a workspace inside the checkout or this repo (a world there is not
 * protected by `.gitignore`), and reports the exact file and the build command
 * that produces it. "The file exists" is not "it is fresh and it runs":
 * freshness stays the build's job and runnability the browser e2e's.
 *
 * The direct commands stay available and stay un-prechecked (see the note setup
 * prints); this wrapper is the pre-checked lane.
 *
 * `--check-only` is also the preflight chain's ONLY executor in the quality
 * gate: `release:check` runs it, so the chain below is not a wrapper nobody
 * calls (AR2″a, `preflight-never-gated`). Where no platform checkout exists —
 * CI, which deliberately does not fetch one (PL8) — it degrades the way
 * `verify-platform-package-set.mjs` and `vendor-platform-src --check` do: one
 * explicit `UNVERIFIED` line, exit 0, and the line SAYS the chain did not run
 * rather than implying it passed. A real launch is never degraded this way.
 *
 * Usage:
 *   node scripts/launch-apps.mjs [--checkout <path>] [--profile <name>] [--check-only] [-- <dsh args>]
 *     --checkout <path>   the platform checkout to launch from (default: $DSH_CHECKOUT or ~/deepseek-harness)
 *     --profile <name>    the dsh profile (default: application-harness)
 *     --check-only        run the preflight and exit (0 = ready or UNVERIFIED, 1 = problems)
 *     --dry-run           print the launch plan without executing it
 *     -- <dsh args>       extra args forwarded verbatim to dsh (e.g. --no-open), except that a
 *                         relative `--patch` overlay is made absolute against the invocation cwd
 *                         first — the child's cwd is the workspace, not the one you stand in
 *   Environment:
 *     DSH_WORKSPACE       the workspace the world belongs to (default: ~/dsh-workspaces/<profile>;
 *                         a relative value resolves against the invocation cwd)
 *     DSH_WORKSPACE_LEGACY  `path.delimiter`-separated directories a legacy `.dsh-applications/` may live in
 *                         (default: this repo + the platform checkout; empty = no legacy world)
 * @module
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  checkDeploymentEntries, deploymentDirOf, deploymentPackages, DEPLOYMENT_DESCRIPTOR,
  missingBuildArtifacts, missingCompositionArtifacts, PROFILE_DEFAULT, resolveProfileDir,
} from './deployment-packages.mjs'
import { resolveDshBin, unbuiltCheckoutMessage } from './platform-checkout.mjs'
import { prepareWorkspace, resolveWorkspace, WORKSPACES_DIRNAME, worldDirOf, workspaceProblems } from './workspace.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The default platform checkout (the daily-launch execution line). */
export function defaultCheckout(env = process.env, home = homedir()) {
  return env.DSH_CHECKOUT !== undefined && env.DSH_CHECKOUT !== '' ? env.DSH_CHECKOUT : join(home, 'deepseek-harness')
}

/**
 * Resolve the launch plan (D2): the runtime's execution source and the
 * workspace the child runs IN, as two fields — one `cwd` used to mean both, and
 * that is how the world ended up inside the checkout. The runtime source stays
 * the platform checkout's CLI entry; the child's cwd is the workspace.
 * @param {{ checkout: string, profile: string, extra?: string[], workspace?: string, env?: Record<string, string | undefined>, home?: string, cli?: { bin: string, source: string } }} options - the resolved checkout, profile, forwarded args, an explicit workspace (else `$DSH_WORKSPACE` → `~/dsh-workspaces/<profile>`), and an optional pre-resolved CLI (the preflight and the spawn share one resolution; tests inject it).
 * @returns {{ runtimeSource: { checkout: string, cmd: string, args: string[], source: string, note: string }, workspaceCwd: string }} the plan.
 */
export function launchPlan({ checkout, profile, extra = [], workspace, env = process.env, home = homedir(), cli }) {
  // The CLI is a resolved ENTRY, not a package manager lookup. `pnpm dsh` used
  // to be the line here, and it cannot be: its project root is found by walking
  // UP from the child's cwd (the workspace, which has no `package.json`), so it
  // either ran in whatever ancestor manifest it found ($HOME's, moving that
  // install's packages aside) or died with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND —
  // never in the checkout it was supposed to execute (2026-09-23, after AR2n④
  // moved the child's cwd off the checkout). `resolveDshBin` is this repo's one
  // answer to "which dsh binary", and it takes the checkout explicitly.
  const resolved = cli ?? resolveDshBin({ repoRoot: ROOT, checkout, env, exists: existsSync })
  return {
    runtimeSource: {
      checkout,
      cmd: process.execPath,
      args: [resolved.bin, '--profile', profile, ...extra],
      source: resolved.source,
      // The note names what would RUN, not what was asked for: a checkout
      // without a built CLI resolves to the registry-line binary, and saying
      // "the CLI runs from <checkout>" there would be the same kind of
      // near-truth the `pnpm dsh` line told (the preflight refuses either way).
      note: resolved.source === 'checkout'
        ? `platform checkout at ${checkout} — the CLI runs from ${resolved.bin} (execution line = checkout; the repo pin constrains types/CI only)`
        : `platform checkout at ${checkout} has no built CLI (${resolved.source}) — the registry-line dsh at ${resolved.bin} is what would run; a real launch refuses`,
    },
    workspaceCwd: workspace ?? resolveWorkspace({ profile, env, home }),
  }
}

/**
 * Whether a platform checkout exists at this path — the preflight's execution
 * source, and the condition its degraded form is keyed on. A directory that is
 * not a checkout (no `package.json`) counts as absent: the preflight would only
 * report it, and `--check-only` must answer the same way for both.
 * @param checkout - the resolved checkout path.
 * @param exists - the existence probe (injectable for the tests).
 * @returns the verdict.
 */
export function checkoutPresent(checkout, exists = existsSync) {
  return exists(join(checkout, 'package.json'))
}

/**
 * The preflight: everything that must hold before the checkout lane boots.
 * @param {{ root?: string, checkout: string, profile?: string, env?: Record<string, string | undefined>, profileDir?: string, deploymentDir?: string, workspace?: string, home?: string }} options - the repo root, the checkout, the profile, and optional explicit directories (the tests point both halves at one fixture).
 * @returns {Array<{ name: string, file?: string, hint: string }>} one entry per problem (empty = ready).
 */
export function preflight({ root = ROOT, checkout, profile = PROFILE_DEFAULT, env = process.env, profileDir, deploymentDir, extraPatches = [], workspace, home = homedir() }) {
  const problems = []
  // The workspace: the world must not live inside the checkout or this repo
  // (AR2n④, D3). The judgement is on canonical paths, never string prefixes —
  // a trailing slash or a symlink is still the same directory. The caller
  // prints both resolved absolute paths; this is the fail-closed half.
  const workspaceCwd = workspace ?? resolveWorkspace({ profile, env, home })
  for (const problem of workspaceProblems({ workspace: workspaceCwd, repoRoot: root, checkout })) problems.push(problem)
  if (!existsSync(join(checkout, 'package.json'))) {
    problems.push({
      name: `platform checkout ${checkout}`,
      hint: 'not a checkout (no package.json) — pass --checkout <path> or set DSH_CHECKOUT; the registry lane is `dsh --profile application-harness`',
    })
    return problems
  }
  // The checkout lane runs the platform from ITS workspace: without an install
  // there is nothing for the CLI's own module graph to resolve.
  if (!existsSync(join(checkout, 'node_modules'))) {
    problems.push({
      name: `platform checkout ${checkout}/node_modules`,
      hint: 'the checkout is not installed — run (checkout): pnpm install',
    })
  }
  // The executable this launch will run, resolved the same way the spawn
  // resolves it (one resolution, both consumers). Three verdicts, and only one
  // of them may launch: a checkout whose CLI is not built is a problem with a
  // build remedy, and a checkout with no CLI package at all is not the shape
  // this lane launches (`resolveDshBin` falls back to the registry line there,
  // which is a DIFFERENT execution line than the one this wrapper promises).
  const cli = resolveDshBin({ repoRoot: root, checkout, exists: existsSync })
  if (cli.source === 'unbuilt-checkout') {
    problems.push({ name: `platform CLI ${cli.bin}`, file: cli.bin, hint: unbuiltCheckoutMessage(cli) })
  } else if (cli.source === 'npm') {
    problems.push({
      name: `platform CLI ${join(checkout, 'apps', 'cli')}`,
      file: join(checkout, 'apps', 'cli'),
      hint: 'the checkout declares no platform CLI — this lane launches the checkout\'s own `apps/cli` and never the registry line; pass a real checkout or set DSH_CHECKOUT',
    })
  }
  // The entries the composition will ACTUALLY load, resolved from the profile's
  // bundle list → each bundle's patch rows → each package's own exports. Both
  // sides are covered (the checkout's platform packages AND this repo's), and
  // only mounted rows are demanded: a package that merely exists in the checkout
  // is not a deployment requirement (T2).
  const resolvedProfileDir = profileDir ?? resolveProfileDir({ profile, env })
  // The launcher's own `--patch` overlays ride the forwarded dsh arguments; the
  // preflight composes them onto the shipped layers, so a row only an overlay
  // mounts is required too (PL7 ①).
  const composition = missingCompositionArtifacts({ checkout, profileDir: resolvedProfileDir, extraPatches })
  for (const entry of composition.missing) {
    problems.push({
      name: entry.name,
      file: entry.file,
      hint: `${entry.hint} [${entry.where}]`,
    })
  }
  // PL4 (+ AR2 ②): a composition row that RESOLVES but whose artifact predates
  // its sources serves the previous bytes — the exact shape of "a pull edited an
  // existing package without adding a row". Since AR2 ② this covers every
  // mounted row, host entries as much as client bundles.
  for (const entry of composition.stale) {
    problems.push({
      name: entry.name,
      file: entry.file,
      hint: `${entry.hint} [${entry.where}]`,
    })
  }
  const descriptorPath = join(root, DEPLOYMENT_DESCRIPTOR)
  let descriptor
  try {
    descriptor = parseYaml(readFileSync(descriptorPath, 'utf8'))
  } catch (error) {
    problems.push({ name: 'deployment descriptor', file: descriptorPath, hint: `unreadable: ${String(error)}` })
    return problems
  }
  const deployment = deploymentPackages(root)
  for (const missing of missingBuildArtifacts({ descriptor, deployment })) {
    problems.push({ name: missing.name, file: missing.file, hint: missing.hint })
  }
  // The profile this launch will use: the link entries must point back here.
  const dir = deploymentDir ?? deploymentDirOf(resolvedProfileDir)
  if (deploymentDir === undefined && !existsSync(join(dir, '..', 'package.json'))) {
    problems.push({
      name: `profile ${profile}`,
      file: dir,
      hint: 'profile not found — bootstrap it: node scripts/setup.mjs',
    })
    return problems
  }
  for (const problem of checkDeploymentEntries({ packages: deployment, deploymentDir: dir, realpathSync })) {
    problems.push({ name: problem.split(':')[0], hint: problem })
  }
  return problems
}

/**
 * The `--patch` overlay files among the arguments forwarded to dsh (both
 * `--patch FILE` and `--patch=FILE`), in order. This is the launcher's own
 * argument surface — no second patch parser is introduced for it.
 * @param {string[]} args - the forwarded arguments.
 * @returns {string[]} the overlay paths, as given.
 */
export function patchArgsOf(args) {
  const files = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--patch') {
      const next = args[index + 1]
      if (next !== undefined) files.push(next)
    } else if (arg.startsWith('--patch=')) {
      files.push(arg.slice('--patch='.length))
    }
  }
  return files
}

/**
 * Make the `--patch` overlay paths among the forwarded arguments absolute
 * against ONE base: the invocation cwd.
 *
 * The child's cwd is the WORKSPACE (D2), so a relative overlay handed over
 * verbatim would resolve THERE at boot — the launcher's own preflight resolves
 * it here, against the cwd you invoked from, and dsh fails the boot outright
 * when the file it opens is not the one the preflight judged (the child's
 * `resolve(file)` follows its cwd). This step is what makes the preflight's
 * verdict and the child's boot read one path: the string judged is the string
 * handed over. The launcher's other overlay-bearing entries resolve up front
 * against the repo the same way.
 *
 * Only the `--patch` VALUE is touched; every other forwarded argument stays
 * verbatim. An empty value is left alone — that is not a relative path but a
 * malformed one, and dsh's own parser names it better than this rewrite could.
 * @param {string[]} args - the forwarded arguments.
 * @param {string} [cwd] - the base every relative overlay resolves against (default: the invocation cwd).
 * @returns {string[]} the arguments, with each `--patch` value absolute.
 */
export function resolvePatchArgs(args, cwd = process.cwd()) {
  const out = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--patch') {
      const value = args[index + 1]
      if (value === undefined || value === '') { out.push(arg); continue }
      out.push(arg, resolve(cwd, value))
      index += 1
    } else if (arg.startsWith('--patch=') && arg !== '--patch=') {
      out.push(`--patch=${resolve(cwd, arg.slice('--patch='.length))}`)
    } else {
      out.push(arg)
    }
  }
  return out
}

/** Parse the CLI arguments (exported for the script tests). */
export function parseArgs(argv, env = process.env, home = homedir()) {
  const opts = { checkout: defaultCheckout(env, home), profile: PROFILE_DEFAULT, checkOnly: false, dryRun: false, extra: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--checkout') opts.checkout = argv[++index]
    else if (arg === '--profile') opts.profile = argv[++index]
    else if (arg === '--check-only') opts.checkOnly = true
    else if (arg === '--dry-run') opts.dryRun = true
    // Everything after `--` is dsh's; stop parsing so nothing is forwarded twice.
    else if (arg === '--') { opts.extra.push(...argv.slice(index + 1)); break }
    else if (arg === '-h' || arg === '--help') opts.help = true
    else opts.extra.push(arg)
  }
  return opts
}

function usage() {
  process.stdout.write(`usage: node scripts/launch-apps.mjs [options] [-- <dsh args>]\n\n`
    + `  --checkout <path>   platform checkout to launch from (default: $DSH_CHECKOUT or ~/deepseek-harness)\n`
    + `  --profile <name>    dsh profile (default: ${PROFILE_DEFAULT})\n`
    + `  --check-only        run the preflight and exit (0 = ready or UNVERIFIED, 1 = problems)\n`
    + `  --dry-run           print the launch plan without executing it\n`
    + `\nThe runtime comes from the checkout; the workspace data (the applications' own\ndocuments) lives in the workspace, which the child process runs in:\n`
    + `  DSH_WORKSPACE       the workspace directory\n`
    + `                      (default: ~/${WORKSPACES_DIRNAME}/<profile>; a relative value resolves against the invocation cwd)\n`
    + `  DSH_WORKSPACE_LEGACY  PATH-style separated ('${delimiter}') directories a legacy .dsh-applications/ may live in\n`
    + `                      (default: this repo + the platform checkout; empty = no legacy world)\n`
    + `The workspace is refused when it sits inside the checkout or this repo. A legacy world is\n`
    + `adopted only when it is the ONLY one: two worlds with data refuse to launch (never merged,\n`
    + `never picked between). --check-only never writes and never adopts: it reports such a world\n`
    + `as UNVERIFIED (reason + the by-hand fix, exit 0) instead of failing this repository's gate.\n`)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help === true) { usage(); return }
  // ONE resolution feeds both consumers below (F-1): `patchArgsOf(extra)` is
  // what the preflight judges and `plan.runtimeSource.args` is what the child is
  // given. Once they are the same strings, the preflight's "the overlay exists"
  // is a statement about the file the boot will actually open.
  const extra = resolvePatchArgs(opts.extra)
  const plan = launchPlan({ checkout: opts.checkout, profile: opts.profile, extra })
  // Both resolved absolute paths, on every run — the preflight's own report
  // (D3): where the runtime comes from, and which workspace owns the world.
  // The platform state directory is resolved by the same `dshHomePath`
  // convention the host uses (the child inherits this environment), so the
  // grants/onboarding/history records are visible without opening the profile.
  process.stdout.write(`[launch-apps] runtime source: ${plan.runtimeSource.note}\n`
    + `[launch-apps] workspace: ${plan.workspaceCwd} (the world lives in ${worldDirOf(plan.workspaceCwd)})\n`
    + `[launch-apps] platform state: ${dshHomePath('application-harness')}\n`)
  // The world's own state — the ONE call, in the mode the lane calls for. The
  // inspection path (check lane / `--dry-run`) never writes; the launch path
  // performs the adoption before the child exists, so there is never a boot
  // beside half a workspace. A failed path check or a failed move exits 1.
  const preparing = opts.checkOnly !== true && opts.dryRun !== true
  const worldOf = (dryRun) => {
    try {
      return prepareWorkspace({ workspace: plan.workspaceCwd, repoRoot: ROOT, checkout: opts.checkout, dryRun })
    } catch (error) {
      process.stderr.write(`[launch-apps] ${String(error.message ?? error)}\n`)
      process.exit(1)
    }
  }
  // The world is NOT the checkout's business: the check lane inspects it BEFORE
  // the degraded branch below, so a machine without a checkout still hears that
  // a real launch would be refused. The verdict is reported at the END (the
  // preflight chain below still runs — it is the quality gate's only executor,
  // AR2″a `preflight-never-gated`). A refusal is not reported as a failure —
  // this machine's data layout is not a defect of the repository under test —
  // but it is NOT a pass either: UNVERIFIED, with the reason and the by-hand
  // fix, and nothing written. The launch itself refuses (scripts/workspace.mjs).
  let world
  if (!preparing) world = worldOf(true)
  // The check lane's verdict on the world: NOT a pass (the reason and the
  // by-hand fix are both here) and NOT a failure (this machine's data layout is
  // not a defect of the repository the gate is about).
  const reportWorldRefusal = (refusal) => {
    process.stdout.write('[launch-apps] UNVERIFIED — nothing was launched and nothing was moved; a REAL launch (or `pnpm run start`) would be REFUSED:\n'
      + `${refusal}\n`)
  }
  /**
   * Report the world's verdict for the lane that does not launch: the refusal
   * (above) or what a launch would do to this workspace. Every sentence here is
   * about what a REAL launch would do — the lane must not promise a world the
   * launch could not create (see `worldShapeProblem`).
   * @returns {boolean} true when the world is refused (nothing more may be promised).
   */
  const reportWorld = () => {
    if (world.refusal !== undefined) {
      reportWorldRefusal(world.refusal)
      return true
    }
    process.stdout.write(`[launch-apps] ${world.note}\n`)
    return false
  }
  // The degraded form (AR2″a, `preflight-never-gated`): with no checkout there
  // is nothing to resolve the composition against, so `--check-only` says so and
  // exits 0 instead of failing — the same convention as the two gates that need
  // a checkout (PL8: CI does not fetch one). It is deliberately NOT a pass: the
  // line names the chain and states that it did not run. Only the CHECK lane
  // degrades; a real launch still refuses to boot from a missing checkout. The
  // world's verdict is checkout-INDEPENDENT, so it is reported here too (only
  // the CHECK lane reaches this branch, where `world` is the read-only one).
  if (opts.checkOnly && !checkoutPresent(opts.checkout)) {
    reportWorld()
    process.stdout.write(`[launch-apps] UNVERIFIED — no platform checkout at ${opts.checkout}; the preflight chain (composition artifacts, build artifacts, profile links) was NOT executed here. Run it where a checkout exists: node scripts/launch-apps.mjs --check-only\n`)
    return
  }
  const problems = preflight({
    checkout: opts.checkout, profile: opts.profile, workspace: plan.workspaceCwd, extraPatches: patchArgsOf(extra),
  })
  if (problems.length > 0) {
    process.stderr.write(`[launch-apps] ${problems.length} preflight problem(s) — not launching:\n`)
    for (const problem of problems) {
      process.stderr.write(`  - ${problem.name}${problem.file === undefined ? '' : ` (${problem.file})`}\n`)
      process.stderr.write(`      ${problem.hint}\n`)
    }
    process.exit(1)
  }
  process.stdout.write('[launch-apps] preflight OK: this deployment\'s entry points are present and no mounted row is older than its sources (runnability stays the build\'s, the smoke\'s and the browser e2e\'s).\n'
    + '[launch-apps] scope: this proves the artifacts exist, are not stale, and Node can resolve the rows\' modules — it does NOT prove the startup profile resolution accepts them (a row can still fail to activate at boot).\n')
  if (!preparing) {
    // The world's verdict comes LAST, so the preflight chain above still ran
    // (it is the quality gate's only executor) before the lane answers.
    if (reportWorld()) return
    if (opts.checkOnly) return
    process.stdout.write(`[launch-apps] would run: (cd ${plan.workspaceCwd}) ${[plan.runtimeSource.cmd, ...plan.runtimeSource.args].join(' ')}\n`)
    return
  }
  // A real launch: the adoption happens HERE — after the preflight (nothing is
  // moved on a machine that cannot launch) and before the child exists (never a
  // boot beside half a workspace). A refusal or a failed move throws → exit 1.
  world = worldOf(false)
  process.stdout.write(`[launch-apps] ${world.note}\n`)
  process.stdout.write(`[launch-apps] launching: (cd ${plan.workspaceCwd}) ${[plan.runtimeSource.cmd, ...plan.runtimeSource.args].join(' ')}\n`)
  const child = spawn(plan.runtimeSource.cmd, plan.runtimeSource.args, { cwd: plan.workspaceCwd, stdio: 'inherit' })
  // Forward termination signals to the child and mirror its exit code, so the
  // wrapper is transparent to scripts and to Ctrl-C.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { child.kill(signal) })
  }
  child.on('exit', (code, signal) => {
    if (signal === null) {
      process.exitCode = code ?? 1
      return
    }
    // The child died from a signal: mirror it. Our own forwarder is removed
    // first — otherwise the re-raised signal would be caught by the listener we
    // installed above and the wrapper would linger after its child is gone.
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  })
  child.on('error', (error) => {
    process.stderr.write(`[launch-apps] failed to launch: ${String(error)}\n`)
    process.exit(1)
  })
}

// Importable for the script tests without executing the launcher.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
