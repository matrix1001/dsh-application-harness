import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { parseStartArgs } from '../start.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'start.mjs')

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

test('parses start flags and keeps the launcher/dsh arguments intact', () => {
  const parsed = parseStartArgs(['--build', '--no-setup', '--profile', 'demo', '--no-open', '--', '--build'])
  assert.equal(parsed.build, true)
  assert.equal(parsed.noSetup, true)
  assert.deepEqual(parsed.forward, ['--profile', 'demo', '--no-open', '--', '--build'])
})

test('prints help without touching a profile or the installed line', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /pnpm start/)
  assert.match(result.stdout, /--build/)
  assert.equal(result.stderr, '')
})

test('refuses the removed platform-checkout flag with a clear message', () => {
  const result = run(['--checkout', '/tmp/old-checkout'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--checkout is no longer supported/)
})

test('refuses a missing profile with --no-setup and names the bootstrap command', () => {
  const home = mkdtempSync(join(tmpdir(), 'start-missing-'))
  try {
    const result = run(['--no-setup', '--profile', 'does-not-exist'], { DSH_HOME: home })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /profile does-not-exist is missing/)
    assert.match(result.stderr, /pnpm run setup/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
