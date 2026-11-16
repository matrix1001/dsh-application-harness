/**
 * Script-plane tests for the T1/T2 deployment helpers (`node --test`, NOT
 * vitest — the vitest suite collects `packages/*​/*​/tests/**` only, so a test
 * placed under `scripts/` must be wired into an explicit runner; see the
 * `test:scripts` script and its use in `release:check` / CI).
 *
 * Everything runs against temp fixtures with injectable roots: the production
 * `dev-apps.mjs` / `launch-apps.mjs` entry points are never invoked (they would
 * rebuild the workspace first, which is exactly what these tests must not need).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkDeploymentEntries, deploymentDirOf, deploymentPackages, isDeploymentPackageName,
  missingBuildArtifacts, resolveDshHome, resolveProfileDir, splitSpecifier, workspaceManifests,
} from '../deployment-packages.mjs'
import { defaultCheckout, launchPlan, parseArgs, preflight } from '../launch-apps.mjs'

/** Run `body` with a fresh temp dir, removed afterwards. */
function withFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scripts-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A minimal checkout-local bundle whose patch mounts one row (the composition half's input). */
function writeFixtureBundle(checkout) {
  // The checkout's CLI: the entry the daily launch runs, resolved by
  // `scripts/platform-checkout.mjs` from `apps/cli` (the platform's own layout,
  // unchanged across the 0.1.6 → 0.1.7 line). A checkout without it is not this
  // lane's shape, so a "clean preflight" fixture has to carry one.
  writeManifest(checkout, 'apps/cli', { name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } })
  mkdirSync(join(checkout, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(checkout, 'apps', 'cli', 'lib', 'bin.js'), '')
  const dir = join(checkout, 'packages', 'bundle', 'platform')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-fixture-platform', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: fixture-host',
    "      name: '@matrix1001/dsh-application-harness-runtime'",
    '',
  ].join('\n'))
}

/** Write one package manifest at `<root>/<rel>/package.json`. */
function writeManifest(root, rel, manifest) {
  mkdirSync(join(root, rel), { recursive: true })
  writeFileSync(join(root, rel, 'package.json'), JSON.stringify(manifest, undefined, 2))
}

/** A fixture workspace: an app package (built), an unbuilt app package, a typert build shell, and the bundle. */
function fixtureWorkspace(root) {
  writeManifest(root, 'packages/application/runtime', {
    name: '@matrix1001/dsh-application-harness-runtime',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './types': { default: './lib/types.js' } },
  })
  mkdirSync(join(root, 'packages/application/runtime/lib'), { recursive: true })
  writeFileSync(join(root, 'packages/application/runtime/lib/index.js'), '')
  writeFileSync(join(root, 'packages/application/runtime/lib/types.js'), '')
  writeManifest(root, 'packages/examples/unbuilt', {
    name: '@matrix1001/dsh-application-harness-unbuilt',
    exports: { '.': { default: './lib/index.js' } },
  })
  // The build-only shell: private, has build output, lives outside the package
  // areas, and is NOT deployed.
  writeManifest(root, 'packages/typert/protocol', { name: '@deepseek-ai/dsh-typert-protocol', exports: { '.': { default: './lib/index.js' } } })
  mkdirSync(join(root, 'packages/typert/protocol/lib'), { recursive: true })
  writeFileSync(join(root, 'packages/typert/protocol/lib/index.js'), '')
  writeManifest(root, 'packages/bundle/app-harness', { name: '@matrix1001/dsh-application-harness', exports: { '.': { default: './lib/index.js' } } })
  mkdirSync(join(root, 'packages/bundle/app-harness/lib'), { recursive: true })
  writeFileSync(join(root, 'packages/bundle/app-harness/lib/index.js'), '')
  // A client plugin package: the ./client export is the built bundle.
  writeManifest(root, 'packages/client/applications', {
    name: '@matrix1001/dsh-application-harness-client-applications',
    exports: { '.': { default: './lib/index.js' }, './client': { default: './lib/client.js' } },
  })
  mkdirSync(join(root, 'packages/client/applications/lib'), { recursive: true })
  writeFileSync(join(root, 'packages/client/applications/lib/index.js'), '')
  writeFileSync(join(root, 'packages/client/applications/lib/client.js'), '')
}

