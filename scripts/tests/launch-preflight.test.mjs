/**
 * T2 script-plane tests: the launch preflight must resolve the entries the
 * composition will ACTUALLY load (both the platform checkout's and this repo's),
 * report a missing one with its package name, path and build command, and never
 * demand a package the composition does not mount.
 *
 * The fixtures are temp trees with injectable roots: the production entry points
 * are never invoked (they would rebuild the workspace first).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deploymentPackages, inlinedSourceDirs, mergedPatchRowNames, missingCompositionArtifacts, packageResolver, patchRowNames,
  parsePatchYaml, resolveLaunchSource, workspaceSourceImports,
} from '../deployment-packages.mjs'
import { launchPlan, parseArgs, patchArgsOf, preflight, resolvePatchArgs } from '../launch-apps.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Run `body` with a fresh temp dir, removed afterwards (an async body is awaited first). */
function withFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-t2-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  let result
  try {
    result = body(dir)
  } catch (error) {
    cleanup()
    throw error
  }
  if (result instanceof Promise) return result.finally(cleanup)
  cleanup()
  return result
}

/** Write `<root>/<rel>` with the given text, creating parents. */
function write(root, rel, text) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/**
 * A fixture deployment: a checkout whose bundle patch mounts a platform client,
 * a platform host row, and this repo's packages through a second bundle.
 * `built` decides which artifacts exist; `platformPatch` is the platform
 * bundle's `dsh.bundle.patch` declaration verbatim (a string or an ordered list).
 */
function fixtureDeployment(root, { platformClientBuilt = true, platformHostBuilt = true, repoClientBuilt = true, repoHostBuilt = true, platformPatch = './cordis.patch.yml' } = {}) {
  const checkout = join(root, 'checkout')
  const repo = join(root, 'repo')
  const profile = join(root, 'home', 'profiles', 'fixture')
  write(checkout, 'package.json', '{"name":"fixture-checkout","private":true}')
  mkdirSync(join(checkout, 'node_modules'), { recursive: true })
  // The platform bundle: a patch naming one client row and one host row.
  write(checkout, 'packages/bundle/platform/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-fixture-platform', dsh: { bundle: { patch: platformPatch } },
  }))
  write(checkout, 'packages/bundle/platform/cordis.patch.yml', [
    '- id: system-prompt',
    '  config:',
    '    personaSuffix: !!js process.env.CWD',
    '- insert:',
    "    - id: fixture-client",
    "      name: '@deepseek-ai/dsh-fixture-client'",
    "    - id: fixture-host",
    "      name: '@deepseek-ai/dsh-fixture-host'",
    '',
  ].join('\n'))
  write(checkout, 'packages/client/fixture-client/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-fixture-client',
    dsh: { client: { platform: 'web', inject: [] } },
    exports: { '.': { default: './lib/index.js' }, './client': { default: './lib/client.js' } },
  }))
  write(checkout, 'packages/host/fixture-host/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-fixture-host', exports: { '.': { default: './lib/index.js' } },
  }))
  if (platformClientBuilt) write(checkout, 'packages/client/fixture-client/lib/client.js', '// built\n')
  if (platformHostBuilt) write(checkout, 'packages/host/fixture-host/lib/index.js', '// built\n')
  // A client package that exists but no row mounts: it must never be demanded.
  write(checkout, 'packages/client/optional-client/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-optional-client',
    dsh: { client: { platform: 'web' } },
    exports: { './client': { default: './lib/client.js' } },
  }))
  // This repo's bundle, carrying one of its client packages and one HOST
  // package — the staleness criterion covers mounted host entries too (AR2 ②).
  write(repo, 'packages/bundle/app-harness/package.json', JSON.stringify({
    name: '@matrix1001/dsh-application-harness', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  write(repo, 'packages/bundle/app-harness/cordis.patch.yml', [
    '- insert:',
    "    - id: client-panel",
    "      name: '@matrix1001/dsh-application-harness-client-panel'",
    "    - id: repo-host",
    "      name: '@matrix1001/dsh-application-harness-fixture-host'",
    '',
  ].join('\n'))
  write(repo, 'packages/client/panel/package.json', JSON.stringify({
    name: '@matrix1001/dsh-application-harness-client-panel',
    dsh: { client: { platform: 'web' } },
    exports: { '.': { default: './lib/index.js' }, './client': { default: './lib/client.js' } },
  }))
  if (repoClientBuilt) write(repo, 'packages/client/panel/lib/client.js', '// built\n')
  write(repo, 'packages/application/fixture-host/package.json', JSON.stringify({
    name: '@matrix1001/dsh-application-harness-fixture-host',
    exports: { '.': { default: './lib/index.js' } },
  }))
  if (repoHostBuilt) write(repo, 'packages/application/fixture-host/lib/index.js', '// built\n')
  // The profile lives where the resolved DSH_HOME puts it, names both bundles,
  // and links this repo's packages exactly as a real `setup.mjs` profile does —
  // so the descriptor half of the preflight has a real deployment to check.
  write(profile, 'package.json', JSON.stringify({
    name: 'dsh-profile-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-fixture-platform', '@matrix1001/dsh-application-harness'] } },
  }))
  const deploymentDir = join(profile, 'node_modules')
  mkdirSync(join(deploymentDir, '@deepseek-ai'), { recursive: true })
  mkdirSync(join(deploymentDir, '@matrix1001'), { recursive: true })
  for (const [name, dir] of deploymentPackages(REPO)) {
    symlinkSync(dir, join(deploymentDir, name))
  }
  // The checkout's CLI, as a built checkout has it: the daily launch runs THIS
  // entry with the workspace as its cwd (`scripts/platform-checkout.mjs`),
  // because a `pnpm dsh` lookup would resolve its project root from that cwd —
  // where no manifest exists — and never reach the checkout (2026-09-23).
  write(checkout, 'apps/cli/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.0.0-fixture', bin: { dsh: 'lib/bin.js' },
  }))
  const cliBin = write(checkout, 'apps/cli/lib/bin.js', 'process.exit(0)\n')
  // The workspace is part of the fixture (D5, AR2n④): a launcher spawned with
  // this env must resolve ITS OWN workspace and its own (empty) legacy list —
  // never the developer's live world, which the launcher would otherwise adopt
  // or refuse over.
  return {
    checkout, repo, profile, deploymentDir, cliBin,
    env: { DSH_HOME: join(root, 'home'), DSH_WORKSPACE: join(root, 'workspace'), DSH_WORKSPACE_LEGACY: '' },
  }
}

