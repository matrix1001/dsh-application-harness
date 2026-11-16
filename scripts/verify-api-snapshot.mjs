#!/usr/bin/env node
/**
 * Public-API snapshot gate (remediation plan 阶段 G, 公共 API 快照/变更门): every
 * publishable package's *public type surface* — its `exports` subpaths and each
 * symbol a subpath's declaration file exports, **with that symbol's declaration
 * text** — is recorded in `scripts/api-snapshot.json`. A change to that surface
 * fails the gate until the snapshot is regenerated with `--update`, so an API
 * change is always a deliberate, reviewable act instead of an accident.
 *
 * The snapshot reads the built `lib/types/**` declarations (the same files a
 * consumer resolves), so it reflects the published surface, not the source
 * layout. Run after a build; the release chain builds first. Reading the
 * EMITTED declarations is what makes a signature snapshot stable and
 * reviewable: the compiler normalizes the source into a shape that only
 * changes when the contract does, so a formatting-only edit does not trip it
 * (a source-text snapshot would, and `--update` would become routine).
 *
 * Depth (AR2″a, `api-snapshot-name-only-and-update`): the gate used to compare
 * symbol NAME SETS, so a signature-level change — a new parameter, a widened
 * return type, a new member — was invisible as long as the names held. It now
 * records and compares normalized declaration text. Names reach the surface
 * through five shapes and each one resolves to a declaration:
 *
 * - defined here (`export interface X`, `export declare function f`);
 * - re-exported from a sibling module (`export { X } from './x.ts'`, and the
 *   `import type { X } from './x.ts'` + `export { X }` pair the compiler emits
 *   for a local re-export);
 * - re-exported from another workspace package (`export type { X } from
 *   '@matrix1001/dsh-application-harness-host-bridge/types'`) — resolved through that package's
 *   own `exports` map;
 * - re-exported from something outside the workspace (a platform package): the
 *   edge itself is recorded as `<external: …>`, so the dependency is still
 *   visible, and the count of such symbols is printed rather than passed over
 *   in silence;
 * - re-exported WHOLE (`export * from './x.ts'`, `export type * from './x.ts'`):
 *   followed into the target's own export surface, transitively, so the names
 *   behind the star enter the snapshot with the text of the module that
 *   declares them (整改轮 2, `api-snapshot-star-reexport`). That list has five
 *   entries because this one was missing: the module used to say "names reach
 *   the surface through four shapes and all four resolve to a declaration" —
 *   true of the four it counted, and silent about the shape that reached the
 *   surface through none of them. `export type *` stood in front of a dozen
 *   names in one entry file and the snapshot held none of them.
 *
 * A star-shaped rewrite is NOT a shape: `export * as ns from '…'` exports the
 * single name `ns` and none of the target's own names, so expanding it as a
 * surface would invent symbols. The star edges the gate cannot read are
 * counted and printed on every run instead (`starsNotFollowed`) rather than
 * silently dropped: the namespace form above, and a star whose target is
 * outside the workspace, whose surface this gate has no way to enumerate.
 *
 * Its input is only admissible while the declarations still DESCRIBE the tree
 * they name, so the gate guards that input FIRST ({@link staleSurfaces},
 * AR2″a 整改轮 1/2): if a declaration it is about to read is older than its
 * package's `src/`, no build has happened since the last edit, and the gate
 * refuses BOTH of its actions — it prints `STALE` with the file and the rebuild
 * command instead of a verdict, never `OK`. Guarding the comparison alone would
 * be too late: `--update` from a stale tree writes a public-surface fact into
 * the repo that the source no longer produces, and that is a wrong fact rather
 * than a temporary one. `--update`'s lawful use is "build, then re-record the
 * published surface" — a stale tree cannot re-record, because that discipline
 * is the point. The check is deliberately an mtime test rather than a fallback
 * to source text: source text is the IMPLEMENTATION
 * (`export function f(): string {{ … }}`), not the contract the emitted `.d.ts`
 * states (`declare function f(): string;`), so comparing source would demand a
 * re-record after every internal edit.
 *
 * Every reader below is exported with an injectable root so the script-plane
 * tests can point it at a fixture tree: the production entry points are never
 * invoked (they would rebuild the workspace first).
 * @module
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STALE_ENTRY_GRACE_MS, newestSourceMtime } from './deployment-packages.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The recorded surface, relative to the workspace root. */
export const SNAPSHOT_REL = join('scripts', 'api-snapshot.json')

