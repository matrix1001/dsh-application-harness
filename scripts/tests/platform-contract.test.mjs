/**
 * Script-plane tests for the T3/T4/T5 platform-contract helpers: the profile
 * shape comparator, the module-table parser, and the drift checker. Every case
 * is a NEGATIVE self-proof first — each new red line must actually trip — plus
 * the positive control that the real shapes pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import {
  compareProfileShape, digestTree, officialAppBoot, officialBundleLists, parseLocalPlatformModules, parsePlatformModules, readLock, targetOf, VENDOR_PAIRS,
} from '../platform-contract.mjs'
import { declaredLine, tagFor } from '../vendor-platform-src.mjs'
import { verify as verifyModules } from '../verify-platform-modules.mjs'

/** Run `body` with a fresh temp dir. */
function withFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-contract-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Write a profile-shaped directory (the official sample's exact shape by default). */
function writeProfile(dir, overrides = {}) {
  const {
    manifest = {
      name: 'dsh-profile-application-harness',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    },
    patch = '# template\n[]\n',
    workspace = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    skip = [],
  } = overrides
  mkdirSync(dir, { recursive: true })
  if (!skip.includes('package.json')) writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  if (!skip.includes('cordis.patch.yml')) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  if (!skip.includes('pnpm-workspace.yaml')) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)
  return dir
}

