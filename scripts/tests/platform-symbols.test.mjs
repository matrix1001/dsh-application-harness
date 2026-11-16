/**
 * `check-platform-symbols` exists because the client-side platform atom
 * surface — the icon set and locale keys of
 * `@deepseek-ai/dsh-client-ui-primitives`, the slot faces of
 * `@deepseek-ai/dsh-client-ui-slots` — carries no compatibility promise, and
 * our build cannot tell us: it resolves the *pinned* copy under `node_modules`,
 * so a green `tsc` proves the pinned line, never the checkout we launch. The
 * 0.1.6 line renamed `IconSendOutline16` → `IconPaperPlaneOutline14` and
 * dropped two locale keys; we missed both by luck, not by machinery.
 *
 * What the suites below pin, in order of importance:
 *
 * - **Fail-open is the first principle.** A `export * from` re-export we cannot
 *   follow means the package's export set is unknown, and an unknown set never
 *   reports a symbol missing; so do imports whose shape we cannot read (default
 *   and namespace bindings carry no platform symbol name), and so does anything
 *   we cannot resolve to a file. A false MISSING costs more than a miss — it is
 *   how a check gets skimmed past and then deleted.
 * - **A resolvable `export *` is followed**, because the headline case — the
 *   icon set — sits behind one (`src/index.ts` re-exports `./icons/index.tsx`,
 *   but not all clients can see through it). A star we *can* resolve is not an
 *   unknown set.
 * - **Extraction covers what our sources actually write**: `type`-prefixed
 *   members, `as` aliases (the symbol name is the original, not the local
 *   binding), `import type { … }`, multi-line braces.
 * - **Skips are counted and printed.** A green line that quietly checked
 *   nothing is the failure mode of every "verify" script ever written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  clientPlatformImports, exportedNames, importedSymbols, missingSymbols, packageSymbols,
  platformPackageDirs, verify,
} from '../check-platform-symbols.mjs'

/** A throwaway fixture directory, removed even when the body throws. */
function withScratch(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-platform-symbols-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Write a fixture file, creating its directory. */
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

test('named imports are extracted with their specifier', () => {
  const found = importedSymbols("import { Button, type Pill } from '@deepseek-ai/dsh-client-ui-primitives'\n", PRIMITIVES)
  assert.deepEqual([...found].sort(), ['Button', 'Pill'])
})

test('a renamed export is caught; a star re-export fails open', () => {
  const exports = exportedNames(["export { IconPaperPlaneOutline14 } from './icons'\n"])
  assert.deepEqual(missingSymbols({ imports: [{ symbol: 'IconPaperPlaneOutline14' }], exports }), [])
  assert.deepEqual(missingSymbols({ imports: [{ symbol: 'IconSendOutline16' }], exports }), ['IconSendOutline16'])
  const star = exportedNames(["export * from './icons'\n"])
  assert.deepEqual(missingSymbols({ imports: [{ symbol: 'Anything' }], exports: star }), [])
})

test('import extraction covers aliases, type-only statements and multi-line braces', () => {
  const text = [
    "import { Button as B, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'",
    "import type { ComposedProps, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'",
    'import {',
    '  Pill,',
    '  type TagTone,',
    "} from '@deepseek-ai/dsh-client-ui-primitives'",
    "// import { Commented } from '@deepseek-ai/dsh-client-ui-primitives'",
    "/* import { Blocked } from '@deepseek-ai/dsh-client-ui-primitives' */",
    'const untouched = "import { Ghost } from \'@deepseek-ai/dsh-client-ui-primitives\'"',
    '',
  ].join('\n')
  // The alias contributes its ORIGINAL name; neither a quoted import nor a
  // commented one is a platform dependency (a phantom would check a symbol
  // nobody imports).
  assert.deepEqual([...importedSymbols(text, PRIMITIVES)].sort(), ['Button', 'IconCloseOutline16', 'Pill', 'TagTone'].sort())
  assert.deepEqual([...importedSymbols(text, '@deepseek-ai/dsh-client-ui-slots')].sort(), ['ComposedProps', 'TranslateNS'])
})

test('an alias keeps the original name, and other import shapes contribute nothing', () => {
  const text = [
    "import { Button as B, Switch as S } from '@deepseek-ai/dsh-client-ui-primitives'",
    "import Primitives from '@deepseek-ai/dsh-client-ui-primitives'",
    "import * as everything from '@deepseek-ai/dsh-client-ui-primitives'",
    "import '@deepseek-ai/dsh-client-ui-primitives'",
    '',
  ].join('\n')
  assert.deepEqual([...importedSymbols(text, PRIMITIVES)].sort(), ['Button', 'Switch'])
})

test('export shapes: declarations, named lists, aliases, type lists and namespace stars', () => {
  const exports = exportedNames([
    'export const Button = 1\n',
    'export declare function useAnchoredPosition(): void\n',
    'export async function inspectApiSession(): Promise<void> {}\n',
    'export abstract class Surface {}\n',
    'export class Menu {}\n',
    'export interface PropsRenderSlots {}\n',
    'export type TranslateNS = (key: string) => string\n',
    'export enum Kind { A }\n',
    'export { Pill, Tag as TagChip }\n',
    'export type { StateDotState }\n',
    "export { Modal } from './Modal.tsx'\n",
    "export * as icons from './icons/index.tsx'\n",
  ])
  assert.equal(exports.open, false)
  for (const name of ['Button', 'useAnchoredPosition', 'inspectApiSession', 'Surface', 'Menu', 'PropsRenderSlots', 'TranslateNS', 'Kind', 'Pill', 'TagChip', 'StateDotState', 'Modal', 'icons']) {
    assert.ok(exports.names.includes(name), `${name} should be collected`)
  }
  // The alias's *exported* name is the one an importer writes.
  assert.ok(!exports.names.includes('Tag'), 'the pre-alias name is not an export')
})

test('a resolvable star is followed instead of opening the set', () => {
  const texts = [
    { path: 'index.ts', text: "export * from './icons/index.tsx'\n" },
    { path: 'icons/index.tsx', text: 'export const IconPaperPlaneOutline14 = 1\n' },
  ]
  const resolveStar = (specifier, from) => {
    if (specifier !== './icons/index.tsx' || from !== 'index.ts') return undefined
    return [texts[1]]
  }
  const exports = exportedNames(texts, { resolveStar })
  assert.equal(exports.open, false)
  assert.deepEqual(missingSymbols({ imports: [{ symbol: 'IconPaperPlaneOutline14' }], exports }), [])
  assert.deepEqual(missingSymbols({ imports: [{ symbol: 'IconSendOutline16' }], exports }), ['IconSendOutline16'])
})

test('a star that resolves to nothing new is not an unknown set; an unresolvable one is', () => {
  const cyclic = exportedNames(['export * from "./a.ts"\n'], { resolveStar: () => [] })
  assert.equal(cyclic.open, false)
  const bare = exportedNames(['export * from "@deepseek-ai/dsh-client-ui-slots"\n'], { resolveStar: () => undefined })
  assert.equal(bare.open, true)
})

test('missingSymbols returns each missing name once, in first-seen order', () => {
  const exports = exportedNames(['export const Button = 1\n'])
  const missing = missingSymbols({
    imports: [{ symbol: 'Ghost' }, { symbol: 'Button' }, { symbol: 'Ghost' }],
    exports,
  })
  assert.deepEqual(missing, ['Ghost'])
})

test('clientPlatformImports walks our client sources and keeps sites', () => {
  withScratch((root) => {
    write(join(root, 'packages', 'client', 'panel', 'src', 'client', 'index.ts'), [
      '// a header comment',
      "import { Button, Ghost } from '@deepseek-ai/dsh-client-ui-primitives'",
      "import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'",
      "import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'",
      "import { ApplicationModel } from './application-model.ts'",
      "import { Application } from '@matrix1001/dsh-application-harness-anchor'",
      '',
    ].join('\n'))
    write(join(root, 'packages', 'client', 'panel', 'src', 'client', 'ApplicationPanel.tsx'), [
      "import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'",
      '',
    ].join('\n'))
    const imports = clientPlatformImports(root)
    assert.deepEqual(imports.map((site) => `${site.specifier}:${site.symbols.join(',')}`).sort(), [
      `${PRIMITIVES}:Button,Ghost`,
      `${PRIMITIVES}:Pill`,
      '@deepseek-ai/dsh-client-ui-renderer/client:',
      '@deepseek-ai/dsh-client-ui-slots:ComposedProps',
    ])
    const ghost = imports.find((site) => site.symbols.includes('Ghost'))
    assert.equal(ghost.file, 'packages/client/panel/src/client/index.ts')
    assert.equal(ghost.line, 2)
  })
})

test('platformPackageDirs maps a checkout package name to its directory', () => {
  withScratch((checkout) => {
    write(join(checkout, 'packages', 'client', 'ui-primitives', 'package.json'), JSON.stringify({ name: PRIMITIVES }))
    // The directory name is not the package name: `dsh-client-locale` lives in `client/locale`.
    write(join(checkout, 'packages', 'client', 'locale', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-locale' }))
    const dirs = platformPackageDirs(checkout)
    assert.equal(dirs.get(PRIMITIVES), join(checkout, 'packages', 'client', 'ui-primitives'))
    assert.equal(dirs.get('@deepseek-ai/dsh-client-locale'), join(checkout, 'packages', 'client', 'locale'))
  })
})

/** A checkout package: a manifest plus a `src` tree of the given files. */
function packageFixture(checkout, dir, name, sourceFiles) {
  write(join(checkout, dir, 'package.json'), JSON.stringify({ name }))
  for (const [relative, text] of Object.entries(sourceFiles)) write(join(checkout, dir, 'src', relative), text)
}

/** The repo fixture: one client package importing two platform symbols. */
function repoFixture(root, source) {
  write(join(root, 'packages', 'client', 'panel', 'src', 'client', 'index.ts'), source)
}

test('packageSymbols follows a relative star inside the package source tree', () => {
  withScratch((checkout) => {
    packageFixture(checkout, 'packages/client/ui-primitives', PRIMITIVES, {
      'index.ts': "export * from './icons/index.tsx'\nexport const Button = 1\n",
      'icons/index.tsx': 'export const IconPaperPlaneOutline14 = 1\n',
    })
    const symbols = packageSymbols({ dirs: platformPackageDirs(checkout), name: PRIMITIVES })
    assert.equal(symbols.open, false)
    assert.ok(symbols.names.includes('IconPaperPlaneOutline14'))
    assert.ok(symbols.names.includes('Button'))
  })
})

test('packageSymbols returns undefined for a package with no src tree to read', () => {
  withScratch((checkout) => {
    write(join(checkout, 'packages', 'client', 'generated', 'package.json'), JSON.stringify({ name: PRIMITIVES }))
    assert.equal(packageSymbols({ dirs: platformPackageDirs(checkout), name: PRIMITIVES }), undefined)
    assert.equal(packageSymbols({ dirs: platformPackageDirs(checkout), name: '@deepseek-ai/dsh-not-here' }), undefined)
  })
})

test('verify reports a missing symbol with its import site and exits 1', () => {
  withScratch((scratch) => {
    const root = join(scratch, 'repo')
    const checkout = join(scratch, 'checkout')
    repoFixture(root, "import { Button, Ghost } from '@deepseek-ai/dsh-client-ui-primitives'\n")
    packageFixture(checkout, 'packages/client/ui-primitives', PRIMITIVES, { 'index.ts': 'export const Button = 1\n' })
    const lines = []
    const code = verify({ root, checkout, log: (line) => lines.push(line), error: (line) => lines.push(line) })
    assert.equal(code, 1)
    const output = lines.join('\n')
    assert.match(output, /MISSING @deepseek-ai\/dsh-client-ui-primitives: Ghost \(imported by packages\/client\/panel\/src\/client\/index\.ts:1\)/u)
    assert.match(output, /1 specifier\(s\) \/ 2 symbol\(s\) checked/u)
    assert.match(output, /check-platform-symbols: FAIL — 1 missing symbol\(s\)/u)
  })
})

test('verify is fail-open: an unreadable package and an open set both stay green, and are counted', () => {
  withScratch((scratch) => {
    const root = join(scratch, 'repo')
    const checkout = join(scratch, 'checkout')
    repoFixture(root, [
      "import { Ghost } from '@deepseek-ai/dsh-client-ui-primitives'",
      "import { Vanished } from '@deepseek-ai/dsh-client-ui-slots'",
      "import { Elsewhere } from '@deepseek-ai/dsh-client-ui-layout/client'",
      '',
    ].join('\n'))
    packageFixture(checkout, 'packages/client/ui-primitives', PRIMITIVES, { 'index.ts': 'export const Ghost = 1\n' })
    // ui-slots exports through a bare specifier we cannot follow → open.
    packageFixture(checkout, 'packages/client/ui-slots', '@deepseek-ai/dsh-client-ui-slots', {
      'index.ts': "export * from '@deepseek-ai/elsewhere'\n",
    })
    // ui-layout is simply not on this checkout → unreadable, not missing.
    const lines = []
    const code = verify({ root, checkout, log: (line) => lines.push(line), error: (line) => lines.push(line) })
    assert.equal(code, 0)
    const output = lines.join('\n')
    assert.match(output, /check-platform-symbols: OK/u)
    assert.match(output, /0 missing symbol\(s\)/u)
    assert.match(output, /SKIP @deepseek-ai\/dsh-client-ui-slots: open \(export \* not followed\)/u)
    // The skip line names the full specifier — a subpath is part of what was skipped.
    assert.match(output, /SKIP @deepseek-ai\/dsh-client-ui-layout\/client: not found on the line/u)
    // Both counters: a skipped specifier with no symbols of its own must still
    // be visible in the green line, or "OK" hides how little was checked.
    assert.match(output, /skipped 2 symbol\(s\) in 2 specifier\(s\)/u)
  })
})

test('verify without a checkout is UNVERIFIED and exits 0', () => {
  withScratch((scratch) => {
    const root = join(scratch, 'repo')
    repoFixture(root, "import { Button } from '@deepseek-ai/dsh-client-ui-primitives'\n")
    const lines = []
    assert.equal(verify({ root, checkout: undefined, log: (line) => lines.push(line), error: (line) => lines.push(line) }), 0)
    assert.match(lines.join('\n'), /UNVERIFIED — no platform checkout/u)
  })
})

test('a bare string is read as one text, never as a character walk', () => {
  const exports = exportedNames('export const Button = 1\n')
  assert.deepEqual(exports, { open: false, names: ['Button'] })
})

test('verify reports the run as JSON when asked', () => {
  withScratch((scratch) => {
    const root = join(scratch, 'repo')
    const checkout = join(scratch, 'checkout')
    repoFixture(root, "import { Ghost } from '@deepseek-ai/dsh-client-ui-primitives'\n")
    packageFixture(checkout, 'packages/client/ui-primitives', PRIMITIVES, { 'index.ts': 'export const Button = 1\n' })
    const lines = []
    const code = verify({ root, checkout, json: true, log: (line) => lines.push(line), error: (line) => lines.push(line) })
    assert.equal(code, 1)
    const report = JSON.parse(lines.join('\n'))
    assert.deepEqual(report.missing, [
      { specifier: PRIMITIVES, symbol: 'Ghost', file: 'packages/client/panel/src/client/index.ts', line: 1 },
    ])
    assert.equal(report.checkout, checkout)
    assert.equal(report.status, 'fail')
    assert.equal(report.symbols, 1)
    assert.deepEqual(report.skipped, [])
  })
})
