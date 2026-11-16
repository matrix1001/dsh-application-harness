#!/usr/bin/env node
/**
 * Runtime dependency check (dsh-web #5): scan a package's SHIPPED module graph —
 * the `exports` subpaths' entries plus the chunks they load — for bare imports.
 * Anything not a node: builtin and not relative must be declared in that
 * package's `dependencies` (or `peerDependencies`/`optionalDependencies`), or
 * the user's boot fails with ERR_MODULE_NOT_FOUND (issue #70 实证的整类缺陷).
 *
 * Two faces used to be skipped wholesale, and a skip that prints nothing reads
 * exactly like a pass (AR2″a, `runtime-deps-skips-workspace-and-lib-types`):
 *
 * - `@deepseek-ai/*`. A workspace/platform package is still a package: an
 *   undeclared one is a defect the profile's `link:` install cannot paper over.
 *   The rule is now the same as for any other bare specifier — the PACKAGE NAME
 *   (scope + first segment, so `@matrix1001/dsh-application-harness-store/atomic` answers
 *   to `@matrix1001/dsh-application-harness-store`) must be declared, or be one of the
 *   seed entries the loader module table answers.
 * - The declaration face. The declarations an `exports` subpath exposes, plus
 *   the ones they import, are what a consumer typechecks against; a bare
 *   specifier there must be declared in ANY of the four sections —
 *   devDependencies included, because a type-only edge is erased at runtime and
 *   this repo puts those edges there on purpose (`packages/client/AGENTS.md`
 *   rule 3, enforced by verify-client-peer-shape). Seeds are NOT exempt here: a
 *   seed is a runtime answer from the loader module table, not a resolution for
 *   the consumer's typechecker.
 *
 * What the gate still does not judge, it NAMES and COUNTS instead of passing
 * over in silence: a browser bundle's specifiers are answered by the loader
 * module table (`verify-client-factory` asserts exactly that), the compiler's
 * intermediates under `lib/types/**` are the bundler's input rather than a
 * shipped module, declarations no subpath exposes belong to a source that is
 * gone, and a package with no `lib/` build has no face to read at all.
 * `--self-test` runs the checker over synthetic fixtures and must trip it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The package areas this deployment owns, in scan order. */
export const PACKAGE_GROUPS = ['application', 'client', 'examples', 'bundle']

/**
 * Package areas deliberately outside the scan — named so the omission is
 * visible in the gate's own output rather than an absence nobody sees.
 */
export const OUTSIDE_AREAS = [
  ['packages/typert/protocol', 'the vendored build-only typert shell: no deployment manifest, never installed by the profile'],
]

/**
 * Platform seeds whose packages the loader module table answers (never
 * node_modules): the entries `packages/client/tsdown.client.ts` externalizes.
 * Their contract is asserted by verify-client-factory, not by package manifests.
 */
export const PLATFORM_SEEDS = new Set(['react', 'react-dom', '@deepseek-ai/cordis'])

/** The sections that answer a RUNTIME import: a consumer installs these, never `devDependencies`. */
const RUNTIME_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies']

/**
 * The sections that answer a TYPE import: declaration files are erased at
 * runtime, so a type-only edge lives in `devDependencies` here by policy.
 */
const TYPE_SECTIONS = [...RUNTIME_SECTIONS, 'devDependencies']

/**
 * The package name a bare specifier resolves to — scope + first segment for a
 * scoped name, the first segment otherwise (`react/jsx-runtime` → `react`).
 * @param specifier - the bare specifier.
 * @returns the package name.
 */
export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Bare specifiers one module file imports (import … from / require / export … from).
 * Seeds are NOT filtered here: the module table answers a runtime specifier,
 * not the typechecker of whoever consumes a declaration, so each face decides.
 * @param source - the module text.
 * @returns the bare specifiers.
 */
export function bareImports(source) {
  const found = new Set()
  const re = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"./][^'"]*)['"]|require\(['"]([^'"./][^'"]*)['"]\)/g
  for (const match of source.matchAll(re)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined) continue
    if (specifier.startsWith('node:')) continue
    found.add(specifier)
  }
  return found
}

/** Every file under `dir` whose name ends with `suffix`, recursively (an absent directory yields none). */
function filesUnder(dir, suffix) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path)
  }
  return found
}

/**
 * The build artifacts a package SHIPS: every `exports` subpath's `default`
 * target that resolves to a `.js` file. This is the runtime face's scope, and
 * it is deliberately not "everything under lib/": `lib/types/**\/*.js` is the
 * compiler's intermediate output which tsdown bundles INTO these entries, so
 * its specifiers are resolved by the bundler, never by node.
 * @param dir - the package directory.
 * @returns the entry files, plus the browser bundle's path when there is one.
 */