test('the patch parser reads insert rows and tolerates the platform\'s !!js values', () => {
  const document = parsePatchYaml([
    '- id: system-prompt',
    '  config:',
    '    personaSuffix: !!js process.env.CWD',
    '- insert:',
    "    - id: a",
    "      name: '@deepseek-ai/dsh-a'",
    "    - id: b",
    "      name: '@deepseek-ai/dsh-b'",
    '',
  ].join('\n'))
  assert.deepEqual(patchRowNames(document), ['@deepseek-ai/dsh-a', '@deepseek-ai/dsh-b'])
  // A name-less row only overrides: it adds no package.
  assert.deepEqual(patchRowNames(parsePatchYaml('- id: x\n  config:\n    a: 1\n')), [])
  assert.deepEqual(patchRowNames('not: an array\n'), [])
  assert.deepEqual(patchRowNames([null, 7, { insert: [null, { id: 'c' }] }]), [])
})

test('a disabled row is not a mounted row', () => {
  const names = patchRowNames([
    { id: 'a', name: '@x/a' },
    { id: 'b', name: '@x/b', disabled: true },
    { id: 'c', insert: [{ id: 'd', name: '@x/d' }, { id: 'e', name: '@x/e', disabled: true }] },
  ])
  assert.deepEqual(names, ['@x/a', '@x/d'])
  // Only a LITERAL `true` disables. A platform patch's conditional disable is a
  // `!!js` EXPRESSION, which the preflight's schema reads as an opaque string
  // and never evaluates — and such a row IS mounted wherever its expression
  // holds, so it must stay in the requirement set. The live composition's
  // `!!js process.platform === 'win32'` rows (`dsh-tool-bash`,
  // `dsh-bash-sandbox`) are enabled here on Linux: a truthiness judgement
  // (`!row.disabled`) would drop them — and their artifacts — with no red light.
  const conditional = parsePatchYaml([
    '- id: tool-bash',
    "  name: '@deepseek-ai/dsh-tool-bash'",
    "  disabled: !!js process.platform === 'win32'",
    '',
  ].join('\n'))
  assert.equal(conditional[0].disabled, "!!js process.platform === 'win32'")
  assert.deepEqual(patchRowNames(conditional), ['@deepseek-ai/dsh-tool-bash'])
})

test('a fully built fixture deployment passes, and an unmounted optional package is never demanded', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  const result = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.deepEqual(result.missing, [])
  // Four mounted rows (platform client + platform host + repo client + repo
  // host); the optional, unmounted one is not among them.
  assert.equal(result.rows, 4)
  assert.equal(result.checked, 4)
  assert.equal(existsSync(join(checkout, 'packages/client/optional-client/lib/client.js')), false)
}))

test('PL12: an ORDERED patch list on a platform bundle mounts every layer, not just the first', () => withFixture((root) => {
  // The platform's own web-app bundle went from one `cordis.patch.yml` to
  // `[cordis.patch.yml, presets/{standard,ptc,minimal,cordis}.patch.yml]`
  // (0.1.7-alpha.2, platform commit 654caa4bbd "accept an ordered patch file
  // list"). A preflight that understood only the string form read that bundle
  // as "declares no dsh.bundle.patch" and refused the daily launch; one that
  // read only the FIRST file would silently under-require every preset's rows.
  const { checkout, repo, profile } = fixtureDeployment(root, {
    platformPatch: ['./cordis.patch.yml', './presets/standard.patch.yml'],
  })
  // The second layer mounts a client the first never names.
  write(checkout, 'packages/bundle/platform/presets/standard.patch.yml', [
    '- insert:',
    "    - id: preset-client",
    "      name: '@deepseek-ai/dsh-fixture-preset-client'",
    '',
  ].join('\n'))
  write(checkout, 'packages/client/preset-client/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-fixture-preset-client',
    dsh: { client: { platform: 'web' } },
    exports: { './client': { default: './lib/client.js' } },
  }))
  const unbuilt = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.deepEqual(unbuilt.missing, [{
    name: '@deepseek-ai/dsh-fixture-preset-client client bundle',
    file: join(checkout, 'packages/client/preset-client/lib/client.js'),
    where: 'checkout',
    hint: 'platform artifact missing — build it: (checkout) pnpm run build',
  }])
  // Building it settles the preflight: the layer really is part of the set.
  write(checkout, 'packages/client/preset-client/lib/client.js', '// built\n')
  const built = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.deepEqual(built.missing, [])
  assert.equal(built.rows, 5)
  assert.equal(built.checked, 5)
}))