/** The signature recorded for a symbol whose declaration lives outside this workspace. */
export function externalMarker(specifier) {
  return `<external: ${specifier}>`
}

/** The signature recorded for a symbol whose declaration could not be located at all. */
export const UNRESOLVED = '<unresolved>'

/**
 * Drop `//` and block comments without touching string or template literals.
 * The compiler copies JSDoc into the declarations, and a doc-only edit is not
 * an API change — keeping comments would make the snapshot churn on prose.
 * @param text - the declaration text.
 * @returns the text with comments removed (their line breaks kept, so the shape is stable).
 */
export function stripComments(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') out += '\n'
        index += 1
      }
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      out += char
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') { out += text[index] + (text[index + 1] ?? ''); index += 2; continue }
        out += text[index]
        if (text[index] === char) { index += 1; break }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Collapse one declaration to a single stable line. */
function normalize(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Whether the type a `}` just closed is continued by what follows instead of
 * ended there. Five characters say "the declaration goes on" in this
 * workspace's emitted declarations, and each one is a `}` that the old
 * "first depth-0 `}` ends the declaration" rule filed half a signature away:
 *
 * - `|` and `&` — the next member of a union or intersection, which is where
 *   `RecoveryStatus` lost three of its four states;
 * - `>` — the brace was the last of a generic argument (`Schema<ObjectS<{ … }>,
 *   ObjectT<{ … }>>`), and the argument list still has to close;
 * - `,` — a later argument of the same list;
 * - `[` — an array or an indexed access applied to the closed type.
 *
 * The census behind the list is every depth-0 `}` of every declaration this
 * workspace emits: 414 are followed by the next `export`, 207 by `;`, 11 by
 * end-of-file, 16 by a declaration the gate does not record (`declare`,
 * `type`, `interface`), and the rest by exactly these five characters.
 * @param text - the comment-free declaration text.
 * @param from - the index just past the closing `}`.
 * @returns whether the declaration continues.
 */
function continuesDeclaration(text, from) {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue
    return char === '|' || char === '&' || char === '[' || char === '>' || char === ','
  }
  return false
}

/**
 * The end index of the declaration starting at `start`: the matching `}` of a
 * braced body, else the first `;` outside any bracket — except that a depth-0
 * `}` ends it only where the TYPE it closed is complete.
 *
 * That exception is the whole difficulty of reading declarations textually, and
 * it is not a corner: a braced body is not one brace deep in `{ a } | { b }`
 * (`RecoveryStatus`, `ProjectionDecision`, `ProjectionScope`,
 * `BackgroundScheduleAuthor` are all written that way) nor in
 * `Schema<ObjectS<{ … }>, ObjectT<{ … }>>`, and a rule that stops at the first
 * balancing brace records a signature the source never states. The written
 * declaration text stays the subject — it is the contract, and the compiler's
 * own printer would be a different contract with a different formatting — so
 * the fix is a better reading of the same text ({@link continuesDeclaration}).
 * @param text - the comment-free declaration text.
 * @param start - the index of the declaration's `export` keyword.
 * @returns the index just past the declaration.
 */
function declarationEnd(text, start) {
  let depth = 0
  let sawBrace = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{' || char === '(' || char === '[') { depth += 1; sawBrace = true }
    else if (char === '}' || char === ')' || char === ']') {
      depth -= 1
      if (char === '}' && depth === 0 && sawBrace && !continuesDeclaration(text, index + 1)) return index + 1
    } else if (char === ';' && depth === 0) return index + 1
  }
  return text.length
}

/**
 * Every symbol DEFINED in one declaration file, name → normalized declaration
 * text.
 * @param text - the declaration file's text (comments are stripped here).
 * @returns the definitions, keyed by name.
 */
export function definedSignatures(text) {
  const source = stripComments(text)
  const found = new Map()
  const definitions = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|function|const|let|var|enum|namespace)\s+([A-Za-z0-9_$]+)/gmu
  for (const match of source.matchAll(definitions)) {
    found.set(match[1], normalize(source.slice(match.index, declarationEnd(source, match.index))))
  }
  return found
}

/**
 * The module each imported name came from: `import type { A, B } from '…'`.
 * The compiler emits the `import type` + `export { A, B }` pair for a local
 * re-export, so this is how such a name finds its declaration.
 * @param text - the declaration file's text.
 * @returns the specifier by imported name.
 */
export function importedFrom(text) {
  const source = stripComments(text)
  const sources = new Map()
  for (const match of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gmu)) {
    for (const entry of match[1].split(',')) {
      const alias = entry.trim().split(/\s+as\s+/u)
      const name = (alias[1] ?? alias[0])?.trim()
      if (name !== undefined && name.length > 0) sources.set(name, match[2])
    }
  }
  return sources
}

