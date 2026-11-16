#!/usr/bin/env node
/**
 * The tests typecheck gate (`pnpm run typecheck:tests`): run
 * `tsc -p tsconfig.tests.json` over every package's test files, then filter
 * the report through a fail-closed decision.
 *
 * Platform packages resolve through node_modules (published lib), except the
 * vendored client sources under `.platform-src/` (see its README). Those
 * vendored files are platform code checked under the platform's own tsconfig
 * upstream, so this program's strict settings flag them wholesale; the
 * decision filters those diagnostics and exits nonzero only when OUR files
 * (anything outside `.platform-src/`) fail. The tests program itself is the
 * gate: our test files must typecheck clean, and any error in them fails the
 * run.
 *
 * Fail-closed (audit C-I2): a nonzero tsc exit is green ONLY when every error
 * line in the raw output belongs to `.platform-src/` — and the process was
 * not killed by a signal and the output carries no crash marker (OOM,
 * segfault, internal error). Any other nonzero exit — a crash, an OOM, a
 * config error (diagnostics without a file location header), or any kept
 * non-vendored error line — exits 1. A crash silently truncates the
 * diagnostic list, so a header-less report after a nonzero exit can never be
 * mistaken for "only vendored noise".
 *
 * The gate self-checks: every run first asserts the fail-closed decision
 * logic against canned outputs (including a child-process crash simulation)
 * and aborts with exit 1 if the wrapper itself regresses.
 *
 * Usage: node scripts/typecheck-tests.mjs [--self-test]
 *   --self-test  run the self-test alone (no tsc run) and exit by its result.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const thisScript = resolve(new URL(import.meta.url).pathname)
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc')

/**
 * Crash markers that make any nonzero exit a hard failure: a partial run's
 * .platform-only report cannot be trusted after an OOM or a signal.
 * (Ordinary tsc diagnostics never contain these phrases.)
 */
const CRASH_MARKERS = /(fatal error|heap out of memory|allocation failed|out of memory|segmentation fault|internal error)/i

/**
 * Decide the gate's verdict from a raw tsc run result.
 * @param result - a spawnSync-shaped result: { error?, status, signal, stdout, stderr }.
 * @returns { green: boolean, ours: number, message: string } — `ours` is the
 *   number of kept non-`.platform` error lines, or -1 when the run cannot be
 *   attributed to diagnostics at all (crash/OOM/config error).
 */
function decide(result) {
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
  // status !== 0: fail closed unless every error line is .platform noise.
  if (CRASH_MARKERS.test(raw)) {
    return { green: false, ours: -1, message: 'typecheck-tests: tsc output carries a crash marker (OOM/segfault/internal error) — failing closed.' }
  }
  const errorLines = raw.split('\n').filter((line) => /error TS/.test(line))
  // Kept errors: not a file-located `.platform` diagnostic header (includes
  // our packages' files and unlocated/config diagnostics alike).
  const nonPlatform = errorLines.filter((line) => {
    const header = line.match(/^(.*?)\(\d+,\d+\): error TS/)
    return header === null || !header[1].startsWith('.platform')
  })
  if (errorLines.length > 0 && nonPlatform.length === 0) {
    return { green: true, ours: 0, message: "typecheck-tests: only .platform mirror noise (vendored src, checked under its own tsconfig) — filtered." }
  }
  if (errorLines.length === 0) {
    return { green: false, ours: -1, message: `typecheck-tests: tsc exited ${result.status} without diagnostic headers (crash, OOM, or config error) — failing closed.` }
  }
  return { green: false, ours: nonPlatform.length, message: `typecheck-tests: ${nonPlatform.length} error(s) outside .platform (our packages' files or unlocated/config diagnostics) — failing.` }
}

/**
 * Build the report: drop .platform diagnostic headers and their detail lines.
 * @param result - a spawnSync-shaped result.
 * @returns the kept (non-`.platform`) output, trimmed.
 */
function filteredReport(result) {
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n')
  const kept = []
  let dropping = false
  for (const line of lines) {
    const header = line.match(/^(.*?)\(\d+,\d+\): error TS/)
    if (header) dropping = header[1].startsWith('.platform')
    if (!dropping) kept.push(line)
  }
  return kept.join('\n').trim()
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

if (process.argv.includes('--self-test')) {
  const cases = [
    ['crash output (no error TS)', decide({ status: 1, signal: null, stdout: '', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }), false],
    ['silent nonzero exit (no diagnostics)', decide({ status: 1, signal: null, stdout: '', stderr: '' }), false],
    ['killed by signal', decide({ status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }), false],
    ['config error (no file location header)', decide({ status: 1, signal: null, stdout: "error TS5023: Unknown compiler option 'nope'.\n", stderr: '' }), false],
    ['all .platform noise', decide({ status: 1, signal: null, stdout: '.platform/dsh-foo/src/index.ts(1,2): error TS1234: nope\n  detail line\n', stderr: '' }), true],
    ['our own error', decide({ status: 1, signal: null, stdout: 'packages/client/chrome/tests/x.spec.ts(3,4): error TS2322: bad\n', stderr: '' }), false],
    ['mixed .platform + our error', decide({ status: 1, signal: null, stdout: '.platform/dsh-foo/src/index.ts(1,2): error TS1234: nope\npackages/client/chrome/tests/x.spec.ts(3,4): error TS2322: bad\n', stderr: '' }), false],
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
    [decide({ status: 1, signal: null, stdout: '.platform/dsh-foo/src/index.ts(1,2): error TS1234: nope\n', stderr: '' }), true],
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

const report = filteredReport(result)
if (report) console.log(report)

const verdict = decide(result)
console.log(verdict.message)
if (verdict.green && result.status !== 0) {
  console.log('typecheck-tests: OK — no errors in our packages\' test files.')
}
process.exit(verdict.green ? 0 : 1)