function entriesOf(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entries = []
  const declarations = []
  let bundle
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target !== 'object' || target === null) continue
    if (typeof target.types === 'string' && target.types.endsWith('.d.ts') && existsSync(join(dir, target.types))) {
      declarations.push(join(dir, target.types))
    }
    const file = target.default
    if (typeof file !== 'string' || !file.endsWith('.js')) continue
    const path = join(dir, file)
    if (!existsSync(path)) continue
    if (subpath === './client') bundle = path
    else entries.push(path)
  }
  return { entries, declarations, bundle }
}

/**
 * The module graph one file loads through RELATIVE edges, transitively.
 * @param entry - the entry file.
 * @param inside - the directory the walk may not leave.
 * @param extension - the specifier extension the graph is written in (`js` for
 * a shipped bundle, `ts` for declarations, which the compiler emits as `.d.ts`).
 * @returns the absolute files in the graph.
 */
function reachableFrom(entry, inside, extension) {
  const found = new Set()
  const queue = [entry]
  const pattern = new RegExp(`(?:from|import|require\\()\\s*['"](\\.[^'"]+\\.${extension})['"]`, 'g')
  while (queue.length > 0) {
    const file = queue.pop()
    if (found.has(file)) continue
    found.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) {
      const path = extension === 'js' ? resolve(dirname(file), match[1]) : declarationPath(file, match[1])
      if (path !== undefined && path.startsWith(inside) && existsSync(path)) queue.push(path)
    }
  }
  return found
}

/**
 * The emitted declaration one relative declaration import resolves to:
 * `./run.ts` and `./run.js` both name `run.d.ts`.
 * @param fromFile - the declaration file the edge was read from.
 * @param specifier - the relative specifier.
 * @returns the declaration path.
 */
function declarationPath(fromFile, specifier) {
  return resolve(dirname(fromFile), specifier.replace(/\.[cm]?[jt]sx?$/u, '.d.ts'))
}

/**
 * Check one package's two faces.
 * @param dir - the package directory.
 * @returns the package name, its problems, and what the scan actually read.
 */
export function checkPackage(dir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return { name: dir, problems: [`unreadable package manifest (${join(dir, 'package.json')})`], scanned: emptyScan() }
  }
  const declared = (sections) => new Set(sections.flatMap((section) => Object.keys(manifest[section] ?? {})))
  const runtimeDeclared = declared(RUNTIME_SECTIONS)
  const typeDeclared = declared(TYPE_SECTIONS)
  const self = manifest.name
  const libDir = join(dir, 'lib')
  const scanned = emptyScan()
  const problems = []
  if (!existsSync(libDir)) {
    // No build output: neither face exists to read. The caller counts these, so
    // "the package passed" is never confused with "the package was not looked at".
    scanned.unbuilt = true
    return { name: manifest.name, problems, scanned }
  }
  const { entries, declarations, bundle } = entriesOf(dir)
  const shipped = new Set()
  for (const entry of entries) for (const file of reachableFrom(entry, libDir, 'js')) shipped.add(file)
  const exposed = new Set()
  for (const entry of declarations) for (const file of reachableFrom(entry, libDir, 'ts')) exposed.add(file)
  if (bundle !== undefined) { scanned.bundles += 1 }
  // What lib/ holds but no consumer can reach: the compiler's intermediates
  // (tsdown bundles them into the entries) and declarations left behind by a
  // deleted source. Counted, so the exclusion is visible rather than an absence.
  for (const file of filesUnder(libDir, '.js')) if (!shipped.has(file) && file !== bundle) scanned.intermediates += 1
  for (const file of filesUnder(libDir, '.d.ts')) if (!exposed.has(file)) scanned.strayDeclarations += 1
  for (const file of shipped) {
    scanned.runtimeFiles += 1
    for (const specifier of bareImports(readFileSync(file, 'utf8'))) {
      scanned.runtimeSpecifiers += 1
      const name = packageNameOf(specifier)
      if (self !== undefined && name === self) continue
      if (PLATFORM_SEEDS.has(name)) { scanned.seedExemptions += 1; continue }
      if (!runtimeDeclared.has(name)) {
        problems.push(`${relative(dir, file)}: imports undeclared ${JSON.stringify(specifier)} (declare ${JSON.stringify(name)} in dependencies/peerDependencies/optionalDependencies — devDependencies are not installed for a consumer)`)
      }
    }
  }
  for (const file of exposed) {
    scanned.typeFiles += 1
    for (const specifier of bareImports(readFileSync(file, 'utf8'))) {
      scanned.typeSpecifiers += 1
      const name = packageNameOf(specifier)
      if (self !== undefined && name === self) continue
      if (!typeDeclared.has(name)) {
        problems.push(`${relative(dir, file)}: declaration imports undeclared ${JSON.stringify(specifier)} (declare ${JSON.stringify(name)} in any dependency section — a consumer typechecking against this surface cannot resolve it)`)
      }
    }
  }
  return { name: manifest.name, problems, scanned }
}

/** A fresh scan tally. */
function emptyScan() {
  return { runtimeFiles: 0, runtimeSpecifiers: 0, typeFiles: 0, typeSpecifiers: 0, bundles: 0, intermediates: 0, strayDeclarations: 0, seedExemptions: 0, unbuilt: false }
}

