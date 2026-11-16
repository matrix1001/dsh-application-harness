/**
 * Script-plane tests for the vendoring source escape hatch (`--record --commit`)
 * and the lock fields it adds (`sourceMode` / `commitsAhead`).
 *
 * Why the shape is a contract and not a convenience: the vendored trees used to
 * be readable from the declared line's tag ONLY, so a checkout whose HEAD has
 * moved ahead of that tag had no correct source at all — the execution line and
 * the test plane silently drifted apart. The three red lines proved here are: a
 * commit past the tag is recorded WITH its distance, a commit OFF the line is
 * refused outright, and a checkout that no longer holds the recorded commit
 * fails the check (the shallow-clone / moved-worktree shape a tag-only lock
 * cannot see). The lock's READERS are part of the same contract: a new source
 * mode is only complete once the gate that re-reads the source follows it.
 *
 * Every fixture is a throwaway git repo plus a scratch repo root — `record()`
 * writes the lock and every vendored tree under the root it is given, so a test
 * that leaned on the default root would overwrite this workspace.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PLATFORM_LOCK, VENDOR_PAIRS } from '../platform-contract.mjs'
import { check, record } from '../vendor-platform-src.mjs'
import { verify as verifyModules } from '../verify-platform-modules.mjs'

/** Run git in a fixture checkout (this environment exports a broken GIT_CONFIG_*). */
const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@t',
  },
})

/** Run `body` against a fresh scratch dir, removed afterwards. */
function withFixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vendor-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `record` announces every tree on stdout; keep the run's output to the assertions. */
function quiet(body) {
  const log = console.log
  console.log = () => {}
  try {
    return body()
  } finally {
    console.log = log
  }
}

/**
 * A throwaway platform checkout at `dir`: one `packages/<from>/src` per
 * vendoring pair, the platform's shared-module table, a commit BEFORE the tag,
 * and the tag itself.
 *
 * The pre-tag commit is what makes "off the declared line" expressible: the
 * line is anchored AT the tag, so a commit the tag cannot reach is the shape
 * `--commit` must refuse. `variant` keeps two otherwise identical fixtures'
 * commit SHAs distinct — SHAs are content-addressed, so same-second commits of
 * identical trees collide.
 * @param {string} dir - the checkout root to create.
 * @param {{ line: string, variant?: string }} options - the declared line and the content marker.
 * @returns {string} `dir`.
 */
function makeCheckout(dir, { line, variant = 'a' }) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  for (const [from] of VENDOR_PAIRS) {
    mkdirSync(join(dir, 'packages', from, 'src'), { recursive: true })
    writeFileSync(join(dir, 'packages', from, 'src', 'a.ts'), `export const a = '${variant}'\n`)
  }
  mkdirSync(join(dir, 'packages/client/web/src'), { recursive: true })
  writeFileSync(join(dir, 'packages/client/web/src/platform.ts'), "export const PLATFORM_MODULES = [\n  'react',\n] as const\n")
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'before the line'])
  // Everything from here on is the declared line: the tag anchors it.
  writeFileSync(join(dir, 'LINE.md'), `declared line ${line}\n`)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', `line ${line}`])
  git(dir, ['tag', `dsh-v${line}`])
  return dir
}

/**
 * One more commit past the tag. The working tree has to change: git refuses an
 * unchanged tree, and two identical trees under the same parent in the same
 * second would collide on SHA.
 * @param {string} repo - the fixture checkout.
 * @returns {string} the new HEAD's SHA.
 */
