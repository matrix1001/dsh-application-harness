#!/usr/bin/env node
/**
 * Do the platform symbols our client packages import still exist on the
 * checkout we launch?
 *
 * Nothing else in this repo can answer that. Our client sources import the
 * platform's *atom* surface — the icon set and locale keys of
 * `@deepseek-ai/dsh-client-ui-primitives`, the slot faces of
 * `@deepseek-ai/dsh-client-ui-slots` — and that surface carries no
 * compatibility promise: the 0.1.6 line renamed `IconSendOutline16` →
 * `IconPaperPlaneOutline14` and dropped two locale keys, and we missed both by
 * luck, not by machinery. `tsc`, `build` and every gate resolve the version we
 * *pinned* under `node_modules`, so a green build proves the pinned copy — it
 * says nothing about the checkout the profile actually links and launches.
 * This script compares the two planes directly: every named symbol our client
 * sources import from a `@deepseek-ai/dsh*` specifier against the export set of
 * that package's `src` on the checkout.
 *
 * It is a **checklist step, not a gate**: it needs a checkout, and CI has none.
 * Run it by hand against any checkout when the platform line is bumped — the
 * historical line-bump checklist (§"PL6 · 周期符号核对") lives only in git
 * history now, and this check is not part of `release:check`.
 *
 * Semantics — fail-open is the first principle (a false MISSING costs more than
 * a miss: it teaches the reader to skim, and then the check is deleted):
 *
 * - `export * from '<spec>'` re-exports: followed when the specifier resolves
 *   inside the package (the icon set is reached this way — `src/index.ts`
 *   re-exports `./icons/index.tsx`), otherwise the package's export set is
 *   **unknown** and nothing in it is ever reported missing.
 * - Import shapes we cannot turn into a symbol name (default bindings,
 *   `import * as ns`, side-effect imports) contribute no check.
 * - A package with no readable `src` tree, a specifier we cannot locate on the
 *   line, and a subpath with no source counterpart (a generated face, e.g.
 *   typert `/remote`) are **skipped and counted** — the summary line always
 *   prints how much was checked and how much was skipped, because a green line
 *   that quietly checked nothing is this script's own worst failure mode.
 *
 * The scan is deliberately text-based rather than parser-based: `scripts/*.mjs`
 * carry no build step, the forms it reads are the ones our sources write
 * (`type`-prefixed members, `as` aliases, `import type { … }`, multi-line
 * braces), and every parse miss is a miss in the safe direction. Comments are
 * blanked first (they legitimately contain example imports and exports), and an
 * import statement is only read at the start of a line — a string literal
 * quoting an import is not one.
 *
 * Usage: `node scripts/check-platform-symbols.mjs [--checkout <path>] [--json]`
 * No checkout → `UNVERIFIED`, exit 0 (the `vendor-platform-src --check`
 * convention). Missing symbols → exit 1.
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutRoot } from './platform-checkout.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The platform's naming convention — the same filter as `verify-platform-package-set`. */
const PLATFORM_SPECIFIER = /^@deepseek-ai\/dsh(-|$)/u

/** Source extensions we read on both sides. */
const SOURCE_FILE = /\.tsx?$/u

/** How deep a `export * from` chain is followed before the set counts as unknown. */
const MAX_STAR_DEPTH = 8

/** How deep a checkout is scanned for package manifests (`packages/<group>/<pkg>`). */
const MAX_MANIFEST_DEPTH = 3

/**
 * An `import …{ … } from '<specifier>'` statement, at the start of a line.
 * Braces are required, so a default-only or namespace import never matches;
 * the leading binding is optional so `import Foo, { A } from '<spec>'` reads
 * `A`. Non-greedy, so the brace group may span lines but stops at the first
 * `}` — which is why an import statement is only recognized when it opens with
 * `import` (a `}` on a later line cannot pull a following statement in).
 */
const IMPORT_STATEMENT = /^[ \t]*import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/gmu

/**
 * `export const|function|class|… <Name>` (incl. `export declare`, `export
 * abstract class`, `export async function`).
 */
const EXPORT_DECLARATION = /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gu

/** `export { A, B as C }`, `export type { A }` — the exported name is the one after `as`. */
const EXPORT_LIST = /export\s+(?:type\s+)?\{([^}]*)\}/gu