/**
 * Every name one declaration file RE-EXPORTS: exported name → the module it
 * came from (undefined when the specifier has to come from this file's own
 * `import` list).
 * @param text - the declaration file's text.
 * @returns the re-export edges by exported name.
 */
export function reExportedFrom(text) {
  const source = stripComments(text)
  const edges = new Map()
  for (const match of source.matchAll(/^export\s*(?:type\s+)?\{([^}]*)\}\s*(?:from\s+['"]([^'"]+)['"])?/gmu)) {
    for (const entry of match[1].split(',')) {
      const alias = entry.trim().split(/\s+as\s+/u)
      const local = alias[0]?.trim()
      const exported = (alias[1] ?? alias[0])?.trim()
      if (local === undefined || local.length === 0 || exported === undefined || exported.length === 0) continue
      edges.set(exported, { local, specifier: match[2] })
    }
  }
  return edges
}

/**
 * Every whole-surface re-export edge of one declaration file, in the order the
 * file states them: `export * from '…'` and `export type * from '…'`.
 *
 * `export * as ns from '…'` is deliberately NOT one of them, and the compiler
 * is why: it exports the single name `ns` and none of the target's own names
 * (asked of `tsc` on a fixture, not read off the spec). Expanding it as a
 * surface would invent symbols; it is reported as an edge the gate did not
 * follow instead, which is the honest reading of a name that is in the surface
 * and not in the snapshot.
 * @param text - the declaration file's text.
 * @returns the star edges, in source order.
 */
export function starReExports(text) {
  const source = stripComments(text)
  const edges = []
  const stars = /^export\s+(?:type\s+)?\*\s*(?:as\s+([A-Za-z0-9_$]+)\s+)?from\s*['"]([^'"]+)['"]/gmu
  for (const match of source.matchAll(stars)) {
    edges.push({ specifier: match[2], namespace: match[1] !== undefined })
  }
  return edges
}

/**
 * The exported symbol names of one declaration file (see {@link collectSurface}
 * for the full record).
 * @param path - the declaration file.
 * @returns the sorted symbol names.
 */
export function exportedSymbols(path) {
  return Object.keys(collectSurface(new Map(), path, new Map())).sort()
}

/**
 * The declaration file one subpath of a package resolves to, or undefined.
 * Only an OBJECT target carrying a `types` field is a declaration surface: a
 * plain string export (`"./cordis.patch.yml": "./cordis.patch.yml"`) ships a
 * file but declares no types, and reading it as a surface would add an empty
 * subpath to the snapshot.
 */
function declarationOf(dir, subpath) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const key = subpath === '' ? '.' : `./${subpath}`
  const target = manifest.exports?.[key]
  if (typeof target !== 'object' || target === null || typeof target.types !== 'string') return undefined
  const path = join(dir, target.types)
  return existsSync(path) ? path : undefined
}

/**
 * Resolve a BARE re-export specifier through the target package's own `exports`
 * map: `@matrix1001/dsh-application-harness-host-bridge/types` → the package's `./types` declaration.
 * @param specifier - a bare package specifier.
 * @param packages - the workspace's package name → directory index.
 * @returns the declaration file, or undefined when the workspace does not declare the name.
 */
function resolvePackageSpecifier(specifier, packages) {
  const parts = specifier.split('/')
  const dir = packages.get(parts.slice(0, 2).join('/'))
  if (dir === undefined) return undefined
  return declarationOf(dir, parts.slice(2).join('/'))
}

/**
 * Where one module specifier leads, read from the declaration file that states
 * it: a relative specifier names a sibling declaration the build emitted (the
 * compiler leaves the source extension in its output, so `./x.ts` names
 * `./x.d.ts`), while a bare one goes through the workspace's own name →
 * directory index.
 * @param packages - the workspace's package name → directory index.
 * @param file - the declaration file the specifier was read from.
 * @param specifier - the specifier as written.
 * @returns `{ target }` for a declaration file this workspace emits; `{ external }`
 *   for a bare specifier the workspace does not declare — a real dependency on
 *   something outside it, whose edge is the record because the far side is not
 *   this workspace's to read; `{}` for a relative specifier that resolves to
 *   nothing, a DEFECT (the declaration points at a module the build never
 *   emitted) that reads as unresolved.
 */
