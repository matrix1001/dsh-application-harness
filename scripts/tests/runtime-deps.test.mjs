/**
 * Script-plane tests for the runtime-dependency gate (AR2″a,
 * `runtime-deps-skips-workspace-and-lib-types`).
 *
 * The gate used to skip two faces by construction — every `@deepseek-ai/*`
 * specifier, and the declaration half of `lib/` — with no output saying so,
 * which reads exactly like a pass. These tests pin the coverage that replaced
 * it, and each new face gets a NEGATIVE case: a fixture with a real violation
 * of that face must trip the checker, so "the face is covered" is proven by
 * something that can fail rather than by a print statement.
 *
 * Every fixture is a temp tree. `pnpm run test:scripts` runs before the build in
 * CI, so a test that reached for this repo's `lib/` would depend on a build
 * product that is not there.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bareImports, checkPackage, packageNameOf, packagesToScan, verify } from '../verify-runtime-deps.mjs'

/** Run `body` with a fresh temp workspace, removed afterwards. */
function withWorkspace(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-deps-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Write `<root>/<rel>` with the given text, creating parents. */
function write(root, rel, text) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/**
 * One fixture package: a manifest plus whatever lib files the case needs.
 * `exports` mirrors the real shape (a Node entry, optionally a browser bundle
 * and typed subpaths) so the gate's own reading of the manifest is exercised.
 */
function fixturePackage(root, { group = 'application', name = '@matrix1001/dsh-application-harness-x', manifest = {}, files = {} } = {}) {
  const dir = join(root, 'packages', group, 'pkg')
  write(root, `packages/${group}/pkg/package.json`, JSON.stringify({
    name,
    exports: {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './client': { default: './lib/client.js' },
    },
    ...manifest,
  }))
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text)
  write(dir, 'lib/index.js', files['lib/index.js'] ?? "export const name = 'x'\n")
  write(dir, 'lib/client.js', files['lib/client.js'] ?? 'export const client = 1\n')
  return dir
}

test('packageNameOf reads a scoped name, a subpath and a plain name', () => {
  assert.equal(packageNameOf('@matrix1001/dsh-application-harness-anchor/atomic'), '@matrix1001/dsh-application-harness-anchor')
  assert.equal(packageNameOf('@deepseek-ai/dsh-client-ui-primitives'), '@deepseek-ai/dsh-client-ui-primitives')
  assert.equal(packageNameOf('react/jsx-runtime'), 'react')
  assert.equal(packageNameOf('left-pad'), 'left-pad')
})

test('bareImports keeps @deepseek-ai specifiers in the set (nothing is filtered per-face here)', () => {
  const found = bareImports("import a from 'left-pad'\nimport b from '@matrix1001/dsh-application-harness-anchor/atomic'\nimport c from './rel.js'\nimport d from 'node:fs'\n")
  assert.deepEqual([...found].sort(), ['@matrix1001/dsh-application-harness-anchor/atomic', 'left-pad'])
})

test('an undeclared third-party runtime import still trips the gate', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, { files: { 'lib/index.js': "import leftPad from 'left-pad'\n" } })
    assert.deepEqual(checkPackage(dir).problems, [
      'lib/index.js: imports undeclared "left-pad" (declare "left-pad" in dependencies/peerDependencies/optionalDependencies — devDependencies are not installed for a consumer)',
    ])
  })
})

test('the @deepseek-ai/* face trips on an undeclared package name', () => {
  // The face the item names: it used to be skipped wholesale, so a workspace
  // package that was never declared resolved by luck and failed in no gate.
  withWorkspace((root) => {
    const dir = fixturePackage(root, {
      manifest: { dependencies: { '@matrix1001/dsh-application-harness-declared': 'workspace:*' } },
      files: {
        'lib/index.js': "import a from '@matrix1001/dsh-application-harness-declared/atomic'\nimport b from '@matrix1001/dsh-application-harness-undeclared'\n",
      },
    })
    assert.deepEqual(checkPackage(dir).problems, [
      'lib/index.js: imports undeclared "@matrix1001/dsh-application-harness-undeclared" (declare "@matrix1001/dsh-application-harness-undeclared" in dependencies/peerDependencies/optionalDependencies — devDependencies are not installed for a consumer)',
    ])
  })
})

test('a platform seed is answered by the loader module table on the runtime face', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, { files: { 'lib/index.js': "import { jsx } from 'react/jsx-runtime'\n" } })
    const { problems, scanned } = checkPackage(dir)
    assert.deepEqual(problems, [])
    assert.equal(scanned.seedExemptions, 1)
  })
})

test('devDependencies do not answer a runtime import', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, {
      manifest: { devDependencies: { 'left-pad': '^1.0.0' } },
      files: { 'lib/index.js': "import leftPad from 'left-pad'\n" },
    })
    assert.equal(checkPackage(dir).problems.length, 1)
  })
})