function commitPast(repo) {
  writeFileSync(join(repo, 'LINE.md'), 'the line moved on\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'past tag'])
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

/**
 * A scratch repo root: the deployment descriptor feeds `declaredLine(root)`, the
 * two local copies of the platform seed table feed `verify-platform-modules`
 * (they must agree with the lock's snapshot, exactly as in the real repo), and
 * `scripts/` receives the lock and the vendored trees.
 * @param {string} dir - the repo root to create.
 * @param {{ line: string, modules?: string[] }} options - the declared line the descriptor states, and the seed table both local copies hold.
 * @returns {string} `dir`.
 */
function makeRoot(dir, { line, modules = ['react'] }) {
  mkdirSync(join(dir, 'packages/bundle/app-harness'), { recursive: true })
  mkdirSync(join(dir, 'packages/client'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const table = modules.map(name => `'${name}'`).join(', ')
  writeFileSync(join(dir, 'packages/bundle/app-harness/deployment.yml'), `platform:\n  declaredLine: ${line}\n`)
  writeFileSync(join(dir, 'packages/client/tsdown.client.ts'), `const PLATFORM_MODULES = [\n  ${table},\n] as const\n`)
  writeFileSync(join(dir, 'scripts/verify-client-factory.mjs'), `const PLATFORM_MODULES = [\n  ${table},\n]\n`)
  return dir
}

/** The lock a previous `record()` wrote under a fixture root. */
function readFixtureLock(root) {
  return JSON.parse(readFileSync(join(root, PLATFORM_LOCK), 'utf8'))
}

test('--commit records a commit past the declared tag with its distance', () => withFixture((dir) => {
  const line = '0.0.1'
  const repo = makeCheckout(join(dir, 'checkout'), { line })
  const root = makeRoot(join(dir, 'root'), { line, modules: ['react', 'react-dom'] })
  writeFileSync(join(repo, 'packages/client/web/src/platform.ts'), "export const PLATFORM_MODULES = [\n  'react', 'react-dom',\n] as const\n")
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'past tag'])
  const head = git(repo, ['rev-parse', 'HEAD']).trim()

  quiet(() => record({ checkout: repo, commit: head, root }))

  const lock = readFixtureLock(root)
  assert.equal(lock.sourceMode, 'commit')
  assert.equal(lock.commit, head)
  // The tag keeps naming the DECLARED LINE (its readers read the line off it),
  // so the mode travels separately.
  assert.equal(lock.tag, `dsh-v${line}`)
  assert.equal(lock.commitsAhead, 1)
  quiet(() => assert.equal(check({ checkout: repo, root }), 0))
}))

test('--commit refuses a commit that is not on the declared line', () => withFixture((dir) => {
  const line = '0.0.2'
  const repo = makeCheckout(join(dir, 'checkout'), { line })
  const root = makeRoot(join(dir, 'root'), { line })
  // The commit before the tag: the line is anchored AT the tag, so an ancestor
  // is off it — the shape `--commit` must refuse.
  const beforeTag = git(repo, ['rev-parse', 'HEAD^']).trim()

  assert.throws(() => record({ checkout: repo, commit: beforeTag, root }), /declared line/)
  // A refusal must leave no lock behind: a half-recorded source is worse than none.
  assert.equal(existsSync(join(root, PLATFORM_LOCK)), false)
}))

test('--check fails when the recorded commit is unknown to the checkout', () => withFixture((dir) => {
  const line = '0.0.3'
  const recorded = join(dir, 'recorded')
  const root = makeRoot(join(dir, 'root'), { line })
  makeCheckout(recorded, { line })
  const head = git(recorded, ['rev-parse', 'HEAD']).trim()
  quiet(() => record({ checkout: recorded, commit: head, root }))

  // A different checkout holding the same tag but NOT the recorded commit (the
  // shallow-clone / moved-worktree shape). `variant: 'b'` keeps its commit SHA
  // distinct from the recorded one.
  const other = makeCheckout(join(dir, 'other'), { line, variant: 'b' })
  const errors = []
  const original = console.error
  console.error = (entry) => { errors.push(String(entry)) }
  try {
    assert.equal(check({ checkout: other, root }), 1)
  } finally {
    console.error = original
  }
  assert.match(errors.join('\n'), /could not be read/)
}))

test('the tag source still records sourceMode tag with zero distance', () => withFixture((dir) => {
  const line = '0.0.4'
  const repo = makeCheckout(join(dir, 'checkout'), { line })
  const root = makeRoot(join(dir, 'root'), { line })
  const head = git(repo, ['rev-parse', 'HEAD']).trim()

  quiet(() => record({ checkout: repo, tag: `dsh-v${line}`, root }))

  const lock = readFixtureLock(root)
  assert.equal(lock.sourceMode, 'tag')
  assert.equal(lock.commitsAhead, 0)
  assert.equal(lock.commit, head)
  quiet(() => assert.equal(check({ checkout: repo, root }), 0))
}))

test('a commit-sourced lock also satisfies the module-table gate', () => withFixture((dir) => {
  const line = '0.0.5'
  const repo = makeCheckout(join(dir, 'checkout'), { line })
  const root = makeRoot(join(dir, 'root'), { line })
  const head = commitPast(repo)
  quiet(() => record({ checkout: repo, commit: head, root }))
  assert.equal(readFixtureLock(root).sourceMode, 'commit')

  // The gate's upstream half used to read the module table from the TAG's
  // commit and to require that commit to BE the lock's — a commit-sourced lock
  // failed it (the tag resolves one commit behind), so the whole release:check
  // went red for a lock the recorder considers correct.
  quiet(() => assert.equal(verifyModules({ root, checkout: repo }), 0))
}))

test('the module-table gate fails when the recorded commit left the line', () => withFixture((dir) => {
  const line = '0.0.6'
  const repo = makeCheckout(join(dir, 'checkout'), { line })
  const root = makeRoot(join(dir, 'root'), { line })
  const head = commitPast(repo)
  quiet(() => record({ checkout: repo, commit: head, root }))

  // Re-point the line's anchor at a SIBLING of the recorded commit (same
  // parent, different content): the commit is still in the checkout, but the
  // declared line no longer reaches it — the shape a re-tagged or re-pointed
  // line produces, which the reader must refuse rather than compare anyway.
  git(repo, ['checkout', '-q', '--detach', `${head}~1`])
  writeFileSync(join(repo, 'LINE.md'), 'a sibling of the recorded commit\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'sibling'])
  git(repo, ['tag', '-f', `dsh-v${line}`, git(repo, ['rev-parse', 'HEAD']).trim()])

  const errors = []
  const original = console.error
  console.error = (entry) => { errors.push(String(entry)) }
  try {
    assert.equal(verifyModules({ root, checkout: repo }), 1)
  } finally {
    console.error = original
  }
  assert.match(errors.join('\n'), /no longer on the declared line/)
}))