function resolveModule(packages, file, specifier) {
  if (specifier.startsWith('.')) {
    const target = join(dirname(file), specifier.replace(/\.tsx?$/u, '.d.ts'))
    return existsSync(target) ? { target } : {}
  }
  const target = resolvePackageSpecifier(specifier, packages)
  return target === undefined ? { external: specifier } : { target }
}

/**
 * Every name one declaration file presents: the ones it defines, the ones it
 * re-exports by name, and the ones that arrive through its `export *` edges —
 * followed transitively, because a star re-exports a SURFACE and that surface
 * may hold stars of its own.
 *
 * The walk is a closure over the star graph with a visited set, which is what
 * a cycle needs: `a` → `b` → `a` terminates, and every module the walk reaches
 * still contributes the names it defines. WHICH of the names the surface
 * records is {@link resolveSignature}'s question, not this one's.
 * @param packages - the workspace's package name → directory index.
 * @param file - the declaration file to enumerate.
 * @param reads - the declaration files this run read (filled in; the staleness guard needs them).
 * @param skipped - the star edges the walk could not follow (filled in; see {@link surfaceScope}).
 * @returns the names, unsorted.
 */
function surfaceNames(packages, file, reads, skipped) {
  const names = new Set()
  const seen = new Set([file])
  const queue = [file]
  while (queue.length > 0) {
    const current = queue.shift()
    reads.add(current)
    const text = readFileSync(current, 'utf8')
    for (const name of definedSignatures(text).keys()) names.add(name)
    for (const name of reExportedFrom(text).keys()) names.add(name)
    // A star this walk cannot read is COUNTED, once per edge, rather than
    // dropped: the names behind it lie outside a surface the gate claims to
    // have enumerated, and that claim is the whole point of saying so.
    const skip = (specifier, reason) => { skipped.set(`${current} ${specifier}`, { file: current, specifier, reason }) }
    for (const star of starReExports(text)) {
      if (star.namespace) { skip(star.specifier, 'namespace'); continue }
      const where = resolveModule(packages, current, star.specifier)
      if (where.external !== undefined) { skip(star.specifier, 'external'); continue }
      if (where.target === undefined) { skip(star.specifier, 'missing'); continue }
      if (seen.has(where.target)) continue
      seen.add(where.target)
      queue.push(where.target)
    }
  }
  return names
}

/**
 * The declaration text one name resolves to FROM one declaration file: the
 * text this file defines it with, else the text its re-export edges lead to.
 *
 * The precedence is the compiler's, and every branch of it was ASKED of `tsc`
 * on a fixture rather than read off the spec:
 *
 * - an explicit export shadows an `export *` of the same name (the fixture
 *   compiles with no ambiguity, and the explicit text is what resolves);
 * - among several stars, the first in source order wins — the direction `tsc`
 *   reports the conflict in (`Module './a.ts' has already exported a member
 *   named 'X'`, TS2308, naming the EARLIER module as the one already exporting
 *   the member). Two stars offering the same NAME are an error in the compiler
 *   and a deterministic first-wins choice here; two stars offering the same
 *   SYMBOL are not an error, and both readings agree because both edges lead
 *   to the same declaration.
 *
 * `seen` is the path this lookup has taken, and it is what makes a star cycle
 * terminate (`a` → `b` → `a`). Skipping a module already on the path loses no
 * name: its own names were read when it was entered, and the names its
 * remaining stars reach are reached by the caller's own loop as well.
 * @param packages - the workspace's package name → directory index.
 * @param file - the declaration file to resolve the name from.
 * @param name - the exported name.
 * @param reads - the declaration files this run read (filled in).
 * @param seen - the files on this lookup's path (the cycle guard).
 * @returns the normalized declaration text, an external marker, or {@link UNRESOLVED}.
 */
