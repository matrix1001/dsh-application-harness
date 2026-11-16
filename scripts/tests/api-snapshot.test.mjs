/**
 * Script-plane tests for the public-API snapshot gate (AR2″a,
 * `api-snapshot-name-only-and-update`).
 *
 * Two properties are under test. First, the SHAPES a name reaches the surface
 * through: a definition (`export interface X`), a local re-export
 * (`export { X }`), a type-only re-export (`export type { X } from '…'`, which
 * put `type` between `export` and `{` and was invisible), a whole-surface
 * re-export (`export * from '…'`, which the module note claimed as a shape
 * while the surface held none of the names behind it), a cross-package
 * re-export and a re-export of something outside the workspace. Second, the
 * DEPTH of the comparison: a signature-level change must fail the gate even
 * when every name is unchanged, and a comment-only edit must not.
 *
 * The `export *` precedence rules are not read off the spec: each one is a
 * fixture that `tsc` was asked about, and the comment on the case records what
 * it answered.
 *
 * Every fixture is a temp tree: the gate reads the BUILT declarations of the
 * workspace it is pointed at, and `pnpm run test:scripts` runs before the build
 * in CI, so a test that reached for this repo's `lib/` would depend on a build
 * product that is not there.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  UNRESOLVED, apiProblems, collectSurface, collectSurfaces, definedSignatures, exportedSymbols, reExportedFrom,
  staleSurfaces, starReExports, stripComments, surfaceOf, surfaceScope, verify,
} from '../verify-api-snapshot.mjs'

/** Run `body` with a fresh temp workspace, removed afterwards. */
function withWorkspace(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-snapshot-'))
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

/** A package manifest exporting its root types at the conventional path. */
function manifest(name, extra = {}) {
  return JSON.stringify({
    name,
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
    ...extra,
  })
}

/** Collect one declaration file's surface without a workspace index. */
function surfaceOfFile(path) {
  return collectSurface(new Map(), path, new Map())
}

test('exportedSymbols reads every declaration shape an emitted .d.ts uses', () => {
  withWorkspace((root) => {
    const path = write(root, 'types.d.ts', [
      'export interface Defined { a: string }',
      'export declare const value: number;',
      'export type Alias = string',
      'export { Local, renamed as Renamed };',
      "export { Plain } from './plain.ts';",
      "export type { TypeOnly, Other as AliasedType } from './type-only.ts';",
      "export type { LocalTypeOnly };",
      '',
    ].join('\n'))
    assert.deepEqual(exportedSymbols(path), [
      'Alias', 'AliasedType', 'Defined', 'Local', 'LocalTypeOnly', 'Plain', 'Renamed', 'TypeOnly', 'value',
    ])
  })
})

test('a type-only re-export is part of the surface, not outside it', () => {
  // The regression this pins: `export type { X } from '…'` put `type` between
  // `export` and `{`, so the name never entered the set — and the snapshot's
  // "60 export subpaths unchanged" was true of a smaller surface than it named.
  withWorkspace((root) => {
    const path = write(root, 'types.d.ts', "export type { ApplicationProjection, OpenRun } from './coordinator.ts';\n")
    assert.deepEqual(exportedSymbols(path), ['ApplicationProjection', 'OpenRun'])
  })
})

test('a signature is the declaration text, comment-free and collapsed to one line', () => {
  assert.deepEqual([...definedSignatures([
    '/** The run context. */',
    'export interface RunContext {',
    '    reportProgress: (data: string) => void;',
    '}',
    '',
  ].join('\n'))], [['RunContext', 'export interface RunContext { reportProgress: (data: string) => void; }']])
})

test('a braced member does not end a declaration: unions, intersections, arrays and generics are read whole', () => {
  // R32: the rule used to be "the first depth-0 `}` ends the declaration", and
  // in every shape below that brace belongs to a MEMBER, an argument or an
  // index rather than to the declaration. `RecoveryStatus` was filed as
  // `{ readonly status: 'pending'; }` while its declaration states four
  // states, and `Config` lost the second half of its generic argument list.
  assert.deepEqual([...definedSignatures([
    "export type Union = { a: 'x' } | { a: 'y' } | { a: 'z' };",
    'export type Intersection = { a: 1 } & { b: 2 };',
    'export type Arrayed = { a: 1 }[];',
    'export declare const Generic: Box<Inner<{ a: 1 }>, Other<{ b: 2 }>>;',
    'export type Tuple = Composed<{ a: 1 }, { b: 2 }>;',
    'export interface After { z: 1 }',
    '',
  ].join('\n'))].map(([, text]) => text), [
    // A declaration that ends at its closing brace records without the
    // optional `;` — the same shape a class or interface body has always had.
    // Only the terminator the scan actually stops on is part of the text.
    "export type Union = { a: 'x' } | { a: 'y' } | { a: 'z' }",
    'export type Intersection = { a: 1 } & { b: 2 }',
    'export type Arrayed = { a: 1 }[];',
    'export declare const Generic: Box<Inner<{ a: 1 }>, Other<{ b: 2 }>>;',
    'export type Tuple = Composed<{ a: 1 }, { b: 2 }>;',
    // ...and a body that IS the whole declaration still ends there: the last
    // `}` is followed by nothing, not by a continuation.
    'export interface After { z: 1 }',
  ])
})

test('stripComments leaves a URL inside a type alone', () => {
  assert.equal(stripComments("export type Home = 'https://example.com/x';\n"), "export type Home = 'https://example.com/x';\n")
  assert.equal(stripComments('export type A = { a: string } // trailing\n'), 'export type A = { a: string } \n')
})

test('re-export edges name the module they came from', () => {
  assert.deepEqual([...reExportedFrom("export { A, b as C } from './x.ts';\nexport type { D };")], [
    ['A', { local: 'A', specifier: './x.ts' }],
    ['C', { local: 'b', specifier: './x.ts' }],
    ['D', { local: 'D', specifier: undefined }],
  ])
})

test('a re-exported symbol is recorded with the text of the module that declares it', () => {
  withWorkspace((root) => {
    write(root, 'index.d.ts', "export type { Config } from './config.ts';\n")
    write(root, 'config.d.ts', 'export interface Config { port: number; }\n')
    assert.deepEqual(surfaceOfFile(join(root, 'index.d.ts')), {
      Config: 'export interface Config { port: number; }',
    })
  })
})

test('a local re-export resolves through the import the compiler emitted beside it', () => {
  withWorkspace((root) => {
    write(root, 'types.d.ts', [
      "import type { ApplicationLogEvent } from './ledger.ts';",
      'export type { ApplicationLogEvent };',
      '',
    ].join('\n'))
    write(root, 'ledger.d.ts', 'export interface ApplicationLogEvent { readonly seq: number; }\n')
    assert.deepEqual(surfaceOfFile(join(root, 'types.d.ts')), {
      ApplicationLogEvent: 'export interface ApplicationLogEvent { readonly seq: number; }',
    })
  })
})

test('star re-export edges are read in both forms, and the namespace form is not one of them', () => {
  // Asked of `tsc`: `export * as ns from '…'` exports the single name `ns` and
  // none of the target's own names (a consumer importing them from the barrel
  // is TS2305). Expanding it as a surface would invent symbols.
  assert.deepEqual([...starReExports([
    "export * from './values.ts';",
    "export type * from './applications/index.ts';",
    "export * as NsApi from './transport.ts';",
    'export { Named } from "./named.ts";',
    '',
  ].join('\n'))], [
    { specifier: './values.ts', namespace: false },
    { specifier: './applications/index.ts', namespace: false },
    { specifier: './transport.ts', namespace: true },
  ])
})

test('a whole-surface re-export is followed into the target, and its names enter the surface', () => {
  // The regression this pins: the gate's module note said "all four shapes
  // resolve to a declaration" while `export *` was not one of the four —
  // `export type * from './applications/index.ts'` stood in front of a dozen
  // names and the snapshot held none of them.
  withWorkspace((root) => {
    write(root, 'index.d.ts', [
      "export * from './values.ts';",
      "export type * from './applications/index.ts';",
      '',
    ].join('\n'))
    write(root, 'values.d.ts', 'export declare const OWN: 1\n')
    // The target's own surface is a mixture: values re-exported by name,
    // types re-exported by name, both from modules a further hop away. The
    // star contributes the NAMES; the text recorded for each is the text of
    // the module that declares it, not the barrel's line.
    write(root, 'applications/index.d.ts', [
      "export { ApplicationMirror, combineTransports } from './runtime.ts';",
      "export type { FrameFan, TransportFrame } from './transport.ts';",
      '',
    ].join('\n'))
    write(root, 'applications/runtime.d.ts', [
      'export declare class ApplicationMirror { list(): void }',
      'export declare function combineTransports(): void;',
      '',
    ].join('\n'))
    write(root, 'applications/transport.d.ts', [
      'export interface FrameFan { on(frame: string): void }',
      'export type TransportFrame = { readonly seq: number };',
      '',
    ].join('\n'))
    assert.deepEqual(surfaceOfFile(join(root, 'index.d.ts')), {
      ApplicationMirror: 'export declare class ApplicationMirror { list(): void }',
      FrameFan: 'export interface FrameFan { on(frame: string): void }',
      OWN: 'export declare const OWN: 1',
      TransportFrame: 'export type TransportFrame = { readonly seq: number }',
      combineTransports: 'export declare function combineTransports(): void;',
    })
  })
})

test('an explicit export shadows a star, and the first star wins between two — the precedence `tsc` states', () => {
  // Asked of `tsc` on this fixture: the explicit form compiles with no
  // ambiguity and is what resolves; two stars offering the same NAME is
  // TS2308, reported against the EARLIER module ("Module './a.ts' has already
  // exported a member named 'X'"), which is the direction of the first-wins
  // rule here. Two stars offering the same SYMBOL are not an error at all, and
  // both readings agree because both edges lead to one declaration.
  withWorkspace((root) => {
    write(root, 'index.d.ts', [
      "export * from './a.ts';",
      "export * from './b.ts';",
      "export type { Ambiguous } from './c.ts';",
      '',
    ].join('\n'))
    write(root, 'a.d.ts', "export interface Ambiguous { from: 'a' }\nexport interface First { from: 'a' }\n")
    write(root, 'b.d.ts', "export interface Ambiguous { from: 'b' }\nexport interface First { from: 'b' }\n")
    write(root, 'c.d.ts', "export interface Ambiguous { from: 'c' }\n")
    assert.deepEqual(surfaceOfFile(join(root, 'index.d.ts')), {
      Ambiguous: "export interface Ambiguous { from: 'c' }",
      First: "export interface First { from: 'a' }",
    })
  })
})

test('a star cycle terminates, and a name behind it is reached from both sides', () => {
  // Asked of `tsc` on this fixture: `import { X } from './b.ts'` resolves, even
  // though b reaches X only by going round the cycle (b → a → d). A walk that
  // stopped at the first repeat would leave `X` out of b's surface.
  withWorkspace((root) => {
    write(root, 'a.d.ts', "export * from './b.ts';\nexport * from './d.ts';\nexport interface FromA { a: 1 }\n")
    write(root, 'b.d.ts', "export * from './a.ts';\nexport interface FromB { b: 1 }\n")
    write(root, 'd.d.ts', 'export interface X { d: 1 }\n')
    for (const file of ['a', 'b']) {
      assert.deepEqual(surfaceOfFile(join(root, `${file}.d.ts`)), {
        FromA: 'export interface FromA { a: 1 }',
        FromB: 'export interface FromB { b: 1 }',
        X: 'export interface X { d: 1 }',
      })
    }
  })
})

test('a cross-package re-export resolves through the target package exports map', () => {
  withWorkspace((root) => {
    write(root, 'packages/a/pub/package.json', manifest('@matrix1001/dsh-application-harness-pub'))
    write(root, 'packages/a/pub/lib/types/index.d.ts', 'export interface Wire { readonly id: string; }\n')
    write(root, 'packages/a/dep/package.json', manifest('@matrix1001/dsh-application-harness-dep'))
    write(root, 'packages/a/dep/lib/types/index.d.ts', "export type { Wire } from '@matrix1001/dsh-application-harness-pub';\n")
    assert.deepEqual(collectSurfaces(root)['@matrix1001/dsh-application-harness-dep'], {
      '.': { Wire: 'export interface Wire { readonly id: string; }' },
    })
  })
})

test('a re-export of something outside the workspace records the edge and is counted', () => {
  withWorkspace((root) => {
    write(root, 'packages/a/dep/package.json', manifest('@matrix1001/dsh-application-harness-dep'))
    write(root, 'packages/a/dep/lib/types/index.d.ts', "export type { Service } from '@deepseek-ai/cordis';\nexport type { Lost } from './nowhere.ts';\n")
    const current = collectSurfaces(root)
    assert.deepEqual(current['@matrix1001/dsh-application-harness-dep']['.'], {
      Lost: UNRESOLVED,
      Service: '<external: @deepseek-ai/cordis>',
    })
    // Not a silent skip: both faces are counted so the gate can print them.
    assert.deepEqual(surfaceScope(current), { unresolved: 1, external: 1, starsNotFollowed: 0 })
  })
})

test('a star the walk cannot read is counted, and the surface holds only what it could read', () => {
  withWorkspace((root) => {
    write(root, 'packages/a/dep/package.json', manifest('@matrix1001/dsh-application-harness-dep'))
    write(root, 'packages/a/dep/lib/types/index.d.ts', [
      "export type * from '@deepseek-ai/cordis';",
      "export * from './nowhere.ts';",
      "export * as NsApi from './real.ts';",
      "export type { Known } from './real.ts';",
      '',
    ].join('\n'))
    write(root, 'packages/a/dep/lib/types/real.d.ts', 'export interface Known { a: 1 }\n')
    const skipped = new Map()
    const current = collectSurfaces(root, new Set(), skipped)
    // What the walk CAN read is in the surface — including a named re-export
    // that shares a module with a star it cannot read — and the three edges it
    // cannot are what the run line counts, so the gate never reports a surface
    // it did not enumerate.
    assert.deepEqual(current['@matrix1001/dsh-application-harness-dep']['.'], { Known: 'export interface Known { a: 1 }' })
    assert.deepEqual(surfaceScope(current, skipped), { unresolved: 0, external: 0, starsNotFollowed: 3 })
    assert.deepEqual([...skipped.values()].map((edge) => [edge.specifier, edge.reason]), [
      ['@deepseek-ai/cordis', 'external'],
      ['./nowhere.ts', 'missing'],
      ['./real.ts', 'namespace'],
    ])
  })
})

test('the run line names every star edge it did not follow', () => {
  // A count says a surface went unread; the names say WHICH, and the gate
  // printing one without the other is the shape it exists to refuse.
  withWorkspace((root) => {
    write(root, 'packages/a/dep/package.json', manifest('@matrix1001/dsh-application-harness-dep'))
    write(root, 'packages/a/dep/lib/types/index.d.ts', "export type * from '@deepseek-ai/cordis';\nexport * from './nowhere.ts';\n")
    const logged = []
    assert.equal(verify({ root, update: true, log: (line) => logged.push(line), error: () => {} }), 0)
    assert.deepEqual(logged, [
      'verify-api-snapshot: recorded 1 package surfaces → scripts/api-snapshot.json'
        + ' (0 symbol(s) unresolved, 0 resolved to an external package edge, 2 star re-export edge(s) not followed)',
      '  - star re-export not followed: packages/a/dep/lib/types/index.d.ts → @deepseek-ai/cordis (the target is outside the workspace)',
      '  - star re-export not followed: packages/a/dep/lib/types/index.d.ts → ./nowhere.ts (the build emitted no such declaration)',
    ])
  })
})

test('a name set behind a star is part of the snapshot: changing it trips the gate', () => {
  withWorkspace((root) => {
    write(root, 'packages/x/pkg/package.json', manifest('@matrix1001/dsh-application-harness-x'))
    write(root, 'packages/x/pkg/lib/types/index.d.ts', "export type * from './surface.ts';\n")
    const target = write(root, 'packages/x/pkg/lib/types/surface.d.ts', 'export declare function first(): void;\n')
    const seats = { log: () => {}, error: () => {} }
    assert.equal(verify({ root, update: true, ...seats }), 0)
    assert.match(readFileSync(join(root, 'scripts/api-snapshot.json'), 'utf8'), /first/u)
    writeFileSync(target, 'export declare function first(): void;\nexport declare function second(): void;\n')
    assert.equal(verify({ root, ...seats }), 1)
    assert.deepEqual(apiProblems(JSON.parse(readFileSync(join(root, 'scripts/api-snapshot.json'), 'utf8')), collectSurfaces(root)), [
      '@matrix1001/dsh-application-harness-x.: added second',
    ])
  })
})

test('surfaceOf reads the subpaths a manifest exports and their declaration files', () => {
  withWorkspace((root) => {
    write(root, 'packages/x/pkg/package.json', JSON.stringify({
      name: '@matrix1001/dsh-application-harness-x',
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './types': { types: './lib/types/types.d.ts' },
        // A plain string subpath ships a file but declares no types: reading it
        // as a surface would add an empty subpath to the snapshot.
        './cordis.patch.yml': './cordis.patch.yml',
        './no-types': { default: './lib/no-types.js' },
      },
    }))
    write(root, 'packages/x/pkg/lib/types/index.d.ts', 'export declare class Runtime {}\n')
    write(root, 'packages/x/pkg/lib/types/types.d.ts', "export type { Config } from './config.ts';\n")
    write(root, 'packages/x/pkg/lib/types/config.d.ts', 'export interface Config { a: string }\n')
    write(root, 'packages/x/pkg/cordis.patch.yml', '- id: x\n')
    assert.deepEqual(surfaceOf(root, 'packages/x/pkg'), {
      '.': { Runtime: 'export declare class Runtime {}' },
      './types': { Config: 'export interface Config { a: string }' },
    })
  })
})