/** `export * as ns from '<spec>'` — the namespace name is exported. */
const EXPORT_NAMESPACE_STAR = /export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/gu

/** `export * from '<spec>'` (incl. `export type * from`) — the one form we must follow or fail open on. */
const EXPORT_STAR = /export\s+(?:type\s+)?\*\s+from\s*['"]([^'"]+)['"]/gu

/**
 * Blank out comments, keeping every offset (and newline) in place so line
 * numbers stay exact. Strings are deliberately left alone: import specifiers
 * *are* string literals, and the statement-start rule already keeps a quoted
 * import in a template from being read as one.
 * @param text - the source text.
 * @returns the text with comments replaced by spaces.
 */
function stripComments(text) {
  const chars = text.split('')
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (chars[index] !== '\n') chars[index] = ' '
  }
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    const next = chars[index + 1]
    if (char === '/' && next === '/') {
      let end = index
      while (end < chars.length && chars[end] !== '\n') end += 1
      blank(index, end)
      index = end
      continue
    }
    if (char === '/' && next === '*') {
      let end = index + 2
      while (end < chars.length && !(chars[end] === '*' && chars[end + 1] === '/')) end += 1
      const stop = Math.min(end + 2, chars.length)
      blank(index, stop)
      index = stop
      continue
    }
    index += 1
  }
  return chars.join('')
}

/**
 * The line a text offset sits on (1-based).
 * @param text - the source text.
 * @param offset - the offset.
 * @returns the line number.
 */
function lineAt(text, offset) {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) if (text[index] === '\n') line += 1
  return line
}

/**
 * Every named import in a source text, with the specifier it came from, the
 * names it binds and the line it is written on. Aliases contribute the
 * **original** name (`{ Button as B }` → `Button`), because that is the
 * platform's symbol; `type ` members and `import type { … }` are ordinary names
 * here (a type that only exists in the pinned copy is exactly the drift this
 * script looks for). A statement binding nothing (`import type {} from '<spec>'`,
 * the declaration-merge form our view packages use) is kept with an empty
 * symbol list: it is still a dependency on the platform, and dropping it would
 * make the summary's specifier count a quiet lie.
 * @param sourceText - the file's text.
 * @returns `{ specifier, symbols, line }` records, in source order.
 */
function importSites(sourceText) {
  const code = stripComments(sourceText)
  const sites = []
  for (const match of code.matchAll(IMPORT_STATEMENT)) {
    const [, members, specifier] = match
    const symbols = []
    for (const raw of members.split(',')) {
      const cleaned = raw.trim().replace(/^type\s+/u, '')
      if (cleaned === '') continue
      const symbol = cleaned.split(/\s+as\s+/u)[0].trim()
      if (symbol === '') continue
      symbols.push(symbol)
    }
    sites.push({ specifier, symbols, line: lineAt(code, match.index) })
  }
  return sites
}

/**
 * The named imports of one specifier.
 * @param sourceText - the file's text.
 * @param specifier - the module specifier to collect from.
 * @returns the imported names, deduplicated, in source order.
 */
export function importedSymbols(sourceText, specifier) {
  const names = new Set()
  for (const site of importSites(sourceText)) {
    if (site.specifier !== specifier) continue
    for (const symbol of site.symbols) names.add(symbol)
  }
  return [...names]
}

/**
 * The names a set of source texts exports. `texts` entries are either plain
 * strings or `{ path, text }` records — the path is handed to `resolveStar` so
 * a relative re-export can be resolved against its importer.
 * @param texts - the source texts (strings or `{ path, text }`).
 * @param options - `resolveStar(specifier, fromPath)`: the texts a star
 * re-export pulls in, `[]` when the target is known but contributes nothing
 * new, `undefined` when it cannot be followed at all (which opens the set).
 * @returns `{ open, names }` — `open` means the set is incomplete and a lookup
 * miss proves nothing.
 */
