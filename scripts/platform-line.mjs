#!/usr/bin/env node
/**
 * The platform line as one mechanical fact: which DSH version this repository
 * declares, every place that repeats it, and the one command that moves them
 * together.
 *
 * Why this exists: the platform pins are spread over every manifest, the
 * workspace's cache-age exemptions and overrides, `deployment.yml`, and each
 * deployment package's `engines.dsh` (≈500 individual values on the 0.2.2
 * line). A bump done by hand leaves a mixed line behind, and a mixed line is
 * not a compile error — it resolves one version for the type plane, another
 * for the profile, and a third in the snapshot. `--check` makes that state
 * loud; `--set` moves the whole plane in one operation. The version is only
 * moved when the target exists in the registry unless `--allow-unpublished`
 * says the caller deliberately tracks an unreleased line (the checkout
 * execution line is a different plane and is not written here).
 *
 * Three planes, deliberately separate:
 *   - declaration line — this file's `--set`; what CI and release install;
 *   - test snapshot — `--snapshot`, which re-records `.platform-src` and the
 *     lock from a checkout commit (the execution line); it does NOT move pins;
 *   - execution line — the checkout itself; read via `--checkout` for drift.
 *
 * Usage:
 *   node scripts/platform-line.mjs --check [--checkout <dir>] [--json]
 *   node scripts/platform-line.mjs --set <version> [--dry-run] [--no-install]
 *                                   [--allow-unpublished] [--checkout <dir>]
 *   node scripts/platform-line.mjs --snapshot [--checkout <dir>] [--commit <sha>]
 * @module scripts/platform-line
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESCRIPTOR = 'packages/bundle/app-harness/deployment.yml'
const WORKSPACE = 'pnpm-workspace.yaml'
const LOCK = 'scripts/platform-src-lock.json'
const SHELL_DIR = 'packages/typert/protocol'
const SHELL_NAME = '@deepseek-ai/dsh-typert-protocol'
const HARNESS_PREFIX = '@matrix1001/dsh-application-harness'
const PLATFORM_NAME = /^@deepseek-ai\/dsh(-|$)/u
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const ENGINE_TAIL = '<0.3.0-0'

/** Whether a package name belongs to the platform release train. @param name - the name. @returns the verdict. */
export function platformName(name) {
  return typeof name === 'string' && PLATFORM_NAME.test(name)
}

/** Whether a package is one of this repository's deployment packages. @param name - the name. @returns the verdict. */
function harnessPackage(name) {
  return typeof name === 'string' && (name === HARNESS_PREFIX || name.startsWith(`${HARNESS_PREFIX}-`))
}

/** The default platform checkout, matching `platform-checkout.mjs`. @param env - the environment. @returns the absolute checkout root. */
export function checkoutRoot(env = process.env) {
  const configured = env.DSH_HARNESS_REPO
  return configured !== undefined && configured !== '' ? resolve(configured) : join(homedir(), 'deepseek-harness')
}

/** Every manifest the line lives in: the root plus each workspace package. @param root - the repo root. @returns root-relative POSIX paths, sorted. */
export function manifestFiles(root = ROOT) {
  const files = ['package.json']
  const packages = join(root, 'packages')
  if (!existsSync(packages)) return files
  for (const group of readdirSync(packages, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(packages, group.name)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(groupDir, entry.name, 'package.json'))) files.push(`packages/${group.name}/${entry.name}/package.json`)
    }
  }
  return files.sort()
}

/** Read the declared line from the deployment descriptor. @param root - the repo root. @returns the version. @throws when the descriptor is missing or unreadable. */
export function readDeclaredLine(root = ROOT) {
  const path = join(root, DESCRIPTOR)
  if (!existsSync(path)) throw new Error(`${DESCRIPTOR} is missing — the platform line has no source of truth`)
  const line = /declaredLine:\s*(\S+)/u.exec(readFileSync(path, 'utf8'))?.[1]
  if (line === undefined) throw new Error(`${DESCRIPTOR} has no platform.declaredLine`)
  return line
}