test('a signature-only change fails the gate while every name stays put', () => {
  // The whole point of the depth: the name set is identical before and after,
  // so the name-only gate this replaces reported "unchanged".
  withWorkspace((root) => {
    write(root, 'packages/x/pkg/package.json', manifest('@matrix1001/dsh-application-harness-x'))
    const declaration = write(root, 'packages/x/pkg/lib/types/index.d.ts', [
      'export interface RunContext {',
      '    reportProgress: (data: string) => void;',
      '}',
      '',
    ].join('\n'))
    const seats = { log: () => {}, error: () => {} }
    assert.equal(verify({ root, update: true, ...seats }), 0)
    writeFileSync(declaration, [
      'export interface RunContext {',
      '    reportProgress: (data: string, label?: string) => void;',
      '}',
      '',
    ].join('\n'))
    const error = []
    assert.equal(verify({ root, ...seats, error: (line) => error.push(line) }), 1)
    assert.deepEqual(error, [
      'verify-api-snapshot: the public API surface changed:',
      '  - @matrix1001/dsh-application-harness-x.: RunContext signature changed\n'
        + '      - export interface RunContext { reportProgress: (data: string) => void; }\n'
        + '      + export interface RunContext { reportProgress: (data: string, label?: string) => void; }',
      'Review the change, then re-record with: node scripts/verify-api-snapshot.mjs --update',
    ])
  })
})

