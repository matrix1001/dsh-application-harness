/**
 * The reconciliation gate between our reference plane and the platform's
 * package set exists because a rename on the platform line is invisible to
 * every other gate. `pnpm install` resolves whatever the manifests name — an
 * old name installs from the registry and the drift surfaces at runtime — and
 * the two inert lists in `pnpm-workspace.yaml` (`overrides`,
 * `minimumReleaseAgeExclude`) are read by the resolver, not by the dependency
 * graph, so a stale entry there is read by nobody at all.
 *
 * Two properties are worth pinning beyond "a missing name is reported":
 *
 * - **The filter belongs to `diffSets`, and it filters OUR names out** — not
 *   the platform's in. This repo references `@matrix1001/dsh-application-harness-*`,
 *   `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and none of them is a
 *   package the platform tier is expected to hold; a gate that inherited them
 *   would fail on its first run and be switched off by the second.
 * - **The available plane is the checkout's OWN workspace declaration**, not
 *   the package tier alone: two names we reference — `@deepseek-ai/dsh` (the
 *   CLI bin) and `@deepseek-ai/dsh-web-frontend` — live under `apps/`. Scanning
 *   the package tier alone would report them missing, which is a false alarm on
 *   a package that plainly exists, and a gate that lies gets ignored.
 *
 * Every fixture is a scratch directory: a repo-root shape (root manifest +
 * `packages/<group>/<pkg>/package.json` + `pnpm-workspace.yaml`) or a checkout
 * shape (the platform's own `pnpm-workspace.yaml` globs).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  diffSets, platformNamesFromCheckout, referenceSites, referencedNames, verify,
} from '../verify-platform-package-set.mjs'

/** A throwaway fixture directory, removed even when the body throws. */
function withScratch(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-package-set-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Write a JSON fixture, creating its directory. */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

/**
 * The repo-root fixture: a root manifest, one package manifest, and the
 * workspace file's two inert lists — the four sites the reference plane reads.
 */
function repoFixture(root, {
  rootDeps = {}, packageDeps = {}, overrides = [], minimumReleaseAgeExclude = [],
} = {}) {
  writeJson(join(root, 'package.json'), { name: 'application-harness', private: true, devDependencies: rootDeps })
  writeJson(join(root, 'packages', 'client', 'panel', 'package.json'), {
    name: '@matrix1001/dsh-application-harness-client-panel',
    dependencies: packageDeps,
    peerDependencies: { '@matrix1001/dsh-application-harness-anchor': 'workspace:*' },
  })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - 'packages/*/*'",
    '',
    'minimumReleaseAgeExclude:',
    ...minimumReleaseAgeExclude.map((entry) => `  - '${entry}'`),
    '',
    'overrides:',
    ...overrides.map((entry) => `  "${entry[0]}": ${entry[1]}`),
    '',
  ].join('\n'))
}

/** A checkout fixture: the platform's own workspace declaration plus its packages. */
function checkoutFixture(checkout, { globs, packages, manifests }) {
  mkdirSync(checkout, { recursive: true })
  writeFileSync(join(checkout, 'pnpm-workspace.yaml'), ['packages:', ...globs.map((glob) => `  - '${glob}'`), ''].join('\n'))
  for (const dir of packages) mkdirSync(join(checkout, dir), { recursive: true })
  for (const [dir, name] of manifests) writeJson(join(checkout, dir, 'package.json'), { name })
}

test('a referenced platform package absent from the checkout is reported', () => {
  const verdict = diffSets({
    referenced: ['@deepseek-ai/dsh-ptc-runtime', '@deepseek-ai/dsh-code-runtime'],
    available: ['@deepseek-ai/dsh-ptc-runtime'],
  })
  assert.deepEqual(verdict.missing, ['@deepseek-ai/dsh-code-runtime'])
})

test('non-platform and workspace names are ignored by the caller', () => {
  const verdict = diffSets({ referenced: ['@matrix1001/dsh-application-harness-anchor'], available: [] })
  assert.deepEqual(verdict.missing, [])
})

