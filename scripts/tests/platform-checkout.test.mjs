/**
 * Checkout-line resolution is a correctness seam, not a convenience: it
 * decides whether our emitted Typert faces and our verification runs take the
 * runtime the user actually launches (the checkout) or the published line. The
 * two assertions that matter are that a built checkout always wins, and that a
 * checkout which exists but was never built fails loudly instead of silently
 * falling back to the published line — that silent fallback is the exact
 * failure the checkout-first rule exists to prevent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  checkoutRoot, loadTypertGenerator, loadTypertPlugin, resolveDshBin, resolveTypertGenerator,
  resolveTypertGeneratorApi, unbuiltCheckoutMessage,
} from '../platform-checkout.mjs'

const CHECKOUT = join('/tmp', 'dsh-checkout-probe')
const GENERATOR_DIR = join(CHECKOUT, 'packages', 'typert', 'generator')
const ENTRY = join(GENERATOR_DIR, 'lib', 'types', 'tsdown-plugin.js')
const API_ENTRY = join(GENERATOR_DIR, 'lib', 'index.js')
const MANIFEST = join(GENERATOR_DIR, 'package.json')
const REPO = join('/tmp', 'dsh-repo-probe')
const PUBLISHED_BIN = join(REPO, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const CLI_DIR = join(CHECKOUT, 'apps', 'cli')
const CLI_BIN = join(CLI_DIR, 'lib', 'bin.js')
const EXPORTS = JSON.stringify({
  exports: { './tsdown': { types: './lib/types/tsdown-plugin.d.ts', default: './lib/types/tsdown-plugin.js' } },
})

/** A filesystem probe over a fixed set of existing paths and file contents. */
function probe(paths, files = {}) {
  const present = new Set(paths)
  return {
    exists: (path) => present.has(path),
    readFile: (path) => {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
  }
}

test('the checkout root is $DSH_HARNESS_REPO, or ~/deepseek-harness when unset or empty', () => {
  assert.equal(checkoutRoot({ DSH_HARNESS_REPO: '/srv/checkout' }), '/srv/checkout')
  assert.equal(checkoutRoot({}), join(homedir(), 'deepseek-harness'))
  assert.equal(checkoutRoot({ DSH_HARNESS_REPO: '' }), join(homedir(), 'deepseek-harness'))
})

test('a built checkout supplies the generator, addressed by its own ./tsdown export', () => {
  const resolved = resolveTypertGenerator({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([GENERATOR_DIR, MANIFEST, ENTRY], { [MANIFEST]: EXPORTS }),
  })
  assert.equal(resolved.source, 'checkout')
  assert.equal(resolved.entry, ENTRY)
})

test('a string-form ./tsdown export resolves the same way', () => {
  const resolved = resolveTypertGenerator({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([GENERATOR_DIR, MANIFEST, ENTRY], { [MANIFEST]: JSON.stringify({ exports: { './tsdown': './lib/types/tsdown-plugin.js' } }) }),
  })
  assert.equal(resolved.source, 'checkout')
  assert.equal(resolved.entry, ENTRY)
})

test('no checkout at all falls back to the published generator', () => {
  const resolved = resolveTypertGenerator({ env: { DSH_HARNESS_REPO: CHECKOUT }, ...probe([]) })
  assert.equal(resolved.source, 'npm')
  assert.equal(resolved.entry, undefined)
})

test('a checkout without a built generator is an error source, not a fallback', () => {
  const unbuilt = resolveTypertGenerator({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([GENERATOR_DIR, MANIFEST], { [MANIFEST]: EXPORTS }),
  })
  assert.equal(unbuilt.source, 'unbuilt-checkout')
  assert.equal(unbuilt.entry, ENTRY)

  const noExport = resolveTypertGenerator({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([GENERATOR_DIR, MANIFEST], { [MANIFEST]: JSON.stringify({ exports: {} }) }),
  })
  assert.equal(noExport.source, 'unbuilt-checkout')

  const unreadable = resolveTypertGenerator({ env: { DSH_HARNESS_REPO: CHECKOUT }, ...probe([GENERATOR_DIR, MANIFEST]) })
  assert.equal(unreadable.source, 'unbuilt-checkout')
})

test('the bundle-free API resolves the checkout root entry, or the published package', async () => {
  const built = resolveTypertGeneratorApi({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([GENERATOR_DIR, API_ENTRY]),
  })
  assert.equal(built.source, 'checkout')
  assert.equal(built.entry, API_ENTRY)

  const imports = []
  const lines = []
  const loaded = await loadTypertGenerator({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([GENERATOR_DIR, API_ENTRY]),
    importer: (specifier) => {
      imports.push(specifier)
      return Promise.resolve({ findWorkspaceRoot: () => CHECKOUT })
    },
  })
  assert.deepEqual(imports, [pathToFileURL(API_ENTRY).href])
  assert.equal(loaded.findWorkspaceRoot(), CHECKOUT)
  assert.deepEqual(lines, [])

  const publishedImports = []
  const publishedLines = []
  await loadTypertGenerator({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([]),
    importer: (specifier) => {
      publishedImports.push(specifier)
      return Promise.resolve({})
    },
    log: (line) => publishedLines.push(line),
  })
  assert.deepEqual(publishedImports, ['@deepseek-ai/dsh-typert-generator'])
  assert.equal(publishedLines.length, 1)
  assert.match(publishedLines[0], /published generator.*artifact shape/)
})

test('the bundle-free API refuses an unbuilt checkout instead of falling back', async () => {
  assert.equal(
    resolveTypertGeneratorApi({ env: { DSH_HARNESS_REPO: CHECKOUT }, ...probe([GENERATOR_DIR]) }).source,
    'unbuilt-checkout',
  )
  await assert.rejects(
    loadTypertGenerator({
      env: { DSH_HARNESS_REPO: CHECKOUT },
      ...probe([GENERATOR_DIR]),
      importer: () => Promise.resolve({}),
    }),
    /is not built \(expected .*lib\/index\.js\) .*run `pnpm run build` in the checkout/,
  )
})

test('loading a built checkout imports its entry by file URL', async () => {
  const imports = []
  const generator = { typertPlugin: () => 'checkout-plugin' }
  const plugin = await loadTypertPlugin({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([GENERATOR_DIR, MANIFEST, ENTRY], { [MANIFEST]: EXPORTS }),
    importer: (specifier) => {
      imports.push(specifier)
      return Promise.resolve(generator)
    },
  })
  assert.deepEqual(imports, [pathToFileURL(ENTRY).href])
  assert.equal(plugin(), 'checkout-plugin')
})

test('loading without a checkout imports the published package and says so', async () => {
  const imports = []
  const lines = []
  const plugin = await loadTypertPlugin({
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([]),
    importer: (specifier) => {
      imports.push(specifier)
      return Promise.resolve({ typertPlugin: () => 'published-plugin' })
    },
    log: (line) => lines.push(line),
  })
  assert.deepEqual(imports, ['@deepseek-ai/dsh-typert-generator/tsdown'])
  assert.equal(plugin(), 'published-plugin')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /no platform checkout at .*dsh-checkout-probe.*published generator/)
})