export function exportedNames(texts, { resolveStar, depth = 0 } = {}) {
  const names = new Set()
  let open = false
  // A bare string is one text. Iterating it would walk characters and return an
  // empty set — which reads as "nothing is exported" and would report every
  // imported symbol as missing: the one failure direction this script must
  // never take.
  for (const entry of typeof texts === 'string' ? [texts] : texts) {
    const text = typeof entry === 'string' ? entry : entry.text
    const path = typeof entry === 'string' ? undefined : entry.path
    const code = stripComments(text)
    for (const match of code.matchAll(EXPORT_DECLARATION)) names.add(match[1])
    for (const match of code.matchAll(EXPORT_LIST)) {
      for (const raw of match[1].split(',')) {
        const cleaned = raw.trim().replace(/^type\s+/u, '')
        if (cleaned === '') continue
        const parts = cleaned.split(/\s+as\s+/u)
        const exported = parts[parts.length - 1].trim()
        if (exported !== '') names.add(exported)
      }
    }
    for (const match of code.matchAll(EXPORT_NAMESPACE_STAR)) names.add(match[1])
    for (const match of code.matchAll(EXPORT_STAR)) {
      const nested = depth >= MAX_STAR_DEPTH ? undefined : resolveStar?.(match[1], path)
      if (nested === undefined) {
        // Unfollowed re-export: the package may export anything. Never report
        // a symbol missing against an unknown set.
        open = true
        continue
      }
      const inner = exportedNames(nested, { resolveStar, depth: depth + 1 })
      if (inner.open) open = true
      for (const name of inner.names) names.add(name)
    }
  }
  return { open, names: [...names] }
}

/**
 * The imported symbols an export set cannot account for.
 * @param sets - `imports`: `{ symbol }` records; `exports`: an `exportedNames` result.
 * @returns the missing symbol names, deduplicated, in first-seen order.
 */
export function missingSymbols({ imports, exports }) {
  if (exports?.open === true) return []
  const names = new Set(exports?.names ?? [])
  const seen = new Set()
  const missing = []
  for (const { symbol } of imports) {
    if (names.has(symbol) || seen.has(symbol)) continue
    seen.add(symbol)
    missing.push(symbol)
  }
  return missing
}

/**
 * Every source file under a directory, sorted (walk order must not leak into
 * the report).
 * @param dir - the directory.
 * @returns absolute file paths.
 */
function sourceFiles(dir) {
  const files = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  walk(dir)
  return files
}

/**
 * The platform specifiers and symbols our client sources import — the reference
 * plane. Our own packages (`@matrix1001/dsh-application-harness-*`), relative imports and
 * `@deepseek-ai/cordis` edges are out of scope by the platform-name filter.
 * @param root - the repo root.
 * @returns `{ specifier, symbols, file, line }` records, in scan order.
 */
export function clientPlatformImports(root = ROOT) {
  const sites = []
  const clients = join(root, 'packages', 'client')
  if (!existsSync(clients)) return sites
  for (const group of readdirSync(clients).sort()) {
    const src = join(clients, group, 'src')
    if (!existsSync(src)) continue
    for (const file of sourceFiles(src)) {
      for (const site of importSites(readFileSync(file, 'utf8'))) {
        // `test` on a global regex is stateful; `PLATFORM_SPECIFIER` carries no
        // `g` flag, so it is safe to call per site.
        if (!PLATFORM_SPECIFIER.test(site.specifier)) continue
        sites.push({ ...site, file: relative(root, file) })
      }
    }
  }
  return sites
}

/**
 * The package part of a platform specifier (`@deepseek-ai/dsh-client-ui-slots/client`
 * → `@deepseek-ai/dsh-client-ui-slots`), which is what carries a name.
 * @param specifier - the module specifier.
 * @returns the package name.
 */
function packageNameOf(specifier) {
  return specifier.split('/').slice(0, 2).join('/')
}

/**
 * The subpath of a platform specifier, if any (`…/client` → `client`).
 * @param specifier - the module specifier.
 * @returns the subpath, or undefined for the package root.
 */
function subpathOf(specifier) {
  const segments = specifier.split('/').slice(2)
  return segments.length === 0 ? undefined : segments.join('/')
}

/**
 * A checkout's package directories, keyed by the name in each manifest. The
 * manifest is the authority — the directory name is not the package name
 * (`dsh-client-locale` lives in `packages/client/locale`). First name wins, and
 * a directory holding a manifest is not descended into (platform fixtures carry
 * manifests of their own).
 *
 * Entries are walked in name order: "first name wins" makes the walk order a
 * verdict input, and `readdir` order is filesystem-dependent — today's checkout
 * has no duplicate names, so the tie never breaks, but a future duplicate must
 * resolve the same way on every machine (a nondeterministic verdict is the
 * shape this repo bans, not the tie itself). Sorting segment-wise at each level
 * makes the whole walk a deterministic pre-order by path.
 * @param checkout - the platform checkout root.
 * @returns a Map from package name to absolute directory.
 */