/** Read the snapshot lock's line and provenance. @param root - the repo root. @returns the lock summary, or an error object. */
export function readSnapshotLock(root = ROOT) {
  const path = join(root, LOCK)
  if (!existsSync(path)) return { error: `${LOCK} is missing — record the snapshot: node scripts/vendor-platform-src.mjs --record` }
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'))
    return {
      declaredLine: lock.declaredLine,
      tag: lock.tag,
      commit: lock.commit,
      sourceMode: lock.sourceMode,
      commitsAhead: lock.commitsAhead,
    }
  } catch (error) {
    return { error: `${LOCK} is unreadable (${String(error)})` }
  }
}

/**
 * The platform entries of `pnpm-workspace.yaml`, with the line index they sit
 * on (rewriting is line-local and keeps comments and quoting untouched).
 * @param text - the workspace file text.
 * @returns the entries, in file order.
 */
export function parseWorkspace(text) {
  const entries = []
  let section = ''
  text.split('\n').forEach((line, index) => {
    // Only the two dependency-pin sections carry the line. `allowBuilds:` has
    // platform names with boolean values and must never be mistaken for a pin.
    const top = /^([A-Za-z][\w-]*):/u.exec(line)
    if (top !== null) {
      section = top[1]
      return
    }
    if (section === 'minimumReleaseAgeExclude') {
      const exclude = /^(\s*-\s*')(@deepseek-ai\/dsh[^@']+)@([^']+)('\s*)$/u.exec(line)
      if (exclude !== null) entries.push({ kind: 'exclude', name: exclude[2], version: exclude[3], index })
      return
    }
    if (section === 'overrides') {
      const quote = /^(\s*")(@deepseek-ai\/dsh[^"]+)("\s*:\s*)(\S+)(\s*)$/u.exec(line)
      if (quote !== null) {
        entries.push({ kind: 'override', name: quote[2], version: quote[4], index })
        return
      }
      const bare = /^(\s*)(@deepseek-ai\/dsh[^:\s]+)(:\s*)(\S+)(\s*)$/u.exec(line)
      if (bare !== null) entries.push({ kind: 'override', name: bare[2], version: bare[4], index })
    }
  })
  return entries
}

/** The live documents whose platform facts must move with the line. @param root - the repo root. @returns root-relative POSIX paths. */
function liveDocs(root) {
  const docs = ['README.md', 'AGENTS.md']
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name.endsWith('.md')) docs.push(relative(root, abs).split(sep).join('/'))
    }
  }
  walk(join(root, 'docs'))
  return docs.sort()
}

/** Escape a string for a regular expression. @param text - the literal. @returns the escaped literal. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Lines in live docs that still name another 0.2.2-line prerelease. These are
 * warnings, not failures: a doc may legitimately discuss the previous rc, but
 * a silent stale interface fact is exactly what the lane must surface.
 * @param root - the repo root.
 * @param line - the declared line.
 * @returns the stale mentions.
 */
export function docWarnings(root = ROOT, line = readDeclaredLine(root)) {
  const family = line.includes('-') ? line.slice(0, line.indexOf('-')) : line
  const pattern = new RegExp(`${escapeRegExp(family)}-[0-9A-Za-z.-]+`, 'gu')
  const warnings = []
  for (const file of liveDocs(root)) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    readFileSync(path, 'utf8').split('\n').forEach((text, index) => {
      for (const match of text.matchAll(pattern)) {
        if (match[0] === line) continue
        warnings.push({ file, line: index + 1, found: match[0], text: text.trim().slice(0, 160) })
      }
    })
  }
  return warnings
}

/**
 * Read the whole line surface: every pin, every engines range, the workspace
 * entries, the shell manifest version, and the snapshot lock.
 * @param root - the repo root.
 * @param options - optional checkout for execution-line drift.
 * @returns the state.
 */