test('loading an unbuilt checkout throws with the remedy and never imports', async () => {
  const imports = []
  await assert.rejects(
    loadTypertPlugin({
      env: { DSH_HARNESS_REPO: CHECKOUT },
      ...probe([GENERATOR_DIR, MANIFEST], { [MANIFEST]: EXPORTS }),
      importer: (specifier) => {
        imports.push(specifier)
        return Promise.resolve({})
      },
    }),
    /is not built \(expected .*tsdown-plugin\.js\) .*run `pnpm run build` in the checkout/,
  )
  assert.deepEqual(imports, [])
})

test('the dsh bin follows the same rule: built checkout first, published install otherwise', () => {
  const built = resolveDshBin({
    repoRoot: REPO,
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([CLI_DIR, CLI_BIN]),
  })
  assert.equal(built.source, 'checkout')
  assert.equal(built.bin, CLI_BIN)

  const published = resolveDshBin({ repoRoot: REPO, env: { DSH_HARNESS_REPO: CHECKOUT }, ...probe([]) })
  assert.equal(published.source, 'npm')
  assert.equal(published.bin, PUBLISHED_BIN)

  const unbuilt = resolveDshBin({
    repoRoot: REPO,
    env: { DSH_HARNESS_REPO: CHECKOUT },
    ...probe([CLI_DIR]),
  })
  assert.equal(unbuilt.source, 'unbuilt-checkout')
  assert.equal(unbuilt.bin, CLI_BIN)
})

test('the unbuilt-checkout remedy names the checkout and the missing artifact', () => {
  const message = unbuiltCheckoutMessage({ checkout: CHECKOUT, bin: CLI_BIN })
  assert.match(message, /dsh-checkout-probe.*not built/)
  assert.match(message, new RegExp(CLI_BIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(message, /run `pnpm run build` in the checkout/)

  const generator = unbuiltCheckoutMessage({ checkout: CHECKOUT, entry: ENTRY })
  assert.match(generator, /tsdown-plugin\.js/)
})