test('PL12: a patch list names each missing file, and a malformed declaration is reported as none', () => withFixture((root) => {
  const absent = fixtureDeployment(join(root, 'absent'), { platformPatch: ['./missing.patch.yml'] })
  // A listed file that is not there is reported by its OWN path, so the fix
  // (rebuild the bundle) is nameable without reading the manifest.
  assert.deepEqual(missingCompositionArtifacts({ checkout: absent.checkout, profileDir: absent.profile, repoRoot: absent.repo }).missing, [{
    name: '@deepseek-ai/dsh-fixture-platform patch',
    file: join(absent.checkout, 'packages/bundle/platform/missing.patch.yml'),
    where: 'checkout',
    hint: 'bundle patch missing — rebuild it',
  }])
  // A list with a non-string entry declares nothing readable — the same
  // verdict the platform's own `bundlePatchFiles` reaches by throwing.
  const malformed = fixtureDeployment(join(root, 'malformed'), { platformPatch: ['./cordis.patch.yml', 7] })
  assert.deepEqual(missingCompositionArtifacts({ checkout: malformed.checkout, profileDir: malformed.profile, repoRoot: malformed.repo }).missing, [{
    name: '@deepseek-ai/dsh-fixture-platform',
    file: join(malformed.checkout, 'packages/bundle/platform/package.json'),
    where: 'checkout',
    hint: 'bundle declares no dsh.bundle.patch — the composition cannot be read',
  }])
}))

test('PL4 + AR2 ②: a mounted row older than its sources is reported — a client bundle and a host entry alike', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  const built = new Date('2026-01-01T00:00:00Z')
  const edited = new Date('2026-01-02T00:00:00Z')
  // The platform client bundle and BOTH host entries (the checkout's platform
  // host and this repo's host row) get a newer source file (a real edit); the
  // repo client bundle keeps sources older than its artifact.
  utimesSync(join(checkout, 'packages/client/fixture-client/lib/client.js'), built, built)
  write(checkout, 'packages/client/fixture-client/src/index.ts', '// edited\n')
  utimesSync(join(checkout, 'packages/client/fixture-client/src/index.ts'), edited, edited)
  utimesSync(join(repo, 'packages/client/panel/lib/client.js'), edited, edited)
  write(repo, 'packages/client/panel/src/index.ts', '// older\n')
  utimesSync(join(repo, 'packages/client/panel/src/index.ts'), built, built)
  utimesSync(join(checkout, 'packages/host/fixture-host/lib/index.js'), built, built)
  write(checkout, 'packages/host/fixture-host/src/index.ts', '// edited\n')
  utimesSync(join(checkout, 'packages/host/fixture-host/src/index.ts'), edited, edited)
  utimesSync(join(repo, 'packages/application/fixture-host/lib/index.js'), built, built)
  write(repo, 'packages/application/fixture-host/src/index.ts', '// edited\n')
  utimesSync(join(repo, 'packages/application/fixture-host/src/index.ts'), edited, edited)
  const result = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.deepEqual(result.missing, [])
  assert.equal(result.stale.length, 3)
  const byName = Object.fromEntries(result.stale.map(entry => [entry.name, entry]))
  assert.match(Object.keys(byName).join(' '), /@deepseek-ai\/dsh-fixture-client/)
  // The client bundle keeps its own wording and rebuild command…
  assert.match(byName['@deepseek-ai/dsh-fixture-client client bundle'].hint, /\(checkout\) pnpm run build/)
  assert.match(byName['@deepseek-ai/dsh-fixture-client client bundle'].hint, /stale client bundle/)
  // …and a host entry names ITS artifact and the host build, in the source tree
  // it was resolved from (a repo row rebuilds with the repo command).
  assert.equal(byName['@deepseek-ai/dsh-fixture-host'].where, 'checkout')
  assert.match(byName['@deepseek-ai/dsh-fixture-host'].hint, /stale host entry: src\/ is newer than lib\/index\.js/)
  assert.match(byName['@matrix1001/dsh-application-harness-fixture-host'].hint, /\(repo\) pnpm run build/)
  // The FRESH repo client bundle (artifact newer than its sources) is not stale.
  assert.equal(result.stale.some(entry => entry.name.includes('client-panel')), false)
}))

test('PL4: a repo client bundle older than its sources names the repo rebuild command', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  const built = new Date('2026-01-01T00:00:00Z')
  const edited = new Date('2026-01-02T00:00:00Z')
  utimesSync(join(repo, 'packages/client/panel/lib/client.js'), built, built)
  write(repo, 'packages/client/panel/src/index.ts', '// edited\n')
  utimesSync(join(repo, 'packages/client/panel/src/index.ts'), edited, edited)
  const { stale } = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].where, 'repo')
  assert.match(stale[0].hint, /\(repo\) pnpm exec tsdown/)
}))

test('a missing platform client bundle is reported with its path and the checkout build command', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root, { platformClientBuilt: false })
  const { missing } = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.equal(missing.length, 1)
  const [problem] = missing
  assert.match(problem.name, /@deepseek-ai\/dsh-fixture-client/)
  assert.equal(problem.file, join(checkout, 'packages/client/fixture-client/lib/client.js'))
  assert.equal(problem.where, 'checkout')
  assert.match(problem.hint, /\(checkout\) pnpm run build/)
}))