test('a comment-only edit is not an API change', () => {
  withWorkspace((root) => {
    write(root, 'packages/x/pkg/package.json', manifest('@matrix1001/dsh-application-harness-x'))
    const declaration = write(root, 'packages/x/pkg/lib/types/index.d.ts', '/** First. */\nexport declare function ping(): void;\n')
    assert.equal(verify({ root, update: true, log: () => {}, error: () => {} }), 0)
    writeFileSync(declaration, '/** Second — reworded only. */\nexport declare function ping(): void;\n')
    assert.equal(verify({ root, log: () => {}, error: () => {} }), 0)
  })
})

test('the gate reports added and removed symbols, and re-recording clears it', () => {
  withWorkspace((root) => {
    write(root, 'packages/x/pkg/package.json', manifest('@matrix1001/dsh-application-harness-x'))
    const declaration = write(root, 'packages/x/pkg/lib/types/index.d.ts', 'export declare function ping(name: string): string\n')
    const seats = { log: () => {}, error: () => {} }
    assert.equal(verify({ root, update: true, ...seats }), 0)
    assert.equal(verify({ root, ...seats }), 0)
    // A renamed export is a change the gate must see.
    writeFileSync(declaration, 'export declare function pong(name: string): string\n')
    assert.equal(verify({ root, ...seats }), 1)
    assert.deepEqual(apiProblems(JSON.parse(readFileSync(join(root, 'scripts/api-snapshot.json'), 'utf8')), collectSurfaces(root)), [
      '@matrix1001/dsh-application-harness-x.: added pong',
      '@matrix1001/dsh-application-harness-x.: removed ping',
    ])
  })
})

