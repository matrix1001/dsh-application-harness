import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = join(ROOT, 'scripts', 'gate.mjs')

/** Run the gate runner without a shell, so flags are passed literally. */
function run(...args) {
  return spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
}

test('lists the named steps without running one', () => {
  const result = run('--list')
  assert.equal(result.status, 0)
  for (const name of ['typecheck', 'docs', 'coverage', 'build', 'scripts', 'contracts', 'platform', 'smoke', 'smoke-tooled']) {
    assert.match(result.stdout, new RegExp(`^${name}\\s`, 'm'))
  }
})

test('rejects an unknown step instead of silently selecting nothing', () => {
  const result = run('--only', 'nope')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown gate step: nope/)
})

test('rejects an unknown flag', () => {
  const result = run('--wat')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown argument: --wat/)
})

test('release:check delegates to the named gate', () => {
  const listed = JSON.parse(run('--json').stdout)
  assert.ok(listed.length > 0)
  const release = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['release:check']
  assert.equal(release, 'node scripts/gate.mjs', 'release:check must delegate to the named gate')
})