test('a missing platform host entry and a missing repo client bundle are each reported with their own command', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root, { platformHostBuilt: false, repoClientBuilt: false })
  const { missing } = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  const byName = Object.fromEntries(missing.map(entry => [entry.name, entry]))
  assert.match(Object.keys(byName).join(' '), /@deepseek-ai\/dsh-fixture-host/)
  const host = missing.find(entry => entry.name.includes('fixture-host'))
  assert.equal(host.where, 'checkout')
  assert.match(host.hint, /\(checkout\) pnpm run build/)
  const repoProblem = missing.find(entry => entry.name.includes('client-panel'))
  assert.equal(repoProblem.where, 'repo')
  assert.match(repoProblem.hint, /\(repo\) pnpm exec tsdown/)
}))

test('an uninstalled bundle and an uninstalled row package are reported, not skipped', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  // A profile naming a bundle that is nowhere to be found.
  write(profile, 'package.json', JSON.stringify({
    name: 'dsh-profile-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-fixture-platform', '@deepseek-ai/dsh-missing-bundle'] } },
  }))
  const uninstalled = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.ok(uninstalled.missing.some(entry => entry.name === '@deepseek-ai/dsh-missing-bundle' && /pnpm install/.test(entry.hint)))
  // A mounted row whose package is absent.
  write(checkout, 'packages/bundle/platform/cordis.patch.yml', [
    '- insert:',
    "    - id: ghost",
    "      name: '@deepseek-ai/dsh-ghost-row'",
    '',
  ].join('\n'))
  const ghost = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.ok(ghost.missing.some(entry => entry.name === '@deepseek-ai/dsh-ghost-row' && /pnpm install/.test(entry.hint)))
  // A profile without bundles is a hard problem too.
  write(profile, 'package.json', JSON.stringify({ name: 'dsh-profile-fixture', private: true }))
  const noBundles = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.equal(noBundles.checked, 0)
  assert.ok(noBundles.missing.some(entry => entry.name === 'profile bundles'))
  // …and a missing profile is reported rather than silently empty.
  const noProfile = missingCompositionArtifacts({ checkout, profileDir: join(root, 'nope'), repoRoot: repo })
  assert.ok(noProfile.missing.some(entry => entry.name === 'profile'))
}))

test('the resolver prefers the checkout workspace, then the profile, then this repo', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  const resolver = packageResolver({ checkout, profileDir: profile, repoRoot: repo })
  assert.equal(resolver.resolve('@deepseek-ai/dsh-fixture-client'), join(checkout, 'packages/client/fixture-client'))
  assert.equal(resolver.resolve('@matrix1001/dsh-application-harness-client-panel'), join(repo, 'packages/client/panel'))
  assert.equal(resolver.resolve('@deepseek-ai/nowhere'), undefined)
  assert.equal(resolver.root(join(checkout, 'packages/x')), 'checkout')
  assert.equal(resolver.root(join(repo, 'packages/x')), 'repo')
  assert.equal(resolver.root(join(profile, 'node_modules/x')), 'profile')
}))

test('the real deployment passes the preflight, and the reported repro (empty checkout node_modules) does not', () => withFixture((root) => {
  const home = process.env.HOME ?? ''
  const realCheckout = join(home, 'deepseek-harness')
  const realProfile = join(home, '.dsh', 'profiles', 'application-harness')
  if (!existsSync(join(realCheckout, 'package.json')) || !existsSync(join(realProfile, 'package.json'))) {
    // The CI sandbox has neither: the fixture cases above carry the contract.
    return
  }
  assert.deepEqual(missingCompositionArtifacts({ checkout: realCheckout, profileDir: realProfile }).missing, [])
  // The review's repro: a checkout with a package.json and an EMPTY node_modules.
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  write(root, 'package.json', '{}')
  const repro = missingCompositionArtifacts({ checkout: root, profileDir: realProfile })
  assert.ok(repro.missing.length > 0, 'an empty checkout node_modules must not pass the preflight')
  assert.ok(repro.missing.some(entry => /^@deepseek-ai\/dsh-base$/.test(entry.name)))
}))

test('a top-level name beside an insert never mounts: only the insert entries are demanded (PL7 ②)', () => {
  const document = parsePatchYaml([
    '- id: wrapper',
    "  name: '@deepseek-ai/dsh-never-mounted'",
    '  insert:',
    "    - id: real",
    "      name: '@deepseek-ai/dsh-real'",
    '',
  ].join('\n'))
  assert.deepEqual(patchRowNames(document), ['@deepseek-ai/dsh-real'])
})

