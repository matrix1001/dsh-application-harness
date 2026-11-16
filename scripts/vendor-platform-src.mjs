#!/usr/bin/env node
/**
 * Vendor (or verify) the platform client sources the test plane imports — the
 * twelve `.platform-src/<name>/src` trees (see AGENTS.md).
 * The typert protocol shell is NOT vendored from the tag: it is the build
 * plane's type face and follows the **checkout** (see its README and
 * `scripts/platform-checkout.mjs`), so `--check` compares it against a
 * checkout's `packages/typert/protocol/src` whenever one is present.
 *
 * **The source is an immutable commit of the declared platform line, read out
 * of Git objects — never a working tree.** A checkout that has moved ahead of
 * the declared line cannot skew the snapshot: the tag recorded in
 * `scripts/platform-src-lock.json` (`dsh-<declaredLine>`) is resolved to a
 * commit, and every file is read with `git show <commit>:<path>`. The one
 * deliberate exception is `--record --commit <sha>`: when the execution line
 * (the checkout) runs ahead of the declared line, the named commit must
 * DESCEND from the tag's, and the lock records both the commit and its
 * distance from the tag (`sourceMode` / `commitsAhead`).
 *
 * Modes:
 *   --record [--checkout <path>] [--commit <sha>]
 *                                  re-vendor from the tag into a STAGING dir,
 *                                  validate every tree there, then swap it in
 *                                  and re-record the lock (T3). `--commit`
 *                                  vendors a commit ON OR AFTER the declared
 *                                  line's tag (the execution line moves ahead
 *                                  of the tag; the record says by how much).
 *   --check  [--checkout <path>]   verify the working tree against the lock
 *                                  (offline; the CI path) and, when a checkout
 *                                  with the tag is available, verify the
 *                                  recorded source still resolves on the
 *                                  declared line and that its files hash to
 *                                  the record.
 *   --self-test                    exercise the checker against fixtures
 *                                  (negative self-proof; no checkout needed).
 *
 * Statuses follow the plan's table: a missing/corrupt lock, a declared-version
 * mismatch, or a drifted tree is a FAIL; "no matching checkout" is reported as
 * UNVERIFIED for the UPSTREAM half only — the local consistency check still runs
 * and still fails hard.
 * @module
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareTreesToLock, digestTree, listFiles, parsePlatformModules, PLATFORM_LOCK, PLATFORM_MODULES_SOURCE,
  readLock, targetOf, VENDOR_PAIRS,
} from './platform-contract.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The typert protocol shell mirrors the checkout's own
 * `packages/typert/protocol/src` (the build plane's generator comes from there
 * — `platform-checkout.mjs`). It stays a registered project so the generator
 * recognizes its type-meta symbols; one local divergence is normalized before
 * comparison: `types.ts` drops the Cordis Context augmentation so discovery
 * does not treat the shell as a contributor.
 */
const SHELL_PATH = 'packages/typert/protocol/src'
const SHELL_UPSTREAM_PATH = 'packages/typert/protocol/src'

/**
 * Cut the shell's local divergence from `types.ts`: either the upstream
 * Context augmentation block or our replacement comment. Both sit at the end
 * of the file, so comparing the prefix is faithful for every other byte.
 * @param {string} text - a shell `types.ts` source text.
 * @returns {string} the normalized text.
 */
function normalizeShellTypes(text) {
  const markers = ["declare module '@deepseek-ai/cordis' {", '// Local build-shell divergence:']
  let cut = text.length
  for (const marker of markers) {
    const at = text.indexOf(marker)
    if (at !== -1) cut = Math.min(cut, at)
  }
  return text.slice(0, cut).replace(/\s+$/u, '')
}

/**
 * Digest the shell tree with the local `types.ts` normalization applied.
 * @param {string} dir - the shell source directory.
 * @returns {{ files: number, digest: string }} the normalized digest.
 */