/** Every workspace package directory the scan covers, in a stable order. */
export function packagesToScan(root) {
  const packages = []
  for (const group of PACKAGE_GROUPS) {
    const groupDir = join(root, 'packages', group)
    if (!existsSync(groupDir)) continue
    for (const dir of readdirSync(groupDir)) {
      if (existsSync(join(groupDir, dir, 'package.json'))) packages.push(join(groupDir, dir))
    }
  }
  return packages
}

/**
 * Run the check over a workspace.
 * @param {{ root?: string, log?: (line: string) => void, error?: (line: string) => void }} [options] - the workspace root and the log seats.
 * @returns the exit code (0 = every readable face is declared, 1 = a problem).
 */
export function verify({ root = ROOT, log = console.log, error = console.error } = {}) {
  log('verify-runtime-deps: committed lib imports vs declared dependencies')
  const packages = packagesToScan(root)
  const total = emptyScan()
  const unbuilt = []
  let failed = 0
  for (const dir of packages) {
    const { name, problems, scanned } = checkPackage(dir)
    for (const key of Object.keys(total)) if (typeof total[key] === 'number') total[key] += scanned[key]
    if (scanned.unbuilt) unbuilt.push(name)
    if (problems.length > 0) {
      error(`  ✘ ${name}:`)
      for (const problem of problems) error(`      ${problem}`)
      failed++
    } else {
      log(`  ✓ ${name}`)
    }
  }
  // The faces this gate does NOT judge are printed, not passed over: a gate that
  // silently narrowed its own coverage would keep reporting the same sentence.
  for (const [area, reason] of OUTSIDE_AREAS) {
    if (existsSync(join(root, area))) log(`  ◦ ${area} outside the scan — ${reason}`)
  }
  log(`  ◦ ${total.seedExemptions} import(s) of a platform seed taken as answered by the loader module table (${[...PLATFORM_SEEDS].sort().join(', ')}) — the seeds are runtime answers, so they are NOT exempt on the types face`)
  log(`  ◦ ${total.bundles} browser bundle(s) skipped — their specifiers are the loader module table's, asserted by verify-client-factory`)
  log(`  ◦ ${total.intermediates} compiler-intermediate .js file(s) outside the shipped module graph were not scanned (tsdown bundles them into the entries)`)
  log(`  ◦ ${total.strayDeclarations} declaration file(s) no exports subpath exposes were not scanned (a deleted source's leftovers — \`clean: false\` keeps them in lib/)`)
  if (unbuilt.length > 0) {
    log(`  ◦ ${unbuilt.length} package(s) with no lib/ build, neither face judged: ${unbuilt.join(', ')}`)
  }
  const faces = `runtime face ${total.runtimeSpecifiers} specifier(s) over ${total.runtimeFiles} file(s); types face ${total.typeSpecifiers} specifier(s) over ${total.typeFiles} file(s)`
  if (failed > 0) {
    error(`verify-runtime-deps: ${failed} package(s) with undeclared imports (${faces})`)
    return 1
  }
  log(`verify-runtime-deps: ${packages.length} packages OK (${faces})`)
  return 0
}

function selfTest() {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-rundeps-selftest-'))
  try {
    const dir = join(dest, 'pkg')
    mkdirSync(join(dir, 'lib', 'types'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'selftest',
      exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
      dependencies: { '@matrix1001/dsh-application-harness-ok': 'workspace:*' },
    }))
    writeFileSync(join(dir, 'lib', 'index.js'), [
      "import leftPad from 'left-pad'",
      "import 'node:fs'",
      "import '@matrix1001/dsh-application-harness-ok/atomic'",
      "import '@matrix1001/dsh-application-harness-typo/atomic'",
      "import 'react'",
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'lib', 'types', 'index.d.ts'), [
      "import type { ApplicationValue } from '@matrix1001/dsh-application-harness-undeclared-types';",
      '',
    ].join('\n'))
    const { problems } = checkPackage(dir)
    const trips = [
      ['left-pad', /left-pad/u],
      ['an undeclared @deepseek-ai package name (the face that used to be skipped)', /application-harness-typo/u],
      ['an undeclared declaration-face import', /application-harness-undeclared-types/u],
    ]
    for (const [what, pattern] of trips) {
      if (!problems.some((problem) => pattern.test(problem))) {
        throw new Error(`self-test did not trip the checker on ${what} (got: ${problems.join('; ') || 'no problems'})`)
      }
    }
    for (const [what, pattern] of [['a declared workspace subpath', /application-harness-ok/u], ['a platform seed', /react/u], ['a node: builtin', /node:fs/u]]) {
      if (problems.some((problem) => pattern.test(problem))) {
        throw new Error(`self-test reported ${what} as a problem (got: ${problems.join('; ')})`)
      }
    }
    console.log('  ✓ self-test trips the checker on all three faces and clears the declared ones')
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

// Importable for the script tests; the CLI runs the check (or its own self-test).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--self-test')) selfTest()
  else process.exit(verify())
}