test('the stack composes: an overlay re-enables a shipped-disabled row, and a later disable wins (PL7 ①)', () => {
  const shipped = parsePatchYaml([
    '- id: ui-schedule',
    "  name: '@deepseek-ai/dsh-client-ui-schedule'",
    '  disabled: true',
    '- id: app-http',
    "  name: '@matrix1001/dsh-application-harness-http'",
    '',
  ].join('\n'))
  const overlay = parsePatchYaml([
    '- id: ui-schedule',
    '  disabled: false',
    '- id: app-http',
    '  disabled: true',
    '',
  ].join('\n'))
  // The shipped layer alone drops the disabled row and demands the live one…
  assert.deepEqual(patchRowNames(shipped), ['@matrix1001/dsh-application-harness-http'])
  // …but the composed stack demands the re-enabled one and drops the disabled
  // one — the row KEYED by id, exactly as the loader keys it.
  assert.deepEqual(mergedPatchRowNames([shipped, overlay]), ['@deepseek-ai/dsh-client-ui-schedule'])
  // A later layer that re-declares a row supersedes its name; the disabled flag
  // only moves when that layer carries one (here it re-enables too).
  const renamed = parsePatchYaml('- id: ui-schedule\n  name: \'@deepseek-ai/dsh-renamed\'\n  disabled: false\n')
  assert.deepEqual(mergedPatchRowNames([shipped, renamed]), ['@deepseek-ai/dsh-renamed', '@matrix1001/dsh-application-harness-http'])
  const renamedStillDisabled = parsePatchYaml('- id: ui-schedule\n  name: \'@deepseek-ai/dsh-renamed\'\n')
  assert.deepEqual(mergedPatchRowNames([shipped, renamedStillDisabled]), ['@matrix1001/dsh-application-harness-http'])
  // Layers that are not arrays contribute nothing (a broken layer is the
  // caller's problem, not a crash here): only the shipped layer's live row remains.
  assert.deepEqual(mergedPatchRowNames([shipped, 'not: an array\n', null]), ['@matrix1001/dsh-application-harness-http'])
  // An anonymous row (no id) cannot be targeted: it mounts where it is enabled.
  assert.deepEqual(mergedPatchRowNames([[{ insert: [{ name: '@deepseek-ai/dsh-x' }] }], [{ start: 'y' }]]), ['@deepseek-ai/dsh-x'])
})

test('PL7 ①: the preflight composes the overlay layers — a shipped-disabled row is demanded only once an overlay enables it', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  // The shipped row is disabled and the client bundle is NOT built: as long as
  // nothing enables the row, it is not part of the requirement set.
  write(repo, 'packages/bundle/app-harness/cordis.patch.yml', [
    '- insert:',
    "    - id: client-panel",
    "      name: '@matrix1001/dsh-application-harness-client-panel'",
    '      disabled: true',
    '',
  ].join('\n'))
  rmSync(join(repo, 'packages/client/panel/lib/client.js'))
  assert.deepEqual(missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo }).missing, [])
  // The profile's USER layer re-enables it by id (the loader's own idiom): the
  // artifact is now required, and its absence is reported.
  write(profile, 'cordis.patch.yml', '- id: client-panel\n  disabled: false\n')
  const enabled = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.equal(enabled.missing.length, 1)
  assert.match(enabled.missing[0].name, /@matrix1001\/dsh-application-harness-client-panel/)
  // A launcher `--patch` overlay does the same from the command line…
  write(profile, 'cordis.patch.yml', '[]\n')
  const overlay = write(root, 'overlay.yml', '- id: client-panel\n  disabled: false\n')
  const viaLauncher = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo, extraPatches: [overlay] })
  assert.equal(viaLauncher.missing.length, 1)
  // …and a `--patch` path that does not exist is reported instead of silently
  // shrinking the requirement set.
  const absent = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo, extraPatches: ['/nope/gone.yml'] })
  assert.equal(absent.missing.length, 1)
  assert.match(absent.missing[0].name, /--patch \/nope\/gone\.yml/)
  assert.equal(absent.missing[0].where, 'launch')
}))

test('the whole preflight (launch-apps) reports a missing mounted client and passes once it is built', () => withFixture((root) => {
  const broken = fixtureDeployment(join(root, 'broken'), { platformClientBuilt: false })
  const problems = preflight({ root: REPO, checkout: broken.checkout, profile: 'fixture', profileDir: broken.profile, deploymentDir: broken.deploymentDir })
  assert.ok(problems.some(problem => /fixture-client/.test(problem.name)), JSON.stringify(problems.slice(0, 3)))
  assert.match(problems.find(problem => /fixture-client/.test(problem.name)).file, /lib\/client\.js$/)
  // The fully built variant of the same fixture passes end to end.
  const built = fixtureDeployment(join(root, 'built'))
  assert.deepEqual(preflight({ root: REPO, checkout: built.checkout, profile: 'fixture', profileDir: built.profile, deploymentDir: built.deploymentDir }), [])
}))

test('AR2″a: the preflight really reaches all three chains — one seeded defect each', () => withFixture((root) => {
  // The three chains the item found unexecuted: composition artifacts, build
  // artifacts, profile links. Seed exactly one defect per chain and demand all
  // three come back — a chain that is dropped from `preflight` turns this red
  // instead of quietly narrowing what the launch pre-checks.
  const { checkout, profile, deploymentDir } = fixtureDeployment(root, { platformClientBuilt: false })
  const repo = join(root, 'repo')
  // ② a descriptor-declared row whose artifact was never built.
  write(repo, 'packages/bundle/app-harness/deployment.yml', 'schemaVersion: 1\nservices:\n  - package: \'@matrix1001/dsh-application-harness-fixture-build\'\n')
  write(repo, 'packages/application/fixture-build/package.json', JSON.stringify({
    name: '@matrix1001/dsh-application-harness-fixture-build',
    exports: { '.': { default: './lib/index.js' } },
  }))
  // ③ the profile links each deployment package back at this workspace; link one
  // of them somewhere else (a stale copy) instead.
  write(repo, 'packages/application/fixture-link/package.json', JSON.stringify({ name: '@matrix1001/dsh-application-harness-fixture-link' }))
  mkdirSync(join(root, 'elsewhere'), { recursive: true })
  symlinkSync(join(root, 'elsewhere'), join(deploymentDir, '@matrix1001/dsh-application-harness-fixture-link'))
  const problems = preflight({ root: repo, checkout, profile: 'fixture', profileDir: profile, deploymentDir })
  const names = problems.map((problem) => problem.name).join(' | ')
  assert.match(names, /dsh-fixture-client/u, `no composition-artifact problem: ${names}`)
  assert.match(names, /application-harness-fixture-build/u, `no build-artifact problem: ${names}`)
  assert.match(names, /application-harness-fixture-link/u, `no profile-link problem: ${names}`)
}))