test('the deployment set follows the package areas + the naming rule', () => withFixture((root) => {
  fixtureWorkspace(root)
  const packages = deploymentPackages(root)
  assert.deepEqual([...packages.keys()].sort(), [
    '@matrix1001/dsh-application-harness',
    '@matrix1001/dsh-application-harness-client-applications',
    '@matrix1001/dsh-application-harness-runtime',
    '@matrix1001/dsh-application-harness-unbuilt',
  ])
  // The typert build shell is private AND lives outside the areas: excluded by
  // the rule, not by "has no lib/".
  assert.equal(packages.has('@deepseek-ai/dsh-typert-protocol'), false)
  // An unbuilt package is still IN the set (skipping it would hide the problem).
  assert.equal(packages.has('@matrix1001/dsh-application-harness-unbuilt'), true)
  // The naming rule itself.
  assert.equal(isDeploymentPackageName('@matrix1001/dsh-application-harness-workbook'), true)
  assert.equal(isDeploymentPackageName('@matrix1001/dsh-application-harness'), true)
  assert.equal(isDeploymentPackageName('@deepseek-ai/dsh-typert-protocol'), false)
  // Four manifests in the deployment areas (runtime, the unbuilt app, the client
  // package, the bundle) — the vendored typert shell is not one.
  assert.equal(workspaceManifests(root).length, 4)
}))

test('the profile path resolves from DSH_HOME first, then homedir, with the profile name', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom' }, '/home/u'), '/custom')
  assert.equal(resolveDshHome({ DSH_HOME: '' }, '/home/u'), join('/home/u', '.dsh'))
  assert.equal(resolveDshHome({}, '/home/u'), join('/home/u', '.dsh'))
  assert.equal(resolveProfileDir({ env: { DSH_HOME: '/custom' }, profile: 'p' }), join('/custom', 'profiles', 'p'))
  assert.equal(resolveProfileDir({ env: {}, home: '/home/u' }), join('/home/u', '.dsh', 'profiles', 'application-harness'))
  assert.equal(deploymentDirOf('/custom/profiles/p'), join('/custom/profiles/p', 'node_modules'))
})

test('deployment entries: a missing entry, a stale copy, and an unresolvable link are all reported', () => withFixture((root) => {
  const packages = new Map([['@matrix1001/dsh-application-harness-runtime', join(root, 'pkg')]])
  mkdirSync(join(root, 'pkg'), { recursive: true })
  const deploymentDir = join(root, 'node_modules')
  mkdirSync(join(deploymentDir, '@matrix1001'), { recursive: true })

  const absent = checkDeploymentEntries({ packages, deploymentDir })
  assert.match(absent[0], /deployment entry absent/)

  // A stale copy: the entry resolves somewhere other than the package dir.
  const elsewhere = join(root, 'stale')
  mkdirSync(elsewhere, { recursive: true })
  symlinkSync(elsewhere, join(deploymentDir, '@matrix1001', 'dsh-application-harness-runtime'))
  const stale = checkDeploymentEntries({ packages, deploymentDir })
  assert.match(stale[0], /resolves elsewhere/)

  // A dangling link reads as absent (realpath reports ENOENT)…
  unlinkSync(join(deploymentDir, '@matrix1001', 'dsh-application-harness-runtime'))
  symlinkSync(join(root, 'gone'), join(deploymentDir, '@matrix1001', 'dsh-application-harness-runtime'))
  assert.match(checkDeploymentEntries({ packages, deploymentDir })[0], /absent/)
  // …while a link that cannot be resolved at all (a self-referencing loop,
  // ELOOP) is its own diagnosis, not a crash.
  unlinkSync(join(deploymentDir, '@matrix1001', 'dsh-application-harness-runtime'))
  symlinkSync('dsh-application-harness-runtime', join(deploymentDir, '@matrix1001', 'dsh-application-harness-runtime'))
  assert.match(checkDeploymentEntries({ packages, deploymentDir })[0], /unresolvable \(ELOOP\)/)

  // …and a correct link passes.
  unlinkSync(join(deploymentDir, '@matrix1001', 'dsh-application-harness-runtime'))
  symlinkSync(join(root, 'pkg'), join(deploymentDir, '@matrix1001', 'dsh-application-harness-runtime'))
  assert.deepEqual(checkDeploymentEntries({ packages, deploymentDir }), [])
}))

