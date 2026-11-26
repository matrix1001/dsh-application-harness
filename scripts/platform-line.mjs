#!/usr/bin/env node
/**
 * The platform line as one mechanical fact: which published DSH version this
 * repository declares, every place that repeats it, and the one command that
 * moves them together.
 *
 * There is one line: a published `@deepseek-ai/dsh` version, whichever one the
 * latest release put on the registry. The repo consumes that release only:
 *
 *   - every `@deepseek-ai/dsh*` pin (dev, peer, optional) is that exact version;
 *   - every deployment package's `engines.dsh` is that exact version (the
 *     plugin is supported on the version it was built and tested against, and
 *     a newer runtime is refused rather than silently assumed compatible);
 *   - the resolver mirror list (`overrides`)
 *     carry that version;
 *   - the Typert protocol shell mirrors the installed protocol package's
 *     `src/` (the build plane's type face), with one local normalization.
 *
 * `--check` makes a mixed line loud; `--set` moves the whole plane, then
 * refreshes the shell from what the install produced. No checkout, tag commit
 * or vendored tree is involved: `node scripts/deps.mjs` is the only source.
 *
 * Usage:
 *   node scripts/platform-line.mjs --check [--json] [--no-registry]
 *   node scripts/platform-line.mjs --set <version> [--dry-run] [--no-install]
 *                                   [--allow-unpublished] [--no-registry]
 * @module scripts/platform-line
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { packageManifests } from './package-areas.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESCRIPTOR = 'packages/bundle/app-harness/deployment.yml'
const WORKSPACE = 'pnpm-workspace.yaml'
const SHELL_DIR = 'packages/typert/protocol'
const SHELL_SRC = join(SHELL_DIR, 'src')
const SHELL_NAME = '@deepseek-ai/dsh-typert-protocol'
const HARNESS_PREFIX = '@matrix1001/dsh-application-harness'
const PLATFORM_NAME = /^@deepseek-ai\/dsh(-|$)/u
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/**
 * Framework packages that move with the platform generation but are not named
 * `@deepseek-ai/dsh*`, so the platform-pin scan above does not see them. Their
 * manifest values must equal (or, for a range such as the Typert shell's peer,
 * be satisfied by) the installed version; otherwise a line bump leaves the
 * tested dependency set and the published manifest describing two generations.
 */
export const FRAMEWORK_PACKAGES = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
])