/** Run `--check-only` in a child process and collect its verdict. */
async function runCheckOnly(args, env) {
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'launch-apps.mjs'), '--check-only', ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const code = await new Promise((resolveExit) => child.on('exit', resolveExit))
  return { code, output }
}

test('AR2″a: --check-only without a checkout reports UNVERIFIED and does not fail', () => withFixture(async (root) => {
  // CI has no platform checkout and deliberately does not fetch one (PL8). The
  // degraded form must say the chain did NOT run — never claim it passed.
  const { code, output } = await runCheckOnly(['--checkout', join(root, 'no-such-checkout'), '--profile', 'nope'], {})
  assert.equal(code, 0, output)
  assert.match(output, /UNVERIFIED — no platform checkout/u)
  assert.match(output, /was NOT executed/u)
  assert.doesNotMatch(output, /preflight OK/u)
}))

test('the launch summary names the platform state directory derived from DSH_HOME', () => withFixture(async (root) => {
  const { checkout, env } = fixtureDeployment(root, { platformClientBuilt: true })
  const { output } = await runCheckOnly(['--checkout', checkout, '--profile', 'fixture'], env)
  assert.match(output, /\[launch-apps\] platform state: /u)
  assert.ok(
    output.includes(join(root, 'home', 'application-harness')),
    `the platform state path is not the DSH_HOME-derived one:\n${output}`,
  )
}))

test('AR2″a: --check-only on a checkout with a real defect fails', () => withFixture(async (root) => {
  const { checkout, env } = fixtureDeployment(root, { platformClientBuilt: false })
  const { code, output } = await runCheckOnly(['--checkout', checkout, '--profile', 'fixture'], env)
  assert.equal(code, 1, output)
  assert.match(output, /preflight problem\(s\) — not launching/u)
  assert.match(output, /dsh-fixture-client/u)
}))

test('the setup --launch source resolution reports what it verified', () => {
  assert.deepEqual(resolveLaunchSource({ dshBin: '/nope', profileArgs: ['--profile', 'p'] }), {
    cmd: process.execPath, args: ['/nope', '--profile', 'p'], source: '--dsh', verified: false, note: 'explicit bin path does not exist',
  })
  assert.equal(resolveLaunchSource({ dshBin: process.execPath }).verified, true)
  assert.equal(resolveLaunchSource({ env: { DSH_BIN: '/nope' } }).source, 'DSH_BIN')
  assert.equal(resolveLaunchSource({ env: { DSH_BIN: '/nope' } }).verified, false)
  const onPath = resolveLaunchSource({ env: {}, onPath: name => name === 'dsh' })
  assert.deepEqual([onPath.source, onPath.verified, onPath.cmd], ['PATH', true, 'dsh'])
  const npx = resolveLaunchSource({ env: {}, onPath: () => false })
  assert.deepEqual([npx.source, npx.verified], ['npx', false])
  assert.match(npx.note, /NOT the platform checkout/)
})