function digestShellTree(dir) {
  // The typert step writes .js/.d.ts artifacts next to the shell sources; they
  // are gitignored (see .gitignore) and are not part of the vendored snapshot.
  const generated = /(?:\.js(?:\.map)?|\.d\.ts(?:\.map)?)$/u
  const files = listFiles(dir).filter(file => !generated.test(file))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    const raw = readFileSync(join(dir, file))
    const content = file === 'types.ts' ? normalizeShellTypes(raw.toString('utf8')) : raw
    hash.update(createHash('sha256').update(content).digest('hex'))
    hash.update('\n')
  }
  return { files: files.length, digest: `sha256:${hash.digest('hex')}` }
}

/**
 * The shell half of the check: compare the shell's working tree with the
 * checkout's own `packages/typert/protocol/src`. Working trees on both sides
 * on purpose — the shell must mirror what the checkout is *running*, committed
 * or not.
 * @param {string} checkout - the platform checkout root.
 * @param {string} [root] - the repo root (a scratch root in tests).
 * @returns {{ ok: boolean, message: string }} the verdict.
 */
function compareShellToCheckout(checkout, root = ROOT) {
  const upstream = join(checkout, SHELL_UPSTREAM_PATH)
  if (!existsSync(upstream)) {
    return { ok: true, message: `verify-platform-src: typert shell UNVERIFIED — no ${SHELL_UPSTREAM_PATH} in the checkout to compare` }
  }
  const local = digestShellTree(join(root, SHELL_PATH))
  const theirs = digestShellTree(upstream)
  if (local.digest !== theirs.digest || local.files !== theirs.files) {
    return {
      ok: false,
      message: `verify-platform-src: FAIL — the typert shell drifted from the checkout:\n`
        + `  - ${SHELL_PATH}: shell ${local.files} file(s) ${local.digest}, checkout ${theirs.files} file(s) ${theirs.digest}\n`
        + `  sync it from the checkout: cp <checkout>/${SHELL_UPSTREAM_PATH}/*.ts ${SHELL_PATH}/`,
    }
  }
  return { ok: true, message: `verify-platform-src: typert shell matches the checkout (${local.files} file(s), ${local.digest})` }
}

/**
 * Run git in a checkout (the environment exports a broken GIT_CONFIG_*).
 * stderr is PIPED rather than inherited: a failing read (a missing tag, an
 * object the checkout does not hold) is reported once, inside the thrown
 * error's message, instead of also being echoed to the terminal ahead of the
 * caller's own FAIL line.
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The same git read without text decoding, for binary tree entries. */
function gitBuffer(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The declared platform line, from the deployment descriptor (its single home). */
export function declaredLine(root = ROOT) {
  const descriptor = readFileSync(join(root, 'packages/bundle/app-harness/deployment.yml'), 'utf8')
  const match = /declaredLine:\s*(\S+)/u.exec(descriptor)
  if (match === null) throw new Error('deployment.yml has no platform.declaredLine — the lock cannot bind to a line')
  return match[1]
}

/** The tag naming the declared line's immutable commit. */
export function tagFor(line) {
  return `dsh-v${line}`
}

/**
 * Read one directory tree out of a Git commit into `dest` (the immutable source).
 * @param {{ checkout: string, commit: string, from: string, dest: string }} options - the checkout, the commit, the checkout-relative source dir, and the destination.
 * @returns {number} the number of files written.
 */
export function readTreeFromCommit({ checkout, commit, from, dest }) {
  // `from` is the checkout-relative PACKAGE dir; the vendored tree is its
  // `src/` (the npm packages publish `lib/` only, so `src` is what the test
  // plane needs). Reading the package dir itself would sweep in package.json /
  // README / tests — the digest would still be self-consistent, which is
  // exactly why `record()` validates the staged shape below.
  const tree = `packages/${from}/src`
  const prefix = `${tree}/`
  const listed = git(checkout, ['ls-tree', '-r', '--name-only', commit, '--', tree])
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  if (listed.length === 0) throw new Error(`no files at ${tree} in ${commit} — the declared line's layout changed`)
  rmSync(dest, { recursive: true, force: true })
  for (const path of listed) {
    const rel = path.slice(prefix.length)
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, gitBuffer(checkout, ['show', `${commit}:${path}`]))
  }
  return listed.length
}

