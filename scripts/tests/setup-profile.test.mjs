/**
 * `setup.mjs` refreshes the profile — and the profile directory holds state the
 * PLATFORM owns, not only our scaffold. Platform 0.1.7-alpha.1 moved user
 * settings into the active profile's `cordis.patch.yml` (the config editor and
 * the settings service persist there, and the settings page writes rows by
 * plugin id), the plugin manager installs into the profile's `package.json`,
 * and its build approval writes `pnpm-workspace.yaml`.
 *
 * Before 2026-09-23 `main()` did `rmSync(dir)` and `writeProfile` rewrote all
 * three from templates: one settings-page edit plus one `node scripts/setup.mjs`
 * (or `pnpm run start`, which is `setup --launch`) silently reset every setting
 * and dropped every installed plugin. These specs pin the merge: our half is
 * refreshed in place, theirs is left alone, and a patch layer we cannot read
 * fails closed instead of being replaced.
 *
 * The fixtures are isolated `DSH_HOME` + workspace trees; no live profile is
 * ever read or written (the repo's own `$DSH_HOME` default is never used).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROFILE = 'application-harness'

/** Run `body` with a fresh temp dir, removed afterwards (an async body is awaited first). */
function withFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-setup-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  let result
  try {
    result = body(dir)
  } catch (error) {
    cleanup()
    throw error
  }
  // These specs spawn a process inside the body: cleaning up before that
  // promise settles would delete the fixture out from under the run.
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

/** The isolated environment a setup run gets: its own home, workspace and (empty) legacy list. */
function envOf(root) {
  return {
    DSH_HOME: join(root, 'home'),
    DSH_WORKSPACE: join(root, 'workspace'),
    DSH_WORKSPACE_LEGACY: '',
  }
}