test('the wrapper forwards arguments, the exit code, and termination signals', async () => withFixture(async (root) => {
  const { checkout, env, cliBin } = fixtureDeployment(root)
  // A stub CLI at the checkout's OWN declared entry, that records its argv,
  // exits with a chosen code, and answers SIGTERM with its own marker + exit
  // code. Nothing is stubbed on PATH: what the wrapper resolves is the entry
  // the checkout declares, so the test proves the resolution, not a lookup.
  const record = join(root, 'argv.txt')
  const cwdRecord = join(root, 'cwd.txt')
  const signalMarker = join(root, 'signal.txt')
  const ready = join(root, 'ready.txt')
  writeFileSync(cliBin, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))
fs.writeFileSync(${JSON.stringify(cwdRecord)}, process.cwd())
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalMarker)}, 'SIGTERM'); process.exit(42) })
if (process.argv.includes('--hold')) { fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 30000) } else { process.exit(7) }
`)
  const wrapper = join(REPO, 'scripts', 'launch-apps.mjs')
  const spawnWrapper = (extra) => spawn(process.execPath, [wrapper, '--checkout', checkout, '--profile', 'fixture', '--', ...extra], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Exit-code forwarding + argument forwarding (the stub sees `dsh --profile fixture --no-open`).
  let childOutput = ''
  const exited = await new Promise((resolveExit) => {
    const child = spawnWrapper(['--no-open'])
    child.stdout.on('data', (chunk) => { childOutput += chunk })
    child.stderr.on('data', (chunk) => { childOutput += chunk })
    child.on('exit', (code) => resolveExit(code))
  })
  assert.equal(exited, 7, childOutput)
  // The stub IS the checkout's declared CLI entry, so a written record already
  // proves that entry ran; the arguments dsh sees are the profile and
  // everything the caller forwarded.
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), ['--profile', 'fixture', '--no-open'])
  // …and the child ran IN the workspace, not in the checkout it was launched
  // from (AR2n④: `process.cwd()` is where the world's files land).
  assert.equal(readFileSync(cwdRecord, 'utf8'), join(root, 'workspace'))
  assert.equal(existsSync(join(root, 'workspace', '.dsh-applications')), true, 'the launch did not create the workspace world directory')
  // Signal forwarding: SIGTERM reaches the child, which answers with its own
  // code — the wrapper mirrors that, so a killed child never leaves a wrapper
  // lingering. The child announces itself through `ready` first (the first
  // run's record file would otherwise make the wait a no-op).
  rmSync(ready, { force: true })
  const signalled = await new Promise((resolveExit) => {
    const child = spawnWrapper(['--hold'])
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit('timeout') }, 15000)
    const wait = setInterval(() => {
      if (existsSync(ready)) {
        clearInterval(wait)
        child.kill('SIGTERM')
      }
    }, 25)
    child.on('exit', (code) => { clearTimeout(timer); clearInterval(wait); resolveExit(code) })
  })
  assert.equal(signalled, 42)
  assert.equal(readFileSync(signalMarker, 'utf8'), 'SIGTERM')
}))

test('F-1: a relative --patch resolves ONCE — against the invocation cwd — for the preflight and the child', () => {
  // The rewrite: both spellings become absolute against the caller's cwd, every
  // other forwarded argument is untouched, and an already-absolute overlay and a
  // valueless `--patch` stay exactly as given (dsh's parser names the latter).
  assert.deepEqual(
    resolvePatchArgs(['--no-open', '--patch', 'rel/overlay.yml', '--patch=other.yml'], '/base'),
    ['--no-open', '--patch', '/base/rel/overlay.yml', '--patch=/base/other.yml'],
  )
  assert.deepEqual(resolvePatchArgs(['--patch', '/abs/o.yml', '--patch='], '/base'), ['--patch', '/abs/o.yml', '--patch='])
  assert.deepEqual(resolvePatchArgs(['--patch'], '/base'), ['--patch'])
  // One string, two consumers: what the preflight judges (`patchArgsOf`) is what
  // the plan hands the child (`runtimeSource.args`).
  const extra = resolvePatchArgs(['--patch', 'overlay.yml'], '/base')
  assert.deepEqual(patchArgsOf(extra), ['/base/overlay.yml'])
  assert.deepEqual(
    launchPlan({ checkout: '/co', profile: 'p', extra, workspace: '/ws', cli: { bin: '/co/apps/cli/lib/bin.js', source: 'checkout' } }).runtimeSource.args,
    ['/co/apps/cli/lib/bin.js', '--profile', 'p', '--patch', '/base/overlay.yml'],
  )
})

test('F-1: a relative --patch that the preflight passes is a file the child can open from its OWN cwd', async () => withFixture(async (root) => {
  const { checkout, env, cliBin } = fixtureDeployment(root)
  const overlay = write(root, 'overlay.yml', '[]\n')
  // The stub CLI resolves the overlay the way dsh does — `resolve(file)` from
  // ITS cwd — and records both the argv it got and whether that file opens.
  const record = join(root, 'argv.txt')
  const cwdRecord = join(root, 'cwd.txt')
  const opened = join(root, 'opened.txt')
  writeFileSync(cliBin, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(argv))
fs.writeFileSync(${JSON.stringify(cwdRecord)}, process.cwd())
fs.writeFileSync(${JSON.stringify(opened)}, String(fs.existsSync(path.resolve(argv[argv.indexOf('--patch') + 1]))))
process.exit(7)
`)
  // Launched from the fixture ROOT: `overlay.yml` resolves from here and nowhere
  // else (the child's cwd is the workspace, where no such file exists), so a
  // verbatim hand-off is exactly the failure the preflight's own hint promises
  // to catch — the preflight passing on a file the boot cannot open.
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'launch-apps.mjs'),
    '--checkout', checkout, '--profile', 'fixture', '--', '--patch', 'overlay.yml'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const code = await new Promise((resolveExit) => child.on('exit', resolveExit))
  assert.equal(code, 7, output)
  assert.match(output, /preflight OK/u, output)
  // The child runs in the workspace, and the overlay it was handed is the
  // ABSOLUTE file the preflight judged — resolvable from that cwd.
  assert.equal(readFileSync(cwdRecord, 'utf8'), join(root, 'workspace'))
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), ['--profile', 'fixture', '--patch', overlay])
  assert.equal(readFileSync(opened, 'utf8'), 'true', 'the child could not open the overlay the preflight passed')
}))

test('AR2″a: a VALUE import of a workspace package is an inlined input; a type-only one is not', () => withFixture((root) => {
  const document = [
    "import { Section } from '@matrix1001/dsh-application-harness-client-chrome'",
    "import { type AppTab, TabBar } from '@matrix1001/dsh-application-harness-client-chrome'",
    "import type { AppRunMeta } from '@matrix1001/dsh-application-harness-host-bridge/client'",
    "export type { AppRunResponse } from '@matrix1001/dsh-application-harness-host-bridge/client'",
    "import React from 'react'",
    "import { local } from './local.ts'",
    '',
  ].join('\n')
  write(root, 'pkg/src/client/index.ts', document)
  // A type-only edge is erased: it cannot put a byte into the artifact, so it
  // must not make the consumer look stale when the far side is edited.
  assert.deepEqual([...workspaceSourceImports(join(root, 'pkg'))], ['@matrix1001/dsh-application-harness-client-chrome'])
}))