function resolveSignature(packages, file, name, reads, seen) {
  if (seen.has(file)) return UNRESOLVED
  const path = new Set(seen)
  path.add(file)
  reads.add(file)
  const text = readFileSync(file, 'utf8')
  const defined = definedSignatures(text).get(name)
  if (defined !== undefined) return defined
  const edge = reExportedFrom(text).get(name)
  if (edge !== undefined) {
    const specifier = edge.specifier ?? importedFrom(text).get(edge.local)
    if (specifier === undefined) return UNRESOLVED
    const where = resolveModule(packages, file, specifier)
    if (where.external !== undefined) return externalMarker(where.external)
    if (where.target === undefined || path.has(where.target)) return UNRESOLVED
    return resolveSignature(packages, where.target, edge.local, reads, path)
  }
  // The fifth shape, in source order: an explicit export above shadows every
  // star, and among the stars the first one that declares the name wins.
  for (const star of starReExports(text)) {
    if (star.namespace) continue
    const where = resolveModule(packages, file, star.specifier)
    if (where.target === undefined || path.has(where.target)) continue
    const found = resolveSignature(packages, where.target, name, reads, path)
    if (found !== UNRESOLVED) return found
  }
  return UNRESOLVED
}

/**
 * The signature of one exported name, memoized per declaration file. The memo
 * records only WHOLE lookups: a value computed with a partial path (a star
 * cycle having cut the walk short) answers a narrower question than the same
 * key asks the next time, so the steps inside one lookup are not recorded.
 * @param packages - the workspace's package name → directory index.
 * @param file - the declaration file the name is exported from.
 * @param name - the exported name.
 * @param memo - the resolved names, shared across one surface build.
 * @param reads - the declaration files this run read (filled in).
 * @returns the normalized declaration text, an external marker, or {@link UNRESOLVED}.
 */
function signatureOf(packages, file, name, memo, reads) {
  const key = `${file}\u0000${name}`
  const cached = memo.get(key)
  if (cached !== undefined) return cached
  const found = resolveSignature(packages, file, name, reads, new Set())
  memo.set(key, found)
  return found
}

/**
 * The surface one declaration file presents: exported name → normalized
 * declaration text.
 * @param packages - the workspace's package name → directory index.
 * @param path - the declaration file.
 * @param memo - the resolution memo (shared per run).
 * @param reads - the declaration files this run read (filled in; the staleness guard needs them).
 * @param skipped - the star edges not followed (filled in; see {@link surfaceScope}).
 * @returns the surface, keyed by sorted name.
 */
export function collectSurface(packages, path, memo, reads = new Set(), skipped = new Map()) {
  const surface = {}
  for (const name of [...surfaceNames(packages, path, reads, skipped)].sort()) {
    surface[name] = signatureOf(packages, path, name, memo, reads)
  }
  return surface
}

/**
 * The public surface of one package: subpath → { symbol: declaration text }.
 * @param root - the workspace root.
 * @param dir - the package directory, relative to `root`.
 * @param packages - the workspace's package name → directory index.
 * @param memo - the resolution memo (shared per run).
 * @param reads - the declaration files this run read (filled in; the staleness guard needs them).
 * @param skipped - the star edges not followed (filled in; see {@link surfaceScope}).
 * @returns the surface (an empty object when the package declares no typed `exports`).
 */
export function surfaceOf(root, dir, packages = new Map(), memo = new Map(), reads = new Set(), skipped = new Map()) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  const surface = {}
  for (const subpath of Object.keys(manifest.exports ?? {})) {
    if (subpath === './package.json') continue
    const path = declarationOf(join(root, dir), subpath === '.' ? '' : subpath.replace(/^\.\//u, ''))
    if (path === undefined) continue
    surface[subpath] = collectSurface(packages, path, memo, reads, skipped)
  }
  return surface
}

/**
 * Every publishable workspace package directory, in a stable order. The
 * vendored `packages/typert/protocol` build shell is excluded by area (it
 * publishes the platform package name it snapshots, not ours).
 * @param root - the workspace root.
 * @returns package directories relative to `root`.
 */
export function publishablePackages(root) {
  return globSync('packages/*/*/package.json', { cwd: root })
    .map((path) => dirname(path))
    .filter((dir) => dir.startsWith('packages/typert') === false)
    .sort()
}

/**
 * The recorded surface of the whole workspace: package name → subpath → {
 * symbol: declaration text }.
 * @param root - the workspace root.
 * @param reads - the declaration files this run read (filled in; the staleness guard needs them).
 * @param skipped - the star edges not followed (filled in; see {@link surfaceScope}).
 * @returns the surface of every non-private package.
 */
export function collectSurfaces(root, reads = new Set(), skipped = new Map()) {
  const dirs = publishablePackages(root)
  const packages = new Map()
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
    if (typeof manifest.name === 'string') packages.set(manifest.name, join(root, dir))
  }
  const memo = new Map()
  const current = {}
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
    if (manifest.private === true) continue
    current[manifest.name] = surfaceOf(root, dir, packages, memo, reads, skipped)
  }
  return current
}