/** The installed version of one package, or undefined when it is not installed. */
function installedVersion(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** The local shell note appended after the cut augmentation (the checker strips it). */
const SHELL_NOTE = `// Local build-shell divergence: the platform declaration augments Cordis
// Context with \`typert\` and \`invocation\`. Keeping that augmentation here makes
// the Typert analyzer discover this shell as a service contributor; analyzing
// its \`TypertLookupMap\` then merges the published dsh-session augmentation from
// node_modules and fails the "declaration outside this face" check.
// This shell only supplies type-meta symbols to the build plane, our packages
// do not read ctx.typert/ctx.invocation, and the published protocol package
// (runtime/test plane) keeps the augmentation. \`platform-line --set\` refreshes
// this file from the installed line and cuts the augmentation.
`

/** Whether a package name belongs to the platform train. */
export function platformName(name) {
  return typeof name === 'string' && PLATFORM_NAME.test(name)
}

/** Whether a package is one of this repository's deployment packages. */
function harnessPackage(name) {
  return typeof name === 'string' && (name === HARNESS_PREFIX || name.startsWith(`${HARNESS_PREFIX}-`))
}

/** Every manifest the line lives in: the root plus each workspace package. */
export function manifestFiles(root = ROOT) {
  return [
    'package.json',
    ...packageManifests(root).map(file => relative(root, file).split('\\').join('/')),
  ].sort()
}

/** Read the declared line from the deployment descriptor. */
export function readDeclaredLine(root = ROOT) {
  const path = join(root, DESCRIPTOR)
  if (!existsSync(path)) throw new Error(`${DESCRIPTOR} is missing — the platform line has no source of truth`)
  const line = /declaredLine:\s*(\S+)/u.exec(readFileSync(path, 'utf8'))?.[1]
  if (line === undefined) throw new Error(`${DESCRIPTOR} has no platform.declaredLine`)
  return line
}

/** The platform entries of `pnpm-workspace.yaml`, with their line index. */
export function parseWorkspace(text) {
  const entries = []
  let section = ''
  text.split('\n').forEach((line, index) => {
    const top = /^([A-Za-z][\w-]*):/u.exec(line)
    if (top !== null) { section = top[1]; return }
    if (section === 'overrides') {
      const quote = /^(\s*")(@deepseek-ai\/dsh[^"]+)("\s*:\s*)(\S+)(\s*)$/u.exec(line)
      if (quote !== null) { entries.push({ kind: 'override', name: quote[2], version: quote[4], index }); return }
      const bare = /^(\s*)(@deepseek-ai\/dsh[^:\s]+)(:\s*)(\S+)(\s*)$/u.exec(line)
      if (bare !== null) entries.push({ kind: 'override', name: bare[2], version: bare[4], index })
    }
  })
  return entries
}

/** The shell's `types.ts` without the local note or the upstream augmentation. */
function normalizeShellTypes(text) {
  const markers = ["declare module '@deepseek-ai/cordis' {", '// Local build-shell divergence:']
  let cut = text.length
  for (const marker of markers) {
    const at = text.indexOf(marker)
    if (at !== -1) cut = Math.min(cut, at)
  }
  return text.slice(0, cut).replace(/\s+$/u, '')
}

/** The installed protocol package's source directory. */
function installedShellSource(root = ROOT) {
  return join(root, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'src')
}

/** Compare the local shell with the installed protocol source. */
export function shellProblems(root = ROOT) {
  const problems = []
  const upstream = installedShellSource(root)
  const local = join(root, SHELL_SRC)
  if (!existsSync(upstream)) return [`${upstream} is missing — run: node scripts/deps.mjs`]
  // The shell's own manifest is a manual surface: a platform release can add a
  // peer (0.2.3-alpha.2 added `@deepseek-ai/dsh-error`), and `--set` rewrites
  // only the `dsh*` versions it already knows. Compare the dependency sections
  // so a missing peer cannot pass every gate.
  const localManifestPath = join(root, SHELL_DIR, 'package.json')
  const installedManifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'package.json')
  try {
    const localManifest = JSON.parse(readFileSync(localManifestPath, 'utf8'))
    const installedManifest = JSON.parse(readFileSync(installedManifestPath, 'utf8'))
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const ours = localManifest[field] ?? {}
      const theirs = installedManifest[field] ?? {}
      for (const name of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
        if (ours[name] !== theirs[name]) {
          problems.push(`${SHELL_DIR}/package.json ${field}.${name} = ${String(ours[name] ?? '(absent)')} (installed ${String(theirs[name] ?? '(absent)')})`)
        }
      }
    }
  } catch (cause) {
    problems.push(`${SHELL_DIR}/package.json could not be compared with the installed protocol package: ${String(cause?.message ?? cause)}`)
  }
  for (const entry of readdirSync(upstream)) {
    if (!entry.endsWith('.ts')) continue
    const theirs = readFileSync(join(upstream, entry), 'utf8')
    const oursPath = join(local, entry)
    if (!existsSync(oursPath)) { problems.push(`${SHELL_SRC}/${entry} is missing`); continue }
    const ours = readFileSync(oursPath, 'utf8')
    const same = entry === 'types.ts' ? normalizeShellTypes(ours) === normalizeShellTypes(theirs) : ours === theirs
    if (!same) problems.push(`${SHELL_SRC}/${entry} does not match the installed protocol source`)
  }
  return problems
}

/** Rewrite the shell from the installed protocol package. */
function refreshShell(root = ROOT) {
  const upstream = installedShellSource(root)
  const local = join(root, SHELL_SRC)
  for (const entry of readdirSync(upstream)) {
    if (!entry.endsWith('.ts')) continue
    const text = readFileSync(join(upstream, entry), 'utf8')
    writeFileSync(join(local, entry), entry === 'types.ts' ? `${normalizeShellTypes(text)}\n\n${SHELL_NOTE}` : text)
  }
  return readdirSync(upstream).filter(entry => entry.endsWith('.ts')).length
}

/** Lines in live docs that still name another version of the same line. */
export function docWarnings(root = ROOT, line = readDeclaredLine(root)) {
  const family = line.includes('-') ? line.slice(0, line.indexOf('-')) : line
  const pattern = new RegExp(`${family.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-[0-9A-Za-z.-]+`, 'gu')
  const docs = ['README.md', 'AGENTS.md']
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name.endsWith('.md')) docs.push(resolve(abs).slice(root.length + 1))
    }
  }
  walk(join(root, 'docs'))
  const warnings = []
  for (const file of docs.sort()) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    readFileSync(path, 'utf8').split('\n').forEach((text, index) => {
      for (const match of text.matchAll(pattern)) {
        if (match[0] === line) continue
        if (match[0].includes('--')) continue // a shields.io badge escapes the hyphen
        warnings.push({ file, line: index + 1, found: match[0], text: text.trim().slice(0, 160) })
      }
    })
  }
  return warnings
}