test('AR2″a: the walk is transitive, and a host row inlines nothing', () => withFixture((root) => {
  const source = (name, text) => write(root, `pkg-${name}/src/index.ts`, text)
  const consumer = join(root, 'pkg-consumer')
  const library = join(root, 'pkg-library')
  const nested = join(root, 'pkg-nested')
  source('consumer', "import { a } from '@matrix1001/dsh-application-harness-x-library'\n")
  source('library', "import { b } from '@matrix1001/dsh-application-harness-x-nested'\n")
  source('nested', 'export const b = 1\n')
  const workspace = new Map([
    ['@matrix1001/dsh-application-harness-x-library', library],
    ['@matrix1001/dsh-application-harness-x-nested', nested],
  ])
  assert.deepEqual(inlinedSourceDirs(consumer, { workspace, inlines: true }), [library, nested])
  // A host entry's workspace imports stay external (the profile resolves them
  // at runtime), so nothing of theirs feeds the artifact.
  assert.deepEqual(inlinedSourceDirs(consumer, { workspace, inlines: false }), [])
}))

test('AR2″a: an edit to an INLINED input stales a client bundle whose own src/ did not move', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  const built = new Date('2026-01-01T00:00:00Z')
  const edited = new Date('2026-01-02T00:00:00Z')
  // A workspace library this repo's client bundle pulls in by value. It is not a
  // mounted row: the client build inlines it instead of leaving it to the
  // profile, so its sources are part of the bundle's bytes.
  write(repo, 'packages/client/inline-lib/package.json', JSON.stringify({
    name: '@matrix1001/dsh-application-harness-inline-lib',
    exports: { '.': { default: './lib/index.js' } },
  }))
  write(repo, 'packages/client/inline-lib/lib/index.js', '// built\n')
  write(repo, 'packages/client/panel/src/client/index.ts', "import { section } from '@matrix1001/dsh-application-harness-inline-lib'\nexport const a = section\n")
  utimesSync(join(repo, 'packages/client/panel/src/client/index.ts'), built, built)
  utimesSync(join(repo, 'packages/client/panel/lib/client.js'), built, built)
  // The inlined input moves. The consumer's own src/ is untouched — the exact
  // shape the own-`src/` criterion read as "not stale".
  write(repo, 'packages/client/inline-lib/src/index.ts', '// edited\n')
  utimesSync(join(repo, 'packages/client/inline-lib/src/index.ts'), edited, edited)
  const { stale } = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].name, '@matrix1001/dsh-application-harness-client-panel client bundle')
  assert.equal(stale[0].where, 'repo')
  assert.match(stale[0].hint, /an inlined input \(packages\/client\/inline-lib\/src\/\) is newer than lib\/client\.js/u)
}))

test('AR2″a: an edit to a package a HOST row only imports at runtime does not stale it', () => withFixture((root) => {
  const { checkout, repo, profile } = fixtureDeployment(root)
  const built = new Date('2026-01-01T00:00:00Z')
  const edited = new Date('2026-01-02T00:00:00Z')
  write(repo, 'packages/application/peer-lib/package.json', JSON.stringify({ name: '@matrix1001/dsh-application-harness-peer-lib' }))
  write(repo, 'packages/application/fixture-host/src/index.ts', "import { p } from '@matrix1001/dsh-application-harness-peer-lib'\nexport const a = p\n")
  utimesSync(join(repo, 'packages/application/fixture-host/src/index.ts'), built, built)
  utimesSync(join(repo, 'packages/application/fixture-host/lib/index.js'), built, built)
  write(repo, 'packages/application/peer-lib/src/index.ts', '// edited\n')
  utimesSync(join(repo, 'packages/application/peer-lib/src/index.ts'), edited, edited)
  const { stale } = missingCompositionArtifacts({ checkout, profileDir: profile, repoRoot: repo })
  // The host entry is bundled with its workspace import left EXTERNAL: the
  // profile supplies it at boot, so the far side's edit moves no byte here.
  assert.deepEqual(stale, [])
}))

test('AR2″a: --help states the same exit-code contract as the module header', async () => {
  // The wrapper's 0 is no longer only "ready": with no checkout the check lane
  // reports UNVERIFIED and still exits 0. `--help` said "0 = ready, 1 =
  // problems" while the module header already said "ready or UNVERIFIED" — a
  // user-visible claim that hid the case it exists to explain. Pin both copies.
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'launch-apps.mjs'), '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let help = ''
  child.stdout.on('data', (chunk) => { help += chunk })
  child.stderr.on('data', (chunk) => { help += chunk })
  const code = await new Promise((resolveExit) => child.on('exit', resolveExit))
  assert.equal(code, 0, help)
  assert.match(help, /--check-only\s+run the preflight and exit \(0 = ready or UNVERIFIED, 1 = problems\)/u)
  assert.doesNotMatch(help, /0 = ready, 1 = problems/u)
  // The module header carries the same sentence, so the two cannot drift apart
  // one at a time.
  assert.match(readFileSync(join(REPO, 'scripts', 'launch-apps.mjs'), 'utf8'), /0 = ready or UNVERIFIED, 1 = problems\)/u)
})

test('the wrapper CLI contract stays stable', () => {
  const opts = parseArgs(['--checkout', '/co', '--profile', 'p', '--check-only', '--dry-run', '--', '--no-open'], {}, '/home/u')
  assert.deepEqual(opts, { checkout: '/co', profile: 'p', checkOnly: true, dryRun: true, extra: ['--no-open'] })
  const plan = launchPlan({ checkout: '/co', profile: 'p', extra: ['--x'], workspace: '/ws', cli: { bin: '/co/apps/cli/lib/bin.js', source: 'checkout' } })
  assert.deepEqual(plan.runtimeSource.args, ['/co/apps/cli/lib/bin.js', '--profile', 'p', '--x'])
  // The runtime stays in the checkout while the child's cwd is the workspace.
  assert.equal(plan.runtimeSource.checkout, '/co')
  assert.equal(plan.workspaceCwd, '/ws')
})
