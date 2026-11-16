#!/usr/bin/env node
/**
 * The red/green half of the platform adaptation lane: run the checks that can
 * tell whether this repository still matches the platform checkout, and write
 * the failures as one machine-readable report.
 *
 * Why a report instead of "just run the gate": the semantic repair stage
 * (`platform-adapt` workflow) must start from failures that actually happened,
 * not from an agent re-reading 2000 commits of platform diff. The report is
 * deterministic, replayable, and small enough to hand to a planner; the
 * package-hit histogram is the first cut of "which of our packages own this
 * failure".
 *
 * What it deliberately does NOT do: decide WHAT changed or how to fix it. That
 * is the workflow's job, and keeping the two apart is why a rerun costs one
 * command instead of one multi-agent run.
 *
 * Usage:
 *   node scripts/platform-compat.mjs [--checkout <dir>] [--only a,b]
 *                                    [--skip-heavy] [--json <path>] [--no-report]
 * @module scripts/platform-compat
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutRoot, inspect, problemsOf } from './platform-line.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_REPORT = join(ROOT, 'tmp', 'platform-adapt', 'compat.json')

/**
 * The checks, in the order a reader should read them: line shape first (cheap
 * and offline), then the snapshot and symbol planes, then the build/test/smoke
 * planes that actually load the platform.
 */
export const CHECKS = [
  { name: 'line', kind: 'inline', description: 'declared line, pins, engines, workspace entries, lock' },
  { name: 'snapshot', cmd: 'node', args: (checkout) => ['scripts/vendor-platform-src.mjs', '--check', ...(checkout === undefined ? [] : ['--checkout', checkout])], description: 'vendored sources and typert shell' },
  { name: 'modules', cmd: 'node', args: (checkout) => ['scripts/verify-platform-modules.mjs', ...(checkout === undefined ? [] : ['--checkout', checkout])], description: 'shared-module table' },
  { name: 'package-set', cmd: 'node', args: (checkout) => ['scripts/verify-platform-package-set.mjs', ...(checkout === undefined ? [] : ['--checkout', checkout])], description: 'platform package names and renames' },
  { name: 'engines', cmd: 'node', args: () => ['scripts/verify-engines.mjs'], description: 'engines.dsh covers the declared line' },
  { name: 'symbols', cmd: 'node', args: (checkout) => ['scripts/check-platform-symbols.mjs', ...(checkout === undefined ? [] : ['--checkout', checkout])], description: 'platform atom surface our client imports' },
  { name: 'launch', cmd: 'node', args: (checkout) => ['scripts/launch-apps.mjs', '--check-only', ...(checkout === undefined ? [] : ['--checkout', checkout])], description: 'launch preflight' },
  { name: 'build', cmd: 'pnpm', args: () => ['run', 'build'], heavy: true, description: 'host/client TypeScript and bundles' },
  { name: 'test', cmd: 'pnpm', args: () => ['run', 'test'], heavy: true, description: 'unit suite against the vendored snapshot' },
  { name: 'smoke', cmd: 'node', args: () => ['scripts/smoke.mjs', 'applications'], description: 'keyless composition smoke' },
  { name: 'smoke-tooled', cmd: 'node', args: () => ['scripts/smoke.mjs', 'applications', '--tooled'], description: 'tooled composition smoke' },
]

/** Keep only the checks the flags asked for. @param names - comma list, or empty for all. @param skipHeavy - drop build/test. @returns the selected checks. */
export function selectChecks(names, skipHeavy = false) {
  const wanted = names === undefined || names === '' ? undefined : new Set(names.split(',').map((name) => name.trim()).filter(Boolean))
  return CHECKS.filter((check) => (wanted === undefined || wanted.has(check.name)) && (!skipHeavy || check.heavy !== true))
}

/**
 * The packages a failing output points at, most-mentioned first. This is a
 * heuristic index, not a verdict: it only keeps the planner from starting at
 * `packages/` and reading everything.
 * @param output - combined stdout/stderr of a check.
 * @returns the ranked package directories.
 */