test('a workspace with no snapshot is a failure, not an empty comparison', () => {
  withWorkspace((root) => {
    write(root, 'packages/x/pkg/package.json', JSON.stringify({ name: '@matrix1001/dsh-application-harness-x', exports: {} }))
    const error = []
    assert.equal(verify({ root, log: () => {}, error: (line) => error.push(line) }), 1)
    assert.match(error[0], /api-snapshot\.json is missing/u)
  })
})

/** A fixture package plus a `src/` entry whose mtime the case controls. */
function fixtureWithSource(root, { sourceAt, declarationAt, name = '@matrix1001/dsh-application-harness-x' } = {}) {
  write(root, 'packages/x/pkg/package.json', manifest(name))
  const declaration = write(root, 'packages/x/pkg/lib/types/index.d.ts', 'export declare function ping(): void\n')
  const source = write(root, 'packages/x/pkg/src/index.ts', 'export function ping(): void {}\n')
  const at = (path, when) => utimesSync(path, when, when)
  if (declarationAt !== undefined) at(declaration, declarationAt)
  if (sourceAt !== undefined) at(source, sourceAt)
  return { declaration, source }
}

test('a declaration older than its sources makes the gate refuse to judge', () => {
  // The false-confidence shape the mtime guard closes: run the gate after
  // editing src/ and skipping the build, and the declarations it is about to
  // compare are the PREVIOUS revision. Comparing them would print OK for a
  // surface nobody is looking at.
  withWorkspace((root) => {
    const { source } = fixtureWithSource(root, { declarationAt: new Date('2026-01-01T00:00:00Z'), sourceAt: new Date('2025-12-31T00:00:00Z') })
    assert.equal(verify({ root, update: true, log: () => {}, error: () => {} }), 0)
    // The edit that was never rebuilt.
    const edited = new Date('2026-01-02T00:00:00Z')
    utimesSync(source, edited, edited)
    const lines = []
    const error = []
    assert.equal(verify({ root, log: (line) => lines.push(line), error: (line) => error.push(line) }), 1)
    assert.deepEqual(lines, [], 'a refused comparison must not print a verdict')
    assert.match(error[0], /STALE — 1 package\(s\) whose declaration artifacts are older than their sources/u)
    assert.match(error[0], /refusing to compare or re-record/u)
    assert.match(error[0], /Build first: pnpm run build/u)
    assert.deepEqual(error.slice(1), ['  - @matrix1001/dsh-application-harness-x: src/ is newer than packages/x/pkg/lib/types/index.d.ts'])
  })
})

