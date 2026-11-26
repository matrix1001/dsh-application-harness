#!/usr/bin/env node
/**
 * The tests typecheck gate (`pnpm run typecheck:tests`): run
 * `tsc -p tsconfig.tests.json` over every package's test files and decide the
 * verdict fail-closed.
 *
 * Platform packages resolve through `node_modules` except the client suites'
 * source fixture under `.platform-src/` (generated from the installed line by
 * `scripts/sync-platform-fixture.mjs`). Those files are platform code, checked
 * by the platform against its own tsconfig, so this program's strict settings
 * flag them wholesale; the decision keeps those diagnostics out and fails on
 * anything else. Every remaining diagnostic is ours or a config problem.
 *
 * The fixture diagnostics are not ignored silently: their count and TS-code
 * histogram are recorded in `scripts/platform-fixture-diagnostics.json` and
 * must match on every run. A platform line whose fixture noise changes fails
 * the gate with the difference, and `--update-fixture-baseline` records the
 * new baseline as a deliberate part of that port.
 *
 * Fail-closed (audit C-I2): a nonzero tsc exit fails UNLESS it is provably a
 * clean diagnostic report — the process was not killed by a signal, the
 * output carries no crash marker (OOM, segfault, internal error), and at
 * least one `error TS` line exists. A crash silently truncates the
 * diagnostic list, so a header-less report after a nonzero exit can never be
 * mistaken for "nothing to report".
 *
 * The gate self-checks: every run first asserts the fail-closed decision
 * logic against canned outputs (including a child-process crash simulation)
 * and aborts with exit 1 if the wrapper itself regresses.
 *
 * Usage: node scripts/typecheck-tests.mjs [--self-test] [--update-fixture-baseline]
 *   --self-test                  run the self-test alone (no tsc run) and exit by its result.
 *   --update-fixture-baseline    record the current fixture diagnostics after a deliberate platform port.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const thisScript = resolve(new URL(import.meta.url).pathname)
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc')
const BASELINE = resolve(repoRoot, 'scripts/platform-fixture-diagnostics.json')

/**
 * Crash markers that make any nonzero exit a hard failure: a partial run's
 * report cannot be trusted after an OOM or a signal.
 * (Ordinary tsc diagnostics never contain these phrases.)
 */
const CRASH_MARKERS = /(fatal error|heap out of memory|allocation failed|out of memory|segmentation fault|internal error)/i

/** The fixture-diagnostic fingerprint: total count plus a TS-code histogram. */
function fingerprint(lines) {
  const codes = {}
  for (const line of lines) {
    const match = /error (TS\d+)/u.exec(line)
    if (match === null) continue
    codes[match[1]] = (codes[match[1]] ?? 0) + 1
  }
  return { count: lines.length, codes: Object.fromEntries(Object.entries(codes).sort(([a], [b]) => a.localeCompare(b))) }
}

/** Whether two fingerprints describe the same fixture noise. */
function sameFingerprint(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Read the recorded fixture-diagnostic baseline, or undefined. */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Decide the gate's verdict from a raw tsc run result.
 * @param result - a spawnSync-shaped result: { error?, status, signal, stdout, stderr }.
 * @returns { green: boolean, ours: number, message: string } — `ours` is the
 *   number of `error TS` lines, or -1 when the run cannot be attributed to
 *   diagnostics at all (crash/OOM/config error).
 */
function decide(result, baseline) {
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) {
    return { green: false, ours: -1, message: `typecheck-tests: failed to run tsc: ${result.error.message}` }
  }
  if (result.signal !== null) {
    return { green: false, ours: -1, message: `typecheck-tests: tsc was killed by signal ${result.signal} — failing closed.` }
  }
  if (result.status === 0) {
    return { green: true, ours: 0, message: 'typecheck-tests: OK — no errors.' }
  }
  if (CRASH_MARKERS.test(raw)) {
    return { green: false, ours: -1, message: 'typecheck-tests: tsc output carries a crash marker (OOM/segfault/internal error) — failing closed.' }
  }
  const errorLines = raw.split('\n').filter((line) => /error TS/.test(line))
  if (errorLines.length === 0) {
    return { green: false, ours: -1, message: `typecheck-tests: tsc exited ${result.status} without diagnostic headers (crash, OOM, or config error) — failing closed.` }
  }
  const fixture = []
  const ours = []
  for (const line of errorLines) {
    const header = /^(.*?)\(\d+,\d+\): error TS/.exec(line)
    if (header !== null && header[1].startsWith('.platform-src')) fixture.push(line)
    else ours.push(line)
  }
  if (ours.length > 0) {
    return { green: false, ours: ours.length, message: `typecheck-tests: ${ours.length} type error(s) outside the platform fixture — failing.` }
  }
  if (fixture.length === 0) {
    return { green: true, ours: 0, fixture: { count: 0, codes: {} }, message: 'typecheck-tests: OK — no errors.' }
  }
  const print = fingerprint(fixture)
  if (baseline !== undefined && sameFingerprint(print, baseline)) {
    return { green: true, ours: 0, fixture: print, message: `typecheck-tests: ${fixture.length} platform-fixture diagnostic(s) match the recorded baseline.` }
  }
  return {
    green: false,
    ours: 0,
    fixture: print,
    message: `typecheck-tests: platform-fixture diagnostics changed (recorded ${baseline === undefined ? 'none' : JSON.stringify(baseline)}, now ${JSON.stringify(print)}) — review and run with --update-fixture-baseline as part of the platform port.`,
  }
}