/**
 * A staged tree must look like a package's `src`: TypeScript sources, and no
 * package manifest. The digest alone cannot catch a wrong SOURCE PATH (both the
 * record and the check would agree on the wrong tree), so the shape is asserted
 * before anything is swapped in.
 * @param {string} dir - the staged tree.
 * @param {string} from - the checkout-relative package dir (for the message).
 */
export function validateStagedTree(dir, from) {
  const files = listFiles(dir)
  if (files.includes('package.json')) {
    throw new Error(`${from}: the staged tree carries package.json — the source path is wrong (expected <package>/src)`)
  }
  if (!files.some(file => file.endsWith('.ts') || file.endsWith('.tsx'))) {
    throw new Error(`${from}: the staged tree carries no TypeScript sources — the source path is wrong`)
  }
  if (files.some(file => file.startsWith('tests/') || file.startsWith('lib/'))) {
    throw new Error(`${from}: the staged tree carries tests/ or lib/ — the source path is wrong (expected <package>/src)`)
  }
  return files.length
}

/**
 * Record mode: stage every tree from the recorded source, validate, swap in,
 * and write the lock.
 *
 * Two sources, one rule — the source must be the declared line: `tag` (its
 * value reaching here from `--tag`, defaulted by `main`) resolves the line's
 * anchor, and `commit` (`--commit`) names any commit ON that line, for when the
 * execution line runs ahead of the tag. Exactly one of the two is used; the
 * lock's `tag` field names the DECLARED LINE in both modes, so its existing
 * readers keep reading the line off it.
 * @param {{ checkout: string, tag?: string, commit?: string, root?: string }} options - the checkout, the source, and the repo root.
 * @returns {void}
 * @throws {Error} when the source is off the declared line, or a staged tree does not look like a package's `src` (nothing is written in either case).
 */