export function packageHits(output) {
  const counts = new Map()
  for (const match of output.matchAll(/\bpackages\/([a-z0-9-]+)\/([a-z0-9-]+)\//gu)) {
    const packageDir = `packages/${match[1]}/${match[2]}`
    counts.set(packageDir, (counts.get(packageDir) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([packageDir, hits]) => ({ package: packageDir, hits }))
    .sort((left, right) => right.hits - left.hits || left.package.localeCompare(right.package))
    .slice(0, 8)
}

/** Trim a check's output to the part a reader needs. @param output - combined output. @param failed - whether the check failed. @returns the tail. */
export function outputTail(output, failed) {
  const limit = failed ? 24000 : 2000
  return output.length <= limit ? output : output.slice(output.length - limit)
}

/** Run one command check. @param check - the check. @param checkout - the platform checkout, if any. @param timeout - per-check timeout in ms. @returns the result. */
function runCommand(check, checkout, timeout) {
  const args = check.args(checkout)
  const started = Date.now()
  const result = spawnSync(check.cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const timedOut = result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal !== null)
  return {
    name: check.name,
    command: [check.cmd, ...args].join(' '),
    status: timedOut ? 'timeout' : result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status,
    durationMs: Date.now() - started,
    packageHits: packageHits(output),
    outputTail: outputTail(output, result.status !== 0),
  }
}

/** Run the inline line check. @param checkout - the platform checkout. @returns the result. */
function runLine(checkout) {
  const started = Date.now()
  const state = inspect(ROOT, { checkout })
  const { problems, warnings } = problemsOf(state)
  const lines = [
    `declared ${state.line}; ${state.pins.length} pin(s), ${state.engines.length} engines range(s), ${state.workspace.length} workspace entr(y/ies)`,
    ...problems.map((problem) => `PROBLEM ${problem}`),
    ...warnings.map((warning) => `WARN ${warning}`),
  ]
  return {
    name: 'line',
    command: 'node scripts/platform-line.mjs --check',
    status: problems.length === 0 ? 'pass' : 'fail',
    exitCode: problems.length === 0 ? 0 : 1,
    durationMs: Date.now() - started,
    packageHits: [],
    outputTail: lines.join('\n'),
  }
}

/** The CLI. */
function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`platform-compat: one report of what the platform checkout broke
  --checkout <dir>   platform checkout (default: $DSH_HARNESS_REPO or ~/deepseek-harness)
  --only a,b         run only the named checks (${CHECKS.map((check) => check.name).join(', ')})
  --skip-heavy       skip build and test
  --json <path>      report path (default: tmp/platform-adapt/compat.json)
  --no-report        print only; write no file
  --timeout <ms>     per-check timeout (default: 15 min for build/test, 5 min otherwise)`)
    return
  }
  const valueOf = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const configured = valueOf('--checkout')
  const candidate = configured ?? checkoutRoot()
  const checkout = existsSync(join(candidate, '.git')) ? candidate : undefined
  if (configured !== undefined && checkout === undefined) console.warn(`platform-compat: no checkout at ${configured} — checkout-dependent checks run unverified`)
  const selected = selectChecks(valueOf('--only'), argv.includes('--skip-heavy'))
  if (selected.length === 0) {
    console.error('platform-compat: --only selected no check')
    process.exit(1)
  }
  const override = valueOf('--timeout')
  const reportPath = valueOf('--json') ?? DEFAULT_REPORT
  const declareLine = inspect(ROOT).line
  const results = []
  for (const check of selected) {
    process.stdout.write(`platform-compat: ${check.name} … `)
    const timeout = override !== undefined ? Number(override) : check.heavy === true ? 900000 : 300000
    const result = check.kind === 'inline' ? runLine(checkout) : runCommand(check, checkout, timeout)
    results.push(result)
    console.log(`${result.status.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)}s)`)
  }
  const failed = results.filter((result) => result.status !== 'pass')
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: ROOT,
    checkout,
    declaredLine: declareLine,
    checks: results,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      failedChecks: failed.map((result) => result.name),
    },
  }
  if (!argv.includes('--no-report')) {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, undefined, 2)}\n`)
  }
  console.log(`platform-compat: ${report.summary.passed}/${report.summary.total} check(s) passed${failed.length > 0 ? ` — failed: ${failed.map((result) => result.name).join(', ')}` : ''}`)
  if (!argv.includes('--no-report')) console.log(`  report: ${reportPath}`)
  for (const result of failed) {
    for (const hit of result.packageHits.slice(0, 3)) console.log(`  ${result.name}: ${hit.package} (${hit.hits} mention(s))`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