test('a stale tree cannot re-record: --update refuses and leaves the snapshot alone', () => {
  // Guarding the comparison alone would be too late. Re-recording from a stale
  // tree writes a public-surface fact into the repo that the source no longer
  // produces — a wrong fact, not a temporary one, which is the same disease
  // 子项 5 treats ("改了公共面要重录" running in neutral).
  withWorkspace((root) => {
    const { declaration, source } = fixtureWithSource(root, { declarationAt: new Date('2026-01-01T00:00:00Z'), sourceAt: new Date('2025-12-31T00:00:00Z') })
    assert.equal(verify({ root, update: true, log: () => {}, error: () => {} }), 0)
    const recorded = readFileSync(join(root, 'scripts/api-snapshot.json'), 'utf8')
    assert.match(recorded, /ping/u)
    // One revision behind: the artifact still holds the previous surface, the
    // source has moved on. An unguarded `--update` would write `pong`.
    writeFileSync(declaration, 'export declare function pong(): void\n')
    utimesSync(declaration, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    utimesSync(source, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))
    const lines = []
    const error = []
    assert.equal(verify({ root, update: true, log: (line) => lines.push(line), error: (line) => error.push(line) }), 1)
    assert.deepEqual(lines, [], 'a refused re-record must not print a verdict')
    assert.match(error[0], /refusing to compare or re-record/u)
    const after = readFileSync(join(root, 'scripts/api-snapshot.json'), 'utf8')
    assert.equal(after, recorded, 'the snapshot must be untouched')
    assert.doesNotMatch(after, /pong/u)
  })
})