export function record({ checkout, tag, commit: requested, root = ROOT }) {
  const line = declaredLine(root)
  const lineTag = tagFor(line)
  let commit
  let sourceMode
  let commitsAhead
  if (requested === undefined) {
    commit = git(checkout, ['rev-parse', `${tag}^{commit}`]).trim()
    if (tag !== lineTag) {
      throw new Error(`tag ${tag} does not name the declared line ${line} — refusing to record a mismatched source`)
    }
    sourceMode = 'tag'
    commitsAhead = 0
  } else {
    commit = git(checkout, ['rev-parse', `${requested}^{commit}`]).trim()
    const lineCommit = git(checkout, ['rev-parse', `${lineTag}^{commit}`]).trim()
    // The tag is the line's anchor, and ancestry is the whole rule: a commit
    // the anchor cannot reach is a different line, and vendoring it would make
    // the snapshot unexplainable against the line the descriptor declares.
    try {
      git(checkout, ['merge-base', '--is-ancestor', lineCommit, commit])
    } catch {
      throw new Error(`commit ${commit} is not on the declared line ${line} (${lineTag}) — refusing to record a mismatched source`)
    }
    sourceMode = 'commit'
    commitsAhead = Number(git(checkout, ['rev-list', '--count', `${lineCommit}..${commit}`]).trim())
  }
  const staging = mkdtempSync(join(tmpdir(), 'dsh-vendor-'))
  try {
    const targets = []
    for (const pair of VENDOR_PAIRS) {
      const [from, name] = pair
      const to = targetOf(pair)
      const staged = join(staging, to)
      readTreeFromCommit({ checkout, commit, from, dest: staged })
      const { files, digest } = digestTree(staged)
      targets.push({ name, from: `packages/${from}/src`, to, files, digest })
    }
    // The T5 snapshot: the platform's shared-module table, bound to the same commit.
    const platformModules = parsePlatformModules(git(checkout, ['show', `${commit}:${PLATFORM_MODULES_SOURCE}`]))
    const lock = {
      declaredLine: line,
      tag: lineTag,
      commit,
      // Which of the two sources named the commit: `tag` above still names the
      // declared LINE, so the mode has to travel in its own field.
      sourceMode,
      commitsAhead,
      // A digest proves the local snapshot is what was recorded; the commit is
      // what binds that record to the declared line (not an upstream signature).
      source: sourceMode === 'commit'
        ? `read via git show <commit>:<path> — the declared line's tag ${lineTag} plus ${commitsAhead} commit(s) (the execution line)`
        : 'read via git show <commit>:<path> — the tag is resolved, never a working tree',
      targets,
      platformModules: { source: PLATFORM_MODULES_SOURCE, modules: platformModules },
    }
    const origin = sourceMode === 'commit' ? `${lineTag} +${commitsAhead}` : lineTag
    // Swap only after every tree staged and validated: a half-copied workspace
    // is what "re-vendor in a staging dir" exists to prevent.
    for (const pair of VENDOR_PAIRS) {
      const staged = join(staging, targetOf(pair))
      const dest = join(root, targetOf(pair))
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(staged, dest, { recursive: true })
      console.log(`vendored ${pair[1]} <- ${origin} packages/${pair[0]}/src (${listFiles(dest).length} file(s))`)
    }
    writeFileSync(join(root, PLATFORM_LOCK), `${JSON.stringify(lock, undefined, 2)}\n`)
    console.log(`vendor-platform-src: recorded ${targets.length} trees + ${platformModules.length} platform modules @ ${commit} (${origin}) → ${PLATFORM_LOCK}`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Check mode: the local half always runs; the upstream half runs when a
 * checkout holding the recorded source is available, else reports UNVERIFIED.
 * @param {{ checkout: string | undefined, root?: string }} options - the optional checkout and the repo root.
 * @returns {number} the exit code (0 = the local check passed, 1 = FAIL); every failure is reported on stderr, never thrown.
 */
export function check({ checkout, root = ROOT }) {
  let lock
  try {
    lock = readLock(root)
  } catch (error) {
    console.error(`verify-platform-src: FAIL — ${String(error.message ?? error)}`)
    return 1
  }
  const line = declaredLine(root)
  if (lock.declaredLine !== line) {
    console.error(`verify-platform-src: FAIL — the lock records the platform line ${lock.declaredLine} but the deployment descriptor declares ${line}`)
    console.error('  re-vendor from the declared line: node scripts/vendor-platform-src.mjs --record --checkout <path>')
    return 1
  }
  const { failures, checked } = compareTreesToLock(root, lock)
  if (failures.length > 0) {
    console.error(`verify-platform-src: FAIL — ${failures.length} vendored tree(s) drifted:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error('  re-vendor from the declared line: node scripts/vendor-platform-src.mjs --record --checkout <path>')
    return 1
  }
  if (checkout === undefined) {
    console.log(`verify-platform-src: OK — ${checked} vendored trees match ${PLATFORM_LOCK} (declared line ${line})`)
    console.log('verify-platform-src: upstream UNVERIFIED — no platform checkout, so the source half was not compared')
    console.log(`verify-platform-src: typert shell UNVERIFIED — no platform checkout; the shell follows the checkout, not the declared tag`)
    return 0
  }
  try {
    const lineTag = tagFor(line)
    // How the recorded source names itself in every message below: the tag
    // alone, or the tag plus the distance the commit sits ahead of it.
    const origin = lock.sourceMode === 'commit' ? `${lock.tag} +${lock.commitsAhead}` : lock.tag
    let commit
    if (lock.sourceMode === 'commit') {
      // The recorded commit must still be ON the line, not merely present in
      // the checkout: a checkout whose tag has moved to another commit can hold
      // the object and still be a different line. An unknown object (a shallow
      // clone, a moved worktree) throws out of `rev-parse` into the catch —
      // a FAIL, never a silent pass.
      commit = git(checkout, ['rev-parse', `${lock.commit}^{commit}`]).trim()
      const lineCommit = git(checkout, ['rev-parse', `${lineTag}^{commit}`]).trim()
      try {
        git(checkout, ['merge-base', '--is-ancestor', lineCommit, commit])
      } catch {
        console.error(`verify-platform-src: FAIL — the recorded commit ${lock.commit} is no longer on the declared line ${line} (${lineTag})`)
        return 1
      }
    } else {
      commit = git(checkout, ['rev-parse', `${lock.tag}^{commit}`]).trim()
      if (commit !== lock.commit) {
        console.error(`verify-platform-src: FAIL — ${lock.tag} resolves to ${commit} but the lock records ${lock.commit}`)
        return 1
      }
    }
    // The source's own files must hash to the record: the half a digest alone
    // cannot prove (a record could have drifted WITH the tree).
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-vendor-check-'))
    try {
      const mismatched = []
      for (const target of lock.targets) {
        const pair = VENDOR_PAIRS.find(candidate => candidate[1] === target.name)
        if (pair === undefined) { mismatched.push(`${target.name}: no vendoring rule`); continue }
        const staged = join(scratch, target.to)
        readTreeFromCommit({ checkout, commit, from: pair[0], dest: staged })
        const current = digestTree(staged)
        if (current.files !== target.files || current.digest !== target.digest) {
          mismatched.push(`${target.to}: ${origin} holds ${current.files} file(s) ${current.digest}, the lock records ${target.files} file(s) ${target.digest}`)
        }
      }
      if (mismatched.length > 0) {
        console.error('verify-platform-src: FAIL — the recorded trees are not what the recorded source holds:')
        for (const entry of mismatched) console.error(`  - ${entry}`)
        return 1
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    const live = parsePlatformModules(git(checkout, ['show', `${commit}:${PLATFORM_MODULES_SOURCE}`]))
    if (JSON.stringify(live) !== JSON.stringify(lock.platformModules?.modules)) {
      console.error('verify-platform-src: FAIL — the recorded platform module table differs from the declared commit\'s')
      return 1
    }
    console.log(`verify-platform-src: OK — ${checked} vendored trees match ${PLATFORM_LOCK}; upstream PASS (${origin} → ${commit}, trees + module table match)`)
    const shell = compareShellToCheckout(checkout, root)
    console.log(shell.message)
    if (!shell.ok) return 1
    return 0
  } catch (error) {
    console.error(`verify-platform-src: FAIL — the checkout could not be read: ${String(error.message ?? error)}`)
    return 1
  }
}

/** Negative self-proof: the checker must reject a drifted tree, a missing lock, and an unparseable table. */
function selfTest() {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-vendor-selftest-'))
  let failures = 0
  /** A body that must THROW (a missing/corrupt input). */
  const expectThrows = (label, body) => {
    try {
      body()
      console.error(`  ✗ ${label}: the checker did NOT trip`)
      failures += 1
    } catch {
      console.log(`  ✓ ${label}`)
    }
  }
  /** A mutation that must produce drift failures. */
  const expectDrift = (label, mutate, restore) => {
    mutate()
    const { failures: found } = compareTreesToLock(scratch, lock)
    restore()
    if (found.length === 0) {
      console.error(`  ✗ ${label}: no drift reported`)
      failures += 1
    } else {
      console.log(`  ✓ ${label}`)
    }
  }
  let lock
  try {
    const tree = join(scratch, '.platform-src/x/src')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'a.ts'), 'export const a = 1\n')
    lock = {
      declaredLine: '0.0.0', tag: 'dsh-v0.0.0', commit: 'deadbeef',
      targets: [{ name: 'x', from: 'packages/x/src', to: '.platform-src/x/src', ...digestTree(tree) }],
    }
    // A faithful tree passes…
    if (compareTreesToLock(scratch, lock).failures.length !== 0) {
      console.error('  ✗ an unchanged tree should pass')
      failures += 1
    } else {
      console.log('  ✓ an unchanged tree passes')
    }
    expectDrift('a drifted file',
      () => writeFileSync(join(tree, 'a.ts'), 'export const a = 2\n'),
      () => writeFileSync(join(tree, 'a.ts'), 'export const a = 1\n'))
    expectDrift('an added file',
      () => writeFileSync(join(tree, 'b.ts'), 'export const b = 1\n'),
      () => rmSync(join(tree, 'b.ts')))
    expectDrift('a deleted tree',
      () => rmSync(tree, { recursive: true, force: true }),
      () => { mkdirSync(tree, { recursive: true }); writeFileSync(join(tree, 'a.ts'), 'export const a = 1\n') })
    expectThrows('a missing lock', () => readLock(scratch))
    expectThrows('a non-literal module table', () => parsePlatformModules('export const PLATFORM_MODULES = [...other]\n'))
    expectThrows('an empty module table', () => parsePlatformModules('export const PLATFORM_MODULES = []\n'))
    expectThrows('a missing module table', () => parsePlatformModules('export const OTHER = []\n'))
    const literal = parsePlatformModules("export const PLATFORM_MODULES = [\n  'react', 'react-dom',\n] as const\n")
    if (literal.length !== 2) {
      console.error('  ✗ a literal table should parse to its two entries')
      failures += 1
    } else {
      console.log('  ✓ a literal table parses')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (failures > 0) {
    console.error(`vendor-platform-src --self-test: ${failures} negative self-test(s) failed`)
    process.exit(1)
  }
  console.log('vendor-platform-src --self-test: OK — every negative case trips')
}

/**
 * The value of a source flag, or a clean FAIL.
 * `--commit` with no value would otherwise arrive as `undefined` and fall
 * through to the tag source — recording a lock the caller did not ask for.
 * @param {string[]} argv - the process arguments.
 * @param {string} flag - the flag to read.
 * @returns {string} the flag's value.
 */
function flagValue(argv, flag) {
  const value = argv[argv.indexOf(flag) + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`vendor-platform-src: FAIL — ${flag} needs a value`)
    process.exit(1)
  }
  return value
}

function main() {
  const argv = process.argv.slice(2)
  const mode = argv.includes('--record') ? 'record' : argv.includes('--self-test') ? 'self-test' : 'check'
  const checkoutIndex = argv.indexOf('--checkout')
  const checkout = checkoutIndex === -1
    ? (process.env.DSH_HARNESS_REPO !== undefined && process.env.DSH_HARNESS_REPO !== '' ? process.env.DSH_HARNESS_REPO : join(process.env.HOME ?? '', 'deepseek-harness'))
    : argv[checkoutIndex + 1]
  if (mode === 'self-test') { selfTest(); return }
  const tagIndex = argv.indexOf('--tag')
  const commitIndex = argv.indexOf('--commit')
  if (tagIndex !== -1 && commitIndex !== -1) {
    console.error('vendor-platform-src: FAIL — pass either --tag or --commit, not both')
    process.exit(1)
  }
  if (mode === 'record') {
    if (!existsSync(join(checkout, '.git'))) {
      console.error(`vendor-platform-src: FAIL — no checkout at ${checkout} (pass --checkout <path>)`)
      process.exit(1)
    }
    if (commitIndex !== -1) {
      record({ checkout, commit: flagValue(argv, '--commit') })
    } else {
      record({ checkout, tag: tagIndex === -1 ? tagFor(declaredLine()) : flagValue(argv, '--tag') })
    }
    return
  }
  process.exit(check({ checkout: existsSync(join(checkout, '.git')) ? checkout : undefined }))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
