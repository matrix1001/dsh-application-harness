/**
 * `pnpm run clean` must remove build artifacts and nothing else.
 *
 * The command it replaced (`git clean -Xdf -e node_modules`) removed node_modules
 * as well, and deleted `.dsh-applications/` — the cwd-relative business data (the
 * linkage ledger and the workbook document, each the only source of its world).
 * An irreversible command earns a test: the protected set is pinned here, and the
 * dry run over THIS checkout must never list a protected path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_SUFFIXES,
  DATA,
  PROTECTED,
  ROOT_ARTIFACTS,
  cleanWorkspace,
  collectArtifacts,
  parseArgs,
} from '../clean.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('the protected set covers the dependency tree and the workspace business data', () => {
  assert.deepEqual([...PROTECTED], ['node_modules', DATA])
  assert.equal(DATA, '.dsh-applications')
  for (const dir of ROOT_ARTIFACTS) assert.ok(!PROTECTED.includes(dir))
})

test('a default run over this checkout never lists a protected path', () => {
  const { removed, skipped, dryRun } = cleanWorkspace({ root: ROOT, dryRun: true })
  assert.equal(dryRun, true)
  assert.deepEqual(skipped, [...PROTECTED])
  // Build artifacts exist in a warm tree; the point is what is NOT among them.
  for (const path of removed) {
    const head = path.split('/')[0]
    assert.ok(!PROTECTED.includes(head), `${path} must never be a clean target`)
  }
  assert.ok(!removed.includes(DATA))
})

test('--purge-data is the only way to reach the business data', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'clean-'))
  try {
    mkdirSync(join(fixture, 'coverage'))
    mkdirSync(join(fixture, DATA))
    writeFileSync(join(fixture, DATA, 'ledger.jsonl'), '{}\n')
    assert.ok(collectArtifacts(fixture).includes('coverage'))
    const kept = cleanWorkspace({ root: fixture })
    assert.deepEqual(kept.removed, ['coverage'])
    assert.deepEqual(kept.skipped, [...PROTECTED])
    assert.ok(!collectArtifacts(fixture).includes('coverage'))
    const purged = cleanWorkspace({ root: fixture, purgeData: true })
    assert.deepEqual(purged.removed, [DATA])
    assert.deepEqual(purged.skipped, [])
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('artifact collection finds package build outputs and their suffixes only', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'clean-'))
  try {
    mkdirSync(join(fixture, 'apps', 'demo', 'host', 'lib'), { recursive: true })
    mkdirSync(join(fixture, 'apps', 'demo', 'host', 'node_modules'), { recursive: true })
    mkdirSync(join(fixture, 'apps', 'demo', 'host', '.dsh-applications'), { recursive: true })
    writeFileSync(join(fixture, 'apps', 'demo', 'host', 'tsconfig.tsbuildinfo'), '{}')
    const found = collectArtifacts(fixture)
    assert.deepEqual(found, [
      'apps/demo/host/lib',
      `apps/demo/host/tsconfig${ARTIFACT_SUFFIXES[0]}`,
    ])
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('the CLI refuses unknown arguments and reports a dry run', () => {
  assert.match(String(parseArgs(['--nope']).error), /unknown argument/)
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, purgeData: false, workspace: undefined })
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'clean.mjs'), '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.ok(!out.includes(`${DATA}/`) && !out.includes(`${DATA}\n`), out)
  assert.ok(!/would remove node_modules\//.test(out), out)
})

test('F-5: --purge-data names the workspace it deletes — it never derives one', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'clean-'))
  try {
    const repo = join(fixture, 'repo')
    const workspace = join(fixture, 'ws')
    mkdirSync(join(repo, DATA), { recursive: true })
    writeFileSync(join(repo, DATA, 'ledger.jsonl'), '{"seq":1}\n')
    mkdirSync(join(workspace, DATA), { recursive: true })
    writeFileSync(join(workspace, DATA, 'ledger.jsonl'), '{"seq":9}\n')
    writeFileSync(join(workspace, 'unrelated.txt'), 'kept\n')
    // A bare --purge-data reaches THIS repo's own .dsh-applications (the legacy
    // world) and nothing else: the live world is a workspace, and which one is
    // live is never guessed from the environment or from ~/dsh-workspaces.
    const bare = cleanWorkspace({ root: repo, purgeData: true, dryRun: true })
    assert.deepEqual(bare.removed, [DATA])
    assert.equal(bare.workspaceWorld, undefined)
    assert.equal(existsSync(join(workspace, DATA)), true, 'an unnamed workspace was reached')
    // The named one: only its .dsh-applications, and nothing beside it.
    const named = cleanWorkspace({ root: repo, purgeData: true, workspace })
    assert.ok(named.removed.includes(join(workspace, DATA)), JSON.stringify(named.removed))
    assert.equal(named.workspaceWorld, join(workspace, DATA))
    assert.equal(existsSync(join(workspace, DATA)), false)
    assert.equal(readFileSync(join(workspace, 'unrelated.txt'), 'utf8'), 'kept\n')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('F-5: --purge-data --dry-run prints exactly the paths the real run deletes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'clean-'))
  try {
    const repo = join(fixture, 'repo')
    const workspace = join(fixture, 'ws')
    mkdirSync(join(repo, 'coverage'), { recursive: true })
    mkdirSync(join(repo, DATA), { recursive: true })
    mkdirSync(join(workspace, DATA), { recursive: true })
    writeFileSync(join(workspace, DATA, 'ledger.jsonl'), '{"seq":9}\n')
    const opts = { root: repo, purgeData: true, workspace }
    const dry = cleanWorkspace({ ...opts, dryRun: true })
    // The dry run printed the workspace world as an absolute path (never a
    // repo-relative guess) and deleted nothing.
    assert.ok(dry.removed.includes(join(workspace, DATA)), JSON.stringify(dry.removed))
    assert.equal(existsSync(join(workspace, DATA)), true)
    assert.equal(existsSync(join(repo, DATA)), true)
    const real = cleanWorkspace(opts)
    assert.deepEqual(real.removed, dry.removed, 'the dry run and the real run disagree about what is removed')
    assert.equal(existsSync(join(workspace, DATA)), false)
    assert.equal(existsSync(join(repo, DATA)), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('a real run announces each path — absolute, and while it is still there — before removing it', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'clean-'))
  try {
    const repo = join(fixture, 'repo')
    const workspace = join(fixture, 'ws')
    mkdirSync(join(repo, 'coverage'), { recursive: true })
    mkdirSync(join(repo, DATA), { recursive: true })
    mkdirSync(join(workspace, DATA), { recursive: true })
    writeFileSync(join(workspace, DATA, 'ledger.jsonl'), '{"seq":9}\n')
    const announced = []
    const { removed } = cleanWorkspace({
      root: repo, purgeData: true, workspace,
      // The announcement must arrive BEFORE the rmSync that acts on it: a caller
      // reading "removing /abs/…" is being warned, and a warning that lands after
      // the deletion is a report (AR2″a review, Minor). Asserting inside the
      // callback is what makes that ordering observable.
      beforeRemove: (path) => {
        assert.ok(isAbsolute(path), `${path} is not absolute — the caller cannot tell WHICH tree it is losing`)
        assert.equal(existsSync(path), true, `${path} was announced after it was (or without being) removed`)
        announced.push(path)
      },
    })
    // Same list, same order — the announcement is the `removed` list, absolute.
    assert.deepEqual(announced, removed.map((path) => resolve(repo, path)))
    assert.ok(announced.includes(join(workspace, DATA)), JSON.stringify(announced))
    assert.equal(existsSync(join(workspace, DATA)), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('the CLI echoes those paths on a real run, not only in the dry run', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'clean-'))
  // The CLI derives its root from its own module URL, so a real run against the
  // checked-out tree would delete THIS repository's build outputs (and its
  // legacy world). The program is therefore run from a COPY, with the same
  // relative layout — placed inside the repo's `tmp/` so the copy still resolves
  // the dependencies its import chain needs (js-yaml).
  const copied = join(ROOT, 'tmp', `clean-cli-${String(process.pid)}-${String(Date.now())}`)
  const repo = join(copied, 'repo')
  try {
    const workspace = join(fixture, 'ws')
    cpSync(join(ROOT, 'scripts'), join(repo, 'scripts'), { recursive: true })
    mkdirSync(join(repo, 'coverage'), { recursive: true })
    mkdirSync(join(repo, DATA), { recursive: true })
    writeFileSync(join(repo, DATA, 'ledger.jsonl'), '{"seq":1}\n')
    mkdirSync(join(workspace, DATA), { recursive: true })
    writeFileSync(join(workspace, DATA, 'ledger.jsonl'), '{"seq":9}\n')
    const out = execFileSync(process.execPath,
      [join(repo, 'scripts', 'clean.mjs'), '--purge-data', '--workspace', workspace],
      { cwd: repo, encoding: 'utf8' })
    const removing = out.split('\n').filter((line) => line.startsWith('removing ')).map((line) => line.slice('removing '.length))
    // Every announced path is absolute: `removing coverage` would name a
    // directory without saying whose.
    for (const path of removing) assert.ok(isAbsolute(path), `${path} (in: ${out}) is not absolute`)
    for (const path of [join(repo, 'coverage'), join(repo, DATA), join(workspace, DATA)]) {
      assert.ok(removing.includes(path), `${path} was not announced before the run deleted it: ${out}`)
      assert.equal(existsSync(path), false, `${path} survived the run`)
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
    // Only the directory this test made — `tmp/` itself belongs to the repo's
    // other lanes.
    rmSync(copied, { recursive: true, force: true })
  }
})

test('F-5: --workspace is refused without --purge-data, and the CLI says where the live world is', () => {
  assert.match(String(parseArgs(['--workspace', '/x']).error), /--workspace needs --purge-data/u)
  assert.match(String(parseArgs(['--purge-data', '--workspace']).error), /--workspace needs a directory/u)
  const run = (...args) => execFileSync(process.execPath, [join(ROOT, 'scripts', 'clean.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' })
  // The note is the fix for the wording F-5 found: a bare --purge-data is the
  // way to delete business data, but the business data it reaches is THIS repo's
  // (legacy) world — the live one is a workspace, and the line names it.
  const out = run('--dry-run', '--purge-data')
  assert.ok(out.includes(join(ROOT, DATA)), out)
  assert.match(out, /--purge-data reached this repository only/u)
  assert.match(out, /the LIVE world lives in a WORKSPACE \(\$DSH_WORKSPACE \/ ~\/dsh-workspaces\/<profile>\)/u)
  // Naming a workspace answers the question instead: what it would delete is
  // that workspace's world, absolute, and the "not here" note is gone.
  const named = run('--dry-run', '--purge-data', '--workspace', join(ROOT, 'tmp', 'no-such-workspace'))
  assert.match(named, /no world at .*no-such-workspace[/\\]\.dsh-applications — nothing to purge there/u)
  assert.doesNotMatch(named, /reached this repository only/u)
  assert.match(String(parseArgs(['--purge-data', '--workspace', 'rel/ws']).workspace), /rel[/\\]ws/u)
})