export function inspect(root = ROOT, { checkout } = {}) {
  const line = readDeclaredLine(root)
  const pins = []
  const engines = []
  let shellVersion
  for (const file of manifestFiles(root)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(root, file), 'utf8'))
    } catch (error) {
      throw new Error(`${file} is unreadable (${String(error)})`)
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        if (platformName(name)) pins.push({ file, field, name, value })
      }
    }
    if (typeof manifest.engines?.dsh === 'string' && (harnessPackage(manifest.name) || manifest.name === SHELL_NAME)) {
      engines.push({ file, name: manifest.name, range: manifest.engines.dsh })
    }
    if (manifest.name === SHELL_NAME) shellVersion = manifest.version
  }
  const workspacePath = join(root, WORKSPACE)
  const workspaceText = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
  const workspace = parseWorkspace(workspaceText)
  const lock = readSnapshotLock(root)
  return {
    root,
    line,
    pins,
    engines,
    shellVersion,
    workspace,
    workspaceText,
    lock,
    docs: docWarnings(root, line),
    checkout: checkout === undefined ? undefined : snapshotState(root, checkout),
  }
}

/** Read one git value from a checkout with the environment's broken GIT_CONFIG_* neutralized. @param cwd - the checkout. @param args - git arguments. @returns stdout. */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
  }).trim()
}

/**
 * How far the recorded snapshot is from a checkout HEAD. Ancestry is the
 * correctness question (a non-ancestor snapshot was recorded from another
 * line); the distance is the staleness warning.
 * @param root - the repo root.
 * @param checkout - the checkout path.
 * @returns the drift summary.
 */
export function snapshotState(root = ROOT, checkout = checkoutRoot()) {
  const lock = readSnapshotLock(root)
  if (lock.error !== undefined) return { status: 'no-lock', error: lock.error }
  if (!existsSync(join(checkout, '.git'))) return { status: 'no-checkout', checkout }
  try {
    const head = git(checkout, ['rev-parse', '--short=12', 'HEAD'])
    let ancestor = true
    try {
      git(checkout, ['merge-base', '--is-ancestor', lock.commit, 'HEAD'])
    } catch {
      ancestor = false
    }
    if (!ancestor) return { status: 'diverged', checkout, head, commit: lock.commit }
    const behind = Number(git(checkout, ['rev-list', '--count', `${lock.commit}..HEAD`]))
    return { status: behind === 0 ? 'current' : 'behind', checkout, head, commit: lock.commit, behind }
  } catch (error) {
    return { status: 'unreadable', checkout, error: String(error.message ?? error) }
  }
}

/**
 * Every way the line can be inconsistent. Problems fail `--check`; warnings
 * are facts a human must look at but not line-shape errors.
 * @param state - the result of {@link inspect}.
 * @returns the problems and warnings.
 */
export function problemsOf(state) {
  const problems = []
  const warnings = []
  const line = state.line
  if (!semver.valid(line)) problems.push(`deployment.yml declaredLine ${line} is not a valid semver version`)
  for (const pin of state.pins) {
    if (pin.value !== line) problems.push(`${pin.file} ${pin.field}.${pin.name} = ${pin.value} (declared line ${line})`)
  }
  for (const engine of state.engines) {
    if (semver.validRange(engine.range) === null) {
      problems.push(`${engine.file} engines.dsh ${engine.range} is not a valid semver range`)
      continue
    }
    if (!semver.satisfies(line, engine.range)) problems.push(`${engine.file} engines.dsh ${engine.range} does not cover ${line}`)
    else if (!engine.range.includes(`>=${line}`)) problems.push(`${engine.file} engines.dsh ${engine.range} does not name the declared line ${line}`)
  }
  if (state.shellVersion !== undefined && state.shellVersion !== line) {
    problems.push(`${SHELL_DIR}/package.json version ${state.shellVersion} does not follow the platform line ${line}`)
  }
  for (const entry of state.workspace) {
    if (entry.version !== line) problems.push(`${WORKSPACE} ${entry.kind} ${entry.name} = ${entry.version} (declared line ${line})`)
  }
  if (state.lock.error !== undefined) problems.push(state.lock.error)
  else if (state.lock.declaredLine !== line) problems.push(`${LOCK} records line ${state.lock.declaredLine} but deployment.yml declares ${line}`)
  if (state.checkout !== undefined) {
    if (state.checkout.status === 'diverged') problems.push(`the snapshot commit ${state.checkout.commit} is not an ancestor of ${state.checkout.checkout} HEAD ${state.checkout.head}`)
    else if (state.checkout.status === 'behind') warnings.push(`the snapshot is ${state.checkout.behind} commit(s) behind ${state.checkout.checkout} HEAD ${state.checkout.head} — re-record when the execution line moves`)
    else if (state.checkout.status === 'unreadable') warnings.push(`the snapshot/checkout comparison could not run: ${state.checkout.error}`)
    else if (state.checkout.status === 'no-checkout') warnings.push(`no platform checkout at ${state.checkout.checkout} — execution-line drift unverified`)
  }
  for (const doc of state.docs) warnings.push(`${doc.file}:${doc.line} still says ${doc.found} (declared ${line}): ${doc.text}`)
  return { problems, warnings }
}