/** Read the whole line surface. */
export function inspect(root = ROOT) {
  const line = readDeclaredLine(root)
  const pins = []
  const engines = []
  let shellVersion
  const framework = []
  const installed = new Map()
  for (const file of manifestFiles(root)) {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'))
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        if (platformName(name)) pins.push({ file, field, name, value })
        if (FRAMEWORK_PACKAGES.has(name)) {
          if (!installed.has(name)) installed.set(name, installedVersion(root, name))
          framework.push({ file, field, name, value, installed: installed.get(name) })
        }
      }
    }
    if (typeof manifest.engines?.dsh === 'string' && (harnessPackage(manifest.name) || manifest.name === SHELL_NAME)) {
      engines.push({ file, name: manifest.name, range: manifest.engines.dsh })
    }
    if (manifest.name === SHELL_NAME) shellVersion = manifest.version
  }
  const workspacePath = join(root, WORKSPACE)
  const workspaceText = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
  return { root, line, pins, framework, engines, shellVersion, workspace: parseWorkspace(workspaceText), workspaceText, docs: docWarnings(root, line) }
}

/** Every way the line can be inconsistent.
 * `legacyEngines` accepts the pre-migration `>=<line> <0.3.0-0` form so `--set`
 * can start from it and normalize it to the exact line; `--check` is strict. */
export function problemsOf(state, { legacyEngines = false } = {}) {
  const problems = []
  const warnings = []
  const line = state.line
  if (!semver.valid(line)) problems.push(`deployment.yml declaredLine ${line} is not a valid semver version`)
  for (const pin of state.pins) {
    if (pin.value !== line) problems.push(`${pin.file} ${pin.field}.${pin.name} = ${pin.value} (declared line ${line})`)
  }
  for (const engine of state.engines) {
    if (engine.range === line) continue
    const legacy = legacyEngines && semver.satisfies(line, engine.range) && engine.range.includes(`>=${line}`)
    if (!legacy) problems.push(`${engine.file} engines.dsh ${engine.range} (declared line ${line})`)
  }
  if (state.shellVersion !== undefined && state.shellVersion !== line) {
    problems.push(`${SHELL_DIR}/package.json version ${state.shellVersion} does not follow the platform line ${line}`)
  }
  for (const pin of state.framework ?? []) {
    if (pin.installed === undefined) {
      problems.push(`${pin.file} ${pin.field}.${pin.name} = ${pin.value}: the framework package is not installed — run: node scripts/deps.mjs`)
      continue
    }
    const satisfied = semver.valid(pin.value) === null
      ? semver.satisfies(pin.installed, pin.value, { includePrerelease: true })
      : pin.value === pin.installed
    if (!satisfied) problems.push(`${pin.file} ${pin.field}.${pin.name} = ${pin.value} (installed ${pin.installed})`)
  }
  for (const entry of state.workspace) {
    if (entry.version !== line) problems.push(`${WORKSPACE} ${entry.kind} ${entry.name} = ${entry.version} (declared line ${line})`)
  }
  for (const doc of state.docs) warnings.push(`${doc.file}:${doc.line} still says ${doc.found} (declared ${line}): ${doc.text}`)
  return { problems, warnings }
}

/**
 * Ask npm which version is published. A request that fails (rate limit, DNS,
 * timeout) is *unknown*, never *missing*: a partial answer must not refuse a
 * line that is in fact published.
 * @param {string} version - the target version.
 * @param {string[]} names - the imported platform package names.
 * @returns {Promise<{ status: 'published'|'missing'|'unknown', missing: string[], unknown: string[] }>} the verdict.
 */