test('the platform has names we never reference, and non-platform names we do', () => {
  const verdict = diffSets({
    referenced: ['@deepseek-ai/dsh-ptc-runtime', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
    available: ['@deepseek-ai/dsh-ptc-runtime', '@deepseek-ai/dsh-unused', '@deepseek-ai/cordis'],
  })
  assert.deepEqual(verdict.missing, [])
  assert.deepEqual(verdict.unused, ['@deepseek-ai/dsh-unused'])
})

test('the reference plane is the root manifest, every package manifest, and both workspace lists', () => {
  withScratch((root) => {
    repoFixture(root, {
      rootDeps: { '@deepseek-ai/dsh': '0.1.6-alpha.1' },
      packageDeps: { '@deepseek-ai/dsh-ptc-runtime': '0.1.6-alpha.1' },
      overrides: [['@deepseek-ai/dsh-session-projection', '0.1.6-alpha.1'], ['@deepseek-ai/cordis', '4.0.2']],
      minimumReleaseAgeExclude: ['@deepseek-ai/dsh-web-frontend@0.1.6-alpha.1', '@deepseek-ai/dsh@0.1.6-alpha.1'],
    })
    // Raw and unfiltered on purpose: our own workspace name and the cordis /
    // schemastery edges belong to the list `diffSets` is handed.
    assert.deepEqual(referencedNames(root), [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-ptc-runtime',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-web-frontend',
      '@matrix1001/dsh-application-harness-anchor',
    ])
    const sites = referenceSites(root)
    assert.deepEqual(sites.get('@deepseek-ai/dsh'), ['package.json', 'pnpm-workspace.yaml (minimumReleaseAgeExclude)'])
    assert.deepEqual(sites.get('@deepseek-ai/dsh-ptc-runtime'), ['packages/client/panel/package.json'])
    assert.deepEqual(sites.get('@deepseek-ai/dsh-session-projection'), ['pnpm-workspace.yaml (overrides)'])
    assert.deepEqual(sites.get('@deepseek-ai/dsh-web-frontend'), ['pnpm-workspace.yaml (minimumReleaseAgeExclude)'])
  })
})

test('the available plane follows the checkout\'s own workspace globs', () => {
  withScratch((checkout) => {
    checkoutFixture(checkout, {
      globs: ['vendor/*', 'packages/*/*', 'apps/*', 'benchmarks'],
      packages: [
        'vendor/cordis',
        'packages/application/anchor',
        'packages/client/ui-layout',
        'packages/client/not-a-package',
        'apps/cli',
        'apps/web',
        'benchmarks',
      ],
      manifests: [
        ['vendor/cordis', '@deepseek-ai/cordis'],
        ['packages/application/anchor', '@deepseek-ai/dsh-anchor'],
        ['packages/client/ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
        ['apps/cli', '@deepseek-ai/dsh'],
      ],
    })
    assert.deepEqual(platformNamesFromCheckout(checkout), [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-anchor',
      '@deepseek-ai/dsh-client-ui-layout',
    ])
  })
})

test('a checkout with no workspace declaration is read from the package tier alone', () => {
  withScratch((checkout) => {
    writeJson(join(checkout, 'packages', 'application', 'anchor', 'package.json'), { name: '@deepseek-ai/dsh-anchor' })
    assert.deepEqual(platformNamesFromCheckout(checkout), ['@deepseek-ai/dsh-anchor'])
  })
})

test('a workspace declaration the resolver cannot expand is an error, not a smaller package set', () => {
  withScratch((checkout) => {
    for (const glob of ['packages/**', '!packages/vendor']) {
      writeFileSync(join(checkout, 'pnpm-workspace.yaml'), `packages:\n  - '${glob}'\n`)
      assert.throws(() => platformNamesFromCheckout(checkout), /update the resolver/)
    }
    writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'overrides:\n  "@deepseek-ai/cordis": 4.0.2\n')
    assert.throws(() => platformNamesFromCheckout(checkout), /declares no packages: list/)
  })
})

test('no checkout is UNVERIFIED at exit 0, never a silent pass', () => {
  withScratch((root) => {
    repoFixture(root, { rootDeps: { '@deepseek-ai/dsh-ptc-runtime': '0.1.6-alpha.1' } })
    const lines = []
    const errors = []
    const code = verify({ root, checkout: undefined, log: (line) => lines.push(line), error: (line) => errors.push(line) })
    assert.equal(code, 0)
    assert.deepEqual(errors, [])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /UNVERIFIED — no platform checkout/)
    assert.match(lines[0], /1 referenced platform name\(s\)/)
  })
})