/**
 * Move the whole declaration plane to `nextLine`. Refuses a mixed starting
 * state: bumping on top of one hides the pre-existing skew.
 * @param root - the repo root.
 * @param nextLine - the target version.
 * @param options - dry run, install, registry verification, checkout.
 * @returns the outcome with every changed site.
 */
export function rewriteLine(root, nextLine, options = {}) {
  const { dryRun = false, install = true, verifyRegistry = true, allowUnpublished = false, checkout } = options
  const state = inspect(root)
  const { problems } = problemsOf(state)
  if (problems.length > 0) return { ok: false, changed: false, problems, changes: [], warnings: [] }
  if (!semver.valid(nextLine)) return { ok: false, changed: false, problems: [`${nextLine} is not a valid semver version`], changes: [], warnings: [] }
  if (nextLine === state.line) return { ok: true, changed: false, problems: [], changes: [], warnings: ['the declared line already is the target'] }

  const warnings = []
  if (verifyRegistry) {
    const registry = registryStatus(nextLine, root)
    if (registry === 'missing' && !allowUnpublished) {
      return {
        ok: false,
        changed: false,
        problems: [`@deepseek-ai/dsh@${nextLine} is not on the registry — pass --allow-unpublished only if tracking an unreleased line is deliberate`],
        changes: [],
        warnings,
      }
    }
    if (registry === 'unknown') warnings.push('the registry could not be queried; the target version is unverified')
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
      if (!range.includes(`>=${state.line}`)) {
        return { ok: false, changed: false, problems: [`${file} engines.dsh ${range} does not name ${state.line}`], changes, warnings }
      }
      manifest.engines.dsh = range.replace(`>=${state.line}`, `>=${nextLine}`)
      changes.push({ file, kind: 'engines', from: range, to: manifest.engines.dsh })
      dirty = true
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
  let workspaceMoved = 0
  let section = ''
  for (let index = 0; index < lines.length; index++) {
    const top = /^([A-Za-z][\w-]*):/u.exec(lines[index])
    if (top !== null) {
      section = top[1]
      continue
    }
    if (section === 'minimumReleaseAgeExclude') {
      const exclude = /^(\s*-\s*')(@deepseek-ai\/dsh[^@']+)@([^']+)('\s*)$/u.exec(lines[index])
      if (exclude === null || exclude[3] !== state.line) continue
      lines[index] = `${exclude[1]}${exclude[2]}@${nextLine}${exclude[4]}`
      changes.push({ file: WORKSPACE, kind: 'workspace-exclude', name: exclude[2], from: state.line, to: nextLine })
      workspaceMoved += 1
      continue
    }
    if (section === 'overrides') {
      const quote = /^(\s*")(@deepseek-ai\/dsh[^"]+)("\s*:\s*)(\S+)(\s*)$/u.exec(lines[index])
      if (quote !== null && quote[4] === state.line) {
        lines[index] = `${quote[1]}${quote[2]}${quote[3]}${nextLine}${quote[5]}`
        changes.push({ file: WORKSPACE, kind: 'workspace-override', name: quote[2], from: state.line, to: nextLine })
        workspaceMoved += 1
        continue
      }
      const bare = /^(\s*)(@deepseek-ai\/dsh[^:\s]+)(:\s*)(\S+)(\s*)$/u.exec(lines[index])
      if (bare !== null && bare[4] === state.line) {
        lines[index] = `${bare[1]}${bare[2]}${bare[3]}${nextLine}${bare[5]}`
        changes.push({ file: WORKSPACE, kind: 'workspace-override', name: bare[2], from: state.line, to: nextLine })
        workspaceMoved += 1
      }
    }
  }
  if (workspaceMoved === 0) return { ok: false, changed: false, problems: [`${WORKSPACE} has no platform entry on ${state.line} — its shape changed`], changes, warnings }
  if (!dryRun) writeFileSync(workspacePath, lines.join('\n'))

  for (const doc of docWarnings(root, nextLine)) warnings.push(`${doc.file}:${doc.line} still says ${doc.found} (declared ${nextLine}): ${doc.text}`)
  const nextLock = readSnapshotLock(root)
  if (nextLock.error === undefined && nextLock.declaredLine !== nextLine) {
    warnings.push(`${LOCK} still records ${nextLock.declaredLine}; run --snapshot to re-record it from the new line before --check can pass`)
  }
  if (checkout !== undefined) {
    const drift = snapshotState(root, checkout)
    if (drift.status === 'behind') warnings.push(`the snapshot is ${drift.behind} commit(s) behind the checkout — run --snapshot`)
  }

  if (!dryRun && install) {
    const result = spawnSync('node', ['scripts/deps.mjs'], { cwd: root, stdio: 'inherit' })
    if (result.status !== 0) {
      return { ok: false, changed: true, problems: [`dependencies were not refreshed (node scripts/deps.mjs exited ${String(result.status)})`], changes, warnings }
    }
  }
  return { ok: true, changed: true, problems: [], changes, warnings }
}

/**
 * Ask the registry whether a version exists. `unknown` is deliberately not a
 * failure: an offline machine must still be able to move a deliberate line.
 * @param version - the target version.
 * @param root - the repo root (local npm cache lives under `tmp/`).
 * @returns `published`, `missing`, or `unknown`.
 */
export function registryStatus(version, root = ROOT) {
  const cache = join(root, 'tmp', 'npm-cache')
  mkdirSync(cache, { recursive: true })
  const result = spawnSync('npm', ['view', `@deepseek-ai/dsh@${version}`, 'version', '--json', '--cache', cache], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.error !== undefined) return 'unknown'
  if (result.status === 0) return 'published'
  return /\bE404\b|404 Not Found/u.test(`${result.stdout}${result.stderr}`) ? 'missing' : 'unknown'
}

/** The CLI. */
function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`platform-line: keep every platform-line fact in one plane
  --check [--checkout <dir>] [--json]   verify pins, engines, workspace entries, lock, docs
  --set <version> [--dry-run] [--no-install] [--allow-unpublished] [--checkout <dir>]
                                        move the declared line everywhere (refuses a mixed start)
  --snapshot [--checkout <dir>] [--commit <sha> | --tag]
                                        re-record .platform-src + the lock from the checkout HEAD
                                        (--commit pins a commit, --tag records the declared tag)`)
    return
  }
  const valueOf = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const checkout = valueOf('--checkout') ?? (existsSync(join(checkoutRoot(), '.git')) ? checkoutRoot() : undefined)

  if (argv.includes('--snapshot')) {
    const target = valueOf('--checkout') ?? checkoutRoot()
    if (!existsSync(join(target, '.git'))) {
      console.error(`platform-line: FAIL — no checkout at ${target} (pass --checkout <path>)`)
      process.exit(1)
    }
    const args = ['scripts/vendor-platform-src.mjs', '--record', '--checkout', target]
    let commit = valueOf('--commit')
    if (commit === undefined && !argv.includes('--tag')) {
      try {
        commit = git(target, ['rev-parse', 'HEAD'])
      } catch (error) {
        console.error(`platform-line: FAIL — could not read HEAD in ${target}: ${String(error.message ?? error)}`)
        process.exit(1)
      }
    }
    if (commit !== undefined) args.push('--commit', commit)
    const record = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit' })
    if (record.status !== 0) process.exit(record.status ?? 1)
    const verify = spawnSync('node', ['scripts/vendor-platform-src.mjs', '--check', '--checkout', target], { cwd: ROOT, stdio: 'inherit' })
    if (verify.status !== 0) process.exit(verify.status ?? 1)
    console.log('platform-line: snapshot recorded; next: node scripts/generate-typert.mjs (needs a built checkout), then node scripts/platform-compat.mjs')
    return
  }

  if (argv.includes('--set')) {
    const index = argv.indexOf('--set')
    const nextLine = argv[index + 1]
    if (nextLine === undefined || nextLine.startsWith('--')) {
      console.error('platform-line: --set needs a version, e.g. --set 0.2.2-rc.2')
      process.exit(1)
    }
    const result = rewriteLine(ROOT, nextLine, {
      dryRun: argv.includes('--dry-run'),
      install: !argv.includes('--no-install'),
      verifyRegistry: !argv.includes('--no-registry'),
      allowUnpublished: argv.includes('--allow-unpublished'),
      checkout,
    })
    if (!result.ok) {
      console.error(`platform-line: FAIL — ${result.problems.length} problem(s)`)
      for (const problem of result.problems) console.error(`  - ${problem}`)
      if (result.changed) console.error('  files were changed before the failure; inspect the diff before retrying')
      process.exit(1)
    }
    if (!result.changed) {
      console.log('platform-line: nothing to do — the declared line is already the target')
      return
    }
    const counts = new Map()
    for (const change of result.changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1)
    console.log(`platform-line: ${argv.includes('--dry-run') ? 'would move' : 'moved'} the declared line to ${nextLine}`)
    for (const [kind, count] of [...counts.entries()].sort()) console.log(`  ${kind}: ${count}`)
    for (const warning of result.warnings) console.warn(`  WARN ${warning}`)
    console.log('  next: node scripts/vendor-platform-src.mjs --record --checkout <dir> (or --snapshot), then node scripts/platform-compat.mjs')
    return
  }

  let state
  try {
    state = inspect(ROOT, { checkout })
  } catch (error) {
    console.error(`platform-line: FAIL — ${String(error.message ?? error)}`)
    process.exit(1)
  }
  const { problems, warnings } = problemsOf(state)
  const counts = {
    rootPins: state.pins.filter(pin => pin.file === 'package.json').length,
    packagePins: state.pins.filter(pin => pin.file !== 'package.json').length,
    engines: state.engines.length,
    workspace: state.workspace.length,
    docs: state.docs.length,
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ mode: 'check', line: state.line, counts, problems, warnings, snapshot: state.checkout ?? null, lock: state.lock }, undefined, 2))
  } else {
    const snapshot = state.lock.error === undefined
      ? `${state.lock.tag}${state.lock.sourceMode === 'commit' ? ` +${String(state.lock.commitsAhead)}` : ''} (${String(state.lock.commit).slice(0, 12)})`
      : 'missing'
    console.log(`platform-line: declared ${state.line} — ${counts.rootPins} root pin(s), ${counts.packagePins} package pin(s), ${counts.engines} engines range(s), ${counts.workspace} workspace entr(y/ies); snapshot ${snapshot}`)
    for (const warning of warnings) console.warn(`  WARN ${warning}`)
    if (problems.length > 0) {
      console.error(`platform-line: FAIL — ${problems.length} problem(s)`)
      for (const problem of problems) console.error(`  - ${problem}`)
    } else {
      console.log('platform-line: OK')
    }
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