test('missing build artifacts resolve the descriptor entries through each package exports map', () => withFixture((root) => {
  fixtureWorkspace(root)
  const deployment = deploymentPackages(root)
  const descriptor = {
    services: [
      { id: 'app-applications', package: '@matrix1001/dsh-application-harness-runtime' },
      { id: 'app-types', package: '@matrix1001/dsh-application-harness-runtime/types' },
      { id: 'app-typert', package: '@deepseek-ai/dsh-typert-protocol' },
    ],
    applications: [{ id: 'notes', package: '@matrix1001/dsh-application-harness-unbuilt' }],
    client: { packages: ['@matrix1001/dsh-application-harness-client-applications'] },
  }
  const missing = missingBuildArtifacts({ descriptor, deployment })
  // The runtime's root + subpath entries exist; the platform row is skipped; the
  // unbuilt application is reported with its real path and a build hint.
  assert.equal(missing.length, 1)
  assert.equal(missing[0].name, '@matrix1001/dsh-application-harness-unbuilt')
  assert.equal(missing[0].file, join(root, 'packages/examples/unbuilt/lib/index.js'))
  assert.match(missing[0].hint, /pnpm run build/)
  // Drop the client bundle: the client entry is reported with ITS hint.
  rmSync(join(root, 'packages/client/applications/lib/client.js'))
  const withClient = missingBuildArtifacts({ descriptor, deployment })
  assert.equal(withClient.length, 2)
  assert.match(withClient.find(entry => entry.name.includes('client-applications')).hint, /tsdown/)
}))

test('the checkout lane plan and the launch-source resolution stay distinguishable', () => {
  // Runtime source and workspace are two fields (D2): the child runs the
  // CHECKOUT's code, in the WORKSPACE — one `cwd` for both is the defect
  // (AR2n④) this shape exists to make unrepresentable.
  // The CLI is a resolved ENTRY handed to node, never a `pnpm dsh` lookup: a
  // package manager resolves its project root by walking UP from the child's
  // cwd, which is the workspace (no `package.json`) — it ran in whatever
  // ancestor manifest it found, or died, never in the checkout (2026-09-23).
  const plan = launchPlan({
    checkout: '/co', profile: 'p', extra: ['--no-open'], workspace: '/ws',
    cli: { bin: '/co/apps/cli/lib/bin.js', source: 'checkout' },
  })
  assert.deepEqual(plan, {
    runtimeSource: {
      checkout: '/co', cmd: process.execPath, args: ['/co/apps/cli/lib/bin.js', '--profile', 'p', '--no-open'], source: 'checkout',
      note: 'platform checkout at /co — the CLI runs from /co/apps/cli/lib/bin.js (execution line = checkout; the repo pin constrains types/CI only)',
    },
    workspaceCwd: '/ws',
  })
  // A checkout with no built CLI resolves to the registry-line binary instead.
  // The note then names what would RUN rather than what was asked for, so the
  // top-of-run report cannot claim a checkout line this launch will not use.
  const fallback = launchPlan({ checkout: '/co', profile: 'p', workspace: '/ws' })
  assert.equal(fallback.runtimeSource.source, 'npm')
  assert.match(fallback.runtimeSource.note, /has no built CLI \(npm\)/)
  assert.match(fallback.runtimeSource.note, /a real launch refuses/)
  assert.match(fallback.runtimeSource.args[0], /node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/)
  // With no explicit workspace the plan resolves the shared default
  // ($DSH_WORKSPACE → ~/dsh-workspaces/<profile>).
  assert.equal(launchPlan({ checkout: '/co', profile: 'p', env: { DSH_WORKSPACE: '/given' } }).workspaceCwd, '/given')
  assert.equal(launchPlan({ checkout: '/co', profile: 'p', env: {}, home: '/home/u' }).workspaceCwd, join('/home/u', 'dsh-workspaces', 'p'))
  assert.equal(defaultCheckout({ DSH_CHECKOUT: '/x' }, '/home/u'), '/x')
  assert.equal(defaultCheckout({}, '/home/u'), join('/home/u', 'deepseek-harness'))
  const args = parseArgs(['--checkout', '/co', '--profile', 'p', '--check-only', '--dry-run', '--', '--no-open'], {}, '/home/u')
  assert.deepEqual(args, { checkout: '/co', profile: 'p', checkOnly: true, dryRun: true, extra: ['--no-open'] })
  // Positional args are forwarded to dsh, and `--help` is recognised.
  const forwarded = parseArgs(['--no-open'], { DSH_CHECKOUT: '/co' }, '/home/u')
  assert.deepEqual(forwarded.extra, ['--no-open'])
  assert.equal(forwarded.checkout, '/co')
  assert.equal(parseArgs(['--help']).help, true)
  assert.deepEqual(splitSpecifier('@matrix1001/dsh-application-harness-runtime/types'), { name: '@matrix1001/dsh-application-harness-runtime', subpath: 'types' })
  assert.deepEqual(splitSpecifier('@matrix1001/dsh-application-harness'), { name: '@matrix1001/dsh-application-harness', subpath: '' })
})