test('inside the grace window the gate still judges', () => {
  // A single install or checkout writes src/ and lib/ in filesystem order, so
  // sources can land marginally newer than a fresh artifact — the same
  // tolerance the launch preflight uses.
  withWorkspace((root) => {
    const declarationAt = new Date('2026-01-01T00:00:00Z')
    fixtureWithSource(root, { declarationAt, sourceAt: new Date(declarationAt.getTime() + 1000) })
    assert.equal(verify({ root, update: true, log: () => {}, error: () => {} }), 0)
    assert.equal(verify({ root, log: () => {}, error: () => {} }), 0)
  })
})

test('a fresh build is judged, and the guard has nothing to say', () => {
  withWorkspace((root) => {
    fixtureWithSource(root, { declarationAt: new Date('2026-01-02T00:00:00Z'), sourceAt: new Date('2026-01-01T00:00:00Z') })
    const reads = new Set()
    const current = collectSurfaces(root, reads)
    assert.deepEqual(staleSurfaces(root, reads), [])
    assert.equal(verify({ root, update: true, log: () => {}, error: () => {} }), 0)
    assert.equal(verify({ root, log: () => {}, error: () => {} }), 0)
    assert.deepEqual(Object.keys(current), ['@matrix1001/dsh-application-harness-x'])
  })
})