/**
 * How much of a surface was resolved rather than merely named: the symbols
 * whose declaration lives outside the workspace, those whose declaration was
 * not found at all, and the `export *` edges the walk could not follow — the
 * last one being the surface this gate did not enumerate, which it therefore
 * must not describe as enumerated. Printed on every run: a gate that stopped
 * resolving part of the surface must say so instead of comparing a smaller set
 * while reporting the same sentence.
 * @param current - a surface as {@link collectSurfaces} returns it.
 * @param skipped - the star edges the run did not follow (see {@link collectSurfaces}).
 * @returns the three counts.
 */
export function surfaceScope(current, skipped = new Map()) {
  let unresolved = 0
  let external = 0
  for (const surface of Object.values(current)) {
    for (const symbols of Object.values(surface)) {
      for (const signature of Object.values(symbols)) {
        if (signature === UNRESOLVED) unresolved += 1
        else if (signature.startsWith('<external: ')) external += 1
      }
    }
  }
  return { unresolved, external, starsNotFollowed: skipped.size }
}

/**
 * The packages whose declaration artifacts are OLDER than their sources.
 *
 * This gate's input is build output, so a comparison is only meaningful while
 * that output still describes the tree it names. After a source edit and no
 * build, the declarations are the previous revision — and comparing them would
 * print `OK` for a surface nobody is looking at, which is exactly the false
 * confidence W1-E forbids. The gate therefore refuses to judge and says why.
 *
 * An mtime test, not a fallback to source text: source text is the
 * IMPLEMENTATION (`export function f(): string { … }`), while the emitted
 * declaration is the CONTRACT (`declare function f(): string;`) — comparing
 * source would demand a re-record after every internal edit, and `--update`
 * would become routine.
 *
 * The source side reuses the repo's own {@link newestSourceMtime}, so "stale"
 * means here what it means to the launch preflight; the declaration side uses
 * the files THIS run read, because those are the bytes being judged (a
 * declaration the gate never reads cannot mislead it).
 * @param root - the workspace root.
 * @param reads - the declaration files the run read (see {@link collectSurfaces}).
 * @returns one entry per stale package, naming the newest declaration read.
 */
export function staleSurfaces(root, reads) {
  const stale = []
  for (const dir of publishablePackages(root)) {
    const source = newestSourceMtime(join(root, dir))
    if (source === undefined) continue
    const prefix = join(root, dir) + sep
    const own = [...reads].filter((file) => file.startsWith(prefix))
    if (own.length === 0) continue
    const newest = own
      .map((file) => ({ file, at: statSync(file).mtimeMs }))
      .reduce((best, entry) => (entry.at > best.at ? entry : best))
    if (source > newest.at + STALE_ENTRY_GRACE_MS) {
      const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
      stale.push({ name: manifest.name ?? dir, file: relative(root, newest.file), source, declaration: newest.at })
    }
  }
  return stale
}

/**
 * The differences between a recorded surface and the current one, as one
 * human-readable line per difference (empty = unchanged). A symbol whose
 * declaration text changed is reported with both texts: the gate's own output
 * is where the change is read, so the snapshot can stay one line per symbol.
 * @param recorded - the recorded surface.
 * @param current - the surface read from the workspace.
 * @returns the problem lines.
 */