export function platformPackageDirs(checkout) {
  const dirs = new Map()
  const walk = (dir, depth) => {
    if (depth > MAX_MANIFEST_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const child = join(dir, entry.name)
      const manifest = join(child, 'package.json')
      if (existsSync(manifest)) {
        try {
          const name = JSON.parse(readFileSync(manifest, 'utf8')).name
          if (typeof name === 'string' && name !== '' && !dirs.has(name)) dirs.set(name, child)
        } catch {
          // An unreadable manifest names nothing; the package is simply absent.
        }
        continue
      }
      walk(child, depth + 1)
    }
  }
  walk(checkout, 1)
  return dirs
}

/**
 * The exported names of one checkout package, read from its `src` tree.
 *
 * The whole tree is scanned, not the entry file: the specifier's subpath
 * (`…/client`) maps to a source directory through the package's own `exports`
 * map, and a cross-file re-export is ordinary there. Reading everything makes
 * the set *larger*, which is the safe direction — a symbol exported anywhere in
 * the package is one a client can import.
 * @param options - `dirs` (name → directory), `name`, and injectable `readFile`.
 * @returns `{ open, names }`, or `undefined` when there is no `src` tree to
 * read (the package cannot be judged from source — a generated face).
 */
export function packageSymbols({ dirs, name, readFile = readFileSync }) {
  const dir = dirs.get(name)
  if (dir === undefined) return undefined
  const src = join(dir, 'src')
  if (!existsSync(src)) return undefined
  const files = sourceFiles(src)
  if (files.length === 0) return undefined
  const texts = files.map((path) => {
    try {
      return { path, text: readFile(path, 'utf8') }
    } catch {
      return { path, text: '' }
    }
  })
  const byPath = new Map(texts.map((entry) => [entry.path, entry]))
  const expanded = new Set()
  const resolveStar = (specifier, fromPath) => {
    if (!specifier.startsWith('.')) return undefined
    const base = fromPath === undefined ? src : dirname(fromPath)
    for (const candidate of [specifier, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`]) {
      const target = resolve(base, candidate)
      const known = byPath.get(target)
      if (known !== undefined) {
        // Already part of the scanned tree: its names are collected either way.
        if (expanded.has(target)) return []
        expanded.add(target)
        return [known]
      }
      // A source outside the `src` tree but still readable on disk counts too.
      if (target.startsWith(`${dir}/`) && existsSync(target)) {
        if (expanded.has(target)) return []
        expanded.add(target)
        try {
          return [{ path: target, text: readFile(target, 'utf8') }]
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }
  return exportedNames(texts, { resolveStar })
}

/**
 * The verdict for one specifier: its symbol set, or why it cannot be judged.
 * @param options - the checkout package dirs, the specifier, and the package-wide sets.
 * @returns `{ symbols }` or `{ skip }`.
 */
function specifierVerdict({ dirs, specifier, symbolsByName }) {
  const name = packageNameOf(specifier)
  const dir = dirs.get(name)
  if (dir === undefined) return { skip: 'not found on the line' }
  const subpath = subpathOf(specifier)
  if (subpath !== undefined) {
    // A subpath without a source counterpart is a generated face (the typert
    // `/remote` contracts): its symbols are not in `src`, so reading `src`
    // would invent MISSING verdicts. Skip it.
    const source = join(dir, 'src', subpath)
    if (!existsSync(`${source}.ts`) && !existsSync(`${source}.tsx`) && !existsSync(join(source, 'index.ts')) && !existsSync(join(source, 'index.tsx'))) {
      return { skip: `subpath ./${subpath} has no src counterpart` }
    }
  }
  const symbols = symbolsByName.get(name)
  if (symbols === undefined) return { skip: 'no src tree to read' }
  if (symbols.open) return { skip: 'open (export * not followed)' }
  return { symbols }
}

/**
 * Run the check.
 * @param options - `root`, `checkout` (undefined = none), `json`, and the log seats.
 * @returns the exit code (1 = a symbol is missing, 0 otherwise).
 */
export function verify({ root = ROOT, checkout, json = false, log = console.log, error = console.error } = {}) {
  const imports = clientPlatformImports(root)
  const lines = []
  const out = (line) => lines.push(line)
  if (checkout === undefined) {
    const symbols = new Set(imports.flatMap((site) => site.symbols)).size
    const message = `check-platform-symbols: UNVERIFIED — no platform checkout; run the line-bump checklist step ⑥ where one exists (${symbols} platform symbol(s) our client packages import were left unchecked)`
    if (json) {
      log(JSON.stringify({ status: 'unverified', checkout: undefined, specifiers: 0, symbols: 0, missing: [], skipped: [] }, undefined, 2))
      return 0
    }
    log(message)
    return 0
  }

  const dirs = platformPackageDirs(checkout)
  const specifiers = [...new Set(imports.map((site) => site.specifier))].sort()
  const symbolsByName = new Map()
  for (const specifier of specifiers) {
    const name = packageNameOf(specifier)
    if (symbolsByName.has(name)) continue
    symbolsByName.set(name, packageSymbols({ dirs, name }))
  }
  const missing = []
  const skipped = []
  let checked = 0
  let skippedSymbols = 0
  let checkedSpecifiers = 0
  for (const specifier of specifiers) {
    const statements = imports.filter((site) => site.specifier === specifier)
    // Counted per distinct symbol, not per import statement: the same name
    // imported in a dozen files was still one symbol checked.
    const symbols = [...new Set(statements.flatMap((site) => site.symbols))]
    const verdict = specifierVerdict({ dirs, specifier, symbolsByName })
    if (verdict.skip !== undefined) {
      skippedSymbols += symbols.length
      skipped.push({ specifier, reason: verdict.skip, symbols: symbols.length })
      out(`  SKIP ${specifier}: ${verdict.skip} — ${symbols.length} symbol(s) not checked`)
      continue
    }
    checkedSpecifiers += 1
    checked += symbols.length
    for (const symbol of missingSymbols({ imports: symbols.map((symbol) => ({ symbol })), exports: verdict.symbols })) {
      const site = statements.find((candidate) => candidate.symbols.includes(symbol))
      missing.push({ specifier, symbol, file: site.file, line: site.line })
      out(`  MISSING ${specifier}: ${symbol} (imported by ${site.file}:${site.line})`)
    }
  }

  const display = checkout.startsWith(homedir()) ? `~${checkout.slice(homedir().length)}` : checkout
  const verdict = missing.length === 0 ? 'OK' : 'FAIL'
  if (json) {
    log(JSON.stringify({
      status: verdict === 'OK' ? 'ok' : 'fail',
      checkout,
      specifiers: checkedSpecifiers,
      symbols: checked,
      missing,
      skipped,
    }, undefined, 2))
    return missing.length === 0 ? 0 : 1
  }
  if (missing.length > 0) {
    out('  a rename on the platform line arrives here first: fix the import site above, or move to the new symbol')
  }
  log([
    `check-platform-symbols: ${checkedSpecifiers} specifier(s) / ${checked} symbol(s) checked,`
    + ` skipped ${skippedSymbols} symbol(s) in ${skipped.length} specifier(s) — against ${display}`,
    ...lines,
    `check-platform-symbols: ${verdict} — ${missing.length} missing symbol(s)`,
  ].join('\n'))
  if (missing.length > 0) error(`check-platform-symbols: FAIL — ${missing.length} symbol(s) our client packages import do not exist on ${display}`)
  return missing.length === 0 ? 0 : 1
}

/** Parse the CLI and run. */
function main() {
  const argv = process.argv.slice(2)
  const index = argv.indexOf('--checkout')
  const explicit = index === -1 ? undefined : argv[index + 1]
  const configured = explicit ?? checkoutRoot()
  // The `.git` probe is the same "is this really a checkout" test as
  // `verify-platform-package-set`: a path without one is not a platform line,
  // and checking against it would invent missing symbols.
  const checkout = existsSync(join(configured, '.git')) ? configured : undefined
  process.exit(verify({ checkout, json: argv.includes('--json') }))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