test('the guard reads only the declarations the gate reads, and needs a src tree', () => {
  withWorkspace((root) => {
    fixtureWithSource(root, { declarationAt: new Date('2026-01-01T00:00:00Z'), sourceAt: new Date('2026-01-02T00:00:00Z') })
    // What the run READ is the subject: a declaration nobody reads cannot
    // mislead a comparison, so an empty read set is never stale.
    assert.deepEqual(staleSurfaces(root, new Set()), [])
    // A published-only package (no src/) cannot be stale this way.
    assert.equal(staleSurfaces(root, new Set([join(root, 'packages/x/pkg/lib/types/index.d.ts')])).length, 1)
    rmSync(join(root, 'packages/x/pkg/src'), { recursive: true, force: true })
    assert.deepEqual(staleSurfaces(root, new Set([join(root, 'packages/x/pkg/lib/types/index.d.ts')])), [])
  })
})

test('private packages and the vendored typert shell stay out of the surface', () => {
  withWorkspace((root) => {
    write(root, 'packages/x/pub/package.json', JSON.stringify({ name: '@matrix1001/dsh-application-harness-pub', exports: {} }))
    write(root, 'packages/x/priv/package.json', JSON.stringify({ name: '@matrix1001/dsh-application-harness-priv', private: true, exports: {} }))
    write(root, 'packages/typert/protocol/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', exports: {} }))
    assert.deepEqual(Object.keys(collectSurfaces(root)), ['@matrix1001/dsh-application-harness-pub'])
  })
})