test('T4: the real official shape and a legitimate custom profile pass', () => withFixture((root) => {
  const official = writeProfile(join(root, 'official'))
  // Ours by design: different name, `link:` dependencies, a longer bundle list,
  // comments, and NO patchReload (the platform deleted the field in
  // 0.1.6-alpha.2; see the reverse assertion).
  const ours = writeProfile(join(root, 'ours'), {
    manifest: {
      name: 'dsh-profile-application-harness',
      private: true,
      dependencies: { '@matrix1001/dsh-application-harness': 'link:/repo/packages/bundle/app-harness' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@matrix1001/dsh-application-harness'] } },
    },
    patch: '# our user layer\n[]\n',
  })
  assert.deepEqual(compareProfileShape({ official, ours, parseYaml }), [])
}))

test('T4: EVERY red line trips — on our side and on the official sample alike', () => withFixture((root) => {
  const wsOk = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  const officialManifest = { name: 'dsh-profile-official', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
  const ourManifest = { name: 'dsh-profile-application-harness', private: true, dependencies: { '@matrix1001/dsh-application-harness': 'link:/repo/packages/bundle/app-harness' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@matrix1001/dsh-application-harness'] } } }
  const official = writeProfile(join(root, 'official'), { manifest: officialManifest })
  const ours = writeProfile(join(root, 'ours'), { manifest: ourManifest, patch: '# our user layer\n[]\n' })
  // The positive control: the real shapes (ours without patchReload, with its
  // own links/bundles/name/comments) align.
  assert.deepEqual(compareProfileShape({ official, ours, parseYaml }), [])

  // One mutant per requirement, each written to its own directory. The official
  // side is the CONTRACT, so a change there must be just as loud as one of ours.
  const cases = [
    // [label, side, overrides, expected]
    ['official: bundles is not an array', 'official', { manifest: { ...officialManifest, dsh: { profile: { bundles: '@deepseek-ai/dsh-base' } } } }, /official sample dsh\.profile\.bundles is no longer a string array/],
    ['official: patch is not a top-level array', 'official', { patch: 'not: an array\n' }, /official sample cordis\.patch\.yml must be a top-level array/],
    ['official: nodeLinker dropped', 'official', { workspace: 'packages:\n  - .\n\nautoInstallPeers: false\n' }, /official sample pnpm-workspace\.yaml declares no nodeLinker/],
    ['official: autoInstallPeers dropped', 'official', { workspace: 'packages:\n  - .\n\nnodeLinker: hoisted\n' }, /official sample pnpm-workspace\.yaml declares no autoInstallPeers/],
    ['official: not private', 'official', { manifest: { ...officialManifest, private: false } }, /official sample is not private/],
    ['official: name is not dsh-profile-*', 'official', { manifest: { ...officialManifest, name: 'application-harness' } }, /official sample name is no longer/],
    ['official: dependencies is not an object', 'official', { manifest: { ...officialManifest, dependencies: [] } }, /official sample dependencies are no longer an object/],
    ['official: patchReload wrote itself back', 'official', { manifest: { ...officialManifest, dsh: { profile: { bundles: [], patchReload: 'live' } } } }, /official sample carries dsh\.profile\.patchReload/],
    ['ours: missing the patch file', 'ours', { skip: ['cordis.patch.yml'] }, /missing the required file cordis\.patch\.yml/],
    ['ours: missing the pnpm workspace file', 'ours', { skip: ['pnpm-workspace.yaml'] }, /missing the required file pnpm-workspace\.yaml/],
    ['ours: not private', 'ours', { manifest: { ...ourManifest, private: false } }, /must set private: true/],
    ['ours: name is not dsh-profile-*', 'ours', { manifest: { ...ourManifest, name: 'whatever' } }, /name must be `dsh-profile-<profile>`/],
    ['ours: dependencies is an array', 'ours', { manifest: { ...ourManifest, dependencies: [] } }, /dependencies object/],
    ['ours: bundles is not an array', 'ours', { manifest: { ...ourManifest, dsh: { profile: { bundles: '@deepseek-ai/dsh-base' } } } }, /dsh\.profile\.bundles must be array/],
    ['ours: a non-string bundle', 'ours', { manifest: { ...ourManifest, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 7] } } } }, /bundles must contain only strings/],
    ['ours: patchReload wrote itself back', 'ours', { manifest: { ...ourManifest, dsh: { profile: { bundles: [], patchReload: 'never' } } } }, /dsh\.profile\.patchReload must be absent/],
    ['ours: patch is not a top-level array', 'ours', { patch: 'not: an array\n' }, /generated profile cordis\.patch\.yml must be a top-level array/],
    ['ours: user layer is no longer empty', 'ours', { patch: '- id: x\n' }, /official template is an empty array, but the generated user layer carries 1 entry/],
    ['ours: nodeLinker changed', 'ours', { workspace: 'packages:\n  - .\n\nnodeLinker: isolated\nautoInstallPeers: false\n' }, /nodeLinker must be "hoisted" like the official sample/],
    ['ours: autoInstallPeers changed', 'ours', { workspace: 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: true\n' }, /autoInstallPeers must be false like the official sample/],
    ['ours: packages list changed', 'ours', { workspace: 'packages:\n  - sub\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' }, /packages must be \["\."\] like the official sample/],
  ]
  for (const [label, side, overrides, expected] of cases) {
    const dir = join(root, `mutant-${label.replace(/\W+/gu, '-')}`)
    if (side === 'official') {
      writeProfile(dir, { workspace: wsOk, ...overrides })
      const failures = compareProfileShape({ official: dir, ours, parseYaml })
      assert.ok(failures.some(failure => expected.test(failure)), `${label}: expected ${expected} in ${JSON.stringify(failures)}`)
    } else {
      writeProfile(dir, { manifest: ourManifest, patch: '# ours\n[]\n', workspace: wsOk, ...overrides })
      const failures = compareProfileShape({ official, ours: dir, parseYaml })
      assert.ok(failures.some(failure => expected.test(failure)), `${label}: expected ${expected} in ${JSON.stringify(failures)}`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
}))

test('T4: the official package decision is fail-closed on missing or mismatched versions', () => withFixture((root) => {
  const declaredLine = '0.1.5-rc.1'
  // Missing: a configuration error, never an UNVERIFIED pass.
  assert.equal(officialAppBoot({ root, declaredLine }).status, 'missing')
  // A matching version is the only ok.
  const write = (manifest) => {
    mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify(manifest))
  }
  write({ name: '@deepseek-ai/dsh-app-boot', version: '0.1.2-rc.1' })
  assert.deepEqual(
    [officialAppBoot({ root, declaredLine }).status, officialAppBoot({ root, declaredLine }).version],
    ['mismatch', '0.1.2-rc.1'],
  )
  write({ name: '@deepseek-ai/dsh-app-boot', version: declaredLine })
  assert.deepEqual([officialAppBoot({ root, declaredLine }).status, officialAppBoot({ root, declaredLine }).version], ['ok', declaredLine])
  // The real deployment must be on the declared line.
  assert.equal(officialAppBoot({ root: process.cwd(), declaredLine: readLock(process.cwd()).declaredLine }).status, 'ok')
}))

test('T4: the official bundle-list package is checked on the same declared line', () => withFixture((root) => {
  const declaredLine = '0.2.2-rc.1'
  assert.equal(officialBundleLists({ root, declaredLine }).status, 'missing')
  const write = (manifest) => {
    mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-official-bundles'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-official-bundles', 'package.json'), JSON.stringify(manifest))
  }
  write({ name: '@deepseek-ai/dsh-official-bundles', version: '0.2.1-rc.2' })
  assert.deepEqual(
    [officialBundleLists({ root, declaredLine }).status, officialBundleLists({ root, declaredLine }).version],
    ['mismatch', '0.2.1-rc.2'],
  )
  write({ name: '@deepseek-ai/dsh-official-bundles', version: declaredLine })
  assert.deepEqual(
    [officialBundleLists({ root, declaredLine }).status, officialBundleLists({ root, declaredLine }).version],
    ['ok', declaredLine],
  )
  assert.equal(officialBundleLists({ root: process.cwd(), declaredLine: readLock(process.cwd()).declaredLine }).status, 'ok')
}))

test('T5: the module-table parser accepts only a literal array (never an empty pass)', () => {
  assert.deepEqual(
    parsePlatformModules("export const PLATFORM_MODULES = [\n  'react', 'react-dom',\n] as const\n"),
    ['react', 'react-dom'],
  )
  assert.throws(() => parsePlatformModules('export const PLATFORM_MODULES = []\n'), /empty/)
  assert.throws(() => parsePlatformModules('export const PLATFORM_MODULES = [...base, "react"]\n'), /non-literal/)
  assert.throws(() => parsePlatformModules('export const OTHER = ["react"]\n'), /not exported/)
})

test('T5: the local copies and the lock are compared as three separate red lines', () => withFixture((root) => {
  // A fixture repo whose two local copies disagree, whose lock disagrees with
  // both, and whose package declares a platform seed as an external edge.
  const write = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  write('packages/client/tsdown.client.ts', "const PLATFORM_MODULES = [\n  'react', 'react-dom',\n] as const\n")
  write('scripts/verify-client-factory.mjs', "const PLATFORM_MODULES = [\n  'react',\n]\n")
  write('packages/client/panel/package.json', JSON.stringify({ name: '@matrix1001/dsh-application-harness-client-panel', dsh: { client: { external: ['react-dom'] } } }))
  write('scripts/platform-src-lock.json', JSON.stringify({ declaredLine: '0.0.0', tag: 'dsh-v0.0.0', commit: 'x', targets: [], platformModules: { source: 's', modules: ['react'] } }))
  // No checkout → the upstream half is UNVERIFIED, but the local failures are hard.
  const original = console.error
  const lines = []
  console.error = (line) => { lines.push(String(line)) }
  try {
    assert.equal(verifyModules({ root, checkout: undefined }), 1)
  } finally {
    console.error = original
  }
  const report = lines.join('\n')
  assert.match(report, /disagree on the platform seed table/)
  assert.match(report, /does not match the declared line's/)
  assert.match(report, /is a platform SEED entry/)
  // And the positive control: the real repo passes this function.
  assert.equal(verifyModules({}), 0)
}))

test('T3: the digest covers content, additions, and the pair table stays the lock contract', () => withFixture((root) => {
  const tree = join(root, 'src')
  mkdirSync(join(tree, 'nested'), { recursive: true })
  writeFileSync(join(tree, 'a.ts'), 'a\n')
  writeFileSync(join(tree, 'nested', 'b.ts'), 'b\n')
  const first = digestTree(tree)
  assert.equal(first.files, 2)
  writeFileSync(join(tree, 'nested', 'b.ts'), 'b2\n')
  assert.notEqual(digestTree(tree).digest, first.digest)
  writeFileSync(join(tree, 'c.ts'), 'c\n')
  assert.equal(digestTree(tree).files, 3)
  // A missing lock is a FAIL with the re-record instruction, not an empty pass.
  assert.throws(() => readLock(root), /is missing/)
  // The declared line and its tag are bound to the deployment descriptor.
  assert.match(tagFor(declaredLine()), /^dsh-v\d/)
  assert.equal(VENDOR_PAIRS.length, 12)
  // The typert shell is deliberately NOT vendored here — it follows the
  // checkout (see VENDOR_PAIRS' comment), so only the default target shape
  // remains to pin.
  assert.equal(targetOf(['client/store', 'dsh-client-store']), '.platform-src/dsh-client-store/src')
}))

test('T5: a real platform source file parses to the recorded snapshot', () => {
  // The lock's snapshot came from the declared commit; the local copy is
  // parsed by the OTHER helper, so this pins the two parsers together.
  const lock = readLock(process.cwd())
  const local = parseLocalPlatformModules(join(process.cwd(), 'packages/client/tsdown.client.ts'))
  assert.deepEqual(local, lock.platformModules.modules)
})