test('the preflight reports a missing checkout, an uninstalled checkout, and a missing profile', () => withFixture((root) => {
  const checkout = join(root, 'co')
  const problems = preflight({ root, checkout })
  assert.equal(problems.length, 1)
  assert.match(problems[0].hint, /not a checkout/)

  // A checkout without node_modules cannot resolve the CLI's module graph at
  // all. Every real problem is reported at once (nothing launches on any).
  mkdirSync(checkout, { recursive: true })
  writeFileSync(join(checkout, 'package.json'), '{}')
  // Keep the test independent of the developer's real profile: the composition
  // half reads an explicit fixture profile, not $DSH_HOME.
  writeManifest(root, 'profile', {
    name: 'dsh-profile-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const uninstalled = preflight({ root, checkout, profileDir: join(root, 'profile') })
  assert.ok(uninstalled.some(problem => /pnpm install/.test(problem.hint)))
  assert.ok(uninstalled.some(problem => problem.name === 'deployment descriptor'))
  // …and it declares no CLI package yet: reported, never silently downgraded
  // to the registry line this lane exists to avoid.
  assert.ok(uninstalled.some(problem => /declares no platform CLI/.test(problem.hint)), JSON.stringify(uninstalled.slice(0, 3)))
  // With the CLI declared but not built, the remedy names the build.
  writeManifest(checkout, 'apps/cli', { name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } })
  const unbuiltCli = preflight({ root, checkout, profileDir: join(root, 'profile') })
  assert.ok(unbuiltCli.some(problem => /is not built .*pnpm run build/.test(problem.hint)), JSON.stringify(unbuiltCli.slice(0, 3)))
  mkdirSync(join(checkout, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(checkout, 'apps', 'cli', 'lib', 'bin.js'), '')

  // Installed, but this workspace's deployment artifacts are missing. The
  // composition half also reports the platform bundles this fixture checkout
  // does not install — both halves are real problems, so the assertions name
  // the ones under test instead of pinning the whole list.
  mkdirSync(join(checkout, 'node_modules'), { recursive: true })
  const unbuilt = preflight({ root, checkout, deploymentDir: join(root, 'co', 'node_modules'), profileDir: join(root, 'profile') })
  assert.ok(unbuilt.some(problem => problem.name === 'deployment descriptor'))
  assert.ok(unbuilt.some(problem => /@deepseek-ai\/dsh-base/.test(problem.name)), JSON.stringify(unbuilt.slice(0, 3)))

  // A real descriptor with a satisfying fixture workspace passes end to end.
  fixtureWorkspace(root)
  mkdirSync(join(root, 'packages/bundle/app-harness'), { recursive: true })
  writeFileSync(join(root, 'packages/bundle/app-harness/deployment.yml'), [
    'services:',
    '  - id: app-applications',
    "    package: '@matrix1001/dsh-application-harness-runtime'",
    'applications:',
    '  - id: notes',
    "    package: '@matrix1001/dsh-application-harness-unbuilt'",
    'client:',
    '  packages:',
    "    - '@matrix1001/dsh-application-harness-client-applications'",
    '',
  ].join('\n'))
  const deploymentDir = join(root, 'profile', 'node_modules')
  mkdirSync(join(deploymentDir, '@matrix1001'), { recursive: true })
  for (const [name, dir] of deploymentPackages(root)) {
    symlinkSync(dir, join(deploymentDir, name))
  }
  // Unbuilt application + profile entry present: the artifact check reports it.
  const withUnbuilt = preflight({ root, checkout, deploymentDir })
  assert.ok(withUnbuilt.some(problem => problem.name === '@matrix1001/dsh-application-harness-unbuilt'))
  // Build it, and give the fixture a checkout-local bundle + a profile naming
  // it: the whole preflight is then clean (the profile links all resolve back
  // here, and the composition half finds both sides built).
  mkdirSync(join(root, 'packages/examples/unbuilt/lib'), { recursive: true })
  writeFileSync(join(root, 'packages/examples/unbuilt/lib/index.js'), '')
  writeFixtureBundle(checkout)
  writeFileSync(join(root, 'profile', 'package.json'), JSON.stringify({
    name: 'dsh-profile-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-fixture-platform'] } },
  }))
  const clean = preflight({ root, checkout, deploymentDir, profile: 'fixture', profileDir: join(root, 'profile') })
  assert.deepEqual(clean, [], JSON.stringify(clean.slice(0, 3)))
  assert.ok(existsSync(deploymentDir))
}))