// ── Self-test ────────────────────────────────────────────────────────────────
// The child mode simulates a tsc run that dies without diagnostics through the
// real decide-and-exit path; the parent asserts its exit code (a crash must
// never turn the gate green).
if (process.argv.includes('--self-test-child-crash')) {
  const verdict = decide({
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'node:internal/errors: crashed\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
  })
  console.log(verdict.message)
  process.exit(verdict.green ? 0 : 1)
}

if (process.argv.includes('--update-fixture-baseline')) {
  const env = { ...process.env }
  delete env.npm_command
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.tests.json'], { cwd: repoRoot, env, encoding: 'utf8' })
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const fixture = raw.split('\n').filter((line) => {
    const header = /^(.*?)\(\d+,\d+\): error TS/.exec(line)
    return header !== null && header[1].startsWith('.platform-src')
  })
  const next = fingerprint(fixture)
  writeFileSync(BASELINE, `${JSON.stringify(next, undefined, 2)}\n`)
  console.log(`typecheck-tests: recorded ${next.count} platform-fixture diagnostic(s) in ${BASELINE}`)
  process.exit(0)
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ['crash output (no error TS)', decide({ status: 1, signal: null, stdout: '', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }), false],
    ['silent nonzero exit (no diagnostics)', decide({ status: 1, signal: null, stdout: '', stderr: '' }), false],
    ['killed by signal', decide({ status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }), false],
    ['config error (no file location header)', decide({ status: 1, signal: null, stdout: "error TS5023: Unknown compiler option 'nope'.\n", stderr: '' }), false],
    ['our own error', decide({ status: 1, signal: null, stdout: 'packages/client/chrome/tests/x.spec.ts(3,4): error TS2322: bad\n', stderr: '' }), false],
    ['only recorded platform-fixture noise', decide({ status: 1, signal: null, stdout: '.platform-src/dsh-x/src/a.ts(1,2): error TS1234: nope\n', stderr: '' }, { count: 1, codes: { TS1234: 1 } }), true],
    ['changed platform-fixture noise', decide({ status: 1, signal: null, stdout: '.platform-src/dsh-x/src/a.ts(1,2): error TS9999: nope\n', stderr: '' }, { count: 1, codes: { TS1234: 1 } }), false],
    ['clean success', decide({ status: 0, signal: null, stdout: '', stderr: '' }), true],
  ]
  let failed = 0
  for (const [name, verdict, expectedGreen] of cases) {
    const pass = verdict.green === expectedGreen
    if (!pass) failed += 1
    console.log(`${pass ? 'ok' : 'FAIL'}  ${name} — ${verdict.message}`)
  }
  const child = spawnSync(process.execPath, [thisScript, '--self-test-child-crash'], { cwd: repoRoot, encoding: 'utf8' })
  const childOk = child.status === 1
  if (!childOk) failed += 1
  console.log(`${childOk ? 'ok' : 'FAIL'}  child process exits 1 on a simulated tsc crash (got ${child.status})`)
  if (failed > 0) {
    console.error(`typecheck-tests: self-test failed (${failed} case(s))`)
    process.exit(1)
  }
  console.log('typecheck-tests: self-test OK — fail-closed decision logic verified.')
  process.exit(0)
}

// ── Gate self-check: the wrapper must not regress (audit C-I2). ──────────────
{
  const cases = [
    [decide({ status: 1, signal: null, stdout: '', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }), false],
    [decide({ status: 1, signal: null, stdout: '', stderr: '' }), false],
    [decide({ status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }), false],
    [decide({ status: 1, signal: null, stdout: "error TS5023: Unknown compiler option 'nope'.\n", stderr: '' }), false],
    [decide({ status: 1, signal: null, stdout: 'packages/client/chrome/tests/x.spec.ts(3,4): error TS2322: bad\n', stderr: '' }), false],
    [decide({ status: 0, signal: null, stdout: '', stderr: '' }), true],
  ]
  for (const [verdict, expectedGreen] of cases) {
    if (verdict.green !== expectedGreen) {
      console.error(`typecheck-tests: self-test case failed — ${verdict.message}`)
      process.exit(1)
    }
  }
  const child = spawnSync(process.execPath, [thisScript, '--self-test-child-crash'], { cwd: repoRoot, encoding: 'utf8' })
  if (child.status !== 1) {
    console.error(`typecheck-tests: self-test child exited ${child.status}, expected 1 (crash must fail closed)`)
    process.exit(1)
  }
}

// ── The real run ─────────────────────────────────────────────────────────────
const env = { ...process.env }
delete env.npm_command
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.tests.json'], {
  cwd: repoRoot,
  env,
  encoding: 'utf8',
})

const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
if (raw) {
  const kept = []
  let dropping = false
  for (const line of raw.split('\n')) {
    const header = /^(.*?)\(\d+,\d+\): error TS/.exec(line)
    if (header) dropping = header[1].startsWith('.platform-src')
    if (!dropping) kept.push(line)
  }
  if (kept.length > 0) console.log(kept.join('\n'))
}

const verdict = decide(result, readBaseline())
console.log(verdict.message)
process.exit(verdict.green ? 0 : 1)
