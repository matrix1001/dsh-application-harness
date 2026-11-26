#!/usr/bin/env node
/**
 * Materialize the test fixture from the installed platform line.
 *
 * A platform package's `./client` entry ships as a module-table bundle
 * (`window.__ModuleLoader__.load(...)`): importable in the browser shell, fatal
 * in Node. The same package ships its `src/`, so the two suites that exercise
 * the client plumbing (the applications panel and the git-browser plugin) run
 * against a copy of those sources, mapped by `tsconfig.test-paths.json`.
 *
 * The copy is a DERIVATIVE of the installed line, never a second source of
 * truth: it is generated from `node_modules`, its packages must all be at the
 * declared version, and `--check` fails when the tree drifts. The directory is
 * gitignored; `node scripts/deps.mjs`, `platform-line --set` and the `pretest`
 * hooks keep it in place.
 *
 * Usage:
 *   node scripts/sync-platform-fixture.mjs          # write / refresh
 *   node scripts/sync-platform-fixture.mjs --ensure # write only when missing
 *   node scripts/sync-platform-fixture.mjs --check  # verify, write nothing
 * @module scripts/sync-platform-fixture
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, '.platform-src')
const MARKER = join(FIXTURE, 'VERSION')
const DESCRIPTOR = join(ROOT, 'packages/bundle/app-harness/deployment.yml')

/** The packages whose `src/` the client test plane imports. */
export const FIXTURE_PACKAGES = [
  'dsh-api-gateway',
  'dsh-api-session-controller',
  'dsh-client-connection',
  'dsh-client-locale',
  'dsh-client-modules',
  'dsh-client-store',
  'dsh-client-test-runtime',
  'dsh-client-ui-chat',
  'dsh-client-ui-context-menu',
  'dsh-client-ui-conversation',
  'dsh-client-ui-renderer',
  'dsh-client-ui-session',
  'dsh-client-ui-session-status',
  'dsh-token-meter',
]

/** The declared platform line from the deployment descriptor. */
export function declaredLine(root = ROOT) {
  const line = /declaredLine:\s*(\S+)/u.exec(readFileSync(join(root, 'packages/bundle/app-harness/deployment.yml'), 'utf8'))?.[1]
  if (line === undefined) throw new Error('deployment.yml has no platform.declaredLine')
  return line
}

/**
 * The installed directory of one platform package (hoisted, else in the pnpm
 * store), or undefined when it is not installed.
 * @param {string} root - the repo root.
 * @param {string} name - the package name.
 * @returns {string | undefined} the package directory.
 */
export function installedDir(root, name) {
  const hoisted = join(root, 'node_modules', '@deepseek-ai', name)
  if (existsSync(join(hoisted, 'package.json'))) return hoisted
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith(`@deepseek-ai+${name}@`)) continue
    const nested = join(store, entry, 'node_modules', '@deepseek-ai', name)
    if (existsSync(join(nested, 'package.json'))) return nested
  }
  return undefined
}

/** Every file under `dir`, as POSIX paths relative to it, sorted. */
function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(abs, base))
    else out.push(relative(base, abs).split(sep).join('/'))
  }
  return out.sort()
}

/**
 * Resolve the installed sources for the fixture, refusing a package that is
 * missing, has no `src/`, or is not at the declared version.
 * @param {string} root - the repo root.
 * @param {string} line - the declared line.
 * @returns {{ name: string, dir: string, source: string }[]} the sources.
 */
export function fixtureSources(root = ROOT, line = declaredLine(root)) {
  const problems = []
  const sources = []
  for (const name of FIXTURE_PACKAGES) {
    const dir = installedDir(root, name)
    if (dir === undefined) { problems.push(`${name} is not installed — run: node scripts/deps.mjs`); continue }
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    if (version !== line) { problems.push(`${name} is ${version}, not the declared line ${line} — run: node scripts/deps.mjs`); continue }
    const source = join(dir, 'src')
    if (!existsSync(source)) { problems.push(`${name} ships no src/ — this package cannot serve as a test fixture`); continue }
    sources.push({ name, dir, source })
  }
  if (problems.length > 0) throw new Error(`the platform test fixture cannot be built:\n  ${problems.join('\n  ')}`)
  return sources
}

/**
 * Compare the fixture with the installed sources without writing.
 * @param {string} root - the repo root.
 * @param {string} line - the declared line.
 * @returns {{ problems: string[], files: number }} the drift and the file count.
 */
export function checkFixture(root = ROOT, line = declaredLine(root)) {
  const problems = []
  const marker = existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : undefined
  if (marker === undefined) problems.push(`${relative(root, MARKER)} is missing — run: node scripts/sync-platform-fixture.mjs`)
  else if (marker !== line) problems.push(`the fixture was built for ${marker}, the declared line is ${line} — run: node scripts/sync-platform-fixture.mjs`)
  let files = 0
  for (const { name, source } of fixtureSources(root, line)) {
    const dest = join(FIXTURE, name, 'src')
    if (!existsSync(dest)) { problems.push(`${name}: the fixture is missing`); continue }
    const theirs = listFiles(source)
    files += theirs.length
    for (const file of theirs) {
      const local = join(dest, file)
      if (!existsSync(local)) { problems.push(`${name}/src/${file}: missing`); continue }
      if (!readFileSync(local).equals(readFileSync(join(source, file)))) problems.push(`${name}/src/${file}: differs from the installed source`)
    }
    for (const file of listFiles(dest)) {
      if (!theirs.includes(file)) problems.push(`${name}/src/${file}: not in the installed source`)
    }
  }
  return { problems, files }
}

/**
 * Write (or refresh) the fixture from the installed sources.
 * @param {string} root - the repo root.
 * @param {string} line - the declared line.
 * @returns {{ files: number }} the copied file count.
 */
export function writeFixture(root = ROOT, line = declaredLine(root)) {
  const sources = fixtureSources(root, line)
  let files = 0
  for (const { name, source } of sources) {
    const dest = join(FIXTURE, name, 'src')
    rmSync(join(FIXTURE, name), { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(source, dest, { recursive: true })
    files += listFiles(dest).length
  }
  mkdirSync(FIXTURE, { recursive: true })
  writeFileSync(MARKER, `${line}\n`)
  return { files }
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const ensure = process.argv.includes('--ensure')
  try {
    const line = declaredLine(ROOT)
    if (checkOnly) {
      const { problems, files } = checkFixture(ROOT, line)
      if (problems.length > 0) {
        console.error(`sync-platform-fixture: FAIL — ${problems.length} problem(s)`)
        for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`)
        if (problems.length > 20) console.error(`  … ${problems.length - 20} more`)
        console.error('  fix: node scripts/sync-platform-fixture.mjs')
        process.exit(1)
      }
      console.log(`sync-platform-fixture: OK — ${files} file(s) match the installed platform line ${line}`)
      return
    }
    if (ensure) {
      // A marker alone does not prove the tree is complete: a branch switch can
      // remove generated files that were tracked on the other side. Reuse only
      // when the full comparison passes.
      try {
        if (checkFixture(ROOT, line).problems.length === 0) return
      } catch { /* fall through to a fresh write */ }
    }
    const { files } = writeFixture(ROOT, line)
    console.log(`sync-platform-fixture: wrote ${files} file(s) for ${FIXTURE_PACKAGES.length} package(s) from the installed line ${line}`)
  } catch (error) {
    console.error(`sync-platform-fixture: FAIL — ${String(error.message ?? error)}`)
    process.exit(1)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