async function registryCheck(version, names) {
  const unique = [...new Set(['@deepseek-ai/dsh', ...names])]
  const answers = new Map()
  let index = 0
  const worker = async () => {
    while (index < unique.length) {
      const name = unique[index++]
      answers.set(name, await fetchVersion(name, version))
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const missing = unique.filter(name => answers.get(name) === 'missing')
  const unknown = unique.filter(name => answers.get(name) === 'unknown')
  if (missing.length > 0) return { status: 'missing', missing, unknown }
  if (unknown.length > 0) return { status: 'unknown', missing, unknown }
  return { status: 'published', missing, unknown }
}

/**
 * Whether one package has `version` published: `published`, `missing` (the
 * registry answered and the version is absent), or `unknown` (no answer).
 * @param {string} name - the package name.
 * @param {string} version - the version.
 * @returns {Promise<'published'|'missing'|'unknown'>} the verdict.
 */
async function fetchVersion(name, version) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`https://registry.npmjs.org/${name}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(8000),
      })
      if (response.status === 404) return 'missing'
      if (!response.ok) continue
      const document = await response.json()
      return document.versions?.[version] === undefined ? 'missing' : 'published'
    } catch { /* retry once */ }
  }
  return 'unknown'
}

/** The latest published version, from the umbrella's dist-tags. */
async function latestPublished() {
  try {
    const response = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh', {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return undefined
    const tags = (await response.json())['dist-tags'] ?? {}
    const candidates = [tags.latest, tags.next, tags.alpha].filter(tag => typeof tag === 'string')
    return candidates.sort(semver.compare).at(-1)
  } catch { return undefined }
}

/**
 * Move the whole declaration plane to `nextLine`.
 * @param {string} root - the repo root.
 * @param {string} nextLine - the target version.
 * @param {{ dryRun?: boolean, install?: boolean, verifyRegistry?: boolean, allowUnpublished?: boolean }} [options] - switches.
 * @returns {Promise<object>} the outcome.
 */
export async function rewriteLine(root, nextLine, options = {}) {
  const { dryRun = false, install = true, verifyRegistry = true, allowUnpublished = false } = options
  const state = inspect(root)
  const { problems } = problemsOf(state, { legacyEngines: true })
  if (problems.length > 0) return { ok: false, changed: false, problems, changes: [], warnings: [] }
  if (!semver.valid(nextLine)) return { ok: false, changed: false, problems: [`${nextLine} is not a valid semver version`], changes: [], warnings: [] }
  if (nextLine === state.line) return { ok: true, changed: false, problems: [], changes: [], warnings: ['the declared line already is the target'] }
  const warnings = []
  if (verifyRegistry) {
    const imported = [...new Set(state.pins.filter(pin => pin.value === state.line).map(pin => pin.name))]
    const registry = await registryCheck(nextLine, imported)
    if (registry.status !== 'missing' && registry.unknown.length > 0) {
      warnings.push(`the registry did not answer for ${registry.unknown.length} name(s): ${registry.unknown.join(', ')} — their presence at ${nextLine} is unverified`)
    }
    if (registry.status === 'missing' && !allowUnpublished) {
      return { ok: false, changed: false, problems: [`${nextLine} is not fully published — missing: ${(registry.missing ?? []).join(', ')}; pass --allow-unpublished only if tracking an unreleased line is deliberate`], changes: [], warnings }
    }
    if (registry.status === 'unknown') warnings.push('the registry could not be queried; the target version is unverified')
  }
  const changes = []
  for (const file of manifestFiles(root)) {
    const path = join(root, file)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    let dirty = false
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        if (!platformName(name) || value !== state.line) continue
        manifest[field][name] = nextLine
        changes.push({ file, kind: 'pin', name, from: state.line, to: nextLine })
        dirty = true
      }
    }
    if (manifest.name === SHELL_NAME && manifest.version === state.line) {
      manifest.version = nextLine
      changes.push({ file, kind: 'shell-version', from: state.line, to: nextLine })
      dirty = true
    }
    if (typeof manifest.engines?.dsh === 'string' && (harnessPackage(manifest.name) || manifest.name === SHELL_NAME)) {
      const range = manifest.engines.dsh
      // The line is exact: the plugin is supported on the version it was built
      // and tested against, never on an untested range.
      if (range !== state.line && range !== nextLine) {
        return { ok: false, changed: false, problems: [`${file} engines.dsh ${range} does not name ${state.line}`], changes, warnings }
      }
      if (range !== nextLine) {
        manifest.engines.dsh = nextLine
        changes.push({ file, kind: 'engines', from: range, to: nextLine })
        dirty = true
      }
    }
    if (dirty && !dryRun) writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }
  const descriptorPath = join(root, DESCRIPTOR)
  const descriptor = readFileSync(descriptorPath, 'utf8')
  const nextDescriptor = descriptor.replace(/(declaredLine:\s*)(\S+)/u, `$1${nextLine}`)
  if (nextDescriptor === descriptor) return { ok: false, changed: false, problems: [`${DESCRIPTOR} does not carry a rewritable declaredLine`], changes, warnings }
  changes.push({ file: DESCRIPTOR, kind: 'declared-line', from: state.line, to: nextLine })
  if (!dryRun) writeFileSync(descriptorPath, nextDescriptor)

  const workspacePath = join(root, WORKSPACE)
  const lines = state.workspaceText.split('\n')
  let moved = 0
  for (const entry of state.workspace) {
    const text = lines[entry.index]
    lines[entry.index] = text.replace(new RegExp(`(:\\s*)${entry.version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\s*)$`, 'u'), `$1${nextLine}$2`)
    changes.push({ file: WORKSPACE, kind: `workspace-${entry.kind}`, name: entry.name, from: entry.version, to: nextLine })
    moved += 1
  }
  if (moved === 0) return { ok: false, changed: false, problems: [`${WORKSPACE} has no platform entry on ${state.line} — its shape changed`], changes, warnings }
  if (!dryRun) writeFileSync(workspacePath, lines.join('\n'))

  for (const doc of docWarnings(root, nextLine)) warnings.push(`${doc.file}:${doc.line} still says ${doc.found} (declared ${nextLine}): ${doc.text}`)
  if (!dryRun && install) {
    const result = spawnSync('node', ['scripts/deps.mjs'], { cwd: root, stdio: 'inherit' })
    if (result.status !== 0) {
      return { ok: false, changed: true, problems: [`dependencies were not refreshed (node scripts/deps.mjs exited ${String(result.status)})`], changes, warnings }
    }
    const files = refreshShell(root)
    changes.push({ file: SHELL_SRC, kind: 'shell', from: state.line, to: nextLine })
    warnings.push(`refreshed ${files} typert shell source file(s) from the installed protocol package`)
    const fixture = spawnSync(process.execPath, ['scripts/sync-platform-fixture.mjs'], { cwd: root, stdio: 'inherit' })
    if (fixture.status !== 0) {
      return { ok: false, changed: true, problems: ['the platform test fixture was not refreshed'], changes, warnings }
    }
  }
  return { ok: true, changed: true, problems: [], changes, warnings }
}

/** Print one problem list and exit. */
function fail(problems, changed) {
  console.error(`platform-line: FAIL — ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  if (changed) console.error('  files were changed before the failure; inspect the diff before retrying')
  process.exit(1)
}

/** The CLI. */
async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`platform-line: keep every platform-line fact in one plane
  --check [--json] [--no-registry]  verify pins, engines, shell, workspace entries, docs
  --set <version> [--dry-run] [--no-install] [--allow-unpublished] [--no-registry]
                                    move the declared line everywhere, refresh the shell`)
    return
  }
  const valueOf = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  if (argv.includes('--set')) {
    const nextLine = valueOf('--set')
    if (nextLine === undefined || nextLine.startsWith('--')) {
      console.error('platform-line: --set needs a version, e.g. --set 0.2.2-rc.5')
      process.exit(1)
    }
    const result = await rewriteLine(ROOT, nextLine, {
      dryRun: argv.includes('--dry-run'),
      install: !argv.includes('--no-install'),
      verifyRegistry: !argv.includes('--no-registry'),
      allowUnpublished: argv.includes('--allow-unpublished'),
    })
    if (!result.ok) fail(result.problems, result.changed)
    if (!result.changed) { console.log('platform-line: nothing to do — the declared line is already the target'); return }
    const counts = new Map()
    for (const change of result.changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1)
    console.log(`platform-line: ${argv.includes('--dry-run') ? 'would move' : 'moved'} the declared line to ${nextLine}`)
    for (const [kind, count] of [...counts.entries()].sort()) console.log(`  ${kind}: ${count}`)
    for (const warning of result.warnings) console.warn(`  WARN ${warning}`)
    return
  }
  let state
  try {
    state = inspect(ROOT)
  } catch (error) {
    console.error(`platform-line: FAIL — ${String(error.message ?? error)}`)
    process.exit(1)
  }
  const { problems, warnings } = problemsOf(state)
  const shell = shellProblems(ROOT)
  problems.push(...shell)
  if (!argv.includes('--no-registry')) {
    const latest = await latestPublished()
    if (latest !== undefined && semver.gt(latest, state.line)) {
      warnings.push(`npm has a newer published line: ${latest} (this repo declares ${state.line}) — bump it when you are ready to adapt`)
    }
  }
  const counts = {
    rootPins: state.pins.filter(pin => pin.file === 'package.json').length,
    packagePins: state.pins.filter(pin => pin.file !== 'package.json').length,
    engines: state.engines.length,
    workspace: state.workspace.length,
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ mode: 'check', line: state.line, counts, problems, warnings }, undefined, 2))
    process.exit(problems.length === 0 ? 0 : 1)
  }
  console.log(`platform-line: declared ${state.line} — ${counts.rootPins} root pin(s), ${counts.packagePins} package pin(s), ${counts.engines} engines range(s), ${counts.workspace} workspace entr(y/ies)`)
  for (const warning of warnings) console.warn(`  WARN ${warning}`)
  if (problems.length > 0) fail(problems, false)
  console.log('platform-line: OK')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