test('the declaration face trips on an undeclared package', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, { files: { 'lib/types/index.d.ts': "import type { Config } from 'undeclared-types';\n" } })
    assert.deepEqual(checkPackage(dir).problems, [
      'lib/types/index.d.ts: declaration imports undeclared "undeclared-types" (declare "undeclared-types" in any dependency section — a consumer typechecking against this surface cannot resolve it)',
    ])
  })
})

test('devDependencies DO answer a declaration import, and seeds do not', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, {
      manifest: { devDependencies: { 'react': '^18.2.0' } },
      files: { 'lib/types/index.d.ts': "import type { ReactNode } from 'react';\nimport type { Config } from 'react-dom';\n" },
    })
    // react is declared and therefore fine; react-dom is NOT declared and is a
    // seed — the module table answers it at runtime, not a consumer's typechecker.
    assert.deepEqual(checkPackage(dir).problems, [
      'lib/types/index.d.ts: declaration imports undeclared "react-dom" (declare "react-dom" in any dependency section — a consumer typechecking against this surface cannot resolve it)',
    ])
  })
})

test('a relative chunk the entry loads is judged, and the browser bundle is not', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, {
      files: {
        'lib/index.js': "export { a } from './types-CHUNK.js'\n",
        'lib/types-CHUNK.js': "import leftPad from 'left-pad'\n",
        'lib/client.js': "import anything from 'whatever-the-module-table-answers'\n",
      },
    })
    const { problems, scanned } = checkPackage(dir)
    // The chunk ships beside the entry and carries its own imports; the browser
    // bundle's specifiers belong to the loader module table (verify-client-factory).
    assert.deepEqual(problems, [
      'lib/types-CHUNK.js: imports undeclared "left-pad" (declare "left-pad" in dependencies/peerDependencies/optionalDependencies — devDependencies are not installed for a consumer)',
    ])
    assert.equal(scanned.bundles, 1)
  })
})

test('the compiler intermediates under lib/types are not judged, and are counted', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, { files: { 'lib/types/index.js': "import leftPad from 'left-pad'\n" } })
    const { problems, scanned } = checkPackage(dir)
    // tsdown bundles lib/types/*.js INTO the shipped entries: the bundler
    // resolves those specifiers, node never does.
    assert.deepEqual(problems, [])
    assert.equal(scanned.intermediates, 1)
  })
})

test('a declaration no exports subpath exposes is not judged, and is counted', () => {
  withWorkspace((root) => {
    const dir = fixturePackage(root, { files: { 'lib/types/leftover.d.ts': "import type { Gone } from 'deleted-source-leftover';\n" } })
    const { problems, scanned } = checkPackage(dir)
    assert.deepEqual(problems, [])
    assert.equal(scanned.strayDeclarations, 1)
  })
})

test('a package with no build output is counted, not passed over in silence', () => {
  withWorkspace((root) => {
    const dir = join(root, 'packages', 'application', 'empty')
    write(root, 'packages/application/empty/package.json', JSON.stringify({ name: '@matrix1001/dsh-application-harness-empty' }))
    const { problems, scanned } = checkPackage(dir)
    assert.deepEqual(problems, [])
    assert.equal(scanned.unbuilt, true)
  })
})

test('the run prints every face it did not judge', () => {
  withWorkspace((root) => {
    write(root, 'packages/typert/protocol/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol' }))
    write(root, 'packages/application/model/package.json', JSON.stringify({
      name: '@matrix1001/dsh-application-harness-model',
      exports: { '.': { default: './lib/index.js' } },
    }))
    write(root, 'packages/application/model/lib/index.js', 'export const name = 1\n')
    const lines = []
    assert.equal(verify({ root, log: (line) => lines.push(line), error: () => {} }), 0)
    const printed = lines.join('\n')
    assert.match(printed, /packages\/typert\/protocol outside the scan/u)
    assert.match(printed, /platform seed/u)
    assert.match(printed, /browser bundle\(s\) skipped/u)
    assert.match(printed, /compiler-intermediate/u)
    assert.match(printed, /no exports subpath exposes/u)
    assert.match(printed, /1 packages OK/u)
    assert.deepEqual(packagesToScan(root), [join(root, 'packages', 'application', 'model')])
  })
})

test('a violation reaches the exit code, not just the log', () => {
  withWorkspace((root) => {
    fixturePackage(root, { name: '@matrix1001/dsh-application-harness-x', files: { 'lib/index.js': "import leftPad from 'left-pad'\n" } })
    const errors = []
    assert.equal(verify({ root, log: () => {}, error: (line) => errors.push(line) }), 1)
    assert.match(errors.join('\n'), /1 package\(s\) with undeclared imports/u)
  })
})