export function apiProblems(recorded, current) {
  const problems = []
  for (const [name, surface] of Object.entries(current)) {
    const before = recorded[name]
    if (before === undefined) {
      problems.push(`${name}: new package (not in the snapshot)`)
      continue
    }
    for (const [subpath, symbols] of Object.entries(surface)) {
      const oldSymbols = before[subpath]
      if (oldSymbols === undefined) {
        problems.push(`${name}${subpath}: new export subpath (${Object.keys(symbols).length} symbols)`)
        continue
      }
      const added = Object.keys(symbols).filter((symbol) => oldSymbols[symbol] === undefined)
      const removed = Object.keys(oldSymbols).filter((symbol) => symbols[symbol] === undefined)
      if (added.length > 0) problems.push(`${name}${subpath}: added ${added.join(', ')}`)
      if (removed.length > 0) problems.push(`${name}${subpath}: removed ${removed.join(', ')}`)
      for (const symbol of Object.keys(symbols)) {
        const old = oldSymbols[symbol]
        if (old === undefined || old === symbols[symbol]) continue
        problems.push(`${name}${subpath}: ${symbol} signature changed\n      - ${old}\n      + ${symbols[symbol]}`)
      }
    }
    for (const subpath of Object.keys(before)) {
      if (surface[subpath] === undefined) problems.push(`${name}${subpath}: export subpath removed`)
    }
  }
  for (const name of Object.keys(recorded)) {
    if (current[name] === undefined) problems.push(`${name}: package removed (still in the snapshot)`)
  }
  return problems
}

/**
 * Run the gate (or record the surface with `update`).
 * @param {{ root?: string, update?: boolean, log?: (line: string) => void, error?: (line: string) => void }} [options] - the workspace root and the log seats.
 * @returns the exit code (0 = OK or recorded, 1 = stale input or a changed surface).
 */
export function verify({ root = ROOT, update = false, log = console.log, error = console.error } = {}) {
  const snapshotPath = join(root, SNAPSHOT_REL)
  const reads = new Set()
  const skipped = new Map()
  const current = collectSurfaces(root, reads, skipped)
  const { unresolved, external, starsNotFollowed } = surfaceScope(current, skipped)
  const scope = ` (${unresolved} symbol(s) unresolved, ${external} resolved to an external package edge, ${starsNotFollowed} star re-export edge(s) not followed)`
  // The star edges the walk could not follow are NAMED, not just counted: the
  // count says a surface went unread, the names say which, and a gate that
  // leaves the reader to guess is the failure mode this whole module is about.
  const reportSkipped = () => {
    for (const edge of skipped.values()) {
      const why = edge.reason === 'namespace'
        ? 'the namespace form exports one symbol, not a surface'
        : edge.reason === 'external' ? 'the target is outside the workspace' : 'the build emitted no such declaration'
      log(`  - star re-export not followed: ${relative(root, edge.file)} → ${edge.specifier} (${why})`)
    }
  }
  // The guard comes FIRST, ahead of both actions. It has to: a snapshot recorded
  // from a stale tree would write a public-surface fact into the repo that the
  // source no longer produces — a wrong fact, not a temporary one. `--update`'s
  // lawful use is "build, then re-record the published surface", and a stale
  // tree cannot re-record because that discipline is the point.
  const stale = staleSurfaces(root, reads)
  if (stale.length > 0) {
    error(`verify-api-snapshot: STALE — ${stale.length} package(s) whose declaration artifacts are older than their sources; refusing to compare or re-record, because the bytes read do not describe the tree they name. Build first: pnpm run build`)
    for (const entry of stale) error(`  - ${entry.name}: src/ is newer than ${entry.file}`)
    return 1
  }
  if (update) {
    mkdirSync(dirname(snapshotPath), { recursive: true })
    writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`)
    log(`verify-api-snapshot: recorded ${Object.keys(current).length} package surfaces → scripts/api-snapshot.json${scope}`)
    reportSkipped()
    return 0
  }
  if (!existsSync(snapshotPath)) {
    error('verify-api-snapshot: scripts/api-snapshot.json is missing — run with --update after reviewing the surface')
    return 1
  }
  const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  const problems = apiProblems(recorded, current)
  if (problems.length > 0) {
    error('verify-api-snapshot: the public API surface changed:')
    for (const problem of problems) error(`  - ${problem}`)
    error('Review the change, then re-record with: node scripts/verify-api-snapshot.mjs --update')
    return 1
  }
  const subpaths = Object.values(current).reduce((sum, surface) => sum + Object.keys(surface).length, 0)
  const symbols = Object.values(current).reduce((sum, surface) => sum + Object.values(surface).reduce((n, s) => n + Object.keys(s).length, 0), 0)
  log(`verify-api-snapshot: OK — ${Object.keys(current).length} package surfaces, ${subpaths} export subpaths, ${symbols} symbol signatures unchanged${scope}`)
  reportSkipped()
  return 0
}

// Importable for the script tests without executing the gate.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(verify({ update: process.argv.includes('--update') }))
}