/** Run `node scripts/setup.mjs <args>` in the fixture environment. */
function runSetup(root, args) {
  const child = spawn(process.execPath, [join(REPO, 'scripts', 'setup.mjs'), ...args], {
    env: { ...process.env, ...envOf(root) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  return new Promise((settle) => { child.on('exit', (code) => settle({ code, output })) })
}

const profileDirOf = (root) => join(root, 'home', 'profiles', PROFILE)

test('setup keeps the platform-owned settings document it finds', async () => withFixture(async (root) => {
  const settings = [
    '# the profile user layer, as the platform writes it',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-08-13.1',
    '',
  ].join('\n')
  const patch = write(root, join('home', 'profiles', PROFILE, 'cordis.patch.yml'), settings)
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  // Byte-for-byte: a settings document is not ours to reformat.
  assert.equal(readFileSync(patch, 'utf8'), settings)
}))

test('setup seeds the patch layer only when there is none', async () => withFixture(async (root) => {
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  const patch = join(profileDirOf(root), 'cordis.patch.yml')
  assert.equal(existsSync(patch), true, 'a fresh profile still gets the user layer')
  assert.match(readFileSync(patch, 'utf8'), /^\[/mu, 'the seeded layer is the empty user layer')
}))

test('setup refreshes our dependencies and keeps the plugins the manager installed', async () => withFixture(async (root) => {
  // The plugin the manager installed: a local `link:` so the profile install
  // stays offline. What matters to the merge is that it is NOT in this repo's
  // deployment set, so nothing here redeploys it.
  write(root, 'plugin-fixture/package.json', JSON.stringify({ name: '@some-community/plugin', version: '2.0.0' }))
  write(root, join('home', 'profiles', PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-application-harness',
    private: true,
    dependencies: {
      '@matrix1001/dsh-application-harness-runtime': 'link:/gone/stale/path',
      '@some-community/plugin': `link:${join(root, 'plugin-fixture')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, undefined, 2))
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  const manifest = JSON.parse(readFileSync(join(profileDirOf(root), 'package.json'), 'utf8'))
  // The installed plugin stays (nothing in this repo redeploys it)…
  assert.equal(manifest.dependencies['@some-community/plugin'], `link:${join(root, 'plugin-fixture')}`)
  // …our own entries are refreshed to this repo's packages…
  assert.match(manifest.dependencies['@matrix1001/dsh-application-harness-runtime'], new RegExp(`^link:${REPO}/`, 'u'))
  // …and this deployment's own bundles are all present, in layer order.
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@matrix1001/dsh-application-harness',
  ])
}))

test('setup drops our own entry for a package this repo no longer deploys', async () => withFixture(async (root) => {
  // The 2026-09-24 rename left the profile holding `@matrix1001/dsh-application-harness-ledger`
  // -> the old package directory. Keeping it makes the launch preflight resolve a
  // package that does not exist, forever. The entry is OURS because it links into
  // this repo's `packages/` — a plugin the manager installed (a `link:` into the
  // store, or a local path outside the repo) is never touched.
  write(root, 'plugin-fixture/package.json', JSON.stringify({ name: '@some-community/plugin', version: '2.0.0' }))
  const renamed = join(REPO, 'packages', 'application', 'ledger')
  write(root, join('home', 'profiles', PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-application-harness',
    private: true,
    dependencies: {
      '@matrix1001/dsh-application-harness-ledger': `link:${renamed}`,
      '@matrix1001/dsh-application-harness-runtime': 'link:/gone/stale/path',
      '@some-community/plugin': `link:${join(root, 'plugin-fixture')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, undefined, 2))
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  assert.match(output, /no longer deploys — dropped/u)
  const manifest = JSON.parse(readFileSync(join(profileDirOf(root), 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@matrix1001/dsh-application-harness-ledger'], undefined)
  assert.equal(manifest.dependencies['@some-community/plugin'], `link:${join(root, 'plugin-fixture')}`)
  assert.match(manifest.dependencies['@matrix1001/dsh-application-harness-runtime'], new RegExp(`^link:${REPO}/`, 'u'))
  // A `link:` into this repo's packages that DOES exist is ours and stays.
  const kept = join(REPO, 'packages', 'application', 'runtime')
  write(root, join('home', 'profiles', PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-application-harness', private: true,
    dependencies: { '@matrix1001/dsh-application-harness-runtime': `link:${kept}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, undefined, 2))
  const keptRun = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(keptRun.code, 0, keptRun.output)
}))

test('setup drops a RENAMED package entry and its bundle layer, so one bundle has one card', async () => withFixture(async (root) => {
  // The 2026-11 `@deepseek-ai/application-harness*` → `@matrix1001/dsh-application-harness*`
  // rename kept every package DIRECTORY, so the old dependency key pointed at an
  // existing target whose manifest declared the new name: the "target exists"
  // test kept it. `dsh.profile.bundles` then held the old bundle name next to
  // the new one; both resolve to the SAME patch, so the plugin page listed the
  // bundle twice (two enabled cards, and disabling or removing one changed
  // nothing because the other layer still applied).
  const bundleDir = join(REPO, 'packages', 'bundle', 'app-harness')
  const runtimeDir = join(REPO, 'packages', 'application', 'runtime')
  write(root, join('home', 'profiles', PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-application-harness',
    private: true,
    dependencies: {
      '@deepseek-ai/application-harness': `link:${bundleDir}`,
      '@deepseek-ai/application-harness-runtime': `link:${runtimeDir}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/application-harness', '@matrix1001/dsh-application-harness'] } },
  }, undefined, 2))
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  const manifest = JSON.parse(readFileSync(join(profileDirOf(root), 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-ai/application-harness'], undefined, 'the old bundle key goes')
  assert.equal(manifest.dependencies['@deepseek-ai/application-harness-runtime'], undefined, 'so does every old row key')
  assert.match(output, /whose package is now @matrix1001\/dsh-application-harness — dropped/u)
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@matrix1001/dsh-application-harness', '@deepseek-ai/dsh-web-app',
  ], 'the renamed bundle name leaves the layer list; the current one keeps its position')
  // A readable manifest that still declares the dependency's own name is kept.
  assert.match(manifest.dependencies['@matrix1001/dsh-application-harness-runtime'], new RegExp(`^link:${REPO}/`, 'u'))
}))

test('setup seeds the workspace file only when there is none (build approvals live there)', async () => withFixture(async (root) => {
  const approvals = 'packages:\n  - .\n\nonlyBuiltDependencies:\n  - koffi\n'
  const workspace = write(root, join('home', 'profiles', PROFILE, 'pnpm-workspace.yaml'), approvals)
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  assert.equal(readFileSync(workspace, 'utf8'), approvals)
}))

test('setup fails closed on a patch layer it cannot read, and does not replace it', async () => withFixture(async (root) => {
  // A YAML array is what the platform requires; a mapping is not one, and
  // replacing it would delete whatever the user wrote.
  const broken = 'a: mapping\nnot: an array\n'
  const patch = write(root, join('home', 'profiles', PROFILE, 'cordis.patch.yml'), broken)
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.notEqual(code, 0, output)
  assert.match(output, /not a readable YAML array/u)
  assert.match(output, new RegExp(patch.replaceAll('/', '\\/'), 'u'), 'the refusal names the absolute path')
  assert.equal(readFileSync(patch, 'utf8'), broken)
}))

test('setup keeps the bundles the plugin manager enabled, and appends only what is missing', async () => withFixture(async (root) => {
  // `dsh.profile.bundles` is what the platform's plugin manager reads as each
  // bundle's `enabled` flag and writes back on activate/deactivate
  // (`packages/boot/app-boot/src/profile-plugins.ts`), so a bundle the user
  // enabled there is not ours to drop.
  write(root, join('home', 'profiles', PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-application-harness',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-base'] } },
  }, undefined, 2))
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  const manifest = JSON.parse(readFileSync(join(profileDirOf(root), 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app', '@matrix1001/dsh-application-harness',
  ], 'the user bundle keeps its position; only the missing required entries are appended')
  assert.match(output, /profile bundle @deepseek-ai\/dsh-web-app was missing/u)
}))

test('setup re-appends a required bundle that is missing, and says so out loud', async () => withFixture(async (root) => {
  // A missing required entry is indistinguishable in the manifest from a
  // deliberate deactivation, so the append is reported rather than guessed at
  // (and never a refusal: `setup` is the documented daily command).
  write(root, join('home', 'profiles', PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-application-harness',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@matrix1001/dsh-application-harness'] } },
  }, undefined, 2))
  const { code, output } = await runSetup(root, ['--no-install', '--no-build'])
  assert.equal(code, 0, output)
  const manifest = JSON.parse(readFileSync(join(profileDirOf(root), 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@matrix1001/dsh-application-harness', '@deepseek-ai/dsh-web-app',
  ])
  assert.match(output, /profile bundle @deepseek-ai\/dsh-web-app was missing from dsh\.profile\.bundles/u)
}))