test('a reference plane the checkout covers is OK, with both counts in the line', () => {
  withScratch((scratch) => {
    const root = join(scratch, 'repo')
    const checkout = join(scratch, 'checkout')
    repoFixture(root, {
      rootDeps: { '@deepseek-ai/dsh': '0.1.6-alpha.1' },
      packageDeps: { '@deepseek-ai/dsh-ptc-runtime': '0.1.6-alpha.1' },
      minimumReleaseAgeExclude: ['@deepseek-ai/dsh-typert-protocol@0.1.6-alpha.1'],
    })
    checkoutFixture(checkout, {
      globs: ['packages/*/*', 'apps/*'],
      packages: ['packages/application/anchor', 'packages/typert/protocol', 'packages/application/unused', 'apps/cli'],
      manifests: [
        ['packages/application/anchor', '@deepseek-ai/dsh-ptc-runtime'],
        ['packages/typert/protocol', '@deepseek-ai/dsh-typert-protocol'],
        ['packages/application/unused', '@deepseek-ai/dsh-never-referenced'],
        ['apps/cli', '@deepseek-ai/dsh'],
      ],
    })
    const lines = []
    const errors = []
    const code = verify({ root, checkout, log: (line) => lines.push(line), error: (line) => errors.push(line) })
    assert.equal(code, 0)
    assert.deepEqual(errors, [])
    assert.match(lines[0], /OK — 3 referenced platform names all exist \(4 available on the line, 1 unreferenced\)/)
  })
})

test('a referenced name the checkout does not hold fails and names both the package and its site', () => {
  withScratch((scratch) => {
    const root = join(scratch, 'repo')
    const checkout = join(scratch, 'checkout')
    repoFixture(root, {
      rootDeps: { '@deepseek-ai/dsh-ptc-runtime': '0.1.6-alpha.1' },
      minimumReleaseAgeExclude: ['@deepseek-ai/dsh-web-frontend@0.1.6-alpha.1'],
    })
    checkoutFixture(checkout, {
      globs: ['packages/*/*', 'apps/*'],
      packages: ['packages/application/anchor', 'apps/cli'],
      manifests: [['packages/application/anchor', '@deepseek-ai/dsh-ptc-runtime'], ['apps/cli', '@deepseek-ai/dsh']],
    })
    const lines = []
    const errors = []
    const code = verify({ root, checkout, log: (line) => lines.push(line), error: (line) => errors.push(line) })
    assert.equal(code, 1)
    assert.deepEqual(lines, [])
    assert.match(errors[0], /FAIL — 1 referenced platform name\(s\) do not exist on the platform line/)
    assert.match(errors[1], /^ {2}- @deepseek-ai\/dsh-web-frontend — referenced by pnpm-workspace\.yaml \(minimumReleaseAgeExclude\)$/)
  })
})

test('a checkout whose package set cannot be read is a FAIL, never a pass', () => {
  withScratch((scratch) => {
    const root = join(scratch, 'repo')
    const checkout = join(scratch, 'checkout')
    repoFixture(root, { rootDeps: { '@deepseek-ai/dsh': '0.1.6-alpha.1' } })
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages: [\n')
    const errors = []
    const code = verify({ root, checkout, log: () => {}, error: (line) => errors.push(line) })
    assert.equal(code, 1)
    assert.match(errors[0], /FAIL — the checkout's package set could not be read/)
  })
})
